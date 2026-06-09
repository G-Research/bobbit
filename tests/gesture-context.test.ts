/**
 * Unit tests for the client-internal USER-GESTURE TOKEN
 * (src/app/gesture-context.ts) — design docs/design/extension-host-phase2.md §8
 * C2.1. The token is the load-bearing mechanism behind "no auto-post on mount":
 * `host.session.postMessage` consumes it synchronously and throws when absent.
 *
 * Pure module (no DOM), so it runs as a node:test.
 *
 * Pins:
 *   - the flag is false at rest (a render/mount has no gesture).
 *   - runWithUserGesture sets it for the synchronous body and restores it after.
 *   - consumeGesture returns true exactly once per gesture (no latching).
 *   - nesting is safe (inner restore does not clear an outer gesture).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runWithUserGesture, consumeGesture, isGestureActive } from "../src/app/gesture-context.ts";

describe("gesture-context", () => {
	it("is inactive at rest — consumeGesture() is false on mount", () => {
		assert.equal(isGestureActive(), false);
		assert.equal(consumeGesture(), false);
	});

	it("runWithUserGesture activates the flag for the synchronous body only", () => {
		let inside = false;
		runWithUserGesture(() => { inside = isGestureActive(); });
		assert.equal(inside, true);
		assert.equal(isGestureActive(), false, "flag is restored after the gesture settles");
	});

	it("consumeGesture returns true exactly once inside a gesture (no latching)", () => {
		const seen: boolean[] = [];
		runWithUserGesture(() => {
			seen.push(consumeGesture()); // first: true
			seen.push(consumeGesture()); // second: false — one gesture authorizes one post
		});
		assert.deepEqual(seen, [true, false]);
	});

	it("returns the body's value", () => {
		assert.equal(runWithUserGesture(() => 42), 42);
	});

	it("restores the flag even when the body throws", () => {
		assert.throws(() => runWithUserGesture(() => { throw new Error("boom"); }), /boom/);
		assert.equal(isGestureActive(), false);
	});

	it("is nesting-safe (inner restore preserves the outer gesture)", () => {
		const snapshots: boolean[] = [];
		runWithUserGesture(() => {
			runWithUserGesture(() => { /* inner */ });
			snapshots.push(isGestureActive()); // still active after inner restores
		});
		assert.deepEqual(snapshots, [true]);
	});
});
