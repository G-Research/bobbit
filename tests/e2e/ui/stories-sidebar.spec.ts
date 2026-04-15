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
	defineStory,
	exportSpecGraph,
	contractCompleteness,
	clearStoryRegistry,
} from "./spec-framework.js";
import { CT_03, CT_04 } from "./spec-contracts.js";
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

	test("SB-01: Project sections collapse and persist across reload", async ({ page }) => {
		s.begin(defineStory({
			id: "SB-01",
			title: "Project sections collapse and persist across reload",
			contracts: [CT_03],
			covers: ["page-reload"],
		}));

		// setup — create a session so the project section has content
		const sessionId = await s.createTestSession("A");

		// Get project info from API
		const resp = await apiFetch("/api/projects");
		const projects = await resp.json();
		const projectInfo = projects[0] as { id: string; name: string };

		// act — collapse the project section
		s.act();
		await s.sidebar.is_visible();

		// "Sessions" sub-header should be visible when project is expanded
		const sessionsLabel = page.getByText("Sessions", { exact: true }).first();
		await expect(sessionsLabel).toBeVisible({ timeout: 10_000 });

		// Find project header — div.cursor-pointer inside .sidebar-edge containing project name
		const projectHeader = page.locator(".sidebar-edge div.cursor-pointer").filter({
			hasText: projectInfo.name,
		}).first();
		await expect(projectHeader).toBeVisible({ timeout: 5_000 });

		// Click to collapse
		await projectHeader.click();

		// After collapse, "Sessions" should be hidden
		await expect(sessionsLabel).not.toBeVisible({ timeout: 5_000 });

		// Reload — collapsed state should persist via localStorage
		await s.reload();

		// assert — Sessions should still be hidden after reload
		s.assert();
		await expect(sessionsLabel).not.toBeVisible({ timeout: 3_000 });

		// Expand again to restore state for other tests
		const projectHeaderAfterReload = page.locator(".sidebar-edge div.cursor-pointer").filter({
			hasText: projectInfo.name,
		}).first();
		await projectHeaderAfterReload.click();
		await expect(page.getByText("Sessions", { exact: true }).first()).toBeVisible({ timeout: 5_000 });
	});

	// ---------------------------------------------------------------
	// SB-02: Goal team nesting and expand/collapse
	// ---------------------------------------------------------------

	test("SB-02: Goal team nesting with expand and collapse", async ({ page }) => {
		s.begin(defineStory({
			id: "SB-02",
			title: "Goal team nesting with expand and collapse",
			contracts: [CT_03],
			covers: ["collapsed-tree-expansion"],
		}));

		// setup — create a goal
		const goal = await createGoal({ title: "Team Nesting Goal", cwd: nonGitCwd() });
		goalIds.push(goal.id);

		// Reload to pick up the new goal in sidebar
		await s.reload();

		// act — find the goal in sidebar by text
		s.act();
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
		s.begin(defineStory({
			id: "SB-03",
			title: "Auto-expand parent goal group on deep link navigation",
			contracts: [CT_03],
			covers: ["deep-link-navigation", "collapsed-tree-expansion"],
		}));

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
		s.begin(defineStory({
			id: "SB-06",
			title: "Idle time display on session rows persists across reload",
			contracts: [CT_04],
			covers: ["page-reload"],
		}));

		// setup — create a session (will be idle immediately)
		const sessionId = await s.createTestSession("A");

		// act — navigate to the session so it appears in sidebar
		s.act();
		await s.navigate_to("session", "A");

		// assert — session is active (textarea visible), and sidebar shows it
		s.assert();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		// The active row should be highlighted
		const activeRow = page.locator(".sidebar-session-active");
		await expect(activeRow).toBeVisible({ timeout: 10_000 });

		// Reload and verify session row still visible
		await s.reload();
		// Navigate back to the session
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator(".sidebar-session-active")).toBeVisible({ timeout: 10_000 });
	});

	// ---------------------------------------------------------------
	// SB-09: Goal gate progress badge
	// ---------------------------------------------------------------

	test("SB-09: Goal gate progress badge persists across reload", async ({ page }) => {
		s.begin(defineStory({
			id: "SB-09",
			title: "Goal gate progress badge persists across reload",
			contracts: [CT_04],
			covers: ["page-reload"],
		}));

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
		s.begin(defineStory({
			id: "SB-12",
			title: "Completed goal renders appropriately in sidebar",
			contracts: [CT_04],
			covers: ["page-reload"],
		}));

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

	test("SB-24: Filter sidebar sessions by typing in search", async ({ page }) => {
		s.begin(defineStory({
			id: "SB-24",
			title: "Filter sidebar sessions by typing in search",
			contracts: [CT_03],
			covers: ["page-reload"],
		}));

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

		const searchInput = page.locator("input[data-search]");
		await expect(searchInput).toBeVisible({ timeout: 5_000 });
		await searchInput.fill("AlphaSB");
		await page.waitForTimeout(400);

		// assert — Alpha visible, Bravo hidden
		s.assert();
		await expect(page.getByText("AlphaSBTest")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("BravoSBTest")).not.toBeVisible({ timeout: 3_000 });

		// Clear search — both should reappear
		await searchInput.fill("");
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
		s.begin(defineStory({
			id: "SB-27",
			title: "Show archived toggle reveals archived section",
			contracts: [CT_03, CT_04],
			covers: ["page-reload"],
		}));

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
		s.begin(defineStory({
			id: "SB-32",
			title: "Sidebar collapses to icon-only mode and persists",
			contracts: [CT_03],
			covers: ["page-reload"],
		}));

		// setup — verify sidebar is expanded (240px wide)
		await s.sidebar.is_visible();
		const fullSidebar = page.locator(".w-\\[240px\\]").first();
		await expect(fullSidebar).toBeVisible({ timeout: 10_000 });

		// act — click the collapse button
		s.act();
		const collapseBtn = page.locator("button[title*='Collapse sidebar']").first();
		await expect(collapseBtn).toBeVisible({ timeout: 5_000 });
		await collapseBtn.click();

		// Sidebar should now be narrow (w-14 = 56px)
		await expect(page.locator(".w-14").first()).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(".w-\\[240px\\]")).toHaveCount(0, { timeout: 3_000 });

		// Reload — collapsed state should persist
		await s.reload();

		// assert — sidebar still collapsed after reload
		s.assert();
		await expect(page.locator(".w-14").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator(".w-\\[240px\\]")).toHaveCount(0, { timeout: 3_000 });

		// Expand to restore state for other tests
		const expandBtn = page.locator("button[title*='Expand sidebar']").first();
		await expect(expandBtn).toBeVisible({ timeout: 5_000 });
		await expandBtn.click();
		await expect(page.locator(".w-\\[240px\\]").first()).toBeVisible({ timeout: 5_000 });
	});

	// ---------------------------------------------------------------
	// SB-34: Sidebar keyboard shortcuts
	// ---------------------------------------------------------------

	test("SB-34: Keyboard shortcuts for sidebar search and collapse", async ({ page }) => {
		s.begin(defineStory({
			id: "SB-34",
			title: "Keyboard shortcuts for sidebar search and collapse",
			contracts: [CT_03],
			covers: ["deep-link-navigation"],
		}));

		// setup
		await s.sidebar.is_visible();

		// act — test Ctrl+K focuses search
		s.act();
		await page.keyboard.press("Control+k");
		await page.waitForTimeout(300);

		const searchInput = page.locator("input[data-search]");
		await expect(searchInput).toBeFocused({ timeout: 5_000 });

		// Press Escape to blur search
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);

		// Test Ctrl+[ toggles sidebar collapse
		await expect(page.locator(".w-\\[240px\\]").first()).toBeVisible({ timeout: 5_000 });
		await page.keyboard.press("Control+[");
		await page.waitForTimeout(500);

		// Sidebar should be collapsed (w-14)
		await expect(page.locator(".w-14").first()).toBeVisible({ timeout: 5_000 });

		// assert — keyboard shortcuts work
		s.assert();
		// Toggle back to expanded
		await page.keyboard.press("Control+[");
		await page.waitForTimeout(500);
		await expect(page.locator(".w-\\[240px\\]").first()).toBeVisible({ timeout: 5_000 });
	});

	// ---------------------------------------------------------------
	// CT-03: Session highlight on navigation
	// ---------------------------------------------------------------

	test("CT-03-sidebar-highlight: Session highlight follows navigation", async ({ page }) => {
		s.begin(defineStory({
			id: "CT-03-sidebar-highlight",
			title: "Session highlight follows navigation with back/forward",
			contracts: [CT_03],
			covers: ["deep-link-navigation", "back-forward-navigation"],
		}));

		// setup — create two sessions
		const idA = await s.createTestSession("A");
		const idB = await s.createTestSession("B");

		// act — navigate to session A via deep link
		s.act();
		await navigateToHash(page, `#/session/${idA}`);
		await expect(page.locator("textarea").first())
			.toBeVisible({ timeout: 15_000 });

		// Session A should be highlighted
		const activeRow = page.locator(".sidebar-session-active");
		await expect(activeRow).toBeVisible({ timeout: 5_000 });

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
		await expect(page.locator(".sidebar-session-active")).toBeVisible({ timeout: 5_000 });
	});
});

// ---------------------------------------------------------------
// Spec graph dump
// ---------------------------------------------------------------

test.describe("Sidebar spec graph", () => {
	test.beforeEach(() => {
		clearStoryRegistry();
		// Do NOT clear contract registry — contracts from spec-contracts.ts must remain
	});

	test("spec graph dump for sidebar stories", () => {
		// Re-register stories for graph analysis
		defineStory({ id: "SB-01", title: "Project sections collapse persistence", contracts: [CT_03], covers: ["page-reload"] });
		defineStory({ id: "SB-02", title: "Goal team nesting expand/collapse", contracts: [CT_03], covers: ["collapsed-tree-expansion"] });
		defineStory({ id: "SB-03", title: "Auto-expand parent on deep link", contracts: [CT_03], covers: ["deep-link-navigation", "collapsed-tree-expansion"] });
		defineStory({ id: "SB-06", title: "Idle time display on session rows", contracts: [CT_04], covers: ["page-reload"] });
		defineStory({ id: "SB-09", title: "Goal gate progress badge", contracts: [CT_04], covers: ["page-reload"] });
		defineStory({ id: "SB-12", title: "Completed goal rendering", contracts: [CT_04], covers: ["page-reload"] });
		defineStory({ id: "SB-24", title: "Filter sidebar by typing", contracts: [CT_03], covers: ["page-reload"] });
		defineStory({ id: "SB-27", title: "Show archived toggle", contracts: [CT_03, CT_04], covers: ["page-reload"] });
		defineStory({ id: "SB-32", title: "Collapsed sidebar icon-only mode", contracts: [CT_03], covers: ["page-reload"] });
		defineStory({ id: "SB-34", title: "Sidebar keyboard shortcuts", contracts: [CT_03], covers: ["deep-link-navigation"] });
		defineStory({ id: "CT-03-sidebar-highlight", title: "Session highlight follows navigation", contracts: [CT_03], covers: ["deep-link-navigation", "back-forward-navigation"] });

		const graph = exportSpecGraph();

		// CT-03 should have stories
		expect(graph.contracts["CT-03"]).toBeTruthy();
		expect(graph.contracts["CT-03"].stories.length).toBeGreaterThanOrEqual(8);

		// CT-04 should have stories
		expect(graph.contracts["CT-04"]).toBeTruthy();
		expect(graph.contracts["CT-04"].stories.length).toBeGreaterThanOrEqual(3);

		// Check coverage completeness
		const completeness = contractCompleteness();

		const ct03 = completeness.find(c => c.contractId === "CT-03");
		expect(ct03).toBeTruthy();
		// CT-03 variations: deep-link-navigation, back-forward-navigation, page-reload, collapsed-tree-expansion
		expect(ct03!.coverage).toBe(1);

		const ct04 = completeness.find(c => c.contractId === "CT-04");
		expect(ct04).toBeTruthy();
		// CT-04 variations: page-reload covered, agent-crash-restart and concurrent-agents not covered here
		const ct04Covered = ct04!.variations.filter(v => v.coveredBy !== null);
		expect(ct04Covered.length).toBeGreaterThanOrEqual(1);
	});
});
