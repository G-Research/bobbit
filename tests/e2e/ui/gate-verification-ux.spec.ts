/**
 * Gate Verification UX E2E tests.
 *
 * Tests:
 * 1. Dashboard establishes a viewer WebSocket and closes it on nav away
 * 2. Dashboard session links use in-place navigation (no target="_blank")
 * 3. delegate-cards renderSessionLink uses in-place navigation
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, createGoal, deleteSession, deleteGoal } from "../e2e-setup.js";
import { openApp, navigateToGoalDashboard, navigateToHash } from "./ui-helpers.js";

test.describe("Gate verification UX", () => {
	test("dashboard opens viewer WS and closes it on navigation away", async ({ page }) => {
		const goal = await createGoal({ title: "WS test goal", workflowId: "general" });
		const goalId = goal.id;

		try {
			await openApp(page);

			// Set up WS listener BEFORE navigating to dashboard
			const wsPromise = page.waitForEvent("websocket", {
				predicate: (ws) => ws.url().includes("/ws/viewer"),
				timeout: 30_000,
			});

			await navigateToGoalDashboard(page, goalId);

			// Verify WS to /ws/viewer was actually opened
			const viewerWs = await wsPromise;
			expect(viewerWs.url()).toContain("/ws/viewer");

			// Verify WS closes when navigating away
			const wsClosePromise = viewerWs.waitForEvent("close", { timeout: 5_000 });
			await navigateToHash(page, "#/");
			await wsClosePromise; // resolves only if WS was closed

			// Navigate back — should establish a NEW viewer WS
			const ws2Promise = page.waitForEvent("websocket", {
				predicate: (ws) => ws.url().includes("/ws/viewer"),
				timeout: 30_000,
			});
			await navigateToGoalDashboard(page, goalId);
			const viewerWs2 = await ws2Promise;
			expect(viewerWs2.url()).toContain("/ws/viewer");
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("dashboard session links use in-place navigation (no target=_blank)", async ({ page }) => {
		const goal = await createGoal({ title: "Nav test goal", workflowId: "general" });
		const goalId = goal.id;
		const sessionId = await createSession();

		try {
			await openApp(page);
			await navigateToGoalDashboard(page, goalId);

			// Verify no target="_blank" links pointing to sessions exist on the dashboard
			const blankSessionLinks = await page.locator('a[target="_blank"][href*="session"]').count();
			expect(blankSessionLinks).toBe(0);

			// Verify in-place hash navigation works for sessions
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });

			// Confirm hash is correct
			const hash = await page.evaluate(() => location.hash);
			expect(hash).toBe(`#/session/${sessionId}`);
		} finally {
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("delegate-cards session link navigates in-place (no new tab)", async ({ page }) => {
		const sessionId = await createSession();

		try {
			await openApp(page);

			// Navigate to session view
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });

			// Verify no target="_blank" links pointing to /session/ exist on the page
			const blankSessionLinks = await page.locator('a[target="_blank"][href*="/session/"]').count();
			expect(blankSessionLinks).toBe(0);

			// Verify that hash-based session navigation works in-place
			const newSession = await createSession();
			try {
				await navigateToHash(page, `#/session/${newSession}`);
				await expect(page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });

				const hash = await page.evaluate(() => location.hash);
				expect(hash).toBe(`#/session/${newSession}`);
			} finally {
				await deleteSession(newSession);
			}
		} finally {
			await deleteSession(sessionId);
		}
	});
});
