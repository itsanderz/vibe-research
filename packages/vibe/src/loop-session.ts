/**
 * Real session runner for `vibe run` — vibe M2 slice 1.
 *
 * Spec: docs/research/loop-design.md "act" step — the loop controller
 * (packages/vibe-core/src/loop/controller.ts) spawns one fresh,
 * non-interactive agent session per iteration via pi's SDK. This module is
 * the LoopDeps.runSession implementation used by `vibe run` (wired in
 * cli.ts); tests fake this function entirely, so it is never imported by
 * packages/vibe-core's test suite.
 *
 * `cwd` is set to `context.workspaceDir` — the same directory the loop
 * controller checkpoints under — so the research extension's tools
 * (`join(ctx.cwd, "workspace")`, see extensions/research.ts) read and write
 * the exact ledger/journal/dossier files the controller journals from.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	classifyProviderError,
	type RunSessionContext,
	type RunSessionFn,
	type RunSessionResult,
	type RunSessionUsage,
} from "vibe-core";
import { createResearchExtension } from "./extensions/research.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** Same bundling convention as cli.ts's bundledArgs: resolved relative to this compiled module so it works regardless of install location. */
const skillPath = join(here, "skills", "vibe-mathing");

const ZERO_USAGE: RunSessionUsage = { input: 0, output: 0, total: 0 };

/**
 * The model/auth catalog is expensive to build (reads auth.json/models.json
 * from disk); reuse one ModelRuntime across every iteration of a single
 * `vibe run` process instead of rebuilding it per session.
 */
let cachedModelRuntime: ModelRuntime | undefined;

async function getModelRuntime(): Promise<ModelRuntime> {
	if (!cachedModelRuntime) {
		cachedModelRuntime = await ModelRuntime.create();
	}
	return cachedModelRuntime;
}

function extractText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/**
 * Runs one non-interactive agent session for `objective` and reports its
 * usage/outcome back to the loop controller.
 *
 * SDK APIs used (all from `@earendil-works/pi-coding-agent` unless noted):
 * - `resolveCliModel({ cliModel, modelRuntime })` — turns the config's
 *   `"provider/model"` string (e.g. "openrouter/anthropic/claude-sonnet-5")
 *   into a `Model`. A `resolved.error` (bad model string, no auth) is
 *   returned as `RunSessionResult.error` rather than thrown, so the
 *   controller's two-strike logic can see it.
 * - `DefaultResourceLoader` with `extensionFactories: [createResearchExtension({ role: context.role })]`
 *   and `additionalSkillPaths: [<bundled vibe-mathing skill>]` — the
 *   programmatic equivalent of cli.ts's `-e`/`--skill` flags. `context.role`
 *   ("reasoner" | "checker", set by the loop controller per iteration — see
 *   packages/vibe-core/src/loop/controller.ts) is how the loop's role-aware
 *   gate (spec "Roles & the checker gate") reaches the research extension:
 *   there's no config channel on the SDK's ExtensionFactory/ExtensionContext,
 *   so this closure is the mechanism (see extensions/research.ts's doc
 *   comment on `SESSION_ROLE_ENV_VAR` for the full reasoning).
 * - `createAgentSession({ cwd, agentDir, modelRuntime, model, resourceLoader,
 *   sessionManager })` — `tools` is intentionally omitted: per
 *   `CreateAgentSessionOptions.tools`'s doc comment, omitting it enables the
 *   default built-ins (read/bash/edit/write) plus every extension-registered
 *   tool, which is exactly the research toolset the session needs.
 * - `SessionManager.inMemory(cwd)` — the loop doesn't need pi's own
 *   session-transcript persistence; the ledger/journal/dossier under
 *   `workspace/` are the durable record.
 * - `session.prompt(objective)` — resolves only after the full turn
 *   (including any tool-call loop) completes; single prompt per session,
 *   per the M2s1 cap ("session ends when model stops").
 * - `session.getSessionStats().tokens` — cumulative usage for the turn.
 * - `session.messages` filtered to the last `role: "assistant"` message —
 *   read for the `INVESTIGATION_COMPLETE` marker (checked by the
 *   controller) and, via `stopReason === "error"` / `errorMessage`, for
 *   provider errors that complete the stream protocol without throwing
 *   (e.g. a 402 surfaces here, not as a thrown exception).
 * - `session.dispose()` — always called (`finally`) to release the session.
 */
export const runSession: RunSessionFn = async (
	objective: string,
	context: RunSessionContext,
): Promise<RunSessionResult> => {
	const modelRuntime = await getModelRuntime();

	const resolved = resolveCliModel({ cliModel: context.model, modelRuntime });
	if (resolved.error || !resolved.model) {
		return {
			transcriptSummary: "",
			usage: ZERO_USAGE,
			error: resolved.error ?? `could not resolve model "${context.model}"`,
		};
	}

	const agentDir = getAgentDir();
	const resourceLoader = new DefaultResourceLoader({
		cwd: context.workspaceDir,
		agentDir,
		additionalSkillPaths: [skillPath],
		extensionFactories: [createResearchExtension({ role: context.role })],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: context.workspaceDir,
		agentDir,
		modelRuntime,
		model: resolved.model,
		thinkingLevel: resolved.thinkingLevel ?? "medium",
		resourceLoader,
		sessionManager: SessionManager.inMemory(context.workspaceDir),
	});

	try {
		await session.prompt(objective);

		const stats = session.getSessionStats();
		const usage: RunSessionUsage = {
			input: stats.tokens.input,
			output: stats.tokens.output,
			total: stats.tokens.total,
		};

		const assistantMessages = session.messages.filter(
			(m): m is AssistantMessage => (m as { role?: string }).role === "assistant",
		);
		const last = assistantMessages[assistantMessages.length - 1];

		if (last && last.stopReason === "error") {
			const error = last.errorMessage ?? 'session ended with stopReason "error"';
			return {
				transcriptSummary: extractText(last),
				usage,
				error,
				errorKind: classifyProviderError(last.stopReason, last.errorMessage),
			};
		}

		return { transcriptSummary: extractText(last), usage };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			transcriptSummary: "",
			usage: ZERO_USAGE,
			error: message,
			errorKind: classifyProviderError(undefined, message),
		};
	} finally {
		session.dispose();
	}
};
