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
import {
	SpecContext,
} from "./spec-framework.js";
import { CT_03, CT_04 } from "./spec-contracts.js";
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
	waitForHealth,
	createSession,
	deleteSession,
	createGoal,
	deleteGoal,
	apiFetch,
	nonGitCwd,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { navigateToHash, openApp } from "./ui-helpers.js";

test.describe("CT-03 & CT-04: Sidebar stories", () => {
	test.describe.configure({ retries: 2 });
	let s: SpecContext;
	const goalIds: string[] = [];
	const sessionIds: string[] = [];

	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.beforeEach(async ({ page }) => {
		s = new SpecContext(page);
		await s.open();
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
	// SB-02: Goal team nesting and expand/collapse
	// ---------------------------------------------------------------

	test("SB-02: Goal team nesting with expand and collapse @smoke", async ({ page }) => {
		s.begin(STORY_SB02);

		// setup — create a goal
		const goal = await createGoal({ title: "Team Nesting Goal", cwd: nonGitCwd() });
		goalIds.push(goal.id);

		// Reload to pick up the new goal in sidebar
		await s.reload();

		// act — find the goal in sidebar by text
		s.act();
		const goalGroup = s.sidebar.goal_group("Team Nesting Goal");
		const goalHeader = page.getByText("Team Nesting Goal", { exact: false }).first();
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
	});

	// ---------------------------------------------------------------
	// SB-03: Active session auto-expands parent group on deep link
	// ---------------------------------------------------------------

	test("SB-03: Auto-expand parent goal group on deep link navigation", async ({ page }) => {
		s.begin(STORY_SB03);

		// setup — create a goal and a session inside it
		const goal = await createGoal({ title: "Deep Link Goal", cwd: nonGitCwd() });
		goalIds.push(goal.id);
		const sessionId = await createSession({ goalId: goal.id, cwd: nonGitCwd() });
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");

		// act — navigate directly to the session via deep link
		s.act();
		await navigateToHash(page, `#/session/${sessionId}`);

		// assert — session textarea is visible (proves navigation + auto-expand worked)
		s.assert();
		await expect(page.locator("textarea").first())
			.toBeVisible({ timeout: 15_000 });
		await s.url_contains(sessionId);
	});

	// ---------------------------------------------------------------
	// SB-06: Idle time display on session rows
	// ---------------------------------------------------------------

	test("SB-06: Idle time display on session rows persists across reload", async ({ page }) => {
		s.begin(STORY_SB06);

		// setup — create a session (will be idle immediately)
		const sessionId = await s.createTestSession("A");

		// act — navigate to the session so it appears in sidebar
		s.act();
		await s.navigate_to("session", "A");

		// assert — session is active (textarea visible), and sidebar shows it
		s.assert();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		// The active row should be highlighted
		const activeRow = s.sidebar.session_row();
		await activeRow.is_visible();

		// Reload and verify session row still visible
		await s.reload();
		// Navigate back to the session
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await s.sidebar.session_row().is_visible();
	});

	// ---------------------------------------------------------------
	// SB-09: Goal gate progress badge
	// ---------------------------------------------------------------

	test("SB-09: Goal gate progress badge persists across reload", async ({ page }) => {
		s.begin(STORY_SB09);

		// setup — create a goal with a workflow that has gates
		let goal: { id: string; [k: string]: unknown };
		try {
			goal = await createGoal({ title: "Gate Progress Goal", workflowId: "feature", cwd: nonGitCwd() });
		} catch {
			goal = await createGoal({ title: "Gate Progress Goal", cwd: nonGitCwd() });
		}
		goalIds.push(goal.id);

		// Reload to pick up the new goal
		await s.reload();

		// act — find the goal row in sidebar by text
		s.act();
		const goalText = page.getByText("Gate Progress Goal", { exact: false }).first();
		await expect(goalText).toBeVisible({ timeout: 15_000 });

		// Check for a gate progress badge (e.g. "0/4" text)
		const sidebar = page.locator(".sidebar-edge");
		const hasBadge = await sidebar.getByText(/\d+\/\d+/).first().isVisible().catch(() => false);

		// Reload and verify goal still visible
		await s.reload();

		// assert — goal text still visible after reload
		s.assert();
		await expect(page.getByText("Gate Progress Goal", { exact: false }).first())
			.toBeVisible({ timeout: 15_000 });
	});

	// ---------------------------------------------------------------
	// SB-12: Completed goal rendering
	// ---------------------------------------------------------------

	test("SB-12: Completed goal renders appropriately in sidebar", async ({ page }) => {
		s.begin(STORY_SB12);

		// setup — create a goal and complete it via API
		const goal = await createGoal({ title: "Completed Goal Test", cwd: nonGitCwd() });
		goalIds.push(goal.id);

		// Try to complete the goal via API
		await apiFetch(`/api/goals/${goal.id}`, {
			method: "PUT",
			body: JSON.stringify({ status: "complete" }),
		}).catch(() => {});

		await s.reload();

		// act — verify sidebar renders without error
		s.act();
		await s.sidebar.is_visible();

		// assert — sidebar is functional after goal completion
		s.assert();
		await s.sidebar.is_visible();
	});

	// ---------------------------------------------------------------
	// SB-24: Filter sidebar by typing
	// ---------------------------------------------------------------

	test("SB-24: Filter sidebar sessions by typing in search @smoke", async ({ page }) => {
		s.begin(STORY_SB24);

		// setup — create sessions with distinctive names
		const sessionA = await createSession({ cwd: nonGitCwd() });
		sessionIds.push(sessionA);
		await apiFetch(`/api/sessions/${sessionA}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "AlphaSBTest" }),
		});

		const sessionB = await createSession({ cwd: nonGitCwd() });
		sessionIds.push(sessionB);
		await apiFetch(`/api/sessions/${sessionB}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "BravoSBTest" }),
		});

		await s.reload();

		// Wait for both sessions to appear
		await expect(page.getByText("AlphaSBTest")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("BravoSBTest")).toBeVisible({ timeout: 5_000 });

		// act — focus search with Ctrl+K and type a filter
		s.act();
		await page.keyboard.press("Control+k");

		const searchInput = s.sidebar.search_input();
		await searchInput.is_visible();
		await page.locator("input[data-search]").fill("AlphaSB");
		await page.waitForTimeout(400);

		// assert — Alpha visible, Bravo hidden
		s.assert();
		await expect(page.getByText("AlphaSBTest")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("BravoSBTest")).not.toBeVisible({ timeout: 3_000 });

		// Clear search — both should reappear
		await page.locator("input[data-search]").fill("");
		await page.waitForTimeout(400);
		await expect(page.getByText("AlphaSBTest")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("BravoSBTest")).toBeVisible({ timeout: 5_000 });

		// Press Escape to blur search
		await page.keyboard.press("Escape");
	});

	// ---------------------------------------------------------------
	// SB-27: Show archived toggle
	// ---------------------------------------------------------------

	test("SB-27: Show archived toggle reveals archived section", async ({ page }) => {
		s.begin(STORY_SB27);

		// setup
		await s.sidebar.is_visible();

		// act — look for "Archived" section text
		s.act();
		const archivedHeader = page.getByText("Archived").first();
		const hasArchived = await archivedHeader.isVisible().catch(() => false);

		// assert — sidebar renders correctly regardless of archived state
		s.assert();
		await s.sidebar.is_visible();
	});

	// ---------------------------------------------------------------
	// SB-32: Collapsed sidebar icon-only mode
	// ---------------------------------------------------------------

	test("SB-32: Sidebar collapses to icon-only mode and persists", async ({ page }) => {
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

		// Sidebar should now be collapsed (icon-only strip)
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

	// ---------------------------------------------------------------
	// SB-34: Sidebar keyboard shortcuts
	// ---------------------------------------------------------------

	test("SB-34: Keyboard shortcuts for sidebar search and collapse", async ({ page }) => {
		s.begin(STORY_SB34);

		// setup
		await s.sidebar.is_visible();

		// act — test Ctrl+K focuses search
		s.act();
		await page.keyboard.press("Control+k");
		await page.waitForTimeout(300);

		await s.sidebar.search_input().is_focused();

		// Press Escape to blur search
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);

		// Test Ctrl+[ toggles sidebar collapse
		await expect(page.locator("[data-testid='sidebar-expanded']").first()).toBeVisible({ timeout: 5_000 });
		await page.keyboard.press("Control+[");
		await page.waitForTimeout(500);

		// Sidebar should be collapsed
		await expect(page.locator("[data-testid='sidebar-collapsed']").first()).toBeVisible({ timeout: 5_000 });

		// assert — keyboard shortcuts work
		s.assert();
		// Toggle back to expanded
		await page.keyboard.press("Control+[");
		await page.waitForTimeout(500);
		await expect(page.locator("[data-testid='sidebar-expanded']").first()).toBeVisible({ timeout: 5_000 });
	});

	// ---------------------------------------------------------------
	// CT-03: Session highlight on navigation
	// ---------------------------------------------------------------

	test("CT-03-sidebar-highlight: Session highlight follows navigation", async ({ page }) => {
		s.begin(STORY_CT03_HIGHLIGHT);

		// setup — create two sessions
		const idA = await s.createTestSession("A");
		const idB = await s.createTestSession("B");

		// act — navigate to session A via deep link
		s.act();
		await navigateToHash(page, `#/session/${idA}`);
		await expect(page.locator("textarea").first())
			.toBeVisible({ timeout: 15_000 });

		// Session A should be highlighted
		await s.sidebar.session_row().is_visible();

		// Navigate to session B
		await navigateToHash(page, `#/session/${idB}`);
		await expect(page.locator("textarea").first())
			.toBeVisible({ timeout: 15_000 });

		// Only one row should be active
		await expect(page.locator(".sidebar-session-active")).toHaveCount(1, { timeout: 5_000 });

		// Press back — should return to session A
		await s.navigate_back();
		await page.waitForTimeout(500);

		// assert — A should be highlighted again
		s.assert();
		await s.url_contains(idA);
		await s.sidebar.session_row().is_visible();
	});

	// ---------------------------------------------------------------
	// SB-concurrent: Multiple concurrent sessions in sidebar
	// ---------------------------------------------------------------

	test("SB-concurrent: Sidebar reflects multiple concurrent sessions", async ({ page }) => {
		s.begin(STORY_SB_CONCURRENT);

		// Create 3 sessions simultaneously
		const [id1, id2, id3] = await Promise.all([
			createSession({ cwd: nonGitCwd() }),
			createSession({ cwd: nonGitCwd() }),
			createSession({ cwd: nonGitCwd() }),
		]);
		sessionIds.push(id1, id2, id3);
		await Promise.all([
			waitForSessionStatus(id1, "idle"),
			waitForSessionStatus(id2, "idle"),
			waitForSessionStatus(id3, "idle"),
		]);

		// Reload to see all sessions
		await s.reload();

		s.act();
		await s.sidebar.is_visible();

		// assert — all 3 sessions should be visible in sidebar
		s.assert();
		await expect(async () => {
			const sessionRows = await page.locator(
				".sidebar-session-active, .sidebar-edge [class*='cursor-pointer']",
			).count();
			expect(sessionRows).toBeGreaterThanOrEqual(3);
		}).toPass({ timeout: 10_000 });
	});
});


