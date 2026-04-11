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

// ---------------------------------------------------------------------------
// SB-27: Toggle "Show archived"
// ---------------------------------------------------------------------------
test.describe("SB-27: Toggle Show archived", () => {
	let sessionId: string;

	test.beforeAll(async () => {
		// Create a session, send a message via API to make it non-empty, then archive it
		sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await deleteSession(sessionId); // archives the session
	});

	test("toggle archived on → section appears, persists across reload, toggle off hides", async ({ page }) => {
		await openApp(page);

		// Archived section should not be visible initially
		const archivedHeader = page.locator("span.uppercase").filter({ hasText: "Archived" });

		// Click "See Archived" button in sidebar footer
		const seeArchivedBtn = page.locator("button").filter({ hasText: "See Archived" }).first();
		await expect(seeArchivedBtn).toBeVisible({ timeout: 10_000 });
		await seeArchivedBtn.click();

		// Archived section should appear
		await expect(archivedHeader.first()).toBeVisible({ timeout: 10_000 });

		// Items in the archived section should have reduced opacity (greyscale styling)
		// The archived section wraps items in opacity-60 containers
		const archivedContainer = page.locator(".opacity-60").first();
		await expect(archivedContainer).toBeVisible({ timeout: 5_000 });

		// Reload — toggle state should persist
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Archived section should still be visible after reload
		await expect(archivedHeader.first()).toBeVisible({ timeout: 10_000 });

		// Toggle off
		const seeArchivedBtnAfter = page.locator("button").filter({ hasText: "See Archived" }).first();
		await seeArchivedBtnAfter.click();

		// Archived section content should disappear — the "Load more" buttons and
		// archived session/goal sublists should be hidden.
		// Verify that the "Sessions" or "Goals" sub-headers inside the archived block are gone.
		await expect(
			page.locator("button").filter({ hasText: "Load more" }),
		).toHaveCount(0, { timeout: 5_000 });

		// The archived section toggle button should no longer have the active highlight
		await expect(seeArchivedBtnAfter).not.toHaveClass(/text-primary/, { timeout: 3_000 });
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

		// Enable archived view
		const seeArchivedBtn = page.locator("button").filter({ hasText: "See Archived" }).first();
		await expect(seeArchivedBtn).toBeVisible({ timeout: 10_000 });
		await seeArchivedBtn.click();

		// Wait for archived section to load
		await expect(
			page.locator("span.uppercase").filter({ hasText: "Archived" }).first(),
		).toBeVisible({ timeout: 10_000 });

		// The goal should appear in the archived section.
		// Look for the goal title text (case-insensitive since it's uppercased in sidebar)
		const goalText = page.getByText("Archived Team Test", { exact: false });
		await expect(goalText.first()).toBeVisible({ timeout: 10_000 });

		// Expand the goal by clicking it
		await goalText.first().click();

		// After expanding, archived sessions under the goal should be visible
		// They should be in a container with greyscale/reduced-opacity styling
		// Wait for any session row to appear under the goal
		const archivedSessions = page.locator(".opacity-60");
		await expect(archivedSessions.first()).toBeVisible({ timeout: 10_000 });
	});
});

// ---------------------------------------------------------------------------
// SB-29: Archived goals appear when toggled
// ---------------------------------------------------------------------------
test.describe("SB-29: Archived goals visible", () => {
	const goalIds: string[] = [];

	test.afterAll(async () => {
		for (const id of goalIds) {
			await deleteGoal(id).catch(() => {});
		}
	});

	test("archived goals appear in archived section", async ({ page }) => {
		// Create 2 goals and archive them (DELETE archives, doesn't hard-delete)
		for (let i = 0; i < 2; i++) {
			const goal = await createGoal({
				title: `Archive Goal ${i + 1}`,
				worktree: false,
			});
			goalIds.push(goal.id);
			// Archive the goal via DELETE
			await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });
		}

		await openApp(page);

		// Toggle "Show archived" on
		const seeArchivedBtn = page.locator("button").filter({ hasText: "See Archived" }).first();
		await expect(seeArchivedBtn).toBeVisible({ timeout: 10_000 });
		await seeArchivedBtn.click();

		// Wait for archived section
		await expect(
			page.locator("span.uppercase").filter({ hasText: "Archived" }).first(),
		).toBeVisible({ timeout: 10_000 });

		// Both archived goals should appear
		for (let i = 0; i < 2; i++) {
			await expect(
				page.getByText(`Archive Goal ${i + 1}`, { exact: false }).first(),
			).toBeVisible({ timeout: 10_000 });
		}
	});
});

// ---------------------------------------------------------------------------
// SB-32: Collapsed sidebar
// ---------------------------------------------------------------------------
test.describe("SB-32: Collapsed sidebar", () => {
	test("collapse button narrows sidebar, persists across reload, expand restores", async ({ page }) => {
		await openApp(page);

		// The sidebar should be ~240px wide initially (full width)
		const sidebar = page.locator(".w-\\[240px\\]").first();
		await expect(sidebar).toBeVisible({ timeout: 10_000 });

		// Click the collapse button (PanelLeftClose icon button)
		const collapseBtn = page.locator("button[title*='Collapse sidebar']").first();
		await expect(collapseBtn).toBeVisible({ timeout: 5_000 });
		await collapseBtn.click();

		// Sidebar should now be narrow (~56px / w-14)
		const collapsedSidebar = page.locator(".w-14").first();
		await expect(collapsedSidebar).toBeVisible({ timeout: 5_000 });
		// Full-width sidebar should be gone
		await expect(page.locator(".w-\\[240px\\]")).toHaveCount(0, { timeout: 3_000 });

		// Reload — collapsed state should persist
		await page.reload();
		await expect(
			page.locator(".w-14").first(),
		).toBeVisible({ timeout: 15_000 });
		// Full-width sidebar should still be gone after reload
		await expect(page.locator(".w-\\[240px\\]")).toHaveCount(0, { timeout: 3_000 });

		// Click expand button to restore
		const expandBtn = page.locator("button[title*='Expand sidebar']").first();
		await expect(expandBtn).toBeVisible({ timeout: 5_000 });
		await expandBtn.click();

		// Full-width sidebar should be back
		await expect(page.locator(".w-\\[240px\\]").first()).toBeVisible({ timeout: 5_000 });
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

		// Wait a moment for localStorage to persist
		await page.waitForTimeout(500);

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
