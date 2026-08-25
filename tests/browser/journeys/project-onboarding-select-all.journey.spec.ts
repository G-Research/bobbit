/**
 * Journey: Project Onboarding — repository selection count
 * Covers: journey-project-onboarding
 * Ported from: add-project-select-all.
 */
import { rmSync } from "node:fs";
import { test, expect, openApp } from "../../../tests2/browser/_helpers/journey-fixture.js";
import {
	ADD_PROJECT,
	clearAddedProjects,
	makeMultiRepoFixture,
	openAddProjectDialog,
	preflightAvailable,
	selectCompletedProjectPath,
} from "../../../tests2/browser/_helpers/project-onboarding.js";

test.describe("Journey: Project Onboarding — repository selection count", () => {
	test.afterEach(async () => {
		await clearAddedProjects();
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
});
