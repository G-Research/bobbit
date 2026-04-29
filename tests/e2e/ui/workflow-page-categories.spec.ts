/**
 * E2E test for the Workflows page Goal/Mission section split.
 *
 * Asserts:
 *  - Both "Goal workflows" and "Mission workflows" section headings render.
 *  - Built-in workflows appear under the correct section.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Workflow page categories", () => {
	test("renders Goal and Mission section headings @smoke", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/workflows");

		await expect(page.getByTestId("wf-section-title-goal")).toHaveText(/goal workflows/i);
		await expect(page.getByTestId("wf-section-title-mission")).toHaveText(/mission workflows/i);

		// Built-in goal workflows live in the goal section.
		const goalSection = page.getByTestId("wf-section-goal");
		await expect(goalSection.locator(".wf-row").filter({ hasText: "General" }).first()).toBeVisible({ timeout: 10_000 });
		await expect(goalSection.locator(".wf-row").filter({ hasText: "Feature" }).first()).toBeVisible();

		// Built-in mission workflow lives in the mission section.
		const missionSection = page.getByTestId("wf-section-mission");
		await expect(missionSection.locator(".wf-row").filter({ hasText: "Mission" }).first()).toBeVisible();

		// Cross-check: the mission workflow row is NOT in the goal section.
		// ("General" must be present in goal section, but a row whose name is exactly "Mission" must not.)
		const goalMissionRow = goalSection.locator(".wf-row-name").filter({ hasText: /^\s*Mission(\s|$)/ });
		await expect(goalMissionRow).toHaveCount(0);
	});
});
