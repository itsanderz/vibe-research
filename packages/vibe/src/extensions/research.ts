/**
 * Research tools extension — vibe M1 slice 3.
 *
 * Registers thin tool wrappers over `vibe-core` (the claim ledger, status
 * transitions, WSL experiment runner, and research journal) so the LLM can
 * drive a `vibe-mathing`-style investigation directly. All state lives under
 * `<ctx.cwd>/workspace`, created lazily by the vibe-core primitives on first
 * use (never eagerly at extension load — see "Long-lived resources and
 * shutdown" in docs/extensions.md).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ClaimNotFoundError,
	ClaimStatus,
	generateDossier,
	openJournal,
	openLedger,
	runExperiment,
	TransitionError,
} from "vibe-core";

/** Literal tuple (not `Object.values`) so the tool schema keeps literal
 * status types — must stay in sync with `ClaimStatus` in
 * packages/vibe-core/src/ledger/types.ts. */
const CLAIM_STATUS_VALUES = [
	ClaimStatus.UNTESTED,
	ClaimStatus.TESTED_SMALL_CASES,
	ClaimStatus.COUNTEREXAMPLE_FOUND,
	ClaimStatus.COMPUTATIONALLY_VERIFIED,
	ClaimStatus.INFORMALLY_PROVED,
	ClaimStatus.FORMALLY_VERIFIED,
] as const;

/** Characters of stdout/stderr shown to the LLM per `math_run_python` call.
 * Full output is always saved to disk under the run's artifact directory
 * regardless of this cap — this only bounds what goes back into context. */
const TOOL_OUTPUT_CHAR_CAP = 4000;

function workspaceDir(ctx: ExtensionContext): string {
	return join(ctx.cwd, "workspace");
}

function formatClaimLine(claim: { id: string; status: string; statement: string }): string {
	return `${claim.id}  ${claim.status.padEnd(24)}  ${claim.statement}`;
}

const mathRecordClaim = defineTool({
	name: "math_record_claim",
	label: "Record Claim",
	description:
		"Record a new mathematical claim in the research ledger. Starts at status UNTESTED. " +
		"The statement must be exact and self-contained (quantifiers, domain, every symbol defined) " +
		"— write it so it's understandable without the surrounding conversation. List every assumption " +
		"as a separate string. Returns the claim id, which math_update_claim needs.",
	promptSnippet: "Record a mathematical claim in the research ledger (starts UNTESTED)",
	parameters: Type.Object({
		statement: Type.String({
			description: "The exact, self-contained claim: quantifiers, domain, every symbol defined.",
		}),
		assumptions: Type.Array(Type.String(), {
			description: "Every assumption the claim depends on, one per entry. Empty array if none.",
		}),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const ledger = openLedger(workspaceDir(ctx));
		const claim = ledger.recordClaim(params.statement, params.assumptions);
		return {
			content: [
				{
					type: "text",
					text: `Recorded claim ${claim.id} (status UNTESTED): ${claim.statement}`,
				},
			],
			details: { claim },
		};
	},
});

const mathUpdateClaim = defineTool({
	name: "math_update_claim",
	label: "Update Claim",
	description:
		"Move a claim to a new status, with evidence of what check was actually run. " +
		"Evidence must state what was done (method, scope/domain tested, arithmetic mode, artifact path) — " +
		"'no counterexample found' with no stated scope is not evidence. " +
		"Statuses only strengthen: UNTESTED < TESTED_SMALL_CASES < COMPUTATIONALLY_VERIFIED < INFORMALLY_PROVED < FORMALLY_VERIFIED, " +
		"and a transition may not move to a lower rank. COUNTEREXAMPLE_FOUND is the one exception: it is reachable " +
		"from any non-terminal status (a valid counterexample refutes regardless of prior strength) and is itself " +
		"terminal — no further transitions are legal once a claim is there. FORMALLY_VERIFIED additionally requires " +
		"a non-empty checkerArtifact. An illegal transition is rejected with a clear error explaining why — read it " +
		"and choose a legal status; it is not a crash.",
	promptSnippet: "Move a claim to a new (only-strengthening) status with evidence",
	promptGuidelines: [
		"Never call math_update_claim without evidence that states the actual method, scope, and arithmetic mode used.",
		"If math_update_claim rejects a transition, do not retry the same call — pick a status the ledger will accept, or record a new claim.",
	],
	parameters: Type.Object({
		id: Type.String({ description: "Claim id, from math_record_claim or math_list_claims." }),
		status: StringEnum(CLAIM_STATUS_VALUES, {
			description: "The new status. Must not weaken the claim's current status.",
		}),
		evidence: Type.Array(Type.String(), {
			description:
				"One or more non-empty evidence strings for this transition, e.g. " +
				"'method=exhaustive search; scope=n in [-1000,1000]; arithmetic=exact integer; artifact=workspace/runs/<id>; result=no counterexample'.",
		}),
		checkerArtifact: Type.Optional(
			Type.String({
				description:
					"Required, non-empty, when status is FORMALLY_VERIFIED — path/reference to the checker's output.",
			}),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const ledger = openLedger(workspaceDir(ctx));
		// ClaimNotFoundError / TransitionError both extend Error with a clear,
		// human-readable .message. Letting them propagate from execute() is the
		// documented way to signal a tool failure to the LLM (isError: true,
		// message reported) without crashing the extension or the session — see
		// "Signaling errors" in docs/extensions.md.
		const claim = ledger.updateClaim(
			params.id,
			params.status,
			params.evidence,
			params.checkerArtifact ? { checkerArtifact: params.checkerArtifact } : undefined,
		);
		return {
			content: [
				{
					type: "text",
					text: `Claim ${claim.id} -> ${claim.status} (${claim.evidence.length} evidence entr${claim.evidence.length === 1 ? "y" : "ies"} total).`,
				},
			],
			details: { claim },
		};
	},
});

const mathListClaims = defineTool({
	name: "math_list_claims",
	label: "List Claims",
	description:
		"List every claim currently in the research ledger: id, status, statement. " +
		"Use this to look up a claim's id before calling math_update_claim, or to review overall progress.",
	promptSnippet: "List every claim in the research ledger (id, status, statement)",
	parameters: Type.Object({}),
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		const ledger = openLedger(workspaceDir(ctx));
		const claims = ledger.listClaims();
		const text =
			claims.length === 0
				? "No claims recorded yet. Use math_record_claim to start one."
				: [`${claims.length} claim(s):`, ...claims.map(formatClaimLine)].join("\n");
		return {
			content: [{ type: "text", text }],
			details: { claims },
		};
	},
});

const mathRunPython = defineTool({
	name: "math_run_python",
	label: "Run Python (WSL)",
	description:
		"Run a self-contained Python program inside WSL2 as one reproducible, saved experiment. " +
		"Use exact integer/rational/symbolic arithmetic (e.g. Python ints/fractions, SymPy) — floats are for " +
		"intuition only, never evidence for a claim. `purpose` must state the exact question this run answers, " +
		"verbatim, for the saved record — it is not a label. The code, purpose, stdout, stderr, and result are " +
		"always saved to workspace/runs/<runId>/ regardless of outcome: a nonzero exit code or a timeout is data " +
		"to record as evidence, not a failure to silently retry. timeout_seconds defaults to 60s and is clamped " +
		"to [1, 600].",
	promptSnippet: "Run a self-contained Python experiment inside WSL2 (exact arithmetic, always saved)",
	promptGuidelines: [
		"Use math_run_python for any claim that needs computational checking — never assert 'tested' without a saved run.",
		"Prefer exact arithmetic (int, Fraction, SymPy) in math_run_python scripts; float-only results cannot support a claim status.",
	],
	parameters: Type.Object({
		code: Type.String({ description: "A complete, self-contained Python program. Saved verbatim to experiment.py." }),
		purpose: Type.String({
			description: "The exact question this run is intended to answer. Saved verbatim to purpose.txt.",
		}),
		timeout_seconds: Type.Optional(
			Type.Number({ description: "Wall-clock budget in seconds. Default 60, clamped to [1, 600]." }),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const result = await runExperiment(workspaceDir(ctx), {
			code: params.code,
			purpose: params.purpose,
			timeoutSeconds: params.timeout_seconds,
		});

		const stdoutFull = readFileSync(join(result.artifactDir, "stdout.txt"), "utf8");
		const stderrFull = readFileSync(join(result.artifactDir, "stderr.txt"), "utf8");
		const stdout = stdoutFull.slice(0, TOOL_OUTPUT_CHAR_CAP);
		const stderr = stderrFull.slice(0, TOOL_OUTPUT_CHAR_CAP);
		const stdoutNote = describeTruncation(stdoutFull.length, result.stdoutTruncated);
		const stderrNote = describeTruncation(stderrFull.length, result.stderrTruncated);

		const text = [
			`runId: ${result.runId}`,
			`exitCode: ${result.exitCode}`,
			`timedOut: ${result.timedOut}`,
			`durationMs: ${result.durationMs}`,
			`artifactDir: ${result.artifactDir}`,
			`--- stdout${stdoutNote} ---`,
			stdout,
			`--- stderr${stderrNote} ---`,
			stderr,
		].join("\n");

		return {
			content: [{ type: "text", text }],
			details: {
				runId: result.runId,
				exitCode: result.exitCode,
				timedOut: result.timedOut,
				durationMs: result.durationMs,
				artifactDir: result.artifactDir,
			},
		};
	},
});

/** Note appended after a stdout/stderr section describing any truncation —
 * both this tool's own display cap and (if it happened first) the runner's
 * own on-disk capture cap. */
function describeTruncation(shownSourceLength: number, harnessTruncated: boolean): string {
	const notes: string[] = [];
	if (harnessTruncated) notes.push("capture truncated at 1MB by the runner");
	if (shownSourceLength > TOOL_OUTPUT_CHAR_CAP) {
		notes.push(`showing first ${TOOL_OUTPUT_CHAR_CAP} of ${shownSourceLength} chars`);
	}
	return notes.length > 0 ? ` (${notes.join("; ")})` : "";
}

const journalNote = defineTool({
	name: "journal_note",
	label: "Journal Note",
	description:
		"Append one entry to the live research journal (workspace/journal.md and journal.jsonl). " +
		"`phase` is a free-form label for what's happening (e.g. formalize, explore, attack, verify, surprise, " +
		"decision, synthesize) — use whatever describes the current step. Record hypotheses, experiment results, " +
		"surprises, and next moves as the investigation progresses, not only at the end.",
	promptSnippet: "Append an entry to the live research journal",
	parameters: Type.Object({
		phase: Type.String({
			description: "Free-form label for the current step, e.g. 'explore', 'attack', 'surprise'.",
		}),
		text: Type.String({ description: "The journal entry text." }),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const journal = openJournal(workspaceDir(ctx));
		const entry = journal.note(params.phase, params.text);
		return {
			content: [{ type: "text", text: `Journal entry recorded at ${entry.at} [${entry.phase}].` }],
			details: { entry },
		};
	},
});

const mathGenerateDossier = defineTool({
	name: "math_generate_dossier",
	label: "Generate Dossier",
	description:
		"Render the current workspace (claim ledger, research journal, and saved experiment runs) into a " +
		"self-contained, shareable investigation report at workspace/dossier.md. The headline sentence is chosen " +
		"verbatim from the spec §11 permitted-phrasing table for the main claim's status — it is never " +
		"free-composed. Journal text that overclaims relative to the ledger is flagged in the returned violations " +
		"and annotated in place with a '⚠ language exceeds evidence' footnote, rather than rejected. Call this as " +
		"the final step of an investigation, after the ledger and journal are up to date.",
	promptSnippet: "Render the workspace into a shareable dossier.md report",
	promptGuidelines: [
		"Call math_generate_dossier as the last step of an investigation, once every load-bearing claim and " +
			"experiment is already recorded — the dossier only arranges what is already on the ledger and journal.",
	],
	parameters: Type.Object({
		title: Type.Optional(
			Type.String({ description: "Optional dossier title (H1). Defaults to a generic title if omitted." }),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const result = generateDossier(workspaceDir(ctx), { title: params.title });
		const text =
			result.violations.length === 0
				? `Dossier written to ${result.path}. No language-policy violations found.`
				: `Dossier written to ${result.path}. ${result.violations.length} language-policy violation(s) found ` +
					"(annotated with a footnote in the journal narrative where they came from user/model-authored text): " +
					result.violations.map((v) => `"${v.match}"`).join(", ") +
					".";
		return {
			content: [{ type: "text", text }],
			details: { path: result.path, violations: result.violations },
		};
	},
});

export default function researchExtension(pi: ExtensionAPI) {
	pi.registerTool(mathRecordClaim);
	pi.registerTool(mathUpdateClaim);
	pi.registerTool(mathListClaims);
	pi.registerTool(mathRunPython);
	pi.registerTool(journalNote);
	pi.registerTool(mathGenerateDossier);
}

// Exported for the headless registration check (see scripts/check-research-extension.mjs)
// and for anything that wants to reuse the tool definitions directly.
export { mathRecordClaim, mathUpdateClaim, mathListClaims, mathRunPython, journalNote, mathGenerateDossier };

// Re-exported so callers of this module don't need a separate vibe-core
// import just to catch the errors math_update_claim can throw.
export { ClaimNotFoundError, TransitionError };
