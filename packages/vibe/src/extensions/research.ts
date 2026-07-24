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
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ClaimNotFoundError,
	ClaimStatus,
	generateDossier,
	openJournal,
	openLedger,
	PreregNotFoundError,
	PreregValidationError,
	ProposalAlreadyResolvedError,
	ProposalNotFoundError,
	recordPreregOutcome,
	registerPrereg,
	runExperiment,
	TransitionError,
} from "vibe-core";

/**
 * Session role — M2s2, spec "Roles & the checker gate". The pi SDK's
 * `ExtensionFactory` type is `(pi: ExtensionAPI) => void | Promise<void>`
 * with no config parameter, and `ExtensionContext` carries no custom-config
 * field either (checked packages/coding-agent/src/core/extensions/types.ts:
 * no field on `ExtensionContext` or `DefaultResourceLoader`'s
 * `extensionFactories?: InlineExtension[]` passes anything but the bare
 * factory function through). There is no built-in channel to parameterize an
 * extension factory, so `createResearchExtension(options)` below is a
 * closure-based factory-of-factory: the *cleanest* supported mechanism,
 * capturing `role` before returning the real `ExtensionFactory`. The env var
 * is an explicit fallback for callers (or a future CLI flag) that can't reach
 * into the loader's extensionFactories array to pass options directly.
 */
const SESSION_ROLE_ENV_VAR = "VIBE_SESSION_ROLE";

export interface ResearchExtensionOptions {
	/** "reasoner" (default) or "checker" — see module doc comment above for how this gets here. */
	role?: string;
}

function resolveRole(options?: ResearchExtensionOptions): string {
	return options?.role ?? process.env[SESSION_ROLE_ENV_VAR] ?? "reasoner";
}

/**
 * Protected statuses (spec "Roles & the checker gate"): reaching any of
 * these is the trust-sensitive step in an investigation, so a non-checker
 * session's math_update_claim to one of these becomes a `proposeTransition`
 * instead of applying immediately — only a checker session (a different
 * model family, enforced by the loop — see vibe-core's `assertDistinctCheckerFamily`)
 * may apply it, via `math_review_proposal`.
 */
const PROTECTED_STATUSES: ReadonlySet<string> = new Set([
	ClaimStatus.INFORMALLY_PROVED,
	ClaimStatus.FORMALLY_VERIFIED,
	ClaimStatus.COUNTEREXAMPLE_FOUND,
]);

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

/**
 * `math_update_claim` is role-aware (M2s2): a non-checker session moving a
 * claim to a PROTECTED status doesn't apply the transition — it records a
 * proposal for a checker session (a different model family) to review from
 * the artifacts. Every other transition (including COUNTEREXAMPLE_FOUND for
 * a *checker* session itself, e.g. re-resolving a proposal by hand) is
 * unaffected. `role` is captured by the enclosing `createResearchExtension`
 * closure — see the module doc comment above `SESSION_ROLE_ENV_VAR`.
 */
function createMathUpdateClaim(role: string) {
	return defineTool({
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
			"and choose a legal status; it is not a crash. In a non-checker session, moving to a PROTECTED status " +
			"(INFORMALLY_PROVED, FORMALLY_VERIFIED, COUNTEREXAMPLE_FOUND) does not apply immediately — it is recorded " +
			"as a proposal for an independent checker session to review from the artifacts; that is expected, not an error.",
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
			const opts = params.checkerArtifact ? { checkerArtifact: params.checkerArtifact } : undefined;

			if (role !== "checker" && PROTECTED_STATUSES.has(params.status)) {
				const proposal = ledger.proposeTransition(
					params.id,
					params.status,
					params.evidence,
					{ role, model: ctx.model?.id ?? "unknown" },
					opts,
				);
				return {
					content: [
						{
							type: "text",
							text: `Recorded as proposal ${proposal.id}. A checker session using a different model family will review it from the artifacts.`,
						},
					],
					details: { proposal },
				};
			}

			// ClaimNotFoundError / TransitionError both extend Error with a clear,
			// human-readable .message. Letting them propagate from execute() is the
			// documented way to signal a tool failure to the LLM (isError: true,
			// message reported) without crashing the extension or the session — see
			// "Signaling errors" in docs/extensions.md.
			const claim = ledger.updateClaim(params.id, params.status, params.evidence, opts);
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
}

/**
 * Checker-only (spec "Roles & the checker gate"): resolves an open
 * transition proposal. Registered only when `role === "checker"` — see
 * `createResearchExtension`.
 */
function createMathReviewProposal(role: string) {
	return defineTool({
		name: "math_review_proposal",
		label: "Review Proposal",
		description:
			"Resolve an open transition proposal — checker sessions only. You must independently re-derive/" +
			"re-verify the transition strictly from the artifacts already on record (math_list_claims for the " +
			"claim sheet, the evidence strings already on the claim, and any experiment artifacts under " +
			"workspace/runs/ referenced by that evidence) — never trust the proposing session's own claim of " +
			"correctness; its evidence text is a lead to check, not a fact. Approving applies the transition with " +
			"the exact same validation math_update_claim enforces (an approved-but-invalid proposal is rejected " +
			"with a thrown error and nothing is recorded — neither the claim nor the proposal changes). Rejecting " +
			"only records your verdict; the claim is left untouched either way.",
		promptSnippet: "Resolve an open transition proposal after independently re-verifying it from artifacts",
		promptGuidelines: [
			"Never approve a proposal without independently re-deriving/re-verifying it from the artifacts on record — the proposing session's own evidence text is not proof.",
			"Always pass notes explaining exactly what you checked, whether you approve or reject.",
		],
		parameters: Type.Object({
			proposalId: Type.String({
				description: "Proposal id (from the checker objective, or math_list_claims context).",
			}),
			approved: Type.Boolean({ description: "true to apply the proposed transition, false to reject it." }),
			notes: Type.Optional(
				Type.String({ description: "What you independently checked and why you approved or rejected." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const ledger = openLedger(workspaceDir(ctx));
			// ProposalNotFoundError / ProposalAlreadyResolvedError / TransitionError /
			// ClaimNotFoundError (the last two from an invalid approve) all extend
			// Error — same "let it propagate" convention as math_update_claim above.
			const proposal = ledger.resolveProposal(params.proposalId, {
				approved: params.approved,
				byRole: role,
				byModel: ctx.model?.id ?? "unknown",
				notes: params.notes,
			});
			return {
				content: [
					{
						type: "text",
						text: `Proposal ${proposal.id} ${proposal.status} (claim ${proposal.claimId} -> ${proposal.toStatus}).`,
					},
				],
				details: { proposal },
			};
		},
	});
}

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

const preregExperiment = defineTool({
	name: "prereg_experiment",
	label: "Pre-register Experiment",
	description:
		"Declare a hypothesis and its success metrics/thresholds BEFORE running anything toward it — appended " +
		"append-only to workspace/prereg.jsonl. Outcomes may only be judged against these exact pre-registered " +
		"metrics (via prereg_outcome); if the metrics or thresholds need to change after seeing results, that is " +
		"NEVER a silent reinterpretation — call prereg_experiment again with `amends` set to this prereg's id to " +
		"record a new, distinct amendment. Do this before the first math_run_python call it covers, not after.",
	promptSnippet: "Pre-register a hypothesis and its success metrics before running any experiment toward it",
	promptGuidelines: [
		"Always call prereg_experiment before the first experiment it covers — never register a hypothesis after seeing its results.",
		"To change metrics or thresholds after registering, call prereg_experiment again with `amends` set to the prior id — never reinterpret the old metrics in place.",
	],
	parameters: Type.Object({
		hypothesis: Type.String({ description: "The exact, self-contained hypothesis being tested." }),
		metrics: Type.Array(
			Type.Object({
				name: Type.String({ description: "Metric name, e.g. 'accuracy'." }),
				direction: StringEnum(["min", "max"] as const, {
					description: "Whether success means the metric value is at least (max) or at most (min) the threshold.",
				}),
				successThreshold: Type.String({
					description: "The threshold value that counts as success, e.g. '>= 0.9'.",
				}),
			}),
			{ description: "One or more metrics, declared before any run. Must be non-empty." },
		),
		budgetNote: Type.Optional(
			Type.String({ description: "Optional note on the planned experiment budget (e.g. run count/cost cap)." }),
		),
		amends: Type.Optional(
			Type.String({
				description:
					"If this registration amends a prior one, its prereg id. Never used to edit — always a new entry.",
			}),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const prereg = registerPrereg(workspaceDir(ctx), {
			hypothesis: params.hypothesis,
			metrics: params.metrics,
			budgetNote: params.budgetNote,
			amends: params.amends,
		});
		const amendNote = prereg.amends ? ` (amends ${prereg.amends})` : "";
		return {
			content: [{ type: "text", text: `Pre-registered ${prereg.id}${amendNote}: ${prereg.hypothesis}` }],
			details: { prereg },
		};
	},
});

const preregOutcome = defineTool({
	name: "prereg_outcome",
	label: "Record Pre-registered Outcome",
	description:
		"Record the outcome of a pre-registered experiment against its exact metric values — judged ONLY against " +
		"the metrics/thresholds already declared in prereg_experiment, never against metrics chosen after seeing " +
		"the result. verdict is 'kept' if the pre-registered success thresholds were met, 'discarded' otherwise. " +
		"If you find yourself wanting to judge by a different metric than what was pre-registered, that is a sign " +
		"you need a new amended prereg (prereg_experiment with `amends`), not a reinterpreted outcome.",
	promptSnippet: "Record an experiment outcome judged strictly against its pre-registered metrics",
	promptGuidelines: [
		"Only record verdict 'kept' when the pre-registered thresholds were actually met — never round up an outcome that missed its declared threshold.",
	],
	parameters: Type.Object({
		preregId: Type.String({ description: "The prereg id this outcome is for, from prereg_experiment." }),
		runId: Type.String({
			description: "The math_run_python runId (or other run identifier) this outcome came from.",
		}),
		metricValues: Type.Record(Type.String(), Type.String(), {
			description: "Observed value per pre-registered metric name, e.g. { accuracy: '0.94' }.",
		}),
		verdict: StringEnum(["kept", "discarded"] as const, {
			description: "'kept' if the pre-registered thresholds were met, 'discarded' otherwise.",
		}),
		note: Type.Optional(Type.String({ description: "Optional free-text note on the outcome." })),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const outcome = recordPreregOutcome(workspaceDir(ctx), {
			preregId: params.preregId,
			runId: params.runId,
			metricValues: params.metricValues,
			verdict: params.verdict,
			note: params.note,
		});
		return {
			content: [
				{
					type: "text",
					text: `Outcome recorded for ${outcome.preregId} (run ${outcome.runId}): ${outcome.verdict}.`,
				},
			],
			details: { outcome },
		};
	},
});

/**
 * Factory-of-factory (M2s2): builds a role-bound `ExtensionFactory`.
 * `math_update_claim` gates protected-status transitions into proposals for
 * any role other than "checker"; `math_review_proposal` is registered only
 * for role "checker" — see module doc comment above `SESSION_ROLE_ENV_VAR`
 * for why this closure, rather than a config field, is how role gets here.
 */
export function createResearchExtension(options?: ResearchExtensionOptions): ExtensionFactory {
	const role = resolveRole(options);
	return (pi: ExtensionAPI) => {
		pi.registerTool(mathRecordClaim);
		pi.registerTool(createMathUpdateClaim(role));
		pi.registerTool(mathListClaims);
		pi.registerTool(mathRunPython);
		pi.registerTool(journalNote);
		pi.registerTool(mathGenerateDossier);
		pi.registerTool(preregExperiment);
		pi.registerTool(preregOutcome);
		if (role === "checker") {
			pi.registerTool(createMathReviewProposal(role));
		}
	};
}

// Backward-compatible plain factory (unparameterized — resolves role from
// VIBE_SESSION_ROLE only, defaulting to "reasoner"). scripts/check-research-extension.mjs
// and any caller that doesn't need role control keep using this default export.
export default function researchExtension(pi: ExtensionAPI) {
	createResearchExtension()(pi);
}

// Exported for the headless registration check (see scripts/check-research-extension.mjs)
// and for anything that wants to reuse the tool definitions directly.
export {
	mathRecordClaim,
	mathListClaims,
	mathRunPython,
	journalNote,
	mathGenerateDossier,
	preregExperiment,
	preregOutcome,
};
export { createMathUpdateClaim, createMathReviewProposal, PROTECTED_STATUSES, SESSION_ROLE_ENV_VAR };

// Re-exported so callers of this module don't need a separate vibe-core
// import just to catch the errors math_update_claim / math_review_proposal /
// prereg_experiment / prereg_outcome can throw.
export { ClaimNotFoundError, TransitionError, ProposalNotFoundError, ProposalAlreadyResolvedError };
export { PreregNotFoundError, PreregValidationError };
