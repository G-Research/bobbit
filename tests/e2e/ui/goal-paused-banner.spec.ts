/**
 * E2E — goal-paused in-chat banner visibility.
 *
 * The banner is rendered by `renderGoalPausedBannerIfNeeded` in render.ts.
 * It appears when `activeSession.goalId` (or `teamGoalId`) points to a goal
 * in `state.goals` that has `paused: true`, and disappears when the goal is
 * resumed.
 *
 * Pinned behaviour:
 *   1. Banner is NOT shown when the goal is active (not paused).
 *   2. After pausing via API, the banner appears with the correct testids,
 *      "paused" text, and an inline Resume button.
 *   3. Clicking the Resume button (no descendants → immediate API call, no
 *      dialog) resumes the goal and the banner disappears.
 *
 * See docs/goals-workflows-tasks.md and src/app/render.ts.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, createGoal, deleteSession, deleteGoal, apiFetch, waitForSessionStatus } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Goal paused banner (UI)", () => {
	test("shows banner with Resume button when goal is paused; disappears on resume", async ({ page }) => {
		// 1. Create a goal (no team — we only need the goalId binding)
		const goal = await createGoal({ title: "E2E pause banner goal", autoStartTeam: false });
		const goalId = goal.id as string;

		// 2. Create a session bound to the goal
		const sessionId = await createSession({ goalId });
		await waitForSessionStatus(sessionId, "idle");

		try {
			// 3. Open the app and navigate to the session
			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			// Wait for app state to load goals (state.goals must be populated)
			await page.waitForFunction(
				(id) => {
					const goals: any[] = (window as any).__bobbitState?.goals ?? [];
					return goals.some((g: any) => g.id === id);
				},
				goalId,
				{ timeout: 15_000 },
			);

			// 4. Banner is NOT shown initially (goal is not paused)
			const banner = page.locator('[data-testid="goal-paused-banner"]');
			await expect(banner).toHaveCount(0);

			// 5. Pause the goal via API
			const pauseResp = await apiFetch(`/api/goals/${goalId}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: false }),
			});
			expect(pauseResp.status).toBeLessThan(300);

			// 6. Wait for state.goals to reflect paused=true (WS broadcast → refreshSessions → re-render)
			await page.waitForFunction(
				(id) => {
					const goals: any[] = (window as any).__bobbitState?.goals ?? [];
					return goals.some((g: any) => g.id === id && g.paused === true);
				},
				goalId,
				{ timeout: 15_000 },
			);

			// 7. Banner should now be visible
			await expect(banner).toBeVisible({ timeout: 10_000 });
			await expect(banner).toContainText("paused");

			// 8. Resume button is present inside the banner
			const resumeBtn = page.locator('[data-testid="goal-paused-banner-resume-btn"]');
			await expect(resumeBtn).toBeVisible();
			await expect(resumeBtn).toContainText("Resume");

			// 9. Click Resume — goal has no descendants so resumeGoalWithDialog
			//    calls the API directly without opening a dialog.
			await resumeBtn.click();

			// 10. Wait for state.goals to reflect paused=false (or paused missing)
			await page.waitForFunction(
				(id) => {
					const goals: any[] = (window as any).__bobbitState?.goals ?? [];
					const g = goals.find((g: any) => g.id === id);
					// Either the goal is found with paused falsy, or it's gone from the list
					return !g || !g.paused;
				},
				goalId,
				{ timeout: 15_000 },
			);

			// 11. Banner should be gone
			await expect(banner).toHaveCount(0, { timeout: 10_000 });
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
			await deleteGoal(goalId).catch(() => { /* best-effort */ });
		}
	});

	test("banner not shown for session with no associated goal", async ({ page }) => {
		// A plain session (no goalId) must never show the pause banner.
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			const banner = page.locator('[data-testid="goal-paused-banner"]');
			await expect(banner).toHaveCount(0);

			// Give the app a moment to fully render before asserting absence.
			// Wait until the session appears in state.gatewaySessions (proves the WS
			// connection has delivered at least one update cycle).
			await page.waitForFunction(
				(id) => {
					const sessions: any[] = (window as any).__bobbitState?.gatewaySessions ?? [];
					return sessions.some((s: any) => s.id === id);
				},
				sessionId,
				{ timeout: 15_000 },
			);
			await expect(banner).toHaveCount(0);
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});
});
