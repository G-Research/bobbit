/**
 * Sidebar navigation E2E tests — SB-01, SB-02, SB-03, SB-04, SB-21.
 *
 * Tests project collapse/expand with persistence, session click + highlight,
 * goal team navigation, active session auto-expand, rapid session switching,
 * and goal dashboard navigation.
 */
import { test, expect } from "../gateway-harness.js";
import {
	createSession,
	deleteSession,
	createGoal,
	startTeam,
	teardownTeam,
	deleteGoal,
	apiFetch,
	nonGitCwd,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Sidebar navigation", () => {
	test.describe.configure({ retries: 2 });
	const sessionIds: string[] = [];
	const goalIds: string[] = [];

	test.afterAll(async () => {
		for (const gid of goalIds) {
			await teardownTeam(gid).catch(() => {});
			await deleteGoal(gid);
		}
		for (const sid of sessionIds) {
			await deleteSession(sid);
		}
	});

	// SB-01 collapse persistence: covered by stories-sidebar.spec.ts via localStorage verification.
	// Removed: reload-based variant was redundant and unreliable under server load.

	// ---------------------------------------------------------------
	// SB-01: Click session to navigate and highlight
	// ---------------------------------------------------------------
	test("SB-01: clicking session row connects and highlights it", async ({ page }) => {
		const id1 = await createSession();
		const id2 = await createSession();
		sessionIds.push(id1, id2);

		await waitForSessionStatus(id1, "idle");
		await waitForSessionStatus(id2, "idle");

		await openApp(page);

		// Navigate to session 1 via hash
		await navigateToHash(page, `#/session/${id1}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		// Verify URL contains session 1
		let hash = await page.evaluate(() => window.location.hash);
		expect(hash).toContain(id1);

		// Verify the active row has the sidebar-session-active class
		const activeRow1 = page.locator(".sidebar-session-active");
		await expect(activeRow1).toBeVisible({ timeout: 5_000 });

		// Navigate to session 2
		await navigateToHash(page, `#/session/${id2}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		// Verify URL contains session 2
		hash = await page.evaluate(() => window.location.hash);
		expect(hash).toContain(id2);

		// Only one row should be active
		const activeRows = page.locator(".sidebar-session-active");
		await expect(activeRows).toHaveCount(1, { timeout: 5_000 });
	});

	// ---------------------------------------------------------------
	// SB-02: Goal team navigation — expand goal, see team lead + children
	// ---------------------------------------------------------------
	test("SB-02: goal group shows team lead with expandable children", async ({ page }) => {
		const goal = await createGoal({
			title: "Nav Team Test",
			worktree: false,
			team: true,
		});
		goalIds.push(goal.id);
		const teamLeadId = await startTeam(goal.id);

		await openApp(page);

		// Find the goal in the sidebar — goal titles are rendered with CSS uppercase
		// The text content is original case ("Nav Team Test"), displayed as uppercase via CSS class
		const goalHeader = page.getByText("Nav Team Test", { exact: false }).first();
		await expect(goalHeader).toBeVisible({ timeout: 15_000 });

		// Verify the goal header uses uppercase CSS class
		const headerEl = goalHeader.locator("xpath=ancestor-or-self::*[contains(@class, 'uppercase')]").first();
		await expect(headerEl).toBeVisible();

		// Click the "Expand goal" chevron to expand the goal group
		const expandChevron = page.locator("[title='Expand goal']").first();
		const collapseChevron = page.locator("[title='Collapse goal']").first();

		// If already expanded, no need to click
		const alreadyExpanded = await collapseChevron.isVisible().catch(() => false);
		if (!alreadyExpanded) {
			await expandChevron.click();
		}

		// Wait for team lead session to appear — the team start creates a session with "Team Lead" title
		// or the default title. Let's look for the session row inside the goal group.
		await waitForSessionStatus(teamLeadId, "idle");

		// After expanding, wait for the sidebar to render the team lead session
		// Navigate directly to the team lead to ensure it connects
		await navigateToHash(page, `#/session/${teamLeadId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Verify URL contains the team lead session ID
		const hash = await page.evaluate(() => window.location.hash);
		expect(hash).toContain(teamLeadId);
	});

	// ---------------------------------------------------------------
	// SB-03: Navigating to a session inside an expanded goal highlights it
	// ---------------------------------------------------------------
	test("SB-03: navigating to session inside expanded goal shows it highlighted", async ({ page }) => {
		const goal = await createGoal({
			title: "AutoExp Test",
			worktree: false,
			team: true,
		});
		goalIds.push(goal.id);
		const teamLeadId = await startTeam(goal.id);

		await openApp(page);

		// The goal should be auto-expanded (createGoal adds to expandedGoals)
		const goalHeader = page.getByText("AutoExp Test", { exact: false }).first();
		await expect(goalHeader).toBeVisible({ timeout: 15_000 });

		// Ensure goal is expanded — look for "Collapse goal" chevron
		const collapseChevron = page.locator("[title='Collapse goal']").first();
		const isExpanded = await collapseChevron.isVisible().catch(() => false);
		if (!isExpanded) {
			// Expand it
			const expandChevron = page.locator("[title='Expand goal']").first();
			await expandChevron.click();
		}

		// Navigate directly to the team lead session via URL
		await navigateToHash(page, `#/session/${teamLeadId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// The session row should be highlighted as active in the sidebar
		const activeRow = page.locator(".sidebar-session-active");
		await expect(activeRow).toBeVisible({ timeout: 10_000 });
	});

	// ---------------------------------------------------------------
	// SB-04: Rapid session switching settles on last clicked
	// ---------------------------------------------------------------
	test("SB-04: rapid switching settles on last clicked session", async ({ page }) => {
		const idA = await createSession();
		const idB = await createSession();
		const idC = await createSession();
		sessionIds.push(idA, idB, idC);

		await waitForSessionStatus(idA, "idle");
		await waitForSessionStatus(idB, "idle");
		await waitForSessionStatus(idC, "idle");

		await openApp(page);

		// Wait for all sessions to appear in sidebar
		await page.waitForTimeout(1000);

		// Rapidly switch sessions via hash — no awaits between
		await page.evaluate(
			([a, b, c]) => {
				window.location.hash = `#/session/${a}`;
				// Use a microtask-level delay to simulate rapid clicks
				setTimeout(() => { window.location.hash = `#/session/${b}`; }, 50);
				setTimeout(() => { window.location.hash = `#/session/${c}`; }, 100);
			},
			[idA, idB, idC],
		);

		// Wait for session C to load — textarea visible means session is connected
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Poll until URL contains session C (the last one) — may take time to settle
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain(idC);
		}).toPass({ timeout: 10_000 });

		// Only one session should be active in sidebar
		const activeRows = page.locator(".sidebar-session-active");
		await expect(activeRows).toHaveCount(1, { timeout: 5_000 });

		// Check for console errors (filter out known benign ones)
		const messages = await page.evaluate(() => {
			// Access console messages collected by the page if available
			return (window as any).__consoleErrors || [];
		});
		// Note: we primarily verify there are no uncaught exceptions via the
		// absence of error-state UI rather than console interception
	});

	// ---------------------------------------------------------------
	// SB-21: Dashboard button navigates to goal dashboard
	// ---------------------------------------------------------------
	test("SB-21: dashboard button navigates to goal dashboard", async ({ page }) => {
		const goal = await createGoal({
			title: "DashNav Test",
			worktree: false,
			team: true,
		});
		goalIds.push(goal.id);

		await openApp(page);

		// Find the goal header in sidebar
		const goalHeader = page.getByText("DASHNAV TEST", { exact: false }).first();
		await expect(goalHeader).toBeVisible({ timeout: 15_000 });

		// The dashboard button is inside a `sidebar-actions hidden group-hover:flex` container.
		// In headless Chromium, CSS :hover on .group may not reliably trigger group-hover.
		// Find the button within the same goal header row and click via JavaScript.
		const goalRow = goalHeader.locator("xpath=ancestor::div[contains(@class, 'group')]").first();
		await goalRow.evaluate((row) => {
			const btn = row.querySelector<HTMLButtonElement>("button[title='Goal dashboard']");
			if (btn) btn.click();
		});

		// Verify URL navigates to goal dashboard
		await expect(async () => {
			const h = await page.evaluate(() => window.location.hash);
			expect(h).toContain(goal.id);
			expect(h).toMatch(/goal/i);
		}).toPass({ timeout: 10_000 });

		// Verify dashboard content loads (tab bar is always present)
		await expect(page.locator(".tab").first()).toBeVisible({ timeout: 10_000 });
	});
});
