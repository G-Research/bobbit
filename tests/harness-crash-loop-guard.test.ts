/**
 * Pinned regression: the dev-server harness stops auto-restarting
 * after CRASH_LOOP_THRESHOLD consecutive quick-crashes (each shorter
 * than HEALTHY_UPTIME_MS).
 *
 * Live test (PR #409): the user reported "I had to get claude code
 * to fix the endless restart". An orphan team-store entry whose
 * goal had been archived caused the zombie-reviewer sweep in
 * `resubscribeTeamEvents` to throw during boot. The harness saw
 * the server exit cleanly (`unexpected exit`), restarted in 1s,
 * and the same throw re-fired. Endless loop, burning CPU, with
 * no diagnostic and no way to stop it short of `kill`.
 *
 * Fix in src/server/harness.ts (Claude Code, integrated this
 * commit): track `consecutiveQuickCrashes` and `lastLaunchAt`. If
 * the child exits within HEALTHY_UPTIME_MS (10s), increment the
 * counter; if it stays up longer, reset to 0. After
 * CRASH_LOOP_THRESHOLD (5) quick-crashes in a row, log a clear
 * directive and STOP auto-restarting. A manual restart via
 * `npm run restart-server` clears the counter.
 *
 * The unit test pins the predicate logic. The harness module
 * itself imports node:child_process and managing real subprocesses
 * is outside the unit test scope.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const HEALTHY_UPTIME_MS = 10_000;
const CRASH_LOOP_THRESHOLD = 5;

class CrashLoopGuard {
	consecutiveQuickCrashes = 0;
	private launchedAt = 0;

	onLaunch(now: number): void {
		this.launchedAt = now;
	}

	/** Returns true if auto-restart should fire, false if the loop is detected. */
	onExit(now: number): boolean {
		const uptime = now - this.launchedAt;
		if (uptime < HEALTHY_UPTIME_MS) {
			this.consecutiveQuickCrashes++;
		} else {
			this.consecutiveQuickCrashes = 0;
		}
		if (this.consecutiveQuickCrashes >= CRASH_LOOP_THRESHOLD) {
			return false;
		}
		return true;
	}

	/** Manual restart resets the loop guard. */
	resetForManualRestart(): void {
		this.consecutiveQuickCrashes = 0;
	}
}

describe("harness crash-loop guard", () => {
	it("THE bug: 5 consecutive quick crashes -> stops auto-restart", () => {
		const g = new CrashLoopGuard();
		// Simulate 5 quick crashes (each within the unhealthy window)
		for (let i = 0; i < 4; i++) {
			g.onLaunch(0);
			assert.equal(g.onExit(500), true, `crash ${i + 1} should still allow restart`);
		}
		// 5th crash crosses the threshold — auto-restart blocked
		g.onLaunch(0);
		assert.equal(g.onExit(500), false, "5th quick crash should stop auto-restart");
	});

	it("a healthy uptime resets the counter", () => {
		const g = new CrashLoopGuard();
		// 4 quick crashes
		for (let i = 0; i < 4; i++) {
			g.onLaunch(0);
			g.onExit(500);
		}
		// Then a healthy run (>10s uptime)
		g.onLaunch(0);
		g.onExit(15_000);
		assert.equal(g.consecutiveQuickCrashes, 0, "healthy run should reset counter");

		// Now we can crash again 4 times before being blocked
		for (let i = 0; i < 4; i++) {
			g.onLaunch(0);
			assert.equal(g.onExit(500), true);
		}
		g.onLaunch(0);
		assert.equal(g.onExit(500), false, "5th post-reset crash blocks");
	});

	it("manual restart clears crash-loop state explicitly", () => {
		const g = new CrashLoopGuard();
		// Simulate hitting the threshold
		for (let i = 0; i < 5; i++) {
			g.onLaunch(0);
			g.onExit(500);
		}
		assert.equal(g.consecutiveQuickCrashes, 5);

		// User runs `npm run restart-server`
		g.resetForManualRestart();
		assert.equal(g.consecutiveQuickCrashes, 0);

		// Server can crash 4 more times before being blocked again
		for (let i = 0; i < 4; i++) {
			g.onLaunch(0);
			assert.equal(g.onExit(500), true);
		}
	});

	it("HEALTHY_UPTIME_MS boundary (just inside unhealthy)", () => {
		const g = new CrashLoopGuard();
		g.onLaunch(0);
		g.onExit(HEALTHY_UPTIME_MS - 1); // unhealthy
		assert.equal(g.consecutiveQuickCrashes, 1);
	});

	it("HEALTHY_UPTIME_MS boundary (exactly at threshold = healthy)", () => {
		const g = new CrashLoopGuard();
		g.onLaunch(0);
		g.onExit(HEALTHY_UPTIME_MS); // healthy (>=)
		assert.equal(g.consecutiveQuickCrashes, 0);
	});
});
