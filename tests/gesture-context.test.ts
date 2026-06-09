/**
 * Unit tests for the client-internal USER-ACTIVATION gate (src/app/gesture-context.ts)
 * — design docs/design/extension-host-phase2.md §8 C2.1.
 *
 * Pure module (no DOM), so it runs as a node:test. `navigator.userActivation` is
 * mocked on globalThis to exercise the active/inactive cases.
 *
 * The session WRITE's UNFORGEABLE gate is now its TRANSPORT (the SEND rides the
 * trusted session WebSocket — session-write-bridge.ts — not a fetch carrying a
 * capturable secret), so this module no longer holds any per-session secret and
 * exposes no secret getter. What it still provides is the defense-in-depth
 * "no post on mount" check:
 *   - consumeGesture() is false at rest (a render/mount has no activation) and true
 *     only while navigator.userActivation.isActive (a genuine user gesture).
 *   - runWithUserGesture is a thin wrapper: returns the body's value, propagates throws.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	runWithUserGesture,
	consumeGesture,
	isGestureActive,
} from "../src/app/gesture-context.ts";

/** Install a mock `navigator.userActivation` for the active/inactive cases. */
function mockActivation(isActive: boolean | undefined): void {
	const nav = isActive === undefined ? undefined : { userActivation: { isActive } };
	Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
}

afterEach(() => {
	// Restore "no navigator" so the "at rest" semantics are clean for the next test.
	Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true, writable: true });
});

describe("gesture-context — user-activation gate", () => {
	it("is inactive at rest (no navigator / no activation)", () => {
		mockActivation(undefined);
		assert.equal(isGestureActive(), false);
		assert.equal(consumeGesture(), false);
	});

	it("is inactive when navigator.userActivation.isActive is false", () => {
		mockActivation(false);
		assert.equal(consumeGesture(), false);
	});

	it("is active only while navigator.userActivation.isActive is true", () => {
		mockActivation(true);
		assert.equal(consumeGesture(), true);
		assert.equal(isGestureActive(), true);
	});
});

describe("gesture-context — runWithUserGesture (thin wrapper)", () => {
	it("returns the body's value", () => {
		assert.equal(runWithUserGesture(() => 42), 42);
	});

	it("propagates a thrown error", () => {
		assert.throws(() => runWithUserGesture(() => { throw new Error("boom"); }), /boom/);
	});
});
