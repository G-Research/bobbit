/**
 * E2E tests: Single-project sidebar — project folder row always visible.
 *
 * Verifies the "always show project rows" feature: even with only one
 * project registered, the sidebar renders the project folder row with
 * folder icon, project name, settings gear, and new-goal button.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI } from "./ui-helpers.js";

test.describe("Single-project sidebar", () => {
	test("project folder row visible in single-project mode", async ({ page }) => {
		await openApp(page);

		// The sidebar should contain a project folder row.
		// The project header has: chevron, folder icon, project name, settings gear, new-goal button.

		// Settings gear with title="Project settings"
		const settingsGear = page.locator("button[title='Project settings']").first();
		await expect(settingsGear).toBeVisible({ timeout: 10_000 });

		// The project header group container (parent of gear button)
		const projectHeader = settingsGear.locator("xpath=ancestor::div[contains(@class,'group')]").first();
		await expect(projectHeader).toBeVisible();

		// Folder icon (SVG inside the header) — the header contains a colored folder icon span
		// Project name text — uppercase tracking-wider span
		const projectName = projectHeader.locator("span.uppercase").first();
		await expect(projectName).toBeVisible();
		const nameText = await projectName.textContent();
		expect(nameText!.trim().length).toBeGreaterThan(0);

		// New goal button (title starts with "New goal in")
		const newGoalBtn = projectHeader.locator("button[title^='New goal in']");
		await expect(newGoalBtn).toBeVisible();

		// Project row is expanded by default — "Sessions" label should be visible beneath it
		await expect(
			page.getByText("Sessions", { exact: true }).first(),
		).toBeVisible({ timeout: 5_000 });
	});

	test("session creation from project row works", async ({ page }) => {
		await openApp(page);

		// The "New session" button inside the project's Sessions section
		// In multi-project path, button title is "New session in <project name>"
		const newSessionBtn = page.locator("button[title^='New session']").first();
		await expect(newSessionBtn).toBeVisible({ timeout: 10_000 });
		await newSessionBtn.click();

		// Wait for a chat textarea to appear — indicates session was created
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Verify the URL hash contains a session ID
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toMatch(/#\/session\/[a-f0-9-]+/i);
		}).toPass({ timeout: 5_000 });
	});
});
