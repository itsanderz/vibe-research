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
import { main } from "@earendil-works/pi-coding-agent";

process.title = "vibe";
// Matches upstream cli.ts / rpc-entry.ts: lets child processes (e.g. the bash
// tool) detect they are running inside a pi-derived agent. Not set
// automatically for SDK embedding, so the wrapper sets it explicitly.
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

await main(process.argv.slice(2));
