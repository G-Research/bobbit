/**
 * V2 port of tests/e2e/api-goals-prompt-paused.spec.ts
 *
 * Pins the Pause UX behaviour:
 *   Bug 0: pause/resume endpoints must not return 403 SUBGOALS_DISABLED
 *   Gap 1: team/prompt to paused goal must return 409 GOAL_PAUSED
 */
import { vi } from "vitest";
import { test, expect } from "../../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import {
	apiFetch,
	defaultProjectId,
	nonGitCwd,
	deleteGoal,
	createSession,
	deleteSession,
	waitForSessionStatus,
} from "../../../../tests/support/harnesses/integration/gateway/e2e-setup.js";

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

	test("explicit resume re-drains one deferred goal-guarded prompt, including idempotent recovery", async ({ gateway }) => {
		const goal = await createTestGoal();
		const sessionId = await createSession({ goalId: goal.id });
		await waitForSessionStatus(sessionId, "idle", 30_000);
		const context = gateway.projectContextManager.getContextForGoal(goal.id);
		await context.goalStore.updateStrict(goal.id, {
			state: "in-progress",
			setupStatus: "ready",
			worktreeOwnerSessionId: sessionId,
		});
		const live = gateway.sessionManager.getSession(sessionId);
		const prompt = vi.spyOn(live.rpcClient, "prompt");
		const redrain = vi.spyOn(gateway.sessionManager, "drainGoalGuardedPrompts");
		const text = `nested resume guarded prompt ${goal.id}`;
		const intentId = `nested-resume:${goal.id}`;
		try {
			await pauseGoal(goal.id);
			await gateway.sessionManager.enqueuePrompt(sessionId, text, {
				source: "system",
				suppressTitleGen: true,
				intentId,
				goalDispatchGuardId: goal.id,
			});
			gateway.sessionManager.drainGoalGuardedPrompts(goal.id);
			await new Promise(resolve => setImmediate(resolve));
			expect(prompt).not.toHaveBeenCalled();
			expect(live.promptQueue.toArray()).toEqual([
				expect.objectContaining({ id: intentId, text, goalDispatchGuardId: goal.id }),
			]);

			const resume = async () => apiFetch(`/api/goals/${goal.id}/resume`, {
				method: "POST",
				body: JSON.stringify({ cascade: false }),
			});
			const first = await resume();
			expect(first.status, await first.clone().text()).toBe(200);
			await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
			expect(prompt.mock.calls[0]?.[0]).toMatch(new RegExp(`${text}$`));
			expect(live.promptQueue.toArray()).toEqual([]);
			expect(redrain).toHaveBeenCalledWith(goal.id);

			// A retry after the pause bit was already cleared still invokes the
			// crash-healing release hook, but the consumed row cannot dispatch twice.
			const callsAfterFirst = redrain.mock.calls.length;
			const retry = await resume();
			expect(retry.status, await retry.clone().text()).toBe(200);
			expect(redrain.mock.calls.length).toBe(callsAfterFirst + 1);
			expect(redrain).toHaveBeenLastCalledWith(goal.id);
			expect(prompt).toHaveBeenCalledTimes(1);
		} finally {
			redrain.mockRestore();
			prompt.mockRestore();
			const cleanupGoal = context.goalStore.get(goal.id);
			if (cleanupGoal) delete cleanupGoal.worktreeOwnerSessionId;
			await deleteSession(sessionId).catch(() => {});
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
