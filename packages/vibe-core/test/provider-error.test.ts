import { describe, expect, it } from "vitest";
import { classifyProviderError, ProviderErrorKind } from "../src/loop/provider-error.ts";

/**
 * Fixture note: the exact OpenRouter 402 fragment below ("This request
 * requires more credits, or fewer max_tokens...") was supplied directly by
 * the M2s3 task spec as the fixture text to test against. LEARNINGS.md only
 * paraphrases this failure mode (entry 9), it does not quote the provider's
 * literal error string — so this fixture is taken as given, not copied from
 * that file. See controller.ts / provider-error.ts doc comments for the same
 * note.
 */
describe("classifyProviderError", () => {
	it("classifies the real OpenRouter 402 insufficient-credit text as fuel", () => {
		expect(
			classifyProviderError(
				"error",
				"This request requires more credits, or fewer max_tokens. You can increase your balance at https://openrouter.ai/settings/credits",
			),
		).toBe(ProviderErrorKind.FUEL);
	});

	it("classifies a bare 402 status mention as fuel", () => {
		expect(classifyProviderError("error", "402 Payment Required")).toBe(ProviderErrorKind.FUEL);
	});

	it("classifies insufficient balance / out of credit / quota / billing phrasing as fuel", () => {
		expect(classifyProviderError(undefined, "Insufficient balance for this request")).toBe(ProviderErrorKind.FUEL);
		expect(classifyProviderError(undefined, "Account is out of credit")).toBe(ProviderErrorKind.FUEL);
		expect(classifyProviderError(undefined, "Quota exceeded for this billing period")).toBe(ProviderErrorKind.FUEL);
		expect(classifyProviderError(undefined, "Billing issue on this account")).toBe(ProviderErrorKind.FUEL);
	});

	it("classifies 401/403/unauthorized/invalid-key phrasing as auth", () => {
		expect(classifyProviderError("error", "401 Unauthorized")).toBe(ProviderErrorKind.AUTH);
		expect(classifyProviderError("error", "403 Forbidden")).toBe(ProviderErrorKind.AUTH);
		expect(classifyProviderError(undefined, "Invalid API key provided")).toBe(ProviderErrorKind.AUTH);
		expect(classifyProviderError(undefined, "invalid_api_key: authentication failed")).toBe(ProviderErrorKind.AUTH);
		expect(classifyProviderError(undefined, "Permission denied for this resource")).toBe(ProviderErrorKind.AUTH);
	});

	it("classifies 429/rate-limit phrasing as rate_limit", () => {
		expect(classifyProviderError("error", "429 Too Many Requests")).toBe(ProviderErrorKind.RATE_LIMIT);
		expect(classifyProviderError(undefined, "Rate limit exceeded, please slow down")).toBe(
			ProviderErrorKind.RATE_LIMIT,
		);
		expect(classifyProviderError(undefined, "rate-limited, try again later")).toBe(ProviderErrorKind.RATE_LIMIT);
	});

	it("classifies an unrecognized error as other", () => {
		expect(classifyProviderError("error", "502 Bad Gateway")).toBe(ProviderErrorKind.OTHER);
		expect(classifyProviderError(undefined, "connection reset by peer")).toBe(ProviderErrorKind.OTHER);
	});

	it("classifies no information at all (both undefined) as other", () => {
		expect(classifyProviderError(undefined, undefined)).toBe(ProviderErrorKind.OTHER);
	});

	it("is case-insensitive", () => {
		expect(classifyProviderError(undefined, "UNAUTHORIZED: INVALID API KEY")).toBe(ProviderErrorKind.AUTH);
		expect(classifyProviderError(undefined, "RATE LIMIT EXCEEDED")).toBe(ProviderErrorKind.RATE_LIMIT);
	});

	it("checks stopReason as well as errorMessage", () => {
		expect(classifyProviderError("rate_limit", undefined)).toBe(ProviderErrorKind.RATE_LIMIT);
	});
});
