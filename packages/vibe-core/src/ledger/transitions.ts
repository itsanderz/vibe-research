import { ClaimStatus } from "./types.ts";

/**
 * Thrown when a proposed status change is not on the transition whitelist.
 * `from`/`to` are the statuses involved so callers (and tests) can inspect
 * the rejected move without parsing the message.
 */
export class TransitionError extends Error {
	readonly from: ClaimStatus;
	readonly to: ClaimStatus;
	readonly reason: string;

	constructor(from: ClaimStatus, to: ClaimStatus, reason: string) {
		super(`Illegal claim status transition ${from} -> ${to}: ${reason}`);
		this.name = "TransitionError";
		this.from = from;
		this.to = to;
		this.reason = reason;
	}
}

/**
 * Strength ranking for claim statuses (spec §7): higher is stronger evidence.
 *
 * `COUNTEREXAMPLE_FOUND` is not part of the strength ladder — it is a
 * terminal, absorbing status reachable from any non-terminal status
 * regardless of rank, because a valid counterexample refutes a claim no
 * matter how strongly it was previously supported. Its rank (-1) is defined
 * only so this map stays total (useful for phrasing policy lookups in
 * `report/phrasing.ts`); it is never consulted by the ladder comparison
 * below because `assertLegalTransition` special-cases COUNTEREXAMPLE_FOUND
 * before reaching that comparison.
 */
export const STATUS_RANK: Record<ClaimStatus, number> = {
	[ClaimStatus.COUNTEREXAMPLE_FOUND]: -1,
	[ClaimStatus.UNTESTED]: 0,
	[ClaimStatus.TESTED_SMALL_CASES]: 1,
	[ClaimStatus.COMPUTATIONALLY_VERIFIED]: 2,
	[ClaimStatus.INFORMALLY_PROVED]: 3,
	[ClaimStatus.FORMALLY_VERIFIED]: 4,
};

export interface TransitionOptions {
	/** Required, non-empty, when `to === ClaimStatus.FORMALLY_VERIFIED` (spec §7, §9.3). */
	checkerArtifact?: string;
}

/**
 * Validates a proposed claim status transition per spec §7 and §9.3. Throws
 * `TransitionError` if the transition is not allowed; otherwise returns.
 *
 * Rules (checked in this order):
 *  1. Every status change requires at least one non-empty evidence string
 *     (spec §9.3: "the evidence must state what check was completed").
 *  2. `COUNTEREXAMPLE_FOUND` is terminal: once a claim is there, no further
 *     transition out of it is legal (including to itself).
 *  3. Moving *to* `FORMALLY_VERIFIED` requires a non-empty `checkerArtifact`
 *     (spec §7, §9.3), independent of the rank check below.
 *  4. Moving *to* `COUNTEREXAMPLE_FOUND` is legal from any non-terminal
 *     status, regardless of rank.
 *  5. Otherwise, both statuses are on the strength ladder (`STATUS_RANK`)
 *     and the move is legal iff it does not strictly decrease rank — i.e.
 *     statuses only strengthen and never weaken. Equal rank (re-recording
 *     the same status with new evidence, e.g. widening a tested range while
 *     staying `TESTED_SMALL_CASES`) is permitted: it is neither a
 *     strengthening nor a weakening.
 */
export function assertLegalTransition(
	from: ClaimStatus,
	to: ClaimStatus,
	evidence: string[],
	opts: TransitionOptions = {},
): void {
	if (evidence.length === 0 || evidence.every((entry) => entry.trim().length === 0)) {
		throw new TransitionError(from, to, "at least one non-empty evidence string is required for every status change");
	}

	if (from === ClaimStatus.COUNTEREXAMPLE_FOUND) {
		throw new TransitionError(from, to, "COUNTEREXAMPLE_FOUND is terminal; no further transitions are allowed");
	}

	if (to === ClaimStatus.FORMALLY_VERIFIED && (!opts.checkerArtifact || opts.checkerArtifact.trim().length === 0)) {
		throw new TransitionError(from, to, "FORMALLY_VERIFIED requires a non-empty checkerArtifact reference");
	}

	if (to === ClaimStatus.COUNTEREXAMPLE_FOUND) {
		return;
	}

	const fromRank = STATUS_RANK[from];
	const toRank = STATUS_RANK[to];
	if (toRank < fromRank) {
		throw new TransitionError(
			from,
			to,
			`status may not weaken from ${from} (rank ${fromRank}) to ${to} (rank ${toRank})`,
		);
	}
}
