import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/sidebar-filter-search-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "sidebar-filter-search-fixture-bundle.js");

const SIDEBAR_SRC = path.resolve("src/app/sidebar.ts");
const RENDER_HELPERS_SRC = path.resolve("src/app/render-helpers.ts");
const STATE_SRC = path.resolve("src/app/state.ts");
const API_SRC = path.resolve("src/app/api.ts");
const SIDEBAR_FILTERS_SRC = path.resolve("src/ui/components/sidebar-filters.ts");
const SEARCH_BOX_SRC = path.resolve("src/ui/components/SearchBox.ts");
const SEARCH_STATUS_DOT_SRC = path.resolve("src/app/components/search-status-dot.ts");
const SIDEBAR_NESTING_SRC = path.resolve("src/app/sidebar-nesting.ts");
const SIDEBAR_SPAWNED_CHILDREN_SRC = path.resolve("src/app/sidebar-spawned-children.ts");
const SIDEBAR_TREE_BUILDER_SRC = path.resolve("src/app/sidebar-tree-builder.ts");
const SIDEBAR_TREE_STATE_SRC = path.resolve("src/app/sidebar-tree-state.ts");
const SUBGOALS_FLAG_SRC = path.resolve("src/app/subgoals-flag.ts");

const MARK = "SIDEBAR_FILTER_SEARCH_FIXTURE";

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [
			ENTRY,
			SIDEBAR_SRC,
			RENDER_HELPERS_SRC,
			STATE_SRC,
			API_SRC,
			SIDEBAR_FILTERS_SRC,
			SEARCH_BOX_SRC,
			SEARCH_STATUS_DOT_SRC,
			SIDEBAR_NESTING_SRC,
			SIDEBAR_SPAWNED_CHILDREN_SRC,
			SIDEBAR_TREE_BUILDER_SRC,
			SIDEBAR_TREE_STATE_SRC,
			SUBGOALS_FLAG_SRC,
		],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__sidebarFilterSearchReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__resetSidebarFilterSearchFixture());
	await expect(page.locator(".sidebar-edge"), `${MARK}: sidebar should render`).toBeVisible({ timeout: 10_000 });
}

async function fixtureIds(page: Page): Promise<Record<"project" | "readSession" | "activeSession" | "busySession" | "goal" | "goalReadSession" | "collapsedParentGoal" | "nestedMatchGoal" | "archivedSession", string>> {
	return page.evaluate(() => (window as any).__sidebarFilterSearchFixtureIds);
}

async function setFilters(page: Page, filters: { showRead?: boolean; showBusy?: boolean; showArchived?: boolean }): Promise<void> {
	await page.evaluate((nextFilters) => (window as any).__setSidebarFilterSearchFixtureFilters(nextFilters), filters);
}

async function setSearch(page: Page, query: string): Promise<void> {
	await page.evaluate((nextQuery) => (window as any).__setSidebarFilterSearchFixtureSearch(nextQuery), query);
}

async function visibleSessionIds(page: Page): Promise<string[]> {
	return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".sidebar-edge [data-session-id]"))
		.filter((el) => el.offsetParent !== null)
		.map((el) => el.dataset.sessionId || "")
		.filter(Boolean));
}

async function expectSessionVisible(page: Page, sessionId: string, message: string): Promise<void> {
	await expect.poll(() => visibleSessionIds(page), { timeout: 5_000, message }).toContain(sessionId);
}

async function expectSessionHidden(page: Page, sessionId: string, message: string): Promise<void> {
	await expect.poll(() => visibleSessionIds(page), { timeout: 5_000, message }).not.toContain(sessionId);
}

test.describe("Sidebar filter/search lightweight fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("filter defaults and localStorage persistence render with the single-project sidebar", async ({ page }) => {
		const ids = await fixtureIds(page);

		await expect(page.locator(`[data-nav-id="${ids.project}"]`), `${MARK}: single project header renders`).toBeVisible();
		await expect(page.locator("button[title='Project settings']"), `${MARK}: project settings action renders`).toBeVisible();
		await expect(page.locator("button[title^='New goal in']"), `${MARK}: new goal action renders`).toBeVisible();
		await expect(page.getByText("Sessions", { exact: true }), `${MARK}: Sessions bucket renders`).toBeVisible();

		await page.getByTestId("sidebar-filters-button").click();
		const popover = page.getByTestId("sidebar-filters-popover");
		await expect(popover, `${MARK}: filters popover opens`).toBeVisible();
		await expect(popover.getByTestId("sidebar-filter-archived").locator("input"), `${MARK}: Show Archived defaults off`).not.toBeChecked();
		await expect(popover.getByTestId("sidebar-filter-busy").locator("input"), `${MARK}: Show Busy defaults on`).toBeChecked();
		await expect(popover.getByTestId("sidebar-filter-read").locator("input"), `${MARK}: Show Read defaults on`).toBeChecked();

		await popover.getByTestId("sidebar-filter-archived").locator("input").check();
		await popover.getByTestId("sidebar-filter-busy").locator("input").uncheck();
		await popover.getByTestId("sidebar-filter-read").locator("input").uncheck();
		await expect.poll(() => page.evaluate(() => ({
			archived: localStorage.getItem("bobbit-show-archived"),
			busy: localStorage.getItem("bobbit-show-busy"),
			read: localStorage.getItem("bobbit-show-read"),
		})), { timeout: 5_000 }).toEqual({ archived: "true", busy: "false", read: "false" });

		await page.evaluate(() => (window as any).__resetSidebarFilterSearchFixture({ preserveFilterStorage: true }));
		await page.getByTestId("sidebar-filters-button").click();
		const persisted = page.getByTestId("sidebar-filters-popover");
		await expect(persisted.getByTestId("sidebar-filter-archived").locator("input"), `${MARK}: Show Archived persists on`).toBeChecked();
		await expect(persisted.getByTestId("sidebar-filter-busy").locator("input"), `${MARK}: Show Busy persists off`).not.toBeChecked();
		await expect(persisted.getByTestId("sidebar-filter-read").locator("input"), `${MARK}: Show Read persists off`).not.toBeChecked();
	});

	test("search input filters rows, auto-opens archived results, supports full search, and Escape clears", async ({ page }) => {
		const ids = await fixtureIds(page);
		const searchInput = page.locator("input[data-search]");

		await searchInput.fill("ReadStandaloneAlpha");
		await expect.poll(() => page.evaluate(() => (window as any).bobbitState.searchQuery), { timeout: 5_000 }).toBe("ReadStandaloneAlpha");
		await expectSessionVisible(page, ids.readSession, `${MARK}: search input applies title filter`);
		await expectSessionHidden(page, ids.busySession, `${MARK}: search input hides non-matching rows`);
		await expect.poll(() => page.evaluate(() => (window as any).bobbitState.showArchived), { timeout: 5_000 }).toBe(true);

		await searchInput.fill("ArchivedEchoFixture");
		await expect.poll(() => page.evaluate(() => (window as any).bobbitState.searchQuery), { timeout: 5_000 }).toBe("ArchivedEchoFixture");
		await expectSessionVisible(page, ids.archivedSession, `${MARK}: search auto-opens archived section for matching archived rows`);
		await page.getByText("Full Search").click();
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 5_000 }).toContain("#/search?q=ArchivedEchoFixture");

		await page.evaluate((activeId) => window.history.replaceState({}, "", `#/session/${activeId}`), ids.activeSession);
		await searchInput.click();
		await searchInput.press("Escape");
		await expect(searchInput, `${MARK}: Escape clears the search input`).toHaveValue("");
		await expect.poll(() => page.evaluate(() => (window as any).bobbitState.searchQuery), { timeout: 5_000 }).toBe("");
		expect(await searchInput.evaluate((el) => document.activeElement === el), `${MARK}: Escape blurs search input`).toBe(false);
		await expect.poll(() => page.evaluate(() => (window as any).bobbitState.showArchived), { timeout: 5_000 }).toBe(false);
	});

	test("search expands retained collapsed goal ancestors ephemerally", async ({ page }) => {
		const ids = await fixtureIds(page);
		const storageKey = "bobbit-sidebar-tree-state:v1";

		await expect(page.locator(`[data-nav-id="${ids.collapsedParentGoal}"]`), `${MARK}: collapsed parent starts visible`).toBeVisible();
		await expect(page.locator(`[data-nav-id="${ids.nestedMatchGoal}"]`), `${MARK}: matching child starts hidden behind collapsed parent`).toBeHidden();
		const beforeStorage = await page.evaluate((key) => localStorage.getItem(key), storageKey);

		await setSearch(page, "NestedSearchNeedle");
		await expect(page.locator(`[data-nav-id="${ids.collapsedParentGoal}"]`), `${MARK}: search keeps ancestor chain`).toBeVisible();
		await expect(page.locator(`[data-nav-id="${ids.nestedMatchGoal}"]`), `${MARK}: search expands ancestor in filtered model to reveal matching child`).toBeVisible();
		await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey), { timeout: 5_000 }).toBe(beforeStorage);

		await setSearch(page, "");
		await expect(page.locator(`[data-nav-id="${ids.collapsedParentGoal}"]`), `${MARK}: clearing search keeps parent visible`).toBeVisible();
		await expect(page.locator(`[data-nav-id="${ids.nestedMatchGoal}"]`), `${MARK}: clearing search restores collapsed parent behavior`).toBeHidden();
	});

	test("Show Read and Show Busy filters hide rows while search bypasses the filters", async ({ page }) => {
		const ids = await fixtureIds(page);

		await expectSessionVisible(page, ids.readSession, `${MARK}: read standalone starts visible`);
		await expectSessionVisible(page, ids.activeSession, `${MARK}: active selected read session starts visible`);
		await expectSessionVisible(page, ids.busySession, `${MARK}: busy standalone starts visible`);
		await expectSessionVisible(page, ids.goalReadSession, `${MARK}: read goal child starts visible`);

		await setFilters(page, { showRead: false });
		await expectSessionHidden(page, ids.readSession, `${MARK}: Show Read off hides read standalone sessions`);
		await expectSessionVisible(page, ids.activeSession, `${MARK}: Show Read off keeps the active session visible`);
		await expectSessionHidden(page, ids.goalReadSession, `${MARK}: Show Read off hides read goal children`);
		await expect(page.locator(`[data-nav-id="${ids.goal}"]`), `${MARK}: goal group remains visible after child filter`).toBeVisible();

		await setSearch(page, "ReadStandaloneAlpha");
		await expectSessionVisible(page, ids.readSession, `${MARK}: search bypasses Show Read for standalone sessions`);
		await setSearch(page, "GoalChildReadCharlie");
		await expect(page.locator(`[data-nav-id="${ids.goal}"]`), `${MARK}: search keeps goal visible when child matches`).toBeVisible();
		await expectSessionVisible(page, ids.goalReadSession, `${MARK}: search bypasses Show Read for goal children`);
		await setSearch(page, "");
		await expectSessionHidden(page, ids.goalReadSession, `${MARK}: clearing search reapplies Show Read to goal children`);

		await setFilters(page, { showRead: true, showBusy: false });
		await expectSessionHidden(page, ids.busySession, `${MARK}: Show Busy off hides active work`);
		await expectSessionVisible(page, ids.readSession, `${MARK}: Show Read restored shows read sessions`);
		await setSearch(page, "BusyStandaloneBravo");
		await expectSessionVisible(page, ids.busySession, `${MARK}: search bypasses Show Busy`);
		await setSearch(page, "");
		await expectSessionHidden(page, ids.busySession, `${MARK}: clearing search reapplies Show Busy`);
	});
});
