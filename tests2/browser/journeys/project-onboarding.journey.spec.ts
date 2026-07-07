/**
 * Journey: Project Onboarding — v2 browser smoke
 * Covers: journey-project-onboarding
 * Consolidated from: add-project-browse-modal, add-project-multi-repo-subset,
 *   add-project-post-archive, add-project-preflight, add-project-select-all,
 *   add-project-symlink, add-project-typeahead, and related specs.
 */
import { mkdirSync } from "node:fs";
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
	statusSlot:   '[data-testid="add-project-status-slot"]',
	footer:       '[data-testid="add-project-footer"]',
	browseDialog: '[data-testid="add-project-browse-dialog"]',
	browseUp:     '[data-testid="add-project-browse-up"]',
	browseCurrent:'[data-testid="add-project-browse-current"]',
	browseEntry:  '[data-testid="add-project-browse-entry"]',
	browseList:   '[data-testid="add-project-browse-list"]',
	continue:     '[data-testid="add-project-continue"]',
	createDirectory: '[data-testid="add-project-create-directory"]',
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
		// Create a temp dir with a subdirectory so there's something to navigate
		const parent = uniqueDir("browse-entries");
		const child = join(parent, "child-dir");
		mkdirSync(child, { recursive: true });

		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });

		const addBtn = page.getByRole("button", { name: /add project/i }).first();
		await expect(addBtn).toBeVisible({ timeout: 15_000 });
		await addBtn.click();
		await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible({ timeout: 15_000 });

		// Seed the picker with the parent path so the browse modal opens there
		await page.locator(ADD_PROJECT.pickerInput).fill(parent);
		await page.locator(ADD_PROJECT.pickerBrowse).click();
		const modal = page.locator(ADD_PROJECT.browseDialog);
		await expect(modal).toBeVisible({ timeout: 15_000 });

		// Wait for entries to load — browse-list or browse-entry should appear
		const browseList = modal.locator(ADD_PROJECT.browseList);
		const browseEntry = modal.locator(ADD_PROJECT.browseEntry);
		const listOrEntry = await browseList.isVisible({ timeout: 15_000 }).catch(() => false)
			|| await browseEntry.first().isVisible({ timeout: 15_000 }).catch(() => false);
		expect(listOrEntry, "browse modal should show a directory list or entries").toBe(true);

		// Up button should exist (for navigating to parent directory)
		await expect(modal.locator(ADD_PROJECT.browseUp)).toBeVisible({ timeout: 15_000 });

		// Close with Escape
		await page.keyboard.press("Escape");
		await expect(modal).toHaveCount(0, { timeout: 15_000 });
	});

	// Ported from add-project-preflight.spec.ts (audit: project-onboarding GAP):
	// a path nested inside an existing project must surface a fail row and mark
	// the preflight panel data-has-fail="1" (which gates Continue).
	test("nested-in-existing-project path marks preflight data-has-fail=1", async ({ page }, testInfo) => {
		test.setTimeout(90_000);
		const parent = uniqueDir("pf-parent");
		mkdirSync(join(parent, ".bobbit", "config"), { recursive: true });
		mkdirSync(join(parent, ".bobbit", "state"), { recursive: true });
		const child = join(parent, "child");
		mkdirSync(child, { recursive: true });

		const reg = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `pf-parent-${Date.now()}`, rootPath: parent, __e2e_seed_skip__: true }),
		});
		if (!reg.ok) { testInfo.skip(true, `Failed to seed parent project: ${reg.status}`); return; }

		await openAddProjectDialog(page);
		await page.locator(ADD_PROJECT.pickerInput).fill(child);

		const panel = page.locator(ADD_PROJECT.dialog).locator('[data-testid="preflight-panel"]').first();
		if (!await panel.isVisible({ timeout: 15_000 }).catch(() => false)) {
			testInfo.skip(true, "preflight panel unavailable (older gateway)");
			return;
		}
		// Nested-in-project is a fail check → panel must report data-has-fail="1".
		await expect(panel).toHaveAttribute("data-has-fail", "1", { timeout: 15_000 });
		await expect(page.locator('[data-testid="preflight-blocked"]').first()).toBeVisible({ timeout: 10_000 });
	});
});
