import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openJournal } from "../src/journal/journal.ts";
import {
	listPreregs,
	PreregNotFoundError,
	PreregValidationError,
	preregPath,
	recordPreregOutcome,
	registerPrereg,
} from "../src/prereg/prereg.ts";

function makeDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "vibe-core-prereg-"));
	mkdirSync(dir, { recursive: true });
	return dir;
}

const metric = { name: "accuracy", direction: "max" as const, successThreshold: ">= 0.9" };

describe("registerPrereg", () => {
	it("appends a registration and returns it with a generated id", () => {
		const dataDir = makeDataDir();
		const view = registerPrereg(dataDir, { hypothesis: "The method improves accuracy", metrics: [metric] });

		expect(view.id).toBeTruthy();
		expect(view.hypothesis).toBe("The method improves accuracy");
		expect(view.metrics).toEqual([metric]);
		expect(view.amends).toBeUndefined();
		expect(view.amendmentChain).toEqual([view.id]);
		expect(view.outcomes).toEqual([]);
	});

	it("rejects an empty hypothesis", () => {
		const dataDir = makeDataDir();
		expect(() => registerPrereg(dataDir, { hypothesis: "", metrics: [metric] })).toThrow(PreregValidationError);
	});

	it("rejects an empty metrics array — metrics must be declared before running anything", () => {
		const dataDir = makeDataDir();
		expect(() => registerPrereg(dataDir, { hypothesis: "x", metrics: [] })).toThrow(PreregValidationError);
	});

	it("rejects a metric with an invalid direction", () => {
		const dataDir = makeDataDir();
		expect(() =>
			registerPrereg(dataDir, {
				hypothesis: "x",
				metrics: [{ name: "a", direction: "up" as never, successThreshold: "1" }],
			}),
		).toThrow(PreregValidationError);
	});

	it("is append-only: the file gains one line per registration, never rewritten", () => {
		const dataDir = makeDataDir();
		registerPrereg(dataDir, { hypothesis: "first", metrics: [metric] });
		registerPrereg(dataDir, { hypothesis: "second", metrics: [metric] });

		const lines = readFileSync(preregPath(dataDir), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});

	it("journals a 'prereg' phase entry on registration", () => {
		const dataDir = makeDataDir();
		const view = registerPrereg(dataDir, { hypothesis: "The method improves accuracy", metrics: [metric] });

		const entries = openJournal(dataDir).entries();
		const note = entries.find((e) => e.phase === "prereg");
		expect(note).toBeDefined();
		expect(note?.text).toContain(view.id);
		expect(note?.text).toContain("The method improves accuracy");
	});

	it("an amendment is a NEW entry referencing the prior id via amends — the prior entry is untouched", () => {
		const dataDir = makeDataDir();
		const original = registerPrereg(dataDir, { hypothesis: "v1 hypothesis", metrics: [metric] });
		const amended = registerPrereg(dataDir, {
			hypothesis: "v2 hypothesis (revised metric threshold)",
			metrics: [{ ...metric, successThreshold: ">= 0.95" }],
			amends: original.id,
		});

		expect(amended.id).not.toBe(original.id);
		expect(amended.amends).toBe(original.id);
		expect(amended.amendmentChain).toEqual([original.id, amended.id]);

		const views = listPreregs(dataDir);
		expect(views).toHaveLength(2);
		// The original entry is unchanged — no in-place edit.
		expect(views[0].hypothesis).toBe("v1 hypothesis");
		expect(views[0].amendmentChain).toEqual([original.id]);
	});

	it("throws PreregNotFoundError when amending a nonexistent id", () => {
		const dataDir = makeDataDir();
		expect(() => registerPrereg(dataDir, { hypothesis: "x", metrics: [metric], amends: "nope" })).toThrow(
			PreregNotFoundError,
		);
	});

	it("supports a chain of amendments (amendment of an amendment)", () => {
		const dataDir = makeDataDir();
		const v1 = registerPrereg(dataDir, { hypothesis: "v1", metrics: [metric] });
		const v2 = registerPrereg(dataDir, { hypothesis: "v2", metrics: [metric], amends: v1.id });
		const v3 = registerPrereg(dataDir, { hypothesis: "v3", metrics: [metric], amends: v2.id });

		const views = listPreregs(dataDir);
		const v3View = views.find((v) => v.id === v3.id);
		expect(v3View?.amendmentChain).toEqual([v1.id, v2.id, v3.id]);
	});
});

describe("recordPreregOutcome", () => {
	it("appends an outcome event and returns it", () => {
		const dataDir = makeDataDir();
		const prereg = registerPrereg(dataDir, { hypothesis: "x", metrics: [metric] });

		const outcome = recordPreregOutcome(dataDir, {
			preregId: prereg.id,
			runId: "run-1",
			metricValues: { accuracy: "0.92" },
			verdict: "kept",
		});

		expect(outcome.preregId).toBe(prereg.id);
		expect(outcome.runId).toBe("run-1");
		expect(outcome.verdict).toBe("kept");
		expect(outcome.metricValues).toEqual({ accuracy: "0.92" });
	});

	it("throws PreregNotFoundError for an outcome against an unregistered prereg id", () => {
		const dataDir = makeDataDir();
		expect(() =>
			recordPreregOutcome(dataDir, { preregId: "nope", runId: "run-1", metricValues: {}, verdict: "kept" }),
		).toThrow(PreregNotFoundError);
	});

	it("rejects an invalid verdict", () => {
		const dataDir = makeDataDir();
		const prereg = registerPrereg(dataDir, { hypothesis: "x", metrics: [metric] });
		expect(() =>
			recordPreregOutcome(dataDir, {
				preregId: prereg.id,
				runId: "run-1",
				metricValues: {},
				verdict: "maybe" as never,
			}),
		).toThrow(PreregValidationError);
	});

	it("journals a 'prereg' phase entry on outcome recording", () => {
		const dataDir = makeDataDir();
		const prereg = registerPrereg(dataDir, { hypothesis: "x", metrics: [metric] });
		recordPreregOutcome(dataDir, {
			preregId: prereg.id,
			runId: "run-1",
			metricValues: { accuracy: "0.5" },
			verdict: "discarded",
		});

		const entries = openJournal(dataDir).entries();
		const outcomeNotes = entries.filter((e) => e.phase === "prereg" && e.text.includes("Outcome"));
		expect(outcomeNotes).toHaveLength(1);
		expect(outcomeNotes[0].text).toContain("discarded");
	});

	it("outcomes are replayable and attach only to the exact prereg id they were recorded against", () => {
		const dataDir = makeDataDir();
		const v1 = registerPrereg(dataDir, { hypothesis: "v1", metrics: [metric] });
		const v2 = registerPrereg(dataDir, { hypothesis: "v2", metrics: [metric], amends: v1.id });

		recordPreregOutcome(dataDir, {
			preregId: v1.id,
			runId: "run-1",
			metricValues: { accuracy: "0.5" },
			verdict: "discarded",
		});
		recordPreregOutcome(dataDir, {
			preregId: v2.id,
			runId: "run-2",
			metricValues: { accuracy: "0.95" },
			verdict: "kept",
		});

		const views = listPreregs(dataDir);
		const v1View = views.find((v) => v.id === v1.id);
		const v2View = views.find((v) => v.id === v2.id);

		expect(v1View?.outcomes).toHaveLength(1);
		expect(v1View?.outcomes[0].runId).toBe("run-1");
		expect(v2View?.outcomes).toHaveLength(1);
		expect(v2View?.outcomes[0].runId).toBe("run-2");
	});

	it("multiple outcomes against the same prereg id all accumulate, in order", () => {
		const dataDir = makeDataDir();
		const prereg = registerPrereg(dataDir, { hypothesis: "x", metrics: [metric] });
		recordPreregOutcome(dataDir, { preregId: prereg.id, runId: "run-1", metricValues: {}, verdict: "discarded" });
		recordPreregOutcome(dataDir, { preregId: prereg.id, runId: "run-2", metricValues: {}, verdict: "kept" });

		const [view] = listPreregs(dataDir);
		expect(view.outcomes.map((o) => o.runId)).toEqual(["run-1", "run-2"]);
	});
});

describe("listPreregs", () => {
	it("returns an empty array when prereg.jsonl does not exist yet", () => {
		const dataDir = makeDataDir();
		expect(listPreregs(dataDir)).toEqual([]);
	});

	it("returns entries in registration order", () => {
		const dataDir = makeDataDir();
		registerPrereg(dataDir, { hypothesis: "first", metrics: [metric] });
		registerPrereg(dataDir, { hypothesis: "second", metrics: [metric] });

		const views = listPreregs(dataDir);
		expect(views.map((v) => v.hypothesis)).toEqual(["first", "second"]);
	});
});
