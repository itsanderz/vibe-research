import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ClaimNotFoundError,
	openLedger,
	ProposalAlreadyResolvedError,
	ProposalNotFoundError,
} from "../src/ledger/store.ts";
import { TransitionError } from "../src/ledger/transitions.ts";
import { ClaimStatus } from "../src/ledger/types.ts";

const dirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "vibe-core-ledger-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	dirs.length = 0;
});

describe("openLedger — basic record/update/list", () => {
	it("records a claim as UNTESTED with no evidence", () => {
		const ledger = openLedger(makeTempDir());
		const claim = ledger.recordClaim("For every integer n, 30 divides n^5 - n.", ["n is an integer"]);

		expect(claim.status).toBe(ClaimStatus.UNTESTED);
		expect(claim.evidence).toEqual([]);
		expect(claim.assumptions).toEqual(["n is an integer"]);
		expect(claim.id).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(ledger.getClaim(claim.id)).toEqual(claim);
	});

	it("updateClaim validates the transition and accumulates evidence", () => {
		const ledger = openLedger(makeTempDir());
		const claim = ledger.recordClaim("Claim", []);

		const updated = ledger.updateClaim(claim.id, ClaimStatus.TESTED_SMALL_CASES, [
			"method=enumeration; scope=n in [-100,100]; result=no counterexample",
		]);

		expect(updated.status).toBe(ClaimStatus.TESTED_SMALL_CASES);
		expect(updated.evidence).toHaveLength(1);
		expect(updated.updatedAt >= updated.createdAt).toBe(true);

		const again = ledger.updateClaim(claim.id, ClaimStatus.COMPUTATIONALLY_VERIFIED, [
			"method=exhaustive enumeration; scope=n in [0,29]; result=no counterexample",
		]);
		expect(again.evidence).toHaveLength(2);
		expect(again.status).toBe(ClaimStatus.COMPUTATIONALLY_VERIFIED);
	});

	it("rejects an illegal transition via the same validation as transitions.ts", () => {
		const ledger = openLedger(makeTempDir());
		const claim = ledger.recordClaim("Claim", []);
		ledger.updateClaim(claim.id, ClaimStatus.INFORMALLY_PROVED, ["informal proof written up"]);

		expect(() =>
			ledger.updateClaim(claim.id, ClaimStatus.TESTED_SMALL_CASES, ["trying to weaken the status"]),
		).toThrow(TransitionError);
	});

	it("throws ClaimNotFoundError for an unknown id", () => {
		const ledger = openLedger(makeTempDir());
		expect(() => ledger.updateClaim("does-not-exist", ClaimStatus.TESTED_SMALL_CASES, ["evidence"])).toThrow(
			ClaimNotFoundError,
		);
	});
});

describe("openLedger — JSONL replay reproduces state", () => {
	it("a fresh openLedger() over the same directory reproduces listClaims() after a multi-claim, multi-update sequence", () => {
		const dir = makeTempDir();
		const ledger = openLedger(dir);

		const claimA = ledger.recordClaim("For every integer n, 30 divides n^5 - n.", ["n is an integer"]);
		const claimB = ledger.recordClaim("There are infinitely many twin primes.", []);

		ledger.updateClaim(claimA.id, ClaimStatus.TESTED_SMALL_CASES, ["method=enumeration; scope=n in [-1000,1000]"]);
		ledger.updateClaim(claimB.id, ClaimStatus.TESTED_SMALL_CASES, ["method=enumeration; scope=p < 10^6"]);
		ledger.updateClaim(claimA.id, ClaimStatus.COMPUTATIONALLY_VERIFIED, [
			"method=exhaustive enumeration; scope=n in [0,29] (period 30)",
		]);
		ledger.updateClaim(claimB.id, ClaimStatus.COUNTEREXAMPLE_FOUND, [
			"method=n/a; result=hypothetical demonstration only, not a real proof",
		]);

		const expected = ledger.listClaims();

		const reopened = openLedger(dir);
		const replayed = reopened.listClaims();

		const sortById = (claims: typeof expected) => [...claims].sort((a, b) => a.id.localeCompare(b.id));
		expect(sortById(replayed)).toEqual(sortById(expected));
		expect(reopened.getClaim(claimA.id)).toEqual(ledger.getClaim(claimA.id));
		expect(reopened.getClaim(claimB.id)).toEqual(ledger.getClaim(claimB.id));
	});
});

describe("openLedger — proposal lifecycle (M2s2, spec 'Roles & the checker gate')", () => {
	const reasoner = { role: "reasoner", model: "openrouter/anthropic/claude-sonnet-5" };
	const checker = { role: "checker", model: "openrouter/openai/gpt-5.6" };

	it("proposeTransition records an open proposal without applying it", () => {
		const ledger = openLedger(makeTempDir());
		const claim = ledger.recordClaim("Claim", []);

		const proposal = ledger.proposeTransition(
			claim.id,
			ClaimStatus.INFORMALLY_PROVED,
			["method=direct proof; result=holds"],
			reasoner,
		);

		expect(proposal.status).toBe("open");
		expect(proposal.claimId).toBe(claim.id);
		expect(proposal.toStatus).toBe(ClaimStatus.INFORMALLY_PROVED);
		expect(proposal.proposedBy).toEqual(reasoner);
		expect(proposal.id).toMatch(/^[A-Za-z0-9_-]+$/);

		// Not applied: the claim is still UNTESTED.
		expect(ledger.getClaim(claim.id)?.status).toBe(ClaimStatus.UNTESTED);
		expect(ledger.listProposals("open")).toEqual([proposal]);
		expect(ledger.listProposals("resolved")).toEqual([]);
		expect(ledger.listProposals("all")).toEqual([proposal]);
	});

	it("throws ClaimNotFoundError proposing a transition for an unknown claim", () => {
		const ledger = openLedger(makeTempDir());
		expect(() =>
			ledger.proposeTransition("does-not-exist", ClaimStatus.INFORMALLY_PROVED, ["evidence"], reasoner),
		).toThrow(ClaimNotFoundError);
	});

	it("approving a proposal applies updateClaim with full validation still enforced", () => {
		const ledger = openLedger(makeTempDir());
		const claim = ledger.recordClaim("Claim", []);
		const proposal = ledger.proposeTransition(
			claim.id,
			ClaimStatus.INFORMALLY_PROVED,
			["method=direct proof; result=holds"],
			reasoner,
		);

		const resolved = ledger.resolveProposal(proposal.id, {
			approved: true,
			byRole: checker.role,
			byModel: checker.model,
			notes: "Re-derived independently; agrees.",
		});

		expect(resolved.status).toBe("approved");
		expect(resolved.resolution).toEqual({
			approved: true,
			byRole: checker.role,
			byModel: checker.model,
			notes: "Re-derived independently; agrees.",
		});
		expect(resolved.resolvedAt).toBeDefined();

		const claimNow = ledger.getClaim(claim.id);
		expect(claimNow?.status).toBe(ClaimStatus.INFORMALLY_PROVED);
		expect(claimNow?.evidence).toEqual(["method=direct proof; result=holds"]);

		expect(ledger.listProposals("open")).toEqual([]);
		expect(ledger.listProposals("resolved")).toEqual([resolved]);
	});

	it("approving a FORMALLY_VERIFIED proposal without checkerArtifact throws and records/changes nothing", () => {
		const ledger = openLedger(makeTempDir());
		const claim = ledger.recordClaim("Claim", []);
		// proposeTransition itself does not validate — an illegal/incomplete
		// proposal can still be recorded; validation is deferred to approval.
		const proposal = ledger.proposeTransition(
			claim.id,
			ClaimStatus.FORMALLY_VERIFIED,
			["method=formal proof; result=holds"],
			reasoner,
			// no checkerArtifact
		);

		expect(() =>
			ledger.resolveProposal(proposal.id, { approved: true, byRole: checker.role, byModel: checker.model }),
		).toThrow(TransitionError);

		// Neither the claim nor the proposal changed.
		expect(ledger.getClaim(claim.id)?.status).toBe(ClaimStatus.UNTESTED);
		expect(ledger.getProposal(proposal.id)?.status).toBe("open");
		expect(ledger.listProposals("open")).toHaveLength(1);
		expect(ledger.listProposals("resolved")).toHaveLength(0);
	});

	it("rejecting a proposal records the verdict and leaves the claim untouched", () => {
		const ledger = openLedger(makeTempDir());
		const claim = ledger.recordClaim("Claim", []);
		const proposal = ledger.proposeTransition(
			claim.id,
			ClaimStatus.INFORMALLY_PROVED,
			["method=direct proof; result=holds"],
			reasoner,
		);

		const resolved = ledger.resolveProposal(proposal.id, {
			approved: false,
			byRole: checker.role,
			byModel: checker.model,
			notes: "Proof has a gap in case n=0.",
		});

		expect(resolved.status).toBe("rejected");
		expect(ledger.getClaim(claim.id)?.status).toBe(ClaimStatus.UNTESTED);
		expect(ledger.listProposals("open")).toEqual([]);
		expect(ledger.listProposals("resolved")).toEqual([resolved]);
	});

	it("throws ProposalNotFoundError resolving an unknown proposal id", () => {
		const ledger = openLedger(makeTempDir());
		expect(() =>
			ledger.resolveProposal("does-not-exist", { approved: true, byRole: checker.role, byModel: checker.model }),
		).toThrow(ProposalNotFoundError);
	});

	it("throws ProposalAlreadyResolvedError resolving a proposal twice", () => {
		const ledger = openLedger(makeTempDir());
		const claim = ledger.recordClaim("Claim", []);
		const proposal = ledger.proposeTransition(
			claim.id,
			ClaimStatus.INFORMALLY_PROVED,
			["method=direct proof; result=holds"],
			reasoner,
		);
		ledger.resolveProposal(proposal.id, { approved: false, byRole: checker.role, byModel: checker.model });

		expect(() =>
			ledger.resolveProposal(proposal.id, { approved: true, byRole: checker.role, byModel: checker.model }),
		).toThrow(ProposalAlreadyResolvedError);
	});

	it("a fresh openLedger() replays proposal state (open and resolved) identically", () => {
		const dir = makeTempDir();
		const ledger = openLedger(dir);
		const claimA = ledger.recordClaim("Claim A", []);
		const claimB = ledger.recordClaim("Claim B", []);

		const proposalA = ledger.proposeTransition(
			claimA.id,
			ClaimStatus.INFORMALLY_PROVED,
			["method=direct proof; result=holds"],
			reasoner,
		);
		const proposalB = ledger.proposeTransition(
			claimB.id,
			ClaimStatus.COUNTEREXAMPLE_FOUND,
			["method=n=7 fails"],
			reasoner,
		);
		ledger.resolveProposal(proposalA.id, { approved: true, byRole: checker.role, byModel: checker.model });
		// proposalB left open.

		const expectedClaims = ledger.listClaims();
		const expectedProposals = ledger.listProposals("all");

		const reopened = openLedger(dir);
		const sortById = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));

		expect(sortById(reopened.listClaims())).toEqual(sortById(expectedClaims));
		expect(sortById(reopened.listProposals("all"))).toEqual(sortById(expectedProposals));
		expect(reopened.listProposals("open").map((p) => p.id)).toEqual([proposalB.id]);
		expect(reopened.listProposals("resolved").map((p) => p.id)).toEqual([proposalA.id]);
	});
});

describe("openLedger — append-only file", () => {
	it("each mutation grows the file by one line and never rewrites earlier lines", () => {
		const dir = makeTempDir();
		const filePath = join(dir, "claims.jsonl");
		const ledger = openLedger(dir);

		const claim = ledger.recordClaim("Claim one", []);
		const linesAfterCreate = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
		expect(linesAfterCreate).toHaveLength(1);

		ledger.updateClaim(claim.id, ClaimStatus.TESTED_SMALL_CASES, ["scope=small cases"]);
		const linesAfterUpdate = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
		expect(linesAfterUpdate).toHaveLength(2);
		expect(linesAfterUpdate[0]).toBe(linesAfterCreate[0]);

		ledger.recordClaim("Claim two", []);
		const linesAfterSecondCreate = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
		expect(linesAfterSecondCreate).toHaveLength(3);
		expect(linesAfterSecondCreate[0]).toBe(linesAfterCreate[0]);
		expect(linesAfterSecondCreate[1]).toBe(linesAfterUpdate[1]);
	});
});
