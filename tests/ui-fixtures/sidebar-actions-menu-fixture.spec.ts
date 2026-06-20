import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/sidebar-actions-menu-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "sidebar-actions-menu-fixture-bundle.js");

const SIDEBAR_SRC = path.resolve("src/app/sidebar.ts");
const RENDER_HELPERS_SRC = path.resolve("src/app/render-helpers.ts");
const SIDEBAR_POPOVER_SRC = path.resolve("src/ui/components/SidebarActionsPopover.ts");
const SIDEBAR_FLIP_SRC = path.resolve("src/ui/components/sidebar-actions-flip.ts");
const STATE_SRC = path.resolve("src/app/state.ts");
const API_SRC = path.resolve("src/app/api.ts");
const SESSION_MANAGER_SRC = path.resolve("src/app/session-manager.ts");

const MARK = "SIDEBAR_ACTIONS_FIXTURE";

type FixtureIds = {
	session: string;
	generalSession: string;
	teamLeadSession: string;
	goal: string;
	fork: string;
};

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [
			ENTRY,
			SIDEBAR_SRC,
			RENDER_HELPERS_SRC,
			SIDEBAR_POPOVER_SRC,
			SIDEBAR_FLIP_SRC,
			STATE_SRC,
			API_SRC,
			SESSION_MANAGER_SRC,
		],
	});
});

async function loadFixture(page: Page, viewport = { width: 1280, height: 900 }): Promise<FixtureIds> {
	await page.setViewportSize(viewport);
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__sidebarActionsReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__resetSidebarActionsFixture());
	await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });
	return page.evaluate(() => (window as any).__sidebarActionsFixtureIds);
}

function row(page: Page, kind: "session" | "goal", id: string): Locator {
	return kind === "session"
		? page.locator(`[data-session-id="${id}"]`).first()
		: page.locator(`[data-nav-id="goal:${id}"]`).first();
}

function trigger(page: Page, kind: "session" | "goal", id: string): Locator {
	return row(page, kind, id).locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="${kind}"][data-sidebar-actions-id="${id}"]`).first();
}

function menu(page: Page): Locator {
	return page.locator("sidebar-actions-popover [role='menu']").first();
}

function item(page: Page, actionId: string): Locator {
	return page.locator(`sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="${actionId}"]`).first();
}

function checkbox(page: Page): Locator {
	return page.locator('sidebar-actions-popover [role="menuitemcheckbox"][data-sidebar-action-id="fork"]').first();
}

async function focusMenuStop(page: Page, actionId: string, role: "menuitem" | "menuitemcheckbox"): Promise<void> {
	await page.keyboard.press("Home");
	const stopIndex = await page.locator("sidebar-actions-popover [role='menuitem'], sidebar-actions-popover [role='menuitemcheckbox']").evaluateAll(
		(els, target) => els.findIndex((el) => el.getAttribute("role") === target.role
			&& (el as HTMLElement).dataset.sidebarActionId === target.actionId),
		{ actionId, role },
	);
	expect(stopIndex, `${MARK}: expected ${role} roving-focus stop for ${actionId}`).toBeGreaterThanOrEqual(0);
	for (let i = 0; i < stopIndex; i += 1) await page.keyboard.press("ArrowDown");
}

async function openMenu(page: Page, kind: "session" | "goal", id: string): Promise<void> {
	await expect(row(page, kind, id), `${MARK}: row ${kind}:${id} should render`).toBeVisible({ timeout: 10_000 });
	await trigger(page, kind, id).click();
	await expect(menu(page), `${MARK}: menu should open for ${kind}:${id}`).toBeVisible({ timeout: 5_000 });
	await expect(trigger(page, kind, id)).toHaveAttribute("aria-expanded", "true");
}

async function expectNoPopover(page: Page): Promise<void> {
	await expect(page.locator("sidebar-actions-popover")).toHaveCount(0, { timeout: 5_000 });
}

async function expectQuickActionHiddenAndNonInteractive(action: Locator, description: string): Promise<void> {
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

async function menuLabels(page: Page): Promise<string[]> {
	return page.locator("sidebar-actions-popover [role='menuitem']").evaluateAll((els) =>
		els.map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()),
	);
}

async function menuTitleMap(page: Page): Promise<Record<string, string | null>> {
	return page.locator("sidebar-actions-popover [role='menuitem']").evaluateAll((els) =>
		Object.fromEntries(els.map((el) => [
			(el as HTMLElement).dataset.sidebarActionId || "",
			el.getAttribute("title"),
		])),
	);
}

test("hover strip layout keeps action controls out of idle-time layout flow", async ({ page }) => {
	const ids = await loadFixture(page);
	const sessionRow = row(page, "session", ids.session);
	const stripClass = await sessionRow.locator(".sidebar-actions").first().getAttribute("class");
	expect(stripClass).toContain("absolute");
	expect(stripClass).toContain("opacity-0");
	expect(stripClass).toContain("pointer-events-none");
	await expect(sessionRow.locator('span[class*="group-hover:hidden"]').first()).toBeVisible();
});

test("session and goal menus preserve popover ordering and title contracts", async ({ page }) => {
	const ids = await loadFixture(page);

	await openMenu(page, "session", ids.session);
	await expect.poll(() => menuLabels(page)).toEqual(["Modify", "Terminate", "Refresh agent", "Fork", "Copy link", "View System Prompt", "Open in new window"]);
	await expect.poll(() => menuTitleMap(page)).toMatchObject({
		modify: "Rename this session",
		"refresh-agent": "Restart this agent with the latest prompt, tools, and auth state",
		fork: "Create a new session from this session's history",
		"copy-link": "Copy a link to this session",
		"view-system-prompt": "View System Prompt",
		"open-new-window": "Open this session in a new browser window",
	});
	expect((await menuTitleMap(page)).terminate).toContain("Terminate this session");
	await page.keyboard.press("Escape");
	await expectNoPopover(page);

	await openMenu(page, "goal", ids.goal);
	await expect.poll(() => menuLabels(page)).toEqual(["Goal dashboard", "Archive", "Re-attempt", "Copy link"]);
	await expect.poll(() => menuTitleMap(page)).toEqual({
		dashboard: "Open this goal's dashboard",
		archive: "Archive this goal",
		reattempt: "Start a new attempt for this goal",
		"copy-link": "Copy a link to this goal",
	});
});

test("dismissal closes on outside click, Escape, route change, item selection, repeated toggle, and direct switch", async ({ page }) => {
	const ids = await loadFixture(page);

	await openMenu(page, "session", ids.session);
	await page.mouse.click(5, 5);
	await expectNoPopover(page);

	await openMenu(page, "session", ids.session);
	await page.keyboard.press("Escape");
	await expectNoPopover(page);

	await openMenu(page, "session", ids.session);
	await page.evaluate(() => { window.location.hash = "#/settings"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
	await expectNoPopover(page);

	await openMenu(page, "session", ids.session);
	await item(page, "copy-link").click();
	await expectNoPopover(page);

	await openMenu(page, "session", ids.session);
	await trigger(page, "session", ids.session).click();
	await expectNoPopover(page);

	await openMenu(page, "session", ids.session);
	await trigger(page, "goal", ids.goal).click();
	await expect(page.locator("sidebar-actions-popover")).toHaveCount(1, { timeout: 5_000 });
	await expect(item(page, "dashboard")).toBeVisible({ timeout: 5_000 });
});

test("copy link fallback uses legacy execCommand without surfacing a modal", async ({ page }) => {
	const ids = await loadFixture(page);

	await openMenu(page, "session", ids.session);
	await item(page, "copy-link").click();
	await expectNoPopover(page);
	await expect(page.locator("copy-link-fallback-dialog")).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => (window as any).__sidebarActionsExecCopies)).toContain(
		await page.evaluate((id) => `${location.protocol}//${location.host}/session/${id}`, ids.session),
	);

	await openMenu(page, "goal", ids.goal);
	await item(page, "copy-link").click();
	await expectNoPopover(page);
	await expect(page.locator("copy-link-fallback-dialog")).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => (window as any).__sidebarActionsExecCopies)).toContain(
		await page.evaluate((id) => `${location.origin}${location.pathname}${location.search}#/goal/${id}`, ids.goal),
	);
});

test("fork checkbox toggles independently and fork reads the current New worktree state", async ({ page }) => {
	const ids = await loadFixture(page);

	await openMenu(page, "session", ids.session);
	await expect(item(page, "fork")).toBeVisible();
	await expect(checkbox(page)).toHaveAttribute("aria-checked", "true");

	await checkbox(page).click();
	await expect(checkbox(page)).toHaveAttribute("aria-checked", "false");
	await expect(menu(page)).toBeVisible();
	expect(await page.evaluate(() => (window as any).__sidebarActionsForkBodies)).toEqual([]);

	await item(page, "fork").click();
	await expectNoPopover(page);
	await expect.poll(() => page.evaluate(() => (window as any).__sidebarActionsForkBodies)).toEqual([{ newWorktree: false }]);
});

test("fork checkbox is a roving-focus stop and Space toggles without dismissing", async ({ page }) => {
	const ids = await loadFixture(page);

	await openMenu(page, "session", ids.session);
	await expect(checkbox(page)).toHaveAttribute("aria-checked", "true");
	await focusMenuStop(page, "fork", "menuitem");
	await expect(item(page, "fork")).toBeFocused();

	await page.keyboard.press("ArrowDown");
	await expect(checkbox(page)).toBeFocused();
	await page.keyboard.press(" ");
	await expect(checkbox(page)).toHaveAttribute("aria-checked", "false");
	await expect(menu(page)).toBeVisible();
	await expect(checkbox(page)).toBeFocused();
	expect(await page.evaluate(() => (window as any).__sidebarActionsForkBodies)).toEqual([]);

	await page.keyboard.press(" ");
	await expect(checkbox(page)).toHaveAttribute("aria-checked", "true");
	await expect(menu(page)).toBeVisible();
	expect(await page.evaluate(() => (window as any).__sidebarActionsForkBodies)).toEqual([]);
});

test("role-based fork visibility mirrors the server-supported session model", async ({ page }) => {
	const ids = await loadFixture(page);

	await openMenu(page, "session", ids.generalSession);
	await expect(item(page, "copy-link")).toBeVisible();
	await expect(item(page, "fork"), "role:general sessions remain forkable").toBeVisible();
	await page.keyboard.press("Escape");
	await expectNoPopover(page);

	await openMenu(page, "session", ids.teamLeadSession);
	await expect(item(page, "copy-link")).toBeVisible();
	await expect(item(page, "fork"), "team-lead sessions are genuinely non-forkable").toHaveCount(0);
});

test("reduced-motion opens and closes without component animations", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const ids = await loadFixture(page);
	await page.evaluate(() => {
		const original = Element.prototype.animate;
		(window as any).__sidebarActionsAnimateCalls = 0;
		Element.prototype.animate = function(...args: any[]) {
			(window as any).__sidebarActionsAnimateCalls += 1;
			return original.apply(this, args as any);
		};
	});

	await openMenu(page, "session", ids.session);
	await expect(item(page, "copy-link")).toBeVisible();
	await page.keyboard.press("Escape");
	await expectNoPopover(page);
	await expect.poll(() => page.evaluate(() => (window as any).__sidebarActionsAnimateCalls)).toBe(0);
});

test("mobile rows expose quick actions plus hamburger menus without row navigation", async ({ page }) => {
	const ids = await loadFixture(page, { width: 390, height: 820 });
	const sRow = row(page, "session", ids.session);
	const sessionModify = sRow.locator('[data-sidebar-action-id="modify"][data-sidebar-action-quick="true"]').first();
	const sessionTerminate = sRow.locator('[data-sidebar-action-id="terminate"][data-sidebar-action-quick="true"]').first();
	await expect(sessionModify, "mobile session rows should expose quick modify before the hamburger opens").toBeVisible();
	await expect(sessionTerminate, "mobile session rows should expose quick terminate before the hamburger opens").toBeVisible();
	await expect(sRow.locator('[data-sidebar-action-id="copy-link"]')).toHaveCount(0);

	const startingHash = await page.evaluate(() => window.location.hash);
	const startingActive = await sRow.getAttribute("data-nav-active");
	await expect(trigger(page, "session", ids.session), "mobile session rows must expose a hamburger actions trigger").toBeVisible();
	await openMenu(page, "session", ids.session);
	await expectQuickActionHiddenAndNonInteractive(sessionModify, "mobile sidebar modify quick action");
	await expectQuickActionHiddenAndNonInteractive(sessionTerminate, "mobile sidebar terminate quick action");
	await expect.poll(() => menuLabels(page)).toEqual(["Modify", "Terminate", "Refresh agent", "Fork", "Copy link", "View System Prompt", "Open in new window"]);
	await expect(item(page, "refresh-agent")).toBeVisible();
	await expect(item(page, "fork")).toBeVisible();
	await expect(item(page, "copy-link")).toBeVisible();
	await expect(item(page, "view-system-prompt")).toBeVisible();
	await expect(item(page, "open-new-window")).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.location.hash), { message: `${MARK}: session hamburger must not select/navigate the row` }).toBe(startingHash);
	await expect(sRow).toHaveAttribute("data-nav-active", startingActive ?? "false");
	await page.keyboard.press("Escape");
	await expectNoPopover(page);
	await expect(sessionModify, "mobile sidebar modify quick action should return after Escape").toBeVisible({ timeout: 5_000 });
	await expect(sessionTerminate, "mobile sidebar terminate quick action should return after Escape").toBeVisible({ timeout: 5_000 });

	await sessionModify.click();
	await expect.poll(() => page.evaluate(() => window.location.hash), { message: `${MARK}: quick modify must not select/navigate the row` }).toBe(startingHash);
	await expect(sRow).toHaveAttribute("data-nav-active", startingActive ?? "false");
	await page.keyboard.press("Escape").catch(() => {});

	const gRow = row(page, "goal", ids.goal);
	await expect(gRow.locator('[data-sidebar-action-id="archive"][data-sidebar-action-quick="true"]')).toBeVisible();
	await expect(gRow.locator('[data-sidebar-action-id="dashboard"][data-sidebar-action-quick="true"]')).toBeVisible();
	await expect(gRow.locator('[data-sidebar-action-id="reattempt"]'), "re-attempt remains popover-only, not an inline quick action").toHaveCount(0);
	await expect(gRow.locator('[data-sidebar-action-id="copy-link"]')).toHaveCount(0);
	const emptyState = page.getByText("No sessions").first();
	const emptyStateWasVisible = await emptyState.isVisible();
	await expect(trigger(page, "goal", ids.goal), "mobile goal rows must expose a hamburger actions trigger").toBeVisible();
	await openMenu(page, "goal", ids.goal);
	await expect.poll(() => menuLabels(page)).toEqual(["Goal dashboard", "Archive", "Re-attempt", "Copy link"]);
	await expect(item(page, "reattempt")).toBeVisible();
	await expect(item(page, "copy-link")).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.location.hash), { message: `${MARK}: goal hamburger must not navigate the row` }).toBe(startingHash);
	if (emptyStateWasVisible) await expect(emptyState, `${MARK}: goal hamburger must not toggle expansion`).toBeVisible();
});
