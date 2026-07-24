import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openJournal } from "../src/journal/journal.ts";
import {
	dataDirFor,
	INVESTIGATION_COMPLETE_MARKER,
	type RunSessionContext,
	type RunSessionFn,
	type RunSessionResult,
	runLoop,
} from "../src/loop/controller.ts";
import { initState, saveState } from "../src/loop/state.ts";

/**
 * No live API calls anywhere in this file — every scenario drives runLoop()
 * with a fake `deps.runSession`, per the M2s1 task spec ("Tests ... NO live
 * API calls in tests").
 */

interface WorkspaceOptions {
	maxTokens?: number;
	maxWallClockHours?: number;
	maxIterations?: number;
}

function makeWorkspace(budget: WorkspaceOptions = {}): string {
	const workspaceDir = mkdtempSync(join(tmpdir(), "vibe-core-loop-controller-"));
	const dataDir = dataDirFor(workspaceDir);
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		join(dataDir, "vibe.config.json"),
		JSON.stringify({
			roles: { reasoner: { model: "test-provider/test-model" } },
			budget,
		}),
		"utf8",
	);
	return workspaceDir;
}

function okResult(transcriptSummary: string, total = 100): RunSessionResult {
	return { transcriptSummary, usage: { input: total / 2, output: total / 2, total } };
}

function errorResult(error: string): RunSessionResult {
	return { transcriptSummary: "", usage: { input: 0, output: 0, total: 0 }, error };
}

describe("runLoop — budget stop (token cap)", () => {
	it("stops before the next iteration once accumulated tokens reach maxTokens", async () => {
		const workspaceDir = makeWorkspace({ maxTokens: 100, maxIterations: 25, maxWallClockHours: 4 });
		const runSession: RunSessionFn = vi.fn(async () => okResult("still working", 150));

		const result = await runLoop(workspaceDir, "a trivial problem", { runSession });

		expect(runSession).toHaveBeenCalledTimes(1);
		expect(result.iterations).toBe(1);
		expect(result.tokensSpent).toBe(150);
		expect(result.stopReason).toMatch(/token budget exceeded/);
	});
});

describe("runLoop — iteration cap", () => {
	it("stops after maxIterations completed iterations", async () => {
		const workspaceDir = makeWorkspace({ maxIterations: 1 });
		const runSession: RunSessionFn = vi.fn(async () => okResult("still working", 10));

		const result = await runLoop(workspaceDir, "a trivial problem", { runSession });

		expect(runSession).toHaveBeenCalledTimes(1);
		expect(result.iterations).toBe(1);
		expect(result.stopReason).toMatch(/iteration cap reached \(1\)/);
	});
});

describe("runLoop — two-strike error stop", () => {
	it("stops after two consecutive session errors, without exhausting the iteration budget", async () => {
		const workspaceDir = makeWorkspace({ maxIterations: 25 });
		const runSession: RunSessionFn = vi.fn(async () => errorResult("502 bad gateway"));

		const result = await runLoop(workspaceDir, "a trivial problem", { runSession });

		expect(runSession).toHaveBeenCalledTimes(2);
		expect(result.iterations).toBe(2);
		expect(result.stopReason).toMatch(/2 consecutive session errors/);
		expect(result.stopReason).toMatch(/502 bad gateway/);
	});

	it("a success in between resets the strike count", async () => {
		const workspaceDir = makeWorkspace({ maxIterations: 25 });
		let call = 0;
		const runSession: RunSessionFn = vi.fn(async () => {
			call += 1;
			// error, ok, error, error -> should stop on the 4th call (2 in a row), not the 3rd.
			if (call === 2) return okResult("recovered");
			return errorResult(`boom ${call}`);
		});

		const result = await runLoop(workspaceDir, "a trivial problem", { runSession });

		expect(runSession).toHaveBeenCalledTimes(4);
		expect(result.iterations).toBe(4);
		expect(result.stopReason).toMatch(/2 consecutive session errors/);
	});
});

describe("runLoop — INVESTIGATION_COMPLETE stop", () => {
	it("stops as soon as a session's transcript summary contains the literal marker", async () => {
		const workspaceDir = makeWorkspace({ maxIterations: 25 });
		const runSession: RunSessionFn = vi.fn(async () =>
			okResult(`No further avenues to try.\n${INVESTIGATION_COMPLETE_MARKER}`),
		);

		const result = await runLoop(workspaceDir, "a trivial problem", { runSession });

		expect(runSession).toHaveBeenCalledTimes(1);
		expect(result.iterations).toBe(1);
		expect(result.stopReason).toBe(INVESTIGATION_COMPLETE_MARKER);
	});
});

describe("runLoop — resume", () => {
	it("continues iteration numbering from the persisted checkpoint", async () => {
		const workspaceDir = makeWorkspace({ maxIterations: 25 });
		const dataDir = dataDirFor(workspaceDir);

		const seeded = initState("a resumed problem");
		seeded.iteration = 3;
		seeded.lastCompletedIteration = 3;
		seeded.budgetSpent = { tokens: 999, wallClockMs: 1000 };
		saveState(dataDir, seeded);

		const seenIterations: number[] = [];
		const runSession: RunSessionFn = vi.fn(async (_objective: string, context: RunSessionContext) => {
			seenIterations.push(context.iteration);
			return okResult(INVESTIGATION_COMPLETE_MARKER, 1);
		});

		const result = await runLoop(workspaceDir, undefined, { runSession }, { resume: true });

		expect(seenIterations).toEqual([4]);
		expect(result.iterations).toBe(4);
		expect(result.tokensSpent).toBe(1000);
	});

	it("refuses to resume a stopped loop without --force", async () => {
		const workspaceDir = makeWorkspace({ maxIterations: 1 });
		const runSession: RunSessionFn = vi.fn(async () => okResult("still working"));

		// Natural stop: iteration cap of 1 is reached, which writes stopped{}.
		await runLoop(workspaceDir, "a trivial problem", { runSession });
		expect(runSession).toHaveBeenCalledTimes(1);

		await expect(runLoop(workspaceDir, undefined, { runSession }, { resume: true })).rejects.toThrow(
			/pass --force to resume/,
		);
		// The refused resume must not have started a new session.
		expect(runSession).toHaveBeenCalledTimes(1);
	});

	it("continues past a stopped loop when --force is given", async () => {
		const workspaceDir = makeWorkspace({ maxIterations: 1 });
		const runSession: RunSessionFn = vi.fn(async () => okResult("still working"));

		await runLoop(workspaceDir, "a trivial problem", { runSession });
		expect(runSession).toHaveBeenCalledTimes(1);

		// maxIterations is still 1 and state.iteration is already 1, so the forced
		// resume immediately re-hits the same iteration-cap stop condition without
		// running a new session — this asserts --force is accepted (no throw),
		// not that it magically raises the configured budget.
		const result = await runLoop(workspaceDir, undefined, { runSession }, { resume: true, force: true });
		expect(result.stopReason).toMatch(/iteration cap reached \(1\)/);
		expect(runSession).toHaveBeenCalledTimes(1);
	});
});

describe("runLoop — dossier on stop", () => {
	it("(re)generates workspace/dossier.md for every stop condition", async () => {
		const workspaceDir = makeWorkspace({ maxIterations: 1 });
		const runSession: RunSessionFn = vi.fn(async () => okResult("still working"));

		const result = await runLoop(workspaceDir, "a trivial problem", { runSession });

		expect(existsSync(result.dossierPath)).toBe(true);
		expect(result.dossierPath).toBe(join(dataDirFor(workspaceDir), "dossier.md"));
	});
});

describe("runLoop — journal", () => {
	it('appends a phase "iteration" entry for every completed iteration', async () => {
		const workspaceDir = makeWorkspace({ maxIterations: 3 });
		let call = 0;
		const runSession: RunSessionFn = vi.fn(async () => {
			call += 1;
			return okResult(`iteration ${call} summary text`);
		});

		await runLoop(workspaceDir, "a trivial problem", { runSession });

		const entries = openJournal(dataDirFor(workspaceDir)).entries();
		const iterationEntries = entries.filter((e) => e.phase === "iteration");
		expect(iterationEntries).toHaveLength(3);
		expect(iterationEntries[0].text).toContain("iteration 1 summary text");
		expect(iterationEntries[2].text).toContain("iteration 3 summary text");
	});
});

describe("runLoop — plan/act require a problem to start fresh", () => {
	it("throws if problem is missing and resume was not requested", async () => {
		const workspaceDir = makeWorkspace();
		const runSession: RunSessionFn = vi.fn(async () => okResult("x"));
		await expect(runLoop(workspaceDir, undefined, { runSession })).rejects.toThrow(/problem is required/);
		expect(runSession).not.toHaveBeenCalled();
	});
});
