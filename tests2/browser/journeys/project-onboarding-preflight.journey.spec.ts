/**
 * Journey: Project Onboarding — preflight and multi-repo selection
 * Covers: journey-project-onboarding
 * Consolidated from: add-project-preflight, add-project-post-archive,
 *   add-project-select-all, add-project-symlink, and add-project-multi-repo-subset.
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

test.describe("Journey: Project Onboarding", () => {
	test.afterEach(async () => {
		await clearAddedProjects();
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

			await page.locator(ADD_PROJECT.pickerInput).fill(root);
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
