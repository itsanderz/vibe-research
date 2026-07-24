import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { generateDossier } from "../dossier/dossier.ts";
import { openJournal } from "../journal/journal.ts";
import { openLedger } from "../ledger/store.ts";
import type { Proposal } from "../ledger/types.ts";
import { appendSessionRecord } from "../modelbook/modelbook.ts";
import { assertDistinctCheckerFamily, loadConfig } from "./config.ts";
import { familyOf } from "./family.ts";
import { initState, type LoopState, loadState, saveState, stateExists, statePath } from "./state.ts";

/**
 * LoopController — spec docs/research/loop-design.md "The iteration":
 * `plan -> act -> gate -> journal -> learn -> checkpoint`. M2s1 implemented
 * plan/act/journal/checkpoint with a fixed per-run objective. M2s2 adds
 * `gate` (protected-status enforcement, via the research extension's
 * role-aware transition-proposal gate — see packages/vibe/src/extensions/
 * research.ts) and `learn` (modelbook.jsonl, per iteration): this file's
 * role is scheduling — deciding, each iteration, whether to run a normal
 * reasoner iteration or a CHECKER iteration that reviews open proposals, and
 * recording a modelbook session record after every iteration either way.
 */

export interface RunSessionUsage {
	input: number;
	output: number;
	total: number;
}

export interface RunSessionResult {
	transcriptSummary: string;
	usage: RunSessionUsage;
	/** Set when the session ended in a provider/session error (e.g. a 402). transcriptSummary may be empty in that case. */
	error?: string;
}

export interface RunSessionContext {
	/** The loop's project root — identical to the `workspaceDir` passed to runLoop(). Session tools resolve `<workspaceDir>/workspace`. */
	workspaceDir: string;
	iteration: number;
	/** The model for this iteration's role — `roles.reasoner.model` for a normal iteration, `roles.checker.model` for a CHECKER iteration. */
	model: string;
	/**
	 * The session role for this iteration: "reasoner" for the normal
	 * investigation objective, "checker" when this iteration reviews open
	 * proposals (spec "Roles & the checker gate"). Passed through to the
	 * research extension (packages/vibe/src/extensions/research.ts) so it can
	 * gate protected-status transitions and expose math_review_proposal only
	 * to checker sessions.
	 */
	role: string;
}

/** Drives one agent session for the given objective. Real implementation: packages/vibe/src/loop-session.ts. Tests inject a fake. */
export type RunSessionFn = (objective: string, context: RunSessionContext) => Promise<RunSessionResult>;

export interface IterationProgress {
	iteration: number;
	tokensSpentThisIteration: number;
	totalTokensSpent: number;
	error?: string;
}

export interface LoopDeps {
	runSession: RunSessionFn;
	/** Injectable clock (epoch ms) for deterministic wall-clock-budget tests. Defaults to Date.now. */
	now?: () => number;
	/** Called after every completed iteration (success or error) so a caller (e.g. the CLI) can print progress. */
	onIteration?: (progress: IterationProgress) => void;
	/** Called once when the loop stops, before the dossier is (re)generated. */
	onStop?: (info: { reason: string }) => void;
}

export interface RunLoopOptions {
	/** Load existing loop-state.json and continue iteration numbering instead of starting fresh. */
	resume?: boolean;
	/** Required alongside resume:true to continue a loop whose state was already marked stopped. */
	force?: boolean;
}

export interface RunLoopResult {
	stopReason: string;
	iterations: number;
	tokensSpent: number;
	dossierPath: string;
}

export const INVESTIGATION_COMPLETE_MARKER = "INVESTIGATION_COMPLETE";

/** The two-strike rule (CLAUDE.md routing rules; echoed in loop-design.md "Budgets & provider health"): this many consecutive session errors stops the loop. */
const MAX_CONSECUTIVE_ERRORS = 2;

/**
 * Data directory for a loop run: config, state, ledger, journal, and dossier
 * all live here. Matches the research extension's own convention
 * (`join(ctx.cwd, "workspace")` in packages/vibe/src/extensions/research.ts)
 * so a real session — run with `cwd: workspaceDir` — reads and writes the
 * exact same files the controller checkpoints.
 */
export function dataDirFor(workspaceDir: string): string {
	return join(workspaceDir, "workspace");
}

function buildObjective(problem: string): string {
	return [
		"Investigate the following research problem:",
		"",
		problem,
		"",
		"Use the math_record_claim / math_update_claim / math_list_claims / math_run_python / journal_note tools",
		"to record claims and progress as you work — do not just narrate in prose.",
		"",
		"Note: math_update_claim to a protected status (INFORMALLY_PROVED, FORMALLY_VERIFIED, COUNTEREXAMPLE_FOUND)",
		"will be recorded as a proposal for a checker session to review, not applied immediately — that is expected,",
		"keep working from there rather than treating it as an error.",
		"",
		`When, and only when, you judge there is no more productive next step right now`,
		`(a terminal claim status has been reached, or you are genuinely stuck with no new avenue to try this`,
		`session), end your final message with the literal marker ${INVESTIGATION_COMPLETE_MARKER} on its own line.`,
	].join("\n");
}

/** Objective text for a CHECKER iteration — spec "Roles & the checker gate": review every open proposal strictly from artifacts, never trust the proposing session's own evidence text. */
function buildCheckerObjective(proposals: Proposal[]): string {
	const lines = proposals.map(
		(p) =>
			`- proposal ${p.id}: claim ${p.claimId} -> ${p.toStatus} (proposed by ${p.proposedBy.role}:${p.proposedBy.model})`,
	);
	return [
		"You are a CHECKER session reviewing protected-status transitions proposed by a different session.",
		"Never trust the proposing session's claim of correctness — re-derive/re-verify each transition strictly",
		"from the artifacts already on record: use math_list_claims for the claim sheet, read the evidence strings",
		"already on each claim, and inspect experiment artifacts under workspace/runs/ referenced by that evidence.",
		"",
		"Open proposals to review:",
		...lines,
		"",
		"For each open proposal, call math_review_proposal with your verdict (approved: true/false) and notes",
		"explaining what you checked. Once every open proposal above has been resolved, end your turn.",
	].join("\n");
}

/**
 * Runs the autonomous research loop against `workspaceDir` until a stop
 * condition holds: an iteration/token/wall-clock budget is exceeded, two
 * consecutive session errors occur, or a session's final message contains
 * the literal `INVESTIGATION_COMPLETE` marker. Every stop is journaled and a
 * dossier is (re)generated before returning.
 *
 * `problem` is required to start a fresh loop; on `options.resume` it is
 * ignored in favor of the problem statement persisted in loop-state.json
 * from the original run (the CLI's `vibe run --resume` supplies no problem
 * text), so it may be omitted.
 *
 * `deps.runSession` is the only I/O boundary — tests supply a fake so this
 * function never makes a live API call on its own.
 */
export async function runLoop(
	workspaceDir: string,
	problem: string | undefined,
	deps: LoopDeps,
	options: RunLoopOptions = {},
): Promise<RunLoopResult> {
	const dataDir = dataDirFor(workspaceDir);
	mkdirSync(dataDir, { recursive: true });

	const config = loadConfig(dataDir);
	assertDistinctCheckerFamily(config);
	const journal = openJournal(dataDir);
	const now = deps.now ?? Date.now;

	let state: LoopState;
	if (options.resume) {
		if (!stateExists(dataDir)) {
			throw new Error(`--resume requested but no checkpoint found at ${statePath(dataDir)}`);
		}
		state = loadState(dataDir);
		if (state.stopped) {
			if (!options.force) {
				throw new Error(
					`loop already stopped (reason: "${state.stopped.reason}", at ${state.stopped.at}); pass --force to resume anyway`,
				);
			}
			journal.note("resume", `Forced resume past previous stop (was: "${state.stopped.reason}").`);
			state = { ...state, stopped: undefined };
		} else {
			journal.note("resume", `Resuming after iteration ${state.lastCompletedIteration}.`);
		}
	} else {
		if (!problem || problem.trim().length === 0) {
			throw new Error("runLoop: problem is required to start a new loop (only --resume may omit it)");
		}
		state = initState(problem);
		journal.note("plan", `Starting loop. Problem: ${problem}`);
	}
	saveState(dataDir, state);

	const effectiveProblem = state.problem;
	const budget = config.budget;
	const startedAtMs = new Date(state.startedAt).getTime();
	const deadlineMs = startedAtMs + budget.maxWallClockHours * 60 * 60 * 1000;

	let consecutiveErrors = 0;
	let stopReason: string | undefined;

	while (!stopReason) {
		if (state.iteration >= budget.maxIterations) {
			stopReason = `iteration cap reached (${budget.maxIterations})`;
			break;
		}
		if (state.budgetSpent.tokens >= budget.maxTokens) {
			stopReason = `token budget exceeded (${state.budgetSpent.tokens}/${budget.maxTokens} tokens)`;
			break;
		}
		if (now() >= deadlineMs) {
			stopReason = `wall-clock budget exceeded (${budget.maxWallClockHours}h)`;
			break;
		}

		// plan — a fresh ledger read each iteration: sessions mutate claims.jsonl
		// out of process from this loop (via the research extension's own
		// openLedger() calls), so this must never reuse a Ledger handle opened
		// before the previous session ran.
		const iteration = state.iteration + 1;
		const ledger = openLedger(dataDir);
		const openProposals = ledger.listProposals("open");
		const checkerRole = config.roles.checker;
		const isCheckerIteration = openProposals.length > 0 && checkerRole !== undefined;
		const role = isCheckerIteration ? "checker" : "reasoner";
		const model = isCheckerIteration ? (checkerRole as { model: string }).model : config.roles.reasoner.model;
		const objective = isCheckerIteration ? buildCheckerObjective(openProposals) : buildObjective(effectiveProblem);
		const proposalsResolvedBefore = new Set(ledger.listProposals("resolved").map((p) => p.id));
		journal.note(
			"plan",
			isCheckerIteration
				? `Iteration ${iteration}: CHECKER iteration reviewing ${openProposals.length} open proposal(s) (model: ${model}).`
				: `Iteration ${iteration}: fixed investigation objective (model: ${model}).`,
		);

		// act
		const context: RunSessionContext = { workspaceDir, iteration, model, role };
		const sessionStartMs = now();
		const result = await deps.runSession(objective, context);
		const durationMs = now() - sessionStartMs;

		// journal (phase "iteration")
		state.iteration = iteration;
		journal.note(
			"iteration",
			result.error
				? `Iteration ${iteration} session error: ${result.error}`
				: result.transcriptSummary || `Iteration ${iteration} completed with no summary.`,
		);

		// accumulate budget
		state.budgetSpent.tokens += result.usage.total;
		state.budgetSpent.wallClockMs = now() - startedAtMs;
		state.lastCompletedIteration = iteration;

		// checkpoint
		saveState(dataDir, state);

		// learn — one modelbook.jsonl record per iteration, success or error.
		// Checker-only: count proposals this iteration's session resolved by
		// diffing against the resolved set captured before the session ran.
		let proposalsApproved: number | undefined;
		let proposalsRejected: number | undefined;
		if (isCheckerIteration) {
			const resolvedAfter = openLedger(dataDir).listProposals("resolved");
			const resolvedThisIteration = resolvedAfter.filter((p) => !proposalsResolvedBefore.has(p.id));
			proposalsApproved = resolvedThisIteration.filter((p) => p.resolution?.approved === true).length;
			proposalsRejected = resolvedThisIteration.filter((p) => p.resolution?.approved === false).length;
		}
		appendSessionRecord(dataDir, {
			at: new Date(now()).toISOString(),
			role,
			model,
			family: familyOf(model),
			objectiveKind: isCheckerIteration ? "checker" : "investigate",
			tokens: result.usage,
			durationMs,
			outcome: result.error ? "error" : "completed",
			...(proposalsApproved !== undefined ? { proposalsApproved, proposalsRejected } : {}),
		});

		deps.onIteration?.({
			iteration,
			tokensSpentThisIteration: result.usage.total,
			totalTokensSpent: state.budgetSpent.tokens,
			error: result.error,
		});

		if (result.error) {
			consecutiveErrors += 1;
			if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
				stopReason = `${MAX_CONSECUTIVE_ERRORS} consecutive session errors (last: ${result.error})`;
				break;
			}
			continue;
		}
		consecutiveErrors = 0;

		if (result.transcriptSummary.includes(INVESTIGATION_COMPLETE_MARKER)) {
			stopReason = INVESTIGATION_COMPLETE_MARKER;
			break;
		}
	}

	state.stopped = { reason: stopReason as string, at: new Date(now()).toISOString() };
	saveState(dataDir, state);

	// Never auto-approve: if proposals are still open at stop, say so — loudly
	// when there's no checker configured to ever resolve them.
	const openProposalsAtStop = openLedger(dataDir).listProposals("open");
	if (openProposalsAtStop.length > 0) {
		journal.note(
			"stop",
			config.roles.checker
				? `${openProposalsAtStop.length} proposal(s) still open at stop.`
				: `${openProposalsAtStop.length} proposal(s) awaiting checker (no checker role configured).`,
		);
	}

	journal.note("checkpoint", `Loop stopped: ${stopReason}`);
	deps.onStop?.({ reason: stopReason as string });

	const dossier = generateDossier(dataDir, {
		title: `Autonomous loop: ${effectiveProblem}`,
		problem: effectiveProblem,
	});

	return {
		stopReason: stopReason as string,
		iterations: state.iteration,
		tokensSpent: state.budgetSpent.tokens,
		dossierPath: dossier.path,
	};
}
