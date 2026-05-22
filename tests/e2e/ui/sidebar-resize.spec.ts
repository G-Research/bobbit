/**
 * Sidebar resize E2E: drag handle updates width, persists, double-click resets.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";

const SIDEBAR_SELECTOR = ".sidebar-edge";
const HANDLE_SELECTOR = ".sidebar-resize-handle";

async function sidebarWidth(page: Page): Promise<number> {
	return page.evaluate((sel) => {
		const el = document.querySelector(sel) as HTMLElement | null;
		return el ? el.getBoundingClientRect().width : -1;
	}, SIDEBAR_SELECTOR);
}

async function clearWidth(page: Page): Promise<void> {
	await page.evaluate(() => {
		localStorage.removeItem("bobbit-sidebar-width");
		localStorage.removeItem("bobbit-sidebar-collapsed");
	});
}

async function dragHandle(page: Page, deltaX: number): Promise<void> {
	const handle = page.locator(HANDLE_SELECTOR).first();
	await expect(handle).toBeAttached();
	const box = await handle.boundingBox();
	if (!box) throw new Error("handle has no bounding box");
	const startX = box.x + box.width / 2;
	const startY = box.y + box.height / 2;
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(startX + deltaX, startY, { steps: 6 });
	await page.mouse.up();
}

test.describe("Sidebar resize", () => {
	test("default width, drag resize, reload persistence, and double-click reset @smoke", async ({ page }) => {
		await openApp(page);
		await clearWidth(page);
		await page.reload();
		await expect(page.locator(SIDEBAR_SELECTOR).first()).toBeVisible();

		const defaultWidth = await sidebarWidth(page);
		expect(defaultWidth).toBeGreaterThanOrEqual(239);
		expect(defaultWidth).toBeLessThanOrEqual(241);
		await expect(page.locator(HANDLE_SELECTOR).first()).toBeAttached();

		await dragHandle(page, 50);
		const resized = await sidebarWidth(page);
		expect(resized - defaultWidth).toBeGreaterThanOrEqual(40);
		expect(resized - defaultWidth).toBeLessThanOrEqual(60);

		const headerW = await page.evaluate(() => {
			const els = Array.from(document.querySelectorAll<HTMLElement>("[style*='--sidebar-w'], [style*='var(--sidebar-w']"));
			const sidebar = document.querySelector(".sidebar-edge") as HTMLElement | null;
			if (!sidebar) return -1;
			const sidebarW = sidebar.getBoundingClientRect().width;
			for (const el of Array.from(document.querySelectorAll<HTMLElement>("div"))) {
				if (el === sidebar) continue;
				const w = el.getBoundingClientRect().width;
				if (Math.abs(w - sidebarW) < 1.5 && el.style.cssText.includes("--sidebar-w")) return w;
			}
			return els[0]?.getBoundingClientRect().width ?? -1;
		});
		expect(Math.abs(headerW - resized)).toBeLessThan(2);

		await page.reload();
		await expect(page.locator(SIDEBAR_SELECTOR).first()).toBeVisible();
		const reloaded = await sidebarWidth(page);
		expect(Math.abs(reloaded - resized)).toBeLessThan(2);

		await dragHandle(page, 80);
		expect(await sidebarWidth(page)).toBeGreaterThan(310);
		await page.locator(HANDLE_SELECTOR).first().dblclick();
		const resetW = await sidebarWidth(page);
		expect(Math.abs(resetW - 240)).toBeLessThan(2);
	});
});
