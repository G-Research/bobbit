import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/sidebar-actions-menu-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");

const SIDEBAR_SRC = path.resolve("src/app/sidebar.ts");
const RENDER_HELPERS_SRC = path.resolve("src/app/render-helpers.ts");
const SIDEBAR_TREE_BUILDER_SRC = path.resolve("src/app/sidebar-tree-builder.ts");
const SIDEBAR_POPOVER_SRC = path.resolve("src/ui/components/SidebarActionsPopover.ts");
const SIDEBAR_FLIP_SRC = path.resolve("src/ui/components/sidebar-actions-flip.ts");
const STATE_SRC = path.resolve("src/app/state.ts");
const API_SRC = path.resolve("src/app/api.ts");
const GATEWAY_FETCH_SRC = path.resolve("src/app/gateway-fetch.ts");
const SESSION_ACTIONS_SRC = path.resolve("src/app/session-actions.ts");
const SESSION_MANAGER_SRC = path.resolve("src/app/session-manager.ts");

export const MARK = "SIDEBAR_ACTIONS_FIXTURE";

export type FixtureIds = {
	session: string;
	generalSession: string;
	teamLeadSession: string;
	goal: string;
	fork: string;
};

export function installSidebarActionsFixture(bundleFilename: string): {
	loadFixture: (page: Page, viewport?: { width: number; height: number }) => Promise<FixtureIds>;
} {
	const bundle = path.join(BUNDLE_DIR, bundleFilename);
	test.beforeAll(() => {
		fs.mkdirSync(BUNDLE_DIR, { recursive: true });
		buildBundle({
			entry: ENTRY,
			outfile: bundle,
			deps: [
				ENTRY,
				SIDEBAR_SRC,
				RENDER_HELPERS_SRC,
				SIDEBAR_TREE_BUILDER_SRC,
				SIDEBAR_POPOVER_SRC,
				SIDEBAR_FLIP_SRC,
				STATE_SRC,
				API_SRC,
				GATEWAY_FETCH_SRC,
				SESSION_ACTIONS_SRC,
				SESSION_MANAGER_SRC,
			],
		});
	});

	return {
		async loadFixture(page: Page, viewport = { width: 1280, height: 900 }): Promise<FixtureIds> {
			await page.setViewportSize(viewport);
			await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
			await page.addScriptTag({ path: bundle });
			await page.waitForFunction(() => (window as any).__sidebarActionsReady === true, null, { timeout: 10_000 });
			await page.evaluate(() => (window as any).__resetSidebarActionsFixture());
			await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });
			return page.evaluate(() => (window as any).__sidebarActionsFixtureIds);
		},
	};
}

export function row(page: Page, kind: "session" | "goal", id: string): Locator {
	return kind === "session"
		? page.locator(`[data-session-id="${id}"]`).first()
		: page.locator(`[data-nav-id="goal:${id}"]`).first();
}

export function trigger(page: Page, kind: "session" | "goal", id: string): Locator {
	return row(page, kind, id).locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="${kind}"][data-sidebar-actions-id="${id}"]`).first();
}

export function menu(page: Page): Locator {
	return page.locator("sidebar-actions-popover [role='menu']").first();
}

export function item(page: Page, actionId: string): Locator {
	return page.locator(`sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="${actionId}"]`).first();
}

export function checkbox(page: Page): Locator {
	return page.locator('sidebar-actions-popover [role="menuitemcheckbox"][data-sidebar-action-id="fork"]').first();
}

export async function focusMenuStop(page: Page, actionId: string, role: "menuitem" | "menuitemcheckbox"): Promise<void> {
	await page.keyboard.press("Home");
	const stopIndex = await page.locator("sidebar-actions-popover [role='menuitem'], sidebar-actions-popover [role='menuitemcheckbox']").evaluateAll(
		(els, target) => els.findIndex((el) => el.getAttribute("role") === target.role
			&& (el as HTMLElement).dataset.sidebarActionId === target.actionId),
		{ actionId, role },
	);
	expect(stopIndex, `${MARK}: expected ${role} roving-focus stop for ${actionId}`).toBeGreaterThanOrEqual(0);
	for (let i = 0; i < stopIndex; i += 1) await page.keyboard.press("ArrowDown");
}

export async function openMenu(page: Page, kind: "session" | "goal", id: string): Promise<void> {
	await expect(row(page, kind, id), `${MARK}: row ${kind}:${id} should render`).toBeVisible({ timeout: 10_000 });
	await trigger(page, kind, id).click();
	await expect(menu(page), `${MARK}: menu should open for ${kind}:${id}`).toBeVisible({ timeout: 5_000 });
	await expect(trigger(page, kind, id)).toHaveAttribute("aria-expanded", "true");
}

export async function expectNoPopover(page: Page): Promise<void> {
	await expect(page.locator("sidebar-actions-popover")).toHaveCount(0, { timeout: 5_000 });
}

export async function expectQuickActionHiddenAndNonInteractive(action: Locator, description: string): Promise<void> {
	await expect(action, `${description} should be hidden while the hamburger menu is open`).toBeHidden({ timeout: 5_000 });
	const interactiveTargets = await action.evaluateAll((els) => els.map((el, index) => {
		const target = el as HTMLElement;
		let current: HTMLElement | null = target;
		let hiddenByStyle = false;
		while (current) {
			const style = getComputedStyle(current);
			if (style.display === "none" || style.visibility === "hidden") {
				hiddenByStyle = true;
				break;
			}
			current = current.parentElement;
		}
		const hiddenByAttribute = Boolean(target.closest("[hidden],[aria-hidden='true'],[inert]"));
		const disabled = (target as HTMLButtonElement).disabled || target.getAttribute("aria-disabled") === "true";
		const focusBlocked = hiddenByStyle || hiddenByAttribute || disabled || target.getAttribute("tabindex") === "-1" || target.tabIndex < 0;
		const rect = target.getBoundingClientRect();
		let pointerBlocked = rect.width <= 0 || rect.height <= 0 || getComputedStyle(target).pointerEvents === "none";
		if (!pointerBlocked) {
			const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			pointerBlocked = !hit || (hit !== target && !target.contains(hit));
		}
		return focusBlocked && pointerBlocked ? "" : `target ${index}: focusBlocked=${focusBlocked} pointerBlocked=${pointerBlocked}`;
	}).filter(Boolean));
	expect(interactiveTargets, `${description} should not leave clickable or focusable targets`).toEqual([]);
}

export async function menuLabels(page: Page): Promise<string[]> {
	return page.locator("sidebar-actions-popover [role='menuitem']").evaluateAll((els) =>
		els.map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()),
	);
}

export async function menuTitleMap(page: Page): Promise<Record<string, string | null>> {
	return page.locator("sidebar-actions-popover [role='menuitem']").evaluateAll((els) =>
		Object.fromEntries(els.map((el) => [
			(el as HTMLElement).dataset.sidebarActionId || "",
			el.getAttribute("title"),
		])),
	);
}

export { test, expect };
