/**
 * E2E tests: Single-project sidebar — project folder row always visible.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";

test.describe("Single-project sidebar", () => {
	test("project folder row is visible and session creation from it works", async ({ page }) => {
		await openApp(page);

		const settingsGear = page.locator("button[title='Project settings']").first();
		await expect(settingsGear).toBeVisible({ timeout: 10_000 });

		const projectHeader = settingsGear.locator("xpath=ancestor::div[contains(@class,'group')]").first();
		await expect(projectHeader).toBeVisible();
		const projectName = projectHeader.locator("span.uppercase").first();
		await expect(projectName).toBeVisible();
		expect((await projectName.textContent())!.trim().length).toBeGreaterThan(0);
		await expect(projectHeader.locator("button[title^='New goal in']")).toBeVisible();
		await expect(page.getByText("Sessions", { exact: true }).first()).toBeVisible({ timeout: 5_000 });

		const newSessionBtn = page.locator("button[title^='New session']").first();
		await expect(newSessionBtn).toBeVisible({ timeout: 10_000 });
		await newSessionBtn.click();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toMatch(/#\/session\/[a-f0-9-]+/i);
		}).toPass({ timeout: 5_000 });
	});
});
