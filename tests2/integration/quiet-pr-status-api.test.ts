import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession, nonGitCwd } from "./_e2e/e2e-setup.js";

type QuietPrGoal = { id: string; branch: string; cwd: string; worktreePath: string; projectId?: string };

async function cleanupGoal(goal: QuietPrGoal | undefined): Promise<void> {
	if (goal) await deleteGoal(goal.id).catch(() => {});
}

async function expectEmptyNoContent(resp: Response, label: string): Promise<void> {
	expect(resp.status, `${label} should return 204 No Content`).toBe(204);
	expect(await resp.text(), `${label} 204 response must have no body`).toBe("");
}

async function createGoalWithNoPrBranch(gateway: any): Promise<QuietPrGoal> {
	const cwd = nonGitCwd();
	const goal = await createGoal({
		title: `quiet pr-status no-pr ${Date.now()}`,
		cwd,
		worktree: false,
		autoStartTeam: false,
		spec: "Route fixture for quiet optional PR status probes with no matching GitHub PR.",
	});
	const branch = "feature/no-pr";
	const goalStore = gateway.sessionManager.getGoalStoreForProject(goal.projectId);
	// PR-status routing only requires branch/worktree metadata and an existing cwd.
	// Seed that decision boundary directly; worktree provisioning has dedicated tests.
	goalStore.update(goal.id, { branch, cwd, repoPath: cwd, worktreePath: cwd, setupStatus: "ready" });
	return { id: goal.id, branch, cwd, worktreePath: cwd, projectId: goal.projectId };
}

test.describe("quiet optional PR status probes", () => {
	test("keeps bare session PR absence as 404 but returns empty 204 in optional mode", async ({ gateway }) => {
		let goal: QuietPrGoal | undefined;
		let sessionId: string | undefined;
		try {
			goal = await createGoalWithNoPrBranch(gateway);
			sessionId = await createSession({ goalId: goal.id, cwd: goal.cwd, projectId: goal.projectId });

			const bareResp = await apiFetch(`/api/sessions/${sessionId}/pr-status`);
			expect(bareResp.status, "bare session PR-status absence should remain 404").toBe(404);

			const optionalResp = await apiFetch(`/api/sessions/${sessionId}/pr-status?optional=1`);
			await expectEmptyNoContent(optionalResp, "quiet optional session PR-status absence");
		} finally {
			if (sessionId) await deleteSession(sessionId);
			await cleanupGoal(goal);
		}
	});

	test("returns 404 for a missing session even in optional PR-status mode", async () => {
		const resp = await apiFetch("/api/sessions/no-such-session/pr-status?optional=1");
		expect(resp.status, "missing session should remain 404 even for quiet PR-status probes").toBe(404);
	});

	test("keeps bare goal PR absence as 404 but returns empty 204 in optional mode", async ({ gateway }) => {
		let goal: QuietPrGoal | undefined;
		try {
			goal = await createGoalWithNoPrBranch(gateway);
			const bareResp = await apiFetch(`/api/goals/${goal.id}/pr-status`);
			expect(bareResp.status, "bare goal PR-status absence should remain 404").toBe(404);

			const optionalResp = await apiFetch(`/api/goals/${goal.id}/pr-status?optional=1`);
			await expectEmptyNoContent(optionalResp, "quiet optional goal PR-status absence");
		} finally {
			await cleanupGoal(goal);
		}
	});

	test("returns 404 for a missing goal even in optional PR-status mode", async () => {
		const resp = await apiFetch("/api/goals/no-such-goal/pr-status?optional=1");
		expect(resp.status, "missing goal should remain 404 even for quiet PR-status probes").toBe(404);
	});
});
