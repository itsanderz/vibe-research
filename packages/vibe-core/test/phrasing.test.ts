import { describe, expect, it } from "vitest";
import { ClaimStatus } from "../src/ledger/types.ts";
import { checkReportLanguage, PERMITTED_CONCLUSION_LANGUAGE } from "../src/report/phrasing.ts";

describe("checkReportLanguage — compliant report per status", () => {
	for (const status of Object.values(ClaimStatus)) {
		it(`accepts the spec §11 permitted sentence for ${status}`, () => {
			const result = checkReportLanguage(PERMITTED_CONCLUSION_LANGUAGE[status], status);
			expect(result.ok).toBe(true);
			expect(result.violations).toEqual([]);
		});
	}
});

describe("checkReportLanguage — overclaiming report per status", () => {
	// NOTE: FORMALLY_VERIFIED is the strongest status on the ladder, so there
	// is no wording this policy bans at that status (nothing can overclaim
	// past the top of the ladder). It is covered separately below instead of
	// in this table — see the resolved-ambiguity note there.
	const overclaimCases: { status: ClaimStatus; text: string; expectedTerm: string }[] = [
		{
			status: ClaimStatus.UNTESTED,
			text: "This has been formally verified for all integers n.",
			expectedTerm: "formally verified",
		},
		{
			status: ClaimStatus.TESTED_SMALL_CASES,
			text: "The identity was proved for all valid inputs.",
			expectedTerm: "proved",
		},
		{
			status: ClaimStatus.COUNTEREXAMPLE_FOUND,
			text: "Despite the counterexample, the claim always holds in general.",
			expectedTerm: "always holds",
		},
		{
			status: ClaimStatus.COMPUTATIONALLY_VERIFIED,
			text: "The exhaustive check means the claim is proven.",
			expectedTerm: "proven",
		},
		{
			status: ClaimStatus.INFORMALLY_PROVED,
			text: "The result is machine-checked and fully certified.",
			expectedTerm: "machine-checked",
		},
	];

	for (const { status, text, expectedTerm } of overclaimCases) {
		it(`rejects overclaiming language for ${status} and identifies "${expectedTerm}"`, () => {
			const result = checkReportLanguage(text, status);
			expect(result.ok).toBe(false);
			expect(result.violations.some((v) => v.term === expectedTerm)).toBe(true);
		});
	}

	it("FORMALLY_VERIFIED: the policy has no banned wording left at the top status (resolved ambiguity, see README/task notes) — strong language that would be rejected at every lower status is accepted here", () => {
		const text = "This was proved and formally verified for all n; the result is machine-checked and always holds.";
		const result = checkReportLanguage(text, ClaimStatus.FORMALLY_VERIFIED);
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);

		// Sanity check: the same sentence is rejected at every status below FORMALLY_VERIFIED.
		for (const status of Object.values(ClaimStatus)) {
			if (status === ClaimStatus.FORMALLY_VERIFIED) continue;
			expect(checkReportLanguage(text, status).ok).toBe(false);
		}
	});
});

describe("checkReportLanguage — negation handling", () => {
	it("does not flag 'not proved' at a low status", () => {
		const result = checkReportLanguage("The claim was not proved and remains open.", ClaimStatus.UNTESTED);
		expect(result.ok).toBe(true);
	});

	it("does not flag 'cannot be verified' at a low status", () => {
		const result = checkReportLanguage(
			"With the tools available, this cannot be verified further.",
			ClaimStatus.UNTESTED,
		);
		expect(result.ok).toBe(true);
	});

	it("still flags an unrelated banned word later in the same report", () => {
		const result = checkReportLanguage(
			"The claim was not proved. Separately, the identity always holds for the tested range.",
			ClaimStatus.TESTED_SMALL_CASES,
		);
		expect(result.ok).toBe(false);
		expect(result.violations.some((v) => v.term === "always holds")).toBe(true);
		expect(result.violations.some((v) => v.term === "proved")).toBe(false);
	});
});

describe("checkReportLanguage — violation shape", () => {
	it("returns structured violations with term, match, index, and reason", () => {
		const text = "We believe this is Proved.";
		const result = checkReportLanguage(text, ClaimStatus.UNTESTED);
		expect(result.violations).toHaveLength(1);
		const [violation] = result.violations;
		expect(violation.term).toBe("proved");
		expect(violation.match).toBe("Proved");
		expect(text.slice(violation.index, violation.index + violation.match.length)).toBe("Proved");
		expect(violation.reason.length).toBeGreaterThan(0);
	});
});
