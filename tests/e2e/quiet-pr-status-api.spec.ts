import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteGoal, deleteSession, nonGitCwd } from "./e2e-setup.js";

async function expectEmptyNoContent(resp: Response, label: string): Promise<void> {
	expect(resp.status, `${label} should return 204 No Content`).toBe(204);
	expect(await resp.text(), `${label} 204 response must have no body`).toBe("");
}

async function createGoalWithNoPrBranch(): Promise<{ id: string; branch: string }> {
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const title = `quiet pr-status no-pr ${suffix}`;
	const cwd = nonGitCwd();
	const spec = "E2E reproducer goal for quiet optional PR status probes with no matching GitHub PR.";
	const branch = `quiet-204-no-pr-${suffix}`;
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title,
			cwd,
			worktree: false,
			team: false,
			spec,
		}),
	});
	expect(resp.status).toBe(201);
	const goal = await resp.json() as { id: string; cwd?: string };

	// POST /api/goals derives branches only for real git projects and ignores a
	// caller-supplied branch. Pin a unique no-PR branch explicitly so this test
	// probes true absence instead of the current checkout, which may have an open PR.
	const updateResp = await apiFetch(`/api/goals/${goal.id}`, {
		method: "PUT",
		body: JSON.stringify({ title, cwd: goal.cwd ?? cwd, spec, branch }),
	});
	expect(updateResp.status).toBe(200);
	return { id: goal.id, branch };
}

test.describe("quiet optional PR status probes", () => {
	test("keeps bare session PR absence as 404 but returns empty 204 in optional mode", async () => {
		const goal = await createGoalWithNoPrBranch();
		const sessionId = await createSession({ goalId: goal.id });
		try {
			const bareResp = await apiFetch(`/api/sessions/${sessionId}/pr-status`);
			expect(bareResp.status, "bare session PR-status absence should remain 404").toBe(404);

			const optionalResp = await apiFetch(`/api/sessions/${sessionId}/pr-status?optional=1`);
			await expectEmptyNoContent(optionalResp, "quiet optional session PR-status absence");
		} finally {
			await deleteSession(sessionId);
			await deleteGoal(goal.id);
		}
	});

	test("returns 404 for a missing session even in optional PR-status mode", async () => {
		const resp = await apiFetch("/api/sessions/no-such-session/pr-status?optional=1");
		expect(resp.status, "missing session should remain 404 even for quiet PR-status probes").toBe(404);
	});

	test("keeps bare goal PR absence as 404 but returns empty 204 in optional mode", async () => {
		const goal = await createGoalWithNoPrBranch();
		try {
			const bareResp = await apiFetch(`/api/goals/${goal.id}/pr-status`);
			expect(bareResp.status, "bare goal PR-status absence should remain 404").toBe(404);

			const optionalResp = await apiFetch(`/api/goals/${goal.id}/pr-status?optional=1`);
			await expectEmptyNoContent(optionalResp, "quiet optional goal PR-status absence");
		} finally {
			await deleteGoal(goal.id);
		}
	});

	test("returns 404 for a missing goal even in optional PR-status mode", async () => {
		const resp = await apiFetch("/api/goals/no-such-goal/pr-status?optional=1");
		expect(resp.status, "missing goal should remain 404 even for quiet PR-status probes").toBe(404);
	});
});
