/**
 * Browser E2E for the sidebar font-size setting.
 */
import { type Locator } from "@playwright/test";
import { test, expect, type Page } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProject, deleteGoal, deleteSession } from "../e2e-setup.js";
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
type VisualMetric = {
	width: number;
	height: number;
	left: number;
	right: number;
	top: number;
	bottom: number;
	display: string;
	visibility: string;
	opacity: number;
};
type SidebarVisualSnapshot = {
	rootFont: number;
	topNewGoal: VisualMetric | null;
	addGoalBase: VisualMetric | null;
	addGoalPlus: VisualMetric | null;
	addSessionBase: VisualMetric | null;
	addSessionPlus: VisualMetric | null;
	addStaffBase: VisualMetric | null;
	addStaffPlus: VisualMetric | null;
	projectChevron: VisualMetric | null;
	rolePickerChevron: VisualMetric | null;
	collapsedChevron?: VisualMetric | null;
};

const createdGoalIds = new Set<string>();
const createdSessionIds = new Set<string>();
const createdStaffIds = new Set<string>();

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

async function setSidebarFontSizeDirect(page: Page, px: number): Promise<void> {
	const scale = scaleForPx(px);
	await page.evaluate(([key, value]) => {
		localStorage.setItem(key as string, String(value));
		document.documentElement.style.setProperty("--sidebar-font-scale", String(value));
	}, [SCALE_KEY, scale]);
	await waitForScale(page, scale);
}

async function createSidebarVisualFixture(): Promise<{ goalTitle: string }> {
	const project = await defaultProject();
	const token = `IconScale${Date.now()}`;
	const goal = await createGoal({
		title: `${token} Goal`,
		cwd: project.rootPath,
		projectId: project.id,
		worktree: false,
		autoStartTeam: false,
	});
	createdGoalIds.add(goal.id);

	const sessionResp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ title: `${token} Session`, cwd: project.rootPath, projectId: project.id, worktree: false }),
	});
	expect(sessionResp.status, `create sidebar fixture session: ${await sessionResp.clone().text()}`).toBe(201);
	const session = await sessionResp.json();
	createdSessionIds.add(session.id);

	const staffResp = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({
			name: `${token} Staff`,
			description: "Sidebar icon scaling fixture",
			systemPrompt: "You are a sidebar icon scaling fixture.",
			cwd: project.rootPath,
			projectId: project.id,
		}),
	});
	expect(staffResp.status, `create sidebar fixture staff: ${await staffResp.clone().text()}`).toBe(201);
	const staff = await staffResp.json();
	createdStaffIds.add(staff.id);
	if (staff.currentSessionId) createdSessionIds.add(staff.currentSessionId);
	return { goalTitle: goal.title as string };
}

async function resetSidebarVisualState(page: Page, goalTitle: string): Promise<void> {
	await page.evaluate((title) => {
		localStorage.removeItem("bobbit-sidebar-collapsed");
		localStorage.removeItem("bobbit-expanded-projects");
		localStorage.removeItem("bobbit-collapsed-ungrouped");
		localStorage.removeItem("bobbit-collapsed-staff");
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		const goal = state?.goals?.find((g: { title?: string }) => g.title === title);
		if (goal?.id) localStorage.setItem("bobbit-expanded-goals", JSON.stringify([goal.id]));
	}, goalTitle);
	await page.reload();
	await expect(page.locator("[data-testid='sidebar-expanded']")).toBeVisible({ timeout: 15_000 });
	await expect(page.locator("button[title^='New goal in']").first()).toBeVisible({ timeout: 10_000 });
	await expect(page.locator("button[title^='New session in']").first()).toBeVisible({ timeout: 10_000 });
	await expect(page.locator("button[title^='New staff agent']").first()).toBeVisible({ timeout: 10_000 });
	await expect(page.getByText(goalTitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
}

async function measureSidebarVisualAffordances(page: Page, goalTitle?: string): Promise<SidebarVisualSnapshot> {
	return page.evaluate((title) => {
		const metric = (el: Element | null): VisualMetric | null => {
			if (!el) return null;
			const rect = el.getBoundingClientRect();
			const style = getComputedStyle(el as HTMLElement);
			return {
				width: rect.width,
				height: rect.height,
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
				display: style.display,
				visibility: style.visibility,
				opacity: Number.parseFloat(style.opacity || "1"),
			};
		};
		const first = <T extends Element = Element>(selector: string, root: ParentNode = document): T | null => root.querySelector(selector) as T | null;
		const compoundParts = (buttonSelector: string) => {
			const button = first<HTMLButtonElement>(buttonSelector);
			if (!button) return { base: null, plus: null };
			const base = first('[data-testid$="-icon"], .sidebar-compound-icon, span', button);
			const plus = first('[data-testid$="-plus"]', button)
				?? Array.from(button.querySelectorAll("svg")).at(-1)
				?? null;
			return { base: metric(base), plus: metric(plus) };
		};
		const addGoal = compoundParts('button[title^="New goal in"]');
		const addSession = compoundParts('button[title^="New session in"]');
		const addStaff = compoundParts('button[title^="New staff agent"]');
		const collapsedButton = title
			? Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="sidebar-collapsed"] button'))
				.find((button) => button.getAttribute("title") === title)
			: null;
		const root = first<HTMLElement>('[data-testid="sidebar-expanded"], [data-testid="sidebar-collapsed"]');
		return {
			rootFont: root ? Number.parseFloat(getComputedStyle(root).fontSize) : 0,
			topNewGoal: metric(first('button[data-new-goal-trigger] [data-testid="sidebar-new-goal-icon"], button[data-new-goal-trigger] .sidebar-scale-icon, button[data-new-goal-trigger] svg')),
			addGoalBase: addGoal.base,
			addGoalPlus: addGoal.plus,
			addSessionBase: addSession.base,
			addSessionPlus: addSession.plus,
			addStaffBase: addStaff.base,
			addStaffPlus: addStaff.plus,
			projectChevron: metric(first('[data-testid="project-header"] .sidebar-chevron-slot, [data-testid="project-header"] > span:first-child')),
			rolePickerChevron: metric(first('button[title="New session with role"] .sidebar-scale-icon, button[title="New session with role"] svg')),
			collapsedChevron: metric(first('span', collapsedButton ?? document)),
		};
	}, goalTitle);
}

function assertSidebarAffordancesScale(small: SidebarVisualSnapshot, large: SidebarVisualSnapshot): void {
	const expectedRatio = large.rootFont / small.rootFont;
	const minRatio = expectedRatio * 0.85;
	const failures: string[] = [];
	const checkMetric = (label: string, a: VisualMetric | null | undefined, b: VisualMetric | null | undefined) => {
		if (!a || !b) {
			failures.push(`${label} missing at one or more sidebar font sizes`);
			return;
		}
		const ratio = b.width / Math.max(a.width, 0.01);
		if (ratio < minRatio) failures.push(`${label} width did not scale with sidebar font size: ${a.width.toFixed(2)}px -> ${b.width.toFixed(2)}px (ratio ${ratio.toFixed(2)}, expected >= ${minRatio.toFixed(2)})`);
	};
	const checkPlus = (label: string, base: VisualMetric | null, plus: VisualMetric | null) => {
		if (!base || !plus) {
			failures.push(`${label} plus overlay missing`);
			return;
		}
		if (plus.display === "none" || plus.visibility === "hidden" || plus.opacity <= 0 || plus.width <= 0 || plus.height <= 0) {
			failures.push(`${label} plus overlay is not visibly rendered`);
		}
		const overlaps = plus.left < base.right && plus.right > base.left && plus.top < base.bottom && plus.bottom > base.top;
		if (!overlaps) failures.push(`${label} plus overlay does not overlap its compound icon box`);
	};

	expect(large.rootFont / small.rootFont, "sidebar root font size must change before icon scaling assertions").toBeCloseTo(24 / 14, 1);
	checkMetric("top New Goal icon", small.topNewGoal, large.topNewGoal);
	checkMetric("project New Goal compound icon box", small.addGoalBase, large.addGoalBase);
	checkMetric("project New Goal plus overlay", small.addGoalPlus, large.addGoalPlus);
	checkMetric("New Session compound icon box", small.addSessionBase, large.addSessionBase);
	checkMetric("New Session plus overlay", small.addSessionPlus, large.addSessionPlus);
	checkMetric("New Staff compound icon box", small.addStaffBase, large.addStaffBase);
	checkMetric("New Staff plus overlay", small.addStaffPlus, large.addStaffPlus);
	checkMetric("expanded project disclosure chevron slot", small.projectChevron, large.projectChevron);
	checkMetric("role-picker chevron", small.rolePickerChevron, large.rolePickerChevron);
	if (small.collapsedChevron || large.collapsedChevron) checkMetric("collapsed goal disclosure chevron slot", small.collapsedChevron, large.collapsedChevron);
	checkPlus("project New Goal", large.addGoalBase, large.addGoalPlus);
	checkPlus("New Session", large.addSessionBase, large.addSessionPlus);
	checkPlus("New Staff", large.addStaffBase, large.addStaffPlus);

	expect(failures, `sidebar icon scaling regression: ${failures.join("; ")}`).toEqual([]);
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
	test.afterEach(async () => {
		for (const id of createdStaffIds) await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
		createdStaffIds.clear();
		for (const id of createdSessionIds) await deleteSession(id).catch(() => {});
		createdSessionIds.clear();
		for (const id of createdGoalIds) await deleteGoal(id).catch(() => {});
		createdGoalIds.clear();
	});

	test("real sidebar visual affordance icons scale with the sidebar font size @repro", async ({ page }) => {
		const { goalTitle } = await createSidebarVisualFixture();
		await openApp(page);
		await resetSidebarVisualState(page, goalTitle);

		await setSidebarFontSizeDirect(page, 14);
		const expandedSmall = await measureSidebarVisualAffordances(page);
		await setSidebarFontSizeDirect(page, 24);
		const expandedLarge = await measureSidebarVisualAffordances(page);

		await page.locator("button[title^='Collapse sidebar']").first().click();
		await expect(page.locator("[data-testid='sidebar-collapsed']")).toBeVisible({ timeout: 5_000 });
		await setSidebarFontSizeDirect(page, 14);
		const collapsedSmall = await measureSidebarVisualAffordances(page, goalTitle);
		await setSidebarFontSizeDirect(page, 24);
		const collapsedLarge = await measureSidebarVisualAffordances(page, goalTitle);

		assertSidebarAffordancesScale(
			{ ...expandedSmall, collapsedChevron: collapsedSmall.collapsedChevron },
			{ ...expandedLarge, collapsedChevron: collapsedLarge.collapsedChevron },
		);
	});

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
