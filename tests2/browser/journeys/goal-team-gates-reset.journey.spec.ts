/**
 * Journey: Completed-goal gate reset reconciliation — v2 browser smoke
 */
import {
  test,
  expect,
  openApp,
  navigateToHash,
  createGoal,
  deleteGoal,
  apiFetch,
  deleteSession,
} from "../_helpers/journey-fixture.js";
import {
  connectWs,
  signalAndWaitForGate,
  startTeam,
  teardownTeam,
} from "../e2e-setup.js";

// Resetting a gate is also a goal lifecycle mutation when the team has already
// completed. Pin the user-visible, cross-tab path rather than relying only on
// the reset endpoint: widget, sidebar-backed goal state, and dashboard gates
// must all reconcile before either page reloads, then hydrate the same truth.
test.describe("Journey: completed goal gate reset reopens live UI", () => {
	test("reset clears Completed and updates session/sidebar/dashboard immediately, then survives reload", async ({ page, context }) => {
		// The completed-team semantics below do not depend on the lead becoming
		// idle; waiting for it serializes this UI-only journey behind mock-agent
		// work and breaches the browser lane's strict per-spec cap.
		test.setTimeout(60_000);
		const goal = await createGoal({
			title: `Completed Gate Reset ${Date.now()}`,
			workflowId: "test-fast",
			team: true,
			autoStartTeam: false,
		});
		const goalId = goal.id as string;
		let teamLeadId = "";
		let conn: Awaited<ReturnType<typeof connectWs>> | undefined;
		const dashboardPage = await context.newPage();
		const browserGoalState = async (targetPage: typeof page) => targetPage.evaluate((targetGoalId) => {
			const clientState = (window as any).bobbitState ?? (window as any).__bobbitState;
			return clientState?.goals?.find((candidate: any) => candidate.id === targetGoalId)?.state ?? null;
		}, goalId);
		try {
			teamLeadId = await startTeam(goalId);
			conn = await connectWs(teamLeadId);
			for (const gateId of ["design-doc", "implementation", "ready-to-merge"]) {
				await signalAndWaitForGate(conn, goalId, gateId, {}, ["passed"], 30_000);
			}

			const completeResponse = await apiFetch(`/api/goals/${goalId}/team/complete`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(completeResponse.status, `team completion failed: ${await completeResponse.clone().text().catch(() => "")}`).toBe(200);
			await expect.poll(async () => {
				const response = await apiFetch(`/api/goals/${goalId}`);
				return response.ok ? (await response.json()).state : null;
			}, { timeout: 15_000, message: "fixture goal should be complete before reset" }).toBe("complete");

			// Both surfaces hydrate independently; opening them concurrently avoids
			// paying for the same UI bootstrap work twice.
			await Promise.all([openApp(page), openApp(dashboardPage)]);
			await Promise.all([
				navigateToHash(page, `#/session/${teamLeadId}`),
				navigateToHash(dashboardPage, `#/goal/${goalId}`),
			]);
			const pill = page.locator('[data-testid="goal-status-widget-pill"]').first();
			const widgetDropdown = page.locator("#goal-status-dropdown");
			const dashboardDesignGate = dashboardPage.locator('[data-testid="goal-dashboard-gate-row"][data-gate-id="design-doc"]').first();
			await Promise.all([
				(async () => {
					await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
					await expect(pill).toBeVisible({ timeout: 15_000 });
					await pill.click();
					await expect(widgetDropdown.locator('[data-testid="goal-widget-completed"]')).toBeVisible({ timeout: 15_000 });
					expect(await browserGoalState(page)).toBe("complete");
				})(),
				(async () => {
					await expect(dashboardPage.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
					await expect(dashboardPage.locator(`[data-nav-id="goal:${goalId}"]`).first()).toBeVisible({ timeout: 15_000 });
					await dashboardPage.locator('[data-testid="tab-gates"]').first().click();
					await expect(dashboardDesignGate).toHaveAttribute("data-gate-status", "passed", { timeout: 15_000 });
					expect(await browserGoalState(dashboardPage)).toBe("complete");
				})(),
			]);

			const designRow = widgetDropdown.locator('[data-testid="goal-widget-gate"][data-gate-id="design-doc"]');
			await designRow.locator('[data-testid="goal-widget-gate-reset"]').click();
			const resetTitle = page.getByText("Reset “Design Doc”?", { exact: true });
			await expect(resetTitle).toBeVisible({ timeout: 10_000 });
			// Resolve with the modal's keyboard action, which preserves the open
			// widget. Explicitly wait for modal teardown before reloading so its
			// backdrop cannot intercept the reloaded status pill.
			await page.keyboard.press("Enter");
			await expect(resetTitle).toHaveCount(0, { timeout: 10_000 });

			await Promise.all([
				expect(widgetDropdown.locator('[data-testid="goal-widget-completed"]'), "Completed must clear without reload").toHaveCount(0, { timeout: 15_000 }),
				expect(designRow, "reset gate should render pending in the still-open widget").toHaveAttribute("data-gate-status", "pending", { timeout: 15_000 }),
				expect.poll(() => browserGoalState(page), {
					timeout: 15_000,
					message: "session/sidebar client state should reopen without reload",
				}).toBe("in-progress"),
				expect.poll(() => browserGoalState(dashboardPage), {
					timeout: 15_000,
					message: "cross-tab dashboard client state should reopen without reload",
				}).toBe("in-progress"),
				expect(dashboardDesignGate, "cross-tab dashboard gate should reset without reload").toHaveAttribute("data-gate-status", "pending", { timeout: 15_000 }),
				expect(dashboardPage.locator(`[data-nav-id="goal:${goalId}"]`).first(), "reopened goal remains in the live sidebar").toBeVisible(),
			]);

			await Promise.all([
				page.reload({ waitUntil: "domcontentloaded" }),
				dashboardPage.reload({ waitUntil: "domcontentloaded" }),
			]);
			const reloadedPill = page.locator('[data-testid="goal-status-widget-pill"]').first();
			await Promise.all([
				(async () => {
					await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
					await expect(reloadedPill).toBeVisible({ timeout: 15_000 });
					await reloadedPill.click();
					await expect(page.locator('#goal-status-dropdown [data-testid="goal-widget-completed"]')).toHaveCount(0);
					await expect(page.locator('#goal-status-dropdown [data-testid="goal-widget-gate"][data-gate-id="design-doc"]')).toHaveAttribute("data-gate-status", "pending", { timeout: 15_000 });
				})(),
				(async () => {
					await expect(dashboardPage.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
					await dashboardPage.locator('[data-testid="tab-gates"]').first().click();
					await expect(dashboardPage.locator('[data-testid="goal-dashboard-gate-row"][data-gate-id="design-doc"]').first()).toHaveAttribute("data-gate-status", "pending", { timeout: 15_000 });
					await expect.poll(() => browserGoalState(dashboardPage), { timeout: 15_000 }).toBe("in-progress");
				})(),
			]);
		} finally {
			conn?.close();
			await dashboardPage.close().catch(() => {});
			// A live team-store entry owns its lead session. Tear the team down
			// before deleting that session so cleanup does not take the rejected
			// delete path or leave a stale team-store reference behind.
			await teardownTeam(goalId).catch(() => {});
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			await deleteGoal(goalId, true).catch(() => {});
		}
	});
});
