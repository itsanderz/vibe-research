import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateDossier } from "../src/dossier/dossier.ts";
import { openJournal } from "../src/journal/journal.ts";
import { openLedger } from "../src/ledger/store.ts";
import { ClaimStatus } from "../src/ledger/types.ts";
import { PERMITTED_CONCLUSION_LANGUAGE } from "../src/report/phrasing.ts";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "vibe-core-dossier-"));
}

/**
 * Hand-builds a `runs/<runId>/{experiment.py,purpose.txt,result.json,...}`
 * fixture matching the exact shape `runExperiment` (src/runs/runner.ts)
 * writes, for a failed (nonzero exit) run — so this test doesn't require
 * WSL to exercise a failed-run row in the dossier.
 */
function writeFailedRunFixture(workspaceDir: string, runId: string): void {
	const dir = join(workspaceDir, "runs", runId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "experiment.py"), "import sys\nsys.exit(3)\n");
	writeFileSync(join(dir, "purpose.txt"), "Check whether n=41 breaks the primality pattern.");
	writeFileSync(
		join(dir, "result.json"),
		`${JSON.stringify(
			{
				runId,
				purpose: "Check whether n=41 breaks the primality pattern.",
				exitCode: 3,
				timedOut: false,
				durationMs: 42,
				stdoutTruncated: false,
				stderrTruncated: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				pythonCommand: `wsl.exe -d Ubuntu -- timeout 65s python3 /mnt/c/fake/${runId}/experiment.py`,
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(join(dir, "stdout.txt"), "");
	writeFileSync(join(dir, "stderr.txt"), "boom\n");
}

/** Builds a synthetic workspace via the real ledger/journal APIs: one claim
 * at TESTED_SMALL_CASES (the first recorded, so it's the main claim), one at
 * COUNTEREXAMPLE_FOUND, a journal entry that plants an overclaiming phrase,
 * and one hand-written failed-run fixture. */
function buildWorkspace() {
	const workspaceDir = makeTempDir();
	const ledger = openLedger(workspaceDir);
	const journal = openJournal(workspaceDir);

	const smallCases = ledger.recordClaim("For every integer n in [0, 100], n^2 >= n.", ["n is a non-negative integer"]);
	ledger.updateClaim(smallCases.id, ClaimStatus.TESTED_SMALL_CASES, [
		"method=enumeration; scope=n in [0,100]; arithmetic=exact integer; result=no counterexample",
	]);

	const counter = ledger.recordClaim("For every integer n, n^2 - n + 41 is prime.", ["n is an integer"]);
	ledger.updateClaim(counter.id, ClaimStatus.COUNTEREXAMPLE_FOUND, [
		"method=direct evaluation; scope=n=41; arithmetic=exact integer; result=41^2-41+41=41^2, divisible by 41, not prime",
	]);

	journal.note("formalize", "Stated both claims precisely before testing either one.");
	journal.note(
		"attack",
		"This note overclaims on purpose: the result was formally verified for all n, which is not actually true yet.",
	);

	const runId = "20260101T000000000-abcdef";
	writeFailedRunFixture(workspaceDir, runId);

	return { workspaceDir, smallCasesId: smallCases.id, counterId: counter.id, runId };
}

/** Pulls out the text between two `## ` markdown headings (exclusive of the
 * headings themselves) so assertions can target one section precisely. */
function sectionBetween(text: string, startHeading: string, endHeading: string): string {
	const start = text.indexOf(startHeading);
	const end = text.indexOf(endHeading, start);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	return text.slice(start + startHeading.length, end);
}

describe("generateDossier", () => {
	it("headline matches the spec §11 permitted phrasing for the main claim's status exactly", () => {
		const { workspaceDir } = buildWorkspace();
		const { path, violations: _v } = generateDossier(workspaceDir);
		const text = readFileSync(path, "utf8");

		// Main claim = first recorded = the TESTED_SMALL_CASES claim.
		expect(text).toContain(`**${PERMITTED_CONCLUSION_LANGUAGE[ClaimStatus.TESTED_SMALL_CASES]}**`);
		// Sanity: the exact permitted sentence, not a paraphrase.
		expect(PERMITTED_CONCLUSION_LANGUAGE[ClaimStatus.TESTED_SMALL_CASES]).toBe(
			"No counterexample was found in the tested cases.",
		);
	});

	it("surfaces the planted overclaiming journal phrase in violations and annotates it with the footnote", () => {
		const { workspaceDir } = buildWorkspace();
		const { violations, path } = generateDossier(workspaceDir);

		expect(violations.length).toBeGreaterThan(0);
		expect(violations.some((v) => v.term === "formally verified")).toBe(true);
		expect(violations.some((v) => v.term === "for all")).toBe(true);

		const text = readFileSync(path, "utf8");
		const findings = sectionBetween(text, "## What we found", "## Claims & evidence");
		expect(findings).toContain("formally verified for all n");
		expect(findings).toContain("⚠ language exceeds evidence");

		// The other (non-overclaiming) journal entry must NOT get a footnote.
		const formalizeBlockStart = findings.indexOf("[formalize]");
		const attackBlockStart = findings.indexOf("[attack]");
		const formalizeBlock = findings.slice(formalizeBlockStart, attackBlockStart);
		expect(formalizeBlock).not.toContain("⚠ language exceeds evidence");
	});

	it("lists the TESTED_SMALL_CASES claim in Limitations with its mechanical next-step text", () => {
		const { workspaceDir, smallCasesId } = buildWorkspace();
		const { path } = generateDossier(workspaceDir);
		const text = readFileSync(path, "utf8");

		const limitations = sectionBetween(text, "## Limitations & open items", "## Reproduce");
		expect(limitations).toContain(smallCasesId);
		expect(limitations).toContain("COMPUTATIONALLY_VERIFIED");
		expect(limitations).toContain("next step");
	});

	it("flags the failed run in Limitations as inconclusive/failed evidence", () => {
		const { workspaceDir, runId } = buildWorkspace();
		const { path } = generateDossier(workspaceDir);
		const text = readFileSync(path, "utf8");

		const limitations = sectionBetween(text, "## Limitations & open items", "## Reproduce");
		expect(limitations).toContain(runId);
		expect(limitations).toContain("did not complete cleanly");
	});

	it("is deterministic: two generations over the same workspace differ only on the Generated: line", () => {
		const { workspaceDir } = buildWorkspace();

		const first = generateDossier(workspaceDir);
		const firstText = readFileSync(first.path, "utf8");
		const second = generateDossier(workspaceDir);
		const secondText = readFileSync(second.path, "utf8");

		expect(firstText).toMatch(/^Generated: .+$/m);
		expect(secondText).toMatch(/^Generated: .+$/m);

		const strip = (text: string) => text.replace(/^Generated: .*$/m, "Generated: <REDACTED>");
		expect(strip(firstText)).toBe(strip(secondText));
	});

	it("Reproduce section contains the failed run's relative artifact path and rerun command", () => {
		const { workspaceDir, runId } = buildWorkspace();
		const { path } = generateDossier(workspaceDir);
		const text = readFileSync(path, "utf8");

		const reproduce = text.slice(text.indexOf("## Reproduce"));
		expect(reproduce).toContain(`runs/${runId}`);
		expect(reproduce).toContain(`wsl.exe -d Ubuntu -- python3 runs/${runId}/experiment.py`);
		expect(reproduce).toContain("claims.jsonl");
		expect(reproduce).toContain("journal");
	});

	it("Claims & evidence table lists both claims with id, status, and statement", () => {
		const { workspaceDir, smallCasesId, counterId } = buildWorkspace();
		const { path } = generateDossier(workspaceDir);
		const text = readFileSync(path, "utf8");

		const claimsSection = sectionBetween(text, "## Claims & evidence", "## Experiments");
		expect(claimsSection).toContain(smallCasesId);
		expect(claimsSection).toContain(ClaimStatus.TESTED_SMALL_CASES);
		expect(claimsSection).toContain(counterId);
		expect(claimsSection).toContain(ClaimStatus.COUNTEREXAMPLE_FOUND);
		expect(claimsSection).toContain(
			"method=enumeration; scope=n in [0,100]; arithmetic=exact integer; result=no counterexample",
		);
	});

	it("opts.title overrides the default H1 title", () => {
		const { workspaceDir } = buildWorkspace();
		const { path } = generateDossier(workspaceDir, { title: "n^2 - n + 41 investigation" });
		const text = readFileSync(path, "utf8");
		expect(text.startsWith("# n^2 - n + 41 investigation\n")).toBe(true);
	});

	it("opts.problem selects a different main claim by matching its statement", () => {
		const { workspaceDir, counterId } = buildWorkspace();
		const { path } = generateDossier(workspaceDir, { problem: "n^2 - n + 41 is prime" });
		const text = readFileSync(path, "utf8");

		// Main claim is now the COUNTEREXAMPLE_FOUND one, so the headline must
		// switch to that status's permitted phrasing, not the small-cases one.
		expect(text).toContain(`**${PERMITTED_CONCLUSION_LANGUAGE[ClaimStatus.COUNTEREXAMPLE_FOUND]}**`);
		expect(text).not.toContain(`**${PERMITTED_CONCLUSION_LANGUAGE[ClaimStatus.TESTED_SMALL_CASES]}**`);
		void counterId;
	});

	it("empty workspace: no claims, no journal, no runs still renders a valid dossier", () => {
		const workspaceDir = makeTempDir();
		const { path, violations } = generateDossier(workspaceDir);
		const text = readFileSync(path, "utf8");

		expect(violations).toEqual([]);
		expect(text).toContain("No claims have been recorded for this investigation");
		expect(text).toContain("No journal entries were recorded");
		expect(text).toContain("No experiments have been run");
	});
});
