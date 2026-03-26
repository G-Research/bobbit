import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/back-button-goal.html")}`;

test.describe("Back button after goal creation", () => {
	test("back button should reach sessions list, not stale assistant session", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Run the navigation sequence: sessions → assistant → goal dashboard (push)
		// Then press back and get the resulting hash
		const hashAfterBack = await page.evaluate(() => (window as any).__runTest());

		// The bug: without replace:true, back goes to #/session/assistant-123
		// instead of #/ (sessions list).
		// This assertion checks for the CORRECT behavior — it will FAIL while the bug exists.
		expect(
			hashAfterBack,
			"Expected back navigation to reach sessions list but got assistant session",
		).toBe("#/");
	});
});
