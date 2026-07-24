import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Inputs to one experiment run — spec §9.1. */
export interface RunExperimentOptions {
	/** A complete, self-contained Python program (spec §9.1). Saved verbatim
	 * to `experiment.py` before execution. */
	code: string;
	/** The exact question this run is intended to answer (spec §9.1). Saved
	 * verbatim to `purpose.txt` before execution. */
	purpose: string;
	/** Wall-clock budget in seconds. Defaults to 60; clamped to [1, 600]
	 * regardless of what is passed (spec §9.1 discusses 1-60s for the tool
	 * contract, but the harness itself allows longer bounded runs). */
	timeoutSeconds?: number;
}

/** Which WSL distro and Python binary to run experiments through. */
export interface RunnerOptions {
	distro?: string;
	pythonBin?: string;
}

/**
 * The exact shape written to `result.json` (spec §10). Kept small and
 * flat on purpose — stdout/stderr are saved as sibling `.txt` files instead
 * of being embedded here.
 */
export interface ResultMetadata {
	runId: string;
	purpose: string;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	createdAt: string;
	pythonCommand: string;
}

/** `ResultMetadata` plus the absolute artifact directory it was written into. */
export interface RunResult extends ResultMetadata {
	artifactDir: string;
}

const DEFAULT_TIMEOUT_SECONDS = 60;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 600;

/** Per-stream capture cap (spec §9.1: "captured stdout and stderr"). Applied
 * independently to stdout and stderr. */
const MAX_CAPTURE_BYTES = 1024 * 1024;

const DEFAULT_DISTRO = "Ubuntu";
const DEFAULT_PYTHON_BIN = "python3";

/**
 * Converts an absolute Windows path (e.g. `C:\foo\bar baz`) to the
 * equivalent WSL mount path (`/mnt/c/foo/bar baz`) used to reach it from
 * inside the distro. The drive letter is lowercased (WSL mounts drives
 * lowercase); backslashes become forward slashes. Spaces are left as
 * literal spaces in the returned string — callers must pass the result as
 * one argv element (via `execFile`/`spawn`'s args array), never concatenate
 * it into a shell command string.
 */
export function toWslPath(windowsPath: string): string {
	const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
	if (!match) {
		throw new Error(
			`toWslPath: expected an absolute Windows path with a drive letter, got ${JSON.stringify(windowsPath)}`,
		);
	}
	const [, drive, rest] = match;
	return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, "/")}`;
}

function clampTimeoutSeconds(timeoutSeconds: number | undefined): number {
	const requested = timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
	return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, requested));
}

function formatUtcTimestamp(date: Date): string {
	const pad = (value: number, width = 2) => value.toString().padStart(width, "0");
	const datePart = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
	const timePart = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${pad(date.getUTCMilliseconds(), 3)}`;
	return `${datePart}T${timePart}`;
}

/** run-id = UTC timestamp (YYYYMMDDTHHMMSSmmm) + "-" + 6-char content hash
 * of the experiment code (spec §10). The hash makes two runs of the same
 * code at different times distinguishable from each other's artifacts at a
 * glance, and makes accidental id collisions vanishingly unlikely even at
 * millisecond timestamp resolution. */
function generateRunId(code: string, now: Date): string {
	const hash = createHash("sha256").update(code, "utf8").digest("hex").slice(0, 6);
	return `${formatUtcTimestamp(now)}-${hash}`;
}

/**
 * Best-effort kill of a Windows process and its descendants by pid. A
 * process that has already exited (or `taskkill` itself being unavailable)
 * is not treated as an error — this is cleanup on a timeout path, not a
 * step whose success the caller depends on for correctness.
 *
 * Known limitation: this reaches the Windows-side `wsl.exe` client process
 * tree. A command already handed off to the WSL instance is not always
 * guaranteed to be killed by terminating its Windows-side client (a known
 * WSL interop limitation) — reaching into the distro to kill the Linux-side
 * process would need a distro-side `pkill`, which spec §9.1 does not ask
 * the harness to do.
 */
function killProcessTree(pid: number): void {
	try {
		execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
	} catch {
		// Already exited, or taskkill unavailable — best-effort only.
	}
}

function createByteCappedCollector(maxBytes: number) {
	const chunks: Buffer[] = [];
	let total = 0;
	let truncated = false;
	return {
		onData(chunk: Buffer): void {
			if (total >= maxBytes) {
				truncated = true;
				return;
			}
			const remaining = maxBytes - total;
			if (chunk.length <= remaining) {
				chunks.push(chunk);
				total += chunk.length;
			} else {
				chunks.push(chunk.subarray(0, remaining));
				total += remaining;
				truncated = true;
			}
		},
		finish(): { text: string; truncated: boolean } {
			return { text: Buffer.concat(chunks).toString("utf8"), truncated };
		},
	};
}

/**
 * Harness-level probe: is `wsl.exe -d <distro> -- <pythonBin> --version`
 * actually runnable right now? Synchronous so it can gate test collection
 * directly (`it.skipIf(!wslAvailable())`) without top-level await. Checks
 * real usability (distro exists, python launches), not merely that
 * `wsl.exe` is on PATH.
 */
export function wslAvailable(opts: RunnerOptions = {}): boolean {
	const distro = opts.distro ?? DEFAULT_DISTRO;
	const pythonBin = opts.pythonBin ?? DEFAULT_PYTHON_BIN;
	try {
		execFileSync("wsl.exe", ["-d", distro, "--", pythonBin, "--version"], {
			stdio: "ignore",
			timeout: 10_000,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Runs one reproducible Python experiment inside WSL2 — spec §9.1 / §10.
 *
 * Writes `experiment.py` and `purpose.txt` into a fresh
 * `<workspaceDir>/runs/<run-id>/` directory *before* executing, so a
 * crashed or timed-out run still leaves its artifacts behind. Execution is
 * launched via `wsl.exe -d <distro> -- <pythonBin> <wslPath>` using an argv
 * array (`child_process.spawn`), never shell-string interpolation, so paths
 * containing spaces are handled correctly and no shell metacharacter in
 * `code` or `purpose` can affect the invocation.
 *
 * A failed or timed-out run is *data*, not an exception (spec §9.1): a
 * non-zero exit code, stderr output, or a timeout are all recorded in the
 * returned `RunResult` / `result.json` for the caller to reason about.
 * This function only throws on harness-level failures — the workspace
 * directory cannot be created, or `wsl.exe` cannot be spawned at all (e.g.
 * WSL not installed).
 */
export async function runExperiment(
	workspaceDir: string,
	options: RunExperimentOptions,
	runnerOptions: RunnerOptions = {},
): Promise<RunResult> {
	const distro = runnerOptions.distro ?? DEFAULT_DISTRO;
	const pythonBin = runnerOptions.pythonBin ?? DEFAULT_PYTHON_BIN;
	const timeoutSeconds = clampTimeoutSeconds(options.timeoutSeconds);

	const now = new Date();
	const runId = generateRunId(options.code, now);
	const artifactDir = join(resolve(workspaceDir), "runs", runId);
	mkdirSync(artifactDir, { recursive: true });

	const scriptPath = join(artifactDir, "experiment.py");
	writeFileSync(scriptPath, options.code);
	writeFileSync(join(artifactDir, "purpose.txt"), options.purpose);

	const wslScriptPath = toWslPath(scriptPath);
	const pythonCommand = `wsl.exe -d ${distro} -- ${pythonBin} ${wslScriptPath}`;

	const stdoutCollector = createByteCappedCollector(MAX_CAPTURE_BYTES);
	const stderrCollector = createByteCappedCollector(MAX_CAPTURE_BYTES);

	const started = process.hrtime.bigint();
	const { exitCode, timedOut } = await new Promise<{ exitCode: number | null; timedOut: boolean }>(
		(settlePromise, rejectPromise) => {
			const child = spawn("wsl.exe", ["-d", distro, "--", pythonBin, wslScriptPath], {
				stdio: ["ignore", "pipe", "pipe"],
			});

			let settled = false;
			let didTimeOut = false;
			const timer = setTimeout(() => {
				didTimeOut = true;
				if (child.pid !== undefined) killProcessTree(child.pid);
			}, timeoutSeconds * 1000);

			child.stdout?.on("data", (chunk: Buffer) => stdoutCollector.onData(chunk));
			child.stderr?.on("data", (chunk: Buffer) => stderrCollector.onData(chunk));

			child.once("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				rejectPromise(err);
			});

			child.once("close", (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				settlePromise({ exitCode: didTimeOut ? null : code, timedOut: didTimeOut });
			});
		},
	);
	const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);

	const { text: stdout, truncated: stdoutTruncated } = stdoutCollector.finish();
	const { text: stderr, truncated: stderrTruncated } = stderrCollector.finish();

	const metadata: ResultMetadata = {
		runId,
		purpose: options.purpose,
		exitCode,
		timedOut,
		durationMs,
		stdoutTruncated,
		stderrTruncated,
		createdAt: now.toISOString(),
		pythonCommand,
	};

	writeFileSync(join(artifactDir, "result.json"), `${JSON.stringify(metadata, null, 2)}\n`);
	writeFileSync(join(artifactDir, "stdout.txt"), stdout);
	writeFileSync(join(artifactDir, "stderr.txt"), stderr);

	return { ...metadata, artifactDir };
}
