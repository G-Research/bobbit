/**
 * True end-to-end test: real UI in a real browser, mock agent backend.
 *
 * Flow: open app → create session → send message → verify response renders →
 *       optionally screenshot → terminate session.
 *
 * This test uses the gateway-harness fixture with E2E_SERVE_UI=1 so the
 * gateway serves the built UI. Set SCREENSHOT=1 to capture screenshots.
 */
import { test, expect } from "./gateway-harness.js";
import { readE2EToken, apiFetch } from "./e2e-setup.js";
import type { Page } from "@playwright/test";

const SCREENSHOT = process.env.SCREENSHOT === "1";

/** Open the app authenticated via token query param. */
async function openApp(page: Page): Promise<void> {
	const token = readE2EToken();
	const base = `http://127.0.0.1:${process.env.E2E_PORT}`;
	await page.goto(`${base}/?token=${encodeURIComponent(token)}`);
	await expect(
		page.locator("button[title='New session']").first(),
	).toBeVisible({ timeout: 15_000 });
}

/** Poll until a condition is met. */
async function pollUntil(
	fn: () => Promise<boolean>,
	{ timeout = 15_000, interval = 100 } = {},
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (await fn()) return;
		await new Promise(r => setTimeout(r, interval));
	}
	throw new Error(`pollUntil timed out after ${timeout}ms`);
}

test.describe("Session lifecycle (full-stack UI)", () => {
	test("create session, send message, see response, terminate", async ({ page }) => {
		await openApp(page);

		// Create a new session
		await page.locator("button[title='New session']").first().click();
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 15_000 });

		// Send a message
		await textarea.fill("Hello from the fullstack test");
		await textarea.press("Enter");

		// Wait for the mock agent's "OK" response
		await expect(
			page.getByText("OK", { exact: true }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Verify session reached idle
		const sessionsResp = await apiFetch("/api/sessions");
		const sessions = ((await sessionsResp.json()).sessions || []);
		expect(sessions.length).toBeGreaterThanOrEqual(1);
		const sessionId = sessions[0].id;

		await pollUntil(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			return (await resp.json()).status === "idle";
		});

		// Optional screenshot
		if (SCREENSHOT) {
			await page.screenshot({
				path: "tests/e2e/screenshots/session-with-response.png",
				fullPage: true,
			});
		}

		// Terminate via API
		const delResp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		expect(delResp.ok).toBe(true);

		// Verify session disappears from the server
		await pollUntil(async () => {
			const resp = await apiFetch("/api/sessions");
			const remaining = ((await resp.json()).sessions || []).filter(
				(s: { id: string }) => s.id === sessionId,
			);
			return remaining.length === 0;
		});

		// The session was deleted server-side. Verify the UI reflects this:
		// either the textarea disappears, or we see "No sessions" in the sidebar.
		await expect(textarea).not.toBeVisible({ timeout: 15_000 }).catch(async () => {
			// If textarea is still visible (the chat panel hasn't cleared yet),
			// check that the sidebar at least shows no sessions.
			const base = `http://127.0.0.1:${process.env.E2E_PORT}`;
			await page.goto(`${base}/#/landing`);
			await expect(page.getByText("No sessions")).toBeVisible({ timeout: 10_000 });
		});
	});
});
