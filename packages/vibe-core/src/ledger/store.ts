import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertLegalTransition, type TransitionOptions } from "./transitions.ts";
import { type Claim, ClaimStatus } from "./types.ts";

/**
 * One line of `claims.jsonl`. Each event carries the *full* materialized
 * claim after the event (not a delta), so replaying the file is a simple
 * fold: for each id, the last event mentioning it wins. This keeps replay
 * trivial and keeps the file genuinely append-only — prior lines are never
 * rewritten, only superseded by later ones.
 */
export type ClaimEvent =
	| { kind: "claim_created"; at: string; claim: Claim }
	| { kind: "claim_updated"; at: string; claim: Claim };

export class ClaimNotFoundError extends Error {
	readonly id: string;

	constructor(id: string) {
		super(`No claim with id ${id}`);
		this.name = "ClaimNotFoundError";
		this.id = id;
	}
}

/** Nanoid-style short id built from node:crypto only (no new dependency). */
function generateClaimId(): string {
	return randomBytes(9).toString("base64url");
}

export interface Ledger {
	/** Records a new claim with status UNTESTED and no evidence (spec §9.2). */
	recordClaim(statement: string, assumptions: string[]): Claim;
	/** Moves a claim to a new status, validating the transition (spec §9.3). */
	updateClaim(id: string, newStatus: ClaimStatus, evidence: string[], opts?: TransitionOptions): Claim;
	/** Current view of every claim, folded from the event log. */
	listClaims(): Claim[];
	getClaim(id: string): Claim | undefined;
}

function loadClaims(filePath: string): Map<string, Claim> {
	const claims = new Map<string, Claim>();
	const contents = readFileSync(filePath, "utf8");
	for (const line of contents.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const event = JSON.parse(trimmed) as ClaimEvent;
		claims.set(event.claim.id, event.claim);
	}
	return claims;
}

/**
 * Opens (creating if necessary) the append-only JSONL claim ledger at
 * `<dir>/claims.jsonl`, per spec §10. Existing events are replayed into
 * memory synchronously so `listClaims`/`getClaim` are immediately accurate;
 * every subsequent mutation both updates the in-memory view and appends a
 * new event line to the file — prior lines are never rewritten.
 */
export function openLedger(dir: string): Ledger {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const filePath = join(dir, "claims.jsonl");
	if (!existsSync(filePath)) writeFileSync(filePath, "");

	const claims = loadClaims(filePath);

	function appendEvent(event: ClaimEvent): void {
		appendFileSync(filePath, `${JSON.stringify(event)}\n`);
	}

	return {
		recordClaim(statement, assumptions) {
			const now = new Date().toISOString();
			const claim: Claim = {
				id: generateClaimId(),
				statement,
				assumptions: [...assumptions],
				status: ClaimStatus.UNTESTED,
				evidence: [],
				createdAt: now,
				updatedAt: now,
			};
			claims.set(claim.id, claim);
			appendEvent({ kind: "claim_created", at: now, claim });
			return claim;
		},

		updateClaim(id, newStatus, evidence, opts) {
			const current = claims.get(id);
			if (!current) throw new ClaimNotFoundError(id);

			assertLegalTransition(current.status, newStatus, evidence, opts);

			const now = new Date().toISOString();
			const updated: Claim = {
				...current,
				status: newStatus,
				evidence: [...current.evidence, ...evidence],
				updatedAt: now,
			};
			claims.set(id, updated);
			appendEvent({ kind: "claim_updated", at: now, claim: updated });
			return updated;
		},

		listClaims() {
			return [...claims.values()];
		},

		getClaim(id) {
			return claims.get(id);
		},
	};
}
