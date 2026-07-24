#!/usr/bin/env node
/**
 * vibe CLI entry point.
 *
 * Thin wrapper around @earendil-works/pi-coding-agent's programmatic SDK
 * entry (`main`). vibe-research is a fork of earendil-works/pi; this package
 * gives the fork its own `vibe` binary without modifying the upstream
 * coding-agent package. See https://github.com/earendil-works/pi for the
 * project this is built on.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "@earendil-works/pi-coding-agent";
import { createSigintHandler, type IterationProgress, runLoop } from "vibe-core";
import { runSession } from "./loop-session.ts";

process.title = "vibe";
// Matches upstream cli.ts / rpc-entry.ts: lets child processes (e.g. the bash
// tool) detect they are running inside a pi-derived agent. Not set
// automatically for SDK embedding, so the wrapper sets it explicitly.
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * vibe M2 slice 1: `vibe run "<problem>"` / `vibe run --resume [--force]`
 * drive the autonomous loop (packages/vibe-core/src/loop/controller.ts)
 * instead of the interactive TUI. Intercepted before the pi-coding-agent
 * `main()` passthrough below — everything else (including a project that
 * happens to have a file literally named "run") passes through unchanged.
 * Workspace is always the current working directory, matching every other
 * `vibe`/`pi` invocation.
 */
async function runVibeRun(args: string[]): Promise<void> {
	const resume = args.includes("--resume");
	const force = args.includes("--force");
	const problem = args
		.filter((arg) => arg !== "--resume" && arg !== "--force")
		.join(" ")
		.trim();

	if (!resume && problem.length === 0) {
		console.error('Usage: vibe run "<problem>"');
		console.error("       vibe run --resume [--force]");
		process.exitCode = 1;
		return;
	}

	const workspaceDir = process.cwd();

	const onIteration = (progress: IterationProgress) => {
		const errSuffix = progress.error ? ` — session error: ${progress.error}` : "";
		console.log(
			`[vibe run] iteration ${progress.iteration}: +${progress.tokensSpentThisIteration} tokens ` +
				`(${progress.totalTokensSpent} total)${errSuffix}`,
		);
	};
	const onStop = (info: { reason: string; detail?: string }) => {
		console.log(`[vibe run] stopping: ${info.reason}${info.detail ? ` — ${info.detail}` : ""}`);
	};

	/**
	 * SIGINT handling (M2s3, spec "Resume & stop"): first Ctrl+C lets the
	 * current iteration finish, then the controller's own `deps.interrupted`
	 * check stops the loop cleanly with USER_INTERRUPT (checkpoint, journal,
	 * dossier all still run — see controller.ts). Second Ctrl+C is the ONE
	 * acceptable place in this codebase for a raw `process.exit()`: the M2s1
	 * learning is that calling it while a pi SDK session may still be closing
	 * async handles crashes on Windows (UV_HANDLE_CLOSING), but by the second
	 * signal the user has explicitly asked to not wait for a graceful unwind.
	 * Exit code 130 = 128 + SIGINT, the conventional shell convention.
	 */
	const sigint = createSigintHandler({
		onFirstInterrupt: () => {
			console.log(
				"[vibe run] interrupt received — finishing the current iteration, then stopping (Ctrl+C again to force-exit)...",
			);
		},
		onForceExit: () => {
			console.log("[vibe run] second interrupt — force exiting now.");
			process.exit(130);
		},
	});
	const handleSigint = () => sigint.handleSignal();
	process.on("SIGINT", handleSigint);

	try {
		const result = await runLoop(
			workspaceDir,
			resume ? undefined : problem,
			{ runSession, onIteration, onStop, interrupted: () => sigint.interrupted() },
			{ resume, force },
		);
		console.log(
			`[vibe run] done — ${result.iterations} iteration(s), ${result.tokensSpent} tokens, stop reason: ${result.stopReason}` +
				(result.stopDetail ? ` (${result.stopDetail})` : ""),
		);
		console.log(`[vibe run] dossier: ${result.dossierPath}`);
	} catch (error) {
		console.error(`[vibe run] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	} finally {
		process.off("SIGINT", handleSigint);
	}
}

const cliArgs = process.argv.slice(2);

if (cliArgs[0] === "run") {
	// Let Node exit naturally once the event loop drains (process.exitCode, set
	// above on error, is honored either way) instead of calling process.exit()
	// here — an explicit exit() raced a libuv async handle close on Windows
	// during manual testing (native "UV_HANDLE_CLOSING" assertion after all
	// intended output had already printed).
	await runVibeRun(cliArgs.slice(1));
} else {
	await runRestOfCli();
}

/**
 * vibe M1 slice 3: bundle the research tool extension, the vibe-mathing
 * skill, and the /investigate prompt template so they're available by
 * default from a fresh clone/install, with no per-project setup.
 *
 * These are injected as explicit `-e` / `--skill` / `--prompt-template`
 * flags rather than relying solely on the `pi` manifest key in this
 * package's own package.json. Investigated both routes
 * (packages/coding-agent/src/core/extensions/loader.ts
 * resolveExtensionEntries/readPiManifest, docs/packages.md): the `pi`
 * manifest is only read when a directory carrying it is itself passed as a
 * *configured* extension/skill/prompt-template path — it is never
 * auto-discovered from the currently-running binary's own package.json. So
 * the pi-key route would still need an explicit path pointing back at this
 * package to do anything, which is exactly what direct CLI-flag injection
 * does more simply. `--no-extensions`/`--no-skills`/`--no-prompt-templates`
 * only disable *discovery* — additional/explicit paths (this mechanism) are
 * a separate, always-applied input (see src/main.ts: additionalExtensionPaths
 * /additionalSkillPaths/additionalPromptTemplatePaths vs. the no* flags), so
 * a user who opts out of scanning their own project still gets these.
 *
 * Paths are resolved relative to this compiled module (dist/cli.js) so the
 * wrapper works regardless of the caller's cwd or how `vibe` was installed.
 * The build script (see package.json) copies skills/vibe-mathing and
 * src/prompts into dist/ alongside the compiled extension.
 */
async function runRestOfCli(): Promise<void> {
	const bundledArgs = [
		"-e",
		join(here, "extensions", "research.js"),
		"--skill",
		join(here, "skills", "vibe-mathing"),
		"--prompt-template",
		join(here, "prompts", "investigate.md"),
	];

	await main([...bundledArgs, ...process.argv.slice(2)]);
}
