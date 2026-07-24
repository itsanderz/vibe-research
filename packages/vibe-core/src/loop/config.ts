import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Loop config — spec docs/research/loop-design.md "Roles & the checker gate":
 * `<dataDir>/vibe.config.json`. M2s1 only reads `roles` and `budget`; the
 * `fallbacks` list mentioned in the design's provider-health section lands in
 * a later slice.
 */

export interface RoleConfig {
	model: string;
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
	return { model };
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
