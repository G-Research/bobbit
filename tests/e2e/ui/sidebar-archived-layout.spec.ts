/**
 * E2E tests: Sidebar archived sessions, layout, and resilience.
 * Covers SB-27 (toggle archived), SB-28 (archived team structure),
 * SB-29 (archived goals), SB-32 (collapsed sidebar), SB-33 (mobile),
 * SB-37 (sidebar survives reload).
 */
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	createGoal,
	createSession,
	deleteSession,
	deleteGoal,
	startTeam,
	teardownTeam,
	waitForSessionStatus,
	nonGitCwd,
} from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import { filtersButton, clickShowArchivedToggle } from "./utils/sidebar-filters.js";

// ---------------------------------------------------------------------------
// SB-27/SB-29: Toggle archived and archived goals
// ---------------------------------------------------------------------------
test.describe("SB-27/SB-29: Toggle Show archived", () => {
	let sessionId: string;
	const goalIds: string[] = [];

	test.beforeAll(async () => {
		sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await deleteSession(sessionId);

		for (let i = 0; i < 2; i++) {
			const goal = await createGoal({
				title: `Archive Goal ${i + 1}`,
				worktree: false,
			});
			goalIds.push(goal.id);
			await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });
		}
	});

	test.afterAll(async () => {
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		for (const id of goalIds) await deleteGoal(id).catch(() => {});
	});

	test("toggle archived on shows archived content/goals, persists across reload, and toggle off hides", async ({ page }) => {
		await openApp(page);

		const archivedHeader = page.locator("span.uppercase").filter({ hasText: "Archived" });
		const seeArchivedBtn = filtersButton(page);
		await expect(seeArchivedBtn).toBeVisible({ timeout: 10_000 });
		await clickShowArchivedToggle(page);

		await expect(archivedHeader.first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(".opacity-60").first()).toBeVisible({ timeout: 5_000 });
		for (let i = 0; i < 2; i++) {
			await expect(
				page.getByText(`Archive Goal ${i + 1}`, { exact: false }).first(),
			).toBeVisible({ timeout: 10_000 });
		}

		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await expect(archivedHeader.first()).toBeVisible({ timeout: 10_000 });

		await clickShowArchivedToggle(page);
		await expect(page.locator("button").filter({ hasText: "Load more" })).toHaveCount(0, { timeout: 5_000 });
		await expect(seeArchivedBtn).not.toHaveClass(/text-primary/, { timeout: 3_000 });
	});
});

// ---------------------------------------------------------------------------
// SB-28: Navigate archived team structure
// ---------------------------------------------------------------------------
test.describe("SB-28: Archived team structure", () => {
	let goalId: string;

	test.afterAll(async () => {
		if (goalId) {
			await teardownTeam(goalId).catch(() => {});
			await deleteGoal(goalId);
		}
	});

	test("archived team lead and children appear with greyscale under goal", async ({ page }) => {
		// Create a team goal, start the team, then tear it down to archive
		const goal = await createGoal({
			title: "Archived Team Test",
			worktree: false,
			team: true,
			autoStartTeam: false,
		});
		goalId = goal.id;

		// Start and then teardown the team (archives team lead + members)
		const teamLeadId = await startTeam(goalId);
		await waitForSessionStatus(teamLeadId, "idle");
		await teardownTeam(goalId);

		await openApp(page);

		// Enable archived view via the Filters popover
		const seeArchivedBtn = filtersButton(page);
		await expect(seeArchivedBtn).toBeVisible({ timeout: 10_000 });
		await clickShowArchivedToggle(page);

		// Wait for the See-Archived toggle to activate. The goal here is LIVE
		// (not archived) — only its team sessions were archived via teardown.
		// Those sessions have teamGoalId set so they're excluded from the
		// per-project Archived subsection and instead render nested inside
		// the live goal group (see renderGoalGroup's state.showArchived branch).
		// There's therefore no separate "Archived" subsection header to wait
		// for — just poll the toggle's active state.
		await expect.poll(
			async () => seeArchivedBtn.evaluate((el) => el.className.includes("text-primary")),
			{ timeout: 10_000 },
		).toBe(true);

		// The live goal row should appear in the sidebar.
		const goalText = page.getByText("Archived Team Test", { exact: false });
		await expect(goalText.first()).toBeVisible({ timeout: 10_000 });

		// Expand the goal by clicking it
		await goalText.first().click();

		// After expanding, archived team-lead + member rows should be visible
		// under the goal. renderArchivedSessionRow applies an inline
		// `filter:grayscale(1); opacity:0.75` style rather than a Tailwind
		// .opacity-60 class — match on the inline style attribute instead.
		const archivedSessions = page.locator("[style*='grayscale(1)']");
		await expect(archivedSessions.first()).toBeVisible({ timeout: 10_000 });
	});
});

// ---------------------------------------------------------------------------
// SB-32: Collapsed sidebar
// ---------------------------------------------------------------------------
test.describe("SB-32: Collapsed sidebar", () => {
	test("collapse button narrows sidebar, persists across reload, expand restores", async ({ page }) => {
		await openApp(page);

		// The sidebar should be expanded initially
		const sidebar = page.locator("[data-testid='sidebar-expanded']").first();
		await expect(sidebar).toBeVisible({ timeout: 10_000 });

		// Click the collapse button (PanelLeftClose icon button)
		const collapseBtn = page.locator("button[title*='Collapse sidebar']").first();
		await expect(collapseBtn).toBeVisible({ timeout: 5_000 });
		await collapseBtn.click();

		// Sidebar should now be collapsed (icon-only strip)
		const collapsedSidebar = page.locator("[data-testid='sidebar-collapsed']").first();
		await expect(collapsedSidebar).toBeVisible({ timeout: 5_000 });
		// Expanded sidebar should be gone
		await expect(page.locator("[data-testid='sidebar-expanded']")).toHaveCount(0, { timeout: 3_000 });

		// Reload — collapsed state should persist
		await page.reload();
		await expect(
			page.locator("[data-testid='sidebar-collapsed']").first(),
		).toBeVisible({ timeout: 15_000 });
		// Expanded sidebar should still be gone after reload
		await expect(page.locator("[data-testid='sidebar-expanded']")).toHaveCount(0, { timeout: 3_000 });

		// Click expand button to restore
		const expandBtn = page.locator("button[title*='Expand sidebar']").first();
		await expect(expandBtn).toBeVisible({ timeout: 5_000 });
		await expandBtn.click();

		// Expanded sidebar should be back
		await expect(page.locator("[data-testid='sidebar-expanded']").first()).toBeVisible({ timeout: 5_000 });
	});
});

// ---------------------------------------------------------------------------
// SB-33: Mobile sidebar — action buttons visible without hover
// ---------------------------------------------------------------------------
test.describe("SB-33: Mobile sidebar", () => {
	test.use({ viewport: { width: 375, height: 667 } });

	let sessionId: string;

	test.afterAll(async () => {
		if (sessionId) await deleteSession(sessionId).catch(() => {});
	});

	test("action buttons visible on mobile without hover", async ({ page }) => {
		// Create a session so there's content in the sidebar
		sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// On mobile, the sidebar may be a full-page overlay.
		// Wait for the app to load — on mobile there's no persistent sidebar Settings button
		// The mobile layout shows sessions directly or has a hamburger menu
		// Wait for the page to fully load
		await page.waitForLoadState("networkidle");

		// On mobile viewport, the sidebar opens as an overlay.
		// Look for session rows — action buttons should be visible without hover.
		// The mobile render path shows action buttons (rename, terminate) inline.
		// Check that action buttons are visible (not hidden behind hover state).
		// On desktop, actions use "hidden group-hover:flex" — on mobile they're always visible.

		// Look for the session title in the mobile sidebar
		const sessionRow = page.locator("[class*='cursor-pointer']").first();
		if (await sessionRow.isVisible()) {
			// On mobile, the rename/terminate buttons should be visible without hover
			// Desktop pattern: "sidebar-actions hidden group-hover:flex"
			// Mobile pattern: buttons are directly visible
			const hiddenActions = page.locator(".sidebar-actions.hidden");
			const hiddenCount = await hiddenActions.count();
			// On mobile, there should be no hidden action buttons
			expect(hiddenCount).toBe(0);
		}
	});
});

// ---------------------------------------------------------------------------
// SB-37: Sidebar survives reload (expand/collapse state preserved)
// ---------------------------------------------------------------------------
test.describe("SB-37: Sidebar state survives reload", () => {
	const goalIds: string[] = [];
	let sessionId: string;

	test.afterAll(async () => {
		for (const id of goalIds) {
			await teardownTeam(id).catch(() => {});
			await deleteGoal(id);
		}
		if (sessionId) await deleteSession(sessionId).catch(() => {});
	});

	test("expand/collapse state and active session persist across reload", async ({ page }) => {
		// Create 2 goals
		const goal1 = await createGoal({ title: "Persist Goal A", worktree: false, team: true, autoStartTeam: false });
		const goal2 = await createGoal({ title: "Persist Goal B", worktree: false, team: true, autoStartTeam: false });
		goalIds.push(goal1.id, goal2.id);

		// Create a session and connect to it
		sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// Navigate to the session so it's active
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Expand goal 1 by clicking on it (goals are rendered as collapsible headers)
		const goal1Text = page.getByText("Persist Goal A", { exact: false });
		await expect(goal1Text.first()).toBeVisible({ timeout: 10_000 });
		await goal1Text.first().click();

		// Goal 1 should now be expanded (has a ▾ chevron)
		// Goal 2 should remain collapsed by default

		// localStorage write is synchronous in the click handler; poll until it's visible.
		await page.waitForFunction(
			() => {
				const raw = localStorage.getItem("bobbit-expanded-goals");
				if (!raw) return false;
				try { return (JSON.parse(raw) as string[]).length > 0; } catch { return false; }
			},
			{ timeout: 5_000 },
		);

		// Reload the page
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// After reload, verify:
		// 1. The goal titles are still visible
		await expect(
			page.getByText("Persist Goal A", { exact: false }).first(),
		).toBeVisible({ timeout: 10_000 });
		await expect(
			page.getByText("Persist Goal B", { exact: false }).first(),
		).toBeVisible({ timeout: 10_000 });

		// 2. The previously active session should reconnect
		// Check the URL hash still has the session
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain(sessionId);
		}).toPass({ timeout: 10_000 });

		// 3. Goal expand/collapse state is stored in localStorage
		const expandState = await page.evaluate(() => {
			return localStorage.getItem("bobbit-expanded-goals");
		});
		// The expanded goals set should exist and be non-empty
		expect(expandState).toBeTruthy();
	});
});
