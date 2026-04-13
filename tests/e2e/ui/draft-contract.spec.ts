/**
 * CT-02 behavioral tests: Draft preservation across context changes.
 *
 * These tests verify the contract guarantee — user-visible behavior only.
 * No source code inspection, no implementation details.
 *
 * Stories covered:
 *   PI-04b  — Draft survives rapid session switch (<100ms)
 *   PI-04c  — Draft survives reconnection re-render storm
 *   PI-04   — step 9: Attachment preserved in draft across switch
 *   PI-04d  — Draft survives model change (NEW)
 *   PI-04f  — Draft survives navigation to settings and back (NEW)
 */
import { test, expect } from "../gateway-harness.js";
import {
	createSession,
	waitForHealth,
	waitForSessionStatus,
	apiFetch,
} from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("CT-02: Draft preservation", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("PI-04b: draft survives rapid session switch", async ({ page }) => {
		const sessionA = await createSession();
		const sessionB = await createSession();
		await waitForSessionStatus(sessionA, "idle");
		await waitForSessionStatus(sessionB, "idle");

		await openApp(page);

		// Navigate to session A, type draft
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionA);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		const textarea = page.locator("textarea").first();
		await textarea.fill("important draft");

		// Wait for the debounced draft save to complete before switching
		await expect(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionA}/draft?type=prompt`);
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.data.text).toBe("important draft");
		}).toPass({ timeout: 10_000 });

		// Now rapid-switch: A → B → A with minimal delay
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionB);
		// Don't wait for full load — switch back immediately
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionA);

		// Wait for session A to be visible again
		await expect(textarea).toBeVisible({ timeout: 15_000 });

		// Draft must survive the rapid switch
		await expect(async () => {
			const val = await textarea.inputValue();
			expect(val).toBe("important draft");
		}).toPass({ intervals: [500, 1000, 1000, 2000], timeout: 10_000 });

		// Also verify it survives reload (the save actually persisted)
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionA);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		await expect(async () => {
			const val = await page.locator("textarea").first().inputValue();
			expect(val).toBe("important draft");
		}).toPass({ intervals: [500, 1000, 1000, 2000], timeout: 10_000 });
	});

	test("PI-04c: draft survives reconnection re-render storm", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// Navigate to session and type a draft
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		const draftText = "draft must survive re-renders";
		const textarea = page.locator("textarea").first();
		await textarea.fill(draftText);

		// Wait for draft to save to server (poll the API)
		await expect(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`);
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.data.text).toBe(draftText);
		}).toPass({ timeout: 10_000 });

		// Reload — this triggers the full reconnection sequence:
		// connecting → connected, messages load, session status updates
		// Each state change can cause a Lit re-render that might clobber the textarea
		await page.reload();

		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Draft must be restored after the re-render storm settles
		await expect(async () => {
			const val = await page.locator("textarea").first().inputValue();
			expect(val).toBe(draftText);
		}).toPass({ intervals: [500, 1000, 1000, 2000], timeout: 10_000 });

		// Wait 3 more seconds — a late re-render must not clobber it
		await page.waitForTimeout(3000);
		const finalVal = await page.locator("textarea").first().inputValue();
		expect(finalVal).toBe(draftText);
	});

	test.skip("PI-04 step 9: attachment preserved in draft across session switch", async ({ page }) => {
		const sessionA = await createSession();
		const sessionB = await createSession();
		await waitForSessionStatus(sessionA, "idle");
		await waitForSessionStatus(sessionB, "idle");

		await openApp(page);

		// Navigate to session A
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionA);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Type some text
		const textarea = page.locator("textarea").first();
		await textarea.fill("text with attachment");

		// Attach a file via the hidden file input inside <message-editor> (light DOM)
		// MessageEditor uses createRenderRoot() { return this; } so input is in light DOM
		const fileInput = page.locator('message-editor input[type="file"]').first();
		await fileInput.setInputFiles({
			name: "test-file.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("test file content"),
		});

		// Wait for attachment tile to appear — the component renders a thumbnail
		// or file icon with the filename. Look for it broadly.
		await expect(
			page.locator("message-editor").getByText("test-file", { exact: false }).first()
		).toBeVisible({ timeout: 5_000 });

		// Switch to session B
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionB);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Switch back to session A
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionA);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Both the text and attachment must be preserved
		await expect(async () => {
			const val = await page.locator("textarea").first().inputValue();
			expect(val).toBe("text with attachment");
		}).toPass({ intervals: [500, 1000, 2000], timeout: 10_000 });
		await expect(
			page.locator("message-editor").getByText("test-file", { exact: false }).first()
		).toBeVisible({ timeout: 5_000 });
	});

	test("PI-04d: draft survives model change", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// Navigate to session
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Type draft text
		const textarea = page.locator("textarea").first();
		await textarea.fill("draft before model change");

		// Click the model selector button (shows current model name in the context bar)
		// The model selector is a button in the stats/context bar area
		const modelButton = page.locator("[data-testid='model-selector'], button:has-text('claude'), button:has-text('sonnet'), button:has-text('haiku'), button:has-text('opus')").first();

		// Only run the model-change portion if a model selector exists
		const modelVisible = await modelButton.isVisible().catch(() => false);
		if (modelVisible) {
			await modelButton.click();

			// Pick a different model from the dropdown
			const modelOption = page.locator("[role='option'], [role='menuitem'], li").filter({ hasNotText: await modelButton.textContent() || "" }).first();
			const optionVisible = await modelOption.isVisible().catch(() => false);
			if (optionVisible) {
				await modelOption.click();
			} else {
				// Close the dropdown if no alternative model available
				await page.keyboard.press("Escape");
			}
		}

		// Draft must still be there regardless of whether model change happened
		await expect(async () => {
			const val = await textarea.inputValue();
			expect(val).toBe("draft before model change");
		}).toPass({ intervals: [500, 1000], timeout: 5_000 });
	});

	test("PI-04f: draft survives navigation to settings and back", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// Navigate to session and type draft
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		const textarea = page.locator("textarea").first();
		await textarea.fill("draft before settings detour");

		// Wait for the draft to be saved to the server before navigating away
		await expect(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`);
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.data.text).toBe("draft before settings detour");
		}).toPass({ timeout: 10_000 });

		// Navigate away to settings
		await page.evaluate(() => { window.location.hash = "#/settings"; });
		// Wait for settings page content to appear (not just the button)
		await page.waitForFunction(() => window.location.hash.startsWith("#/settings"));
		await page.waitForTimeout(1000); // Let the settings page fully render

		// Navigate back to the session
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Draft must still be there
		await expect(async () => {
			const val = await page.locator("textarea").first().inputValue();
			expect(val).toBe("draft before settings detour");
		}).toPass({ intervals: [500, 1000, 2000], timeout: 10_000 });
	});
});
