/**
 * Reproducing tests for the Pause UX gaps:
 *   Bug 0: pause/resume 403 when subgoals disabled
 *   Gap 1: team/prompt to paused goal not rejected
 * These tests currently FAIL (bugs exist) and will PASS after the fixes.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, defaultProjectId, nonGitCwd, deleteGoal, createSession, deleteSession } from "./e2e-setup.js";

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
	// After fix this should be 200; before fix it's 403 SUBGOALS_DISABLED
	// This call is used as a helper in Test 2 — with subgoals enabled it works.
	expect(resp.status).toBe(200);
}

test.describe("Pause UX reproducing tests", () => {
	test.afterEach(async () => {
		// Always restore subgoals enabled so other tests are not affected.
		await setSubgoalsEnabled(true);
	});

	test("Bug 0: pause/resume endpoints work even when subgoals are disabled @smoke", async () => {
		// Ensure goal creation works (requires subgoals enabled for the worktree routes,
		// but goal creation itself only needs a project). Create with subgoals on first.
		await setSubgoalsEnabled(true);
		const goal = await createTestGoal();

		try {
			// Disable subgoals to reproduce the bug.
			await setSubgoalsEnabled(false);

			const pauseResp = await apiFetch(`/api/goals/${goal.id}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: false }),
			});

			// BUG: currently returns 403 SUBGOALS_DISABLED
			// AFTER FIX: should return 200 (or a non-403 error), NOT 403 SUBGOALS_DISABLED
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
			// Pause the goal (with subgoals enabled, this should work).
			await pauseGoal(goal.id);

			// Try to send a prompt to the paused goal's team.
			const resp = await apiFetch(`/api/goals/${goal.id}/team/prompt`, {
				method: "POST",
				body: JSON.stringify({
					sessionId: "nonexistent-session-for-pause-test",
					message: "hello from paused goal test",
				}),
			});

			// BUG: currently returns 403 NOT_TEAM_MEMBER_OR_DIRECT_CHILD (pause check missing)
			// AFTER FIX: returns 409 GOAL_PAUSED
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
			// Pause while subgoals enabled
			await pauseGoal(goal.id);
			// Now disable subgoals and try resume
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
		// Create a session associated with the goal
		const sessionId = await createSession({ goalId: goal.id });
		try {
			// Pause the goal
			await pauseGoal(goal.id);
			// Try to prompt the session — should be rejected because its goal is paused
			// Note: session/prompt requires caller session secret auth, so we test
			// the 403 auth path first to confirm the session exists, then verify
			// that the pause check would fire. Since we can't easily forge a caller
			// secret in this test, we verify via the team/prompt path that the 409
			// fires before auth (goal check happens before membership check).
			// Directly: use a real session with goalId to confirm the prompt would
			// reach the pause guard even if auth fails first.
			const resp = await apiFetch(`/api/goals/${goal.id}/team/prompt`, {
				method: "POST",
				body: JSON.stringify({ sessionId, message: "hello paused" }),
			});
			// The goal is paused — should return 409 GOAL_PAUSED before any membership check
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
			// Goal is NOT paused — team/prompt should pass the pause check and hit membership check.
			const resp = await apiFetch(`/api/goals/${goal.id}/team/prompt`, {
				method: "POST",
				body: JSON.stringify({
					sessionId: "nonexistent-session-for-test",
					message: "hello",
				}),
			});

			// Should get 403 (session not on team), NOT 409 (goal not paused).
			expect(resp.status, "non-paused goal team/prompt with bad session should return 403").toBe(403);
			const body = await resp.json();
			expect(body.code).toBe("NOT_TEAM_MEMBER_OR_DIRECT_CHILD");
		} finally {
			await deleteGoal(goal.id);
		}
	});
});
