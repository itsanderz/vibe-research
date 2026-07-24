import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaimNotFoundError, openLedger } from "../src/ledger/store.ts";
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
