/**
 * E2E tests for the auto-start team feature.
 *
 * When a goal is created with autoStartTeam: true (the default),
 * the server automatically calls teamManager.startTeam() after
 * worktree setup completes.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, nonGitCwd, deleteGoal } from "./_e2e/e2e-setup.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";

/** Poll a goal until a predicate is met or timeout. */
async function pollGoal(
	goalId: string,
	predicate: (g: any) => boolean,
	timeoutMs = 30_000,
): Promise<any> {
	return pollUntil(
		async () => {
			const res = await apiFetch(`/api/goals/${goalId}`);
			const goal = await res.json();
			return predicate(goal) ? goal : null;
		},
		{ timeoutMs, intervalMs: 100, label: `goal ${goalId} predicate` },
	);
}

/** Poll until the team is started for a goal (team endpoint returns 200). */
async function pollTeamStarted(goalId: string, timeoutMs = 30_000): Promise<any> {
	return pollUntil(
		async () => {
			const res = await apiFetch(`/api/goals/${goalId}/team`);
			if (res.status !== 200) return null;
			const team = await res.json();
			return team.teamLeadSessionId ? team : null;
		},
		{ timeoutMs, intervalMs: 100, label: `team started for ${goalId}` },
	);
}

/**
 * Exercise the route's asynchronous auto-start decision without provisioning a
 * real Git worktree. For auto-start cases, seed the short-lived "preparing"
 * metadata that normally comes from Git detection and replace only the
 * provisioning leaf; the server still owns and invokes the real startTeam
 * callback. Manual-start cases remain ordinary no-worktree goals.
 */
async function createGoalForAutoStart(gateway: any, opts: Record<string, unknown> = {}): Promise<any> {
	const autoStart = opts.autoStartTeam !== false;
	const context = gateway.projectContextManager.getOrCreate(gateway.defaultProjectId);
	const goalManager = context.goalManager as any;
	const originalCreateGoal = goalManager.createGoal;
	const originalSetupAndStart = goalManager.setupWorktreeAndStartTeam;

	if (autoStart) {
		goalManager.createGoal = async function (...args: any[]) {
			const goal = await originalCreateGoal.apply(this, args);
			Object.assign(goal, {
				repoPath: nonGitCwd(),
				worktreePath: nonGitCwd(),
				branch: `goal/seeded-${goal.id.slice(0, 8)}`,
				setupStatus: "preparing",
			});
			context.goalStore.put(goal);
			return goal;
		};
		goalManager.setupWorktreeAndStartTeam = async function (goalId: string, startTeam: () => Promise<unknown>) {
			context.goalStore.update(goalId, { setupStatus: "ready" });
			await startTeam();
		};
	}

	try {
		const resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: `Auto-start test ${Date.now()}`,
				cwd: nonGitCwd(),
				worktree: false,
				...opts,
			}),
		});
		expect(resp.status).toBe(201);
		return resp.json();
	} finally {
		goalManager.createGoal = originalCreateGoal;
		goalManager.setupWorktreeAndStartTeam = originalSetupAndStart;
	}
}

test.describe("Auto-start team", () => {
	test("defaults to true and starts team automatically", async ({ gateway }) => {
		const goal = await createGoalForAutoStart(gateway);
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

	test("explicit true starts team automatically", async ({ gateway }) => {
		const goal = await createGoalForAutoStart(gateway, { autoStartTeam: true });
		try {
			expect(goal.autoStartTeam).toBe(true);

			await pollGoal(goal.id, g => g.setupStatus === "ready");
			await pollTeamStarted(goal.id);
		} finally {
			await apiFetch(`/api/goals/${goal.id}/team/teardown`, { method: "POST" }).catch(() => {});
			await deleteGoal(goal.id);
		}
	});

	test("false skips team start, manual start works", async ({ gateway }) => {
		const goal = await createGoalForAutoStart(gateway, {
			autoStartTeam: false,
			spec: "# Manual start test\nThis spec is long enough to pass the SPEC_REQUIRED guard.",
		});
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

	test("manual /team/start rejects empty/placeholder spec with SPEC_REQUIRED", async ({ gateway }) => {
		const goal = await createGoalForAutoStart(gateway, { autoStartTeam: false, spec: "placeholder" });
		try {
			await pollGoal(goal.id, g => g.setupStatus === "ready");

			const res = await apiFetch(`/api/goals/${goal.id}/team/start`, { method: "POST" });
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.code).toBe("SPEC_REQUIRED");
			expect(typeof body.error).toBe("string");
		} finally {
			await apiFetch(`/api/goals/${goal.id}/team/teardown`, { method: "POST" }).catch(() => {});
			await deleteGoal(goal.id);
		}
	});
});
