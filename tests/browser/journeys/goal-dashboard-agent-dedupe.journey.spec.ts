import type { Page } from "@playwright/test";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	test,
	waitForSessionStatus,
} from "../../support/helpers/browser/journeys/journey-fixture.js";
import { startTeam, teardownTeam } from "../../support/harnesses/browser/e2e-setup.js";

const REGRESSION = "GOAL_AGENT_DEDUPE_BROWSER_REGRESSION";

async function expectArchivedLeadFromBothSources(page: Page, sessionId: string): Promise<void> {
	await expect.poll(() => page.evaluate((id) => {
		const state = (window as any).bobbitState;
		return {
			live: Array.isArray(state?.gatewaySessions) && state.gatewaySessions.some((session: { id?: string }) => session.id === id),
			archived: Array.isArray(state?.archivedSessions) && state.archivedSessions.some((session: { id?: string }) => session.id === id),
		};
	}, sessionId), {
		timeout: 20_000,
		message: `${REGRESSION}: archived team lead must hydrate into dashboard session state`,
	}).toEqual({ live: false, archived: true });

	const agentsTab = page.locator("[data-testid='tab-agents']");
	await expect(agentsTab.locator(".tab-count"), `${REGRESSION}: Agents badge must count the unique archived lead once`).toHaveText("1", { timeout: 20_000 });

	const panel = page.locator("[data-testid='goal-dashboard-tab-panel'][data-tab-id='agents']");
	const cards = panel.locator(".agent-card");
	await expect(cards, `${REGRESSION}: Agents tab must render one card for the archived lead returned by both lifecycle sources`).toHaveCount(1, { timeout: 20_000 });
	await expect(cards.first().locator(".role-tag").filter({ hasText: /^LEAD$/ })).toHaveCount(1);
	await expect(cards.first()).toContainText("Dismissed");
}

test.describe("Journey: Goal dashboard archived team-lead dedupe", () => {
	test("shows one lead card and a matching badge after teardown, navigation, and reload", async ({ page }) => {
		test.setTimeout(90_000);
		const goal = await createGoal({
			title: `Archived lead dedupe ${Date.now()}`,
			team: true,
			autoStartTeam: false,
		});
		let teamLeadId: string | undefined;

		try {
			teamLeadId = await startTeam(goal.id);
			await waitForSessionStatus(teamLeadId, "idle", 30_000);
			await teardownTeam(goal.id);

			await expect.poll(async () => {
				const response = await apiFetch(`/api/goals/${goal.id}/team/agents?include=archived`);
				if (!response.ok) return -1;
				const body = await response.json() as { agents?: Array<{ sessionId?: string; status?: string }> };
				return (body.agents ?? []).filter((agent) => agent.sessionId === teamLeadId && agent.status === "archived").length;
			}, {
				timeout: 20_000,
				message: `${REGRESSION}: team-agents response must expose the archived lead before UI hydration`,
			}).toBe(1);

			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator("[data-testid='goal-dashboard']")).toBeVisible({ timeout: 20_000 });
			await page.locator("[data-testid='tab-agents']").click();
			await expect(page.locator("[data-testid='tab-agents']")).toHaveAttribute("data-active", "true");
			await expectArchivedLeadFromBothSources(page, teamLeadId);

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("[data-testid='goal-dashboard']")).toBeVisible({ timeout: 20_000 });
			await expect(page.locator("[data-testid='tab-agents']")).toHaveAttribute("data-active", "true", { timeout: 20_000 });
			await expectArchivedLeadFromBothSources(page, teamLeadId);
		} finally {
			await teardownTeam(goal.id).catch(() => {});
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			await deleteGoal(goal.id, true).catch(() => {});
		}
	});
});
