/**
 * Unit tests for sidebar staff rendering helpers.
 *
 * Stories covered: SB-31
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/sidebar-staff-rendering.html").replace(/\\/g, "/")}`;

test.describe("SB-31: Staff row rendering", () => {
	test("staff with active streaming session", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__staffRendering.getStaffRowInfo(
				{ name: "greeter", retired: false },
				{ status: "streaming" }
			)
		);
		expect(r.hasActiveSession).toBe(true);
		expect(r.statusIndicator).toBe("active");
		expect(r.showWakeButton).toBe(false);
	});

	test("staff with active busy session", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__staffRendering.getStaffRowInfo(
				{ name: "greeter", retired: false },
				{ status: "busy" }
			)
		);
		expect(r.statusIndicator).toBe("active");
	});

	test("staff with idle session", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__staffRendering.getStaffRowInfo(
				{ name: "greeter", retired: false },
				{ status: "idle" }
			)
		);
		expect(r.statusIndicator).toBe("idle");
		expect(r.showWakeButton).toBe(false);
	});

	test("staff with no session shows wake button", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__staffRendering.getStaffRowInfo(
				{ name: "greeter", retired: false },
				null
			)
		);
		expect(r.showWakeButton).toBe(true);
		expect(r.statusIndicator).toBe("none");
		expect(r.hasActiveSession).toBe(false);
	});

	test("retired staff is dimmed and has no wake button", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__staffRendering.getStaffRowInfo(
				{ name: "old-greeter", retired: true },
				null
			)
		);
		expect(r.dimmed).toBe(true);
		expect(r.showWakeButton).toBe(false);
		expect(r.isRetired).toBe(true);
	});

	test("staff name is preserved", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() =>
			(window as any).__staffRendering.getStaffRowInfo(
				{ name: "my-staff-member", retired: false },
				null
			)
		);
		expect(r.name).toBe("my-staff-member");
	});
});
