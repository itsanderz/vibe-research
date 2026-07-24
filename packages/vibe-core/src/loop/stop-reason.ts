/**
 * Normalized stop reasons for a loop run — spec docs/research/loop-design.md
 * "Resume & stop". A `const` object + derived union type, per this repo's
 * `erasableSyntaxOnly` convention (no `enum`; mirrors `ClaimStatus` in
 * `ledger/types.ts`).
 *
 * Lives in its own leaf file (not `controller.ts`) so `dossier.ts` can import
 * it for the stop banner without creating a `controller.ts` <-> `dossier.ts`
 * import cycle (`controller.ts` already imports `generateDossier` from
 * `dossier.ts`).
 */
export const StopReason = {
	BUDGET_TOKENS: "BUDGET_TOKENS",
	BUDGET_WALLCLOCK: "BUDGET_WALLCLOCK",
	BUDGET_ITERATIONS: "BUDGET_ITERATIONS",
	TWO_STRIKE_ERRORS: "TWO_STRIKE_ERRORS",
	INVESTIGATION_COMPLETE: "INVESTIGATION_COMPLETE",
	AWAITING_FUEL: "AWAITING_FUEL",
	USER_INTERRUPT: "USER_INTERRUPT",
} as const;

export type StopReason = (typeof StopReason)[keyof typeof StopReason];

/** Stop reasons a plain `vibe run --resume` continues WITHOUT `--force`. All others require `--force`. */
export const RESUMABLE_WITHOUT_FORCE: ReadonlySet<StopReason> = new Set([
	StopReason.AWAITING_FUEL,
	StopReason.USER_INTERRUPT,
]);

/** Human-readable banner text for the dossier header when a run stopped, keyed by StopReason. */
export const STOP_BANNER_TEXT: Record<StopReason, string> = {
	[StopReason.BUDGET_TOKENS]:
		"Run stopped: BUDGET_TOKENS — token budget exhausted. Not resumable without `vibe run --resume --force`.",
	[StopReason.BUDGET_WALLCLOCK]:
		"Run stopped: BUDGET_WALLCLOCK — wall-clock budget exhausted. Not resumable without `vibe run --resume --force`.",
	[StopReason.BUDGET_ITERATIONS]:
		"Run stopped: BUDGET_ITERATIONS — iteration cap reached. Not resumable without `vibe run --resume --force`.",
	[StopReason.TWO_STRIKE_ERRORS]:
		"Run stopped: TWO_STRIKE_ERRORS — two consecutive session errors. Not resumable without `vibe run --resume --force`.",
	[StopReason.INVESTIGATION_COMPLETE]:
		"Run stopped: INVESTIGATION_COMPLETE — the session reported the investigation complete. Not resumable without `vibe run --resume --force`.",
	[StopReason.AWAITING_FUEL]:
		"Run stopped: AWAITING_FUEL — all configured models for at least one role are unhealthy (exhausted credits or auth failure). Resumable with `vibe run --resume`.",
	[StopReason.USER_INTERRUPT]:
		"Run stopped: USER_INTERRUPT — interrupted by user (Ctrl+C). Resumable with `vibe run --resume`.",
};
