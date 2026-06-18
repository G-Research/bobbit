/**
 * Retained spawned-gateway smoke for <goal-status-widget> mounting on real sessions.
 * Popover/action matrices live in tests/goal-status-widget.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, deleteGoal, deleteSession, startTeam, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

async function installWidgetReadMocks(page: any, goalId: string): Promise<void> {
	await page.route(new RegExp(`/api/goals/${goalId}/gates(?:\\?.*)?$`), async (route: any) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ gates: [
				{ gateId: "design-doc", name: "Design Document", status: "passed" },
				{ gateId: "implementation", name: "Implementation", status: "pending" },
			] }),
		});
	});
	await page.route(new RegExp(`/api/goals/${goalId}/verifications/active(?:\\?.*)?$`), async (route: any) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ verifications: [] }) });
	});
}

async function openSession(page: any, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
}

test.describe("<goal-status-widget>", () => {
	test("pill is visible on a real team-lead session and survives reload + narrow viewport @smoke", async ({ page }) => {
		const goal = await createGoal({
			title: `Goal-Status-Widget Team-Lead ${Date.now()}`,
			team: true,
			worktree: false,
			autoStartTeam: false,
		});
		let teamLeadId: string | undefined;
		try {
			await installWidgetReadMocks(page, goal.id);
			teamLeadId = await startTeam(goal.id);
			await waitForSessionStatus(teamLeadId, "idle");

			const sessionInfo = await apiFetch(`/api/sessions/${teamLeadId}`).then(r => r.json());
			expect(sessionInfo.teamGoalId, "REST /api/sessions/:id must expose teamGoalId for the widget").toBe(goal.id);

			await openApp(page);
			await openSession(page, teamLeadId);
			const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
			await expect(pill).toBeVisible({ timeout: 15_000 });
			await expect(pill).toHaveAttribute("data-awaiting-signoffs", "false");

			await page.reload();
			await openSession(page, teamLeadId);
			await expect(pill).toBeVisible({ timeout: 15_000 });

			await page.setViewportSize({ width: 640, height: 800 });
			await expect(pill, "goal widget should not collapse into the overflow popover at narrow widths").toBeVisible({ timeout: 10_000 });
		} finally {
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			await deleteGoal(goal.id).catch(() => {});
		}
	});
});
