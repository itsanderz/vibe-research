import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertLegalTransition, type TransitionOptions } from "./transitions.ts";
import { type Claim, ClaimStatus, type Proposal, type ProposalStatus, type ProposedBy } from "./types.ts";

/**
 * One line of `claims.jsonl`. Each event carries the *full* materialized
 * claim or proposal after the event (not a delta), so replaying the file is
 * a simple fold: for each id, the last event mentioning it wins. This keeps
 * replay trivial and keeps the file genuinely append-only — prior lines are
 * never rewritten, only superseded by later ones.
 *
 * `transition_proposed`/`proposal_resolved` (M2s2, spec "Roles & the checker
 * gate") share this same file/replay mechanism rather than a separate
 * ledger: proposals reference claims by id and the two need to stay
 * consistent under the same append-only, crash-safe discipline.
 */
export type ClaimEvent =
	| { kind: "claim_created"; at: string; claim: Claim }
	| { kind: "claim_updated"; at: string; claim: Claim };

export type ProposalEvent =
	| { kind: "transition_proposed"; at: string; proposal: Proposal }
	| { kind: "proposal_resolved"; at: string; proposal: Proposal };

export type LedgerEvent = ClaimEvent | ProposalEvent;

export class ClaimNotFoundError extends Error {
	readonly id: string;

	constructor(id: string) {
		super(`No claim with id ${id}`);
		this.name = "ClaimNotFoundError";
		this.id = id;
	}
}

export class ProposalNotFoundError extends Error {
	readonly id: string;

	constructor(id: string) {
		super(`No proposal with id ${id}`);
		this.name = "ProposalNotFoundError";
		this.id = id;
	}
}

export class ProposalAlreadyResolvedError extends Error {
	readonly id: string;
	readonly status: ProposalStatus;

	constructor(id: string, status: ProposalStatus) {
		super(`Proposal ${id} was already resolved (status: ${status})`);
		this.name = "ProposalAlreadyResolvedError";
		this.id = id;
		this.status = status;
	}
}

/** Nanoid-style short id built from node:crypto only (no new dependency). Shared by claims and proposals. */
function generateId(): string {
	return randomBytes(9).toString("base64url");
}

export interface Ledger {
	/** Records a new claim with status UNTESTED and no evidence (spec §9.2). */
	recordClaim(statement: string, assumptions: string[]): Claim;
	/** Moves a claim to a new status, validating the transition (spec §9.3). */
	updateClaim(id: string, newStatus: ClaimStatus, evidence: string[], opts?: TransitionOptions): Claim;
	/** Current view of every claim, folded from the event log. */
	listClaims(): Claim[];
	getClaim(id: string): Claim | undefined;

	/**
	 * Records a proposed protected-status transition without applying it
	 * (spec "Roles & the checker gate"). Does NOT validate the transition
	 * itself (rank, evidence, checkerArtifact) — that validation is deferred
	 * to `resolveProposal`'s approve path, via the same `updateClaim` logic,
	 * so a proposal that turns out to be illegal is caught at resolution time
	 * rather than silently refused to record. Throws `ClaimNotFoundError` if
	 * `claimId` doesn't exist.
	 */
	proposeTransition(
		claimId: string,
		toStatus: ClaimStatus,
		evidence: string[],
		proposedBy: ProposedBy,
		opts?: TransitionOptions,
	): Proposal;
	/** Lists proposals, folded from the event log, filtered by resolution state. */
	listProposals(filter: "open" | "resolved" | "all"): Proposal[];
	getProposal(id: string): Proposal | undefined;
	/**
	 * Resolves an open proposal. Approving (`resolution.approved: true`)
	 * applies `updateClaim` with ALL of its existing validation (transition
	 * whitelist, non-empty evidence, `checkerArtifact` required for
	 * FORMALLY_VERIFIED) — an approved-but-invalid proposal throws
	 * (`TransitionError`/`ClaimNotFoundError`) and neither the claim nor the
	 * proposal are changed: nothing is recorded. Rejecting only records the
	 * verdict; the claim is untouched either way. Throws
	 * `ProposalNotFoundError` for an unknown id, `ProposalAlreadyResolvedError`
	 * if the proposal isn't open.
	 */
	resolveProposal(
		proposalId: string,
		resolution: { approved: boolean; byRole: string; byModel: string; notes?: string },
	): Proposal;
}

interface LedgerData {
	claims: Map<string, Claim>;
	proposals: Map<string, Proposal>;
}

function loadLedgerData(filePath: string): LedgerData {
	const claims = new Map<string, Claim>();
	const proposals = new Map<string, Proposal>();
	const contents = readFileSync(filePath, "utf8");
	for (const line of contents.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const event = JSON.parse(trimmed) as LedgerEvent;
		if (event.kind === "claim_created" || event.kind === "claim_updated") {
			claims.set(event.claim.id, event.claim);
		} else {
			proposals.set(event.proposal.id, event.proposal);
		}
	}
	return { claims, proposals };
}

/**
 * Opens (creating if necessary) the append-only JSONL ledger at
 * `<dir>/claims.jsonl`, per spec §10 (and M2s2's proposal events sharing the
 * same file — see `LedgerEvent`). Existing events are replayed into memory
 * synchronously so `listClaims`/`listProposals`/etc. are immediately
 * accurate; every subsequent mutation both updates the in-memory view and
 * appends a new event line to the file — prior lines are never rewritten.
 */
export function openLedger(dir: string): Ledger {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const filePath = join(dir, "claims.jsonl");
	if (!existsSync(filePath)) writeFileSync(filePath, "");

	const { claims, proposals } = loadLedgerData(filePath);

	function appendEvent(event: LedgerEvent): void {
		appendFileSync(filePath, `${JSON.stringify(event)}\n`);
	}

	/** Shared by `updateClaim` and `resolveProposal`'s approve path so both go through identical validation. */
	function doUpdateClaim(id: string, newStatus: ClaimStatus, evidence: string[], opts?: TransitionOptions): Claim {
		const current = claims.get(id);
		if (!current) throw new ClaimNotFoundError(id);

		assertLegalTransition(current.status, newStatus, evidence, opts);

		const now = new Date().toISOString();
		const updated: Claim = {
			...current,
			status: newStatus,
			evidence: [...current.evidence, ...evidence],
			updatedAt: now,
		};
		claims.set(id, updated);
		appendEvent({ kind: "claim_updated", at: now, claim: updated });
		return updated;
	}

	return {
		recordClaim(statement, assumptions) {
			const now = new Date().toISOString();
			const claim: Claim = {
				id: generateId(),
				statement,
				assumptions: [...assumptions],
				status: ClaimStatus.UNTESTED,
				evidence: [],
				createdAt: now,
				updatedAt: now,
			};
			claims.set(claim.id, claim);
			appendEvent({ kind: "claim_created", at: now, claim });
			return claim;
		},

		updateClaim(id, newStatus, evidence, opts) {
			return doUpdateClaim(id, newStatus, evidence, opts);
		},

		listClaims() {
			return [...claims.values()];
		},

		getClaim(id) {
			return claims.get(id);
		},

		proposeTransition(claimId, toStatus, evidence, proposedBy, opts) {
			if (!claims.has(claimId)) throw new ClaimNotFoundError(claimId);

			const now = new Date().toISOString();
			const proposal: Proposal = {
				id: generateId(),
				claimId,
				toStatus,
				evidence: [...evidence],
				checkerArtifact: opts?.checkerArtifact,
				proposedBy: { ...proposedBy },
				status: "open",
				createdAt: now,
			};
			proposals.set(proposal.id, proposal);
			appendEvent({ kind: "transition_proposed", at: now, proposal });
			return proposal;
		},

		listProposals(filter) {
			const all = [...proposals.values()];
			if (filter === "all") return all;
			if (filter === "open") return all.filter((p) => p.status === "open");
			return all.filter((p) => p.status !== "open");
		},

		getProposal(id) {
			return proposals.get(id);
		},

		resolveProposal(proposalId, resolution) {
			const proposal = proposals.get(proposalId);
			if (!proposal) throw new ProposalNotFoundError(proposalId);
			if (proposal.status !== "open") throw new ProposalAlreadyResolvedError(proposalId, proposal.status);

			if (resolution.approved) {
				// Throws before the proposal (or claim) is touched if the
				// transition turns out to be illegal — see doUpdateClaim.
				doUpdateClaim(
					proposal.claimId,
					proposal.toStatus,
					proposal.evidence,
					proposal.checkerArtifact ? { checkerArtifact: proposal.checkerArtifact } : undefined,
				);
			}

			const now = new Date().toISOString();
			const resolved: Proposal = {
				...proposal,
				status: resolution.approved ? "approved" : "rejected",
				resolvedAt: now,
				resolution: { ...resolution },
			};
			proposals.set(proposal.id, resolved);
			appendEvent({ kind: "proposal_resolved", at: now, proposal: resolved });
			return resolved;
		},
	};
}
