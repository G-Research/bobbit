/**
 * Add Project — Select all / Deselect all checklist controls.
 *
 * Pins:
 *   - `add-project-deselect-all` clears the selection; `add-project-selected-count`
 *     drops to "Selected 0 of N"; the assistant Continue button becomes disabled.
 *   - `add-project-select-all` re-checks every row; count returns to "N of N";
 *     Continue re-enables.
 */
import { test, expect } from "../gateway-harness.js";
import { rmSync } from "node:fs";
import {
	ADD_PROJECT,
	openAddProjectDialog,
	makeMultiRepoFixture,
	clearProjects,
	preflightAvailable,
} from "./add-project-helpers.js";

test.describe("Add Project — Select all / Deselect all", () => {
	test.afterEach(async () => {
		await clearProjects();
	});

	test("Deselect all disables Continue; Select all re-enables it", async ({ page }, testInfo) => {
		if (!(await preflightAvailable())) testInfo.skip(true, "preflight endpoint unavailable");
		testInfo.setTimeout(60_000);

		const fixture = makeMultiRepoFixture("selectall", ["one", "two", "three"]);

		try {
			await openAddProjectDialog(page);
			await page.locator(ADD_PROJECT.pickerInput).fill(fixture.root);

			const preflight = page.locator(ADD_PROJECT.preflightPanel);
			await expect(preflight).toBeVisible({ timeout: 8_000 });
			await expect.poll(
				async () => (await preflight.getAttribute("data-has-fail")) ?? "loading",
				{ timeout: 8_000 },
			).toBe("0");

			// Path → scan.
			await page.locator("button").filter({ hasText: "Continue" }).first().click();
			await expect(page.locator(ADD_PROJECT.scanChecklist)).toBeVisible({ timeout: 10_000 });
			await expect(page.locator(ADD_PROJECT.step)).toHaveText("scan");

			const items = ["repo:one", "repo:two", "repo:three"] as const;
			for (const id of items) {
				await expect(page.locator(ADD_PROJECT.scanCheckboxFor(id))).toBeChecked();
			}
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 3 of 3");

			// Deselect all.
			const continueBtn = page.locator(ADD_PROJECT.continue).locator("xpath=ancestor::button");
			await page.locator(ADD_PROJECT.deselectAll).click();
			for (const id of items) {
				await expect(page.locator(ADD_PROJECT.scanCheckboxFor(id))).not.toBeChecked();
			}
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 0 of 3");
			await expect(continueBtn).toBeDisabled();
			// Deselect all itself is now disabled (selected===0), Select all is enabled.
			await expect(page.locator(ADD_PROJECT.deselectAll)).toBeDisabled();
			await expect(page.locator(ADD_PROJECT.selectAll)).toBeEnabled();

			// Select all.
			await page.locator(ADD_PROJECT.selectAll).click();
			for (const id of items) {
				await expect(page.locator(ADD_PROJECT.scanCheckboxFor(id))).toBeChecked();
			}
			await expect(page.locator(ADD_PROJECT.selectedCount)).toHaveText("Selected 3 of 3");
			await expect(continueBtn).toBeEnabled();
			// Now Select all is disabled (everything already selected), Deselect all is enabled.
			await expect(page.locator(ADD_PROJECT.selectAll)).toBeDisabled();
			await expect(page.locator(ADD_PROJECT.deselectAll)).toBeEnabled();
		} finally {
			try { rmSync(fixture.root, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});
});
