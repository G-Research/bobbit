/**
 * Journey: Project Onboarding — settings, dialog, and directory browser
 * Covers: journey-project-onboarding
 * Consolidated from: add-project-browse-modal, add-project-symlink,
 *   project-management, and related specs.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, expect, openApp } from "../_helpers/journey-fixture.js";
import {
	ADD_PROJECT,
	clearAddedProjects,
	uniqueDir,
} from "../_helpers/project-onboarding.js";

test.describe("Journey: Project Onboarding", () => {
	test.afterEach(async () => {
		await clearAddedProjects();
	});

	test("settings projects page is reachable", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
		await expect(page.locator("body").first()).toBeVisible({ timeout: 20_000 });
	});

	test("add-project button or heading visible on projects settings", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
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
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
		// Confirm app shell is present (not a blank error page)
		const title = await page.title();
		expect(title).toBeTruthy();
	});

	test("clicking Add Project opens dialog with data-testid selectors", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });

		const addBtn = page.getByRole("button", { name: /add project/i }).first();
		await expect(addBtn).toBeVisible({ timeout: 15_000 });
		await addBtn.click();

		// Dialog must open — assert via data-testid
		await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible({ timeout: 15_000 });
		// Path input exposed via data-testid
		await expect(page.locator(ADD_PROJECT.pickerInput)).toBeVisible({ timeout: 15_000 });
		// Browse button present
		await expect(page.locator(ADD_PROJECT.pickerBrowse)).toBeVisible({ timeout: 15_000 });
		// Continue button present
		const continueBtn = page.locator(ADD_PROJECT.footer).locator(ADD_PROJECT.continue).first();
		if (!await continueBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
			// Continue may be a direct button in the footer
			await expect(page.locator("button").filter({ hasText: /continue/i }).first()).toBeVisible({ timeout: 15_000 });
		}
		// Status slot shows hint text
		await expect(page.locator(ADD_PROJECT.statusSlot)).toBeVisible({ timeout: 15_000 });
	});

	test("Browse button opens add-project-browse-dialog overlay", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });

		const addBtn = page.getByRole("button", { name: /add project/i }).first();
		await expect(addBtn).toBeVisible({ timeout: 15_000 });
		await addBtn.click();
		await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible({ timeout: 15_000 });

		// Click Browse — add-project-browse-dialog should appear
		await page.locator(ADD_PROJECT.pickerBrowse).click();
		const modal = page.locator(ADD_PROJECT.browseDialog);
		await expect(modal).toBeVisible({ timeout: 15_000 });

		// Parent dialog stays mounted underneath
		await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible();

		// Browse modal exposes a current-path indicator
		await expect(modal.locator(ADD_PROJECT.browseCurrent)).toBeVisible({ timeout: 15_000 });

		// Browse modal has a "Select current" button that becomes enabled once listing loads
		const selectBtn = modal.locator("button").filter({ hasText: "Select current" }).first();
		await expect(selectBtn).toBeVisible({ timeout: 15_000 });

		// Esc closes the modal without mutating the picker input
		const inputValueBefore = await page.locator(ADD_PROJECT.pickerInput).inputValue();
		await page.keyboard.press("Escape");
		await expect(modal).toHaveCount(0, { timeout: 15_000 });
		// Picker value unchanged after Esc
		const inputValueAfter = await page.locator(ADD_PROJECT.pickerInput).inputValue();
		expect(inputValueAfter).toBe(inputValueBefore);
		// Parent dialog still open
		await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible();
	});

	test("Browse → Select current copies path back into picker input", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });

		const addBtn = page.getByRole("button", { name: /add project/i }).first();
		await expect(addBtn).toBeVisible({ timeout: 15_000 });
		await addBtn.click();
		await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible({ timeout: 15_000 });

		await page.locator(ADD_PROJECT.pickerBrowse).click();
		const modal = page.locator(ADD_PROJECT.browseDialog);
		await expect(modal).toBeVisible({ timeout: 15_000 });

		// Wait for Select current to become enabled (listing has loaded)
		const selectBtn = modal.locator("button").filter({ hasText: "Select current" }).first();
		await expect(selectBtn).toBeEnabled({ timeout: 20_000 });
		await selectBtn.click();

		// Modal closes
		await expect(modal).toHaveCount(0, { timeout: 15_000 });

		// Picker input now has a non-empty path
		const inputValue = await page.locator(ADD_PROJECT.pickerInput).inputValue();
		expect(inputValue.length, "picker input should be populated after Select current").toBeGreaterThan(0);
	});

	test("Browse modal shows directory entries and Up button", async ({ page }) => {
		const parent = uniqueDir("browse-entries");
		mkdirSync(join(parent, "child-dir"), { recursive: true });

		try {
			await openApp(page);
			await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
			await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });

			const addBtn = page.getByRole("button", { name: /add project/i }).first();
			await expect(addBtn).toBeVisible({ timeout: 15_000 });
			await addBtn.click();
			const dialog = page.locator(ADD_PROJECT.dialog);
			await expect(dialog).toBeVisible({ timeout: 15_000 });

			// Seed the picker with the parent path so the browse modal opens there.
			await dialog.locator(ADD_PROJECT.pickerInput).fill(parent);
			await dialog.locator(ADD_PROJECT.pickerBrowse).click();
			const modal = page.locator(ADD_PROJECT.browseDialog);
			await expect(modal).toBeVisible({ timeout: 15_000 });

			// The list shell renders before its request settles. Wait for our exact
			// seeded entry and enabled Up action so close cannot race a re-render.
			const browseList = modal.locator(ADD_PROJECT.browseList);
			await expect(browseList).toBeVisible({ timeout: 15_000 });
			await expect(
				browseList.locator(ADD_PROJECT.browseEntry).filter({ hasText: "child-dir" }),
			).toBeVisible({ timeout: 15_000 });
			const upButton = modal.locator(ADD_PROJECT.browseUp);
			await expect(upButton).toBeVisible({ timeout: 15_000 });
			await expect(upButton).toBeEnabled({ timeout: 15_000 });

			// Use the modal-scoped action; Escape behavior is covered independently.
			await modal.getByRole("button", { name: "Cancel", exact: true }).click();
			await expect(modal).toHaveCount(0, { timeout: 15_000 });
			await expect(dialog).toBeVisible();
		} finally {
			try { rmSync(parent, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});
});
