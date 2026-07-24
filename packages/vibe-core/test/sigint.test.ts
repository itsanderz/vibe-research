import { describe, expect, it, vi } from "vitest";
import { createSigintHandler } from "../src/loop/sigint.ts";

describe("createSigintHandler", () => {
	it("invokes onFirstInterrupt exactly once, on the first signal", () => {
		const onFirstInterrupt = vi.fn();
		const onForceExit = vi.fn();
		const handler = createSigintHandler({ onFirstInterrupt, onForceExit });

		handler.handleSignal();

		expect(onFirstInterrupt).toHaveBeenCalledTimes(1);
		expect(onForceExit).not.toHaveBeenCalled();
		expect(handler.interrupted()).toBe(true);
		expect(handler.signalCount()).toBe(1);
	});

	it("invokes onForceExit on the second signal (the one acceptable process.exit() path)", () => {
		const onFirstInterrupt = vi.fn();
		const onForceExit = vi.fn();
		const handler = createSigintHandler({ onFirstInterrupt, onForceExit });

		handler.handleSignal();
		handler.handleSignal();

		expect(onFirstInterrupt).toHaveBeenCalledTimes(1);
		expect(onForceExit).toHaveBeenCalledTimes(1);
		expect(handler.signalCount()).toBe(2);
	});

	it("invokes onForceExit again for every signal after the second", () => {
		const onFirstInterrupt = vi.fn();
		const onForceExit = vi.fn();
		const handler = createSigintHandler({ onFirstInterrupt, onForceExit });

		handler.handleSignal();
		handler.handleSignal();
		handler.handleSignal();
		handler.handleSignal();

		expect(onFirstInterrupt).toHaveBeenCalledTimes(1);
		expect(onForceExit).toHaveBeenCalledTimes(3);
		expect(handler.signalCount()).toBe(4);
	});

	it("interrupted() is false before any signal has arrived", () => {
		const handler = createSigintHandler({ onFirstInterrupt: vi.fn(), onForceExit: vi.fn() });
		expect(handler.interrupted()).toBe(false);
		expect(handler.signalCount()).toBe(0);
	});
});
