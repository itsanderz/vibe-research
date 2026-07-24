/**
 * SIGINT (Ctrl+C) handling logic — spec docs/research/loop-design.md
 * "Resume & stop": "first Ctrl+C lets the current session finish if it can,
 * checkpoints, journals, stops with USER_INTERRUPT, and generates a dossier;
 * a second Ctrl+C force-exits immediately."
 *
 * This module holds only the *decision* logic (what should happen on the
 * Nth signal), kept dependency-free and pure so it can be unit-tested here
 * in vibe-core (packages/vibe has no vitest setup — see package.json). The
 * actual `process.on("SIGINT", ...)` wiring, the `interrupted()` flag read
 * by `controller.ts`'s loop, and the second-signal `process.exit(130)` call
 * live in `packages/vibe/src/cli.ts`, which calls `createSigintHandler` and
 * wires its callbacks to real `process` events.
 *
 * M2s1 learning (see LEARNINGS.md): never call `process.exit()` while a pi
 * SDK session may still be closing async handles — on Windows this crashes
 * Node with a libuv `UV_HANDLE_CLOSING` assertion. The one deliberate
 * exception is the SECOND SIGINT here: at that point the user has asked
 * twice, and an immediate hard exit is the documented, acceptable escape
 * hatch. The FIRST SIGINT never exits — it only requests a graceful stop.
 */

export interface SigintHandlerCallbacks {
	/** Called on the first SIGINT: request a graceful stop (controller checks this each iteration via `interrupted()`). */
	onFirstInterrupt: () => void;
	/** Called on the second (or later) SIGINT: the caller should force-exit immediately (the one acceptable `process.exit()` call). */
	onForceExit: () => void;
}

export interface SigintHandler {
	/** Feed one SIGINT occurrence into the handler. Call this from a real `process.on("SIGINT", ...)` listener. */
	handleSignal: () => void;
	/** Whether a graceful stop has been requested (i.e. at least one SIGINT has been received). */
	interrupted: () => boolean;
	/** How many SIGINTs have been received so far. */
	signalCount: () => number;
}

/**
 * Builds the pure signal-counting state machine: 1st call to `handleSignal`
 * invokes `onFirstInterrupt` and flips `interrupted()` to true; every call
 * after that (2nd, 3rd, ...) invokes `onForceExit` again each time.
 */
export function createSigintHandler(callbacks: SigintHandlerCallbacks): SigintHandler {
	let count = 0;

	return {
		handleSignal: () => {
			count += 1;
			if (count === 1) {
				callbacks.onFirstInterrupt();
			} else {
				callbacks.onForceExit();
			}
		},
		interrupted: () => count > 0,
		signalCount: () => count,
	};
}
