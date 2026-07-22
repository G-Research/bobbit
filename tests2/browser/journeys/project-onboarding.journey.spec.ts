/**
 * Journey: Project Onboarding — v2 browser smoke
 * Covers: journey-project-onboarding
 * Consolidated from: add-project-browse-modal, add-project-multi-repo-subset,
 *   add-project-post-archive, add-project-preflight, add-project-select-all,
 *   add-project-symlink, add-project-typeahead, and related specs.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
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

/** Preflight endpoint availability probe (older gateways lack it). */
async function preflightAvailable(): Promise<boolean> {
	try {
		const res = await apiFetch("/api/projects/preflight?path=" + encodeURIComponent(tmpdir()));
		return res.status !== 404;
	} catch {
		return false;
	}
}

/** Build a multi-repo fixture: root with N child dirs, each with its own .git/. */
function makeMultiRepoFixture(label: string, names: readonly string[]): string {
	const root = uniqueDir(`multirepo-${label}`);
	for (const name of names) {
		mkdirSync(join(root, name, ".git"), { recursive: true });
		writeFileSync(join(root, name, "README.md"), `# ${name}\n`);
	}
	return root;
}

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

/**
 * Commit an already-complete path through the picker's public selection event.
 * This intentionally bypasses the typeahead debounce: the select-all journey
 * verifies the scan controls, while the dedicated typeahead journey owns typed
 * path/debounce coverage.
 */
async function selectCompletedProjectPath(
	page: import("@playwright/test").Page,
	path: string,
): Promise<void> {
	await page.locator(ADD_PROJECT.picker).evaluate((element, selectedPath) => {
		const picker = element as HTMLElement & { setCompletedPath?: (value: string) => void };
		picker.setCompletedPath?.(selectedPath);
		picker.dispatchEvent(new CustomEvent("directory-select", {
			bubbles: true,
			composed: true,
			detail: { path: selectedPath, source: "browse" },
		}));
	}, path);
	await expect(page.locator(ADD_PROJECT.pickerInput)).toHaveValue(path);
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

		// Skip only if the preflight endpoint is genuinely absent (older gateway).
		const pf = await apiFetch("/api/projects/preflight?path=" + encodeURIComponent(tmpdir()));
		if (pf.status === 404) { testInfo.skip(true, "preflight endpoint unavailable"); return; }

		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
		await openAddProjectDialog(page);
		// Fill the picker input (placeholder "/path/to/project") — this triggers the
		// preflight fetch for the nested-in-project path.
		await page.locator('input[placeholder="/path/to/project"]').fill(child);

		const panel = page.locator('[data-testid="preflight-panel"]').first();
		await expect(panel).toBeVisible({ timeout: 15_000 });
		// Wait for preflight to settle (a check row rendered / loading cleared).
		await expect.poll(async () => {
			const rows = await page.locator('[data-testid="preflight-check"]').count();
			const loading = await panel.getAttribute("data-loading");
			return rows > 0 || loading === null;
		}, { timeout: 15_000 }).toBe(true);
		// Nested-in-project is a fail check → panel must report data-has-fail="1".
		await expect(panel).toHaveAttribute("data-has-fail", "1", { timeout: 15_000 });
		await expect(page.locator('[data-testid="preflight-blocked"]').first()).toBeVisible({ timeout: 10_000 });
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

	// Ported from add-project-select-all.spec.ts (audit: project-onboarding GAP,
	// mutant BR55): a multi-repo scan renders the checklist with a selected-count
	// readout; Deselect all / Select all drive the count text and Continue state.
	test("multi-repo scan selected-count reflects deselect-all / select-all", async ({ page }, testInfo) => {
		test.setTimeout(90_000);
		if (!(await preflightAvailable())) { testInfo.skip(true, "preflight endpoint unavailable"); return; }
		const root = makeMultiRepoFixture("selectall", ["one", "two", "three"]);
		try {
			await openApp(page);
			await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
			await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
			await openAddProjectDialog(page);

			const preflightResponse = page.waitForResponse((response) => {
				try {
					const url = new URL(response.url());
					return url.pathname === "/api/projects/preflight"
						&& url.searchParams.get("path") === root
						&& response.request().method() === "GET";
				} catch {
					return false;
				}
			}, { timeout: 15_000 });
			await selectCompletedProjectPath(page, root);
			const response = await preflightResponse;
			expect(response.ok(), `preflight request failed with HTTP ${response.status()}`).toBe(true);

			const preflight = page.locator(ADD_PROJECT.preflightPanel);
			await expect(preflight).toBeVisible({ timeout: 15_000 });
			await expect.poll(
				async () => (await preflight.getAttribute("data-has-fail")) ?? "loading",
				{ timeout: 15_000 },
			).toBe("0");

			// Path → scan.
			await page.locator("button").filter({ hasText: "Continue" }).first().click();
			await expect(page.locator(ADD_PROJECT.scanChecklist)).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(ADD_PROJECT.step)).toHaveText("scan", { timeout: 10_000 });

			const items = ["repo:one", "repo:two", "repo:three"] as const;
			for (const id of items) {
				await expect(page.locator(ADD_PROJECT.scanCheckboxFor(id))).toBeChecked({ timeout: 10_000 });
			}
			// selected-count readout (mutant target) starts at all-selected.
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 3 of 3", { timeout: 10_000 });

			// Deselect all → count drops to 0 of 3.
			await page.locator(ADD_PROJECT.deselectAll).click();
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 0 of 3", { timeout: 10_000 });

			// Select all → count returns to 3 of 3.
			await page.locator(ADD_PROJECT.selectAll).click();
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 3 of 3", { timeout: 10_000 });
		} finally {
			try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

	// Ported from add-project-post-archive.spec.ts (audit: project-onboarding GAP,
	// mutant BR52): a directory with a ghost .bobbit/ (dir present, no
	// project.yaml) surfaces the preflight archive CTA so the user can archive it.
	test("ghost .bobbit/ directory surfaces the preflight archive CTA", async ({ page }, testInfo) => {
		test.setTimeout(90_000);
		if (!(await preflightAvailable())) { testInfo.skip(true, "preflight endpoint unavailable"); return; }
		const dir = uniqueDir("ghost-bobbit");
		mkdirSync(join(dir, ".bobbit"), { recursive: true });
		writeFileSync(join(dir, ".bobbit", "some-file.txt"), "leftover from a previous install\n");
		writeFileSync(join(dir, "README.md"), "# Test\n");
		try {
			await openApp(page);
			await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
			await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
			await openAddProjectDialog(page);

			await page.locator('input[placeholder="/path/to/project"]').fill(dir);
			await expect(page.locator(ADD_PROJECT.preflightPanel)).toBeVisible({ timeout: 15_000 });
			// The ghost-.bobbit existing check row + its archive CTA (mutant target).
			await expect(
				page.locator('[data-testid="preflight-check"][data-check-id="bobbit.existing"]').first(),
			).toBeVisible({ timeout: 10_000 });
			await expect(page.locator('[data-testid="preflight-archive-cta"]').first()).toBeVisible({ timeout: 10_000 });
		} finally {
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

	// Ported from add-project-multi-repo-subset.spec.ts (audit: project-onboarding
	// GAP, mutant BR64): after deselecting one repo, Continue-with-assistant must
	// route to a session AND the WS autoPrompt must carry ONLY the selected repo
	// subset in its machine-readable JSON block.
	test("multi-repo subset: Continue autoPrompt carries only the selected repo id", async ({ page }, testInfo) => {
		test.setTimeout(120_000);
		if (!(await preflightAvailable())) { testInfo.skip(true, "preflight endpoint unavailable"); return; }
		const root = makeMultiRepoFixture("subset", ["alpha-svc", "beta-svc"]);

		// Capture WS prompt frames (must be attached before the session connects).
		const prompts: string[] = [];
		page.on("websocket", (ws) => {
			ws.on("framesent", (event) => {
				try {
					const payload = typeof event.payload === "string" ? event.payload : event.payload.toString("utf-8");
					const data = JSON.parse(payload);
					if (data?.type === "prompt" && typeof data.text === "string") prompts.push(data.text);
				} catch { /* non-JSON frame */ }
			});
		});

		try {
			await openApp(page);
			await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
			await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
			await openAddProjectDialog(page);

			await page.locator(ADD_PROJECT.pickerInput).fill(root);
			const preflight = page.locator(ADD_PROJECT.preflightPanel);
			await expect(preflight).toBeVisible({ timeout: 15_000 });
			await expect.poll(async () => (await preflight.getAttribute("data-has-fail")) ?? "loading", { timeout: 15_000 }).toBe("0");

			await page.locator("button").filter({ hasText: "Continue" }).first().click();
			await expect(page.locator(ADD_PROJECT.scanChecklist)).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(ADD_PROJECT.step)).toHaveText("scan", { timeout: 10_000 });
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 2 of 2", { timeout: 10_000 });

			// Deselect beta-svc → subset of one.
			await page.locator(ADD_PROJECT.scanCheckboxFor("repo:beta-svc")).click();
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 1 of 2", { timeout: 10_000 });

			// Continue with assistant → routes to a session.
			await page.locator(ADD_PROJECT.continue).click();
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 }).toMatch(/^#\/session\//);

			// The autoPrompt JSON block must reflect ONLY the selected subset.
			const rootBase = basename(root);
			await expect.poll(
				() => prompts.find((t) => t.includes(rootBase)) ?? null,
				{ timeout: 15_000 },
			).not.toBeNull();
			const promptText = prompts.find((t) => t.includes(rootBase))!;
			const jsonMatch = promptText.match(/```json\n([\s\S]*?)\n```/);
			expect(jsonMatch, "autoprompt must contain a ```json block").not.toBeNull();
			const parsed = JSON.parse(jsonMatch![1]!);
			expect(parsed.selectedIds).toEqual(["repo:alpha-svc"]);
		} finally {
			try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});
});
