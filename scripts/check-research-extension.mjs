#!/usr/bin/env node
/**
 * Headless proof that packages/vibe's research extension
 * (packages/vibe/src/extensions/research.ts, compiled to dist/extensions/research.js)
 * registers exactly the 6 expected tools, and that those tools' execute()
 * functions actually create/append the expected workspace files — without
 * spinning up a real pi session or burning any API tokens.
 *
 * Run after `npm run build` in packages/vibe (or the root build):
 *   node scripts/check-research-extension.mjs
 *
 * Exits non-zero (and prints why) on any assertion failure.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const extensionPath = join(repoRoot, "packages", "vibe", "dist", "extensions", "research.js");

if (!existsSync(extensionPath)) {
	console.error(`Not built: ${extensionPath}\nRun "npm run build" in packages/vibe first.`);
	process.exit(1);
}

const mod = await import(pathToFileURL(extensionPath).href);
const registerExtension = mod.default;
assert.equal(typeof registerExtension, "function", "default export must be the extension factory function");

// --- 1. Registration proof -------------------------------------------------
const registered = [];
const mockApi = {
	registerTool(tool) {
		registered.push(tool);
	},
};

registerExtension(mockApi);

const EXPECTED_TOOL_NAMES = [
	"math_record_claim",
	"math_update_claim",
	"math_list_claims",
	"math_run_python",
	"journal_note",
	"math_generate_dossier",
];

const registeredNames = registered.map((t) => t.name);
assert.deepEqual(
	[...registeredNames].sort(),
	[...EXPECTED_TOOL_NAMES].sort(),
	`expected exactly the 6 research tools, got: ${registeredNames.join(", ")}`,
);

for (const tool of registered) {
	assert.ok(tool.description && tool.description.length > 20, `${tool.name}: description missing/too short`);
	assert.equal(typeof tool.execute, "function", `${tool.name}: execute must be a function`);
	assert.ok(tool.parameters, `${tool.name}: parameters schema missing`);
}
console.log(`OK  registration: ${registeredNames.join(", ")}`);

// --- 2. Execution proof: claims.jsonl + journal files actually appear ------
const tmpCwd = mkdtempSync(join(tmpdir(), "vibe-research-check-"));
const ctx = { cwd: tmpCwd };
const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

const noop = () => {};

const recordResult = await byName.math_record_claim.execute(
	"call-1",
	{ statement: "For all n, n + 0 = n.", assumptions: ["n is an integer"] },
	undefined,
	noop,
	ctx,
);
const claimId = recordResult.details.claim.id;
assert.equal(recordResult.details.claim.status, "UNTESTED");
console.log(`OK  math_record_claim -> ${claimId}`);

const listResult1 = await byName.math_list_claims.execute("call-2", {}, undefined, noop, ctx);
assert.equal(listResult1.details.claims.length, 1);
console.log("OK  math_list_claims (1 claim)");

const updateResult = await byName.math_update_claim.execute(
	"call-3",
	{
		id: claimId,
		status: "TESTED_SMALL_CASES",
		evidence: ["method=inspection; scope=n in [-10,10]; arithmetic=exact integer; result=holds"],
	},
	undefined,
	noop,
	ctx,
);
assert.equal(updateResult.details.claim.status, "TESTED_SMALL_CASES");
console.log("OK  math_update_claim -> TESTED_SMALL_CASES");

// Illegal transition must surface as a thrown error (isError path), not a crash.
let threw = false;
try {
	await byName.math_update_claim.execute(
		"call-4",
		{ id: claimId, status: "UNTESTED", evidence: ["should be rejected"] },
		undefined,
		noop,
		ctx,
	);
} catch (err) {
	threw = true;
	assert.ok(err instanceof Error && err.message.length > 0, "TransitionError should be a normal Error with a message");
}
assert.ok(threw, "illegal transition (weakening status) must throw, not silently succeed");
console.log("OK  math_update_claim rejects illegal (weakening) transition via throw");

const journalResult = await byName.journal_note.execute(
	"call-5",
	{ phase: "verify", text: "Confirmed via headless check script." },
	undefined,
	noop,
	ctx,
);
assert.ok(journalResult.details.entry.at);
console.log("OK  journal_note");

const claimsPath = join(tmpCwd, "workspace", "claims.jsonl");
const journalMdPath = join(tmpCwd, "workspace", "journal.md");
const journalJsonlPath = join(tmpCwd, "workspace", "journal.jsonl");

assert.ok(existsSync(claimsPath), `expected ${claimsPath} to exist`);
assert.ok(existsSync(journalMdPath), `expected ${journalMdPath} to exist`);
assert.ok(existsSync(journalJsonlPath), `expected ${journalJsonlPath} to exist`);

const claimsLines = readFileSync(claimsPath, "utf8").trim().split("\n");
assert.ok(claimsLines.length >= 2, "claims.jsonl should have a record + update event");
const journalText = readFileSync(journalMdPath, "utf8");
assert.ok(journalText.includes("Confirmed via headless check script."), "journal.md should contain the note text");

console.log(`OK  workspace files created under ${join(tmpCwd, "workspace")}`);
console.log(`    - ${claimsPath} (${claimsLines.length} events)`);
console.log(`    - ${journalMdPath}`);
console.log(`    - ${journalJsonlPath}`);

// math_run_python needs real WSL; only run it if available, so this script
// stays fast/deterministic in environments without WSL (e.g. plain CI).
let wslAvailable = false;
try {
	const runnerMod = await import(pathToFileURL(join(repoRoot, "packages", "vibe-core", "dist", "runs", "runner.js")).href);
	wslAvailable = runnerMod.wslAvailable();
} catch {
	// vibe-core not built at this path, or check itself failed — treat as unavailable.
}

if (wslAvailable) {
	const runResult = await byName.math_run_python.execute(
		"call-6",
		{ code: "print(1 + 1)\n", purpose: "headless check: confirm math_run_python executes", timeout_seconds: 15 },
		undefined,
		noop,
		ctx,
	);
	assert.equal(runResult.details.exitCode, 0);
	assert.ok(runResult.content[0].text.includes("runId:"));
	console.log(`OK  math_run_python (exitCode=0, runId=${runResult.details.runId})`);
} else {
	console.log("SKIP math_run_python (WSL not available in this environment)");
}

// --- 3. math_generate_dossier: renders workspace/dossier.md ----------------
const dossierResult = await byName.math_generate_dossier.execute(
	"call-7",
	{ title: "Headless check dossier" },
	undefined,
	noop,
	ctx,
);
const dossierPath = join(tmpCwd, "workspace", "dossier.md");
assert.ok(existsSync(dossierPath), `expected ${dossierPath} to exist`);
assert.equal(dossierResult.details.path, dossierPath);
assert.ok(Array.isArray(dossierResult.details.violations), "math_generate_dossier details.violations must be an array");

const dossierText = readFileSync(dossierPath, "utf8");
assert.ok(dossierText.startsWith("# Headless check dossier\n"), "dossier.md should use the given title as its H1");
assert.ok(dossierText.includes("Confirmed via headless check script."), "dossier.md should include the journal narrative verbatim");
assert.ok(dossierText.includes("## Claims & evidence"), "dossier.md should have a Claims & evidence section");
console.log(`OK  math_generate_dossier -> ${dossierPath} (${dossierResult.details.violations.length} violation(s))`);

rmSync(tmpCwd, { recursive: true, force: true });
console.log("\nAll checks passed.");
