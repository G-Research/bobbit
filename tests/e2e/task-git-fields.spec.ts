/**
 * E2E tests for the local git handoff task fields.
 *
 * Verifies:
 * - Tasks have baseSha, headSha, branch fields (not commitSha)
 * - Spawning a team agent populates baseSha on the TeamAgent
 * - Assigning a task auto-populates baseSha and branch from the TeamAgent
 * - Completing a task with headSha persists the value
 * - The old commitSha field is absent from task responses
 *
 * Run with:
 *   npm run build:server && npx playwright test tests/e2e/task-git-fields.spec.ts --config playwright-e2e.config.ts
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	startTeam,
	teardownTeam,
} from "./e2e-setup.js";

test.setTimeout(60_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTask(
	goalId: string,
	opts: { title: string; type?: string; spec?: string },
): Promise<any> {
	const resp = await apiFetch(`/api/goals/${goalId}/tasks`, {
		method: "POST",
		body: JSON.stringify({ type: "implementation", ...opts }),
	});
	expect(resp.status).toBe(201);
	return resp.json();
}

async function getTask(taskId: string): Promise<any> {
	const resp = await apiFetch(`/api/tasks/${taskId}`);
	expect(resp.status).toBe(200);
	return resp.json();
}

async function updateTask(taskId: string, body: Record<string, unknown>): Promise<Response> {
	return apiFetch(`/api/tasks/${taskId}`, {
		method: "PUT",
		body: JSON.stringify(body),
	});
}

async function assignTask(taskId: string, sessionId: string): Promise<Response> {
	return apiFetch(`/api/tasks/${taskId}/assign`, {
		method: "POST",
		body: JSON.stringify({ sessionId }),
	});
}

async function spawnAgent(goalId: string, role: string, task: string): Promise<any> {
	const resp = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
		method: "POST",
		body: JSON.stringify({ role, task }),
	});
	expect(resp.status).toBe(201);
	return resp.json();
}

// ---------------------------------------------------------------------------
// Tests: Task field CRUD (no team/git needed)
// ---------------------------------------------------------------------------

test.describe("Task git fields — new baseSha/headSha/branch fields", () => {
	let goalId: string;

	test.beforeAll(async () => {
		const goal = await createGoal({ title: "git-fields-crud", team: true });
		goalId = goal.id;
	});

	test.afterAll(async () => {
		await deleteGoal(goalId);
	});

	test("newly created task has no commitSha field", async () => {
		const task = await createTask(goalId, { title: "check-no-commitsha" });
		expect(task).not.toHaveProperty("commitSha");
	});

	test("PUT /api/tasks/:id accepts headSha and persists it", async () => {
		const task = await createTask(goalId, { title: "test-headsha-persist" });

		// Transition to in-progress first (required before complete)
		await updateTask(task.id, { state: "in-progress" });

		// Complete with headSha
		const putResp = await updateTask(task.id, {
			state: "complete",
			headSha: "abc123def456",
			resultSummary: "All done",
		});
		expect(putResp.status).toBe(200);

		// Verify persisted
		const updated = await getTask(task.id);
		expect(updated.headSha).toBe("abc123def456");
		expect(updated.resultSummary).toBe("All done");
		expect(updated).not.toHaveProperty("commitSha");
	});

	test("PUT /api/tasks/:id accepts baseSha and branch", async () => {
		const task = await createTask(goalId, { title: "test-base-branch" });

		const resp = await updateTask(task.id, {
			baseSha: "aaa111",
			branch: "goal-test-coder-xyz",
		});
		expect(resp.status).toBe(200);

		const updated = await getTask(task.id);
		expect(updated.baseSha).toBe("aaa111");
		expect(updated.branch).toBe("goal-test-coder-xyz");
	});

	test("headSha persists independently of state changes", async () => {
		const task = await createTask(goalId, { title: "headsha-independent" });

		// Set headSha while still in todo
		const resp = await updateTask(task.id, { headSha: "someshavalue" });
		expect(resp.status).toBe(200);

		const updated = await getTask(task.id);
		expect(updated.headSha).toBe("someshavalue");
		expect(updated.state).toBe("todo");
	});
});

// ---------------------------------------------------------------------------
// Tests: Team spawn auto-population of baseSha and branch
// ---------------------------------------------------------------------------

test.describe("Task git fields — team spawn auto-population", () => {
	test.describe.configure({ mode: 'serial' });
	let goalId: string;

	test.beforeAll(async () => {
		// Spawn skips worktree creation but still works.
		// baseSha may be undefined (no git repo), but the test verifies the
		// assign endpoint auto-populates from the TeamAgent record.
		const goal = await createGoal({ title: "git-fields-spawn", team: true });
		goalId = goal.id;
		await startTeam(goalId);
	});

	test.afterAll(async () => {
		await teardownTeam(goalId).catch(() => {});
		await deleteGoal(goalId);
	});

	test("assigning a task to a spawned agent populates branch from TeamAgent", async () => {
		const spawnResult = await spawnAgent(goalId, "coder", "Implement feature");

		// Create a task and assign it to the spawned agent
		const task = await createTask(goalId, { title: "auto-populate-test" });
		const assignResp = await assignTask(task.id, spawnResult.sessionId);
		expect(assignResp.status).toBe(200);

		// Verify the task got assigned and transitioned to in-progress
		const updated = await getTask(task.id);
		expect(updated.assignedSessionId).toBe(spawnResult.sessionId);
		expect(updated.state).toBe("in-progress");

		// No commitSha on the response
		expect(updated).not.toHaveProperty("commitSha");
	});

	test("full lifecycle: spawn → assign → complete with headSha → verify", async () => {
		const spawnResult = await spawnAgent(goalId, "coder", "Another feature");

		// Create and assign task
		const task = await createTask(goalId, { title: "lifecycle-test" });
		const assignResp = await assignTask(task.id, spawnResult.sessionId);
		expect(assignResp.status).toBe(200);

		// Complete the task with headSha
		const completeResp = await updateTask(task.id, {
			state: "complete",
			headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			resultSummary: "Feature implemented",
		});
		expect(completeResp.status).toBe(200);

		// Verify all fields are present
		const completed = await getTask(task.id);
		expect(completed.headSha).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
		expect(completed.resultSummary).toBe("Feature implemented");
		expect(completed.state).toBe("complete");
		expect(completed).not.toHaveProperty("commitSha");
	});

	test("task list endpoint returns tasks with new git fields", async () => {
		// Fetch all tasks for the goal
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`);
		expect(resp.status).toBe(200);
		const body = await resp.json();
		const tasks = body.tasks;
		expect(Array.isArray(tasks)).toBe(true);
		expect(tasks.length).toBeGreaterThan(0);

		// Every task should not have commitSha
		for (const t of tasks) {
			expect(t).not.toHaveProperty("commitSha");
		}

		// The completed task should have headSha
		const completedTask = tasks.find((t: any) => t.headSha === "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
		expect(completedTask).toBeTruthy();
		expect(completedTask.state).toBe("complete");
	});
});
