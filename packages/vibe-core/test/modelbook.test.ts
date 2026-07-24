import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	aggregateModelbook,
	appendSessionRecord,
	modelbookPath,
	type SessionRecord,
} from "../src/modelbook/modelbook.ts";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "vibe-core-modelbook-"));
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
	return {
		at: new Date().toISOString(),
		role: "reasoner",
		model: "openrouter/anthropic/claude-sonnet-5",
		family: "anthropic",
		objectiveKind: "investigate",
		tokens: { input: 100, output: 50, total: 150 },
		durationMs: 1000,
		outcome: "completed",
		...overrides,
	};
}

describe("appendSessionRecord", () => {
	it("appends one JSONL line per call, creating the workspace dir if needed", () => {
		const dir = join(makeTempDir(), "workspace");
		appendSessionRecord(dir, record());
		appendSessionRecord(dir, record({ role: "checker", objectiveKind: "checker" }));

		const lines = readFileSync(modelbookPath(dir), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).role).toBe("reasoner");
		expect(JSON.parse(lines[1]).role).toBe("checker");
	});
});

describe("aggregateModelbook", () => {
	it("returns an empty object when no modelbook.jsonl exists yet", () => {
		expect(aggregateModelbook(makeTempDir())).toEqual({});
	});

	it("aggregates sessions/tokens/errorRate per model, with no approvalRate absent proposals", () => {
		const dir = makeTempDir();
		appendSessionRecord(
			dir,
			record({ model: "openrouter/anthropic/claude-sonnet-5", tokens: { input: 100, output: 50, total: 150 } }),
		);
		appendSessionRecord(
			dir,
			record({
				model: "openrouter/anthropic/claude-sonnet-5",
				tokens: { input: 200, output: 100, total: 300 },
				outcome: "error",
			}),
		);

		const agg = aggregateModelbook(dir);
		const model = "openrouter/anthropic/claude-sonnet-5";
		expect(agg[model].sessions).toBe(2);
		expect(agg[model].totalTokens).toBe(450);
		expect(agg[model].errorRate).toBeCloseTo(0.5);
		expect(agg[model].approvalRate).toBeUndefined();
	});

	it("computes approvalRate only for models with at least one resolved checker proposal", () => {
		const dir = makeTempDir();
		const checkerModel = "openrouter/openai/gpt-5.6";
		appendSessionRecord(
			dir,
			record({
				model: checkerModel,
				role: "checker",
				objectiveKind: "checker",
				proposalsApproved: 3,
				proposalsRejected: 1,
			}),
		);
		appendSessionRecord(
			dir,
			record({
				model: checkerModel,
				role: "checker",
				objectiveKind: "checker",
				proposalsApproved: 1,
				proposalsRejected: 0,
			}),
		);

		const agg = aggregateModelbook(dir);
		expect(agg[checkerModel].approvalRate).toBeCloseTo(4 / 5);
	});

	it("keeps separate aggregates per model", () => {
		const dir = makeTempDir();
		appendSessionRecord(dir, record({ model: "openrouter/anthropic/claude-sonnet-5" }));
		appendSessionRecord(dir, record({ model: "openrouter/openai/gpt-5.6", family: "openai" }));

		const agg = aggregateModelbook(dir);
		expect(Object.keys(agg).sort()).toEqual(
			["openrouter/anthropic/claude-sonnet-5", "openrouter/openai/gpt-5.6"].sort(),
		);
		expect(agg["openrouter/anthropic/claude-sonnet-5"].sessions).toBe(1);
		expect(agg["openrouter/openai/gpt-5.6"].sessions).toBe(1);
	});
});
