/**
 * Journey: Project Onboarding — navigation, dialog, and browsing
 * Covers: journey-project-onboarding
 * Consolidated from: add-project-browse-modal, add-project-typeahead,
 *   project-management, and related specs.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, openApp, apiFetch } from "../_helpers/journey-fixture.js";

/** Stable selectors from tests/e2e/ui/add-project-helpers.ts */
const ADD_PROJECT = {
	dialog:       '[data-testid="add-project-dialog"]',
	picker:       '[data-testid="add-project-picker"]',
	pickerInput:  '[data-testid="directory-picker-input"]',
	pickerBrowse: '[data-testid="directory-picker-browse"]',
	pickerSuggestions: '[data-testid="directory-picker-suggestions"]',
	pickerSuggestion: '[data-testid="directory-picker-suggestion"]',
	statusSlot:   '[data-testid="add-project-status-slot"]',
	footer:       '[data-testid="add-project-footer"]',
	browseDialog: '[data-testid="add-project-browse-dialog"]',
	browseUp:     '[data-testid="add-project-browse-up"]',
	browseCurrent:'[data-testid="add-project-browse-current"]',
	browseEntry:  '[data-testid="add-project-browse-entry"]',
	browseList:   '[data-testid="add-project-browse-list"]',
	continue:     '[data-testid="add-project-continue"]',
	createDirectory: '[data-testid="add-project-create-directory"]',
	preflightPanel:'[data-testid="preflight-panel"]',
	step:         '[data-testid="add-project-step"]',
	scanChecklist:'[data-testid="add-project-scan-checklist"]',
	selectAll:    '[data-testid="add-project-select-all"]',
	deselectAll:  '[data-testid="add-project-deselect-all"]',
	selectedCount:'[data-testid="add-project-selected-count"]',
	scanCheckboxFor: (id: string) => `[data-testid="add-project-scan-checkbox-${id}"]`,
} as const;

let _dirCounter = 0;
function uniqueDir(label: string): string {
	const dir = join(
		tmpdir(),
		`bobbit-v2-onb-${label}-${process.env.E2E_PORT ?? "0"}-${Date.now()}-${++_dirCounter}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function clearAddedProjects(): Promise<void> {
	try {
		const res = await apiFetch("/api/projects");
		const data = await res.json();
		const projects: Array<{ id: string; name: string }> = data.projects || data || [];
		for (const p of projects) {
			if (p.name === "default") continue;
			await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
		}
	} catch {
		// best-effort cleanup
	}
}

/** Open the Add Project dialog; returns the input locator. */
async function openAddProjectDialog(page: import("@playwright/test").Page): Promise<void> {
	await page.locator("button").filter({ hasText: "Add Project" }).first().click();
	await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible({ timeout: 15_000 });
	await expect(page.locator(ADD_PROJECT.pickerInput)).toBeVisible({ timeout: 15_000 });
}

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
		// Create a temp dir with a subdirectory so there's something to navigate.
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

	// Ported from add-project-typeahead.spec.ts (audit: project-onboarding GAP,
	// mutant BR49): typing a parent path with named children renders the
	// absolutely-positioned suggestion overlay populated by /api/browse-directory,
	// containing at least one matching child suggestion.
	test("typing a parent-prefix renders the directory-picker suggestion overlay", async ({ page }) => {
		test.setTimeout(90_000);
		const parent = uniqueDir("typeahead-parent");
		mkdirSync(join(parent, "alpha-child", "nested-child"), { recursive: true });
		mkdirSync(join(parent, "alpha-other", "nested-child"), { recursive: true });
		mkdirSync(join(parent, "beta"), { recursive: true });
		writeFileSync(join(parent, "alpha-child", "README.md"), "hello\n");

		try {
			await openApp(page);
			await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
			await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
			await openAddProjectDialog(page);

			const input = page.locator(ADD_PROJECT.pickerInput);
			// Type the parent path + "/alpha" so the picker queries the parent and
			// filters children by basename "alpha".
			await input.fill(join(parent, "alpha"));

			// The absolutely-positioned suggestion overlay must render (this is the
			// container the mutant strips the testid from) and hold at least one of
			// our fixture children.
			const overlay = page.locator(ADD_PROJECT.pickerSuggestions);
			await expect(overlay).toBeVisible({ timeout: 8_000 });
			await expect.poll(
				async () => {
					const paths = await overlay
						.locator(ADD_PROJECT.pickerSuggestion)
						.evaluateAll((els) => els.map((el) => el.getAttribute("data-path") ?? ""));
					return paths.filter((p) => p.includes("alpha-")).length;
				},
				{ timeout: 8_000 },
			).toBeGreaterThanOrEqual(1);
		} finally {
			try { rmSync(parent, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

});
