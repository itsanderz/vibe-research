import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openJournal } from "../journal/journal.ts";

/**
 * Pre-registered empirical lane — spec docs/research/loop-design.md "Empirical
 * lane": "Before the first empirical iteration on a problem: ... {hypothesis,
 * metrics[{name, direction, successThreshold}], budget} written and
 * journaled. Empirical iterations run experiments ... score against
 * pre-registered metrics only, keep/discard recorded ... No post-hoc metric
 * swaps: prereg is append-only (amendments are new entries referencing the
 * old)."
 *
 * DEVIATION from the spec text: the spec names the file
 * `workspace/prereg.json` (singular JSON document). This slice's task spec
 * requires append-only amendment chains and outcome events sharing one file
 * — exactly the discipline `claims.jsonl`/`journal.jsonl` already implement
 * — so this module uses `prereg.jsonl` (one JSON event per line) instead,
 * matching every other ledger-shaped file in this codebase. The append-only
 * *behavior* the spec asks for is unchanged; only the file's on-disk shape
 * differs from the spec's literal filename.
 *
 * File location follows the same convention as `journal.ts`/`modelbook.ts`:
 * the `workspaceDir` parameter here is the loop's *data* directory
 * (`<project>/workspace` — see `loop/controller.ts`'s `dataDirFor`), so
 * `prereg.jsonl` lands at `<project>/workspace/prereg.jsonl`.
 */

export type MetricDirection = "min" | "max";

export interface PreregMetric {
	name: string;
	direction: MetricDirection;
	successThreshold: string;
}

export interface RegisterPreregInput {
	hypothesis: string;
	metrics: PreregMetric[];
	budgetNote?: string;
	/** id of the prior pre-registration this one amends. Omit for an original registration. */
	amends?: string;
}

/** One registration event, as recorded (before any outcomes are attached). */
export interface PreregRegistration {
	id: string;
	hypothesis: string;
	metrics: PreregMetric[];
	budgetNote?: string;
	amends?: string;
	createdAt: string;
}

export interface RecordPreregOutcomeInput {
	preregId: string;
	runId: string;
	metricValues: Record<string, string>;
	verdict: "kept" | "discarded";
	note?: string;
}

export interface PreregOutcome {
	preregId: string;
	runId: string;
	metricValues: Record<string, string>;
	verdict: "kept" | "discarded";
	note?: string;
	createdAt: string;
}

type PreregEvent =
	| { kind: "prereg_registered"; at: string; registration: PreregRegistration }
	| { kind: "prereg_outcome"; at: string; outcome: PreregOutcome };

/**
 * Folded, current view of one registration event (the original OR one of its
 * amendments — `listPreregs` returns one `PreregView` per event recorded, in
 * registration order), enriched with:
 *  - `amendmentChain`: every id in this registration's lineage, oldest first,
 *    ending with `id` itself (length 1 for an original registration with no
 *    amendments yet).
 *  - `outcomes`: every outcome recorded against exactly this id (not the
 *    whole lineage — an outcome always names the specific prereg it was
 *    judged against).
 */
export interface PreregView extends PreregRegistration {
	amendmentChain: string[];
	outcomes: PreregOutcome[];
}

export class PreregValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PreregValidationError";
	}
}

export class PreregNotFoundError extends Error {
	readonly id: string;
	constructor(id: string) {
		super(`No pre-registration with id ${id}`);
		this.name = "PreregNotFoundError";
		this.id = id;
	}
}

const PREREG_FILE_NAME = "prereg.jsonl";

export function preregPath(workspaceDir: string): string {
	return join(workspaceDir, PREREG_FILE_NAME);
}

/** Nanoid-style short id built from node:crypto only (no new dependency) — same recipe as ledger/store.ts's generateId. */
function generateId(): string {
	return randomBytes(9).toString("base64url");
}

function ensureFile(workspaceDir: string): string {
	if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true });
	const path = preregPath(workspaceDir);
	if (!existsSync(path)) writeFileSync(path, "");
	return path;
}

function loadEvents(path: string): PreregEvent[] {
	if (!existsSync(path)) return [];
	const contents = readFileSync(path, "utf8");
	const events: PreregEvent[] = [];
	for (const line of contents.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		events.push(JSON.parse(trimmed) as PreregEvent);
	}
	return events;
}

function validateMetric(metric: unknown, index: number): PreregMetric {
	if (typeof metric !== "object" || metric === null) {
		throw new PreregValidationError(`metrics[${index}] must be an object with name/direction/successThreshold`);
	}
	const { name, direction, successThreshold } = metric as Record<string, unknown>;
	if (typeof name !== "string" || name.trim().length === 0) {
		throw new PreregValidationError(`metrics[${index}].name must be a non-empty string`);
	}
	if (direction !== "min" && direction !== "max") {
		throw new PreregValidationError(
			`metrics[${index}].direction must be "min" or "max", got ${JSON.stringify(direction)}`,
		);
	}
	if (typeof successThreshold !== "string" || successThreshold.trim().length === 0) {
		throw new PreregValidationError(`metrics[${index}].successThreshold must be a non-empty string`);
	}
	return { name, direction, successThreshold };
}

function toView(
	registration: PreregRegistration,
	byId: Map<string, PreregRegistration>,
	outcomesById: Map<string, PreregOutcome[]>,
): PreregView {
	const chain: string[] = [registration.id];
	let cursor = registration;
	while (cursor.amends) {
		const parent = byId.get(cursor.amends);
		if (!parent) break; // defensive: an amends id not present in the file (shouldn't happen — validated at register time)
		chain.unshift(parent.id);
		cursor = parent;
	}
	return { ...registration, amendmentChain: chain, outcomes: outcomesById.get(registration.id) ?? [] };
}

/**
 * Appends a new pre-registration event to `<workspaceDir>/prereg.jsonl` and
 * journals it (phase "prereg"). An amendment (`input.amends` set) is always a
 * NEW entry — the prior entry is never rewritten; `input.amends` must name an
 * id already present in the file, or `PreregNotFoundError` is thrown before
 * anything is recorded.
 */
export function registerPrereg(workspaceDir: string, input: RegisterPreregInput): PreregView {
	if (typeof input.hypothesis !== "string" || input.hypothesis.trim().length === 0) {
		throw new PreregValidationError("hypothesis must be a non-empty string");
	}
	if (!Array.isArray(input.metrics) || input.metrics.length === 0) {
		throw new PreregValidationError(
			"metrics must be a non-empty array — declare every threshold before running anything",
		);
	}
	const metrics = input.metrics.map((m, i) => validateMetric(m, i));
	if (input.budgetNote !== undefined && typeof input.budgetNote !== "string") {
		throw new PreregValidationError("budgetNote must be a string when given");
	}

	const path = ensureFile(workspaceDir);
	const events = loadEvents(path);
	const byId = new Map(
		events.filter((e) => e.kind === "prereg_registered").map((e) => [e.registration.id, e.registration]),
	);

	if (input.amends !== undefined) {
		if (typeof input.amends !== "string" || input.amends.trim().length === 0) {
			throw new PreregValidationError("amends must be a non-empty prereg id when given");
		}
		if (!byId.has(input.amends)) {
			throw new PreregNotFoundError(input.amends);
		}
	}

	const now = new Date().toISOString();
	const registration: PreregRegistration = {
		id: generateId(),
		hypothesis: input.hypothesis,
		metrics,
		...(input.budgetNote !== undefined ? { budgetNote: input.budgetNote } : {}),
		...(input.amends !== undefined ? { amends: input.amends } : {}),
		createdAt: now,
	};
	appendFileSync(
		path,
		`${JSON.stringify({ kind: "prereg_registered", at: now, registration } satisfies PreregEvent)}\n`,
	);

	const journal = openJournal(workspaceDir);
	journal.note(
		"prereg",
		input.amends
			? `Pre-registration ${registration.id} amends ${input.amends}: "${registration.hypothesis}" — ${metrics.length} metric(s): ` +
					metrics.map((m) => `${m.name} (${m.direction} ${m.successThreshold})`).join(", ")
			: `Pre-registered ${registration.id}: "${registration.hypothesis}" — ${metrics.length} metric(s): ` +
					metrics.map((m) => `${m.name} (${m.direction} ${m.successThreshold})`).join(", "),
	);

	byId.set(registration.id, registration);
	return toView(registration, byId, new Map());
}

/**
 * Appends an outcome event judged against `input.preregId`'s already-recorded
 * metrics — no metric values not on that pre-registration should be
 * introduced here; this function does not enforce which metric names appear
 * in `metricValues` (the calling session/tool is responsible for judging only
 * against what was declared), but it does require `preregId` to reference a
 * pre-registration that actually exists.
 */
export function recordPreregOutcome(workspaceDir: string, input: RecordPreregOutcomeInput): PreregOutcome {
	if (typeof input.preregId !== "string" || input.preregId.trim().length === 0) {
		throw new PreregValidationError("preregId must be a non-empty string");
	}
	if (typeof input.runId !== "string" || input.runId.trim().length === 0) {
		throw new PreregValidationError("runId must be a non-empty string");
	}
	if (input.verdict !== "kept" && input.verdict !== "discarded") {
		throw new PreregValidationError(`verdict must be "kept" or "discarded", got ${JSON.stringify(input.verdict)}`);
	}
	if (typeof input.metricValues !== "object" || input.metricValues === null || Array.isArray(input.metricValues)) {
		throw new PreregValidationError("metricValues must be an object of metric name -> observed value");
	}

	const path = ensureFile(workspaceDir);
	const events = loadEvents(path);
	const registered = new Set(events.filter((e) => e.kind === "prereg_registered").map((e) => e.registration.id));
	if (!registered.has(input.preregId)) {
		throw new PreregNotFoundError(input.preregId);
	}

	const now = new Date().toISOString();
	const outcome: PreregOutcome = {
		preregId: input.preregId,
		runId: input.runId,
		metricValues: { ...input.metricValues },
		verdict: input.verdict,
		...(input.note !== undefined ? { note: input.note } : {}),
		createdAt: now,
	};
	appendFileSync(path, `${JSON.stringify({ kind: "prereg_outcome", at: now, outcome } satisfies PreregEvent)}\n`);

	const journal = openJournal(workspaceDir);
	journal.note(
		"prereg",
		`Outcome for ${input.preregId} (run ${input.runId}): ${input.verdict}. ` +
			Object.entries(outcome.metricValues)
				.map(([k, v]) => `${k}=${v}`)
				.join("; "),
	);

	return outcome;
}

/**
 * Folds `<workspaceDir>/prereg.jsonl` into its current view: one `PreregView`
 * per registration event ever recorded (the original and every amendment),
 * in the order they were registered, each carrying its own amendment lineage
 * and the outcomes recorded against exactly that id. Returns `[]` if
 * `prereg.jsonl` doesn't exist yet.
 */
export function listPreregs(workspaceDir: string): PreregView[] {
	const path = preregPath(workspaceDir);
	const events = loadEvents(path);

	const registrations: PreregRegistration[] = [];
	const byId = new Map<string, PreregRegistration>();
	const outcomesById = new Map<string, PreregOutcome[]>();

	for (const event of events) {
		if (event.kind === "prereg_registered") {
			registrations.push(event.registration);
			byId.set(event.registration.id, event.registration);
		} else {
			const list = outcomesById.get(event.outcome.preregId);
			if (list) list.push(event.outcome);
			else outcomesById.set(event.outcome.preregId, [event.outcome]);
		}
	}

	return registrations.map((r) => toView(r, byId, outcomesById));
}
