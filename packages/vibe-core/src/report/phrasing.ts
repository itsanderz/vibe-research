import { STATUS_RANK } from "../ledger/transitions.ts";
import { ClaimStatus } from "../ledger/types.ts";

/**
 * Required final-report language per spec §11 — the one phrase permitted as
 * the conclusion sentence for each status. This is documentation/reference,
 * not enforced verbatim by `checkReportLanguage` (a report may phrase its
 * conclusion in its own words as long as it does not use stronger language
 * than the evidence supports).
 */
export const PERMITTED_CONCLUSION_LANGUAGE: Record<ClaimStatus, string> = {
	[ClaimStatus.UNTESTED]: "The claim has not been tested.",
	[ClaimStatus.TESTED_SMALL_CASES]: "No counterexample was found in the tested cases.",
	[ClaimStatus.COUNTEREXAMPLE_FOUND]: "The claim is false; here is a counterexample.",
	[ClaimStatus.COMPUTATIONALLY_VERIFIED]: "The bounded/finite claim was exhaustively verified.",
	[ClaimStatus.INFORMALLY_PROVED]: "An informal proof was produced and checked procedurally.",
	[ClaimStatus.FORMALLY_VERIFIED]: "The formalized claim was accepted by the named proof checker.",
};

export interface PhrasingViolation {
	/** The banned phrase this rule checks for (lowercase, canonical form). */
	term: string;
	/** The exact substring matched in `text` (preserves original casing). */
	match: string;
	/** Character offset of the match within `text`. */
	index: number;
	reason: string;
}

export interface PhrasingCheckResult {
	ok: boolean;
	violations: PhrasingViolation[];
}

const SMALL_CASES_RANK = STATUS_RANK[ClaimStatus.TESTED_SMALL_CASES];
const INFORMALLY_PROVED_RANK = STATUS_RANK[ClaimStatus.INFORMALLY_PROVED];
const FORMALLY_VERIFIED_RANK = STATUS_RANK[ClaimStatus.FORMALLY_VERIFIED];

/**
 * Negation cue words. This is a pragmatic, intentionally limited heuristic:
 * it looks at up to the 4 words immediately preceding a match, within the
 * current clause (cut at the nearest preceding '.', ';', or newline), and
 * skips the match if one of these cues appears there. Known limitations:
 *  - does not understand negation scope beyond a simple clause boundary;
 *  - does not handle double negatives ("not unproven") correctly;
 *  - does not follow negation across a comma-joined dependent clause
 *    ("Although not exhaustively tested, this was verified" will still flag
 *    "verified");
 *  - "no" is treated as a cue word, which can over-suppress in front of a
 *    banned phrase used as a noun ("no proof was verified" is under-flagged
 *    by design, since it reads as a negated claim).
 * This trades recall for precision deliberately: the policy's job is to
 * catch confident overclaiming prose, not to parse arbitrary logic.
 */
const NEGATION_CUES = new Set([
	"not",
	"never",
	"no",
	"cannot",
	"can't",
	"isn't",
	"wasn't",
	"hasn't",
	"haven't",
	"doesn't",
	"didn't",
	"won't",
]);

function isNegated(text: string, matchIndex: number): boolean {
	const windowStart = Math.max(0, matchIndex - 60);
	let window = text.slice(windowStart, matchIndex);
	const clauseBreak = Math.max(window.lastIndexOf("."), window.lastIndexOf(";"), window.lastIndexOf("\n"));
	if (clauseBreak >= 0) window = window.slice(clauseBreak + 1);

	const words = window
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => w.replace(/[,:]+$/, ""));
	const precedingWords = words.slice(-4);

	return precedingWords.some((word) => NEGATION_CUES.has(word) || word.endsWith("n't"));
}

function findMatches(text: string, phrase: string): { index: number; match: string }[] {
	const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`\\b${escaped}\\b`, "gi");
	const matches: { index: number; match: string }[] = [];
	let result: RegExpExecArray | null = pattern.exec(text);
	while (result !== null) {
		matches.push({ index: result.index, match: result[0] });
		result = pattern.exec(text);
	}
	return matches;
}

interface PhrasingRule {
	phrase: string;
	appliesWhen: (rank: number) => boolean;
	reason: string;
	/** Optional: suppress a match that is actually part of a longer phrase
	 * already covered by another rule (see the "verified" rule below). */
	skip?: (text: string, index: number) => boolean;
}

const RULES: PhrasingRule[] = [
	{
		phrase: "proved",
		appliesWhen: (rank) => rank < INFORMALLY_PROVED_RANK,
		reason: '"proved" requires at least an informal proof (status INFORMALLY_PROVED or higher); spec §7, §11.',
	},
	{
		phrase: "proven",
		appliesWhen: (rank) => rank < INFORMALLY_PROVED_RANK,
		reason: '"proven" requires at least an informal proof (status INFORMALLY_PROVED or higher); spec §7, §11.',
	},
	{
		phrase: "verified",
		appliesWhen: (rank) => rank <= SMALL_CASES_RANK,
		reason:
			'"verified" is not permitted when the strongest evidence is only untested or tested on small cases; spec §11.',
		// "formally verified" is handled by its own rule below; don't double-report it here.
		skip: (text, index) =>
			text
				.slice(Math.max(0, index - 10), index)
				.trim()
				.toLowerCase()
				.endsWith("formally"),
	},
	{
		phrase: "always holds",
		appliesWhen: (rank) => rank <= SMALL_CASES_RANK,
		reason:
			'"always holds" is not permitted when the strongest evidence is only untested or tested on small cases; spec §11.',
	},
	{
		phrase: "for all",
		appliesWhen: (rank) => rank <= SMALL_CASES_RANK,
		reason:
			'"for all" asserts a universal claim not permitted when the strongest evidence is only untested or tested on small cases; spec §11.',
	},
	{
		phrase: "formally verified",
		appliesWhen: (rank) => rank < FORMALLY_VERIFIED_RANK,
		reason:
			'"formally verified" requires status FORMALLY_VERIFIED with a named external checker; spec §7, §9.3, §11.',
	},
	{
		phrase: "machine-checked",
		appliesWhen: (rank) => rank < FORMALLY_VERIFIED_RANK,
		reason: '"machine-checked" requires status FORMALLY_VERIFIED with a named external checker; spec §7, §9.3, §11.',
	},
];

/**
 * Checks report/conclusion text against the strongest claim status actually
 * on record, per spec §11 ("The system must not use 'proved,' 'verified,'
 * or 'always' when the strongest status is only TESTED_SMALL_CASES") and
 * the general principle in spec §3.7 that wording must never exceed the
 * strongest supported claim status.
 *
 * `strongestStatus` should be the strongest status among the load-bearing
 * claims backing the report. `COUNTEREXAMPLE_FOUND` is treated as weaker
 * than every ladder status for phrasing purposes (rank -1, see
 * `STATUS_RANK`): a refuted claim never warrants proof/verification
 * language, regardless of how much work went into refuting it.
 *
 * Returns every violation found (not just the first), each naming the
 * matched text and why it's disallowed at this status, so a caller can
 * point a user at the exact offending words. Matching is case-insensitive
 * and word-boundary bounded; a pragmatic negation check (see
 * `isNegated`) avoids flagging phrases like "not proved" or "cannot be
 * verified".
 */
export function checkReportLanguage(text: string, strongestStatus: ClaimStatus): PhrasingCheckResult {
	const rank = STATUS_RANK[strongestStatus];
	const violations: PhrasingViolation[] = [];

	for (const rule of RULES) {
		if (!rule.appliesWhen(rank)) continue;
		for (const { index, match } of findMatches(text, rule.phrase)) {
			if (rule.skip?.(text, index)) continue;
			if (isNegated(text, index)) continue;
			violations.push({ term: rule.phrase, match, index, reason: rule.reason });
		}
	}

	return { ok: violations.length === 0, violations };
}
