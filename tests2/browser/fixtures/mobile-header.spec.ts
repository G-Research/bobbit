import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/mobile-header.html")}`;

test.describe("Mobile header always visible", () => {
	test.use({ viewport: { width: 375, height: 667 } }); // iPhone SE size

	test("header is visible initially", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const header = page.locator("#app-header");
		await expect(header).toBeVisible();
	});

	test("header remains visible after scrolling down", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Scroll down significantly
		await page.evaluate(() => (window as any).__scrollTo(300));

		const header = page.locator("#app-header");
		await expect(header).toBeVisible();

		// Verify the header has NOT been translated off-screen
		const transform = await header.evaluate((el: HTMLElement) => el.style.transform);
		expect(transform === "" || transform === "translateY(0)" || transform === "translateY(0px)").toBe(true);
	});

	test("header remains visible after scrolling down and up", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Scroll down then up
		await page.evaluate(() => (window as any).__scrollTo(300));
		await page.evaluate(() => (window as any).__scrollTo(100));

		const header = page.locator("#app-header");
		await expect(header).toBeVisible();
	});

	test("padding-top is set on app-main", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const paddingTop = await page.locator("#app-main").evaluate(
			(el: HTMLElement) => el.style.paddingTop,
		);
		expect(paddingTop).not.toBe("");
		expect(parseInt(paddingTop)).toBeGreaterThan(0);
	});
});
