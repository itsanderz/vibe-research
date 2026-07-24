import { describe, expect, it } from "vitest";
import { familyOf } from "../src/loop/family.ts";

describe("familyOf", () => {
	it.each([
		// meta-provider passthrough (3+ segments): the vendor is the 2nd segment
		["openrouter/anthropic/claude-x", "anthropic"],
		["openrouter/openai/gpt-5.6-sol", "openai"],
		["some-proxy/anthropic/claude-sonnet-5/extra", "anthropic"],
		// <vendor>/<model> (2 segments): the vendor is the 1st segment
		["anthropic/claude-x", "anthropic"],
		["openai/gpt-x", "openai"],
		// single opaque segment: the id itself is the family
		["test-model", "test-model"],
		["deepseek-pro-v4", "deepseek-pro-v4"],
	])("familyOf(%s) === %s", (modelId, expected) => {
		expect(familyOf(modelId)).toBe(expected);
	});

	it("ignores leading/trailing/doubled slashes rather than crashing", () => {
		expect(familyOf("/openrouter/anthropic/claude-x/")).toBe("anthropic");
		expect(familyOf("anthropic//claude-x")).toBe("anthropic");
	});

	it("treats an empty string as a single opaque segment (itself)", () => {
		expect(familyOf("")).toBe("");
	});
});
