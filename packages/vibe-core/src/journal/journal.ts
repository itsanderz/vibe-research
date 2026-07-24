import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One line of `journal.jsonl` — the machine-replayable mirror of an entry
 * also written to `journal.md`. `phase` is intentionally a free-form string
 * ("formalize", "explore", "attack", "surprise", "decision", ...) rather
 * than a closed set: PLAN.md's "live research journal" is meant to capture
 * whatever the investigation is actually doing, not just the six named
 * phases in the v0 spec.
 */
export interface JournalEntry {
	at: string;
	phase: string;
	text: string;
}

export interface Journal {
	/** Appends one entry to both `journal.md` (human-readable) and
	 * `journal.jsonl` (machine-replayable). Returns the entry that was
	 * written, including its timestamp. */
	note(phase: string, text: string): JournalEntry;
	/** Replays every entry recorded so far, in the order they were written,
	 * by reading and parsing `journal.jsonl`. */
	entries(): JournalEntry[];
}

function loadEntries(jsonlPath: string): JournalEntry[] {
	const contents = readFileSync(jsonlPath, "utf8");
	const entries: JournalEntry[] = [];
	for (const line of contents.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		entries.push(JSON.parse(trimmed) as JournalEntry);
	}
	return entries;
}

/**
 * Opens (creating if necessary) the live research journal at
 * `<workspaceDir>/journal.md` and `<workspaceDir>/journal.jsonl`, per
 * PLAN.md's observability decision: "continuous plain-language narrative of
 * hypothesis/experiment/surprise/next-move, `tail`-able, doubles as
 * shareable artifact." Both files are append-only — `note()` never rewrites
 * bytes already written, only appends new ones — so an investigation in
 * progress can be tailed safely and a crash never corrupts prior entries.
 */
export function openJournal(workspaceDir: string): Journal {
	if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true });
	const markdownPath = join(workspaceDir, "journal.md");
	const jsonlPath = join(workspaceDir, "journal.jsonl");
	if (!existsSync(markdownPath)) writeFileSync(markdownPath, "");
	if (!existsSync(jsonlPath)) writeFileSync(jsonlPath, "");

	return {
		note(phase, text) {
			const at = new Date().toISOString();
			const entry: JournalEntry = { at, phase, text };
			appendFileSync(markdownPath, `\n## [${at}] ${phase}\n\n${text}\n`);
			appendFileSync(jsonlPath, `${JSON.stringify(entry)}\n`);
			return entry;
		},

		entries() {
			return loadEntries(jsonlPath);
		},
	};
}
