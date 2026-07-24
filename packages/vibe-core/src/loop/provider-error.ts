/**
 * Provider-error classification — spec docs/research/loop-design.md "Budgets
 * & provider health". A `const` object + derived union type per the repo's
 * `erasableSyntaxOnly` convention (no `enum`).
 *
 * Lives under `loop/` (not `packages/vibe`) so both `loop-session.ts` (which
 * has the real SDK `stopReason`/`errorMessage`) and `controller.ts` (which
 * only sees `RunSessionResult`) can classify errors the same way.
 */
export const ProviderErrorKind = {
	FUEL: "fuel",
	AUTH: "auth",
	RATE_LIMIT: "rate_limit",
	OTHER: "other",
} as const;

export type ProviderErrorKind = (typeof ProviderErrorKind)[keyof typeof ProviderErrorKind];

export const ProviderHealthStatus = {
	EXHAUSTED: "exhausted",
	AUTH_FAILED: "auth_failed",
} as const;

export type ProviderHealthStatus = (typeof ProviderHealthStatus)[keyof typeof ProviderHealthStatus];

export interface ProviderHealthEntry {
	status: ProviderHealthStatus;
	at: string;
}

/**
 * Classifies a provider/session error into a `ProviderErrorKind` from the
 * session's `stopReason` (SDK-level stop reason string, e.g. "error") and/or
 * a free-text `errorMessage`. Either argument may be `undefined` (e.g. the
 * catch-block path in `loop-session.ts` only has a caught error's message,
 * no SDK `stopReason`).
 *
 * Fixture note: the OpenRouter 402 "insufficient credit" text this classifier
 * targets ("This request requires more credits, or fewer max_tokens...") was
 * supplied directly by this slice's task spec as the fixture to test
 * against; `LEARNINGS.md` only paraphrases the same failure mode (entry 9:
 * "OpenRouter 402s when the model's FULL max_tokens reservation exceeds
 * remaining credits...") rather than quoting the provider's literal error
 * string, so this fixture text is taken as given rather than copied from
 * that file.
 */
export function classifyProviderError(
	stopReason: string | undefined,
	errorMessage: string | undefined,
): ProviderErrorKind {
	const haystack = `${stopReason ?? ""} ${errorMessage ?? ""}`.toLowerCase();

	if (!haystack.trim()) return ProviderErrorKind.OTHER;

	// Fuel: out of credits / balance / quota — OpenRouter 402s this way.
	if (
		haystack.includes("402") ||
		haystack.includes("more credits") ||
		haystack.includes("insufficient credit") ||
		haystack.includes("insufficient balance") ||
		haystack.includes("out of credit") ||
		haystack.includes("quota exceeded") ||
		haystack.includes("billing")
	) {
		return ProviderErrorKind.FUEL;
	}

	// Auth: bad/expired/missing API key, forbidden.
	if (
		haystack.includes("401") ||
		haystack.includes("403") ||
		haystack.includes("unauthorized") ||
		haystack.includes("invalid api key") ||
		haystack.includes("invalid_api_key") ||
		haystack.includes("authentication") ||
		haystack.includes("forbidden") ||
		haystack.includes("permission denied")
	) {
		return ProviderErrorKind.AUTH;
	}

	// Rate limit: transient, does not mark a model unhealthy. Includes the
	// underscored "rate_limit" form since an SDK stopReason may report it that
	// way literally (see provider-error.test.ts "checks stopReason as well as
	// errorMessage").
	if (
		haystack.includes("429") ||
		haystack.includes("rate limit") ||
		haystack.includes("rate-limit") ||
		haystack.includes("rate_limit") ||
		haystack.includes("too many requests")
	) {
		return ProviderErrorKind.RATE_LIMIT;
	}

	return ProviderErrorKind.OTHER;
}
