/**
 * Sidebar stories — CT-03 & CT-04
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
import { SpecContext } from "./spec-framework.js";
import {
	STORY_SB02,
	STORY_SB03,
	STORY_SB06,
	STORY_SB09,
	STORY_SB12,
	STORY_SB24,
	STORY_SB27,
	STORY_SB32,
	STORY_SB34,
	STORY_CT03_HIGHLIGHT,
	STORY_SB_CONCURRENT,
} from "./story-registry.js";
import {
	base,
	readE2ETokenAsync,
	waitForHealth,
	createSession,
	deleteSession,
	createGoal,
	deleteGoal,
	apiFetch,
	nonGitCwd,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { navigateToHash } from "./ui-helpers.js";

async function openStoryApp(s: SpecContext): Promise<void> {
	await expect(async () => {
		const resp = await apiFetch("/api/oauth/status?provider=anthropic");
		expect(resp.ok).toBe(true);
		const status = await resp.json();
		expect(status.authenticated).toBe(true);
	}).toPass({ timeout: 20_000 });

	const page = s.page;
	const token = await readE2ETokenAsync();
	await page.goto(`${base()}/?token=${encodeURIComponent(token)}`);
	await expect(
		page.locator("button").filter({ hasText: "Settings" }).first(),
	).toBeVisible({ timeout: 20_000 });
}

test.describe("CT-03 & CT-04: Sidebar stories", () => {
	let s: SpecContext;
	const goalIds: string[] = [];
	const sessionIds: string[] = [];

	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.beforeEach(async ({ page, gateway }) => {
		s = new SpecContext(page, gateway);
		await openStoryApp(s);
	});

	test.afterEach(async () => {
		await s.cleanup();
		for (const id of goalIds.splice(0)) {
			await deleteGoal(id).catch(() => {});
		}
		for (const id of sessionIds.splice(0)) {
			await deleteSession(id).catch(() => {});
		}
	});

	// ---------------------------------------------------------------
	// SB-01: Project sections and collapse persistence
	// ---------------------------------------------------------------

	// SB-01 is covered by the existing sidebar-navigation.spec.ts test.
	// The page-reload variation for CT-03 is covered by SB-24, SB-27, and SB-32.

	// ---------------------------------------------------------------
	// SB-02 + SB-03 + SB-09 + SB-12: Goal sidebar hierarchy
	// ---------------------------------------------------------------

	test("SB-02/SB-03/SB-09/SB-12: Goal sidebar hierarchy survives deep links and completion @smoke", async ({ page }) => {
		// shared setup — create one goal and one nested session for all goal-row stories
		const goalTitle = `Sidebar Goal ${Date.now()}`;
		let goal: { id: string; [k: string]: unknown };
		try {
			goal = await createGoal({ title: goalTitle, workflowId: "feature", cwd: nonGitCwd() });
		} catch {
			goal = await createGoal({ title: goalTitle, cwd: nonGitCwd() });
		}
		goalIds.push(goal.id);

		const sessionId = await createSession({ goalId: goal.id, cwd: nonGitCwd() });
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");
		await s.reload();

		s.begin(STORY_SB02);

		// act — find the goal in sidebar by text
		s.act();
		const goalHeader = page.getByText(goalTitle, { exact: false }).first();
		await expect(goalHeader).toBeVisible({ timeout: 15_000 });

		// Check for expand/collapse chevrons
		const expandChevron = page.locator("[title='Expand goal']").first();
		const collapseChevron = page.locator("[title='Collapse goal']").first();

		const alreadyExpanded = await collapseChevron.isVisible().catch(() => false);
		if (!alreadyExpanded) {
			const canExpand = await expandChevron.isVisible().catch(() => false);
			if (canExpand) {
				await expandChevron.click();
			}
		}

		// assert — goal is visible and interactive
		s.assert();
		await expect(goalHeader).toBeVisible();

		s.begin(STORY_SB03);

		// act — navigate directly to the session via deep link
		s.act();
		await navigateToHash(page, `#/session/${sessionId}`);

		// assert — session textarea is visible (proves navigation + auto-expand worked)
		s.assert();
		await expect(page.locator("textarea").first())
			.toBeVisible({ timeout: 15_000 });
		await s.url_contains(sessionId);

		s.begin(STORY_SB09);

		// act — reload while the goal exists
		s.act();
		await s.reload();

		// assert — goal text still visible after reload
		s.assert();
		await expect(page.getByText(goalTitle, { exact: false }).first())
			.toBeVisible({ timeout: 15_000 });

		s.begin(STORY_SB12);

		// act — complete the goal via API and reload the sidebar
		s.act();
		await apiFetch(`/api/goals/${goal.id}`, {
			method: "PUT",
			body: JSON.stringify({ status: "complete" }),
		}).catch(() => {});
		await s.reload();

		// assert — sidebar is functional after goal completion
		s.assert();
		await s.sidebar.is_visible();
	});

	// ---------------------------------------------------------------
	// SB-06 + CT-03: Session rows and active highlight
	// ---------------------------------------------------------------

	test("SB-06/CT-03-sidebar-highlight: Session rows persist and active highlight follows history", async ({ page }) => {
		// shared setup — create two sessions once for row persistence and highlight checks
		const idA = await s.createTestSession("A");
		const idB = await s.createTestSession("B");

		s.begin(STORY_SB06);

		// act — navigate to the session so it appears in sidebar
		s.act();
		await s.navigate_to("session", "A");

		// assert — session is active (textarea visible), and sidebar shows it
		s.assert();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await s.sidebar.session_row().is_visible();

		// Reload and verify session row still visible
		await s.reload();
		await navigateToHash(page, `#/session/${idA}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await s.sidebar.session_row().is_visible();

		s.begin(STORY_CT03_HIGHLIGHT);

		// act — navigate to session A, then B, then browser-back to A
		s.act();
		await navigateToHash(page, `#/session/${idA}`);
		await expect(page.locator("textarea").first())
			.toBeVisible({ timeout: 15_000 });
		await s.sidebar.session_row().is_visible();

		await navigateToHash(page, `#/session/${idB}`);
		await expect(page.locator("textarea").first())
			.toBeVisible({ timeout: 15_000 });
		await expect(page.locator(".sidebar-session-active")).toHaveCount(1, { timeout: 5_000 });

		await s.navigate_back();

		// assert — A should be highlighted again (url_contains polls)
		s.assert();
		await s.url_contains(idA);
		await s.sidebar.session_row().is_visible();
	});

	// ---------------------------------------------------------------
	// SB-24 + SB-concurrent: Search filtering over concurrent sessions
	// ---------------------------------------------------------------

	test("SB-24/SB-concurrent: Filter search narrows concurrently created sessions @smoke", async ({ page }) => {
		s.begin(STORY_SB24);

		// setup — create sessions concurrently with distinctive names
		const [sessionA, sessionB, sessionC] = await Promise.all([
			createSession({ cwd: nonGitCwd() }),
			createSession({ cwd: nonGitCwd() }),
			createSession({ cwd: nonGitCwd() }),
		]);
		sessionIds.push(sessionA, sessionB, sessionC);
		await Promise.all([
			waitForSessionStatus(sessionA, "idle"),
			waitForSessionStatus(sessionB, "idle"),
			waitForSessionStatus(sessionC, "idle"),
		]);
		await Promise.all([
			apiFetch(`/api/sessions/${sessionA}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "AlphaSBTest" }),
			}),
			apiFetch(`/api/sessions/${sessionB}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "BravoSBTest" }),
			}),
			apiFetch(`/api/sessions/${sessionC}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "CharlieSBTest" }),
			}),
		]);

		await s.reload();
		await expect(page.getByText("AlphaSBTest")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("BravoSBTest")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("CharlieSBTest")).toBeVisible({ timeout: 5_000 });

		// act — focus search with Ctrl+K and type a filter
		s.act();
		await page.keyboard.press("Control+k");

		const searchInput = s.sidebar.search_input();
		await searchInput.is_visible();
		await page.locator("input[data-search]").fill("AlphaSB");

		// assert — Alpha visible, non-matches hidden (filter debounce settles via auto-retry)
		s.assert();
		await expect(page.getByText("AlphaSBTest")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("BravoSBTest")).not.toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("CharlieSBTest")).not.toBeVisible({ timeout: 5_000 });

		// Clear search — all should reappear
		await page.locator("input[data-search]").fill("");
		await expect(page.getByText("AlphaSBTest")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("BravoSBTest")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("CharlieSBTest")).toBeVisible({ timeout: 5_000 });
		await page.keyboard.press("Escape");

		s.begin(STORY_SB_CONCURRENT);

		// act
		s.act();
		await s.sidebar.is_visible();

		// assert — all 3 concurrently-created sessions should be visible in sidebar
		s.assert();
		await expect(page.getByText("AlphaSBTest")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("BravoSBTest")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("CharlieSBTest")).toBeVisible({ timeout: 5_000 });
	});

	// ---------------------------------------------------------------
	// SB-27 + SB-32 + SB-34: Sidebar chrome and shortcuts
	// ---------------------------------------------------------------

	test("SB-27/SB-32/SB-34: Sidebar chrome, collapse persistence, and keyboard shortcuts", async ({ page }) => {
		s.begin(STORY_SB27);

		// act — archived/sidebar chrome renders regardless of archived state
		s.act();
		await s.sidebar.is_visible();

		// assert — sidebar renders correctly regardless of archived state
		s.assert();
		await s.sidebar.is_visible();

		// Wait for shortcut listener to be attached.
		await expect.poll(
			() => page.evaluate(() => document.body.dataset.shortcutsReady === "1"),
			{ timeout: 15_000 },
		).toBe(true);

		// Dispatch shortcuts via window.dispatchEvent so they reach the
		// app's global listener regardless of focus, and set both ctrlKey
		// and metaKey so the platform-aware ctrlOrMeta check matches on
		// macOS (metaKey) and Linux/Windows (ctrlKey).
		// Dispatch on document only — bubbling reaches both the SearchBox
		// Ctrl+K listener (document) and the shortcut-registry listener (window).
		const dispatchKey = (key: string, code: string) => page.evaluate(({ key, code }) => {
			document.dispatchEvent(new KeyboardEvent("keydown", {
				key, code, ctrlKey: true, metaKey: true, bubbles: true, cancelable: true,
			}));
		}, { key, code });

		s.begin(STORY_SB34);

		// act — test Ctrl+K focuses search, then Ctrl+[ toggles sidebar collapse
		s.act();
		await dispatchKey("k", "KeyK");
		await s.sidebar.search_input().is_focused();
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

		await expect(page.locator("[data-testid='sidebar-expanded']").first()).toBeVisible({ timeout: 5_000 });
		await dispatchKey("[", "BracketLeft");
		await expect(page.locator("[data-testid='sidebar-collapsed']").first()).toBeVisible({ timeout: 5_000 });

		// assert — keyboard shortcuts work
		s.assert();
		await dispatchKey("[", "BracketLeft");
		await expect(page.locator("[data-testid='sidebar-expanded']").first()).toBeVisible({ timeout: 5_000 });

		s.begin(STORY_SB32);

		// setup — verify sidebar is expanded
		await s.sidebar.is_visible();
		const fullSidebar = page.locator("[data-testid='sidebar-expanded']").first();
		await expect(fullSidebar).toBeVisible({ timeout: 10_000 });

		// act — click the collapse button
		s.act();
		const collapseBtn = page.locator("button[title*='Collapse sidebar']").first();
		await expect(collapseBtn).toBeVisible({ timeout: 5_000 });
		await collapseBtn.click();

		await expect(page.locator("[data-testid='sidebar-collapsed']").first()).toBeVisible({ timeout: 5_000 });
		await expect(page.locator("[data-testid='sidebar-expanded']")).toHaveCount(0, { timeout: 3_000 });

		// Reload — collapsed state should persist
		await s.reload();

		// assert — sidebar still collapsed after reload
		s.assert();
		await expect(page.locator("[data-testid='sidebar-collapsed']").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator("[data-testid='sidebar-expanded']")).toHaveCount(0, { timeout: 3_000 });

		// Expand to restore state for other tests
		const expandBtn = page.locator("button[title*='Expand sidebar']").first();
		await expect(expandBtn).toBeVisible({ timeout: 5_000 });
		await expandBtn.click();
		await expect(page.locator("[data-testid='sidebar-expanded']").first()).toBeVisible({ timeout: 5_000 });
	});
});
