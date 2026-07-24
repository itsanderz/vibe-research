/**
 * Model-family extraction — spec docs/research/loop-design.md "Roles & the
 * checker gate": "the loop refuses to start a checker session whose model
 * *family* (provider+vendor prefix) equals the proposing session's." A
 * same-family checker (e.g. two Claude models rubber-stamping each other)
 * doesn't provide independent verification.
 *
 * Model ids used across this codebase come in three shapes:
 *  - `<meta-provider>/<vendor>/<model>`, e.g. "openrouter/anthropic/claude-sonnet-5"
 *    (openrouter and similar meta-providers pass a vendor prefix through).
 *  - `<vendor>/<model>`, e.g. "anthropic/claude-sonnet-5" or "openai/gpt-5.6".
 *  - a single opaque segment, e.g. a bare "test-model" used in tests/local
 *    configs — there is no separate vendor, so the id itself is the family.
 *
 * The "family" is always the vendor segment: for 3+ segment ids, the second
 * segment (passthrough extraction past the meta-provider prefix); for
 * exactly 2 segments, the first; for 1 segment, the id itself.
 */
export function familyOf(modelId: string): string {
	const segments = modelId.split("/").filter((segment) => segment.length > 0);
	if (segments.length >= 3) return segments[1];
	if (segments.length === 2) return segments[0];
	return modelId;
}
