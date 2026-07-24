import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runExperiment, wslAvailable } from "../src/runs/runner.ts";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "vibe-core-runner-"));
}

// Computed once at collection time so `it.skipIf` can gate on it — CI
// without WSL stays green, and on a machine with WSL Ubuntu + python3 these
// actually execute (per repo convention, see AGENTS.md / CLAUDE.md §7).
const haveWsl = wslAvailable();

describe("runExperiment — WSL integration", () => {
	it.skipIf(!haveWsl)(
		"runs a trivial print experiment: exit 0, stdout captured, all artifacts saved",
		async () => {
			const dir = makeTempDir();
			const code = "print('hello from vibe-core')\n";
			const result = await runExperiment(dir, { code, purpose: "smoke-test stdout capture" });

			expect(result.exitCode).toBe(0);
			expect(result.timedOut).toBe(false);
			expect(result.stdoutTruncated).toBe(false);
			expect(result.stderrTruncated).toBe(false);

			const savedCode = readFileSync(join(result.artifactDir, "experiment.py"), "utf8");
			expect(savedCode).toBe(code);

			const savedPurpose = readFileSync(join(result.artifactDir, "purpose.txt"), "utf8");
			expect(savedPurpose).toBe("smoke-test stdout capture");

			const stdout = readFileSync(join(result.artifactDir, "stdout.txt"), "utf8");
			expect(stdout).toContain("hello from vibe-core");

			const savedResult = JSON.parse(readFileSync(join(result.artifactDir, "result.json"), "utf8"));
			expect(savedResult).toMatchObject({
				runId: result.runId,
				purpose: "smoke-test stdout capture",
				exitCode: 0,
				timedOut: false,
			});
		},
		30_000,
	);

	it.skipIf(!haveWsl)(
		"records a nonzero exit and stderr as data, without throwing",
		async () => {
			const dir = makeTempDir();
			const code = "import sys\nprint('failing on purpose', file=sys.stderr)\nsys.exit(3)\n";
			const result = await runExperiment(dir, {
				code,
				purpose: "check nonzero exit is data, not an exception",
			});

			expect(result.exitCode).toBe(3);
			expect(result.timedOut).toBe(false);

			const stderr = readFileSync(join(result.artifactDir, "stderr.txt"), "utf8");
			expect(stderr).toContain("failing on purpose");

			const savedResult = JSON.parse(readFileSync(join(result.artifactDir, "result.json"), "utf8"));
			expect(savedResult.exitCode).toBe(3);
		},
		30_000,
	);

	it.skipIf(!haveWsl)(
		"kills a run that exceeds its timeout and still saves artifacts",
		async () => {
			const dir = makeTempDir();
			// Sleeps well past the wrapped Linux `timeout` deadline
			// (timeoutSeconds + 5 = 6s here), not just past timeoutSeconds
			// itself. This means the run can only actually terminate promptly
			// via the in-distro `timeout` wrapper — a Windows-side taskkill
			// that silently failed to reach the Linux-side process (the M1
			// bug this wrapper fixes; see LEARNINGS.md) would otherwise leave
			// this hanging until the full 12s sleep completes, which the
			// duration assertion below would catch.
			const code = "import time\ntime.sleep(12)\nprint('should not get here')\n";
			const started = Date.now();
			const result = await runExperiment(dir, {
				code,
				purpose: "check timeout handling",
				timeoutSeconds: 1,
			});
			const elapsedMs = Date.now() - started;

			expect(result.timedOut).toBe(true);
			// Must resolve well before the 12s sleep would complete on its
			// own — proves the Linux-side `timeout` (deadline: 6s) actually
			// killed the process rather than the run hanging until the
			// script naturally exits.
			expect(elapsedMs).toBeLessThan(10_000);

			const savedCode = readFileSync(join(result.artifactDir, "experiment.py"), "utf8");
			expect(savedCode).toBe(code);
			const savedPurpose = readFileSync(join(result.artifactDir, "purpose.txt"), "utf8");
			expect(savedPurpose).toBe("check timeout handling");

			const savedResult = JSON.parse(readFileSync(join(result.artifactDir, "result.json"), "utf8"));
			expect(savedResult.timedOut).toBe(true);
			// pythonCommand documents the actual invocation, including the
			// in-distro timeout wrapper (timeoutSeconds=1 + 5s grace = 6s).
			expect(savedResult.pythonCommand).toContain("timeout 6s");
		},
		20_000,
	);
});

describe("wslAvailable", () => {
	it("returns a boolean", () => {
		expect(typeof wslAvailable()).toBe("boolean");
	});

	it("returns false for a distro that does not exist", () => {
		expect(wslAvailable({ distro: "definitely-not-a-real-distro-xyz" })).toBe(false);
	});
});
