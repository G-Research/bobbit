/**
 * Unit tests for sidebar mobile behavior helpers.
 *
 * Stories covered: SB-33
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/sidebar-mobile.html").replace(/\\/g, "/")}`;

test.describe("SB-33: Mobile sidebar behavior", () => {
	test("desktop: buttons hidden (hover-reveal), py-0.5 padding", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__mobileSidebar.getMobileSidebarBehavior(true)
		);
		expect(r.buttonsAlwaysVisible).toBe(false);
		expect(r.rowPadding).toBe("py-0.5");
		expect(r.showHamburgerMenu).toBe(false);
		expect(r.autoCloseOnSelect).toBe(false);
	});

	test("mobile: buttons always visible, py-1 padding (larger touch targets)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__mobileSidebar.getMobileSidebarBehavior(false)
		);
		expect(r.buttonsAlwaysVisible).toBe(true);
		expect(r.rowPadding).toBe("py-1");
	});

	test("mobile: auto-close on session select", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__mobileSidebar.getMobileSidebarBehavior(false)
		);
		expect(r.autoCloseOnSelect).toBe(true);
	});

	test("mobile: hamburger menu shown", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__mobileSidebar.getMobileSidebarBehavior(false)
		);
		expect(r.showHamburgerMenu).toBe(true);
	});
});
