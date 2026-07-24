import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openJournal } from "../src/journal/journal.ts";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "vibe-core-journal-"));
}

describe("openJournal — note() and entries()", () => {
	it("appends multiple notes; markdown contains both, JSONL replay matches entries()", () => {
		const dir = makeTempDir();
		const journal = openJournal(dir);

		journal.note("formalize", "Stated the main claim precisely.");
		journal.note("attack", "Tried n = -1..30, no counterexample yet.");

		const markdown = readFileSync(join(dir, "journal.md"), "utf8");
		expect(markdown).toContain("formalize");
		expect(markdown).toContain("Stated the main claim precisely.");
		expect(markdown).toContain("attack");
		expect(markdown).toContain("Tried n = -1..30, no counterexample yet.");
		// Human-readable entries are markdown H2 sections with an ISO timestamp.
		expect(markdown).toMatch(/## \[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] formalize/);

		const entries = journal.entries();
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ phase: "formalize", text: "Stated the main claim precisely." });
		expect(entries[1]).toMatchObject({ phase: "attack", text: "Tried n = -1..30, no counterexample yet." });
		expect(entries[0].at <= entries[1].at).toBe(true);
	});

	it("note() return value matches the entry later read back by entries()", () => {
		const dir = makeTempDir();
		const journal = openJournal(dir);

		const written = journal.note("decision", "Moving to the check phase.");
		const [replayed] = journal.entries();

		expect(replayed).toEqual(written);
	});
});

describe("openJournal — append-only file", () => {
	it("earlier bytes in journal.md and journal.jsonl are never rewritten", () => {
		const dir = makeTempDir();
		const journal = openJournal(dir);

		journal.note("formalize", "first note");
		const markdownAfterFirst = readFileSync(join(dir, "journal.md"), "utf8");
		const jsonlAfterFirst = readFileSync(join(dir, "journal.jsonl"), "utf8");

		journal.note("explore", "second note");
		const markdownAfterSecond = readFileSync(join(dir, "journal.md"), "utf8");
		const jsonlAfterSecond = readFileSync(join(dir, "journal.jsonl"), "utf8");

		expect(markdownAfterSecond.startsWith(markdownAfterFirst)).toBe(true);
		expect(jsonlAfterSecond.startsWith(jsonlAfterFirst)).toBe(true);
		expect(markdownAfterSecond.length).toBeGreaterThan(markdownAfterFirst.length);
		expect(jsonlAfterSecond.length).toBeGreaterThan(jsonlAfterFirst.length);
	});
});

describe("openJournal — reopening replays state", () => {
	it("a fresh openJournal() over the same directory reproduces entries()", () => {
		const dir = makeTempDir();
		const journal = openJournal(dir);
		journal.note("formalize", "note one");
		journal.note("decision", "note two");

		const reopened = openJournal(dir);
		expect(reopened.entries()).toEqual(journal.entries());
	});
});
