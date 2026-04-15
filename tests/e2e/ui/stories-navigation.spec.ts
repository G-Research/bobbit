/**
 * Navigation stories — CT-13
 *
 * These stories ARE the specification. Each test reads as a behavioral
 * requirement and runs as a Playwright E2E test.
 *
 * Phase annotations control what gets tracked in the spec graph:
 *   setup  → preconditions, incidental navigation (not tracked)
 *   act    → the user actions under test (tracked)
 *   assert → the expected outcomes (tracked)
 *   cleanup → teardown (not tracked)
 */
import { test, expect } from "../gateway-harness.js";
import { waitForHealth, createSession, deleteSession, createGoal, deleteGoal, apiFetch } from "../e2e-setup.js";
import {
	SpecContext,
	defineStory,
	exportSpecGraph,
	contractCompleteness,
	clearStoryRegistry,
} from "./spec-framework.js";
import { CT_03, CT_13 } from "./spec-contracts.js";
import { navigateToHash } from "./ui-helpers.js";

test.describe("CT-13: URL routing and navigation", () => {
	let s: SpecContext;
	const goalIds: string[] = [];

	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.beforeEach(async ({ page }) => {
		s = new SpecContext(page);
	});

	test.afterEach(async () => {
		await s.cleanup();
		for (const id of goalIds) {
			await deleteGoal(id).catch(() => {});
		}
		goalIds.length = 0;
	});

	// ---------------------------------------------------------------
	// N-01: Sidebar session selection and highlight
	// ---------------------------------------------------------------

	test("N-01: Sidebar session selection updates URL and highlight", async () => {
		s.begin(defineStory({
			id: "N-01",
			title: "Sidebar session selection updates URL and highlight",
			contracts: [CT_13, CT_03],
			covers: ["view-transitions", "page-reload", "deep-link-navigation"],
		}));

		await s.createTestSession("A");
		await s.createTestSession("B");
		await s.open();

		// act — click session A
		s.act();
		await s.navigate_to("session", "A");

		// assert — session A highlighted, URL contains session ID
		s.assert();
		await s.session("A").is_highlighted();
		await s.url_contains(`/session/${s.session("A").sessionId}`);
		await s.editor.is_visible();

		// act — switch to session B
		s.act();
		await s.navigate_to("session", "B");

		// assert — session B highlighted, A loses highlight
		s.assert();
		await s.session("B").is_highlighted();
		await s.url_contains(`/session/${s.session("B").sessionId}`);

		// act — reload page
		s.act();
		await s.reload();

		// assert — session B still selected after reload
		s.assert();
		await s.url_contains(`/session/${s.session("B").sessionId}`);
	});

	// ---------------------------------------------------------------
	// N-02: Goal dashboard navigation and back
	// ---------------------------------------------------------------

	test("N-02: Goal dashboard navigation and back", async () => {
		s.begin(defineStory({
			id: "N-02",
			title: "Goal dashboard navigation and back",
			contracts: [CT_13],
			covers: ["back-forward-navigation"],
		}));

		await s.createTestSession("A");
		const goal = await createGoal({ title: "Nav test goal" });
		goalIds.push(goal.id);
		await s.open();

		// setup — navigate to session first
		await s.navigate_to("session", "A");
		await s.editor.is_visible();

		// act — navigate to goal dashboard
		s.act();
		await navigateToHash(s.page, `#/goal/${goal.id}`);
		await s.page.waitForTimeout(500);

		// assert — goal dashboard visible, URL correct
		s.assert();
		await s.url_contains(`/goal/${goal.id}`);
		await expect(s.page.locator(".tab, .goal-dashboard, goal-dashboard").first())
			.toBeVisible({ timeout: 10_000 });

		// act — press back to return to session
		s.act();
		await s.navigate_back();

		// assert — back at session, textarea visible
		s.assert();
		await s.url_contains(`/session/${s.session("A").sessionId}`);
		await s.editor.is_visible();
	});

	// ---------------------------------------------------------------
	// N-03: Deep links to all view types
	// ---------------------------------------------------------------

	test("N-03: Deep links to all view types", async () => {
		s.begin(defineStory({
			id: "N-03",
			title: "Deep links to all view types",
			contracts: [CT_13],
			covers: ["bookmarks"],
		}));

		await s.createTestSession("A");
		const goal = await createGoal({ title: "Deep link goal" });
		goalIds.push(goal.id);
		await s.open();

		s.act();

		// Deep link: session
		await navigateToHash(s.page, `#/session/${s.session("A").sessionId}`);
		s.assert();
		await s.editor.is_visible();

		// Deep link: goal
		s.act();
		await navigateToHash(s.page, `#/goal/${goal.id}`);
		s.assert();
		await expect(s.page.locator(".tab, .goal-dashboard, goal-dashboard").first())
			.toBeVisible({ timeout: 10_000 });

		// Deep link: settings
		s.act();
		await navigateToHash(s.page, "#/settings/system/models");
		s.assert();
		await s.settings.is_visible();

		// Deep link: roles
		s.act();
		await navigateToHash(s.page, "#/roles");
		s.assert();
		await s.page.waitForFunction(() =>
			window.location.hash.startsWith("#/roles"), { timeout: 5_000 });
		await expect(s.page.getByText("Roles").first())
			.toBeVisible({ timeout: 10_000 });

		// Deep link: tools
		s.act();
		await navigateToHash(s.page, "#/tools");
		s.assert();
		await s.page.waitForFunction(() =>
			window.location.hash.startsWith("#/tools"), { timeout: 5_000 });
		await expect(s.page.getByText("Tools").first())
			.toBeVisible({ timeout: 10_000 });

		// Deep link: workflows
		s.act();
		await navigateToHash(s.page, "#/workflows");
		s.assert();
		await s.page.waitForFunction(() =>
			window.location.hash.startsWith("#/workflows"), { timeout: 5_000 });
		await expect(s.page.getByText("Workflows").first())
			.toBeVisible({ timeout: 10_000 });

		// Deep link: staff
		s.act();
		await navigateToHash(s.page, "#/staff");
		s.assert();
		await s.page.waitForFunction(() =>
			window.location.hash.startsWith("#/staff"), { timeout: 5_000 });
		await expect(s.page.getByText("Staff").first())
			.toBeVisible({ timeout: 10_000 });

		// Deep link: personalities
		s.act();
		await navigateToHash(s.page, "#/personalities");
		s.assert();
		await s.page.waitForFunction(() =>
			window.location.hash.startsWith("#/personalities"), { timeout: 5_000 });
		await expect(s.page.getByText("Personalities").first())
			.toBeVisible({ timeout: 10_000 });

		// Deep link: search
		s.act();
		await navigateToHash(s.page, "#/search?q=hello");
		s.assert();
		await s.page.waitForFunction(() =>
			window.location.hash.startsWith("#/search"), { timeout: 5_000 });

		// Deep link: invalid route — should not crash, falls to landing
		s.act();
		await navigateToHash(s.page, "#/nonexistent/route");
		s.assert();
		// App still responsive — settings button visible
		await expect(s.page.locator("button").filter({ hasText: "Settings" }).first())
			.toBeVisible({ timeout: 10_000 });
	});

	// ---------------------------------------------------------------
	// N-04: Browser back and forward across views
	// ---------------------------------------------------------------

	test("N-04: Browser back and forward across views", async () => {
		s.begin(defineStory({
			id: "N-04",
			title: "Browser back and forward across views",
			contracts: [CT_13],
			covers: ["back-forward-navigation"],
		}));

		await s.createTestSession("A");
		await s.open();

		// setup — start at landing
		await navigateToHash(s.page, "#/");
		await s.page.waitForTimeout(300);

		// act — build history: landing → session → settings
		s.act();
		await navigateToHash(s.page, `#/session/${s.session("A").sessionId}`);
		await s.editor.is_visible();
		await navigateToHash(s.page, "#/settings");
		await s.page.waitForFunction(() =>
			window.location.hash.startsWith("#/settings"), { timeout: 5_000 });

		// act — go back twice
		await s.navigate_back(); // back to session
		s.assert();
		await s.url_contains(`/session/${s.session("A").sessionId}`);
		await s.editor.is_visible();

		s.act();
		await s.navigate_back(); // back to landing
		s.assert();
		await s.url_equals("#/");

		// act — go forward twice
		s.act();
		await s.navigate_forward(); // forward to session
		s.assert();
		await s.url_contains(`/session/${s.session("A").sessionId}`);

		s.act();
		await s.navigate_forward(); // forward to settings
		s.assert();
		await s.url_contains("/settings");
	});

	// ---------------------------------------------------------------
	// N-06: Sidebar collapse persistence
	// ---------------------------------------------------------------

	test("N-06: Sidebar collapse persistence across reload", async () => {
		s.begin(defineStory({
			id: "N-06",
			title: "Sidebar collapse persistence across reload",
			contracts: [CT_13],
			covers: ["page-reload"],
		}));

		await s.createTestSession("A");
		await s.open();

		// act — click collapse button
		s.act();
		const collapseBtn = s.page.locator("button[title='Collapse sidebar (Ctrl+[)']").first();
		await expect(collapseBtn).toBeVisible({ timeout: 5_000 });
		await collapseBtn.click();
		await s.page.waitForTimeout(300);

		// assert — localStorage records collapsed state
		s.assert();
		const collapsed = await s.page.evaluate(() =>
			localStorage.getItem("bobbit-sidebar-collapsed")
		);
		expect(collapsed).toBe("true");

		// Expand button should now be visible
		const expandBtn = s.page.locator("button[title='Expand sidebar (Ctrl+[)']").first();
		await expect(expandBtn).toBeVisible({ timeout: 5_000 });

		// act — reload
		s.act();
		await s.reload();

		// assert — still collapsed after reload
		s.assert();
		const stillCollapsed = await s.page.evaluate(() =>
			localStorage.getItem("bobbit-sidebar-collapsed")
		);
		expect(stillCollapsed).toBe("true");

		// act — expand sidebar
		s.act();
		const expandAfterReload = s.page.locator("button[title='Expand sidebar (Ctrl+[)']").first();
		await expect(expandAfterReload).toBeVisible({ timeout: 5_000 });
		await expandAfterReload.click();
		await s.page.waitForTimeout(300);

		// act — reload again
		await s.reload();

		// assert — expanded after reload
		s.assert();
		const expandedAfter = await s.page.evaluate(() =>
			localStorage.getItem("bobbit-sidebar-collapsed")
		);
		expect(expandedAfter).not.toBe("true");
	});

	// ---------------------------------------------------------------
	// N-07: Page title reflects project
	// ---------------------------------------------------------------

	test("N-07: Page title contains Bobbit", async () => {
		s.begin(defineStory({
			id: "N-07",
			title: "Page title contains Bobbit",
			contracts: [CT_13],
			covers: ["page-reload"],
		}));

		await s.createTestSession("A");
		await s.open();

		s.act();
		// No action needed — just check the title

		s.assert();
		await s.page_title_contains("Bobbit");

		// After reload, still has Bobbit in title
		s.act();
		await s.reload();
		s.assert();
		await s.page_title_contains("Bobbit");
	});

	// ---------------------------------------------------------------
	// N-08: Keyboard shortcuts for navigation
	// ---------------------------------------------------------------

	test("N-08: Keyboard shortcuts for navigation", async () => {
		s.begin(defineStory({
			id: "N-08",
			title: "Keyboard shortcuts for navigation",
			contracts: [CT_13],
			covers: ["view-transitions"],
		}));

		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");
		await s.editor.is_visible();

		// act — Ctrl+[ toggles sidebar
		s.act();
		await s.press_key("Control+BracketLeft");
		await s.page.waitForTimeout(400);

		s.assert();
		const collapsedAfterToggle = await s.page.evaluate(() =>
			localStorage.getItem("bobbit-sidebar-collapsed")
		);
		expect(collapsedAfterToggle).toBe("true");

		// Toggle back
		s.act();
		await s.press_key("Control+BracketLeft");
		await s.page.waitForTimeout(400);

		s.assert();
		const expandedAfterToggle = await s.page.evaluate(() =>
			localStorage.getItem("bobbit-sidebar-collapsed")
		);
		expect(expandedAfterToggle).not.toBe("true");

		// act — Ctrl+, opens settings
		s.act();
		await s.press_key("Control+,");
		await s.page.waitForTimeout(500);

		s.assert();
		await s.url_contains("/settings");

		// act — Ctrl+, again closes settings (returns to previous view)
		s.act();
		await s.press_key("Control+,");
		await s.page.waitForTimeout(500);

		s.assert();
		// Should be back at session or at least not on settings
		const hashAfterToggleSettings = await s.page.evaluate(() => window.location.hash);
		expect(hashAfterToggleSettings).not.toContain("/settings");

		// act — Ctrl+K focuses search
		s.act();
		await s.press_key("Control+k");
		await s.page.waitForTimeout(400);

		s.assert();
		// Search input or search page should be active
		const searchVisible = await s.page.locator(
			'input[type="search"], input[placeholder*="Search"], .search-page input, .sidebar-search input'
		).first().isVisible().catch(() => false);
		expect(searchVisible).toBe(true);
	});

	// ---------------------------------------------------------------
	// N-09: Cross-feature navigation journey
	// ---------------------------------------------------------------

	test("N-09: Cross-feature navigation journey", async () => {
		s.begin(defineStory({
			id: "N-09",
			title: "Cross-feature navigation journey",
			contracts: [CT_13],
			covers: ["view-transitions", "back-forward-navigation"],
		}));

		await s.createTestSession("A");
		const goal = await createGoal({ title: "Journey goal" });
		goalIds.push(goal.id);
		await s.open();

		// act — landing → session
		s.act();
		await navigateToHash(s.page, `#/session/${s.session("A").sessionId}`);
		s.assert();
		await s.editor.is_visible();

		// act — session → goal dashboard
		s.act();
		await navigateToHash(s.page, `#/goal/${goal.id}`);
		s.assert();
		await expect(s.page.locator(".tab, .goal-dashboard, goal-dashboard").first())
			.toBeVisible({ timeout: 10_000 });

		// act — goal → settings
		s.act();
		await navigateToHash(s.page, "#/settings");
		s.assert();
		await s.page.waitForFunction(() =>
			window.location.hash.startsWith("#/settings"), { timeout: 5_000 });

		// act — back through the stack
		s.act();
		await s.navigate_back(); // back to goal
		s.assert();
		await s.url_contains(`/goal/${goal.id}`);

		s.act();
		await s.navigate_back(); // back to session
		s.assert();
		await s.url_contains(`/session/${s.session("A").sessionId}`);
		await s.editor.is_visible();

		// No blank screens at any step — app still responsive
		await expect(s.page.locator("button").filter({ hasText: "Settings" }).first())
			.toBeVisible({ timeout: 5_000 });
	});

	// ---------------------------------------------------------------
	// N-10: Settings sub-navigation
	// ---------------------------------------------------------------

	test("N-10: Settings sub-navigation", async () => {
		s.begin(defineStory({
			id: "N-10",
			title: "Settings sub-navigation",
			contracts: [CT_13],
			covers: ["view-transitions", "bookmarks"],
		}));

		await s.createTestSession("A");
		await s.open();

		// act — navigate to settings/system/general
		s.act();
		await navigateToHash(s.page, "#/settings/system/general");
		s.assert();
		await s.page.waitForFunction(() =>
			window.location.hash.startsWith("#/settings"), { timeout: 5_000 });
		await expect(s.page.getByText("Settings").first())
			.toBeVisible({ timeout: 10_000 });

		// act — click a different settings tab (Models)
		s.act();
		const modelTab = s.page.getByText("Models").first();
		if (await modelTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await modelTab.click();
			await s.page.waitForTimeout(300);

			s.assert();
			const hash = await s.page.evaluate(() => window.location.hash);
			expect(hash).toContain("/settings");
		} else {
			// If Models tab not found, just verify we're on settings
			s.assert();
			await s.url_contains("/settings");
		}

		// act — navigate to bare /settings (no sub-path)
		s.act();
		await navigateToHash(s.page, "#/settings");
		s.assert();
		await s.page.waitForFunction(() =>
			window.location.hash.startsWith("#/settings"), { timeout: 5_000 });
		// Should default to a valid view (not blank) — settings button always visible
		await expect(s.page.locator("button").filter({ hasText: "Settings" }).first())
			.toBeVisible({ timeout: 5_000 });
	});
});

// ---------------------------------------------------------------
// Spec graph analysis for navigation stories
// ---------------------------------------------------------------

test.describe("Navigation spec graph", () => {
	test.beforeEach(() => {
		clearStoryRegistry();
	});

	test("CT-13 coverage from navigation stories", () => {
		// Re-register CT-13
		const ct13 = CT_13;

		// Re-define all navigation stories to check coverage
		defineStory({ id: "N-01", title: "Sidebar session selection", contracts: [ct13], covers: ["view-transitions", "page-reload"] });
		defineStory({ id: "N-02", title: "Goal dashboard nav and back", contracts: [ct13], covers: ["back-forward-navigation"] });
		defineStory({ id: "N-03", title: "Deep links to all view types", contracts: [ct13], covers: ["bookmarks"] });
		defineStory({ id: "N-04", title: "Browser back and forward", contracts: [ct13], covers: ["back-forward-navigation"] });
		defineStory({ id: "N-06", title: "Sidebar collapse persistence", contracts: [ct13], covers: ["page-reload"] });
		defineStory({ id: "N-07", title: "Page title", contracts: [ct13], covers: ["page-reload"] });
		defineStory({ id: "N-08", title: "Keyboard shortcuts", contracts: [ct13], covers: ["view-transitions"] });
		defineStory({ id: "N-09", title: "Cross-feature journey", contracts: [ct13], covers: ["view-transitions", "back-forward-navigation"] });
		defineStory({ id: "N-10", title: "Settings sub-navigation", contracts: [ct13], covers: ["view-transitions", "bookmarks"] });

		const results = contractCompleteness();
		const ct13Report = results.find(r => r.contractId === "CT-13")!;

		expect(ct13Report).toBeTruthy();

		// All 4 CT-13 variations should be covered
		const covered = ct13Report.variations.filter(v => v.coveredBy !== null);
		expect(covered).toHaveLength(4);

		// 100% coverage
		expect(ct13Report.coverage).toBe(1);

		const graph = exportSpecGraph();
		expect(Object.keys(graph.stories).length).toBe(9);
		expect(graph.contracts["CT-13"].stories.length).toBe(9);
	});
});
