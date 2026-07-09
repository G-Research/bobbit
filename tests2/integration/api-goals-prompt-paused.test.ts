/**
 * V2 port of tests/e2e/api-goals-prompt-paused.spec.ts
 *
 * Pins the Pause UX behaviour:
 *   Bug 0: pause/resume endpoints must not return 403 SUBGOALS_DISABLED
 *   Gap 1: team/prompt to paused goal must return 409 GOAL_PAUSED
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	defaultProjectId,
	nonGitCwd,
	deleteGoal,
	createSession,
	deleteSession,
} from "./_e2e/e2e-setup.js";

async function setSubgoalsEnabled(enabled: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: enabled }),
	});
	expect(resp.status).toBe(200);
}

async function createTestGoal(): Promise<{ id: string }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `pause-prompt-test-${Date.now()}`,
			cwd: nonGitCwd(),
			worktree: false,
			autoStartTeam: false,
			workflowId: "feature",
			spec: "Test goal for pause-prompt E2E tests — minimal spec to satisfy length requirements for the server.",
			projectId: await defaultProjectId(),
		}),
	});
	expect(resp.status).toBe(201);
	return resp.json();
}

async function pauseGoal(id: string): Promise<void> {
	const resp = await apiFetch(`/api/goals/${id}/pause`, {
		method: "POST",
		body: JSON.stringify({ cascade: false }),
	});
	expect(resp.status).toBe(200);
}

test.describe("Pause UX reproducing tests", () => {
	test.afterEach(async () => {
		await setSubgoalsEnabled(true);
	});

	test("Bug 0: pause/resume endpoints work even when subgoals are disabled @smoke", async () => {
		await setSubgoalsEnabled(true);
		const goal = await createTestGoal();

		try {
			await setSubgoalsEnabled(false);

			const pauseResp = await apiFetch(`/api/goals/${goal.id}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: false }),
			});

			expect(pauseResp.status, "pause should not return 403 SUBGOALS_DISABLED").not.toBe(403);
			const body = await pauseResp.json().catch(() => ({}));
			expect(body.code, "pause should not return SUBGOALS_DISABLED code").not.toBe("SUBGOALS_DISABLED");
		} finally {
			await setSubgoalsEnabled(true);
			await deleteGoal(goal.id);
		}
	});

	test("Gap 1: team/prompt to paused goal returns 409 GOAL_PAUSED @smoke", async () => {
		const goal = await createTestGoal();

		try {
			await pauseGoal(goal.id);

			const resp = await apiFetch(`/api/goals/${goal.id}/team/prompt`, {
				method: "POST",
				body: JSON.stringify({
					sessionId: "nonexistent-session-for-pause-test",
					message: "hello from paused goal test",
				}),
			});

			expect(resp.status, "team/prompt to paused goal should return 409").toBe(409);
			const body = await resp.json();
			expect(body.code, "should return GOAL_PAUSED code").toBe("GOAL_PAUSED");
			expect(body.error, "should include useful error message").toContain("paused");
		} finally {
			await deleteGoal(goal.id);
		}
	});

	test("Bug 0: resume endpoint also works when subgoals are disabled @smoke", async () => {
		await setSubgoalsEnabled(true);
		const goal = await createTestGoal();
		try {
			await pauseGoal(goal.id);
			await setSubgoalsEnabled(false);
			const resumeResp = await apiFetch(`/api/goals/${goal.id}/resume`, {
				method: "POST",
				body: JSON.stringify({ cascade: false }),
			});
			expect(resumeResp.status, "resume should not return 403 SUBGOALS_DISABLED").not.toBe(403);
			const body = await resumeResp.json().catch(() => ({}));
			expect(body.code, "resume should not return SUBGOALS_DISABLED code").not.toBe("SUBGOALS_DISABLED");
		} finally {
			await setSubgoalsEnabled(true);
			await deleteGoal(goal.id);
		}
	});

	test("Gap 1: session/prompt to session of paused goal returns 409 GOAL_PAUSED @smoke", async () => {
		const goal = await createTestGoal();
		const sessionId = await createSession({ goalId: goal.id });
		try {
			await pauseGoal(goal.id);
			const resp = await apiFetch(`/api/goals/${goal.id}/team/prompt`, {
				method: "POST",
				body: JSON.stringify({ sessionId, message: "hello paused" }),
			});
			expect(resp.status, "team/prompt to session of paused goal should return 409").toBe(409);
			const body = await resp.json();
			expect(body.code).toBe("GOAL_PAUSED");
			expect(body.goalId, "response should include goalId").toBe(goal.id);
		} finally {
			await deleteSession(sessionId).catch(() => {});
			await deleteGoal(goal.id);
		}
	});

	test("team/prompt to non-paused goal with unknown session returns 403 (not 409) @smoke", async () => {
		const goal = await createTestGoal();

		try {
			const resp = await apiFetch(`/api/goals/${goal.id}/team/prompt`, {
				method: "POST",
				body: JSON.stringify({
					sessionId: "nonexistent-session-for-test",
					message: "hello",
				}),
			});

			expect(resp.status, "non-paused goal team/prompt with bad session should return 403").toBe(403);
			const body = await resp.json();
			expect(body.code).toBe("NOT_TEAM_MEMBER_OR_DIRECT_CHILD");
		} finally {
			await deleteGoal(goal.id);
		}
	});
});
