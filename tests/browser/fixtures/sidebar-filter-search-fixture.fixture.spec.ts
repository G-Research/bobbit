import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../../support/fixtures/shared/build-bundle.js";

const SHELL = path.resolve("tests/support/fixtures/browser/ui/fixture-shell.html");
const ENTRY = path.resolve("tests/support/fixtures/browser/ui/sidebar-filter-search-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "sidebar-filter-search-fixture-bundle.js");

const SIDEBAR_SRC = path.resolve("src/app/sidebar.ts");
const RENDER_HELPERS_SRC = path.resolve("src/app/render-helpers.ts");
const STATE_SRC = path.resolve("src/app/state.ts");
const API_SRC = path.resolve("src/app/api.ts");
const GATEWAY_FETCH_SRC = path.resolve("src/app/gateway-fetch.ts");
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
			GATEWAY_FETCH_SRC,
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

async function fixtureIds(page: Page): Promise<Record<"project" | "readSession" | "activeSession" | "busySession" | "goal" | "goalReadSession" | "collapsedParentGoal" | "collapsedParentSession" | "childSessionParent" | "firstClassChildSession" | "delegateChildSession" | "archivedDelegateChildSession" | "nestedMatchGoal" | "archivedSession" | "archivedSessionPageTwo" | "archivedSessionPageThree" | "archivedGoalPageTwo" | "archivedGoalPageThree" | "remoteArchivedSession", string>> {
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

async function normalArchiveRequestCursors(page: Page): Promise<{ sessions: Array<string | null>; goals: Array<string | null> }> {
	return page.evaluate(() => {
		const requests = (window as any).__sidebarFilterSearchRequests as Array<{ url: string; method: string }>;
		const matchingCursors = (resource: "sessions" | "goals") => requests.flatMap((request) => {
			const url = new URL(request.url);
			const matches = request.method === "GET"
				&& url.pathname.endsWith(`/api/${resource}`)
				&& !url.searchParams.has("q")
				&& (resource === "sessions"
					? url.searchParams.get("include") === "archived"
					: url.searchParams.get("archived") === "true");
			return matches ? [url.searchParams.get("after")] : [];
		});
		return {
			sessions: matchingCursors("sessions"),
			goals: matchingCursors("goals"),
		};
	});
}

async function normalArchiveRequestCounts(page: Page): Promise<{ sessions: number; goals: number }> {
	const cursors = await normalArchiveRequestCursors(page);
	return { sessions: cursors.sessions.length, goals: cursors.goals.length };
}

async function archivePaginationState(page: Page): Promise<{
	sessionCursor: number | null;
	sessionHasMore: boolean;
	goalCursor: number | null;
	goalHasMore: boolean;
	sessionIds: string[];
	goalIds: string[];
}> {
	return page.evaluate(() => {
		const fixtureState = (window as any).bobbitState;
		return {
			sessionCursor: fixtureState.archivedSessionsCursor,
			sessionHasMore: fixtureState.archivedSessionsHasMore,
			goalCursor: fixtureState.archivedGoalsCursor,
			goalHasMore: fixtureState.archivedGoalsHasMore,
			sessionIds: fixtureState.archivedSessions.map((session: any) => session.id),
			goalIds: fixtureState.goals.filter((goal: any) => goal.archived).map((goal: any) => goal.id),
		};
	});
}

async function enableArchivedForActiveView(page: Page): Promise<void> {
	await page.getByTestId("sidebar-filters-button").click();
	const checkbox = page.getByTestId("sidebar-filter-archived").locator("input");
	if (!(await checkbox.isChecked())) await checkbox.check();
}

async function selectSidebarView(page: Page, view: "project" | "status"): Promise<void> {
	// The fixed-height fixture can geometrically overlap a lower pagination row
	// with this sticky control. Invoke the real button handler without hit-testing.
	await page.getByTestId(`sidebar-view-${view}`).evaluate((button: HTMLButtonElement) => button.click());
}

async function loadNextNormalArchivePages(page: Page): Promise<void> {
	await page.getByText("Load more archived sessions…", { exact: true }).click();
	await page.getByText("Load more archived goals…", { exact: true }).click();
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

	test("render-time session updates use the mounted active gateway connection", async ({ page }) => {
		const ids = await fixtureIds(page);
		await expect.poll(() => page.evaluate((sessionId) =>
			(window as any).__sidebarFilterSearchRequests.find((request: any) =>
				request.method === "PATCH" && request.url.endsWith(`/api/sessions/${sessionId}`)), ids.readSession), {
			timeout: 5_000,
			message: `${MARK}: rendering should persist the assigned session colour through the gateway boundary`,
		}).toMatchObject({
			url: `https://fixture.test/team/bobbit/api/sessions/${ids.readSession}`,
			method: "PATCH",
			credentials: null,
			authorization: "Bearer fixture-token",
		});
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
		await expect.poll(() => page.evaluate(() => ({
			projectArchived: (window as any).bobbitState.showArchived,
			searchDemand: (window as any).bobbitState.archivedSearchDemand,
		})), { timeout: 5_000 }).toEqual({ projectArchived: false, searchDemand: true });

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
		await expect.poll(() => page.evaluate(() => ({
			projectArchived: (window as any).bobbitState.showArchived,
			searchDemand: (window as any).bobbitState.archivedSearchDemand,
		})), { timeout: 5_000 }).toEqual({ projectArchived: false, searchDemand: false });
	});

	test("Status archive search keeps Project preference independent and remote q results current", async ({ page }) => {
		const ids = await fixtureIds(page);
		await page.getByTestId("sidebar-view-status").evaluate((button: HTMLButtonElement) => button.click());
		const searchInput = page.locator("input[data-search]");
		await searchInput.fill("RemoteBeyondFirstPageNeedle");

		await expectSessionVisible(page, ids.remoteArchivedSession, `${MARK}: remote archived q result beyond the unfiltered page is shown`);
		await expect.poll(() => page.evaluate(() => ({
			projectArchived: (window as any).bobbitState.showArchived,
			searchDemand: (window as any).bobbitState.archivedSearchDemand,
		})), { timeout: 5_000 }).toEqual({ projectArchived: false, searchDemand: true });

		await page.getByTestId("sidebar-filters-button").click();
		await page.getByTestId("sidebar-filter-archived").locator("input").check();
		await expectSessionVisible(page, ids.remoteArchivedSession, `${MARK}: toggling Status archived must not invalidate the active remote q result`);
		await expect.poll(() => page.evaluate(() =>
			(window as any).__sidebarFilterSearchRequests.filter((request: any) => request.url.includes("/api/sessions") && request.url.includes("q=RemoteBeyondFirstPageNeedle")).length,
		), { timeout: 5_000 }).toBeGreaterThan(0);

		await page.getByTestId("sidebar-view-project").evaluate((button: HTMLButtonElement) => button.click());
		await page.getByTestId("sidebar-filters-button").click();
		await expect(page.getByTestId("sidebar-filter-archived").locator("input"), `${MARK}: Project Show Archived stays off while query is retained`).not.toBeChecked();
		await expect.poll(() => page.evaluate(() => (window as any).bobbitState.searchQuery)).toBe("RemoteBeyondFirstPageNeedle");
	});

	for (const view of ["Project", "Status"] as const) {
		test(`${view} Show Archived starts a normal archive load after remote search clears`, async ({ page }) => {
			const ids = await fixtureIds(page);
			if (view === "Status") {
				await page.getByTestId("sidebar-view-status").evaluate((button: HTMLButtonElement) => button.click());
			}
			const searchInput = page.locator("input[data-search]");
			// The staff section performs one eager archive-session lookup. Clear a
			// no-preference search once to exercise production cache eviction and
			// start the regression scenario with both normal archive caches fresh.
			await searchInput.fill("RemoteBeyondFirstPageNeedle");
			await expectSessionVisible(page, ids.remoteArchivedSession, `${MARK}: ${view} setup search shows the remote-only archived row`);
			await searchInput.press("Escape");
			await expect(searchInput, `${MARK}: ${view} setup search clears`).toHaveValue("");
			const baselineRequests = await normalArchiveRequestCounts(page);

			await searchInput.fill("RemoteBeyondFirstPageNeedle");
			await expectSessionVisible(page, ids.remoteArchivedSession, `${MARK}: ${view} fresh-cache search shows the remote-only archived row`);
			await page.getByTestId("sidebar-filters-button").click();
			await page.getByTestId("sidebar-filter-archived").locator("input").check();
			await expect.poll(() => normalArchiveRequestCounts(page), {
				timeout: 5_000,
				message: `${MARK}: ${view} toggle must stay on the current remote query while search is active`,
			}).toEqual(baselineRequests);

			await searchInput.click();
			await searchInput.press("Escape");
			await expect(searchInput, `${MARK}: ${view} search clears`).toHaveValue("");
			await expect.poll(() => normalArchiveRequestCounts(page), {
				timeout: 5_000,
				message: `${MARK}: ${view} clear must fulfil deferred normal session and goal archive demand`,
			}).toEqual({ sessions: baselineRequests.sessions + 1, goals: baselineRequests.goals + 1 });
			await expect.poll(() => page.evaluate((activeView) => {
				const fixtureState = (window as any).bobbitState;
				return activeView === "Status" ? fixtureState.statusShowArchived : fixtureState.showArchived;
			}, view), { timeout: 5_000 }).toBe(true);
			await expectSessionVisible(page, ids.archivedSession, `${MARK}: ${view} shows a nonmatching row from the normal archive page`);
			await expect(page.getByText("Load more archived sessions…", { exact: true }), `${MARK}: ${view} exposes normal session pagination`).toBeVisible();
			await expect(page.getByText("Load more archived goals…", { exact: true }), `${MARK}: ${view} exposes normal goal pagination`).toBeVisible();
		});
	}

	test("shared archive pages and cursors survive enabling and switching the second view", async ({ page }) => {
		const ids = await fixtureIds(page);
		await enableArchivedForActiveView(page);
		await expect.poll(() => normalArchiveRequestCursors(page), {
			timeout: 5_000,
			message: `${MARK}: cold Project demand loads each first archive page exactly once`,
		}).toEqual({ sessions: [null], goals: [null] });

		await loadNextNormalArchivePages(page);
		await expect.poll(() => normalArchiveRequestCursors(page), {
			timeout: 5_000,
			message: `${MARK}: Load more requests the second unseen page for each resource`,
		}).toEqual({ sessions: [null, "200"], goals: [null, "200"] });
		await expect.poll(() => archivePaginationState(page), { timeout: 5_000 }).toMatchObject({
			sessionCursor: 100,
			sessionHasMore: true,
			goalCursor: 100,
			goalHasMore: true,
			sessionIds: expect.arrayContaining([ids.archivedSessionPageTwo]),
			goalIds: expect.arrayContaining([ids.archivedGoalPageTwo]),
		});

		await selectSidebarView(page, "status");
		await enableArchivedForActiveView(page);
		await selectSidebarView(page, "project");
		await selectSidebarView(page, "status");

		await expect.poll(() => normalArchiveRequestCursors(page), {
			timeout: 5_000,
			message: `${MARK}: enabling and switching an archived-enabled peer view must not replay page one`,
		}).toEqual({ sessions: [null, "200"], goals: [null, "200"] });
		await expect.poll(() => archivePaginationState(page), { timeout: 5_000 }).toMatchObject({
			sessionCursor: 100,
			sessionHasMore: true,
			goalCursor: 100,
			goalHasMore: true,
			sessionIds: expect.arrayContaining([ids.archivedSessionPageTwo]),
			goalIds: expect.arrayContaining([ids.archivedGoalPageTwo]),
		});

		await loadNextNormalArchivePages(page);
		await expect.poll(() => normalArchiveRequestCursors(page), {
			timeout: 5_000,
			message: `${MARK}: preserved cursors request the next unseen page`,
		}).toEqual({ sessions: [null, "200", "100"], goals: [null, "200", "100"] });
		await expect.poll(() => archivePaginationState(page), { timeout: 5_000 }).toMatchObject({
			sessionCursor: null,
			sessionHasMore: false,
			goalCursor: null,
			goalHasMore: false,
			sessionIds: expect.arrayContaining([ids.archivedSessionPageTwo, ids.archivedSessionPageThree]),
			goalIds: expect.arrayContaining([ids.archivedGoalPageTwo, ids.archivedGoalPageThree]),
		});
	});

	test("active archive search keeps shared normal pagination untouched across view demand changes", async ({ page }) => {
		const ids = await fixtureIds(page);
		await enableArchivedForActiveView(page);
		await expect.poll(() => normalArchiveRequestCursors(page), { timeout: 5_000 })
			.toEqual({ sessions: [null], goals: [null] });
		await loadNextNormalArchivePages(page);
		await expect.poll(() => normalArchiveRequestCursors(page), { timeout: 5_000 })
			.toEqual({ sessions: [null, "200"], goals: [null, "200"] });

		const searchInput = page.locator("input[data-search]");
		await searchInput.fill("RemoteBeyondFirstPageNeedle");
		await expectSessionVisible(page, ids.remoteArchivedSession, `${MARK}: remote q result remains the active archive search source`);
		await expect.poll(() => page.evaluate(() => {
			const requests = (window as any).__sidebarFilterSearchRequests as Array<{ url: string; method: string }>;
			return requests.reduce((counts, request) => {
				const url = new URL(request.url);
				if (request.method === "GET" && url.searchParams.get("q") === "RemoteBeyondFirstPageNeedle") {
					if (url.pathname.endsWith("/api/sessions")) counts.sessions++;
					if (url.pathname.endsWith("/api/goals")) counts.goals++;
				}
				return counts;
			}, { sessions: 0, goals: 0 });
		}), { timeout: 5_000, message: `${MARK}: shared search issues remote q requests for both archive resources` }).toEqual({ sessions: 1, goals: 1 });

		await selectSidebarView(page, "status");
		await enableArchivedForActiveView(page);
		await selectSidebarView(page, "project");
		await selectSidebarView(page, "status");

		await expect.poll(() => normalArchiveRequestCursors(page), {
			timeout: 5_000,
			message: `${MARK}: active q transitions must not restart normal archive pagination`,
		}).toEqual({ sessions: [null, "200"], goals: [null, "200"] });
		await expect.poll(() => archivePaginationState(page), { timeout: 5_000 }).toMatchObject({
			sessionCursor: 100,
			sessionHasMore: true,
			goalCursor: 100,
			goalHasMore: true,
			sessionIds: expect.arrayContaining([ids.archivedSessionPageTwo]),
			goalIds: expect.arrayContaining([ids.archivedGoalPageTwo]),
		});
		await expectSessionVisible(page, ids.remoteArchivedSession, `${MARK}: view/filter transitions retain the current remote q result`);

		await searchInput.press("Escape");
		await expect(searchInput).toHaveValue("");
		await expect.poll(() => normalArchiveRequestCursors(page), {
			timeout: 5_000,
			message: `${MARK}: clearing q reuses the already-loaded normal pages`,
		}).toEqual({ sessions: [null, "200"], goals: [null, "200"] });
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

	test("search reveals matching runtime rows under collapsed goals without persisting expansion", async ({ page }) => {
		const ids = await fixtureIds(page);
		const storageKey = "bobbit-sidebar-tree-state:v1";

		await expect(page.locator(`[data-nav-id="${ids.collapsedParentGoal}"]`), `${MARK}: collapsed goal starts visible`).toBeVisible();
		await expectSessionHidden(page, ids.collapsedParentSession, `${MARK}: runtime child starts hidden behind collapsed goal`);
		const beforeStorage = await page.evaluate((key) => localStorage.getItem(key), storageKey);

		await setSearch(page, "runtime-child-role-needle");
		await expect(page.locator(`[data-nav-id="${ids.collapsedParentGoal}"]`), `${MARK}: search keeps collapsed goal with matching runtime row`).toBeVisible();
		await expectSessionVisible(page, ids.collapsedParentSession, `${MARK}: search expands pruned model to reveal matching runtime role row`);
		await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey), { timeout: 5_000 }).toBe(beforeStorage);

		await setSearch(page, "");
		await expect(page.locator(`[data-nav-id="${ids.collapsedParentGoal}"]`), `${MARK}: clearing search keeps goal visible`).toBeVisible();
		await expectSessionHidden(page, ids.collapsedParentSession, `${MARK}: clearing search restores collapsed goal behavior`);
	});

	test("search retains matching first-class and delegate child sessions with goal ownership", async ({ page }) => {
		const ids = await fixtureIds(page);
		const storageKey = "bobbit-sidebar-tree-state:v1";

		await expectSessionHidden(page, ids.childSessionParent, `${MARK}: child parent starts hidden behind collapsed goal`);
		await expectSessionHidden(page, ids.firstClassChildSession, `${MARK}: first-class child starts hidden behind collapsed goal`);
		await expectSessionHidden(page, ids.delegateChildSession, `${MARK}: delegate child starts hidden behind collapsed goal`);
		const beforeStorage = await page.evaluate((key) => localStorage.getItem(key), storageKey);

		await setSearch(page, "FirstClassChildNeedle");
		await expect(page.locator(`[data-nav-id="${ids.collapsedParentGoal}"]`), `${MARK}: search retains owning collapsed goal for first-class child`).toBeVisible();
		await expectSessionVisible(page, ids.childSessionParent, `${MARK}: search keeps first-class child parent as placement container`);
		await expectSessionVisible(page, ids.firstClassChildSession, `${MARK}: search reveals matching first-class child with goalId`);
		await expectSessionHidden(page, ids.delegateChildSession, `${MARK}: search does not show non-matching delegate sibling broadly`);
		await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey), { timeout: 5_000 }).toBe(beforeStorage);

		await setSearch(page, "DelegateChildNeedle");
		await expect(page.locator(`[data-nav-id="${ids.collapsedParentGoal}"]`), `${MARK}: search retains owning collapsed goal for delegate child`).toBeVisible();
		await expectSessionVisible(page, ids.childSessionParent, `${MARK}: search keeps delegate parent as placement container`);
		await expectSessionVisible(page, ids.delegateChildSession, `${MARK}: search reveals matching delegate child with goalId`);
		await expectSessionHidden(page, ids.firstClassChildSession, `${MARK}: search does not show non-matching first-class sibling broadly`);
		await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey), { timeout: 5_000 }).toBe(beforeStorage);

		await setFilters(page, { showArchived: true });
		await setSearch(page, "ArchivedDelegateChildNeedle");
		await expect(page.locator(`[data-nav-id="${ids.collapsedParentGoal}"]`), `${MARK}: search retains owning collapsed goal for archived delegate child`).toBeVisible();
		await expectSessionVisible(page, ids.childSessionParent, `${MARK}: search keeps archived delegate parent as placement container`);
		await expectSessionVisible(page, ids.archivedDelegateChildSession, `${MARK}: search reveals matching archived delegate child with goalId/teamGoalId`);
		await expectSessionHidden(page, ids.firstClassChildSession, `${MARK}: archived delegate search keeps non-matching live child hidden`);
		await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey), { timeout: 5_000 }).toBe(beforeStorage);

		await setSearch(page, "");
		await expectSessionHidden(page, ids.firstClassChildSession, `${MARK}: clearing search restores collapsed goal for first-class child`);
		await expectSessionHidden(page, ids.delegateChildSession, `${MARK}: clearing search restores collapsed goal for delegate child`);
		await expectSessionHidden(page, ids.archivedDelegateChildSession, `${MARK}: clearing search restores collapsed goal for archived delegate child`);
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
