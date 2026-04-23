/**
 * E2E tests for the auto-start team feature.
 *
 * When a goal is created with autoStartTeam: true (the default),
 * the server automatically calls teamManager.startTeam() after
 * worktree setup completes.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, gitCwd, deleteGoal } from "./e2e-setup.js";

/** Poll a goal until a predicate is met or timeout. */
async function pollGoal(
	goalId: string,
	predicate: (g: any) => boolean,
	timeoutMs = 30_000,
): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await apiFetch(`/api/goals/${goalId}`);
		const goal = await res.json();
		if (predicate(goal)) return goal;
		await new Promise(r => setTimeout(r, 100));
	}
	const res = await apiFetch(`/api/goals/${goalId}`);
	const goal = await res.json();
	throw new Error(
		`Poll timeout after ${timeoutMs}ms. setupStatus=${goal.setupStatus}, autoStartTeam=${goal.autoStartTeam}`,
	);
}

/** Poll until the team is started for a goal (team endpoint returns 200). */
async function pollTeamStarted(goalId: string, timeoutMs = 30_000): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await apiFetch(`/api/goals/${goalId}/team`);
		if (res.status === 200) {
			const team = await res.json();
			if (team.teamLeadSessionId) return team;
		}
		await new Promise(r => setTimeout(r, 100));
	}
	throw new Error(`Team not started for goal ${goalId} within ${timeoutMs}ms`);
}

/** Create a goal with gitCwd so worktree setup can succeed. */
async function createGoalForAutoStart(opts: Record<string, unknown> = {}): Promise<any> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `Auto-start test ${Date.now()}`,
			cwd: gitCwd(),
			...opts,
		}),
	});
	expect(resp.status).toBe(201);
	return resp.json();
}

test.describe("Auto-start team", () => {
	test("defaults to true and starts team automatically", async () => {
		const goal = await createGoalForAutoStart();
		try {
			// autoStartTeam should default to true
			expect(goal.autoStartTeam).toBe(true);

			// Poll until setup is ready AND team has been auto-started
			// (team start happens asynchronously after worktree setup)
			await pollGoal(goal.id, g => g.setupStatus === "ready");
			await pollTeamStarted(goal.id);
		} finally {
			// Teardown team then delete goal
			await apiFetch(`/api/goals/${goal.id}/team/teardown`, { method: "POST" }).catch(() => {});
			await deleteGoal(goal.id);
		}
	});

	test("explicit true starts team automatically", async () => {
		const goal = await createGoalForAutoStart({ autoStartTeam: true });
		try {
			expect(goal.autoStartTeam).toBe(true);

			await pollGoal(goal.id, g => g.setupStatus === "ready");
			await pollTeamStarted(goal.id);
		} finally {
			await apiFetch(`/api/goals/${goal.id}/team/teardown`, { method: "POST" }).catch(() => {});
			await deleteGoal(goal.id);
		}
	});

	test("false skips team start, manual start works", async () => {
		const goal = await createGoalForAutoStart({ autoStartTeam: false });
		try {
			expect(goal.autoStartTeam).toBe(false);

			// Wait for worktree setup to complete
			await pollGoal(goal.id, g => g.setupStatus === "ready");

			// Team should NOT have been started
			const teamRes = await apiFetch(`/api/goals/${goal.id}/team`);
			expect(teamRes.status).toBe(404);

			// Manual start should work
			const startRes = await apiFetch(`/api/goals/${goal.id}/team/start`, {
				method: "POST",
			});
			expect(startRes.status).toBe(201);
			const startData = await startRes.json();
			expect(startData.sessionId).toBeTruthy();

			// Now team should be active
			const teamRes2 = await apiFetch(`/api/goals/${goal.id}/team`);
			expect(teamRes2.status).toBe(200);
			const team2 = await teamRes2.json();
			expect(team2.teamLeadSessionId).toBeTruthy();
		} finally {
			await apiFetch(`/api/goals/${goal.id}/team/teardown`, { method: "POST" }).catch(() => {});
			await deleteGoal(goal.id);
		}
	});
});
