import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderHealthEntry } from "./provider-error.ts";

/**
 * Loop checkpoint — spec docs/research/loop-design.md step 6 ("checkpoint —
 * loop-state.json written atomically; crash/sleep-safe.").
 */

export interface BudgetSpent {
	tokens: number;
	wallClockMs: number;
}

export interface StoppedInfo {
	/**
	 * Left as a loose `string` (not the `StopReason` union) so existing
	 * hand-built fixtures (e.g. loop-state.test.ts's
	 * `{ reason: "iteration cap reached (25)", at }`) keep type-checking —
	 * this field predates the M2s3 StopReason refactor. `controller.ts` now
	 * writes an actual `StopReason` code here; `detail` carries the prose.
	 */
	reason: string;
	at: string;
	/** Human-readable detail (M2s3+): the prose that `reason` used to hold directly. Optional for back-compat with pre-M2s3 checkpoints. */
	detail?: string;
}

export interface LoopState {
	iteration: number;
	startedAt: string;
	/**
	 * The problem statement this loop run is investigating. Not part of the
	 * field list loop-design.md's build-slice note enumerates, but required so
	 * `--resume` (which supplies no problem text on the command line) can
	 * rebuild the same objective — see controller.ts's runLoop(). Persisted
	 * once at loop start and never changed by later iterations.
	 */
	problem: string;
	budgetSpent: BudgetSpent;
	lastCompletedIteration: number;
	stopped?: StoppedInfo;
	/** Per-model health, keyed by model id — loop-design.md "Budgets & provider health". Empty until a fuel/auth error marks an entry. */
	providerHealth: Record<string, ProviderHealthEntry>;
}

const STATE_FILE_NAME = "loop-state.json";

/** Path to the checkpoint file inside a loop data directory (`<workspaceDir>/workspace`). */
export function statePath(dataDir: string): string {
	return join(dataDir, STATE_FILE_NAME);
}

export function stateExists(dataDir: string): boolean {
	return existsSync(statePath(dataDir));
}

/** Fresh state for a new (non-resumed) loop run. */
export function initState(problem: string): LoopState {
	return {
		iteration: 0,
		startedAt: new Date().toISOString(),
		problem,
		budgetSpent: { tokens: 0, wallClockMs: 0 },
		lastCompletedIteration: 0,
		providerHealth: {},
	};
}

export function loadState(dataDir: string): LoopState {
	const text = readFileSync(statePath(dataDir), "utf8");
	return JSON.parse(text) as LoopState;
}

/**
 * Atomic write: serialize to a temp file in the same directory, then
 * `renameSync` over the real path. Rename is atomic on the same filesystem,
 * so a crash mid-write leaves the previous `loop-state.json` (or none)
 * intact — a reader never observes a half-written file, and a stray tmp file
 * left behind by a crash is simply ignored (nothing ever reads the `.tmp-*`
 * name back).
 */
export function saveState(dataDir: string, state: LoopState): void {
	mkdirSync(dataDir, { recursive: true });
	const finalPath = statePath(dataDir);
	const tmpPath = join(
		dataDir,
		`.${STATE_FILE_NAME}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
	renameSync(tmpPath, finalPath);
}
