/**
 * E2E — auto-retry banner visibility.
 *
 * Covers the user-facing UI for the provider overload / rate-limit retry
 * feature. The banner is purely state-driven (rendered when
 * `state.autoRetryPending` is set by the `auto_retry_pending` WS event,
 * cleared by `auto_retry_cancelled` or the next `agent_start`).
 *
 * Driving a real provider overload end-to-end requires either a working
 * mock agent or a flaky live API call, so we inject the same events the
 * server broadcasts directly into `RemoteAgent.handleAgentEvent` via the
 * dev-only `window.__bobbitState.remoteAgent` hook used by other UI tests
 * (see `session-status-recovery.spec.ts`).
 *
 * Pinned behaviour:
 *   1. `auto_retry_pending` event → banner appears with correct testid,
 *      reason, attempt #, and human-readable countdown text.
 *   2. `auto_retry_cancelled` → banner disappears.
 *   3. `agent_start` (next turn dispatched) → banner disappears.
 *   4. Reason flavours (`provider-overload` vs `transient-error`) render
 *      different copy.
 *
 * See docs/auto-retry.md.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, waitForSessionStatus } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Auto-retry banner (UI)", () => {
	test("auto_retry_pending shows banner; auto_retry_cancelled hides it", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			// Wait for RemoteAgent to be exposed.
			await page.waitForFunction(
				() => !!(window as any).__bobbitState?.remoteAgent?.connected,
				undefined,
				{ timeout: 15_000 },
			);

			const banner = page.locator('[data-testid="auto-retry-banner"]');
			await expect(banner).toHaveCount(0);

			// Inject a provider-overload pending event — same shape the server
			// broadcasts from `maybeAutoRetryTransient`.
			await page.evaluate(() => {
				(window as any).__bobbitState.remoteAgent.handleAgentEvent({
					type: "auto_retry_pending",
					reason: "provider-overload",
					retryDelayMs: 4000,
					attempt: 3,
					scheduledAt: Date.now(),
					error: "overloaded_error",
				});
			});

			// Banner appears with the data-* attributes wired by AgentInterface.
			await expect(banner).toBeVisible({ timeout: 5_000 });
			await expect(banner).toHaveAttribute("data-reason", "provider-overload");
			await expect(banner).toHaveAttribute("data-attempt", "3");
			await expect(banner).toHaveAttribute("data-retry-delay-ms", "4000");

			// Copy: provider-overload variant. The displayed seconds round
			// retryDelayMs/1000, so 4000 ms → "~4s".
			await expect(banner).toContainText("provider overload");
			await expect(banner).toContainText("~4s");
			await expect(banner).toContainText("attempt #3");

			// Cancel — banner disappears.
			await page.evaluate(() => {
				(window as any).__bobbitState.remoteAgent.handleAgentEvent({
					type: "auto_retry_cancelled",
					reason: "explicit-retry",
					cancelledAt: Date.now(),
				});
			});

			await expect(banner).toHaveCount(0, { timeout: 5_000 });
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});

	test("agent_start consumes a pending retry banner", async ({ page }) => {
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

			const banner = page.locator('[data-testid="auto-retry-banner"]');

			// Schedule a retry...
			await page.evaluate(() => {
				(window as any).__bobbitState.remoteAgent.handleAgentEvent({
					type: "auto_retry_pending",
					reason: "transient-error",
					retryDelayMs: 1000,
					attempt: 1,
					scheduledAt: Date.now(),
				});
			});
			await expect(banner).toBeVisible({ timeout: 5_000 });

			// ...then simulate the timer firing — agent_start arrives for the
			// retried turn. Per remote-agent.ts case "agent_start", this must
			// clear `autoRetryPending` and the banner disappears.
			await page.evaluate(() => {
				(window as any).__bobbitState.remoteAgent.handleAgentEvent({
					type: "agent_start",
				});
			});
			await expect(banner).toHaveCount(0, { timeout: 5_000 });
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});

	test("transient-error reason renders different copy than provider-overload", async ({ page }) => {
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

			const banner = page.locator('[data-testid="auto-retry-banner"]');

			await page.evaluate(() => {
				(window as any).__bobbitState.remoteAgent.handleAgentEvent({
					type: "auto_retry_pending",
					reason: "transient-error",
					retryDelayMs: 2000,
					attempt: 2,
					scheduledAt: Date.now(),
				});
			});

			await expect(banner).toBeVisible({ timeout: 5_000 });
			await expect(banner).toHaveAttribute("data-reason", "transient-error");
			// Transient-error variant uses "transient error" wording instead of
			// "provider overload" — pin so the two flavours don't accidentally
			// converge to the same copy.
			await expect(banner).toContainText("transient error");
			await expect(banner).not.toContainText("provider overload");
			await expect(banner).toContainText("~2s");
			await expect(banner).toContainText("attempt #2");
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});
});
