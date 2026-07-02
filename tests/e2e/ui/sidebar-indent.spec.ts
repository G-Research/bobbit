/**
 * Browser E2E for the sidebar tree indentation setting.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId, deleteGoal } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const INDENT_KEY = "bobbit:sidebar-tree-indent";
const DEFAULT_PX = 16;
const MIN_PX = 8;
const MAX_PX = 28;
const INDENT_INPUT = "[data-testid='sidebar-tree-indent-input']";
const INDENT_RESET = "[data-testid='sidebar-tree-indent-reset']";
const SPEC = "Sidebar indentation E2E fixture goal with enough detail for validation.";

const createdGoalIds: string[] = [];

type IndentFixture = {
	projectId: string;
	parentId: string;
	childId: string;
	parentTitle: string;
	childTitle: string;
};

async function createChildGoal(projectId: string, parentGoalId: string, title: string): Promise<{ id: string; [k: string]: unknown }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title,
			spec: SPEC,
			projectId,
			parentGoalId,
			team: false,
			worktree: false,
			autoStartTeam: false,
		}),
	});
	expect(resp.status, `create child goal ${title}: ${await resp.clone().text()}`).toBe(201);
	return resp.json();
}

async function createIndentFixture(): Promise<IndentFixture> {
	const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	const projectId = await defaultProjectId();
	const prefs = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: true }),
	});
	expect(prefs.status, `enable subgoals: ${await prefs.clone().text()}`).toBe(200);

	const parent = await createGoal({
		title: `Indent parent ${stamp}`,
		projectId,
		team: false,
		worktree: false,
		subgoalsAllowed: true,
		maxNestingDepth: 3,
	});
	createdGoalIds.push(parent.id);

	const child = await createChildGoal(projectId, parent.id, `Indent child ${stamp}`);
	createdGoalIds.push(child.id);

	return {
		projectId,
		parentId: parent.id,
		childId: child.id,
		parentTitle: String(parent.title),
		childTitle: String(child.title),
	};
}

function indentInput(page: Page) {
	return page.locator(INDENT_INPUT).first();
}

async function setIndentPx(page: Page, value: string): Promise<void> {
	const input = indentInput(page);
	await input.fill(value);
	await input.evaluate((el) => {
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await input.blur();
}

async function runtimeIndentPx(page: Page): Promise<number> {
	return page.evaluate(() => Number.parseFloat(
		getComputedStyle(document.documentElement).getPropertyValue("--sidebar-tree-nested-goal-indent").trim(),
	));
}

async function waitForRuntimeIndent(page: Page, expected: number): Promise<void> {
	await expect.poll(() => runtimeIndentPx(page), { timeout: 5_000 }).toBeCloseTo(expected, 0);
}

async function persistedIndentPx(page: Page): Promise<number> {
	const raw = await page.evaluate((key) => localStorage.getItem(key), INDENT_KEY);
	return Number.parseFloat(raw ?? "");
}

async function inputValueAsNumber(page: Page): Promise<number> {
	return Number.parseFloat(await indentInput(page).inputValue());
}

async function seedSidebarState(page: Page, fixture: IndentFixture, indentPx?: number | string): Promise<void> {
	await page.evaluate(({ key, parentId, indent }) => {
		localStorage.removeItem("bobbit-sidebar-collapsed");
		localStorage.removeItem("bobbit-expanded-projects");
		localStorage.removeItem("gateway.sessionId");
		localStorage.setItem("bobbit-expanded-goals", JSON.stringify([parentId]));
		if (indent === undefined) localStorage.removeItem(key);
		else localStorage.setItem(key, String(indent));

		// Mobile only renders the sidebar tree on the landing surface. Keep the
		// reload deterministic even if a prior desktop assertion left the app on a
		// settings/session route or with a restored session in localStorage.
		history.replaceState(history.state, "", `${location.pathname}${location.search}#/`);
	}, { key: INDENT_KEY, parentId: fixture.parentId, indent: indentPx });
}

async function reloadAndWaitForSidebarTree(page: Page, fixture: IndentFixture): Promise<void> {
	await page.reload();
	await expect.poll(async () => page.locator("button").filter({ hasText: "Settings" }).first().isVisible()
		|| page.locator("button").filter({ hasText: /^\s*Roles\s*$/ }).first().isVisible(), { timeout: 15_000 }).toBe(true);
	await expect(goalEntry(page, fixture.parentId)).toBeVisible({ timeout: 10_000 });
	await expect(goalEntry(page, fixture.childId)).toBeVisible({ timeout: 10_000 });
}

function goalEntry(page: Page, goalId: string) {
	return page.locator(`[data-goal-id='${goalId}']`).first();
}

function goalRow(page: Page, goalId: string) {
	return page.locator(`[data-goal-id='${goalId}'] [data-testid='sidebar-goal-row']`).first();
}

async function goalLeft(page: Page, goalId: string): Promise<number> {
	const row = goalRow(page, goalId);
	await expect(row).toBeVisible({ timeout: 10_000 });
	return row.evaluate((el) => el.getBoundingClientRect().left);
}

async function childOffset(page: Page, fixture: IndentFixture): Promise<number> {
	const parentLeft = await goalLeft(page, fixture.parentId);
	const childLeft = await goalLeft(page, fixture.childId);
	return childLeft - parentLeft;
}

async function openGeneralSettings(page: Page): Promise<void> {
	await navigateToHash(page, "#/settings/system/general");
	await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });
	await expect(page.locator("[data-testid='general-appearance-heading']")).toBeVisible({ timeout: 5_000 });
	await expect(indentInput(page)).toBeVisible({ timeout: 5_000 });
}

async function assertNoSidebarHorizontalOverflow(page: Page, rootSelector: string, label: string): Promise<void> {
	const root = page.locator(rootSelector).first();
	await expect(root, `${label} root`).toBeVisible({ timeout: 10_000 });
	const failures = await root.evaluate((rootEl, scenario) => {
		const root = rootEl as HTMLElement;
		const rootRect = root.getBoundingClientRect();
		const out: string[] = [];
		if (root.scrollWidth > root.clientWidth + 2) {
			out.push(`${scenario}: root scrollWidth ${root.scrollWidth} exceeds clientWidth ${root.clientWidth}`);
		}
		for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
			const rect = el.getBoundingClientRect();
			const style = getComputedStyle(el);
			if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") continue;
			if (rect.left < rootRect.left - 1 || rect.right > rootRect.right + 1) {
				out.push(`${scenario}: ${el.tagName.toLowerCase()} ${el.getAttribute("data-testid") ?? ""} ${el.getAttribute("title") ?? ""} escapes root (${rect.left.toFixed(1)}..${rect.right.toFixed(1)} vs ${rootRect.left.toFixed(1)}..${rootRect.right.toFixed(1)})`);
				if (out.length >= 5) break;
			}
		}
		return out;
	}, label);
	expect(failures, `${label} should not have horizontal overflow at max sidebar tree indentation`).toEqual([]);
}

test.describe("Sidebar tree indentation (full-stack UI)", () => {
	test.afterEach(async () => {
		for (const id of [...createdGoalIds].reverse()) await deleteGoal(id).catch(() => {});
		createdGoalIds.length = 0;
	});

	test("desktop control clamps, persists, resets, and changes nested goal offset @smoke", async ({ page }) => {
		const fixture = await createIndentFixture();
		await page.setViewportSize({ width: 1280, height: 900 });
		await openApp(page);
		await seedSidebarState(page, fixture);
		await reloadAndWaitForSidebarTree(page, fixture);
		await openGeneralSettings(page);

		await expect(page.getByLabel("Sidebar tree indentation")).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(INDENT_RESET)).toBeVisible();
		await expect(page.locator(INDENT_RESET)).toHaveText(`Reset to ${DEFAULT_PX} px`);
		expect(await indentInput(page).getAttribute("type")).toBe("number");
		expect(await indentInput(page).getAttribute("min")).toBe(String(MIN_PX));
		expect(await indentInput(page).getAttribute("max")).toBe(String(MAX_PX));
		expect(await indentInput(page).getAttribute("step")).toBe("1");
		expect(await inputValueAsNumber(page)).toBe(DEFAULT_PX);
		await waitForRuntimeIndent(page, DEFAULT_PX);
		const defaultOffset = await childOffset(page, fixture);
		expect(defaultOffset, "default nested child goal offset should be visibly indented").toBeGreaterThan(8);

		await setIndentPx(page, "24");
		await waitForRuntimeIndent(page, 24);
		expect(await inputValueAsNumber(page)).toBe(24);
		expect(await persistedIndentPx(page)).toBe(24);
		const customOffset = await childOffset(page, fixture);
		expect(customOffset - defaultOffset, "raising indentation should move child goals right").toBeGreaterThan(5);

		await reloadAndWaitForSidebarTree(page, fixture);
		await openGeneralSettings(page);
		await expect(indentInput(page)).toHaveValue("24", { timeout: 5_000 });
		await waitForRuntimeIndent(page, 24);
		expect(await childOffset(page, fixture)).toBeCloseTo(customOffset, 0);

		await setIndentPx(page, "100");
		await waitForRuntimeIndent(page, MAX_PX);
		expect(await inputValueAsNumber(page)).toBe(MAX_PX);
		expect(await persistedIndentPx(page)).toBe(MAX_PX);
		const maxOffset = await childOffset(page, fixture);
		expect(maxOffset - customOffset, "clamping to max should still apply the max visual offset").toBeGreaterThan(2);

		await page.evaluate((key) => localStorage.setItem(key, "100"), INDENT_KEY);
		await reloadAndWaitForSidebarTree(page, fixture);
		await openGeneralSettings(page);
		await expect(indentInput(page)).toHaveValue(String(MAX_PX), { timeout: 5_000 });
		await waitForRuntimeIndent(page, MAX_PX);

		await setIndentPx(page, "1");
		await waitForRuntimeIndent(page, MIN_PX);
		expect(await inputValueAsNumber(page)).toBe(MIN_PX);
		expect(await persistedIndentPx(page)).toBe(MIN_PX);
		const minOffset = await childOffset(page, fixture);
		expect(maxOffset - minOffset, "lowering indentation should move child goals left").toBeGreaterThan(15);

		await page.locator(INDENT_RESET).click();
		await waitForRuntimeIndent(page, DEFAULT_PX);
		expect(await inputValueAsNumber(page)).toBe(DEFAULT_PX);
		expect(await persistedIndentPx(page)).toBe(DEFAULT_PX);
		expect(await childOffset(page, fixture)).toBeCloseTo(defaultOffset, 0);
	});

	test("max indentation avoids horizontal overflow in expanded, mobile, and collapsed sidebars", async ({ page }) => {
		const fixture = await createIndentFixture();
		await page.setViewportSize({ width: 1280, height: 900 });
		await openApp(page);
		await seedSidebarState(page, fixture, MAX_PX);
		await reloadAndWaitForSidebarTree(page, fixture);
		await waitForRuntimeIndent(page, MAX_PX);
		await assertNoSidebarHorizontalOverflow(page, "[data-testid='sidebar-expanded']", "expanded desktop sidebar");

		await page.locator("button[title^='Collapse sidebar']").first().click();
		await expect(page.locator("[data-testid='sidebar-collapsed']")).toBeVisible({ timeout: 5_000 });
		await assertNoSidebarHorizontalOverflow(page, "[data-testid='sidebar-collapsed']", "collapsed desktop sidebar");

		await page.setViewportSize({ width: 375, height: 667 });
		await seedSidebarState(page, fixture, MAX_PX);
		await reloadAndWaitForSidebarTree(page, fixture);
		await expect(page.locator("button").filter({ hasText: /^\s*Roles\s*$/ }).first()).toBeVisible({ timeout: 15_000 });
		await waitForRuntimeIndent(page, MAX_PX);
		await assertNoSidebarHorizontalOverflow(page, ".sidebar-root", "mobile sidebar");
	});
});
