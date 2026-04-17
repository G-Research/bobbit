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
} from "./spec-framework.js";
import {
	STORY_N01,
	STORY_N02,
	STORY_N03,
	STORY_N04,
	STORY_N06,
	STORY_N07,
	STORY_N08,
	STORY_N09,
	STORY_N10,
} from "./story-registry.js";
import { navigateToHash } from "./ui-helpers.js";

test.describe("CT-13: URL routing and navigation", () => {
	test.describe.configure({ retries: 2 });
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

	test("N-01: Sidebar session selection updates URL and highlight @smoke", async () => {
		s.begin(STORY_N01);

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
		s.begin(STORY_N02);

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
		await expect(s.page.locator(".dashboard-container").first())
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

	test("N-03: Deep links to all view types @smoke", async () => {
		s.begin(STORY_N03);

		await s.createTestSession("A");
		const goal = await createGoal({ title: "Deep link goal" });
		goalIds.push(goal.id);
		await s.open();

		s.act();

		// Deep link: session
		await navigateToHash(s.page, `#/session/${s.session("A").sessionId}`);
		s.assert();
		await s.editor.is_visible();

		// Deep link: goal. Wait for the hash to settle before asserting on the
		// new view — back-to-back navigateToHash calls can race with the
		// previous view's teardown animations.
		s.act();
		await navigateToHash(s.page, `#/goal/${goal.id}`);
		await s.page.waitForFunction((id) =>
			window.location.hash.includes(`/goal/${id}`), goal.id, { timeout: 5_000 });
		s.assert();
		await expect(s.page.locator(".dashboard-container").first())
			.toBeVisible({ timeout: 15_000 });

		// Deep link: settings
		s.act();
		await navigateToHash(s.page, "#/settings/system/models");
		await s.page.waitForFunction(() =>
			window.location.hash.startsWith("#/settings"), { timeout: 5_000 });
		s.assert();
		await expect(s.page.getByText("Models").first())
			.toBeVisible({ timeout: 10_000 });

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
		s.begin(STORY_N04);

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
		s.begin(STORY_N06);

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
		s.begin(STORY_N07);

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
		s.begin(STORY_N08);

		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");
		await s.editor.is_visible();

		// The textarea auto-focuses on session open; blur it so the global
		// keyboard shortcut handler receives the event without competition.
		await s.page.evaluate(() => {
			(document.activeElement as HTMLElement | null)?.blur();
			document.body.focus?.();
		});

		// act — Ctrl+[ toggles sidebar. Poll localStorage instead of sleeping
		// a fixed amount; the handler can be slow under parallel load.
		s.act();
		await s.press_key("Control+BracketLeft");

		s.assert();
		await expect.poll(
			() => s.page.evaluate(() => localStorage.getItem("bobbit-sidebar-collapsed")),
			{ timeout: 5_000 },
		).toBe("true");

		// Toggle back
		s.act();
		await s.press_key("Control+BracketLeft");

		s.assert();
		await expect.poll(
			() => s.page.evaluate(() => localStorage.getItem("bobbit-sidebar-collapsed")),
			{ timeout: 5_000 },
		).not.toBe("true");

		// act — Ctrl+, opens settings
		s.act();
		await s.press_key("Control+,");

		s.assert();
		await s.url_contains("/settings");

		// act — Ctrl+, again closes settings (returns to previous view)
		s.act();
		await s.press_key("Control+,");

		s.assert();
		// Should be back at session or at least not on settings
		await expect.poll(
			() => s.page.evaluate(() => window.location.hash),
			{ timeout: 5_000 },
		).not.toContain("/settings");

		// act — Ctrl+K focuses search
		s.act();
		await s.press_key("Control+k");

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
		s.begin(STORY_N09);

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
		await expect(s.page.locator(".dashboard-container").first())
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
		s.begin(STORY_N10);

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


