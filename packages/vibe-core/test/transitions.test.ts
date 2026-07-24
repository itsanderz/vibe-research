import { describe, expect, it } from "vitest";
import { assertLegalTransition, STATUS_RANK, TransitionError } from "../src/ledger/transitions.ts";
import { ClaimStatus } from "../src/ledger/types.ts";

const ALL_STATUSES = Object.values(ClaimStatus);

/**
 * Independent restatement of spec §7's transition rules, used as the
 * expectation oracle for the matrix test below (deliberately not derived
 * from the implementation, so the test can catch a broken implementation
 * rather than just mirror it):
 *  - COUNTEREXAMPLE_FOUND is terminal: nothing may transition out of it.
 *  - Anything non-terminal may transition into COUNTEREXAMPLE_FOUND.
 *  - Otherwise, both statuses are on the strength ladder and the move is
 *    legal iff it does not strictly decrease rank (equal rank permitted).
 */
function expectedLegal(from: ClaimStatus, to: ClaimStatus): boolean {
	if (from === ClaimStatus.COUNTEREXAMPLE_FOUND) return false;
	if (to === ClaimStatus.COUNTEREXAMPLE_FOUND) return true;
	return STATUS_RANK[to] >= STATUS_RANK[from];
}

describe("assertLegalTransition — full 6x6 matrix", () => {
	for (const from of ALL_STATUSES) {
		for (const to of ALL_STATUSES) {
			const legal = expectedLegal(from, to);
			it(`${from} -> ${to} is ${legal ? "legal" : "illegal"}`, () => {
				const evidence = ["method=unit test; scope=matrix cell; result=n/a"];
				const opts =
					to === ClaimStatus.FORMALLY_VERIFIED ? { checkerArtifact: "workspace/runs/checker.log" } : undefined;

				if (legal) {
					expect(() => assertLegalTransition(from, to, evidence, opts)).not.toThrow();
				} else {
					try {
						assertLegalTransition(from, to, evidence, opts);
						expect.unreachable(`expected ${from} -> ${to} to throw`);
					} catch (error) {
						expect(error).toBeInstanceOf(TransitionError);
						const transitionError = error as TransitionError;
						expect(transitionError.from).toBe(from);
						expect(transitionError.to).toBe(to);
						expect(transitionError.reason.length).toBeGreaterThan(0);
					}
				}
			});
		}
	}
});

describe("assertLegalTransition — FORMALLY_VERIFIED requires checkerArtifact", () => {
	it("throws when checkerArtifact is missing, even though the rank move is legal", () => {
		expect(() =>
			assertLegalTransition(ClaimStatus.INFORMALLY_PROVED, ClaimStatus.FORMALLY_VERIFIED, ["evidence"]),
		).toThrow(TransitionError);
	});

	it("throws when checkerArtifact is an empty string", () => {
		expect(() =>
			assertLegalTransition(ClaimStatus.INFORMALLY_PROVED, ClaimStatus.FORMALLY_VERIFIED, ["evidence"], {
				checkerArtifact: "   ",
			}),
		).toThrow(TransitionError);
	});

	it("succeeds when a non-empty checkerArtifact is provided", () => {
		expect(() =>
			assertLegalTransition(ClaimStatus.INFORMALLY_PROVED, ClaimStatus.FORMALLY_VERIFIED, ["evidence"], {
				checkerArtifact: "workspace/runs/lean-checker.log",
			}),
		).not.toThrow();
	});

	it("the thrown error names the checkerArtifact reason", () => {
		try {
			assertLegalTransition(ClaimStatus.UNTESTED, ClaimStatus.FORMALLY_VERIFIED, ["evidence"]);
			expect.unreachable("expected a throw");
		} catch (error) {
			expect(error).toBeInstanceOf(TransitionError);
			expect((error as TransitionError).reason).toMatch(/checkerArtifact/);
		}
	});
});

describe("assertLegalTransition — evidence is required", () => {
	it("throws when evidence is an empty array", () => {
		expect(() => assertLegalTransition(ClaimStatus.UNTESTED, ClaimStatus.TESTED_SMALL_CASES, [])).toThrow(
			TransitionError,
		);
	});

	it("throws when every evidence entry is blank", () => {
		expect(() => assertLegalTransition(ClaimStatus.UNTESTED, ClaimStatus.TESTED_SMALL_CASES, ["   ", ""])).toThrow(
			TransitionError,
		);
	});

	it("succeeds with at least one non-empty evidence entry", () => {
		expect(() =>
			assertLegalTransition(ClaimStatus.UNTESTED, ClaimStatus.TESTED_SMALL_CASES, ["scope=n in [0,100]"]),
		).not.toThrow();
	});
});
