/**
 * Lesson 4.11A — Harness crash-loop guard.
 *
 * The harness wraps the gateway as a child process and auto-restarts on
 * unexpected exit. Without a guard, a gateway that crashes during boot would
 * relaunch every ~1s forever, masking the real bug and burning CPU.
 *
 * The guard logic lives in `src/server/harness.ts` — it's a top-level script
 * that starts a child process at import time, so we can't import-and-test it
 * directly. Instead, this test:
 *   1. Re-implements the decision logic in a pure helper that mirrors the
 *      production source. The helper transitions a small state machine on
 *      child-exit events and "manual restart trigger" events.
 *   2. Source-greps `harness.ts` to confirm the production module still
 *      uses the same constants and the same call structure.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Production constants — keep in sync with harness.ts.
const HEALTHY_UPTIME_MS = 10_000;
const CRASH_LOOP_THRESHOLD = 5;

interface HarnessState {
	consecutiveQuickCrashes: number;
	crashLoopHalted: boolean;
}

function fresh(): HarnessState {
	return { consecutiveQuickCrashes: 0, crashLoopHalted: false };
}

/**
 * Mirrors the `child.on("exit")` callback in harness.ts. Updates the state
 * in-place and returns true iff the harness should auto-restart now.
 */
function onChildExit(state: HarnessState, uptimeMs: number): { shouldRelaunch: boolean } {
	if (uptimeMs < HEALTHY_UPTIME_MS) {
		state.consecutiveQuickCrashes++;
	} else {
		state.consecutiveQuickCrashes = 0;
	}
	if (state.consecutiveQuickCrashes >= CRASH_LOOP_THRESHOLD) {
		state.crashLoopHalted = true;
		return { shouldRelaunch: false };
	}
	return { shouldRelaunch: true };
}

/** Mirrors the manual-restart-clears-counter branch of harness.ts::restart. */
function onManualRestart(state: HarnessState): void {
	state.consecutiveQuickCrashes = 0;
	state.crashLoopHalted = false;
}

describe("Lesson 4.11A — crash-loop guard decision logic", () => {
	it("a single quick crash does NOT halt auto-restart", () => {
		const s = fresh();
		const r = onChildExit(s, 100);
		assert.equal(r.shouldRelaunch, true);
		assert.equal(s.consecutiveQuickCrashes, 1);
		assert.equal(s.crashLoopHalted, false);
	});

	it("relaunches up to four quick crashes; the FIFTH halts auto-restart", () => {
		const s = fresh();
		for (let i = 1; i < CRASH_LOOP_THRESHOLD; i++) {
			const r = onChildExit(s, 100);
			assert.equal(r.shouldRelaunch, true, `crash ${i} should still relaunch`);
		}
		const final = onChildExit(s, 100);
		assert.equal(final.shouldRelaunch, false, "fifth quick crash must halt auto-restart");
		assert.equal(s.crashLoopHalted, true);
		assert.equal(s.consecutiveQuickCrashes, CRASH_LOOP_THRESHOLD);
	});

	it("a healthy uptime (>= HEALTHY_UPTIME_MS) resets the counter to 0", () => {
		const s = fresh();
		onChildExit(s, 100);
		onChildExit(s, 100);
		assert.equal(s.consecutiveQuickCrashes, 2);

		// Server lived 11s — reset.
		onChildExit(s, HEALTHY_UPTIME_MS + 1_000);
		assert.equal(s.consecutiveQuickCrashes, 0);
		assert.equal(s.crashLoopHalted, false);
	});

	it("an exit at exactly HEALTHY_UPTIME_MS counts as healthy (boundary check)", () => {
		const s = fresh();
		onChildExit(s, 100); // 1
		onChildExit(s, HEALTHY_UPTIME_MS); // resets
		assert.equal(s.consecutiveQuickCrashes, 0);
	});

	it("a manual restart trigger (npm run restart-server) clears the counter and unhalts", () => {
		const s = fresh();
		// Drive into halted state.
		for (let i = 0; i < CRASH_LOOP_THRESHOLD; i++) onChildExit(s, 100);
		assert.equal(s.crashLoopHalted, true);

		onManualRestart(s);
		assert.equal(s.consecutiveQuickCrashes, 0);
		assert.equal(s.crashLoopHalted, false);
	});

	it("alternating quick/healthy crashes never reach the cap", () => {
		const s = fresh();
		for (let i = 0; i < 20; i++) {
			onChildExit(s, 100);
			onChildExit(s, HEALTHY_UPTIME_MS + 1_000);
		}
		assert.equal(s.crashLoopHalted, false);
		// Counter was reset on the most recent healthy exit.
		assert.equal(s.consecutiveQuickCrashes, 0);
	});
});

describe("Lesson 4.11A — source-grep guard", () => {
	const SOURCE = path.resolve(import.meta.dirname, "..", "src", "server", "harness.ts");
	const text = fs.readFileSync(SOURCE, "utf-8");

	it("declares HEALTHY_UPTIME_MS = 10_000", () => {
		assert.match(text, /HEALTHY_UPTIME_MS\s*=\s*10_000/);
	});

	it("declares CRASH_LOOP_THRESHOLD = 5", () => {
		assert.match(text, /CRASH_LOOP_THRESHOLD\s*=\s*5/);
	});

	it("tracks consecutiveQuickCrashes and lastLaunchAt across launch/exit", () => {
		assert.match(text, /consecutiveQuickCrashes/);
		assert.match(text, /lastLaunchAt/);
	});

	it("the manual-restart branch resets the counter and clears crashLoopHalted", () => {
		// The restart() function should reset both before kicking off the
		// new launchServer() call.
		assert.match(text, /consecutiveQuickCrashes\s*=\s*0/);
		assert.match(text, /crashLoopHalted\s*=\s*false/);
	});

	it("logs an actionable directive when the cap is reached", () => {
		assert.match(text, /Crash loop detected/);
		assert.match(text, /restart-server/);
	});
});
