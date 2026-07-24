import { readFileSync } from "node:fs";
import { join } from "node:path";
import { familyOf } from "./family.ts";

/**
 * Loop config — spec docs/research/loop-design.md "Roles & the checker gate"
 * and "Budgets & provider health": `<dataDir>/vibe.config.json`.
 */

export interface RoleConfig {
	model: string;
	/** Ordered list of fallback models this role switches to (loop/controller.ts's `selectHealthyModel`) once `model` is marked unhealthy — loop-design.md "Budgets & provider health". Optional; omit for no fallback. */
	fallbacks?: string[];
}

/** At least `reasoner` must be present; other roles (adversary/checker/librarian/...) are added as slices need them. */
export interface RolesConfig {
	reasoner: RoleConfig;
	[role: string]: RoleConfig | undefined;
}

export interface LoopBudget {
	maxTokens?: number;
	maxWallClockHours?: number;
	maxIterations?: number;
}

export interface LoopConfig {
	roles: RolesConfig;
	budget: Required<LoopBudget>;
}

/** Safe defaults for any budget field the config omits (task spec: 1M tokens / 4h / 25 iterations). */
export const DEFAULT_BUDGET: Required<LoopBudget> = {
	maxTokens: 1_000_000,
	maxWallClockHours: 4,
	maxIterations: 25,
};

const CONFIG_FILE_NAME = "vibe.config.json";

/** Thrown when `vibe.config.json` is missing, not valid JSON, or fails shape validation. Message states exactly what was wrong. */
export class ConfigValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigValidationError";
	}
}

/** Path to the config file inside a loop data directory (`<workspaceDir>/workspace`). */
export function configPath(dataDir: string): string {
	return join(dataDir, CONFIG_FILE_NAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRoleConfig(role: string, value: unknown): RoleConfig {
	if (!isPlainObject(value)) {
		throw new ConfigValidationError(`roles.${role} must be an object with a "model" string`);
	}
	const model = value.model;
	if (typeof model !== "string" || model.trim().length === 0) {
		throw new ConfigValidationError(
			`roles.${role}.model must be a non-empty string (e.g. "openrouter/anthropic/claude-sonnet-5")`,
		);
	}
	const fallbacks = validateFallbacks(role, value.fallbacks);
	return fallbacks !== undefined ? { model, fallbacks } : { model };
}

function validateFallbacks(role: string, value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new ConfigValidationError(`roles.${role}.fallbacks must be an array of model strings`);
	}
	const fallbacks = value.map((entry, index) => {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			throw new ConfigValidationError(`roles.${role}.fallbacks[${index}] must be a non-empty string`);
		}
		// Task spec: "every fallback must parse via familyOf". familyOf(entry) never throws — for any
		// non-empty string it resolves to a family (single segment = itself), so this call is the
		// required parse-check; the non-empty-string check above is what actually guards against junk.
		familyOf(entry);
		return entry;
	});
	return fallbacks;
}

function validateBudget(value: unknown): Required<LoopBudget> {
	if (value === undefined) {
		return { ...DEFAULT_BUDGET };
	}
	if (!isPlainObject(value)) {
		throw new ConfigValidationError("budget must be an object");
	}
	const budget = { ...DEFAULT_BUDGET };
	for (const key of Object.keys(DEFAULT_BUDGET) as Array<keyof LoopBudget>) {
		const raw = value[key];
		if (raw === undefined) continue;
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
			throw new ConfigValidationError(`budget.${key} must be a positive number`);
		}
		budget[key] = raw;
	}
	// Reject unknown keys so typos (e.g. "maxToken") fail loudly instead of silently no-op'ing.
	for (const key of Object.keys(value)) {
		if (!(key in DEFAULT_BUDGET)) {
			throw new ConfigValidationError(`budget.${key} is not a recognized budget field`);
		}
	}
	return budget;
}

/** Validates an already-parsed JSON value against the loop config shape. Throws `ConfigValidationError` describing the first problem found. */
export function validateConfig(raw: unknown): LoopConfig {
	if (!isPlainObject(raw)) {
		throw new ConfigValidationError("config must be a JSON object");
	}
	if (!isPlainObject(raw.roles)) {
		throw new ConfigValidationError("roles must be an object");
	}
	if (!("reasoner" in raw.roles)) {
		throw new ConfigValidationError("roles.reasoner is required (no default model — every loop needs a reasoner)");
	}
	const roles: RolesConfig = { reasoner: validateRoleConfig("reasoner", raw.roles.reasoner) };
	for (const [role, value] of Object.entries(raw.roles)) {
		if (role === "reasoner") continue;
		roles[role] = validateRoleConfig(role, value);
	}
	const budget = validateBudget(raw.budget);
	return { roles, budget };
}

/**
 * Refuses a configured checker whose model family (`familyOf`) matches the
 * reasoner's — spec docs/research/loop-design.md "Roles & the checker gate":
 * "the loop refuses to start a checker session whose model family ... equals
 * the proposing session's." A same-family checker can't provide independent
 * verification, so this is a config error, not a runtime one: it's checked
 * once at loop start (see `loop/controller.ts`), before any session runs. A
 * config with no `roles.checker` at all is fine — that's the "no checker
 * configured" case (proposals simply stay open).
 *
 * M2s3 extension (loop-design.md "Budgets & provider health"): since a role
 * can fail over to a `fallbacks` model mid-run, EVERY model the checker might
 * ever run as (its primary + all its fallbacks) must differ in family from
 * every model the reasoner might ever run as (its primary + all its
 * fallbacks) — otherwise a fallback switch could silently put two
 * same-family models on either side of the checker gate.
 */
export function assertDistinctCheckerFamily(config: LoopConfig): void {
	const checker = config.roles.checker;
	if (!checker) return;

	const reasonerModels = [config.roles.reasoner.model, ...(config.roles.reasoner.fallbacks ?? [])];
	const checkerModels = [checker.model, ...(checker.fallbacks ?? [])];

	for (const reasonerModel of reasonerModels) {
		const reasonerFamily = familyOf(reasonerModel);
		for (const checkerModel of checkerModels) {
			const checkerFamily = familyOf(checkerModel);
			if (reasonerFamily === checkerFamily) {
				throw new ConfigValidationError(
					`roles.checker model "${checkerModel}" must be a different model family than roles.reasoner model ` +
						`"${reasonerModel}" — both resolve to family "${reasonerFamily}". Every checker model (primary + ` +
						`fallbacks) must differ in family from every reasoner model (primary + fallbacks); a same-family ` +
						`pairing cannot provide independent verification (docs/research/loop-design.md "Roles & the checker gate").`,
				);
			}
		}
	}
}

/**
 * Loads and validates `<dataDir>/vibe.config.json` (`dataDir` is the loop's
 * data directory, `<workspaceDir>/workspace` — see `loop/controller.ts`).
 * Throws `ConfigValidationError` if the file is missing, not valid JSON, or
 * fails shape validation.
 */
export function loadConfig(dataDir: string): LoopConfig {
	const path = configPath(dataDir);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new ConfigValidationError(
			`could not read ${path}: ${error instanceof Error ? error.message : String(error)}. ` +
				'Create it with at least {"roles": {"reasoner": {"model": "<provider>/<model>"}}}.',
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new ConfigValidationError(
			`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return validateConfig(raw);
}
