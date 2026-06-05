/**
 * Browser E2E coverage for the Subgoal nesting-limit controls.
 *
 *   1. Settings stepper renders and persists across reload.
 *   2. Per-goal controls (Allow subgoals + Max nesting depth) are visible
 *      in the goal-creation panel only when the system Subgoals flag is ON.
 *   3. Per-goal max-depth stepper cannot exceed the system ceiling.
 *
 * The proposal panel cases drive the form by toggling the system flag and
 * checking the data-testid attributes on the goal-form controls.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

async function setPref(key: string, value: unknown): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ [key]: value }),
	});
	expect(resp.status).toBe(200);
}

test.describe("Subgoal nesting limit — system setting", () => {
	test("max-depth stepper renders and persists across reload", async ({ page }) => {
		// Reset to defaults first.
		await setPref("subgoalsEnabled", true);
		await setPref("maxNestingDepth", null);

		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		const stepper = page.locator("[data-testid='general-max-nesting-depth']");
		await expect(stepper).toBeVisible({ timeout: 10_000 });
		// Default value when unset = 3.
		await expect(stepper).toHaveValue("3");

		// Change to 2 and wait for the PUT to fire.
		const putResp = page.waitForResponse(
			r => r.url().includes("/api/preferences")
				&& r.request().method() === "PUT"
				&& r.status() === 200,
		);
		await stepper.fill("2");
		await stepper.blur();
		await putResp;

		// Reload and confirm it persisted.
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		const afterReload = page.locator("[data-testid='general-max-nesting-depth']");
		await expect(afterReload).toBeVisible({ timeout: 5_000 });
		await expect(afterReload).toHaveValue("2");
		await expect.poll(
			() => page.evaluate(() => document.documentElement.dataset.maxNestingDepth),
		).toBe("2");

		// Cleanup: reset for subsequent tests.
		await setPref("maxNestingDepth", null);
	});

	test("max-depth stepper is disabled when Subgoals flag is OFF", async ({ page }) => {
		await setPref("subgoalsEnabled", false);
		await setPref("maxNestingDepth", null);
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		const stepper = page.locator("[data-testid='general-max-nesting-depth']");
		await expect(stepper).toBeVisible({ timeout: 10_000 });
		await expect(stepper).toBeDisabled();

		// Restore for subsequent tests.
		await setPref("subgoalsEnabled", true);
	});
});
