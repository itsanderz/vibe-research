import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertDistinctCheckerFamily,
	ConfigValidationError,
	DEFAULT_BUDGET,
	loadConfig,
	validateConfig,
} from "../src/loop/config.ts";

function makeTempDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "vibe-core-loop-config-"));
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeConfig(dataDir: string, contents: string): void {
	writeFileSync(join(dataDir, "vibe.config.json"), contents, "utf8");
}

describe("validateConfig — accepted shapes", () => {
	it("accepts a minimal config with only roles.reasoner.model, filling in default budget", () => {
		const config = validateConfig({ roles: { reasoner: { model: "openrouter/anthropic/claude-sonnet-5" } } });
		expect(config.roles.reasoner.model).toBe("openrouter/anthropic/claude-sonnet-5");
		expect(config.budget).toEqual(DEFAULT_BUDGET);
	});

	it("accepts extra roles and a fully-specified budget, using the given values as-is", () => {
		const config = validateConfig({
			roles: {
				reasoner: { model: "openrouter/anthropic/claude-sonnet-5" },
				adversary: { model: "openrouter/deepseek/deepseek-v4" },
			},
			budget: { maxTokens: 5_000_000, maxWallClockHours: 8, maxIterations: 100 },
		});
		expect(config.roles.adversary).toEqual({ model: "openrouter/deepseek/deepseek-v4" });
		expect(config.budget).toEqual({ maxTokens: 5_000_000, maxWallClockHours: 8, maxIterations: 100 });
	});

	it("fills in only the omitted budget fields, leaving the given ones untouched", () => {
		const config = validateConfig({
			roles: { reasoner: { model: "openrouter/anthropic/claude-sonnet-5" } },
			budget: { maxIterations: 5 },
		});
		expect(config.budget).toEqual({ ...DEFAULT_BUDGET, maxIterations: 5 });
	});
});

describe("validateConfig — rejected shapes", () => {
	it("rejects a non-object", () => {
		expect(() => validateConfig("not an object")).toThrow(ConfigValidationError);
		expect(() => validateConfig(null)).toThrow(ConfigValidationError);
		expect(() => validateConfig([])).toThrow(ConfigValidationError);
	});

	it("rejects a missing roles.reasoner", () => {
		expect(() => validateConfig({ roles: { adversary: { model: "x/y" } } })).toThrow(/roles\.reasoner is required/);
	});

	it("rejects roles.reasoner without a model", () => {
		expect(() => validateConfig({ roles: { reasoner: {} } })).toThrow(ConfigValidationError);
		expect(() => validateConfig({ roles: { reasoner: { model: "" } } })).toThrow(ConfigValidationError);
		expect(() => validateConfig({ roles: { reasoner: { model: 42 } } })).toThrow(ConfigValidationError);
	});

	it("rejects a non-object budget", () => {
		expect(() => validateConfig({ roles: { reasoner: { model: "x/y" } }, budget: "soon" })).toThrow(
			ConfigValidationError,
		);
	});

	it("rejects a non-positive or non-numeric budget field", () => {
		expect(() => validateConfig({ roles: { reasoner: { model: "x/y" } }, budget: { maxTokens: -1 } })).toThrow(
			ConfigValidationError,
		);
		expect(() =>
			validateConfig({ roles: { reasoner: { model: "x/y" } }, budget: { maxIterations: "lots" } }),
		).toThrow(ConfigValidationError);
	});

	it("rejects an unrecognized budget field", () => {
		expect(() => validateConfig({ roles: { reasoner: { model: "x/y" } }, budget: { maxToken: 10 } })).toThrow(
			/not a recognized budget field/,
		);
	});
});

describe("validateConfig — fallbacks (M2s3, spec 'Budgets & provider health')", () => {
	it("accepts a role with a fallbacks list", () => {
		const config = validateConfig({
			roles: {
				reasoner: {
					model: "openrouter/anthropic/claude-sonnet-5",
					fallbacks: ["openrouter/anthropic/claude-haiku"],
				},
			},
		});
		expect(config.roles.reasoner.fallbacks).toEqual(["openrouter/anthropic/claude-haiku"]);
	});

	it("omits fallbacks entirely from the parsed role when not given", () => {
		const config = validateConfig({ roles: { reasoner: { model: "openrouter/anthropic/claude-sonnet-5" } } });
		expect(config.roles.reasoner.fallbacks).toBeUndefined();
	});

	it("rejects a non-array fallbacks field", () => {
		expect(() => validateConfig({ roles: { reasoner: { model: "x/y", fallbacks: "x/z" } } })).toThrow(
			/fallbacks must be an array/,
		);
	});

	it("rejects a fallbacks array containing a non-string or empty entry", () => {
		expect(() => validateConfig({ roles: { reasoner: { model: "x/y", fallbacks: [42] } } })).toThrow(
			ConfigValidationError,
		);
		expect(() => validateConfig({ roles: { reasoner: { model: "x/y", fallbacks: [""] } } })).toThrow(
			ConfigValidationError,
		);
	});
});

describe("assertDistinctCheckerFamily", () => {
	it("is a no-op when no roles.checker is configured", () => {
		const config = validateConfig({ roles: { reasoner: { model: "openrouter/anthropic/claude-sonnet-5" } } });
		expect(() => assertDistinctCheckerFamily(config)).not.toThrow();
	});

	it("allows a checker from a different model family (including meta-provider passthrough)", () => {
		const config = validateConfig({
			roles: {
				reasoner: { model: "openrouter/anthropic/claude-sonnet-5" },
				checker: { model: "openrouter/openai/gpt-5.6-sol" },
			},
		});
		expect(() => assertDistinctCheckerFamily(config)).not.toThrow();
	});

	it("refuses a checker from the same model family as the reasoner", () => {
		const config = validateConfig({
			roles: {
				reasoner: { model: "openrouter/anthropic/claude-sonnet-5" },
				checker: { model: "anthropic/claude-haiku" },
			},
		});
		expect(() => assertDistinctCheckerFamily(config)).toThrow(ConfigValidationError);
		expect(() => assertDistinctCheckerFamily(config)).toThrow(/different model family/);
	});

	it("refuses when a CHECKER FALLBACK collides in family with the reasoner (M2s3)", () => {
		const config = validateConfig({
			roles: {
				reasoner: { model: "openrouter/anthropic/claude-sonnet-5" },
				checker: {
					model: "openrouter/openai/gpt-5.6-sol",
					fallbacks: ["anthropic/claude-haiku"], // same family ("anthropic") as the reasoner
				},
			},
		});
		expect(() => assertDistinctCheckerFamily(config)).toThrow(ConfigValidationError);
		expect(() => assertDistinctCheckerFamily(config)).toThrow(/different model family/);
	});

	it("refuses when the checker's primary collides in family with a REASONER FALLBACK (M2s3)", () => {
		const config = validateConfig({
			roles: {
				reasoner: {
					model: "openrouter/anthropic/claude-sonnet-5",
					fallbacks: ["openrouter/deepseek/deepseek-v4"],
				},
				checker: { model: "deepseek/deepseek-flash" }, // same family ("deepseek") as the reasoner's fallback
			},
		});
		expect(() => assertDistinctCheckerFamily(config)).toThrow(ConfigValidationError);
		expect(() => assertDistinctCheckerFamily(config)).toThrow(/different model family/);
	});

	it("allows a checker whose primary + fallbacks are all distinct from the reasoner's primary + fallbacks (M2s3)", () => {
		const config = validateConfig({
			roles: {
				reasoner: {
					model: "openrouter/anthropic/claude-sonnet-5",
					fallbacks: ["openrouter/anthropic/claude-haiku"],
				},
				checker: {
					model: "openrouter/openai/gpt-5.6-sol",
					fallbacks: ["openrouter/deepseek/deepseek-v4"],
				},
			},
		});
		expect(() => assertDistinctCheckerFamily(config)).not.toThrow();
	});
});

describe("loadConfig", () => {
	it("reads and validates workspace/vibe.config.json from disk", () => {
		const dataDir = makeTempDataDir();
		writeConfig(dataDir, JSON.stringify({ roles: { reasoner: { model: "openrouter/anthropic/claude-sonnet-5" } } }));

		const config = loadConfig(dataDir);
		expect(config.roles.reasoner.model).toBe("openrouter/anthropic/claude-sonnet-5");
		expect(config.budget).toEqual(DEFAULT_BUDGET);
	});

	it("throws a clear ConfigValidationError when the file is missing", () => {
		const dataDir = makeTempDataDir();
		expect(() => loadConfig(dataDir)).toThrow(ConfigValidationError);
		expect(() => loadConfig(dataDir)).toThrow(/could not read/);
	});

	it("throws a clear ConfigValidationError when the file is not valid JSON", () => {
		const dataDir = makeTempDataDir();
		writeConfig(dataDir, "{ not json");
		expect(() => loadConfig(dataDir)).toThrow(/not valid JSON/);
	});

	it("throws a clear ConfigValidationError when the file fails shape validation", () => {
		const dataDir = makeTempDataDir();
		writeConfig(dataDir, JSON.stringify({ roles: {} }));
		expect(() => loadConfig(dataDir)).toThrow(/roles\.reasoner is required/);
	});
});
