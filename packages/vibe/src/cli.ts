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

process.title = "vibe";
// Matches upstream cli.ts / rpc-entry.ts: lets child processes (e.g. the bash
// tool) detect they are running inside a pi-derived agent. Not set
// automatically for SDK embedding, so the wrapper sets it explicitly.
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

const here = dirname(fileURLToPath(import.meta.url));

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
const bundledArgs = [
	"-e",
	join(here, "extensions", "research.js"),
	"--skill",
	join(here, "skills", "vibe-mathing"),
	"--prompt-template",
	join(here, "prompts", "investigate.md"),
];

await main([...bundledArgs, ...process.argv.slice(2)]);
