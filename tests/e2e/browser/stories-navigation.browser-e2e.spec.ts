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
import type { Page, Route } from "@playwright/test";
import { test, expect } from "../../../tests2/browser/gateway-harness.js";
import { waitForHealth, createGoal, deleteGoal } from "../../../tests2/browser/e2e-setup.js";
import {
	SpecContext,
} from "../../../tests2/browser/e2e/spec-framework.js";
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
} from "../../../tests2/browser/e2e/story-registry.js";
import { navigateToHash } from "../../../tests2/browser/e2e/ui-helpers.js";

async function waitForSessionRouteSettlement(page: Page, sessionId: string): Promise<void> {
	await page.waitForFunction((id) => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		return window.location.hash === `#/session/${id}`
			&& state?.selectedSessionId === id
			&& state?.connectingSessionId === null
			&& state?.connectionStatus === "connected"
			&& state?.remoteAgent?.gatewaySessionId === id;
	}, sessionId, { timeout: 20_000 });
}

type HeldSessionListHydration = {
	held: Promise<void>;
	release: () => void;
	dispose: () => Promise<void>;
};

/**
 * Hold only the target session navigation's final list refresh. The app issues
 * unrelated /api/sessions reads while it boots; if one is held instead, the
 * target session cannot mount and this test creates a harness-only deadlock.
 */
async function holdSessionListHydration(page: Page, sessionId: string): Promise<HeldSessionListHydration> {
	let markHeld!: () => void;
	const held = new Promise<void>((resolve) => { markHeld = resolve; });
	let releaseGate!: () => void;
	const released = new Promise<void>((resolve) => { releaseGate = resolve; });
	let markHandlerComplete!: () => void;
	const handlerComplete = new Promise<void>((resolve) => { markHandlerComplete = resolve; });
	// The caller establishes this visible editor boundary before installing the
	// route. It is an event-state read, not a timer or a polling loop.
	const editorAlreadyRendered = await page.evaluate(() => !!document.querySelector("message-editor"));
	if (!editorAlreadyRendered) throw new Error("target hydration fixture requires a rendered editor");
	let captured = false;
	const matcher = (url: URL) => url.pathname === "/api/sessions";
	const handler = async (route: Route) => {
		// This is the target session's post-render refresh continuation. Its
		// connectingSessionId remains target-owned until the continuation settles;
		// boot, push, and unrelated-session list refreshes therefore fall through.
		const isTargetHydrationContinuation = route.request().method() === "GET" && await page.evaluate(({ id, editorReady }) => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return window.location.hash === `#/session/${id}`
				&& state?.selectedSessionId === id
				&& state?.connectingSessionId === id
				&& state?.remoteAgent?.gatewaySessionId === id
				&& !!state?.chatPanel?.agentInterface
				&& editorReady;
		}, { id: sessionId, editorReady: editorAlreadyRendered });
		if (captured || !isTargetHydrationContinuation) {
			await route.fallback();
			return;
		}
		captured = true;
		markHeld();
		try {
			await released;
			await route.continue();
		} finally {
			markHandlerComplete();
		}
	};
	await page.route(matcher, handler);
	return {
		held,
		release: releaseGate,
		dispose: async () => {
			releaseGate();
			// Playwright cannot remove a route handler while it still owns a
			// request. Release it, wait for continue(), then dispose the route.
			if (captured) await handlerComplete;
			await page.unroute(matcher, handler);
		},
	};
}

async function waitForGoalDashboardRoute(page: Page, goalId: string): Promise<void> {
	await expect.poll(() => page.evaluate((id) => {
		const state = (window as any).bobbitState;
		const visibleDashboardMounted = Array.from(document.querySelectorAll<HTMLElement>(
			".dashboard-container, .goal-dashboard, goal-dashboard",
		)).some((dashboard) => {
			const bounds = dashboard.getBoundingClientRect();
			return dashboard.isConnected
				&& getComputedStyle(dashboard).visibility !== "hidden"
				&& bounds.width > 0
				&& bounds.height > 0;
		});
		return window.location.hash === `#/goal/${id}`
			&& state?.goalDashboardId === id
			&& visibleDashboardMounted;
	}, goalId), {
		timeout: 20_000,
		message: "goal route, state ownership, and visible mounted dashboard must settle together",
	}).toBe(true);
}

test.describe("CT-13: URL routing and navigation", () => {
	let s: SpecContext;
	const goalIds: string[] = [];

	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.beforeEach(async ({ page, gateway }) => {
		s = new SpecContext(page, gateway);
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

	test("N-01/N-07: Sidebar selection persists and title survives reload @smoke", async () => {
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

		// assert — N-07 page title is set before reload
		s.begin(STORY_N07);
		s.assert();
		await s.page_title_contains("Bobbit");

		// act — reload page for N-01
		s.begin(STORY_N01);
		s.act();
		await s.reload();

		// assert — session B still selected after reload
		s.assert();
		await s.url_contains(`/session/${s.session("B").sessionId}`);

		// assert — N-07 title survives the same reload
		s.begin(STORY_N07);
		s.assert();
		await s.page_title_contains("Bobbit");
	});

	// ---------------------------------------------------------------
	// N-03: Deep links to all view types
	// ---------------------------------------------------------------

	test("N-03/N-10: Deep links and settings sub-navigation @smoke", async () => {
		s.begin(STORY_N03);

		await s.createTestSession("A");
		await s.createTestSession("B");
		const goal = await createGoal({ title: "Deep link goal" });
		goalIds.push(goal.id);
		await s.open();

		// Establish a rendered editor before arming the A-specific hydration
		// interceptor. This lets the exact A continuation be held at its own
		// connectingSessionId boundary, rather than waiting for a later push tick.
		await s.navigate_to("session", "B");
		await s.editor.is_visible();

		s.act();

		// Deep link: session. Hold the connection's final session-list refresh so
		// the next navigation races a real, observable hydration continuation.
		const hydration = await holdSessionListHydration(s.page, s.session("A").sessionId);
		let hydrationDisposed = false;
		try {
			await navigateToHash(s.page, `#/session/${s.session("A").sessionId}`);
			await hydration.held;
			s.assert();
			// The deliberately held final refresh owns the target's editor commit;
			// the already-rendered B editor above supplies the no-timer readiness
			// boundary, while the target connection token proves this is A's refresh.
			const sessionStillOwnsHeldRefresh = await s.page.evaluate((id) => {
				const state = (window as any).bobbitState ?? (window as any).__bobbitState;
				return window.location.hash === `#/session/${id}` && state?.selectedSessionId === id;
			}, s.session("A").sessionId);
			expect(sessionStillOwnsHeldRefresh, "session route must own its held post-render refresh").toBe(true);

			// The route has already captured the target continuation, so this distinct
			// list read must take the handler's fallback path and complete before it
			// is released. A broad route predicate would hold this request too.
			const unrelatedRefresh = await s.page.evaluate(async () => {
				const token = localStorage.getItem("gateway.token");
				const response = await fetch(`/api/sessions?unrelated-refresh=${crypto.randomUUID()}`, {
					headers: token ? { Authorization: `Bearer ${token}` } : {},
				});
				return { ok: response.ok, status: response.status };
			});
			expect(unrelatedRefresh, "unrelated session-list refresh must fall through while target hydration is held")
				.toMatchObject({ ok: true, status: 200 });

			// Queue the goal route while the earlier session continuation is held,
			// then release its request before awaiting route handling. This preserves
			// the ownership race without deadlocking the serialized hash router.
			s.act();
			await navigateToHash(s.page, `#/goal/${goal.id}`);
			await hydration.dispose();
			hydrationDisposed = true;
			await waitForGoalDashboardRoute(s.page, goal.id);
			s.assert();
			await expect(s.page.locator(".dashboard-container").first())
				.toBeVisible({ timeout: 20_000 });

			// Prove the held target route itself reaches its editor only after the
			// goal-race assertion; this is a fresh navigation, not a wait for the
			// deliberately held continuation above.
			s.act();
			await navigateToHash(s.page, `#/session/${s.session("A").sessionId}`);
			s.assert();
			await s.editor.is_visible();
		} finally {
			if (!hydrationDisposed) await hydration.dispose();
		}

		// Deep link: settings
		s.act();
		await navigateToHash(s.page, "#/settings/system/models");
		s.assert();
		await expect(s.page.getByText("Models").first())
			.toBeVisible({ timeout: 10_000 });

		// N-10: settings sub-navigation shares the same settings route setup.
		s.begin(STORY_N10);
		s.act();
		await navigateToHash(s.page, "#/settings/system/general");
		s.assert();
		await s.page.waitForFunction(() =>
			window.location.hash.startsWith("#/settings"), { timeout: 5_000 });
		await expect(s.page.getByText("Settings").first())
			.toBeVisible({ timeout: 10_000 });

		s.act();
		const modelTab = s.page.getByText("Models").first();
		if (await modelTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await modelTab.click();
			await s.page.waitForFunction(() => window.location.hash.includes("/settings"), null, { timeout: 5_000 });

			s.assert();
			const hash = await s.page.evaluate(() => window.location.hash);
			expect(hash).toContain("/settings");
		} else {
			s.assert();
			await s.url_contains("/settings");
		}

		s.act();
		await navigateToHash(s.page, "#/settings");
		s.assert();
		await s.page.waitForFunction(() =>
			window.location.hash.startsWith("#/settings"), { timeout: 5_000 });
		await expect(s.page.locator("button").filter({ hasText: "Settings" }).first())
			.toBeVisible({ timeout: 5_000 });

		s.begin(STORY_N03);

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

		// Deep link: workflows. The standalone /#/workflows route now
		// redirects to #/settings/<projectId>/workflows (workflows are
		// project-scoped). navigateToHash() asserts startsWith("#/workflows")
		// which would race the redirect, so set the hash directly and wait
		// for either the pre- or post-redirect form.
		s.act();
		await s.page.evaluate(() => { window.location.hash = "#/workflows"; });
		s.assert();
		await s.page.waitForFunction(() => {
			const h = window.location.hash;
			return h.startsWith("#/workflows") || /^#\/settings\/[^/]+\/workflows/.test(h);
		}, { timeout: 10_000 });
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
		await s.page.waitForFunction(() => window.location.hash === "" || window.location.hash === "#/", null, { timeout: 5_000 });

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
		const collapseBtn = s.page.locator("button[title^='Collapse sidebar']").first();
		await expect(collapseBtn).toBeVisible({ timeout: 5_000 });
		await collapseBtn.click();
		await s.page.waitForFunction(() => localStorage.getItem("bobbit-sidebar-collapsed") === "true", null, { timeout: 5_000 });

		// assert — localStorage records collapsed state
		s.assert();
		const collapsed = await s.page.evaluate(() =>
			localStorage.getItem("bobbit-sidebar-collapsed")
		);
		expect(collapsed).toBe("true");

		// Expand button should now be visible
		const expandBtn = s.page.locator("button[title^='Expand sidebar']").first();
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
		const expandAfterReload = s.page.locator("button[title^='Expand sidebar']").first();
		await expect(expandAfterReload).toBeVisible({ timeout: 5_000 });
		await expandAfterReload.click();
		await s.page.waitForFunction(() => localStorage.getItem("bobbit-sidebar-collapsed") !== "true", null, { timeout: 5_000 });

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

		// Set both ctrlKey and metaKey for ctrlOrMeta shortcuts so the
		// platform-aware match in shortcut-registry works on macOS (metaKey)
		// and Linux/Windows (ctrlKey).
		const dispatchKey = async (key: string, code: string, ctrlKey = true) => {
			await s.page.evaluate(({ key, code, ctrlKey }) => {
				const event = new KeyboardEvent("keydown", { key, code, ctrlKey, metaKey: ctrlKey, bubbles: true, cancelable: true });
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

		// Helper: dispatch a shortcut and wait for its effect. Since dispatchKey
		// targets window directly (bypassing focus), a single dispatch suffices
		// once the `shortcutsReady` marker is set. Retry via re-dispatch (NOT a
		// real key press) on the rare chance the first event is lost — using
		// real keyboard would double-toggle the shortcut.
		const dispatchUntil = async (
			key: string,
			code: string,
			check: () => Promise<void>,
			maxAttempts = 3,
		) => {
			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				await dispatchKey(key, code);
				try { await check(); return; } catch (err) {
					if (attempt === maxAttempts - 1) throw err;
				}
			}
		};

		// act — Ctrl+[ toggles sidebar.
		s.act();
		s.assert();
		await dispatchUntil("[", "BracketLeft", () =>
			pollLocalStorage("bobbit-sidebar-collapsed", "true", 2000),
		);

		// Toggle back
		s.act();
		s.assert();
		await dispatchUntil("[", "BracketLeft", async () => {
			await expect.poll(
				() => s.page.evaluate(() => localStorage.getItem("bobbit-sidebar-collapsed")),
				{ timeout: 2000, intervals: [50, 100, 200, 400] },
			).not.toBe("true");
		});

		// act — Ctrl+, opens settings
		s.act();
		s.assert();
		await dispatchUntil(",", "Comma", () => pollHashContains("/settings", 2000));

		// act — Ctrl+, again closes settings (returns to previous view)
		s.act();
		s.assert();
		await dispatchUntil(",", "Comma", () => pollHashNotContains("/settings", 2000));

		// act — Ctrl+K focuses search
		s.act();
		s.assert();
		const searchLocator = s.page.locator(
			'input[type="search"], input[placeholder*="Search"], .search-page input, .sidebar-search input'
		).first();
		await dispatchUntil("k", "KeyK", async () => {
			await expect(searchLocator).toBeVisible({ timeout: 2000 });
		});
	});

	// ---------------------------------------------------------------
	// N-02 / N-09: Goal back navigation and cross-feature journey
	// ---------------------------------------------------------------

	test("N-02/N-09: Goal dashboard back navigation and cross-feature journey", async () => {
		await s.createTestSession("A");
		const goal = await createGoal({ title: "Journey goal" });
		goalIds.push(goal.id);
		await s.open();

		// N-02: session → goal dashboard → browser back to session.
		s.begin(STORY_N02);
		await s.navigate_to("session", "A");
		await s.editor.is_visible();
		await waitForSessionRouteSettlement(s.page, s.session("A").sessionId);

		s.act();
		await navigateToHash(s.page, `#/goal/${goal.id}`);
		await waitForGoalDashboardRoute(s.page, goal.id);
		s.assert();
		await s.url_contains(`/goal/${goal.id}`);
		await expect(s.page.locator(".dashboard-container").first())
			.toBeVisible({ timeout: 15_000 });

		s.act();
		await s.navigate_back();
		s.assert();
		await s.url_contains(`/session/${s.session("A").sessionId}`);
		await s.editor.is_visible();

		// N-09: reuse the same session/goal for the broader cross-feature path.
		s.begin(STORY_N09);
		await navigateToHash(s.page, "#/");
		await s.page.waitForFunction(() => window.location.hash === "" || window.location.hash === "#/", null, { timeout: 5_000 });

		// act — landing → session
		s.act();
		await navigateToHash(s.page, `#/session/${s.session("A").sessionId}`);
		s.assert();
		await s.editor.is_visible();
		await waitForSessionRouteSettlement(s.page, s.session("A").sessionId);

		// act — session → goal dashboard
		s.act();
		await navigateToHash(s.page, `#/goal/${goal.id}`);
		await waitForGoalDashboardRoute(s.page, goal.id);
		s.assert();
		await s.url_contains(`/goal/${goal.id}`);
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
		await waitForGoalDashboardRoute(s.page, goal.id);
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
});


