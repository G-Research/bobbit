/**
 * Page title E2E test: verify dynamic document.title reflects active project.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";

test.describe("Dynamic page title", () => {
	test("shows active project name with interpunct and Bobbit", async ({ page }) => {
		await openApp(page);

		// The gateway harness auto-creates a default project.
		// After openApp, the title should reflect the active project.
		const title = await page.evaluate(() => document.title);

		expect(title).toContain("·");
		expect(title).toContain("Bobbit");
		// Title format: "<ProjectName> · Bobbit"
		expect(title).toMatch(/.+ · Bobbit$/);
	});
});
