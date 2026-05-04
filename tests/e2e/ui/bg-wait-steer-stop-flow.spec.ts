/**
 * AC §1 — Steer + Stop exactly-once.
 *
 * Steer a queued message (or live-steer a streaming agent) and then click Stop.
 * The steered text must appear as exactly one user-message in the transcript —
 * no duplication via the "abort drains the queue" path.
 */
import { test, expect } from "./fixtures.js";
import { createSession, waitForHealth, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

test.describe("Steer + Stop exactly-once (AC §1)", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("steered text appears as exactly one user-message after Steer+Stop", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await openApp(page);
		await page.evaluate((id) => {
			window.location.hash = `#/session/${id}`;
		}, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await sendMessage(page, "STAY_BUSY:30000 long-running");
		await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 10_000 });

		const textarea = page.locator("textarea").first();
		await textarea.fill("EXACTLY_ONCE_TEXT");
		await textarea.press("Enter");
		await expect(page.locator(".queue-pill").first()).toBeVisible({ timeout: 5_000 });

		await page.locator(".steer-btn").first().click();
		await rec.capture("Steer clicked");
		await page.locator("button[title='Stop streaming']").click();
		await rec.capture("Stop clicked");

		await waitForSessionStatus(sessionId, "idle", 30_000);

		// Wait for the steered user-message to render at least once…
		await expect(
			page.locator("user-message").filter({ hasText: "EXACTLY_ONCE_TEXT" }).first(),
		).toBeVisible({ timeout: 10_000 });

		// …then assert exactly one. The session is already idle and the queue
		// is empty, so any duplicate would already be in the DOM.
		const count = await page.locator("user-message").filter({ hasText: "EXACTLY_ONCE_TEXT" }).count();
		expect(count).toBe(1);
	});
});
