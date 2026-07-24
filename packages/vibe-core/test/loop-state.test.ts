import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initState, loadState, saveState, stateExists, statePath } from "../src/loop/state.ts";

function makeTempDataDir(): string {
	return mkdtempSync(join(tmpdir(), "vibe-core-loop-state-"));
}

describe("initState", () => {
	it("returns a fresh state at iteration 0 with the given problem recorded", () => {
		const state = initState("Is every even number > 2 the sum of two primes?");
		expect(state.iteration).toBe(0);
		expect(state.lastCompletedIteration).toBe(0);
		expect(state.problem).toBe("Is every even number > 2 the sum of two primes?");
		expect(state.budgetSpent).toEqual({ tokens: 0, wallClockMs: 0 });
		expect(state.stopped).toBeUndefined();
		expect(state.providerHealth).toEqual({});
		expect(() => new Date(state.startedAt).toISOString()).not.toThrow();
	});
});

describe("saveState / loadState — roundtrip", () => {
	it("loadState(saveState(x)) reproduces x exactly", () => {
		const dataDir = makeTempDataDir();
		const state = initState("roundtrip problem");
		state.iteration = 3;
		state.lastCompletedIteration = 3;
		state.budgetSpent = { tokens: 12_345, wallClockMs: 987_654 };

		saveState(dataDir, state);
		const reloaded = loadState(dataDir);

		expect(reloaded).toEqual(state);
	});

	it("roundtrips a stopped state, including the stopped{reason, at} block", () => {
		const dataDir = makeTempDataDir();
		const state = initState("stopped problem");
		state.stopped = { reason: "iteration cap reached (25)", at: new Date().toISOString() };

		saveState(dataDir, state);
		expect(loadState(dataDir)).toEqual(state);
	});

	it("stateExists is false before the first save and true after", () => {
		const dataDir = makeTempDataDir();
		expect(stateExists(dataDir)).toBe(false);
		saveState(dataDir, initState("p"));
		expect(stateExists(dataDir)).toBe(true);
	});
});

describe("saveState — atomicity", () => {
	it("writes via a tmp file that is renamed away, never left behind on success", () => {
		const dataDir = makeTempDataDir();
		saveState(dataDir, initState("atomic problem"));

		const entries = readdirSync(dataDir);
		expect(entries).toContain("loop-state.json");
		// No leftover .loop-state.json.tmp-* files after a clean write.
		expect(entries.some((name) => name.includes(".tmp-"))).toBe(false);
	});

	it("a partially-written tmp file alongside a complete loop-state.json is ignored by loadState", () => {
		const dataDir = makeTempDataDir();
		const state = initState("partial-write problem");
		saveState(dataDir, state);

		// Simulate a crash mid-write: a stray tmp file with truncated/invalid JSON.
		writeFileSync(join(dataDir, ".loop-state.json.tmp-99999-123-abcxyz"), '{"iteration": 4, "incompl', "utf8");

		expect(loadState(dataDir)).toEqual(state);
		expect(existsSync(statePath(dataDir))).toBe(true);
	});

	it("each save produces valid, complete JSON — no reader ever observes a half-written file", () => {
		const dataDir = makeTempDataDir();
		for (let i = 1; i <= 5; i++) {
			const state = initState("many saves");
			state.iteration = i;
			saveState(dataDir, state);
			const text = readFileSync(statePath(dataDir), "utf8");
			expect(() => JSON.parse(text)).not.toThrow();
			expect(JSON.parse(text).iteration).toBe(i);
		}
	});
});
