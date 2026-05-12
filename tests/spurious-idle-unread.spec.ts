/**
 * Regression test for the "spurious idle/unread" bug.
 *
 * Bug: `src/app/api.ts::updateLocalSessionStatus()` clobbers `lastActivity`
 * to `Date.now()` on every `session_status` frame. Status heartbeats (and
 * benign busy→idle transitions) therefore make the sidebar repeatedly flip
 * to "now ●" for sessions that haven't actually seen new activity.
 *
 * This file:// fixture seeds a GatewaySession whose server-recorded
 * `lastActivity` is 10 minutes ago and whose `lastReadAt` is *after* that
 * value (user has read past the last activity, so `hasUnseenActivity()`
 * starts false). It then calls `updateLocalSessionStatus(sessionId, "idle")`
 * — simulating a heartbeat — and asserts:
 *
 *   1. `state.gatewaySessions[0].lastActivity` is UNCHANGED.
 *   2. `hasUnseenActivity(session)` remains false.
 *
 * Pre-fix this fails on both assertions (the client clobbers lastActivity
 * to Date.now() which is > lastReadAt). Post-fix (drop the lastActivity
 * write inside updateLocalSessionStatus) it passes.
 *
 * See: goal "Fix spurious idle/unread" — Issue Analysis gate.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/spurious-idle-unread.html");
const BUNDLE = path.resolve("tests/fixtures/spurious-idle-unread-bundle.js");
const ENTRY = path.resolve("tests/fixtures/spurious-idle-unread-entry.ts");
const API_SRC = path.resolve("src/app/api.ts");
const STATE_SRC = path.resolve("src/app/state.ts");
const RH_SRC = path.resolve("src/app/render-helpers.ts");

test.beforeAll(() => {
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, API_SRC, STATE_SRC, RH_SRC],
	});
});

const PAGE = `file://${FIXTURE.replace(/\\/g, "/")}`;

test.describe("updateLocalSessionStatus — heartbeat must not clobber lastActivity", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(PAGE);
		await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	});

	test("lastActivity is preserved across a status_heartbeat-driven call", async ({ page }) => {
		const result = await page.evaluate(() => {
			const T0 = Date.now() - 600_000; // 10 minutes ago — server-recorded last activity
			const lastReadAt = T0 + 1_000;    // user has read past the last activity
			(window as any).__seedSession("s1", T0, lastReadAt);

			const stateBefore = (window as any).__state.gatewaySessions[0];
			const unseenBefore = (window as any).__hasUnseenActivity(stateBefore);

			// Simulate a session_status heartbeat (status unchanged, no new activity).
			(window as any).__updateLocalSessionStatus("s1", "idle");

			const stateAfter = (window as any).__state.gatewaySessions[0];
			const unseenAfter = (window as any).__hasUnseenActivity(stateAfter);

			return {
				T0,
				lastReadAt,
				before: { lastActivity: stateBefore.lastActivity, unseen: unseenBefore },
				after: { lastActivity: stateAfter.lastActivity, unseen: unseenAfter, status: stateAfter.status },
				now: Date.now(),
			};
		});

		// Sanity: precondition holds — no unread before the heartbeat.
		expect(result.before.unseen).toBe(false);
		expect(result.before.lastActivity).toBe(result.T0);

		// CORE ASSERTION (fails pre-fix): lastActivity must NOT be clobbered by
		// the status frame. Server is the sole writer of lastActivity.
		expect(
			result.after.lastActivity,
			`updateLocalSessionStatus must not mutate lastActivity. ` +
				`Expected T0=${result.T0}, got ${result.after.lastActivity} ` +
				`(delta from "now"=${result.now - result.after.lastActivity}ms — ` +
				`a small delta means the client clobbered it to Date.now()).`,
		).toBe(result.T0);

		// Secondary assertion: with lastActivity preserved, the sidebar must not
		// spuriously light up the unread dot.
		expect(result.after.unseen, "hasUnseenActivity() must remain false after a heartbeat").toBe(false);

		// And the status is still set correctly (the one field the function MAY mutate).
		expect(result.after.status).toBe("idle");
	});
});
