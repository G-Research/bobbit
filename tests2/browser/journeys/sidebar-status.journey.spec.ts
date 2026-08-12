import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/sidebar-status-journey-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "sidebar-status-journey-fixture-bundle.js");
const MARK = "SIDEBAR_STATUS_JOURNEY";

type FixtureIds = {
	project: string;
	pinnedNew: string;
	pinnedOld: string;
	unreadNew: string;
	unreadOld: string;
	readNew: string;
	readOld: string;
	busy: string;
	teamLead: string;
	teamMember: string;
	archived: string;
};

const DEPS = [
	ENTRY,
	path.resolve("src/app/sidebar.ts"),
	path.resolve("src/app/sidebar-status.ts"),
	path.resolve("src/app/sidebar-view-preferences.ts"),
	path.resolve("src/app/render.ts"),
	path.resolve("src/app/render-helpers.ts"),
	path.resolve("src/app/session-actions.ts"),
	path.resolve("src/app/api.ts"),
	path.resolve("src/app/state.ts"),
	path.resolve("src/ui/components/sidebar-filters.ts"),
	path.resolve("src/ui/components/SidebarActionsPopover.ts"),
	path.resolve("src/shared/session-tags.ts"),
];

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: DEPS });
});

async function loadFixture(page: Page): Promise<FixtureIds> {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__sidebarStatusJourneyReady === true, null, { timeout: 15_000 });
	await page.evaluate(() => (window as any).__resetSidebarStatusJourney());
	await expect(page.getByTestId("sidebar-expanded"), `${MARK}: desktop sidebar should render`).toBeVisible({ timeout: 10_000 });
	return page.evaluate(() => (window as any).__sidebarStatusJourneyIds);
}

function row(page: Page, sessionId: string): Locator {
	return page.locator(`[data-session-id="${sessionId}"]`).first();
}

function section(page: Page, key: "pinned" | "unread" | "read"): Locator {
	return page.locator(`[data-status-section="${key}"]`);
}

async function sessionIdsInSection(page: Page, key: "pinned" | "unread" | "read"): Promise<string[]> {
	return section(page, key).locator("[data-session-id]").evaluateAll((elements) =>
		elements.map((element) => (element as HTMLElement).dataset.sessionId || "").filter(Boolean),
	);
}

function filtersButton(page: Page): Locator {
	return page.getByTestId("sidebar-filters-button");
}

function filterCheckbox(page: Page, id: "archived" | "busy" | "read" | "teams"): Locator {
	return page.getByTestId(`sidebar-filter-${id}`).locator('input[type="checkbox"]');
}

async function openFilters(page: Page): Promise<void> {
	await filtersButton(page).click();
	await expect(page.getByTestId("sidebar-filters-popover")).toBeVisible();
}

async function closeFiltersWithEscape(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("sidebar-filters-popover")).toHaveCount(0);
	await expect(filtersButton(page)).toBeFocused();
}

async function openSessionMenu(page: Page, sessionId: string): Promise<void> {
	const targetRow = row(page, sessionId);
	await expect(targetRow).toBeVisible();
	await targetRow.hover();
	await targetRow.getByTestId("sidebar-actions-trigger").click();
	await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible();
}

async function menuItemIds(page: Page): Promise<string[]> {
	return page.locator("sidebar-actions-popover [role='menuitem']").evaluateAll((elements) =>
		elements.map((element) => (element as HTMLElement).dataset.sidebarActionId || "").filter(Boolean),
	);
}

async function switchToStatus(page: Page): Promise<void> {
	await page.getByTestId("sidebar-view-status").evaluate((button: HTMLButtonElement) => button.click());
	await expect(page.getByTestId("sidebar-view-status")).toHaveAttribute("aria-pressed", "true");
}

test.describe("Journey: Sidebar status views", () => {
	test("desktop journey covers status grouping, independent filters, search, pin, read, archives, actions, focus, reload, and collapse", async ({ page }) => {
		const ids = await loadFixture(page);

		// Clean profile: one search, By Project selected, and canonical tree intact.
		await expect(page.locator("input[data-search]")).toHaveCount(1);
		await expect(page.getByTestId("sidebar-view-project")).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByTestId("project-header").filter({ hasText: "Status Journey Project" })).toBeVisible();
		await expect(page.getByTestId("sidebar-sessions-header")).toBeVisible();
		await expect(row(page, ids.readNew)).toBeVisible();

		// Shared search and Full Search remain available in Project mode.
		const search = page.locator("input[data-search]");
		await search.fill("Read Newest");
		await expect(row(page, ids.readNew)).toBeVisible();
		await expect(row(page, ids.readOld)).toBeHidden();
		await expect(page.getByText("Full Search")).toBeVisible();
		await search.fill("");

		// An existing production action still opens before switching views.
		await openSessionMenu(page, ids.readNew);
		await expect(page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="modify"]')).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.locator('sidebar-actions-popover [role="menu"]')).toBeHidden();

		await switchToStatus(page);
		await expect.poll(() => page.locator("[data-status-section]").evaluateAll((elements) =>
			elements.map((element) => (element as HTMLElement).dataset.statusSection),
		)).toEqual(["pinned", "unread", "read"]);
		await expect.poll(() => sessionIdsInSection(page, "pinned")).toEqual([ids.pinnedNew, ids.pinnedOld]);
		await expect.poll(() => sessionIdsInSection(page, "unread")).toEqual([ids.unreadNew, ids.unreadOld]);
		await expect.poll(() => sessionIdsInSection(page, "read")).toEqual([ids.readNew, ids.readOld, ids.busy, ids.teamLead]);
		const allIds = await page.locator("[data-status-section] [data-session-id]").evaluateAll((elements) =>
			elements.map((element) => (element as HTMLElement).dataset.sessionId),
		);
		expect(new Set(allIds).size, `${MARK}: status sessions must be exclusive`).toBe(allIds.length);

		// Show teams is Status-only and defaults off; the lead remains visible.
		await openFilters(page);
		await expect(filterCheckbox(page, "teams")).not.toBeChecked();
		await expect(row(page, ids.teamLead)).toBeVisible();
		await expect(row(page, ids.teamMember)).toHaveCount(0);
		await filterCheckbox(page, "teams").check();
		await expect(row(page, ids.teamMember)).toBeVisible();
		await closeFiltersWithEscape(page);

		// Status and Project filter values are independent across view switches.
		await openFilters(page);
		await filterCheckbox(page, "read").uncheck();
		await closeFiltersWithEscape(page);
		await page.getByTestId("sidebar-view-project").evaluate((button: HTMLButtonElement) => button.click());
		await expect(page.getByTestId("sidebar-view-project")).toHaveAttribute("aria-pressed", "true");
		await openFilters(page);
		await expect(page.getByTestId("sidebar-filter-teams")).toHaveCount(0);
		await expect(filterCheckbox(page, "read")).toBeChecked();
		await filterCheckbox(page, "archived").check();
		await closeFiltersWithEscape(page);
		await switchToStatus(page);
		await openFilters(page);
		await expect(filterCheckbox(page, "read")).not.toBeChecked();
		await expect(filterCheckbox(page, "archived")).not.toBeChecked();
		await expect(filterCheckbox(page, "teams")).toBeChecked();
		await closeFiltersWithEscape(page);

		// Search bypasses Status visibility filters and clearing restores them.
		await expect(row(page, ids.readOld)).toHaveCount(0);
		await search.fill("Read Older");
		await expect(row(page, ids.readOld)).toBeVisible();
		await search.fill("");
		await expect(row(page, ids.readOld)).toHaveCount(0);

		// Live quick actions remain Modify, Terminate, Menu; Pin is menu-only and third.
		await openSessionMenu(page, ids.unreadNew);
		expect((await menuItemIds(page)).slice(0, 3)).toEqual(["modify", "terminate", "pin"]);
		await expect(row(page, ids.unreadNew).locator('[data-sidebar-action-id="pin"][data-sidebar-action-quick="true"]')).toHaveCount(0);
		await expect(row(page, ids.unreadNew).locator('[data-sidebar-action-id="modify"][data-sidebar-action-quick="true"]')).toHaveCount(1);
		await expect(row(page, ids.unreadNew).locator('[data-sidebar-action-id="terminate"][data-sidebar-action-quick="true"]')).toHaveCount(1);
		const trigger = row(page, ids.unreadNew).getByTestId("sidebar-actions-trigger");
		await expect(trigger).toHaveAttribute("aria-label", "Session actions");
		await expect(trigger.locator("svg")).toHaveCount(1);
		await expect(trigger.locator('path[d="M4 12h16"]')).toHaveCount(1);

		// Optimistic Pin moves immediately, reconciles, and survives fixture reload.
		await page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="pin"]').click();
		await expect(section(page, "pinned").locator(`[data-session-id="${ids.unreadNew}"]`)).toBeVisible();
		await expect.poll(() => page.evaluate((sessionId) =>
			(window as any).__sidebarStatusRequests.some((request: any) => request.route.endsWith(`/api/sessions/${sessionId}/pin`) && request.method === "PUT"),
		ids.unreadNew)).toBe(true);
		await page.evaluate(() => (window as any).__reloadSidebarStatusJourney());
		await expect(page.getByTestId("sidebar-view-status")).toHaveAttribute("aria-pressed", "true");
		await expect(section(page, "pinned").locator(`[data-session-id="${ids.unreadNew}"]`)).toBeVisible();

		// Unpin reclassifies according to unread state.
		await openSessionMenu(page, ids.unreadNew);
		await expect(page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="pin"]')).toHaveText(/Unpin session/);
		await page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="pin"]').click();
		await expect(section(page, "unread").locator(`[data-session-id="${ids.unreadNew}"]`)).toBeVisible();

		// Marking an unread session read moves it to Read; enable Read first.
		await openFilters(page);
		await filterCheckbox(page, "read").check();
		await closeFiltersWithEscape(page);
		await page.evaluate((sessionId) => (window as any).__markSidebarStatusSessionRead(sessionId), ids.unreadOld);
		await expect(section(page, "read").locator(`[data-session-id="${ids.unreadOld}"]`)).toBeVisible();

		// Active work keeps canonical shimmer/time slot and never adds busy copy.
		await expect(row(page, ids.busy).locator(".sidebar-active-dot")).toHaveCount(1);
		await expect(row(page, ids.busy)).not.toContainText(/busy|streaming/i);
		await expect(row(page, ids.readNew).getByTestId("sidebar-session-last-activity")).toBeVisible();

		// Archived visibility is Status-owned and rows/actions remain archive-safe.
		await openFilters(page);
		await filterCheckbox(page, "archived").check();
		await closeFiltersWithEscape(page);
		await expect(row(page, ids.archived)).toBeVisible();
		await expect(row(page, ids.archived)).toHaveCSS("filter", "grayscale(1)");
		await openSessionMenu(page, ids.archived);
		expect((await menuItemIds(page)).slice(0, 3)).toEqual(["continue-archived", "copy-link", "pin"]);
		await page.keyboard.press("Escape");

		// View, filters, and collapsed Status grouping persist over the reload boundary.
		await page.getByTitle(/Collapse sidebar/).click();
		await expect(page.getByTestId("sidebar-collapsed")).toBeVisible();
		await expect(page.getByTestId("sidebar-collapsed").getByRole("group", { name: /Pinned/ })).toBeVisible();
		await page.evaluate(() => (window as any).__reloadSidebarStatusJourney());
		await expect(page.getByTestId("sidebar-collapsed")).toBeVisible();
		await page.getByTitle(/Expand sidebar/).click();
		await openFilters(page);
		await expect(filterCheckbox(page, "archived")).toBeChecked();
		await expect(filterCheckbox(page, "teams")).toBeChecked();
		await closeFiltersWithEscape(page);
	});

	test("mobile exposes status controls with always-visible actions and no row-click leakage", async ({ page }) => {
		const ids = await loadFixture(page);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.evaluate(() => (window as any).__renderMobileSidebarStatusJourney());
		await expect(page.getByTestId("sidebar-view-status")).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });

		const targetRow = row(page, ids.readNew);
		await expect(targetRow).toBeVisible();
		await expect(targetRow.locator(".sidebar-mobile-action-cluster")).toBeVisible();
		await expect(targetRow.locator('[data-sidebar-action-id="modify"][data-sidebar-action-quick="true"]')).toBeVisible();
		await expect(targetRow.locator('[data-sidebar-action-id="terminate"][data-sidebar-action-quick="true"]')).toBeVisible();
		const hashBefore = await page.evaluate(() => window.location.hash);
		await targetRow.getByTestId("sidebar-actions-trigger").click();
		await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible();
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(hashBefore);

		await page.keyboard.press("Escape");
		await openFilters(page);
		await expect(filterCheckbox(page, "teams")).not.toBeChecked();
		await closeFiltersWithEscape(page);
	});
});
