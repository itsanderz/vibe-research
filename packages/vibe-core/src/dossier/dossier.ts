import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openJournal } from "../journal/journal.ts";
import { openLedger } from "../ledger/store.ts";
import { STATUS_RANK } from "../ledger/transitions.ts";
import { type Claim, ClaimStatus } from "../ledger/types.ts";
import { checkReportLanguage, PERMITTED_CONCLUSION_LANGUAGE, type PhrasingViolation } from "../report/phrasing.ts";

/**
 * Dossier generator — spec §5 Phase 6 (report contents) and §11 (status-bound
 * language), PLAN.md's "self-contained git-native dossiers" decision, and
 * VISION.md's "plain-language narrative first, technical detail after."
 *
 * Renders `<workspaceDir>/dossier.md`: a single self-contained markdown file
 * assembled from the claim ledger (`claims.jsonl`), the research journal
 * (`journal.md` / `journal.jsonl`), and the saved experiment runs
 * (`runs/<run-id>/{purpose.txt,result.json}`). Nothing here re-derives or
 * paraphrases evidence — it only arranges what is already on record.
 */

export interface GenerateDossierOptions {
	/** Dossier title (H1). Defaults to a generic title if omitted. */
	title?: string;
	/**
	 * Free-text description of the problem under investigation. When given,
	 * the main claim is the first recorded claim whose statement matches this
	 * text (case-insensitive substring, either direction) instead of simply
	 * the first claim ever recorded. See `resolveMainClaim` for the exact
	 * rule — this is a documented, resolved ambiguity (the spec says only
	 * "unless opts.problem names another").
	 */
	problem?: string;
}

export interface GenerateDossierResult {
	/** Absolute path to the written `dossier.md`. */
	path: string;
	/**
	 * Every phrasing-policy violation found in the *final assembled document*
	 * (spec §11 / `checkReportLanguage`), checked against the strongest status
	 * present among all claims. This includes violations inside verbatim
	 * journal quotes (expected to happen sometimes — the journal is
	 * user/model-authored prose, not generator output; those get a
	 * "⚠ language exceeds evidence" footnote in the dossier rather than being
	 * rejected) as well as anything in the machine-generated scaffolding
	 * around it (headline, claims table, limitations mapping, reproduce
	 * commands) — which should never happen and would indicate a bug in this
	 * generator if it did. This function does not distinguish the two
	 * categories in the return value; see the "resolved ambiguity" note in
	 * the M1 task output for why.
	 */
	violations: PhrasingViolation[];
}

interface RunSummary {
	runId: string;
	purpose: string;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number | null;
	/** Path relative to the workspace directory, e.g. `runs/<run-id>`. */
	relativeArtifactPath: string;
}

const DEFAULT_TITLE = "Investigation Dossier";
const NO_CLAIMS_HEADLINE = "No claims have been recorded for this investigation yet.";
const LANGUAGE_FOOTNOTE =
	"> ⚠ language exceeds evidence — this entry uses stronger claim language than the ledger currently supports.";

/**
 * Mechanical "what would strengthen it" mapping for the Limitations section.
 * Only `UNTESTED` and `TESTED_SMALL_CASES` have entries: those are the two
 * statuses the task requires this section to list. The `requires` text is
 * deliberately generic/mechanical (spec-shaped, not claim-specific) — it
 * names the next rung on the ladder (spec §7) and, for `TESTED_SMALL_CASES`,
 * both legal next moves (`COMPUTATIONALLY_VERIFIED` only applies when the
 * domain is genuinely complete/bounded — spec §7 — otherwise `INFORMALLY_PROVED`).
 */
const NEXT_STEP: Partial<Record<ClaimStatus, { next: ClaimStatus; requires: string }>> = {
	[ClaimStatus.UNTESTED]: {
		next: ClaimStatus.TESTED_SMALL_CASES,
		requires:
			"Test a representative set of small, boundary, and edge cases with exact arithmetic, and record the " +
			"method, scope, and arithmetic mode as evidence.",
	},
	[ClaimStatus.TESTED_SMALL_CASES]: {
		next: ClaimStatus.COMPUTATIONALLY_VERIFIED,
		requires:
			"Either exhaustively check the claim's complete finite domain (reaching COMPUTATIONALLY_VERIFIED — only " +
			"valid if that domain is genuinely bounded) or construct and check a complete informal proof (reaching " +
			"INFORMALLY_PROVED).",
	},
};

function escapeTableCell(text: string): string {
	return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/**
 * The main claim for the headline: the first claim whose statement matches
 * `problem` (case-insensitive substring, checked in both directions so a
 * short `problem` string matches a longer formal statement and vice versa),
 * or the first claim ever recorded if `problem` is omitted or matches
 * nothing. Returns `undefined` only when the ledger has no claims at all.
 */
function resolveMainClaim(claims: Claim[], problem: string | undefined): Claim | undefined {
	if (claims.length === 0) return undefined;
	const needle = problem?.trim().toLowerCase();
	if (needle) {
		const named = claims.find((claim) => {
			const statement = claim.statement.toLowerCase();
			return statement.includes(needle) || needle.includes(statement);
		});
		if (named) return named;
	}
	return claims[0];
}

/** The strongest status among all recorded claims, by `STATUS_RANK` (spec
 * §7). `UNTESTED` if the ledger has no claims — the weakest possible
 * baseline, which makes `checkReportLanguage` strictest by default. */
function resolveStrongestStatus(claims: Claim[]): ClaimStatus {
	let strongest: ClaimStatus = ClaimStatus.UNTESTED;
	let strongestRank = STATUS_RANK[strongest];
	for (const claim of claims) {
		const rank = STATUS_RANK[claim.status];
		if (rank > strongestRank) {
			strongest = claim.status;
			strongestRank = rank;
		}
	}
	return strongest;
}

/**
 * Reads every saved run under `<workspaceDir>/runs/`, sorted by run id
 * (stable and deterministic: run ids are UTC-timestamp-prefixed, so
 * lexicographic order is chronological order — see `generateRunId` in
 * `runs/runner.ts`). A run missing `result.json` (e.g. the process crashed
 * before the runner could write it) is still listed, with `exitCode: null`,
 * `timedOut: false`, `durationMs: null` — honest degradation (spec NFR-4)
 * rather than silently dropping the run.
 */
function listRuns(workspaceDir: string): RunSummary[] {
	const runsDir = join(resolve(workspaceDir), "runs");
	if (!existsSync(runsDir)) return [];

	const runIds = readdirSync(runsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();

	return runIds.map((runId) => {
		const dir = join(runsDir, runId);
		const resultPath = join(dir, "result.json");
		const purposePath = join(dir, "purpose.txt");

		let exitCode: number | null = null;
		let timedOut = false;
		let durationMs: number | null = null;
		if (existsSync(resultPath)) {
			const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
			exitCode = typeof parsed.exitCode === "number" ? parsed.exitCode : null;
			timedOut = Boolean(parsed.timedOut);
			durationMs = typeof parsed.durationMs === "number" ? parsed.durationMs : null;
		}
		const purpose = existsSync(purposePath) ? readFileSync(purposePath, "utf8").trim() : "(purpose not recorded)";

		return { runId, purpose, exitCode, timedOut, durationMs, relativeArtifactPath: `runs/${runId}` };
	});
}

/**
 * "What we found" — spec: the journal IS the narrative. Every entry is
 * rendered chronologically, phase-labeled, with its `text` reproduced
 * verbatim (never paraphrased or summarized). Each entry is independently
 * checked against `strongestStatus`; an entry whose own text trips the
 * phrasing policy gets a `LANGUAGE_FOOTNOTE` line appended after it rather
 * than being rejected or rewritten — the journal is user/model-authored
 * prose, not something this generator is allowed to edit.
 */
function buildFindingsSection(
	entries: readonly { at: string; phase: string; text: string }[],
	strongestStatus: ClaimStatus,
): string {
	if (entries.length === 0) {
		return "No journal entries were recorded for this investigation.\n";
	}
	const blocks: string[] = [];
	for (const entry of entries) {
		const lines = [`**[${entry.phase}]** _(${entry.at})_`, "", entry.text];
		if (checkReportLanguage(entry.text, strongestStatus).violations.length > 0) {
			lines.push("", LANGUAGE_FOOTNOTE);
		}
		blocks.push(lines.join("\n"));
	}
	return `${blocks.join("\n\n")}\n`;
}

/** "Claims & evidence" — a compact verification table (id, status, statement)
 * plus every evidence string ever recorded, as a nested bullet list keyed by
 * claim id (spec §5 Phase 6 item 4: "a compact verification table"). */
function buildClaimsSection(claims: readonly Claim[]): string {
	if (claims.length === 0) {
		return "No claims have been recorded for this investigation.\n";
	}

	const tableRows = claims.map(
		(claim) => `| \`${claim.id}\` | ${claim.status} | ${escapeTableCell(claim.statement)} |`,
	);
	const table = ["| ID | Status | Statement |", "|---|---|---|", ...tableRows].join("\n");

	const evidenceBlocks = claims.map((claim) => {
		const bullets =
			claim.evidence.length > 0
				? claim.evidence.map((entry) => `  - ${entry}`).join("\n")
				: "  - (no evidence recorded)";
		return `- \`${claim.id}\`\n${bullets}`;
	});

	return `${table}\n\n**Evidence**\n\n${evidenceBlocks.join("\n")}\n`;
}

/** "Experiments" — one row per saved run (spec §5 Phase 6 item 5: "links or
 * paths to experiment artifacts"). */
function buildExperimentsSection(runs: readonly RunSummary[]): string {
	if (runs.length === 0) {
		return "No experiments have been run for this investigation.\n";
	}
	const rows = runs.map(
		(run) =>
			`| \`${run.runId}\` | ${escapeTableCell(run.purpose)} | ${run.exitCode ?? "null"} | ${run.timedOut} | ` +
			`${run.durationMs ?? "-"} | \`${run.relativeArtifactPath}\` |`,
	);
	return [
		"| Run ID | Purpose | Exit code | Timed out | Duration (ms) | Artifact |",
		"|---|---|---|---|---|---|",
		...rows,
	].join("\n");
}

/** "Limitations & open items" — spec §5 Phase 6 item 6 and §14 acceptance
 * criterion 10 ("the final answer contains ... limitations and next step").
 * Auto-generated, mechanical, per-claim/-run — never free-composed prose
 * about the investigation as a whole. */
function buildLimitationsSection(claims: readonly Claim[], runs: readonly RunSummary[]): string {
	const lines: string[] = [];

	for (const claim of claims) {
		const step = NEXT_STEP[claim.status];
		if (!step) continue;
		lines.push(
			`- Claim \`${claim.id}\` (${claim.status}): "${escapeTableCell(claim.statement)}" — next step: reach ` +
				`${step.next}. ${step.requires}`,
		);
	}

	for (const run of runs) {
		if (run.timedOut || (run.exitCode !== null && run.exitCode !== 0)) {
			lines.push(
				`- Run \`${run.runId}\` (${escapeTableCell(run.purpose)}) did not complete cleanly ` +
					`(exitCode=${run.exitCode ?? "null"}, timedOut=${run.timedOut}) — treat as inconclusive or failed ` +
					"evidence, not support for any claim.",
			);
		}
	}

	if (lines.length === 0) {
		lines.push(
			"No open items identified: no claim is stuck at UNTESTED or TESTED_SMALL_CASES, and every experiment " +
				"completed without a timeout or a nonzero exit code.",
		);
	}

	return `${lines.join("\n")}\n`;
}

/** "Reproduce" — spec §5 Phase 6 item 5 / NFR-2 (reproducibility): the exact
 * command to rerun each saved experiment, plus pointers to the raw ledger
 * and journal for anyone who wants the full evidence trail. */
function buildReproduceSection(runs: readonly RunSummary[]): string {
	const lines = ["Run these commands from the workspace directory:", ""];
	if (runs.length === 0) {
		lines.push("No experiments have been run yet.");
	} else {
		lines.push(
			"```",
			...runs.map((run) => `wsl.exe -d Ubuntu -- python3 ${run.relativeArtifactPath}/experiment.py`),
			"```",
		);
	}
	lines.push("", "Full claim history: `claims.jsonl`", "Full narrative: `journal.md` / `journal.jsonl`");
	return `${lines.join("\n")}\n`;
}

/**
 * Renders `<workspaceDir>/dossier.md` — a self-contained, shareable
 * investigation report (spec §5 Phase 6; PLAN.md's "self-contained
 * git-native dossiers" decision) — and returns its path plus any
 * phrasing-policy violations found in it (spec §11).
 *
 * Deterministic given an unchanged workspace: claim order follows the
 * ledger's replay order (first-created-first, per `Ledger.listClaims`),
 * journal order follows `journal.jsonl` (append order), and run order is an
 * explicit lexicographic sort of run ids (which are timestamp-prefixed, so
 * this is also chronological order — see `listRuns`). The only line that can
 * differ between two calls over the same workspace is the `Generated:` line.
 *
 * Never throws on overclaiming journal prose or a rogue claim statement —
 * language-policy violations are reported in the return value (and, for
 * journal entries specifically, annotated in place with a
 * "⚠ language exceeds evidence" footnote) rather than rejecting the dossier,
 * per NFR-4 (honest degradation: a policy violation is a fact to surface,
 * not grounds to fail the whole render).
 */
export function generateDossier(workspaceDir: string, opts: GenerateDossierOptions = {}): GenerateDossierResult {
	const ledger = openLedger(workspaceDir);
	const journal = openJournal(workspaceDir);

	const claims = ledger.listClaims();
	const entries = journal.entries();
	const runs = listRuns(workspaceDir);

	const mainClaim = resolveMainClaim(claims, opts.problem);
	const strongestStatus = resolveStrongestStatus(claims);
	const title = opts.title ?? DEFAULT_TITLE;
	// Headline is CHOSEN from the spec §11 table for the main claim's status,
	// never free-composed — see PERMITTED_CONCLUSION_LANGUAGE.
	const headline = mainClaim ? PERMITTED_CONCLUSION_LANGUAGE[mainClaim.status] : NO_CLAIMS_HEADLINE;

	const generatedAt = new Date().toISOString();

	const body = [
		`# ${title}`,
		"",
		`Generated: ${generatedAt}`,
		"",
		`**${headline}**`,
		"",
		"## What we found",
		"",
		buildFindingsSection(entries, strongestStatus),
		"## Claims & evidence",
		"",
		buildClaimsSection(claims),
		"## Experiments",
		"",
		buildExperimentsSection(runs),
		"",
		"## Limitations & open items",
		"",
		buildLimitationsSection(claims, runs),
		"## Reproduce",
		"",
		buildReproduceSection(runs),
	].join("\n");

	const { violations } = checkReportLanguage(body, strongestStatus);

	const path = join(resolve(workspaceDir), "dossier.md");
	writeFileSync(path, body);

	return { path, violations };
}
