import {
	clientJson,
	startRemoteStateScenario,
	widgetState,
	type RemoteStateScenario,
} from "./remote-state-coordinator.fixture.js";
import { expect, test } from "../../../tests2/browser/_helpers/journey-fixture.js";

/**
 * Covers cold coordination, independent freshness cadences, and automatic Git
 * propagation. Failure/recovery and late-envelope behavior live in the sibling
 * recovery journey so each registered file stays below the browser-v2 budget.
 */
test.describe("Journey: remote-state coordinator cadence", () => {
	test("keeps two clients and every active surface on one canonical Git and PR snapshot", async ({ page, context, gateway }) => {
		test.setTimeout(59_000);
		let scenario: RemoteStateScenario | undefined;
		try {
			scenario = await startRemoteStateScenario({ page, context, gateway, label: "browser-cadence" });
			const {
				goalId,
				sessionId,
				sessionPage,
				dashboardWidget,
				sessionWidget,
				dashboardGoalRow,
				sessionGoalRow,
			} = scenario;

			await expect.poll(() => scenario!.gitFetches(), { timeout: 10_000 }).toBe(1);
			await expect.poll(() => scenario!.prReads(), { timeout: 10_000 }).toBe(1);
			// The targeted session read observes a cold Git envelope while the
			// dashboard owns the in-flight canonical refresh. The client must not
			// classify that metadata-only envelope as an empty/hidden repository.
			expect(scenario.coldSessionGitReads()).toBeGreaterThan(0);
			await expect.poll(() => widgetState(sessionWidget)).toMatchObject({
				branch: "",
				loading: true,
				gitSnapshot: { stale: true, source: "repository" },
			});

			scenario.releaseHeldGitFetch();
			await expect.poll(() => widgetState(dashboardWidget), { timeout: 10_000 }).toMatchObject({ branch: "master", loading: false });
			await expect.poll(() => widgetState(sessionWidget), { timeout: 10_000 }).toMatchObject({ branch: "master", loading: false });

			scenario.releaseHeldPrRead();
			await expect.poll(() => widgetState(dashboardWidget), { timeout: 10_000 }).toMatchObject({
				branch: "master",
				behind: 0,
				prState: "OPEN",
				prNumber: 42,
				prTitle: "Coordinator fixture PR",
				stale: false,
				lastError: undefined,
				source: "pr",
			});
			await expect.poll(() => widgetState(sessionWidget), { timeout: 10_000 }).toMatchObject({
				branch: "master",
				behind: 0,
				prState: "OPEN",
				prNumber: 42,
				prTitle: "Coordinator fixture PR",
				stale: false,
				lastError: undefined,
				source: "pr",
			});
			await expect(dashboardGoalRow.locator('a[title^="PR #42 open"]')).toBeVisible();
			await expect(sessionGoalRow.locator('a[title^="PR #42 open"]')).toBeVisible();

			// Healthy freshness is compact header metadata, not a full-width footer.
			await dashboardWidget.locator("button").first().click();
			await sessionWidget.locator("button").first().click();
			for (const client of [page, sessionPage]) {
				const dropdown = client.locator("#git-status-dropdown");
				await expect(dropdown.locator('[data-testid="remote-state-freshness-chip"]')).toContainText("PR status refreshed");
				await expect(dropdown.locator('[data-testid="remote-state-status"]')).toHaveCount(0);
			}
			await dashboardWidget.locator("button").first().click();
			await sessionWidget.locator("button").first().click();

			// The server clock is deterministic: active demand becomes eligible at 20s,
			// while sidebar-only demand stays on its independent 60s cadence.
			scenario.advanceNow(19_999);
			await Promise.all([
				clientJson(page, `/api/goals/${goalId}/pr-status?optional=1&intent=visible`),
				clientJson(sessionPage, `/api/goals/${goalId}/pr-status?optional=1&intent=sidebar`),
			]);
			expect(scenario.prReads()).toBe(1);
			scenario.advanceNow(1);
			await Promise.all([
				clientJson(page, `/api/goals/${goalId}/pr-status?optional=1&intent=visible`),
				clientJson(sessionPage, `/api/sessions/${sessionId}/pr-status?optional=1&intent=visible`),
				clientJson(page, `/api/goals/${goalId}/pr-status?optional=1&intent=sidebar`),
			]);
			await expect.poll(() => scenario!.prReads(), { timeout: 5_000 }).toBe(2);

			scenario.advanceNow(59_999);
			await Promise.all([
				clientJson(page, `/api/goals/${goalId}/pr-status?optional=1&intent=sidebar`),
				clientJson(sessionPage, `/api/goals/${goalId}/pr-status?optional=1&intent=sidebar`),
			]);
			expect(scenario.prReads()).toBe(2);
			scenario.advanceNow(1);
			await Promise.all([
				clientJson(page, `/api/goals/${goalId}/pr-status?optional=1&intent=sidebar`),
				clientJson(sessionPage, `/api/goals/${goalId}/pr-status?optional=1&intent=sidebar`),
			]);
			await expect.poll(() => scenario!.prReads(), { timeout: 5_000 }).toBe(3);

		} finally {
			await scenario?.cleanup();
		}
	});
});
