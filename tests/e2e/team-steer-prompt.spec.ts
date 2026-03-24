/**
 * E2E tests for team_steer and team_prompt REST endpoints.
 *
 * Verifies: validation (400), membership enforcement (403),
 * steer status check (409), prompt dispatch behavior.
 */
import { test, expect } from "@playwright/test";
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

test.describe("team steer/prompt — validation", () => {
	let goalId: string;

	test.beforeAll(async () => {
		const goal = await createGoal({ title: "steer-prompt-validation", team: true });
		goalId = goal.id;
	});

	test.afterAll(async () => {
		await deleteGoal(goalId);
	});

	test("POST /team/steer returns 400 without sessionId", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/steer`, {
			method: "POST",
			body: JSON.stringify({ message: "hello" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Missing");
	});

	test("POST /team/steer returns 400 without message", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/steer`, {
			method: "POST",
			body: JSON.stringify({ sessionId: "fake-id" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Missing");
	});

	test("POST /team/prompt returns 400 without sessionId", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/prompt`, {
			method: "POST",
			body: JSON.stringify({ message: "hello" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Missing");
	});

	test("POST /team/prompt returns 400 without message", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/prompt`, {
			method: "POST",
			body: JSON.stringify({ sessionId: "fake-id" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Missing");
	});
});

// ── Team membership tests ────────────────────────────────────────────

test.describe("team steer/prompt — membership enforcement", () => {
	let goalId: string;
	let nonTeamSessionId: string;

	test.beforeAll(async () => {
		const goal = await createGoal({ title: "steer-prompt-membership", team: true });
		goalId = goal.id;
		nonTeamSessionId = await createSession();
	});

	test.afterAll(async () => {
		await deleteSession(nonTeamSessionId);
		await deleteGoal(goalId);
	});

	test("POST /team/steer returns 403 for non-team session", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/steer`, {
			method: "POST",
			body: JSON.stringify({ sessionId: nonTeamSessionId, message: "redirect" }),
		});
		expect(resp.status).toBe(403);
		const data = await resp.json();
		expect(data.error).toContain("not a member");
	});

	test("POST /team/prompt returns 403 for non-team session", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/prompt`, {
			method: "POST",
			body: JSON.stringify({ sessionId: nonTeamSessionId, message: "do something" }),
		});
		expect(resp.status).toBe(403);
		const data = await resp.json();
		expect(data.error).toContain("not a member");
	});

	test("POST /team/steer returns 403 for nonexistent session", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/steer`, {
			method: "POST",
			body: JSON.stringify({ sessionId: "nonexistent-id", message: "redirect" }),
		});
		expect(resp.status).toBe(403);
	});
});

// ── Steer status check ──────────────────────────────────────────────

test.describe("team steer — agent must be streaming", () => {
	let goalId: string;

	test.beforeAll(async () => {
		const goal = await createGoal({ title: "steer-status-check", team: true });
		goalId = goal.id;
		await startTeam(goalId);
	});

	test.afterAll(async () => {
		await teardownTeam(goalId);
		await deleteGoal(goalId);
	});

	test("POST /team/steer returns 409 when agent is idle", async () => {
		const spawnResp = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
			method: "POST",
			body: JSON.stringify({ role: "coder", task: "placeholder" }),
		});

		if (spawnResp.status === 201) {
			const { sessionId: agentId } = await spawnResp.json();

			// Wait for agent to reach a known state (idle after processing initial task)
			await waitForSessionStatus(agentId, "idle");

			const steerResp = await apiFetch(`/api/goals/${goalId}/team/steer`, {
				method: "POST",
				body: JSON.stringify({ sessionId: agentId, message: "change direction" }),
			});
			expect(steerResp.status).toBe(409);
			const data = await steerResp.json();
			expect(data.error).toContain("not currently streaming");

			await apiFetch(`/api/goals/${goalId}/team/dismiss`, {
				method: "POST",
				body: JSON.stringify({ sessionId: agentId }),
			});
		}
	});
});

// ── Prompt dispatch ─────────────────────────────────────────────────

test.describe("team prompt — dispatch behavior", () => {
	let goalId: string;

	test.beforeAll(async () => {
		const goal = await createGoal({ title: "prompt-dispatch", team: true });
		goalId = goal.id;
		await startTeam(goalId);
	});

	test.afterAll(async () => {
		await teardownTeam(goalId);
		await deleteGoal(goalId);
	});

	test("POST /team/prompt succeeds for team agent", async () => {
		const spawnResp = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
			method: "POST",
			body: JSON.stringify({ role: "coder", task: "placeholder task" }),
		});

		if (spawnResp.status === 201) {
			const { sessionId: agentId } = await spawnResp.json();

			const promptResp = await apiFetch(`/api/goals/${goalId}/team/prompt`, {
				method: "POST",
				body: JSON.stringify({ sessionId: agentId, message: "also fix the tests" }),
			});
			expect(promptResp.status).toBe(200);
			const data = await promptResp.json();
			expect(data.ok).toBe(true);
			expect(["dispatched", "queued"]).toContain(data.status);

			await apiFetch(`/api/goals/${goalId}/team/dismiss`, {
				method: "POST",
				body: JSON.stringify({ sessionId: agentId }),
			});
		}
	});
});
