import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Modelbook — spec docs/research/loop-design.md "learn" step ("modelbook.jsonl
 * gets {role, model, provider, task-type, tokens, cost, outcome,
 * overclaim-incidents}"). M2s2 implements role/model/family/objectiveKind/
 * tokens/durationMs/outcome, plus checker-only proposal counts; cost and
 * overclaim-incidents are later slices.
 */

export type ObjectiveKind = "investigate" | "checker";
export type SessionOutcome = "completed" | "error";

export interface SessionTokens {
	input: number;
	output: number;
	total: number;
}

export interface SessionRecord {
	at: string;
	role: string;
	model: string;
	family: string;
	objectiveKind: ObjectiveKind;
	tokens: SessionTokens;
	durationMs: number;
	outcome: SessionOutcome;
	/** Only ever set for objectiveKind "checker" — proposals this session resolved (approved/rejected via math_review_proposal). */
	proposalsApproved?: number;
	proposalsRejected?: number;
}

export interface ModelAggregate {
	sessions: number;
	totalTokens: number;
	errorRate: number;
	/** Present only for a model with at least one checker session that resolved a proposal. */
	approvalRate?: number;
}

const MODELBOOK_FILE_NAME = "modelbook.jsonl";

/** Path to the modelbook file inside a loop data directory (`<workspaceDir>/workspace`, same convention as claims.jsonl/journal.jsonl). */
export function modelbookPath(workspaceDir: string): string {
	return join(workspaceDir, MODELBOOK_FILE_NAME);
}

/**
 * Appends one session record to `<workspaceDir>/modelbook.jsonl`. Creates
 * the directory/file if needed. Append-only, same convention as the claim
 * ledger and journal — every session this loop has ever run stays on record.
 */
export function appendSessionRecord(workspaceDir: string, record: SessionRecord): SessionRecord {
	if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true });
	const path = modelbookPath(workspaceDir);
	if (!existsSync(path)) writeFileSync(path, "");
	appendFileSync(path, `${JSON.stringify(record)}\n`);
	return record;
}

function loadRecords(workspaceDir: string): SessionRecord[] {
	const path = modelbookPath(workspaceDir);
	if (!existsSync(path)) return [];
	const contents = readFileSync(path, "utf8");
	const records: SessionRecord[] = [];
	for (const line of contents.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		records.push(JSON.parse(trimmed) as SessionRecord);
	}
	return records;
}

/**
 * Per-model aggregate stats folded from every session record ever appended
 * for `workspaceDir`. `errorRate` is always present (0 when every session
 * completed); `approvalRate` — approved / (approved + rejected) across that
 * model's checker sessions — is only present for a model that has run at
 * least one checker session which resolved a proposal.
 */
export function aggregateModelbook(workspaceDir: string): Record<string, ModelAggregate> {
	const records = loadRecords(workspaceDir);
	const byModel = new Map<string, SessionRecord[]>();
	for (const record of records) {
		const list = byModel.get(record.model);
		if (list) list.push(record);
		else byModel.set(record.model, [record]);
	}

	const result: Record<string, ModelAggregate> = {};
	for (const [model, sessions] of byModel) {
		const totalTokens = sessions.reduce((sum, s) => sum + s.tokens.total, 0);
		const errorCount = sessions.filter((s) => s.outcome === "error").length;
		const approved = sessions.reduce((sum, s) => sum + (s.proposalsApproved ?? 0), 0);
		const rejected = sessions.reduce((sum, s) => sum + (s.proposalsRejected ?? 0), 0);
		const resolvedTotal = approved + rejected;

		result[model] = {
			sessions: sessions.length,
			totalTokens,
			errorRate: errorCount / sessions.length,
			...(resolvedTotal > 0 ? { approvalRate: approved / resolvedTotal } : {}),
		};
	}
	return result;
}
