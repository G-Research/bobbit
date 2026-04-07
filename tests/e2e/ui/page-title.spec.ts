/**
 * Page title E2E test: verify dynamic document.title reflects active project.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";

test.describe("Dynamic page title", () => {
	test("shows active project name with interpunct and Bobbit", async ({ page }) => {
		await openApp(page);

		// The gateway harness auto-creates a default project.
		// Wait for the title to update after projects load and render cycle runs.
		await expect(async () => {
			const title = await page.evaluate(() => document.title);
			expect(title).toContain("·");
			expect(title).toContain("Bobbit");
			expect(title).toMatch(/.+ · Bobbit$/);
		}).toPass({ timeout: 5000 });
	});
});
