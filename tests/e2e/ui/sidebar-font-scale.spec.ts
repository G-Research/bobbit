/**
 * Browser E2E for the sidebar font-size setting.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const SCALE_KEY = "bobbit:sidebar-font-scale";

type SidebarMeasure = { rootSize: number; emChildSize: number | null; cssVar: string };

async function resetScale(page: Page): Promise<void> {
	await openApp(page);
	await page.evaluate((k) => localStorage.removeItem(k), SCALE_KEY);
	await page.reload();
	await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
}

async function measureSidebar(page: Page): Promise<SidebarMeasure> {
	const result = await page.evaluate(() => {
		const root = document.querySelector("[data-testid='sidebar-expanded']") as HTMLElement | null;
		if (!root) return null;
		const rootSize = parseFloat(getComputedStyle(root).fontSize);
		const emChild = Array.from(root.querySelectorAll<HTMLElement>("[style*='font-size'][style*='em']"))[0];
		const emChildSize = emChild ? parseFloat(getComputedStyle(emChild).fontSize) : null;
		const cssVar = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-font-scale").trim();
		return { rootSize, emChildSize, cssVar };
	});
	expect(result).not.toBeNull();
	return result!;
}

async function setScaleSlider(page: Page, value: string): Promise<void> {
	await page.locator("[data-testid='sidebar-font-scale-slider']").evaluate((el: HTMLInputElement, v) => {
		el.value = v;
		el.dispatchEvent(new Event("input", { bubbles: true }));
	}, value);
}

async function injectActivityDot(page: Page): Promise<void> {
	await page.evaluate(() => {
		const root = document.querySelector("[data-testid='sidebar-expanded']") as HTMLElement | null;
		if (!root || root.querySelector("[data-testid='test-activity-dot']")) return;
		const parent = document.createElement("span");
		parent.setAttribute("data-testid", "test-dot-parent");
		parent.style.fontSize = "0.9167em";
		const dot = document.createElement("span");
		dot.setAttribute("data-testid", "test-activity-dot");
		dot.style.fontSize = "calc(0.375rem * var(--sidebar-font-scale, 1))";
		dot.style.lineHeight = "1";
		dot.textContent = "●";
		parent.appendChild(dot);
		root.appendChild(parent);
	});
}

async function activityDotSize(page: Page): Promise<number> {
	await injectActivityDot(page);
	return page.locator("[data-testid='test-activity-dot']").evaluate(
		(el) => parseFloat(getComputedStyle(el).fontSize),
	);
}

test.describe("Sidebar font scale (full-stack UI)", () => {
	test("desktop control scales sidebar, persists on reload, resets, and leaves main pane unchanged @smoke", async ({ page }) => {
		await resetScale(page);
		await navigateToHash(page, "#/settings/system/general");

		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("[data-testid='general-appearance-heading']")).toBeVisible({ timeout: 5_000 });
		await expect(page.locator("[data-testid='sidebar-font-scale-slider']")).toBeVisible({ timeout: 5_000 });
		await expect(page.locator("[data-testid='sidebar-font-scale-label']")).toHaveText("Default");
		await expect(page.locator("[data-testid='sidebar-font-scale-reset']")).toBeVisible();

		const baseline = await measureSidebar(page);
		expect(Math.round(baseline.rootSize)).toBe(12);
		expect(baseline.cssVar).toBe("1");
		expect(baseline.emChildSize ?? 0).toBeGreaterThan(0);
		const baselineChild = baseline.emChildSize!;
		const baselineChat = await page.locator("h1").first().evaluate(
			(el) => parseFloat(getComputedStyle(el).fontSize),
		);
		const baselineDot = await activityDotSize(page);
		expect(baselineDot).toBeGreaterThan(5.5);
		expect(baselineDot).toBeLessThan(6.5);

		await setScaleSlider(page, "4");
		await expect(page.locator("[data-testid='sidebar-font-scale-label']")).toHaveText("Largest");
		const scaled = await measureSidebar(page);
		expect(parseFloat(scaled.cssVar)).toBeCloseTo(1.22, 2);
		expect(scaled.rootSize / baseline.rootSize).toBeCloseTo(1.22, 1);
		expect(scaled.emChildSize! / baselineChild).toBeCloseTo(1.22, 1);
		expect((await activityDotSize(page)) / baselineDot).toBeCloseTo(1.22, 1);
		expect(await page.locator("h1").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(baselineChat, 1);

		const persisted = await page.evaluate((k) => localStorage.getItem(k), SCALE_KEY);
		expect(parseFloat(persisted ?? "")).toBeCloseTo(1.22, 2);

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
		expect(parseFloat(await page.evaluate(
			() => getComputedStyle(document.documentElement).getPropertyValue("--sidebar-font-scale").trim(),
		))).toBeCloseTo(1.22, 2);

		await navigateToHash(page, "#/settings/system/general");
		await expect(page.locator("[data-testid='sidebar-font-scale-label']")).toHaveText("Largest", { timeout: 5_000 });
		expect(await page.locator("[data-testid='sidebar-font-scale-slider']").inputValue()).toBe("4");

		await setScaleSlider(page, "0");
		await expect(page.locator("[data-testid='sidebar-font-scale-label']")).toHaveText("Smallest");
		expect(await page.locator("h1").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(baselineChat, 1);

		await page.locator("[data-testid='sidebar-font-scale-reset']").click();
		await expect(page.locator("[data-testid='sidebar-font-scale-label']")).toHaveText("Default");
		const reset = await measureSidebar(page);
		expect(parseFloat(reset.cssVar)).toBeCloseTo(1.0, 2);
		expect(Math.round(reset.rootSize)).toBe(12);
	});

	test("mobile sidebar text-sm element scales with the persisted multiplier", async ({ page }) => {
		await resetScale(page);
		await page.setViewportSize({ width: 375, height: 667 });
		await page.reload();
		const rolesBtn = page.locator("button").filter({ hasText: /^\s*Roles\s*$/ }).first();
		await expect(rolesBtn).toBeVisible({ timeout: 15_000 });
		expect(await rolesBtn.evaluate((el) => !!el.closest(".sidebar-root"))).toBe(true);

		const baseline = await rolesBtn.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
		expect(baseline).toBeGreaterThan(0);

		await page.evaluate(([key, val]) => {
			localStorage.setItem(key as string, String(val));
			document.documentElement.style.setProperty("--sidebar-font-scale", String(val));
		}, [SCALE_KEY, 1.22]);

		const scaled = await rolesBtn.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
		expect(scaled).toBeGreaterThan(baseline);
		expect(scaled / baseline).toBeCloseTo(1.22, 1);
	});
});
