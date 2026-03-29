import { test, expect } from "./gateway-harness.js";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	startTeam,
	teardownTeam,
	waitForSessionStatus,
} from "./e2e-setup.js";

/**
 * E2E tests for gate dependency enforcement on team_spawn and team/prompt.
 *
 * Uses the `test-fast` workflow which has:
 *   design-doc (no deps) → implementation (depends on design-doc) → ready-to-merge (depends on implementation)
 */

async function spawnAgent(
	goalId: string,
	body: { role: string; task: string; workflowGateId?: string },
) {
	const res = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	return { status: res.status, data: await res.json() };
}

async function promptAgent(
	goalId: string,
	body: { sessionId: string; message: string; workflowGateId?: string },
) {
	const res = await apiFetch(`/api/goals/${goalId}/team/prompt`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	return { status: res.status, data: await res.json() };
}

async function signalGate(goalId: string, gateId: string, content: string) {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signal`, {
		method: "POST",
		body: JSON.stringify({ content }),
	});
	return { status: res.status, data: await res.json() };
}

async function getGates(goalId: string) {
	const res = await apiFetch(`/api/goals/${goalId}/gates`);
	expect(res.ok).toBe(true);
	return res.json() as Promise<{ gates: Array<{ gateId: string; status: string }> }>;
}

async function waitForGatePassed(goalId: string, gateId: string, timeoutMs = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const { gates } = await getGates(goalId);
		const gate = gates.find(g => g.gateId === gateId);
		if (gate?.status === "passed") return;
		await new Promise(r => setTimeout(r, 100));
	}
	throw new Error(`Gate "${gateId}" did not pass within ${timeoutMs}ms`);
}

test.describe.serial("Gate Dependency Enforcement", () => {
	const cleanupGoalIds: string[] = [];

	test.afterAll(async () => {
		for (const id of cleanupGoalIds) {
			await teardownTeam(id).catch(() => {});
		}
		for (const id of cleanupGoalIds) {
			await deleteGoal(id).catch(() => {});
		}
	});

	test("team/spawn rejected (409) when upstream gate not passed", async () => {
		const goal = await createGoal({
			title: "Spawn Reject Test",
			team: true,
			worktree: false,
			workflowId: "test-fast",
		});
		cleanupGoalIds.push(goal.id);
		await startTeam(goal.id);

		// Attempt to spawn for "implementation" gate — depends on "design-doc" which is pending
		const result = await spawnAgent(goal.id, {
			role: "coder",
			task: "Implement the feature",
			workflowGateId: "implementation",
		});

		expect(result.status).toBe(409);
		expect(result.data.error).toContain("Upstream gate");
	});

	test("team/spawn succeeds (201) when upstream gate passed", async () => {
		const goal = await createGoal({
			title: "Spawn Success Test",
			team: true,
			worktree: false,
			workflowId: "test-fast",
		});
		cleanupGoalIds.push(goal.id);
		await startTeam(goal.id);

		// Signal the design-doc gate so it passes
		const signalResult = await signalGate(goal.id, "design-doc", "# Design\nThis is the design doc.");
		expect([200, 201]).toContain(signalResult.status);

		// Wait for verification to complete (test-fast uses `echo ok`)
		await waitForGatePassed(goal.id, "design-doc");

		// Now spawning for "implementation" gate should succeed
		const result = await spawnAgent(goal.id, {
			role: "coder",
			task: "Implement the feature",
			workflowGateId: "implementation",
		});

		expect(result.status).toBe(201);
		expect(result.data.sessionId).toBeTruthy();
	});

	test("team/prompt rejected (409) when upstream gate not passed", async () => {
		const goal = await createGoal({
			title: "Prompt Reject Test",
			team: true,
			worktree: false,
			workflowId: "test-fast",
		});
		cleanupGoalIds.push(goal.id);
		await startTeam(goal.id);

		// Spawn an agent WITHOUT workflowGateId (backward compat, no gate check)
		const spawn = await spawnAgent(goal.id, {
			role: "coder",
			task: "Do some initial work",
		});
		expect(spawn.status).toBe(201);

		// Now prompt that agent with workflowGateId "implementation" while design-doc is pending
		const result = await promptAgent(goal.id, {
			sessionId: spawn.data.sessionId,
			message: "Now work on the implementation gate",
			workflowGateId: "implementation",
		});

		expect(result.status).toBe(409);
		expect(result.data.error).toContain("Upstream gate");
	});

	test("team/spawn without workflowGateId works (backward compat)", async () => {
		const goal = await createGoal({
			title: "Spawn No Gate Test",
			team: true,
			worktree: false,
			workflowId: "test-fast",
		});
		cleanupGoalIds.push(goal.id);
		await startTeam(goal.id);

		const result = await spawnAgent(goal.id, {
			role: "coder",
			task: "Do generic work with no gate reference",
		});

		expect(result.status).toBe(201);
		expect(result.data.sessionId).toBeTruthy();
	});

	test("team/prompt without workflowGateId works (backward compat)", async () => {
		const goal = await createGoal({
			title: "Prompt No Gate Test",
			team: true,
			worktree: false,
			workflowId: "test-fast",
		});
		cleanupGoalIds.push(goal.id);
		await startTeam(goal.id);

		// Spawn an agent first
		const spawn = await spawnAgent(goal.id, {
			role: "coder",
			task: "Initial work",
		});
		expect(spawn.status).toBe(201);

		// Wait for the agent to become idle before prompting
		await waitForSessionStatus(spawn.data.sessionId, "idle");

		// Prompt without workflowGateId — should succeed
		const result = await promptAgent(goal.id, {
			sessionId: spawn.data.sessionId,
			message: "Continue working on the task",
		});

		expect(result.status).toBe(200);
		expect(result.data.ok).toBe(true);
	});
});
