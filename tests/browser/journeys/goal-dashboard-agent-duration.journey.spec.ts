import type { Locator, Page } from "@playwright/test";
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
} from "../../../tests2/browser/_helpers/journey-fixture.js";
import { startTeam, teardownTeam } from "../../e2e/e2e-setup.js";

function leadCard(page: Page): Locator {
	return page.locator(".agent-card").filter({ hasText: "LEAD" }).first();
}

async function expectLiveLeadAge(page: Page, createdAt: number): Promise<void> {
	const card = leadCard(page);
	await expect(card).toBeVisible({ timeout: 20_000 });
	const duration = (await card.locator(".agent-card-meta-item").last().textContent())?.trim() ?? "";
	const actualMinutes = Math.floor(Math.max(0, Date.now() - createdAt) / 60_000);

	expect(duration, "LEAD_UPTIME_BROWSER_EPOCH_REGRESSION: Agents tab must show the live lead's session age").toMatch(/^\d+m$/);
	const renderedMinutes = Number.parseInt(duration, 10);
	expect(renderedMinutes).toBeGreaterThanOrEqual(actualMinutes - 1);
	expect(renderedMinutes).toBeLessThanOrEqual(actualMinutes + 1);
}

test.describe("Journey: Goal dashboard team-lead duration", () => {
	test("uses session age after Agents-tab navigation, dashboard navigation, and reload", async ({ page }) => {
		test.setTimeout(90_000);
		const stamp = Date.now();
		const teamGoal = await createGoal({
			title: `Lead uptime ${stamp}`,
			team: true,
			autoStartTeam: false,
		});
		const otherGoal = await createGoal({ title: `Lead uptime navigation ${stamp}` });
		let teamLeadId: string | undefined;

		try {
			teamLeadId = await startTeam(teamGoal.id);
			await waitForSessionStatus(teamLeadId, "idle", 30_000);
			const sessionResponse = await apiFetch(`/api/sessions/${teamLeadId}`);
			expect(sessionResponse.ok).toBe(true);
			const session = await sessionResponse.json() as { createdAt: number };
			expect(Number.isFinite(session.createdAt)).toBe(true);

			await openApp(page);
			await navigateToHash(page, `#/goal/${teamGoal.id}`);
			await expect(page.locator("[data-testid='goal-dashboard']")).toBeVisible({ timeout: 20_000 });
			await page.locator("[data-testid='tab-agents']").click();
			await expectLiveLeadAge(page, session.createdAt);

			await navigateToHash(page, `#/goal/${otherGoal.id}`);
			await expect(page.getByText(String(otherGoal.title), { exact: true }).first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/goal/${teamGoal.id}?tab=agents`);
			await expectLiveLeadAge(page, session.createdAt);

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("[data-testid='goal-dashboard']")).toBeVisible({ timeout: 20_000 });
			await expect(page.locator("[data-testid='tab-agents']")).toHaveAttribute("data-active", "true", { timeout: 20_000 });
			await expectLiveLeadAge(page, session.createdAt);
		} finally {
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			await teardownTeam(teamGoal.id).catch(() => {});
			await deleteGoal(teamGoal.id, true).catch(() => {});
			await deleteGoal(otherGoal.id, true).catch(() => {});
		}
	});
});
