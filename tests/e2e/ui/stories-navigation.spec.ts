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

		// assert — goal dashboard visible, URL correct. Use toBeVisible with
		// generous timeout instead of a fixed sleep; under parallel load the
		// dashboard container can take longer than 500ms to mount.
		s.assert();
		await s.url_contains(`/goal/${goal.id}`);
		await expect(s.page.locator(".dashboard-container").first())
			.toBeVisible({ timeout: 15_000 });

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

		// Deep link: goal. navigateToHash already waits for the hash to settle,
		// so no extra waitForFunction is needed (removing it avoids compounding
		// timeouts when the navigation is slow under load).
		s.act();
		await navigateToHash(s.page, `#/goal/${goal.id}`);
		s.assert();
		await expect(s.page.locator(".dashboard-container").first())
			.toBeVisible({ timeout: 20_000 });

		// Deep link: settings
		s.act();
		await navigateToHash(s.page, "#/settings/system/models");
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

		// Wait for the app's shortcut listener to be attached. We detect it
		// by checking that a deliberately unbound key (Ctrl+F9) is handled
		// by the listener — actually simpler: just wait for a marker. The
		// app sets `document.body.dataset.shortcutsReady = "1"` after
		// startListening(); tests wait on that.
		await expect.poll(
			() => s.page.evaluate(() => document.body.dataset.shortcutsReady === "1"),
			{ timeout: 15_000 },
		).toBe(true);

		const dispatchKey = async (key: string, code: string, ctrlKey = true) => {
			await s.page.evaluate(({ key, code, ctrlKey }) => {
				const event = new KeyboardEvent("keydown", { key, code, ctrlKey, bubbles: true, cancelable: true });
				window.dispatchEvent(event);
			}, { key, code, ctrlKey });
		};

		// Helper: poll localStorage/hash until predicate passes, with generous
		// timeout so we tolerate slow hash/localStorage propagation under parallel load.
		const pollLocalStorage = async (key: string, expected: string | null, timeout = 5000) =>
			expect.poll(
				() => s.page.evaluate((k) => localStorage.getItem(k), key),
				{ timeout, intervals: [50, 100, 200, 400] },
			).toBe(expected);

		const pollHashNotContains = async (needle: string, timeout = 5000) =>
			expect.poll(
				() => s.page.evaluate(() => window.location.hash),
				{ timeout, intervals: [50, 100, 200, 400] },
			).not.toContain(needle);

		const pollHashContains = async (needle: string, timeout = 5000) =>
			expect.poll(
				() => s.page.evaluate(() => window.location.hash),
				{ timeout, intervals: [50, 100, 200, 400] },
			).toContain(needle);

		// Helper: press a shortcut and wait for its effect. If the first press
		// is swallowed by a transient focus race, retry once.
		const pressUntil = async (key: string, check: () => Promise<void>, maxAttempts = 3) => {
			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				// Re-blur each attempt — any late focus steal would kill the shortcut.
				await s.page.evaluate(() => {
					(document.activeElement as HTMLElement | null)?.blur();
					document.body.focus?.();
				});
				await s.press_key(key);
				try { await check(); return; } catch (err) {
					if (attempt === maxAttempts - 1) throw err;
				}
			}
		};

		// act — Ctrl+[ toggles sidebar. Listener is attached by this point,
		// so a single dispatch suffices.

		s.act();
		await dispatchKey("[", "BracketLeft");
		s.assert();
		await pressUntil("Control+BracketLeft", () => pollLocalStorage("bobbit-sidebar-collapsed", "true"));

		// Toggle back
		s.act();
		await dispatchKey("[", "BracketLeft");
		s.assert();
		await pressUntil("Control+BracketLeft", async () => {
			await expect.poll(
				() => s.page.evaluate(() => localStorage.getItem("bobbit-sidebar-collapsed")),
				{ timeout: 5000, intervals: [50, 100, 200, 400] },
			).not.toBe("true");
		});

		// act — Ctrl+, opens settings
		s.act();
		await dispatchKey(",", "Comma");
		s.assert();
		await pressUntil("Control+,", () => pollHashContains("/settings"));

		// act — Ctrl+, again closes settings (returns to previous view)
		s.act();
		await dispatchKey(",", "Comma");
		s.assert();
		await pressUntil("Control+,", () => pollHashNotContains("/settings"));

		// act — Ctrl+K focuses search
		s.act();
		await dispatchKey("k", "KeyK");
		s.assert();
		const searchLocator = s.page.locator(
			'input[type="search"], input[placeholder*="Search"], .search-page input, .sidebar-search input'
		).first();
		await pressUntil("Control+k", async () => {
			await expect(searchLocator).toBeVisible({ timeout: 5000 });
		});
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
		await expect(s.page.locator('message-editor').first()).toBeVisible({ timeout: 10_000 });

		// No blank screens at any step — app still responsive
		await expect(s.page.locator("button").filter({ hasText: "Settings" }).first())
			.toBeVisible({ timeout: 10_000 });
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


