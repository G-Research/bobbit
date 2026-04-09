/**
 * Archived chat blob E2E tests.
 * Verifies that the bobbit blob in archived sessions is desaturated (grayscale)
 * and has all CSS animations stopped.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, apiFetch, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("Archived session blob", () => {
	test("blob has archived class, grayscale filter, and no animations", async ({ page }) => {
		// Create a session and wait for it to be ready
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		// Open app and navigate to the session
		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		// Send a message so the session has content
		await sendMessage(page, "hello");
		await waitForAgentResponse(page);

		// Wait for idle before terminating
		await waitForSessionStatus(sessionId, "idle");

		// Terminate the session (which archives it)
		const termResp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		expect(termResp.ok).toBe(true);

		// Navigate away, then back to the archived session to pick up archived state
		await page.evaluate(() => { window.location.hash = "#/"; });
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 10_000 });

		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);

		// Wait for the archived blob to appear
		const archivedBlob = page.locator(".bobbit-blob--archived");
		await expect(archivedBlob).toBeVisible({ timeout: 10_000 });

		// Verify grayscale filter is applied
		const filter = await archivedBlob.evaluate(
			el => getComputedStyle(el).filter,
		);
		expect(filter).toContain("grayscale");

		// Verify no CSS animations are running on the blob or its children
		const runningAnimCount = await archivedBlob.evaluate(
			el => el.getAnimations({ subtree: true }).filter(a => a.playState === "running").length,
		);
		expect(runningAnimCount).toBe(0);
	});

	test("active session blob does NOT have archived class", async ({ page }) => {
		// Create a session and verify it does NOT get the archived treatment
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		// Send a message to trigger the blob
		await sendMessage(page, "hello");
		await waitForAgentResponse(page);

		// The blob should be visible but NOT have the archived class
		const blob = page.locator(".bobbit-blob").first();
		await expect(blob).toBeVisible({ timeout: 10_000 });
		await expect(blob).not.toHaveClass(/bobbit-blob--archived/);

		// Cleanup
		await deleteSession(sessionId);
	});
});
