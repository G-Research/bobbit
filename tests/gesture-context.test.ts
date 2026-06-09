/**
 * Unit tests for the client-internal USER-ACTIVATION gate + trusted per-session
 * SECRET holder (src/app/gesture-context.ts) — design
 * docs/design/extension-host-phase2.md §8 C2.1 / Fix A.
 *
 * Pure module (no DOM), so it runs as a node:test. `navigator.userActivation` is
 * mocked on globalThis to exercise the active/inactive cases.
 *
 * Pins (Fix A):
 *   - consumeGesture() is false at rest (a render/mount has no activation) and true
 *     only while navigator.userActivation.isActive (a genuine user gesture).
 *   - runWithUserGesture is a thin wrapper: returns the body's value, propagates throws.
 *   - the per-session secret round-trips, is per-session isolated, and clears.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	runWithUserGesture,
	consumeGesture,
	isGestureActive,
	setSessionSecret,
	getSessionSecret,
	clearSessionSecret,
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

describe("gesture-context — trusted per-session secret (closure-held)", () => {
	it("round-trips a secret for the bound session", () => {
		setSessionSecret("sess-A", "secret-A");
		assert.equal(getSessionSecret("sess-A"), "secret-A");
	});

	it("is isolated per session (another session never sees it)", () => {
		setSessionSecret("sess-A", "secret-A");
		assert.equal(getSessionSecret("sess-B"), undefined);
		setSessionSecret("sess-B", "secret-B");
		assert.equal(getSessionSecret("sess-A"), "secret-A");
		assert.equal(getSessionSecret("sess-B"), "secret-B");
	});

	it("clears a secret (and an empty value clears too)", () => {
		setSessionSecret("sess-A", "secret-A");
		clearSessionSecret("sess-A");
		assert.equal(getSessionSecret("sess-A"), undefined);
		setSessionSecret("sess-A", "secret-A");
		setSessionSecret("sess-A", undefined);
		assert.equal(getSessionSecret("sess-A"), undefined);
	});

	it("ignores undefined session ids", () => {
		setSessionSecret(undefined, "x");
		assert.equal(getSessionSecret(undefined), undefined);
	});
});
