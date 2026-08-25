import { test, expect, apiFetch, createGoal, deleteGoal, openApp, navigateToHash, waitForSessionStatus } from "../_helpers/journey-fixture.js";
import { teardownTeam } from "../_helpers/e2e-setup.js";

const teamStartPath = (goalId: string) => new RegExp(`/api/goals/${goalId}/team/start(?:\\?.*)?$`);
const serverStack = "GoalPausedError: paused goal is paused — spawn rejected\n    at TeamManager._startTeamImpl (team-manager.ts:1874:27)";

async function pauseGoal(goalId: string): Promise<void> {
	const response = await apiFetch(`/api/goals/${goalId}/pause`, {
		method: "POST",
		body: JSON.stringify({ cascade: false }),
	});
	expect(response.status).toBe(200);
}

async function createPausedManualTeamGoal(label: string): Promise<{ id: string }> {
	const goal = await createGoal({
		title: `Paused Start Team UI ${label} ${Date.now()}`,
		team: true,
		autoStartTeam: false,
		worktree: false,
	});
	await pauseGoal(goal.id as string);
	return { id: goal.id as string };
}

async function expectResumedGoalAndLead(page: any, goalId: string, leadId: string): Promise<void> {
	await page.waitForFunction(
		({ goalId: expectedGoalId, leadId: expectedLeadId }: { goalId: string; leadId: string }) => {
			const appState = (window as any).__bobbitState;
			return appState?.goals?.some((goal: any) => goal.id === expectedGoalId && goal.paused !== true)
				&& appState?.gatewaySessions?.some((session: any) => session.id === expectedLeadId && session.teamGoalId === expectedGoalId);
		},
		{ goalId, leadId },
		{ timeout: 20_000 },
	);
	await expect(page.locator(`[data-session-id="${leadId}"]`).first()).toBeVisible({ timeout: 20_000 });
	await expect(page).toHaveURL(new RegExp(`#/session/${leadId}$`), { timeout: 20_000 });
	await expect(page.locator("message-editor textarea, textarea").first()).toBeVisible({ timeout: 20_000 });
}

test.describe("Paused goal Start Team journey", () => {
	test("starts a paused goal once, shows loading, and updates the resumed goal and team lead without reload", async ({ page }) => {
		test.setTimeout(90_000);
		const goal = await createPausedManualTeamGoal("success");
		let teamStartPosts = 0;
		let leadId = "";
		let releaseStart: (() => void) | undefined;
		const startReleased = new Promise<void>((resolve) => { releaseStart = resolve; });

		try {
			await page.route(teamStartPath(goal.id), async (route) => {
				teamStartPosts++;
				await startReleased;
				const response = await route.fetch();
				const body = await response.json() as { sessionId?: string };
				leadId = body.sessionId ?? "";
				await route.fulfill({ response });
			});

			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			const startButton = page.getByRole("button", { name: "Start Team", exact: true });
			await expect(startButton).toBeVisible({ timeout: 20_000 });

			await startButton.click();
			const startingButton = page.getByRole("button", { name: "Starting…", exact: true });
			await expect(startingButton).toBeVisible();
			await expect(startingButton).toBeDisabled();
			await expect.poll(() => teamStartPosts).toBe(1);

			releaseStart?.();
			await expect.poll(() => leadId).not.toBe("");
			await expectResumedGoalAndLead(page, goal.id, leadId);
			expect(teamStartPosts).toBe(1);
			await waitForSessionStatus(leadId, "idle");
		} finally {
			releaseStart?.();
			await teardownTeam(goal.id);
			await deleteGoal(goal.id);
		}
	});

	test("shows a concise stack-free failure and allows retrying Start Team", async ({ page }) => {
		test.setTimeout(90_000);
		const goal = await createPausedManualTeamGoal("retry");
		let teamStartPosts = 0;
		let leadId = "";

		try {
			await page.route(teamStartPath(goal.id), async (route) => {
				teamStartPosts++;
				if (teamStartPosts === 1) {
					await route.fulfill({
						status: 409,
						contentType: "application/json",
						body: JSON.stringify({ error: serverStack, code: "GOAL_PAUSED", stack: serverStack }),
					});
					return;
				}
				const response = await route.fetch();
				const body = await response.json() as { sessionId?: string };
				leadId = body.sessionId ?? "";
				await route.fulfill({ response });
			});

			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			const startButton = page.getByRole("button", { name: "Start Team", exact: true });
			await expect(startButton).toBeVisible({ timeout: 20_000 });

			await startButton.click();
			await expect(page.locator('[data-testid="error-details-message"]')).toHaveText(
				"The goal could not be resumed automatically. Resume it, then try starting the team again.",
			);
			await expect(page.locator("body")).not.toContainText("GoalPausedError");
			await expect(page.locator("body")).not.toContainText("team-manager.ts");
			await page.getByRole("button", { name: "OK", exact: true }).click();

			await startButton.click();
			await expect.poll(() => teamStartPosts).toBe(2);
			await expect.poll(() => leadId).not.toBe("");
			await expectResumedGoalAndLead(page, goal.id, leadId);
			await waitForSessionStatus(leadId, "idle");
		} finally {
			await teardownTeam(goal.id);
			await deleteGoal(goal.id);
		}
	});
});
