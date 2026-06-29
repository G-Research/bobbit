/**
 * AC §1 — Steer + Stop exactly-once.
 *
 * Steer a queued message (or live-steer a streaming agent) and then click Stop.
 * The steered text must appear as exactly one user-message in the transcript —
 * no duplication via the "abort drains the queue" path.
 */
import { test, expect } from "./fixtures.js";
import { createSession, deleteSession, waitForHealth, waitForSessionStatus } from "../e2e-setup.js";
import { navigateToHash, openApp, sendMessage } from "./ui-helpers.js";

const BUSY_MS = 30_000;
const STEER_TEXT = "EXACTLY_ONCE_TEXT";

async function clickStopAndWaitForIdle(page: any, sessionId: string): Promise<void> {
	const clicked = await page.waitForFunction(() => {
		const button = document.querySelector<HTMLButtonElement>("button[title='Stop streaming']");
		if (!button || button.disabled) return false;
		button.click();
		return true;
	}, undefined, { timeout: 5_000 });
	expect(await clicked.jsonValue()).toBe(true);
	// The busy prompt is intentionally much longer than this wait. If Stop is
	// not delivered, this fails deterministically instead of idling out at the
	// Playwright test timeout and closing the page mid-assertion.
	await waitForSessionStatus(sessionId, "idle", 15_000);
}

async function clickSteer(page: any): Promise<void> {
	await expect(page.locator(".steer-btn").first()).toBeVisible({ timeout: 5_000 });
	const clicked = await page.evaluate(() => {
		const button = document.querySelector<HTMLButtonElement>(".queue-pill .steer-btn");
		if (!button || button.disabled) return false;
		button.click();
		return true;
	});
	expect(clicked).toBe(true);
}

test.describe("Steer + Stop exactly-once (AC §1)", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("steered text appears as exactly one user-message after Steer+Stop", async ({ page, rec }) => {
		test.setTimeout(60_000);
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await page.waitForFunction(
				(id) => (window as any).bobbitState?.selectedSessionId === id,
				sessionId,
				{ timeout: 15_000 },
			);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await sendMessage(page, `STAY_BUSY:${BUSY_MS} long-running`);
			await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 10_000 });

			const textarea = page.locator("textarea").first();
			await textarea.fill(STEER_TEXT);
			await textarea.press("Enter");
			await expect(page.locator(".queue-pill").first()).toBeVisible({ timeout: 5_000 });

			await clickSteer(page);
			await rec.capture("Steer clicked");
			await clickStopAndWaitForIdle(page, sessionId);
			await rec.capture("Stop clicked and session idle");

			const steeredMessages = page.locator("user-message").filter({ hasText: STEER_TEXT });
			await expect(steeredMessages.first()).toBeVisible({ timeout: 15_000 });

			// The session is idle and no queued pill remains, so any abort-drain
			// duplicate would already have been rendered by this point.
			await expect(page.locator(".queue-pill")).toHaveCount(0, { timeout: 5_000 });
			await expect(steeredMessages).toHaveCount(1);
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});
});
