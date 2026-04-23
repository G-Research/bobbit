/**
 * Sidebar resize E2E: drag handle updates width, persists, double-click resets.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";

const SIDEBAR_SELECTOR = ".sidebar-edge";
const HANDLE_SELECTOR = ".sidebar-resize-handle";

async function sidebarWidth(page: import("@playwright/test").Page): Promise<number> {
	return page.evaluate((sel) => {
		const el = document.querySelector(sel) as HTMLElement | null;
		return el ? el.getBoundingClientRect().width : -1;
	}, SIDEBAR_SELECTOR);
}

test.describe("Sidebar resize", () => {
	// Clear persisted width once, after openApp, so it doesn't stomp reloads.
	async function clearWidth(page: import("@playwright/test").Page) {
		await page.evaluate(() => {
			try { localStorage.removeItem("bobbit-sidebar-width"); } catch {}
			try { localStorage.removeItem("bobbit-sidebar-collapsed"); } catch {}
		});
	}

	test("default 240px and handle visible @smoke", async ({ page }) => {
		await openApp(page);
		await clearWidth(page);
		await page.reload();
		await expect(page.locator(SIDEBAR_SELECTOR).first()).toBeVisible();
		const w = await sidebarWidth(page);
		expect(w).toBeGreaterThanOrEqual(239);
		expect(w).toBeLessThanOrEqual(241);
		await expect(page.locator(HANDLE_SELECTOR).first()).toBeAttached();
	});

	test("drag right by ~50px grows width by ~50px", async ({ page }) => {
		await openApp(page);
		await clearWidth(page);
		await page.reload();
		await expect(page.locator(SIDEBAR_SELECTOR).first()).toBeVisible();
		const handle = page.locator(HANDLE_SELECTOR).first();
		await expect(handle).toBeAttached();
		const box = await handle.boundingBox();
		if (!box) throw new Error("handle has no bounding box");
		const startX = box.x + box.width / 2;
		const startY = box.y + box.height / 2;

		const before = await sidebarWidth(page);
		await page.mouse.move(startX, startY);
		await page.mouse.down();
		await page.mouse.move(startX + 25, startY, { steps: 5 });
		await page.mouse.move(startX + 50, startY, { steps: 5 });
		await page.mouse.up();

		const after = await sidebarWidth(page);
		expect(after - before).toBeGreaterThanOrEqual(40);
		expect(after - before).toBeLessThanOrEqual(60);

		// Header strip must stay aligned with sidebar.
		const headerW = await page.evaluate(() => {
			// Header strip is first child after shell top bar — select by var usage.
			const els = Array.from(document.querySelectorAll<HTMLElement>("[style*='--sidebar-w'], [style*='var(--sidebar-w']"));
			// Fallback: header strip is an element with same width as sidebar, first sibling of app shell
			const sidebar = document.querySelector(".sidebar-edge") as HTMLElement | null;
			if (!sidebar) return -1;
			const sidebarW = sidebar.getBoundingClientRect().width;
			// Find any element (not the sidebar) whose width matches within 1px.
			for (const el of Array.from(document.querySelectorAll<HTMLElement>("div"))) {
				if (el === sidebar) continue;
				const w = el.getBoundingClientRect().width;
				if (Math.abs(w - sidebarW) < 1.5 && el.style.cssText.includes("--sidebar-w")) return w;
			}
			return els[0]?.getBoundingClientRect().width ?? -1;
		});
		expect(Math.abs(headerW - after)).toBeLessThan(2);
	});

	test("width persists across reload", async ({ page }) => {
		await openApp(page);
		await clearWidth(page);
		await page.reload();
		await expect(page.locator(SIDEBAR_SELECTOR).first()).toBeVisible();
		const handle = page.locator(HANDLE_SELECTOR).first();
		const box = await handle.boundingBox();
		if (!box) throw new Error("handle has no bounding box");
		const startX = box.x + box.width / 2;
		const startY = box.y + box.height / 2;
		await page.mouse.move(startX, startY);
		await page.mouse.down();
		await page.mouse.move(startX + 60, startY, { steps: 6 });
		await page.mouse.up();

		const after = await sidebarWidth(page);
		expect(after).toBeGreaterThan(290);

		await page.reload();
		await expect(page.locator(SIDEBAR_SELECTOR).first()).toBeVisible();
		const reloaded = await sidebarWidth(page);
		expect(Math.abs(reloaded - after)).toBeLessThan(2);
	});

	test("double-click handle resets to 240px", async ({ page }) => {
		await openApp(page);
		await clearWidth(page);
		await page.reload();
		await expect(page.locator(SIDEBAR_SELECTOR).first()).toBeVisible();
		const handle = page.locator(HANDLE_SELECTOR).first();
		const box = await handle.boundingBox();
		if (!box) throw new Error("handle has no bounding box");
		const startX = box.x + box.width / 2;
		const startY = box.y + box.height / 2;
		await page.mouse.move(startX, startY);
		await page.mouse.down();
		await page.mouse.move(startX + 80, startY, { steps: 6 });
		await page.mouse.up();

		expect(await sidebarWidth(page)).toBeGreaterThan(310);

		await handle.dblclick();
		const resetW = await sidebarWidth(page);
		expect(Math.abs(resetW - 240)).toBeLessThan(2);
	});
});
