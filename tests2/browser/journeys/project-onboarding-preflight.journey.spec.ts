/**
 * Journey: Project Onboarding — preflight and typeahead
 * Covers: journey-project-onboarding
 * Consolidated from: add-project-preflight and add-project-typeahead.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, openApp, apiFetch } from "../_helpers/journey-fixture.js";
import {
	ADD_PROJECT,
	clearAddedProjects,
	openAddProjectDialog,
	uniqueDir,
} from "../_helpers/project-onboarding.js";

test.describe("Journey: Project Onboarding — preflight and typeahead", () => {
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
