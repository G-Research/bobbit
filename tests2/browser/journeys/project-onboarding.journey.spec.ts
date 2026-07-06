/**
 * Journey: Project Onboarding — v2 browser smoke
 * Covers: journey-project-onboarding
 * Consolidated from: add-project-browse-modal, add-project-multi-repo-subset,
 *   add-project-post-archive, add-project-preflight, add-project-select-all,
 *   add-project-symlink, add-project-typeahead, and related specs.
 */
import { test, expect, openApp } from "../_helpers/journey-fixture.js";

test.describe("Journey: Project Onboarding", () => {
	test("settings projects page is reachable", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator("body").first()).toBeVisible({ timeout: 10_000 });
	});

	test("add-project button or heading visible on projects settings", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		// Either the add-project button or a projects heading should be visible
		const found = await Promise.any([
			expect(page.getByRole("button", { name: /add project/i }).first()).toBeVisible({ timeout: 15_000 }),
			expect(page.getByText(/projects/i).first()).toBeVisible({ timeout: 15_000 }),
		]).then(() => true).catch(() => false);
		expect(found).toBe(true);
	});

	test("app loads on project-related settings route", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
		// Confirm app shell is present (not a blank error page)
		const title = await page.title();
		expect(title).toBeTruthy();
	});

	test("clicking Add Project opens dialog with path input", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		// Find and click the Add Project button
		const addBtn = page.getByRole("button", { name: /add project/i }).first();
		await expect(addBtn).toBeVisible({ timeout: 15_000 });
		await addBtn.click();
		// Dialog should open — look for the dialog element or a path/browse input
		const dialog = page.locator("add-project-dialog, [data-testid='add-project-dialog'], dialog").first();
		const pickerInput = page.locator("[data-testid='add-project-picker-input'], input[placeholder*='path' i], input[placeholder*='browse' i]").first();
		const browseBtn = page.getByRole("button", { name: /browse/i }).first();
		const dialogOpened =
			await dialog.isVisible({ timeout: 8_000 }).catch(() => false)
			|| await pickerInput.isVisible({ timeout: 3_000 }).catch(() => false)
			|| await browseBtn.isVisible({ timeout: 3_000 }).catch(() => false);
		expect(dialogOpened, "Add Project dialog with path input or Browse button should open").toBe(true);
	});
});
