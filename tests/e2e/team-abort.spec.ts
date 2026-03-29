/**
 * E2E tests for team_abort REST endpoint.
 *
 * Verifies: validation (400), membership enforcement (403),
 * successful abort of busy/idle agents.
 */
import { test, expect } from "./gateway-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	createGoal,
	deleteGoal,
	startTeam,
	teardownTeam,
	waitForSessionStatus,
} from "./e2e-setup.js";

test.setTimeout(30_000);

// ── Validation tests ─────────────────────────────────────────────────

test.describe("team abort — validation", () => {
	let goalId: string;

	test.beforeAll(async () => {
		const goal = await createGoal({ title: "abort-validation", team: true });
		goalId = goal.id;
	});

	test.afterAll(async () => {
		await deleteGoal(goalId);
	});

	test("POST /team/abort returns 400 without sessionId", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/abort`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Missing");
	});

	test("POST /team/abort returns 400 with empty body", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/abort`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(400);
	});
});

// ── Team membership tests ────────────────────────────────────────────

test.describe("team abort — membership enforcement", () => {
	let goalId: string;
	let nonTeamSessionId: string;

	test.beforeAll(async () => {
		const goal = await createGoal({ title: "abort-membership", team: true });
		goalId = goal.id;
		nonTeamSessionId = await createSession();
	});

	test.afterAll(async () => {
		await deleteSession(nonTeamSessionId);
		await deleteGoal(goalId);
	});

	test("POST /team/abort returns 403 for non-team session", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/abort`, {
			method: "POST",
			body: JSON.stringify({ sessionId: nonTeamSessionId }),
		});
		expect(resp.status).toBe(403);
		const data = await resp.json();
		expect(data.error).toContain("not a member");
	});

	test("POST /team/abort returns 403 for nonexistent session", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/abort`, {
			method: "POST",
			body: JSON.stringify({ sessionId: "nonexistent-session-id" }),
		});
		expect(resp.status).toBe(403);
	});
});

// ── Abort of a stuck team agent ──────────────────────────────────────

test.describe("team abort — stuck agent", () => {
	let goalId: string;
	let teamLeadId: string;

	test.beforeAll(async () => {
		const goal = await createGoal({ title: "abort-stuck", team: true });
		goalId = goal.id;
		teamLeadId = await startTeam(goalId);
	});

	test.afterAll(async () => {
		await teardownTeam(goalId);
		await deleteGoal(goalId);
	});

	test("POST /team/abort force-kills a busy agent", async () => {
		// Spawn a role agent with a task that keeps it busy
		const spawnResp = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
			method: "POST",
			body: JSON.stringify({
				role: "coder",
				task: "STAY_BUSY:60000 Run this exact bash command: sleep 120. Do not do anything else.",
			}),
		});
		expect(spawnResp.status).toBe(201);
		const { sessionId: agentId } = await spawnResp.json();

		// Wait until the agent is streaming
		await waitForSessionStatus(agentId, "streaming");

		// Force-abort
		const abortResp = await apiFetch(`/api/goals/${goalId}/team/abort`, {
			method: "POST",
			body: JSON.stringify({ sessionId: agentId }),
		});
		expect(abortResp.status).toBe(200);
		const data = await abortResp.json();
		expect(data.ok).toBe(true);
		expect(data.status).toBe("idle");

		// Verify idle after abort
		await waitForSessionStatus(agentId, "idle");

		// Verify the agent can accept new work after being aborted
		const promptResp = await apiFetch(`/api/goals/${goalId}/team/prompt`, {
			method: "POST",
			body: JSON.stringify({ sessionId: agentId, message: "Reply with just the word OK" }),
		});
		expect(promptResp.status).toBe(200);
		const promptData = await promptResp.json();
		expect(promptData.ok).toBe(true);
		expect(promptData.status).toBe("dispatched");

		// Cleanup
		await apiFetch(`/api/goals/${goalId}/team/dismiss`, {
			method: "POST",
			body: JSON.stringify({ sessionId: agentId }),
		});
	});

	test("POST /team/abort on an already-idle agent is a no-op", async () => {
		const spawnResp = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
			method: "POST",
			body: JSON.stringify({
				role: "coder",
				task: "Reply with just the word DONE and nothing else.",
			}),
		});
		expect(spawnResp.status).toBe(201);
		const { sessionId: agentId } = await spawnResp.json();

		// Wait for agent to become idle
		await waitForSessionStatus(agentId, "idle");

		// Abort an idle agent — should succeed as a no-op
		const abortResp = await apiFetch(`/api/goals/${goalId}/team/abort`, {
			method: "POST",
			body: JSON.stringify({ sessionId: agentId }),
		});
		expect(abortResp.status).toBe(200);
		const data = await abortResp.json();
		expect(data.ok).toBe(true);
		expect(data.status).toBe("idle");

		// Cleanup
		await apiFetch(`/api/goals/${goalId}/team/dismiss`, {
			method: "POST",
			body: JSON.stringify({ sessionId: agentId }),
		});
	});
});

// ── Legacy /swarm/ path ──────────────────────────────────────────────

test.describe("team abort — legacy swarm path", () => {
	let goalId: string;

	test.beforeAll(async () => {
		const goal = await createGoal({ title: "abort-swarm-compat", team: true });
		goalId = goal.id;
	});

	test.afterAll(async () => {
		await deleteGoal(goalId);
	});

	test("POST /swarm/abort works (backward compat)", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/swarm/abort`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		// Should get 400 (missing sessionId) — not 404 — proving the route matches
		expect(resp.status).toBe(400);
	});
});
