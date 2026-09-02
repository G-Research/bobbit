/** Goal-proposal error, persistence, editing, and recovery journeys. */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus } from "../../support/helpers/browser/journeys/journey-fixture.js";
import { createSessionViaUI, sendMessage } from "../../support/helpers/browser/journeys/journey-fixture.js";
import { createGoalAssistantViaUI } from "../../support/helpers/browser/fixtures/ui-helpers.js";
import { authenticateMockProposalTools } from "../../support/helpers/browser/journeys/proposal-helpers.js";

test.describe("Journey: Proposals — API error handling", () => {
	// Also ports the preserve-assistant + retry contract from
	// goal-accept-failure-keeps-assistant.spec.ts (audit: project-settings GAP):
	// on a 400 the assistant stays mounted (title + session route unchanged) and
	// a second Create re-issues the POST.
	test("createGoal 400 shows server error in error modal (page.route stub)", async ({ page }) => {
		test.setTimeout(90_000);
		let postAttempts = 0;
		await page.route("**/api/goals", async (route) => {
			if (route.request().method() !== "POST") return route.continue();
			postAttempts++;
			await route.fulfill({
				status: 400,
				contentType: "application/json",
				body: JSON.stringify({
					error: "Journey test: missing title",
					stack: "Error: Journey test: missing title\n    at goalManager.create (server.ts:1:1)",
				}),
			});
		});
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "STAY_BUSY:propose_goal:4:80");
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 15_000 });
		const badge = page.locator('[data-testid="proposal-streaming-badge"]').first();
		await expect(badge).toBeHidden({ timeout: 20_000 });
		const createBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
		if (await createBtn.isVisible({ timeout: 15_000 }).catch(() => false)) {
			await createBtn.click();
			const errorMsg = page.locator('[data-testid="error-details-message"]').first();
			await expect(errorMsg).toHaveText("Journey test: missing title", { timeout: 20_000 });
			const bodyText = await page.locator("body").innerText();
			expect(bodyText).not.toContain("Failed to create goal: 400");
			await expect.poll(() => postAttempts, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

			// Preserve contract: the assistant panel stays mounted and the session
			// route is unchanged after the failure.
			await expect(titleInput).toBeVisible();
			await expect(page).toHaveURL(/#\/session\//);

			// Retry contract: dismissing and clicking Create again re-issues the POST.
			const okBtn = page.locator("button").filter({ hasText: "OK" }).first();
			if (await okBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
				await okBtn.click();
				await expect(errorMsg).toBeHidden({ timeout: 5_000 });
				await createBtn.click();
				await expect.poll(() => postAttempts, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
			}
		} else {
			test.skip(true, "Create Goal button not present in this harness config");
		}
	});

	test("page.route() session list 500 still lets app load gracefully", async ({ page }) => {
		const sessionListRoute = /\/api\/sessions(?:\?.*)?$/;
		let failedRequestUrl: string | undefined;
		const failedListResponse = page.waitForResponse((response) => {
			const request = response.request();
			return request.method() === "GET"
				&& new URL(response.url()).pathname === "/api/sessions"
				&& response.status() === 500;
		});
		await page.route(sessionListRoute, async (route) => {
			const request = route.request();
			const pathname = new URL(request.url()).pathname;
			if (request.method() !== "GET" || pathname !== "/api/sessions" || failedRequestUrl) {
				return route.fallback();
			}
			failedRequestUrl = request.url();
			await route.fulfill({
				status: 500,
				contentType: "text/plain",
				body: "Internal Server Error",
			});
		});

		const appReady = openApp(page);
		const failedResponse = await failedListResponse;
		expect(failedResponse.url()).toBe(failedRequestUrl);
		await appReady;
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible();
		const mountedState = await page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return {
				appView: state?.appView,
				sessionsError: state?.sessionsError,
				sessionsGeneration: state?.sessionsGeneration,
				sessionsLoading: state?.sessionsLoading,
			};
		});
		expect(mountedState).toMatchObject({
			appView: "authenticated",
			sessionsError: "",
			sessionsLoading: false,
		});
		expect(mountedState.sessionsGeneration).toBeGreaterThanOrEqual(0);
	});

	// Keep the related goal-assistant proposal lifecycle in one session. Besides
	// preserving one continuous user journey, this avoids repeating expensive
	// assistant creation solely to inspect another projection of the same draft.
	test("goal assistant proposal survives navigation, editing and workflow changes, then stays dismissed after reload", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const initialSpecTail = "It validates the goal creation UI.";
		const editedSpecBody = "EDITED SPEC BODY for Mode A repro.";
		await openApp(page);
		await createGoalAssistantViaUI(page, { timeout: 60_000 });
		await authenticateMockProposalTools(page, gateway);
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 30_000 });
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		await expect(page.getByText("Goal Proposal").first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator('[data-testid="proposal-open-button"]').first()).toBeVisible({ timeout: 15_000 });
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
		const panel = page.locator('[data-panel="goal-proposal"]').first();
		await expect(panel).toBeVisible({ timeout: 15_000 });
		await expect.poll(
			() => page.evaluate(() => ((window as any).bobbitState?.previewSpec as string) ?? ""),
			{ timeout: 15_000 },
		).toContain(initialSpecTail);

		const getSpec = () => page.evaluate(() => {
			const cm = document.querySelector("commentable-markdown") as any;
			return (cm?.markdown as string) ?? "";
		});
		const originalSpec = await getSpec();
		expect(originalSpec.length, "proposal spec must be non-empty before nav").toBeGreaterThan(20);
		const sid = await page.evaluate(() => (window as any).bobbitState?.selectedSessionId as string);
		expect(sid).toBeTruthy();
		const otherSessionId = await createSession();
		try {
			await navigateToHash(page, `#/session/${otherSessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await navigateToHash(page, `#/session/${sid}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(panel).toBeVisible({ timeout: 15_000 });
			await expect.poll(getSpec, { timeout: 15_000, intervals: [500, 1000, 2000] }).toBe(originalSpec);
		} finally {
			await deleteSession(otherSessionId).catch(() => {});
		}

		const workflowTab = page.locator("[data-testid='goal-proposal-tab-workflow']").first();
		await workflowTab.click();
		await expect(page.locator("[data-testid='goal-proposal-workflow-select']").first()).toBeVisible({ timeout: 15_000 });
		const customise = page.locator("[data-testid='goal-proposal-workflow-customize']").first();
		await expect(customise).toBeVisible({ timeout: 15_000 });
		await expect(customise).toHaveText("Customise for this goal");
		await customise.click();
		const revert = page.locator("[data-testid='goal-proposal-workflow-reset']").first();
		await expect(revert).toBeVisible({ timeout: 15_000 });
		await expect(revert).toHaveText("Revert to project definition");
		await expect(customise).toHaveCount(0);
		await revert.click();
		await expect(customise).toBeVisible({ timeout: 15_000 });
		await expect(revert).toHaveCount(0);

		await sendMessage(page, "Apply GOAL_EDITABLE_EDIT to the spec");
		await page.waitForFunction(
			(needle: string) => (((window as any).bobbitState?.activeProposals?.goal?.fields?.spec as string) ?? "").includes(needle),
			editedSpecBody,
			{ timeout: 20_000 },
		);
		await expect.poll(
			() => page.evaluate(() => ((window as any).bobbitState?.previewSpec as string) ?? ""),
			{ timeout: 15_000 },
		).toContain(editedSpecBody);
		expect(await page.evaluate(() => ((window as any).bobbitState?.previewSpec as string) ?? "")).not.toContain(initialSpecTail);
		await waitForSessionStatus(sid, "idle");
		await page.waitForFunction(async (sidArg: string) => {
			const url = (localStorage.getItem("gateway.url") ?? location.origin).replace(/\/$/, "");
			const token = localStorage.getItem("gateway.token") ?? "";
			const response = await fetch(`${url}/api/sessions/${sidArg}/draft?type=goal`, { headers: { Authorization: `Bearer ${token}` } });
			if (!response.ok) return false;
			const draft = (await response.json())?.data?.activeGoalProposal;
			return draft?.title === "E2E Test Goal" && String(draft?.spec ?? "").includes("EDITED SPEC BODY for Mode A repro.");
		}, sid, { timeout: 15_000 });
		const goalTab = page.locator('.goal-tab-pill[title="Goal"]').first();
		await expect(goalTab).toBeVisible();
		await goalTab.click();
		await expect(panel).toBeVisible();
		const proposalDelete = page.waitForResponse((response) => {
			const pathname = new URL(response.url()).pathname;
			return response.request().method() === "DELETE"
				&& pathname === `/api/sessions/${encodeURIComponent(sid)}/proposal/goal`;
		});
		const dismissButton = goalTab.getByRole("button", { name: "Dismiss Goal" });
		await expect(dismissButton).toBeVisible();
		await expect(dismissButton).toBeEnabled();
		await dismissButton.click();
		const deleteResponse = await proposalDelete;
		expect(deleteResponse.status()).toBe(204);
		const dismissalFingerprint = await page.evaluate(
			(sidArg: string) => localStorage.getItem(`bobbit-goal-proposal-dismissed-${sidArg}`),
			sid,
		);
		expect(dismissalFingerprint, "the real Dismiss action must persist its proposal fingerprint").toBeTruthy();
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.activeProposals?.goal ?? null),
		).toBeNull();
		await expect(titleInput).toBeHidden();
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await page.waitForFunction((sidArg: string) => (window as any).bobbitState?.selectedSessionId === sidArg, sid, { timeout: 15_000 });
		await expect.poll(() => page.evaluate(({ sidArg, fingerprint }) => {
			const state = (window as any).bobbitState;
			return state?.selectedSessionId === sidArg
				&& !state.activeProposals?.goal
				&& state.previewTitle === ""
				&& localStorage.getItem(`bobbit-goal-proposal-dismissed-${sidArg}`) === fingerprint;
		}, { sidArg: sid, fingerprint: dismissalFingerprint })).toBe(true);
		const titleAfterReload = page.locator("input[placeholder='Goal title']").first();
		await expect(titleAfterReload).toBeHidden({ timeout: 10_000 });
		expect(await page.evaluate(() => (window as any).bobbitState?.activeProposals?.goal ?? null)).toBeNull();
	});
});

// Ported from failed-goal-proposal-ux.spec.ts (audit: proposals GAP): a
// MISSING_WORKFLOW failed proposal surfaces the workflow-error row.
test.describe("Journey: Failed Goal Proposal", () => {
	test("MISSING_WORKFLOW surfaces the goal-proposal-workflow-error row", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createSessionViaUI(page);
		await authenticateMockProposalTools(page, gateway);
		await sendMessage(page, "Please run GOAL_PROPOSAL_MISSING_WORKFLOW now");
		const workflowError = page.locator('[data-testid="goal-proposal-workflow-error"]').first();
		await expect(workflowError).toBeVisible({ timeout: 20_000 });
		await expect(workflowError).toContainText(/Workflow is required/i, { timeout: 10_000 });
	});

	test("CWD_OUTSIDE_PROJECT renders an actionable failed card and corrected resubmission revision", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createSessionViaUI(page);
		await authenticateMockProposalTools(page, gateway);
		await sendMessage(page, "Please run GOAL_PROPOSAL_OUTSIDE_CWD now");

		const failedCard = page.locator('[data-testid="proposal-failed-card"]').filter({ hasText: "Outside Cwd Goal" }).first();
		await expect(failedCard).toBeVisible({ timeout: 20_000 });
		const errorMessage = failedCard.locator('[data-testid="proposal-error-message"]');
		await expect(errorMessage).toContainText(/cwd must be inside .+/i);
		await expect(failedCard.locator('[data-testid="proposal-rev"]')).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			const messages = state?.remoteAgent?.state?.messages ?? [];
			const failed = [...messages].reverse().find((message: any) =>
				message?.role === "toolResult" && message?.toolName === "propose_goal"
					&& (message?.content ?? []).some((part: any) => String(part?.text ?? "").includes("CWD_OUTSIDE_PROJECT")),
			);
			const text = (failed?.content ?? []).map((part: any) => part?.text ?? "").join("\n");
			try { return JSON.parse(text)?.code; } catch { return undefined; }
		}), { timeout: 20_000 }).toBe("CWD_OUTSIDE_PROJECT");

		await sendMessage(page, "Please run GOAL_PROPOSAL_FIXED_CWD now");
		await expect(page.getByText("Corrected Cwd Goal").first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator('[data-testid="proposal-failed-card"]')).toHaveCount(1);
		await expect(page.locator('[data-testid="proposal-rev"]').last()).toHaveText(/^rev \d+$/, { timeout: 20_000 });
	});
});
