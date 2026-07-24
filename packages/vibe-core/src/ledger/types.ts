/**
 * Claim status semantics — spec §7.
 *
 * Statuses describe the strongest completed verification step for the exact
 * recorded claim. They are not free-form: `transitions.ts` enforces which
 * moves between them are legal.
 */
// A plain `const` object + derived union type, not a TS `enum`: this repo
// builds with `erasableSyntaxOnly` (see tsconfig.base.json), which rejects
// `enum` because it compiles to runtime code rather than erasing cleanly.
// `ClaimStatus.UNTESTED` etc. still work as values, and `ClaimStatus` still
// works as a type, exactly as an enum would.
export const ClaimStatus = {
	/** Recorded but no meaningful supporting or refuting check has run. */
	UNTESTED: "UNTESTED",
	/** Survived a finite, non-exhaustive set of examples. Must be used for a
	 * universal claim tested on only finitely many cases. */
	TESTED_SMALL_CASES: "TESTED_SMALL_CASES",
	/** A valid input satisfying the claim's assumptions falsifies the conclusion. */
	COUNTEREXAMPLE_FOUND: "COUNTEREXAMPLE_FOUND",
	/** Exhaustively checked over its complete finite domain (or a complete
	 * decidable reduction). Must not be used for an infinite universal claim
	 * just because a large finite range was tested. */
	COMPUTATIONALLY_VERIFIED: "COMPUTATIONALLY_VERIFIED",
	/** A complete human-readable proof exists and survived the v0 checker phase.
	 * Not a machine-checked guarantee. */
	INFORMALLY_PROVED: "INFORMALLY_PROVED",
	/** An external formal proof checker accepted a formalization matching the
	 * recorded claim and assumptions. */
	FORMALLY_VERIFIED: "FORMALLY_VERIFIED",
} as const;

export type ClaimStatus = (typeof ClaimStatus)[keyof typeof ClaimStatus];

/**
 * Claim ledger entry — spec §6.
 *
 * `statement` should be independently understandable and include its
 * mathematical scope (quantifiers, domain). `evidence` accumulates every
 * evidence string ever recorded against this claim, in the order recorded;
 * see `formatEvidence` for the recommended per-entry text format (spec §8).
 */
export interface Claim {
	id: string;
	statement: string;
	assumptions: string[];
	status: ClaimStatus;
	evidence: string[];
	createdAt: string;
	updatedAt: string;
}

/**
 * Structured fields for one evidence entry — spec §8.
 *
 * All fields are optional because the spec says an entry "should capture as
 * many of these fields as relevant," not that all are always applicable
 * (e.g. a counterexample report may not have a meaningful "limitations").
 */
export interface EvidenceFields {
	method?: string;
	scope?: string;
	arithmetic?: string;
	artifact?: string;
	result?: string;
	limitations?: string;
}

const EVIDENCE_FIELD_ORDER: readonly (keyof EvidenceFields)[] = [
	"method",
	"scope",
	"arithmetic",
	"artifact",
	"result",
	"limitations",
];

/**
 * Renders evidence fields into the recommended v0 textual format from spec §8:
 *
 *   method=<method>; scope=<domain/range>; arithmetic=<mode>; artifact=<path>; result=<result>; limitations=<limitations>
 *
 * Fields that are absent or an empty string are omitted rather than emitted
 * as `key=`. The field order is always method, scope, arithmetic, artifact,
 * result, limitations, regardless of the order given in `fields`.
 */
export function formatEvidence(fields: EvidenceFields): string {
	return EVIDENCE_FIELD_ORDER.filter((key) => fields[key] !== undefined && fields[key] !== "")
		.map((key) => `${key}=${fields[key]}`)
		.join("; ");
}

/**
 * Proposed claim-status transition — spec docs/research/loop-design.md
 * "Roles & the checker gate" (M2s2). Recorded instead of applying directly
 * when a non-checker session attempts a protected-status transition
 * (INFORMALLY_PROVED / FORMALLY_VERIFIED / COUNTEREXAMPLE_FOUND): the claim
 * itself is untouched until a checker session — a different model family —
 * resolves the proposal.
 */
export interface ProposedBy {
	role: string;
	model: string;
}

export interface ProposalResolution {
	approved: boolean;
	byRole: string;
	byModel: string;
	notes?: string;
}

export type ProposalStatus = "open" | "approved" | "rejected";

export interface Proposal {
	id: string;
	claimId: string;
	toStatus: ClaimStatus;
	evidence: string[];
	checkerArtifact?: string;
	proposedBy: ProposedBy;
	status: ProposalStatus;
	createdAt: string;
	resolvedAt?: string;
	resolution?: ProposalResolution;
}
