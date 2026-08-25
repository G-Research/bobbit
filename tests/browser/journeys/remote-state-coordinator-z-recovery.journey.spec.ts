import {
	advanceRemote,
	clientJson,
	setVisible,
	startRemoteStateScenario,
	widgetState,
	type RemoteStateScenario,
	type SnapshotState,
} from "./remote-state-coordinator.fixture.js";
import { expect, test } from "../../../tests2/browser/_helpers/journey-fixture.js";

/**
 * Covers last-good failure handling, dual-client recovery, late REST ordering,
 * and reload hydration. The cold/cadence assertions remain in the sibling
 * coordinator journey; this fixture replays those deterministic transitions as
 * prerequisites without putting both assertion sets under one file budget.
 */
test.describe("Journey: remote-state coordinator recovery", () => {
	test("retains safe last-good state and rejects late regressions across two clients", async ({ page, context, gateway }) => {
		test.setTimeout(59_000);
		let scenario: RemoteStateScenario | undefined;
		try {
			scenario = await startRemoteStateScenario({ page, context, gateway, label: "browser-recovery" });
			const {
				fixture,
				goalId,
				sessionId,
				sessionPage,
				dashboardWidget,
				sessionWidget,
				dashboardGoalRow,
				sessionGoalRow,
				gitStatusRequests,
				prStatusRequests,
			} = scenario;

			// Recreate the cadence journey's authoritative state at its split point.
			await expect.poll(() => scenario!.gitFetches(), { timeout: 10_000 }).toBe(1);
			await expect.poll(() => scenario!.prReads(), { timeout: 10_000 }).toBe(1);
			scenario.releaseHeldGitFetch();
			scenario.releaseHeldPrRead();
			await expect.poll(() => widgetState(dashboardWidget), { timeout: 10_000 }).toMatchObject({ branch: "master", prState: "OPEN" });
			await expect.poll(() => widgetState(sessionWidget), { timeout: 10_000 }).toMatchObject({ branch: "master", prState: "OPEN" });

			scenario.advanceNow(20_000);
			await Promise.all([
				clientJson(page, `/api/goals/${goalId}/pr-status?optional=1&intent=visible`),
				clientJson(sessionPage, `/api/sessions/${sessionId}/pr-status?optional=1&intent=visible`),
			]);
			await expect.poll(() => scenario!.prReads(), { timeout: 5_000 }).toBe(2);
			scenario.advanceNow(60_000);
			await Promise.all([
				clientJson(page, `/api/goals/${goalId}/pr-status?optional=1&intent=sidebar`),
				clientJson(sessionPage, `/api/goals/${goalId}/pr-status?optional=1&intent=sidebar`),
			]);
			await expect.poll(() => scenario!.prReads(), { timeout: 5_000 }).toBe(3);

			// The session's next automatic tick survives the initial cold envelope.
			// It starts one eligible canonical fetch and updates both closed widgets;
			// no visibility event or dropdown interaction is needed.
			advanceRemote(fixture.peer);
			await expect(page.locator("#git-status-dropdown")).toHaveCount(0);
			await expect(sessionPage.locator("#git-status-dropdown")).toHaveCount(0);
			const automaticReadsBeforeTick = gitStatusRequests.filter((url) => url.includes("intent=automatic")).length;
			scenario.holdNextGitFetch();
			await sessionPage.clock.fastForward(30_000);
			await expect.poll(
				() => gitStatusRequests.filter((url) => url.includes("intent=automatic")).length,
				{ timeout: 5_000 },
			).toBeGreaterThan(automaticReadsBeforeTick);
			await expect.poll(() => scenario!.gitFetches(), { timeout: 10_000 }).toBe(2);
			scenario.releaseHeldGitFetch();
			await expect.poll(() => widgetState(dashboardWidget), { timeout: 10_000 }).toMatchObject({ behind: 1 });
			await expect.poll(() => widgetState(sessionWidget), { timeout: 10_000 }).toMatchObject({ behind: 1 });
			await expect(page.locator("#git-status-dropdown")).toHaveCount(0);
			await expect(sessionPage.locator("#git-status-dropdown")).toHaveCount(0);

			// A repository-only failure must not be hidden by the healthy PR record.
			// Both clients retain refs and target one canonical explicit Git recovery.
			scenario.advanceNow(30_000);
			scenario.setFailGitFetches(true);
			const fetchesBeforeGitFailure = scenario.gitFetches();
			await Promise.all([
				clientJson(page, `/api/goals/${goalId}/git-status?intent=visible`),
				clientJson(sessionPage, `/api/sessions/${sessionId}/git-status?intent=visible`),
			]);
			await expect.poll(() => scenario!.gitFetches(), { timeout: 10_000 }).toBe(fetchesBeforeGitFailure + 1);
			for (const widget of [dashboardWidget, sessionWidget]) {
				await expect.poll(() => widgetState(widget), { timeout: 10_000 }).toMatchObject({
					behind: 1,
					gitSnapshot: { stale: true, ageMs: 30_000, lastError: "offline", source: "repository" },
					prSnapshot: { stale: false, source: "pr" },
				});
			}
			await dashboardWidget.locator("button").first().click();
			await sessionWidget.locator("button").first().click();
			const dashboardGitFailure = page.locator('#git-status-dropdown [data-testid="remote-state-status"][data-remote-resource="git"]');
			const sessionGitFailure = sessionPage.locator('#git-status-dropdown [data-testid="remote-state-status"][data-remote-resource="git"]');
			await expect(dashboardGitFailure).toContainText("Remote refs offline; showing last known state (30s ago).");
			await expect(sessionGitFailure).toContainText("Remote refs offline; showing last known state (30s ago).");

			scenario.setFailGitFetches(false);
			scenario.holdNextGitFetch();
			const fetchesBeforeGitRecovery = scenario.gitFetches();
			const explicitGitRequestsBeforeRecovery = gitStatusRequests.filter((url) => url.includes("intent=explicit")).length;
			await Promise.all([
				dashboardGitFailure.getByRole("button", { name: "Refresh" }).click(),
				sessionGitFailure.getByRole("button", { name: "Refresh" }).click(),
			]);
			await expect.poll(
				() => gitStatusRequests.filter((url) => url.includes("intent=explicit")).length,
				{ timeout: 5_000 },
			).toBeGreaterThan(explicitGitRequestsBeforeRecovery);
			await expect.poll(() => scenario!.gitFetches(), { timeout: 10_000 }).toBe(fetchesBeforeGitRecovery + 1);
			expect(scenario.gitFetches()).toBe(fetchesBeforeGitRecovery + 1);
			scenario.releaseHeldGitFetch();
			for (const widget of [dashboardWidget, sessionWidget]) {
				await expect.poll(() => widgetState(widget), { timeout: 10_000 }).toMatchObject({
					behind: 1,
					gitSnapshot: { stale: false, ageMs: 0, source: "repository" },
					prSnapshot: { stale: false, source: "pr" },
				});
			}
			await dashboardWidget.locator("button").first().click();
			await sessionWidget.locator("button").first().click();
			await expect(page.locator("#git-status-dropdown")).toHaveCount(0);
			await expect(sessionPage.locator("#git-status-dropdown")).toHaveCount(0);

			// A real fixture failure after last-good retains the PR everywhere, exposes
			// only the safe error category/age, and offers an explicit refresh.
			scenario.advanceNow(20_000);
			scenario.setFailPrReads(true);
			await Promise.all([setVisible(page), setVisible(sessionPage)]);
			await expect.poll(() => scenario!.prReads(), { timeout: 10_000 }).toBe(4);
			await expect.poll(() => widgetState(dashboardWidget), { timeout: 10_000 }).toMatchObject({
				prState: "OPEN",
				prNumber: 42,
				prTitle: "Coordinator fixture PR",
				stale: true,
				ageMs: 50_000,
				lastError: "offline",
				source: "pr",
			});
			await expect.poll(() => widgetState(sessionWidget), { timeout: 10_000 }).toMatchObject({
				prState: "OPEN",
				prNumber: 42,
				stale: true,
				ageMs: 50_000,
				lastError: "offline",
				source: "pr",
			});
			await expect(dashboardGoalRow.locator('a[title*="remote offline; showing last known state"]')).toBeVisible();
			const safeFailure = await clientJson(page, `/api/goals/${goalId}/pr-status?optional=1&intent=visible`);
			expect(safeFailure.status).toBe(200);
			expect(safeFailure.body).toMatchObject({ stale: true, lastError: "offline", ageMs: 50_000, source: "pr" });
			expect(JSON.stringify(safeFailure.body)).not.toContain("fixture-offline-private-detail");
			expect(JSON.stringify(safeFailure.body)).not.toContain("secret@example.test");

			await dashboardWidget.locator("button").first().click();
			await sessionWidget.locator("button").first().click();
			const dashboardRemoteStatus = page.locator('#git-status-dropdown [data-testid="remote-state-status"]');
			const sessionRemoteStatus = sessionPage.locator('#git-status-dropdown [data-testid="remote-state-status"]');
			await expect(dashboardRemoteStatus).toContainText("PR status offline; showing last known state (50s ago).");
			await expect(sessionRemoteStatus).toContainText("PR status offline; showing last known state (50s ago).");

			// Both visible Refresh buttons force the same canonical PR concurrently.
			// Holding the injected PR read proves the second client joins in-flight work.
			scenario.setFailPrReads(false);
			scenario.setPrTitle("Recovered coordinator PR");
			scenario.setReviewDecision("APPROVED");
			scenario.holdNextPrRead();
			const explicitPrRequestsBeforeRecovery = prStatusRequests.filter((url) => url.includes("intent=explicit")).length;
			// Dispatch both already-visible controls without Playwright's cross-page
			// actionability retries, which can serialize the requests beyond the
			// coordinator's 250ms explicit-refresh burst window.
			const dashboardRefresh = dashboardRemoteStatus.getByRole("button", { name: "Refresh" });
			const sessionRefresh = sessionRemoteStatus.getByRole("button", { name: "Refresh" });
			await Promise.all([
				expect(dashboardRefresh).toBeVisible(),
				expect(dashboardRefresh).toBeEnabled(),
				expect(sessionRefresh).toBeVisible(),
				expect(sessionRefresh).toBeEnabled(),
			]);
			await Promise.all([
				dashboardRefresh.dispatchEvent("click"),
				sessionRefresh.dispatchEvent("click"),
			]);
			await expect.poll(
				() => prStatusRequests.filter((url) => url.includes("intent=explicit")).length,
				{ timeout: 5_000 },
			).toBeGreaterThanOrEqual(explicitPrRequestsBeforeRecovery + 2);
			await expect.poll(() => scenario!.prReads(), { timeout: 10_000 }).toBe(5);
			expect(scenario.prReads()).toBe(5);
			scenario.releaseHeldPrRead();
			await expect.poll(() => widgetState(dashboardWidget), { timeout: 10_000 }).toMatchObject({
				prTitle: "Recovered coordinator PR",
				stale: false,
				ageMs: 0,
				lastError: undefined,
				source: "pr",
			});
			await expect.poll(() => widgetState(sessionWidget), { timeout: 10_000 }).toMatchObject({
				prTitle: "Recovered coordinator PR",
				stale: false,
				ageMs: 0,
				lastError: undefined,
				source: "pr",
			});
			await expect(dashboardGoalRow.locator('a[title*="approved"]')).toBeVisible();
			await expect(sessionGoalRow.locator('a[title*="approved"]')).toBeVisible();

			// Deterministically retain an older SWR REST envelope in the browser while
			// its background refresh completes and broadcasts a newer snapshot. The
			// late response must not regress dashboard or shared sidebar metadata.
			scenario.advanceNow(20_000);
			scenario.setPrTitle("Completion wins over late REST");
			scenario.holdNextPrRead();
			let releaseOlderRest!: () => void;
			const olderRestRelease = new Promise<void>((resolve) => { releaseOlderRest = resolve; });
			let captureOlderRest!: (snapshot: SnapshotState) => void;
			const olderRestCaptured = new Promise<SnapshotState>((resolve) => { captureOlderRest = resolve; });
			let interceptedOlderRest = false;
			const prRoute = `**/api/goals/${goalId}/pr-status*`;
			await page.route(prRoute, async (route) => {
				if (interceptedOlderRest || !route.request().url().includes("intent=visible")) {
					await route.continue();
					return;
				}
				interceptedOlderRest = true;
				const response = await route.fetch();
				const body = await response.text();
				captureOlderRest(JSON.parse(body) as SnapshotState);
				await olderRestRelease;
				await route.fulfill({ response, body });
			});

			await setVisible(page);
			const olderRestSnapshot = await olderRestCaptured;
			expect(olderRestSnapshot).toMatchObject({
				stale: true,
				ageMs: 20_000,
			});
			expect(olderRestSnapshot.lastError).toBeUndefined();
			await expect.poll(() => scenario!.prReads(), { timeout: 5_000 }).toBe(6);
			scenario.releaseHeldPrRead();
			await expect.poll(() => widgetState(dashboardWidget), { timeout: 10_000 }).toMatchObject({
				prTitle: "Completion wins over late REST",
				prSnapshot: { stale: false, ageMs: 0, source: "pr" },
			});
			await expect.poll(() => widgetState(sessionWidget), { timeout: 10_000 }).toMatchObject({
				prTitle: "Completion wins over late REST",
				prSnapshot: { stale: false, ageMs: 0, source: "pr" },
			});
			const completionSnapshot = (await widgetState(dashboardWidget)).prSnapshot!;
			expect(completionSnapshot.lastError).toBeUndefined();
			expect((await widgetState(sessionWidget)).prSnapshot?.lastError).toBeUndefined();
			expect(completionSnapshot.refreshedAt).toBe(scenario.now());

			releaseOlderRest();
			await expect.poll(() => widgetState(dashboardWidget), { timeout: 5_000 }).toMatchObject({
				prTitle: "Completion wins over late REST",
				prSnapshot: {
					stale: false,
					ageMs: 0,
					refreshedAt: completionSnapshot.refreshedAt,
				},
			});
			expect((await widgetState(dashboardWidget)).prSnapshot?.lastError).toBeUndefined();
			await expect(dashboardGoalRow.locator('a[title*="remote stale"]')).toHaveCount(0);
			await expect(dashboardGoalRow.locator('a[title*="remote offline"]')).toHaveCount(0);
			await page.unroute(prRoute);

			// Reload hydrates the same last-good snapshot into both clients without
			// adding an external read while the canonical record is fresh. Refresh the
			// independent Git record before measuring reload so the PR clock advances
			// above cannot make Git eligibility depend on timer ordering.
			await clientJson(page, `/api/goals/${goalId}/git-status?intent=explicit`);
			const readsBeforeReload = scenario.prReads();
			const fetchesBeforeReload = scenario.gitFetches();
			await Promise.all([page.reload(), sessionPage.reload()]);
			const reloadedDashboardWidget = page.locator(".dashboard-git-row git-status-widget").first();
			const reloadedSessionWidget = sessionPage.locator("pi-chat-panel git-status-widget").first();
			await expect(reloadedDashboardWidget).toBeAttached({ timeout: 15_000 });
			await expect(reloadedSessionWidget).toBeAttached({ timeout: 15_000 });
			await expect.poll(() => widgetState(reloadedDashboardWidget), { timeout: 10_000 }).toMatchObject({
				behind: 1,
				prState: "OPEN",
				prNumber: 42,
				prTitle: "Completion wins over late REST",
				stale: false,
				lastError: undefined,
			});
			await expect.poll(() => widgetState(reloadedSessionWidget), { timeout: 10_000 }).toMatchObject({
				behind: 1,
				prState: "OPEN",
				prNumber: 42,
				prTitle: "Completion wins over late REST",
				stale: false,
				lastError: undefined,
			});
			expect(scenario.prReads()).toBe(readsBeforeReload);
			expect(scenario.gitFetches()).toBe(fetchesBeforeReload);
			await expect(page.locator(`[data-nav-id="goal:${goalId}"] a[title*="approved"]`).first()).toBeVisible();
			await expect(sessionPage.locator(`[data-nav-id="goal:${goalId}"] a[title*="approved"]`).first()).toBeVisible();
		} finally {
			await scenario?.cleanup();
		}
	});
});
