/**
 * Browser E2E — F17 remainder: retry-banner + composer queued-state
 * accessibility.
 *
 * F17's dialog third (role="dialog"/aria-modal + focus trap/restore) already
 * landed via UX-01/03/04 (see PR #15, #43). This spec covers the two
 * remaining thirds:
 *
 *   1. The auto-retry banner (AgentInterface.ts) must be an assertive-enough
 *      live region so screen readers announce transient provider-overload /
 *      transient-error retries as they happen, not just visually.
 *   2. The composer (MessageEditor.ts) must make the "your prompt is queued
 *      behind a running turn" state change perceivable to screen readers —
 *      today it's pill-only (sighted users see `.queue-pill` rows appear/
 *      disappear with no non-visual signal). We add a dedicated aria-live
 *      announcer plus a placeholder that hints at queueing while a turn is
 *      in flight.
 *
 * See docs/auto-retry.md and RECONCILIATION-2026-07-05.md (search "F17").
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

test.describe("F17 remainder — retry banner + composer queue a11y", () => {
	test("auto-retry banner is an aria-live status region", async ({ page }) => {
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
			await expect(banner).toHaveCount(0);

			await page.evaluate(() => {
				(window as any).__bobbitState.remoteAgent.handleAgentEvent({
					type: "auto_retry_pending",
					reason: "provider-overload",
					retryDelayMs: 4000,
					attempt: 1,
					scheduledAt: Date.now(),
					error: "overloaded_error",
				});
			});

			// The banner itself is the live region — assert it is announced
			// (role="status" implies an assertive-enough aria-live="polite"
			// live region) and carries the transient-failure text a screen
			// reader would speak.
			await expect(banner).toBeVisible({ timeout: 5_000 });
			await expect(banner).toHaveAttribute("role", "status");
			await expect(banner).toHaveAttribute("aria-live", "polite");
			await expect(banner).toContainText("provider overload");

			// Cancel — banner (and its live region) disappears.
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

	test("composer announces queued state and hints at queueing via placeholder", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);

			const textarea = page.locator("textarea").first();
			const liveRegion = page.locator('[data-testid="composer-queue-live-region"]');
			await expect(textarea).toBeVisible({ timeout: 15_000 });

			// Idle: default placeholder, empty (but present) live region.
			await expect(textarea).toHaveAttribute("placeholder", "Type a message...");
			await expect(liveRegion).toHaveCount(1);
			await expect(liveRegion).toHaveAttribute("aria-live", "polite");
			await expect(liveRegion).toHaveText("");

			// Make the agent busy so subsequent sends queue instead of dispatching.
			await sendMessage(page, "STAY_BUSY:4000 working");
			await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 10_000 });

			// Mid-turn: placeholder hints that typing now will queue.
			await expect(textarea).toHaveAttribute(
				"placeholder",
				"Message will queue until the agent finishes…",
			);

			// Queue one message — pill appears AND the live region announces it.
			await textarea.fill("first queued message");
			await textarea.press("Enter");
			await expect(page.locator(".queue-pill")).toHaveCount(1, { timeout: 5_000 });
			await expect(liveRegion).toHaveText("1 message queued — will send after the agent finishes.");

			// Queue a second — announcement pluralizes and updates the count.
			await textarea.fill("second queued message");
			await textarea.press("Enter");
			await expect(page.locator(".queue-pill")).toHaveCount(2, { timeout: 5_000 });
			await expect(liveRegion).toHaveText("2 messages queued — will send after the agent finishes.");

			// Dequeue both via the remove button — announcement clears back to empty.
			await page.locator(".queue-pill .remove-btn").first().click();
			await expect(page.locator(".queue-pill")).toHaveCount(1, { timeout: 5_000 });
			await expect(liveRegion).toHaveText("1 message queued — will send after the agent finishes.");

			await page.locator(".queue-pill .remove-btn").first().click();
			await expect(page.locator(".queue-pill")).toHaveCount(0, { timeout: 5_000 });
			await expect(liveRegion).toHaveText("");
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});
});
