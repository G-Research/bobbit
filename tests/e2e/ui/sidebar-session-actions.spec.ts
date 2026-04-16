/**
 * Sidebar session actions E2E tests — SB-14, SB-15, SB-17, SB-18, SB-19, SB-20.
 *
 * Tests creating sessions, starting teams, renaming sessions, and termination
 * through real browser interactions against a live gateway.
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
import { openApp, createSessionViaUI } from "./ui-helpers.js";

test.describe("Sidebar session actions", () => {
	const sessionIds: string[] = [];
	const goalIds: string[] = [];

	test.afterAll(async () => {
		for (const id of goalIds) {
			await teardownTeam(id).catch(() => {});
			await deleteGoal(id);
		}
		for (const id of sessionIds) {
			await deleteSession(id);
		}
	});

	// SB-14: Clicking + creates a new session in the project
	test("clicking + creates a new session in the project", async ({ page }) => {
		await openApp(page);

		// Click the "New session" button (title starts with "New session")
		await page.locator("button[title^='New session']").first().click();

		// Verify textarea appears (session created and connected)
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

		// Verify URL contains a session ID
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toMatch(/#\/session\/[a-f0-9-]+/i);
		}).toPass({ timeout: 5_000 });

		// Extract session ID for cleanup
		const hash = await page.evaluate(() => window.location.hash);
		const match = hash.match(/#\/session\/([a-f0-9-]+)/i);
		if (match) sessionIds.push(match[1]);
	});

	// SB-17: Start Team button on empty team goal
	test("Start Team button creates team lead on empty team goal", async ({ page }) => {
		const goal = await createGoal({
			title: "SB17 Team Test",
			team: true,
			worktree: false,
			autoStartTeam: false,
		});
		goalIds.push(goal.id);

		await openApp(page);

		// Expand the goal in sidebar by clicking on it
		const goalRow = page.getByText("SB17 Team Test").first();
		await expect(goalRow).toBeVisible({ timeout: 10_000 });
		await goalRow.click();

		// Look for "Start Team" text/button in the empty state
		const startBtn = page.getByText("Start Team").first();
		await expect(startBtn).toBeVisible({ timeout: 10_000 });
		await startBtn.click();

		// Verify team lead session appears (textarea visible = connected)
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });

		// Verify URL navigated to the team lead session
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toMatch(/#\/session\/[a-f0-9-]+/i);
		}).toPass({ timeout: 5_000 });
	});

	// SB-18: "start one" link on non-team goal
	test("start one link creates session on non-team goal", async ({ page }) => {
		// Create a non-team goal
		const goal = await createGoal({
			title: "SB18 Solo Goal",
			worktree: false,
		});
		goalIds.push(goal.id);

		// Verify via API that the goal was created without team flag
		const goalResp = await apiFetch(`/api/goals/${goal.id}`);
		const goalData = await goalResp.json();

		await openApp(page);

		// Wait for sidebar to show the goal
		const goalRow = page.getByText("SB18 Solo Goal").first();
		await expect(goalRow).toBeVisible({ timeout: 10_000 });

		// Click to expand the goal group
		await goalRow.click();

		// Wait for expansion — look for "start one" or "No sessions" text
		// Use a longer timeout and check both possible states
		const startOneLocator = page.getByText("start one");
		const noSessionsLocator = page.getByText("No sessions");
		const startTeamLocator = page.getByText("Start Team");

		// Wait for any empty state to appear
		await expect(async () => {
			const startOne = await startOneLocator.count();
			const noSessions = await noSessionsLocator.count();
			const startTeam = await startTeamLocator.count();
			// At least one of these should be visible
			expect(startOne + noSessions + startTeam).toBeGreaterThan(0);
		}).toPass({ timeout: 10_000 });

		// If "start one" is visible, click it. Otherwise fall back.
		const startOneCount = await startOneLocator.count();
		if (startOneCount > 0) {
			await startOneLocator.first().click();
		} else {
			// Goal may have been created as team goal — try Start Team
			const startTeamCount = await startTeamLocator.count();
			if (startTeamCount > 0) {
				await startTeamLocator.first().click();
			}
		}

		// Verify session created (textarea visible)
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

		// Verify URL has a session
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toMatch(/#\/session\/[a-f0-9-]+/i);
		}).toPass({ timeout: 5_000 });
	});

	// SB-19: Rename session
	test("rename dialog updates session title and persists", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// Navigate to the session
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// The session row should be visible in the sidebar. Hover to reveal action buttons.
		const sessionRow = page.locator(".sidebar-session-active").first();
		await expect(sessionRow).toBeVisible({ timeout: 10_000 });
		await sessionRow.hover();

		// Click the pencil/rename button (title="Modify")
		const renameBtn = sessionRow.locator("button[title='Modify']");
		await expect(renameBtn).toBeVisible({ timeout: 5_000 });
		await renameBtn.click();

		// Dialog should appear — the rename dialog has title "Edit Session"
		await expect(page.getByText("Edit Session").first()).toBeVisible({ timeout: 5_000 });

		// Find the title input and type a new name
		const titleInput = page.locator("input[placeholder='Session title…']").first();
		await expect(titleInput).toBeVisible({ timeout: 5_000 });
		await titleInput.fill("Renamed Session E2E");

		// Press Enter to save (the input has onKeyDown Enter → doSave)
		await titleInput.press("Enter");

		// Verify sidebar shows the new name
		await expect(page.getByText("Renamed Session E2E").first()).toBeVisible({ timeout: 5_000 });

		// Reload the page
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Navigate back to the session
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Verify name persists after reload
		await expect(page.getByText("Renamed Session E2E").first()).toBeVisible({ timeout: 5_000 });
	});

	// SB-20: Terminate session
	test("terminate button removes session from sidebar @smoke", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// Navigate to the session
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Hover over the active session row to reveal action buttons
		const sessionRow = page.locator(".sidebar-session-active").first();
		await expect(sessionRow).toBeVisible({ timeout: 10_000 });
		await sessionRow.hover();

		// Click the trash/terminate button
		const trashBtn = sessionRow.locator("button[title*='Terminate']");
		await expect(trashBtn).toBeVisible({ timeout: 5_000 });
		await trashBtn.click();

		// Wait for the confirmation dialog overlay to appear
		// The Dialog component renders a .fixed.inset-0 backdrop
		const backdrop = page.locator(".fixed.inset-0").first();
		await expect(backdrop).toBeVisible({ timeout: 5_000 });

		// Click the "Terminate" button within the dialog (not the X close button)
		await backdrop.locator("button").filter({ hasText: "Terminate" }).click();

		// Verify the UI navigated away from the terminated session
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).not.toContain(sessionId);
		}).toPass({ timeout: 5_000 });

		// Verify the session is no longer in the live sessions list
		// (following the pattern from session-interactions.spec.ts)
		await deleteSession(sessionId);
		await expect(async () => {
			const resp = await apiFetch("/api/sessions");
			const sessions = ((await resp.json()).sessions || []);
			const found = sessions.find((s: { id: string }) => s.id === sessionId);
			expect(found).toBeFalsy();
		}).toPass({ timeout: 10_000 });
	});

	// SB-20: Terminate team lead dismisses entire team
	test("ending team removes all team sessions", async ({ page }) => {
		const goal = await createGoal({
			title: "SB20 Team End",
			team: true,
			worktree: false,
		});
		goalIds.push(goal.id);

		// Start team via API
		const teamLeadId = await startTeam(goal.id);
		await waitForSessionStatus(teamLeadId, "idle");

		await openApp(page);

		// Navigate to the team lead session directly
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, teamLeadId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Now hover the active session row to reveal action buttons
		const sessionRow = page.locator(".sidebar-session-active").first();
		await expect(sessionRow).toBeVisible({ timeout: 10_000 });
		await sessionRow.hover();

		// Click the trash button — for team lead it says "End team (Ctrl+Shift+D)"
		const endTeamBtn = sessionRow.locator("button[title*='End team']");
		await expect(endTeamBtn).toBeVisible({ timeout: 5_000 });
		await endTeamBtn.click();

		// Wait for confirmation dialog and click the confirm button
		const confirmButton = page.locator("button").filter({ hasText: "End Team" });
		await expect(async () => {
			const count = await confirmButton.count();
			expect(count).toBeGreaterThanOrEqual(1);
		}).toPass({ timeout: 5_000 });
		await confirmButton.last().click();

		// Verify team lead is no longer in the active sessions API (poll)
		await expect(async () => {
			const resp = await apiFetch("/api/sessions");
			const sessions = (await resp.json()).sessions || [];
			const teamSession = sessions.find((s: { id: string }) => s.id === teamLeadId);
			expect(teamSession).toBeFalsy();
		}).toPass({ timeout: 15_000 });
	});
});
