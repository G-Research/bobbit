/**
 * E2E tests for the sandbox git fetch broker.
 *
 * When a sandboxed agent sets `headSha` on a task, the server calls
 * `teamManager.brokerGitFetch()` to fetch the agent's branch into the
 * team lead's clone. This test verifies the API wire-up works correctly
 * without requiring real Docker containers or sandbox pools.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, deleteGoal, nonGitCwd } from "./e2e-setup.js";

let goalId: string;

test.afterEach(async () => {
	if (goalId) {
		await deleteGoal(goalId);
		goalId = "";
	}
});

test.describe("Sandbox git fetch broker", () => {
	test("task update with headSha succeeds (broker runs fire-and-forget)", async () => {
		// Create a goal with team enabled
		const goal = await createGoal({
			title: "Broker test " + Date.now(),
			team: true,
			worktree: false,
		});
		goalId = goal.id;

		// Create a task with a branch set
		const taskResp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({
				title: "Agent work",
				type: "implementation",
				spec: "Do the thing",
			}),
		});
		expect(taskResp.status).toBe(201);
		const task = await taskResp.json();

		// Set branch on the task first (required for broker to trigger)
		const branchResp = await apiFetch(`/api/tasks/${task.id}`, {
			method: "PUT",
			body: JSON.stringify({ branch: "feature/agent-work" }),
		});
		expect(branchResp.status).toBe(200);

		// Now set headSha — this triggers the broker (fire-and-forget)
		// The broker will fail gracefully since there's no real team/worktree,
		// but the API response should still be 200.
		const headShaResp = await apiFetch(`/api/tasks/${task.id}`, {
			method: "PUT",
			body: JSON.stringify({
				headSha: "abc123def456",
			}),
		});
		expect(headShaResp.status).toBe(200);
		const body = await headShaResp.json();
		expect(body.ok).toBe(true);
	});

	test("task update without headSha does not error", async () => {
		const goal = await createGoal({
			title: "No headSha test " + Date.now(),
			team: true,
			worktree: false,
		});
		goalId = goal.id;

		// Create a task
		const taskResp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({
				title: "Simple task",
				type: "implementation",
			}),
		});
		expect(taskResp.status).toBe(201);
		const task = await taskResp.json();

		// Update without headSha — should succeed normally, no broker triggered
		const updateResp = await apiFetch(`/api/tasks/${task.id}`, {
			method: "PUT",
			body: JSON.stringify({
				state: "in-progress",
			}),
		});
		expect(updateResp.status).toBe(200);

		// Complete without headSha
		const completeResp = await apiFetch(`/api/tasks/${task.id}`, {
			method: "PUT",
			body: JSON.stringify({
				state: "complete",
				resultSummary: "Done without headSha",
			}),
		});
		expect(completeResp.status).toBe(200);
	});

	test("headSha is persisted on task after update", async () => {
		const goal = await createGoal({
			title: "HeadSha persist test " + Date.now(),
			team: true,
			worktree: false,
		});
		goalId = goal.id;

		const taskResp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({
				title: "Persist check",
				type: "implementation",
			}),
		});
		expect(taskResp.status).toBe(201);
		const task = await taskResp.json();

		// Set branch and headSha
		await apiFetch(`/api/tasks/${task.id}`, {
			method: "PUT",
			body: JSON.stringify({
				branch: "feature/test-branch",
				headSha: "deadbeef12345678",
			}),
		});

		// Re-read the task and verify headSha is stored
		const getResp = await apiFetch(`/api/goals/${goalId}/tasks`);
		expect(getResp.status).toBe(200);
		const { tasks } = await getResp.json();
		const updatedTask = tasks.find((t: any) => t.id === task.id);
		expect(updatedTask.headSha).toBe("deadbeef12345678");
		expect(updatedTask.branch).toBe("feature/test-branch");
	});

	test("broker does not break task update when assignedSessionId is missing", async () => {
		// When there's no assignedSessionId, the broker should be skipped
		// (the condition in server.ts checks updatedTask.assignedSessionId)
		const goal = await createGoal({
			title: "No assigned session " + Date.now(),
			team: true,
			worktree: false,
		});
		goalId = goal.id;

		const taskResp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({
				title: "Unassigned task",
				type: "implementation",
			}),
		});
		expect(taskResp.status).toBe(201);
		const task = await taskResp.json();

		// Set branch + headSha but no assignedSessionId — broker condition skipped
		const updateResp = await apiFetch(`/api/tasks/${task.id}`, {
			method: "PUT",
			body: JSON.stringify({
				branch: "feature/unassigned",
				headSha: "aabbccdd",
			}),
		});
		expect(updateResp.status).toBe(200);
	});

	test("broker does not break task update when branch is missing", async () => {
		// Without a branch, the broker condition is not met
		const goal = await createGoal({
			title: "No branch test " + Date.now(),
			team: true,
			worktree: false,
		});
		goalId = goal.id;

		const taskResp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({
				title: "No branch task",
				type: "implementation",
			}),
		});
		expect(taskResp.status).toBe(201);
		const task = await taskResp.json();

		// Set headSha but no branch — broker condition skipped
		const updateResp = await apiFetch(`/api/tasks/${task.id}`, {
			method: "PUT",
			body: JSON.stringify({
				headSha: "11223344",
			}),
		});
		expect(updateResp.status).toBe(200);
	});
});
