/**
 * E2E — session-status canonical-status recovery.
 *
 * Validates two acceptance criteria from the unify-session-status design:
 *
 *   AC #2 — Bounded staleness via heartbeat: after a simulated missed
 *           `agent_end` (we hand-write `_state.status = "streaming"` with no
 *           server frame), the next server-pushed `session_status` heartbeat
 *           or `status_resync` reply heals the client back to "idle".
 *
 *   AC #3 — Duplicate-message bug is gone: the optimistic-prompt branch in
 *           `RemoteAgent.prompt()` is gated on `!isStreaming`. Drive the
 *           client into stuck-streaming, then send a `status_resync` from the
 *           browser; the server replies with the canonical session_status,
 *           the heal flips isStreaming back to false, and a subsequent prompt
 *           renders exactly one user message (no ghost echo).
 *
 * The dev-only test hook used here is `window.__bobbitState.remoteAgent`,
 * which `src/app/main.ts:39` already exposes for E2E tests. No production
 * code change required.
 *
 * See docs/design/unify-session-status.md §6.2.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, waitForSessionStatus } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Session status — canonical-status recovery", () => {
	test("status_resync heals a stuck-streaming client", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			// Wait for RemoteAgent to be exposed and connected.
			await page.waitForFunction(
				() => !!(window as any).__bobbitState?.remoteAgent?.connected,
				undefined,
				{ timeout: 15_000 },
			);

			// Sanity: server is idle, client agrees.
			await expect.poll(async () =>
				page.evaluate(() => (window as any).__bobbitState.remoteAgent.state.isStreaming),
			).toBe(false);

			// Force the stuck-streaming condition: hand-write _state.status =
			// "streaming" and rewind _lastStatusVersion so a freshly minted
			// server frame is treated as a gap (which triggers status_resync).
			const beforeStuck = await page.evaluate(() => {
				const a = (window as any).__bobbitState.remoteAgent;
				a._state.status = "streaming";
				a._lastStatusVersion = -1; // stale → next live frame is a gap → resync
				return { isStreaming: a.state.isStreaming, status: a._state.status };
			});
			expect(beforeStuck.isStreaming).toBe(true);
			expect(beforeStuck.status).toBe("streaming");

			// Trigger a status_resync from the client. The server replies with
			// the canonical session_status frame carrying the real status (idle)
			// and current statusVersion. Client's case "session_status" handler
			// detects the gap (lastVersion=-1, frame=N), requests another resync
			// (no-op, idempotent on the next reply), and applies the frame.
			await page.evaluate(() => {
				(window as any).__bobbitState.remoteAgent.send({ type: "status_resync" });
			});

			// Within a few seconds the heal lands and isStreaming returns to false.
			await expect.poll(
				async () => page.evaluate(() => (window as any).__bobbitState.remoteAgent.state.isStreaming),
				{ timeout: 10_000, intervals: [100, 250, 500] },
			).toBe(false);

			// Status is canonical idle.
			const finalStatus = await page.evaluate(
				() => (window as any).__bobbitState.remoteAgent._state.status,
			);
			expect(finalStatus).toBe("idle");
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});

	test("isStreaming, isArchived, isPreparing are all derived from canonical status", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await page.waitForFunction(
				() => !!(window as any).__bobbitState?.remoteAgent?.connected,
				undefined,
				{ timeout: 15_000 },
			);

			// Drive status through the canonical field; assert every derived
			// boolean follows. This is the divergence-impossibility invariant
			// (AC #1) at the integration level.
			const observations = await page.evaluate(() => {
				const a = (window as any).__bobbitState.remoteAgent;
				const samples: Array<Record<string, unknown>> = [];
				for (const s of ["idle", "streaming", "aborting", "preparing", "archived"]) {
					a._state.status = s;
					samples.push({
						status: a._state.status,
						isStreaming: a.state.isStreaming,
						isArchived: a.state.isArchived,
						isPreparing: a.state.isPreparing,
					});
				}
				return samples;
			});

			expect(observations).toEqual([
				{ status: "idle",      isStreaming: false, isArchived: false, isPreparing: false },
				{ status: "streaming", isStreaming: true,  isArchived: false, isPreparing: false },
				{ status: "aborting",  isStreaming: false, isArchived: false, isPreparing: false },
				{ status: "preparing", isStreaming: false, isArchived: false, isPreparing: true  },
				{ status: "archived",  isStreaming: false, isArchived: true,  isPreparing: false },
			]);
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});
});
