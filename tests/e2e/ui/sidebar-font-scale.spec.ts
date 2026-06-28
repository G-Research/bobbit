/**
 * Browser E2E for the sidebar font-size setting.
 */
import { type Locator } from "@playwright/test";
import { test, expect, type Page } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const SCALE_KEY = "bobbit:sidebar-font-scale";
const BASE_PX = 12;
const DEFAULT_SCALE = 14 / BASE_PX;
const MIN_PX = 10;
const MAX_PX = 32;
const FONT_SIZE_INPUT_SELECTOR = [
	"[data-testid='sidebar-font-size-input']",
	"[data-testid='sidebar-font-scale-input']",
	"input[type='number'][min='10'][max='32'][step='1']",
].join(", ");

type SidebarMeasure = { rootSize: number; emChildSize: number | null; cssVar: string };

function scaleForPx(px: number): number {
	return px / BASE_PX;
}

function fontSizeInput(page: Page): Locator {
	return page.locator(FONT_SIZE_INPUT_SELECTOR).first();
}

async function resetScale(page: Page): Promise<void> {
	await openApp(page);
	await page.evaluate((k) => localStorage.removeItem(k), SCALE_KEY);
	await page.reload();
	await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
}

async function readScale(page: Page): Promise<number> {
	return page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-font-scale").trim()));
}

async function waitForScale(page: Page, expected: number, precision = 2): Promise<void> {
	await expect.poll(() => readScale(page), { timeout: 5_000 }).toBeCloseTo(expected, precision);
}

async function persistedScale(page: Page): Promise<number> {
	const persisted = await page.evaluate((k) => localStorage.getItem(k), SCALE_KEY);
	return Number.parseFloat(persisted ?? "");
}

async function inputValueAsNumber(page: Page): Promise<number> {
	return Number.parseFloat(await fontSizeInput(page).inputValue());
}

async function setFontSizePx(page: Page, value: string): Promise<void> {
	const input = fontSizeInput(page);
	await input.fill(value);
	await input.evaluate((el) => {
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await input.blur();
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
	test("desktop numeric control scales sidebar, persists, clamps, resets, and leaves main pane unchanged @smoke", async ({ page }) => {
		await resetScale(page);
		await navigateToHash(page, "#/settings/system/general");

		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("[data-testid='general-appearance-heading']")).toBeVisible({ timeout: 5_000 });

		const input = fontSizeInput(page);
		await expect(input).toBeVisible({ timeout: 5_000 });
		await expect(page.locator("[data-testid='sidebar-font-scale-slider']")).toHaveCount(0);
		await expect(page.locator("[data-testid='sidebar-font-scale-label']")).toHaveCount(0);
		await expect(page.locator("[data-testid='sidebar-font-scale-reset']")).toBeVisible();
		expect(await input.getAttribute("type")).toBe("number");
		expect(await input.getAttribute("min")).toBe(String(MIN_PX));
		expect(await input.getAttribute("max")).toBe(String(MAX_PX));
		expect(await input.getAttribute("step")).toBe("1");
		expect(await inputValueAsNumber(page)).toBe(14);

		const baseline = await measureSidebar(page);
		expect(parseFloat(baseline.cssVar)).toBeCloseTo(DEFAULT_SCALE, 2);
		expect(baseline.rootSize).toBeCloseTo(14, 1);
		expect(baseline.emChildSize ?? 0).toBeGreaterThan(0);
		const baselineChild = baseline.emChildSize!;
		const baselineChat = await page.locator("h1").first().evaluate(
			(el) => parseFloat(getComputedStyle(el).fontSize),
		);
		const baselineDot = await activityDotSize(page);
		expect(baselineDot).toBeGreaterThan(6.5);
		expect(baselineDot).toBeLessThan(7.5);

		await setFontSizePx(page, "24");
		await waitForScale(page, scaleForPx(24));
		const scaled = await measureSidebar(page);
		expect(scaled.rootSize).toBeCloseTo(24, 1);
		expect(scaled.rootSize / baseline.rootSize).toBeCloseTo(scaleForPx(24) / DEFAULT_SCALE, 1);
		expect(scaled.emChildSize! / baselineChild).toBeCloseTo(scaleForPx(24) / DEFAULT_SCALE, 1);
		expect((await activityDotSize(page)) / baselineDot).toBeCloseTo(scaleForPx(24) / DEFAULT_SCALE, 1);
		expect(await page.locator("h1").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(baselineChat, 1);
		expect(await persistedScale(page)).toBeCloseTo(scaleForPx(24), 2);

		await setFontSizePx(page, String(MAX_PX));
		await waitForScale(page, scaleForPx(MAX_PX));
		expect((await measureSidebar(page)).rootSize).toBeCloseTo(MAX_PX, 1);
		expect(await persistedScale(page)).toBeCloseTo(scaleForPx(MAX_PX), 2);

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
		await waitForScale(page, scaleForPx(MAX_PX));
		await navigateToHash(page, "#/settings/system/general");
		await expect(fontSizeInput(page)).toHaveValue(String(MAX_PX), { timeout: 5_000 });

		await setFontSizePx(page, "100");
		await waitForScale(page, scaleForPx(MAX_PX));
		expect(await inputValueAsNumber(page)).toBe(MAX_PX);
		expect(await persistedScale(page)).toBeCloseTo(scaleForPx(MAX_PX), 2);

		await setFontSizePx(page, "1");
		await waitForScale(page, scaleForPx(MIN_PX));
		expect(await inputValueAsNumber(page)).toBe(MIN_PX);
		expect((await measureSidebar(page)).rootSize).toBeCloseTo(MIN_PX, 1);
		expect(await persistedScale(page)).toBeCloseTo(scaleForPx(MIN_PX), 2);
		expect(await page.locator("h1").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(baselineChat, 1);

		await page.locator("[data-testid='sidebar-font-scale-reset']").click();
		await waitForScale(page, DEFAULT_SCALE);
		expect(await inputValueAsNumber(page)).toBe(14);
		const reset = await measureSidebar(page);
		expect(reset.rootSize).toBeCloseTo(14, 1);
		expect(await persistedScale(page)).toBeCloseTo(DEFAULT_SCALE, 2);
	});

	test("existing persisted scale values load as pixel values in the numeric input", async ({ page }) => {
		await openApp(page);
		await page.evaluate((k) => localStorage.setItem(k, "1.22"), SCALE_KEY);
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		await expect(fontSizeInput(page)).toBeVisible({ timeout: 5_000 });
		expect(await inputValueAsNumber(page)).toBeCloseTo(15, 0);
		await waitForScale(page, 1.22);

		await page.evaluate((k) => localStorage.setItem(k, "2.0"), SCALE_KEY);
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		await expect(fontSizeInput(page)).toHaveValue("24", { timeout: 5_000 });
		await waitForScale(page, 2.0);
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
		await waitForScale(page, DEFAULT_SCALE);

		await page.evaluate(([key, val]) => {
			localStorage.setItem(key as string, String(val));
			document.documentElement.style.setProperty("--sidebar-font-scale", String(val));
		}, [SCALE_KEY, 2.0]);

		const scaled = await rolesBtn.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
		expect(scaled).toBeGreaterThan(baseline);
		expect(scaled / baseline).toBeCloseTo(2.0 / DEFAULT_SCALE, 1);
	});
});
