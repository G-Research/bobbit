/**
 * Browser E2E for the sidebar font-size setting.
 */
import { type Locator } from "@playwright/test";
import { test, expect, type Page } from "../gateway-harness.js";
import { apiFetch, createGoal, createSession, defaultProject, deleteGoal, deleteSession } from "../e2e-setup.js";
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

type IconDimensionName =
	| "newGoalIcon"
	| "projectAddGoalBox"
	| "projectAddGoalPlus"
	| "addSessionBox"
	| "addSessionPlus"
	| "addStaffBox"
	| "addStaffPlus"
	| "expandedDisclosureChevron"
	| "rolePickerChevron"
	| "collapsedDisclosureChevron";

type IconDimensionSnapshot = Record<IconDimensionName, { width: number; height: number }> & { rootFontSize: number };
type OverflowSnapshot = Array<{ label: string; scrollWidth: number; clientWidth: number; overflow: number; overflowY: string }>;
type ActionGapSnapshot = { prToFirstAction: number; firstToSecondAction: number; delta: number };

async function applySidebarFontSizePx(page: Page, px: number): Promise<void> {
	const scale = scaleForPx(px);
	await page.evaluate(([key, value]) => {
		localStorage.setItem(key as string, String(value));
		document.documentElement.style.setProperty("--sidebar-font-scale", String(value));
	}, [SCALE_KEY, scale]);
	await waitForScale(page, scale);
}

async function createStaffAgent(project: { id: string; rootPath: string }, name: string): Promise<{ id: string }> {
	const resp = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({ name, systemPrompt: "You are a sidebar font-scale test bot.", cwd: project.rootPath, projectId: project.id }),
	});
	if (resp.status !== 201) {
		expect(resp.status, `test setup should create staff agent: ${await resp.text().catch(() => "")}`).toBe(201);
	}
	return resp.json();
}

async function resetSidebarVisualState(page: Page, goalId: string): Promise<void> {
	await page.evaluate(({ scaleKey, gid }) => {
		localStorage.removeItem(scaleKey);
		localStorage.removeItem("bobbit-sidebar-collapsed");
		localStorage.removeItem("bobbit-expanded-projects");
		localStorage.setItem("bobbit-collapsed-ungrouped", "[]");
		localStorage.setItem("bobbit-collapsed-staff", "[]");
		localStorage.setItem("bobbit-archived-collapsed-projects", "[]");
		localStorage.setItem("bobbit-expanded-goals", JSON.stringify([gid]));
	}, { scaleKey: SCALE_KEY, gid: goalId });
}

async function waitForSidebarFixture(page: Page, goalId: string, staffName: string): Promise<void> {
	await expect(page.locator("[data-testid='sidebar-expanded']")).toBeVisible({ timeout: 15_000 });
	await expect(page.locator(`[data-nav-id="goal:${goalId}"]`).first()).toBeVisible({ timeout: 15_000 });
	await expect(page.locator("button[title^='New goal in']").first()).toBeVisible({ timeout: 5_000 });
	await expect(page.locator("button[title^='New session in']").first()).toBeVisible({ timeout: 5_000 });
	await expect(page.locator("button[title='New staff agent']").first()).toBeVisible({ timeout: 5_000 });
	await expect(page.getByText(staffName, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
}

async function measureIconDimensions(page: Page, goalId: string): Promise<IconDimensionSnapshot> {
	const result = await page.evaluate((gid) => {
		const requireEl = <T extends Element>(selector: string, root: ParentNode = document): T => {
			const el = root.querySelector<T>(selector);
			if (!el) throw new Error(`missing sidebar measurement target: ${selector}`);
			return el;
		};
		const rectOf = (el: Element) => {
			const r = el.getBoundingClientRect();
			return { width: r.width, height: r.height };
		};
		const expanded = requireEl<HTMLElement>("[data-testid='sidebar-expanded']");
		const newGoalButton = requireEl<HTMLElement>("[data-new-goal-trigger]", expanded);
		const projectAddButton = requireEl<HTMLElement>("button[title^='New goal in']", expanded);
		const addSessionButton = requireEl<HTMLElement>("button[title^='New session in']", expanded);
		const addStaffButton = requireEl<HTMLElement>("button[title='New staff agent']", expanded);
		const rolePickerButton = requireEl<HTMLElement>("button[title='New session with role']", expanded);
		const goalRow = requireEl<HTMLElement>(`[data-nav-id="goal:${gid}"]`, expanded);
		const collapsed = document.querySelector<HTMLElement>("[data-testid='sidebar-collapsed']");
		return {
			rootFontSize: parseFloat(getComputedStyle(expanded).fontSize),
			newGoalIcon: rectOf(requireEl("svg", newGoalButton)),
			projectAddGoalBox: rectOf(requireEl("span.relative.inline-flex", projectAddButton)),
			projectAddGoalPlus: rectOf(requireEl("span.relative.inline-flex svg[viewBox='0 0 10 10']", projectAddButton)),
			addSessionBox: rectOf(requireEl("span.relative.inline-flex", addSessionButton)),
			addSessionPlus: rectOf(requireEl("span.relative.inline-flex svg[viewBox='0 0 10 10']", addSessionButton)),
			addStaffBox: rectOf(requireEl("span.relative.inline-flex", addStaffButton)),
			addStaffPlus: rectOf(requireEl("span.relative.inline-flex svg[viewBox='0 0 10 10']", addStaffButton)),
			expandedDisclosureChevron: rectOf(requireEl("span[title*='goal']", goalRow)),
			rolePickerChevron: rectOf(requireEl("svg", rolePickerButton)),
			collapsedDisclosureChevron: collapsed
				? rectOf(requireEl("button[title] span:first-child", collapsed))
				: { width: Number.NaN, height: Number.NaN },
		};
	}, goalId);
	return result;
}

function assertDimensionScales(
	failures: string[],
	name: IconDimensionName,
	baseline: IconDimensionSnapshot,
	large: IconDimensionSnapshot,
	small: IconDimensionSnapshot,
): void {
	const base = baseline[name].width;
	const largeWidth = large[name].width;
	const smallWidth = small[name].width;
	if (!(largeWidth > base * 1.35)) {
		failures.push(`${name}: large dimension should grow with sidebar font size (baseline=${base.toFixed(2)}px, large=${largeWidth.toFixed(2)}px)`);
	}
	if (!(smallWidth < base * 0.9)) {
		failures.push(`${name}: small dimension should shrink with sidebar font size (baseline=${base.toFixed(2)}px, small=${smallWidth.toFixed(2)}px)`);
	}
}

type MobileIconDimensionName =
	| "mobileNewGoalIcon"
	| "mobileProjectChevron"
	| "mobileProjectAddGoalBox"
	| "mobileProjectAddGoalPlus"
	| "mobileSessionsChevron"
	| "mobileAddSessionBox"
	| "mobileAddSessionPlus"
	| "mobileRolePickerChevron";

type MobileIconDimensionSnapshot = Record<MobileIconDimensionName, { width: number; height: number }> & { rootFontSize: number; overflow: number; overflowY: string };

async function waitForMobileSidebarFixture(page: Page): Promise<void> {
	await expect(page.locator(".sidebar-root").first()).toBeVisible({ timeout: 15_000 });
	await expect(page.locator("[data-testid='project-header']").first()).toBeVisible({ timeout: 15_000 });
	await expect(page.locator("[data-new-goal-trigger]").first()).toBeVisible({ timeout: 5_000 });
	await expect(page.locator("button[title^='New goal in']").first()).toBeVisible({ timeout: 5_000 });
	await expect(page.locator("button[title^='New session in']").first()).toBeVisible({ timeout: 5_000 });
	await expect(page.locator("button[title='New session with role']").first()).toBeVisible({ timeout: 5_000 });
}

async function measureMobileIconDimensions(page: Page): Promise<MobileIconDimensionSnapshot> {
	return page.evaluate(() => {
		const requireEl = <T extends Element>(selector: string, root: ParentNode = document): T => {
			const el = root.querySelector<T>(selector);
			if (!el) throw new Error(`missing mobile sidebar measurement target: ${selector}`);
			return el;
		};
		const rectOf = (el: Element) => {
			const r = el.getBoundingClientRect();
			return { width: r.width, height: r.height };
		};
		const root = requireEl<HTMLElement>(".sidebar-root");
		const newGoalButton = requireEl<HTMLElement>("[data-new-goal-trigger]", root);
		const projectHeader = requireEl<HTMLElement>("[data-testid='project-header']", root);
		const projectAddButton = requireEl<HTMLElement>("button[title^='New goal in']", root);
		const addSessionButton = requireEl<HTMLElement>("button[title^='New session in']", root);
		const sessionsHeader = addSessionButton.closest<HTMLElement>(".cursor-pointer");
		if (!sessionsHeader) throw new Error("missing mobile sessions header");
		const rolePickerButton = requireEl<HTMLElement>("button[title='New session with role']", root);
		const style = getComputedStyle(root);
		return {
			rootFontSize: parseFloat(style.fontSize),
			overflow: root.scrollWidth - root.clientWidth,
			overflowY: style.overflowY,
			mobileNewGoalIcon: rectOf(requireEl("svg", newGoalButton)),
			mobileProjectChevron: rectOf(requireEl(".sidebar-chevron", projectHeader)),
			mobileProjectAddGoalBox: rectOf(requireEl(".sidebar-compound-icon", projectAddButton)),
			mobileProjectAddGoalPlus: rectOf(requireEl(".sidebar-compound-plus", projectAddButton)),
			mobileSessionsChevron: rectOf(requireEl(".sidebar-chevron", sessionsHeader)),
			mobileAddSessionBox: rectOf(requireEl(".sidebar-compound-icon", addSessionButton)),
			mobileAddSessionPlus: rectOf(requireEl(".sidebar-compound-plus", addSessionButton)),
			mobileRolePickerChevron: rectOf(requireEl("svg", rolePickerButton)),
		};
	});
}

function assertMobileDimensionScales(
	failures: string[],
	name: MobileIconDimensionName,
	baseline: MobileIconDimensionSnapshot,
	large: MobileIconDimensionSnapshot,
	small: MobileIconDimensionSnapshot,
): void {
	const base = baseline[name].width;
	const largeWidth = large[name].width;
	const smallWidth = small[name].width;
	if (!(largeWidth > base * 1.35)) {
		failures.push(`${name}: large dimension should grow with sidebar font size (baseline=${base.toFixed(2)}px, large=${largeWidth.toFixed(2)}px)`);
	}
	if (!(smallWidth < base * 0.9)) {
		failures.push(`${name}: small dimension should shrink with sidebar font size (baseline=${base.toFixed(2)}px, small=${smallWidth.toFixed(2)}px)`);
	}
}

async function measureCollapsedChevronDimension(page: Page): Promise<{ width: number; height: number }> {
	return page.evaluate(() => {
		const collapsed = document.querySelector<HTMLElement>("[data-testid='sidebar-collapsed']");
		if (!collapsed) throw new Error("missing collapsed sidebar for chevron measurement");
		const chevron = collapsed.querySelector<HTMLElement>("button[title] span:first-child");
		if (!chevron) throw new Error("missing collapsed sidebar disclosure chevron");
		const rect = chevron.getBoundingClientRect();
		return { width: rect.width, height: rect.height };
	});
}

async function measureHorizontalOverflow(page: Page): Promise<OverflowSnapshot> {
	return page.evaluate(() => {
		const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='sidebar-expanded'], [data-testid='sidebar-collapsed']"));
		const items: Array<{ label: string; scrollWidth: number; clientWidth: number; overflow: number; overflowY: string }> = [];
		const snap = (label: string, el: HTMLElement) => {
			const style = getComputedStyle(el);
			items.push({ label, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflow: el.scrollWidth - el.clientWidth, overflowY: style.overflowY });
		};
		for (const root of roots) {
			const label = root.dataset.testid || "sidebar-root";
			snap(label, root);
			const scroller = root.querySelector<HTMLElement>(".overflow-y-auto");
			if (scroller) snap(`${label} scroller`, scroller);
		}
		return items;
	});
}

async function measureGoalActionGaps(page: Page, goalId: string, prUrl: string): Promise<ActionGapSnapshot> {
	const row = page.locator(`[data-nav-id="goal:${goalId}"]`).first();
	await row.hover();
	await expect(row.locator(".sidebar-actions").first()).toHaveCSS("opacity", "1", { timeout: 5_000 });
	return page.evaluate(({ gid, url }) => {
		const row = document.querySelector<HTMLElement>(`[data-nav-id="goal:${gid}"]`);
		if (!row) throw new Error(`missing goal row for gap measurement: ${gid}`);
		const prSvg = row.querySelector<SVGGraphicsElement>(`a[href="${url}"] svg`);
		const actionSvgs = Array.from(row.querySelectorAll<SVGGraphicsElement>(".sidebar-actions button svg"));
		if (!prSvg || actionSvgs.length < 2) {
			throw new Error(`missing PR/action icons for gap measurement: pr=${!!prSvg}, actions=${actionSvgs.length}`);
		}
		const pr = prSvg.getBoundingClientRect();
		const first = actionSvgs[0].getBoundingClientRect();
		const second = actionSvgs[1].getBoundingClientRect();
		const prToFirstAction = first.left - pr.right;
		const firstToSecondAction = second.left - first.right;
		return { prToFirstAction, firstToSecondAction, delta: Math.abs(prToFirstAction - firstToSecondAction) };
	}, { gid: goalId, url: prUrl });
}

test.describe("Sidebar font scale (full-stack UI)", () => {
	test("sidebar icons, chevrons, overflow, and action gaps follow sidebar font size @repro", async ({ page }) => {
		const project = await defaultProject();
		const tag = Date.now();
		const staffName = `FontScaleStaff${tag}`;
		const prUrl = `https://github.com/acme/sidebar-font-scale/pull/${tag}`;
		let goalId: string | undefined;
		let sessionId: string | undefined;
		let staffId: string | undefined;

		try {
			const goal = await createGoal({ title: `FontScaleGoal${tag}`, projectId: project.id, cwd: project.rootPath, worktree: false, team: false });
			goalId = goal.id as string;
			sessionId = await createSession({ projectId: project.id, cwd: project.rootPath });
			const staff = await createStaffAgent(project, staffName);
			staffId = staff.id;

			await openApp(page);
			await resetSidebarVisualState(page, goalId);
			await page.reload();
			await waitForSidebarFixture(page, goalId, staffName);
			await applySidebarFontSizePx(page, 14);

			const baseline = await measureIconDimensions(page, goalId);
			expect(baseline.rootFontSize).toBeCloseTo(14, 1);

			await applySidebarFontSizePx(page, 24);
			const large = await measureIconDimensions(page, goalId);
			expect(large.rootFontSize).toBeCloseTo(24, 1);

			await applySidebarFontSizePx(page, MIN_PX);
			const small = await measureIconDimensions(page, goalId);
			expect(small.rootFontSize).toBeCloseTo(MIN_PX, 1);

			const failures: string[] = [];
			for (const name of [
				"newGoalIcon",
				"projectAddGoalBox",
				"projectAddGoalPlus",
				"addSessionBox",
				"addSessionPlus",
				"addStaffBox",
				"addStaffPlus",
				"expandedDisclosureChevron",
				"rolePickerChevron",
			] satisfies IconDimensionName[]) {
				assertDimensionScales(failures, name, baseline, large, small);
			}

			for (const px of [MIN_PX, MAX_PX]) {
				await applySidebarFontSizePx(page, px);
				for (const item of await measureHorizontalOverflow(page)) {
					if (item.overflow > 2) {
						failures.push(`${item.label}: horizontal overflow at ${px}px (scrollWidth=${item.scrollWidth}, clientWidth=${item.clientWidth})`);
					}
					if (item.label.endsWith("scroller") && item.overflowY === "hidden") {
						failures.push(`${item.label}: vertical scrolling must remain enabled at ${px}px`);
					}
				}
			}

			await page.evaluate(() => localStorage.setItem("bobbit-sidebar-collapsed", "true"));
			await page.reload();
			await expect(page.locator("[data-testid='sidebar-collapsed']")).toBeVisible({ timeout: 15_000 });
			await applySidebarFontSizePx(page, 14);
			const collapsedBaseline = { ...baseline, collapsedDisclosureChevron: await measureCollapsedChevronDimension(page) };
			await applySidebarFontSizePx(page, 24);
			const collapsedLarge = { ...large, collapsedDisclosureChevron: await measureCollapsedChevronDimension(page) };
			await applySidebarFontSizePx(page, MIN_PX);
			const collapsedSmall = { ...small, collapsedDisclosureChevron: await measureCollapsedChevronDimension(page) };
			assertDimensionScales(failures, "collapsedDisclosureChevron", collapsedBaseline, collapsedLarge, collapsedSmall);

			for (const px of [MIN_PX, MAX_PX]) {
				await applySidebarFontSizePx(page, px);
				for (const item of await measureHorizontalOverflow(page)) {
					if (item.overflow > 2) {
						failures.push(`${item.label}: horizontal overflow at ${px}px collapsed (scrollWidth=${item.scrollWidth}, clientWidth=${item.clientWidth})`);
					}
					if (item.label.endsWith("scroller") && item.overflowY === "hidden") {
						failures.push(`${item.label}: vertical scrolling must remain enabled at ${px}px collapsed`);
					}
				}
			}

			await page.evaluate(() => localStorage.removeItem("bobbit-sidebar-collapsed"));
			await page.reload();
			await waitForSidebarFixture(page, goalId, staffName);
			await applySidebarFontSizePx(page, 14);
			await page.evaluate(({ gid, url }) => {
				const state: any = (window as any).bobbitState ?? (window as any).__bobbitState;
				if (state?.sessionPollTimer) {
					clearInterval(state.sessionPollTimer);
					state.sessionPollTimer = null;
				}
				state.prStatusCache.set(gid, { state: "OPEN", url, number: 42 });
				state.gateStatusCache.set(gid, { passed: 1, total: 1, verifying: false, verifyingCount: 0, awaitingSignoffCount: 0, awaitingHumanSignoff: false, runningGateIds: [], gates: [] });
				(window as any).__bobbitRenderApp?.();
			}, { gid: goalId, url: prUrl });
			await expect(page.locator(`[data-nav-id="goal:${goalId}"] a[href="${prUrl}"]`).first()).toBeVisible({ timeout: 5_000 });
			const gaps = await measureGoalActionGaps(page, goalId, prUrl);
			if (gaps.delta > 2) {
				failures.push(`goal action row: PR-to-action gap should match action-to-action gap (prToFirst=${gaps.prToFirstAction.toFixed(2)}px, actionToAction=${gaps.firstToSecondAction.toFixed(2)}px, delta=${gaps.delta.toFixed(2)}px)`);
			}

			expect(
				failures,
				"SIDEBAR_ICON_SCALE_REGRESSION: sidebar visual icons, chevrons, overflow, and action gaps must follow sidebar font size",
			).toEqual([]);
		} finally {
			if (staffId) await apiFetch(`/api/staff/${staffId}`, { method: "DELETE" }).catch(() => {});
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			if (goalId) await deleteGoal(goalId).catch(() => {});
		}
	});

	test("mobile project sidebar affordances follow sidebar font size @repro", async ({ page }) => {
		const project = await defaultProject();
		const tag = Date.now();
		let goalId: string | undefined;
		let sessionId: string | undefined;

		try {
			const goal = await createGoal({ title: `MobileFontScaleGoal${tag}`, projectId: project.id, cwd: project.rootPath, worktree: false, team: false });
			goalId = goal.id as string;
			sessionId = await createSession({ projectId: project.id, cwd: project.rootPath });

			await page.setViewportSize({ width: 375, height: 667 });
			await openApp(page);
			await resetSidebarVisualState(page, goalId);
			await page.reload();
			await waitForMobileSidebarFixture(page);

			await applySidebarFontSizePx(page, 14);
			const baseline = await measureMobileIconDimensions(page);
			expect(baseline.rootFontSize).toBeCloseTo(14, 1);

			await applySidebarFontSizePx(page, 24);
			const large = await measureMobileIconDimensions(page);
			expect(large.rootFontSize).toBeCloseTo(24, 1);

			await applySidebarFontSizePx(page, MIN_PX);
			const small = await measureMobileIconDimensions(page);
			expect(small.rootFontSize).toBeCloseTo(MIN_PX, 1);

			const failures: string[] = [];
			for (const name of [
				"mobileNewGoalIcon",
				"mobileProjectChevron",
				"mobileProjectAddGoalBox",
				"mobileProjectAddGoalPlus",
				"mobileSessionsChevron",
				"mobileAddSessionBox",
				"mobileAddSessionPlus",
				"mobileRolePickerChevron",
			] satisfies MobileIconDimensionName[]) {
				assertMobileDimensionScales(failures, name, baseline, large, small);
			}

			await applySidebarFontSizePx(page, MAX_PX);
			const max = await measureMobileIconDimensions(page);
			if (max.overflow > 2) {
				failures.push(`mobile sidebar: horizontal overflow at ${MAX_PX}px (overflow=${max.overflow})`);
			}
			if (max.overflowY === "hidden") {
				failures.push("mobile sidebar: vertical scrolling must remain enabled");
			}

			expect(
				failures,
				"SIDEBAR_MOBILE_ICON_SCALE_REGRESSION: mobile sidebar project affordances must follow sidebar font size",
			).toEqual([]);
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			if (goalId) await deleteGoal(goalId).catch(() => {});
		}
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
