/**
 * Journey: Project Onboarding — ghost archive CTA
 * Covers: journey-project-onboarding
 * Ported from: add-project-post-archive.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, expect, openApp } from "../../support/helpers/browser/journeys/journey-fixture.js";
import {
	ADD_PROJECT,
	clearAddedProjects,
	openAddProjectDialog,
	preflightAvailable,
	uniqueDir,
} from "../../support/helpers/browser/journeys/project-onboarding.js";

test.describe("Journey: Project Onboarding — ghost archive CTA", () => {
	test.afterEach(async () => {
		await clearAddedProjects();
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
});
