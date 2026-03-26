import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/mobile-goal-preview.html")}`;

test.describe("Mobile goal preview panel padding", () => {
	test.use({ viewport: { width: 375, height: 667 } }); // iPhone SE

	test("Title field is not hidden behind fixed header", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const header = page.locator("#app-header");
		const titleLabel = page.locator("#title-label");

		await expect(header).toBeVisible();
		await expect(titleLabel).toBeVisible();

		// Get the bottom edge of the fixed header
		const headerBox = await header.boundingBox();
		expect(headerBox).toBeTruthy();
		const headerBottom = headerBox!.y + headerBox!.height;

		// Get the top edge of the Title label
		const titleBox = await titleLabel.boundingBox();
		expect(titleBox).toBeTruthy();
		const titleTop = titleBox!.y;

		// The Title label must be at or below the header's bottom edge.
		// Without the CSS fix, the Title sits under the fixed header (titleTop < headerBottom).
		expect(titleTop).toBeGreaterThanOrEqual(headerBottom);
	});

	test("scroll container has padding-top for mobile header", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const paddingTop = await page.locator("#scroll-container").evaluate(
			(el: HTMLElement) => window.getComputedStyle(el).paddingTop,
		);

		const paddingValue = parseInt(paddingTop);
		// The scroll container should have padding-top >= mobile header height (60px)
		// to prevent content from being hidden behind the fixed header.
		// Without the fix, it only has the base p-5 padding (20px).
		expect(paddingValue).toBeGreaterThanOrEqual(60);
	});
});
