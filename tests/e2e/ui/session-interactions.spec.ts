/**
 * Session interaction E2E tests — Journey 4.
 * Tests session create, message send/receive, switching, termination,
 * and persistence through real browser interactions.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, apiFetch, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("Session interactions (UI)", () => {
	test("create session, send message, see response", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "Hello from session interaction test");
		await waitForAgentResponse(page);
		// Verify "OK" text is visible (the mock agent's default response)
		await expect(page.getByText("OK", { exact: true }).first()).toBeVisible();
	});

	test("switch between sessions via sidebar", async ({ page }) => {
		// Create 2 sessions via API
		const id1 = await createSession();
		const id2 = await createSession();

		// Wait for both to be idle
		await waitForSessionStatus(id1, "idle");
		await waitForSessionStatus(id2, "idle");

		await openApp(page);

		// Navigate to session 1 via hash route
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, id1);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		// Verify the URL hash reflects session 1
		let hash = await page.evaluate(() => window.location.hash);
		expect(hash).toContain(id1);

		// Navigate to session 2
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, id2);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		// Verify the URL hash reflects session 2
		hash = await page.evaluate(() => window.location.hash);
		expect(hash).toContain(id2);

		// Cleanup
		await deleteSession(id1);
		await deleteSession(id2);
	});

	test("terminate session and verify UI cleanup", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "About to be terminated");
		await waitForAgentResponse(page);

		// Get the session ID from the URL hash
		const hash = await page.evaluate(() => window.location.hash);
		const sessionIdMatch = hash.match(/#\/session\/([a-f0-9-]+)/i);
		expect(sessionIdMatch).toBeTruthy();
		const sessionId = sessionIdMatch![1];

		// Wait for idle before deleting
		await waitForSessionStatus(sessionId, "idle");

		// Delete via API
		await deleteSession(sessionId);

		// Navigate to landing to verify the session is gone
		await page.evaluate(() => { window.location.hash = "#/"; });

		// The textarea from the deleted session should not be visible
		// on the landing page. Wait for the landing state.
		await expect(page.locator("button[title='New session']").first()).toBeVisible({ timeout: 10_000 });

		// Verify the session is no longer in the API
		const resp = await apiFetch("/api/sessions");
		const sessions = ((await resp.json()).sessions || []);
		const found = sessions.find((s: { id: string }) => s.id === sessionId);
		expect(found).toBeFalsy();
	});

	test("session survives page reload", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "Persistence test message");
		await waitForAgentResponse(page);

		// Get session ID from hash
		const hash = await page.evaluate(() => window.location.hash);
		const sessionIdMatch = hash.match(/#\/session\/([a-f0-9-]+)/i);
		expect(sessionIdMatch).toBeTruthy();
		const sessionId = sessionIdMatch![1];

		// Wait for idle
		await waitForSessionStatus(sessionId, "idle");

		// Reload the page
		await page.reload();

		// After reload, wait for the app to load
		await expect(
			page.locator("button[title='New session']").first(),
		).toBeVisible({ timeout: 15_000 });

		// Verify the session is still in the API
		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		expect(resp.ok).toBe(true);

		// Navigate back to the session and verify it loads
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		// Cleanup
		await deleteSession(sessionId);
	});
});
