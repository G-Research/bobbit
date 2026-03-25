import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { readE2EToken, BASE as GW_URL } from "./e2e-setup.js";

/**
 * End-to-end tests for team and goal session lifecycle.
 *
 * Covers: creating a team goal, starting a team, letting it run,
 * ending/tearing down a team, creating manual sessions in a goal,
 * deleting sessions, starting a second team after ending a previous one, etc.
 *
 * Run with:
 *   npx playwright test tests/team-lifecycle.spec.ts --config tests/playwright-e2e.config.ts
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function headers(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function apiCreateGoal(
	token: string,
	data: { title: string; cwd?: string; spec?: string; team?: boolean; worktree?: boolean },
) {
	const res = await fetch(`${GW_URL}/api/goals`, {
		method: "POST",
		headers: headers(token),
		body: JSON.stringify({ cwd: process.cwd(), ...data }),
	});
	expect(res.status).toBe(201);
	return res.json() as Promise<{
		id: string; title: string; cwd: string; state: string; spec: string;
		team?: boolean; worktreePath?: string; branch?: string; repoPath?: string;
	}>;
}

async function apiGetGoal(token: string, id: string) {
	const res = await fetch(`${GW_URL}/api/goals/${id}`, { headers: headers(token) });
	expect(res.ok).toBe(true);
	return res.json() as Promise<{
		id: string; title: string; cwd: string; state: string; spec: string;
		team?: boolean; worktreePath?: string; branch?: string; repoPath?: string;
	}>;
}

async function apiUpdateGoal(token: string, id: string, updates: Record<string, unknown>) {
	const res = await fetch(`${GW_URL}/api/goals/${id}`, {
		method: "PUT",
		headers: headers(token),
		body: JSON.stringify(updates),
	});
	expect(res.ok).toBe(true);
}

async function apiDeleteGoal(token: string, id: string) {
	await fetch(`${GW_URL}/api/goals/${id}`, {
		method: "DELETE",
		headers: headers(token),
	});
}

async function apiListSessions(token: string) {
	const res = await fetch(`${GW_URL}/api/sessions`, { headers: headers(token) });
	expect(res.ok).toBe(true);
	const data = await res.json();
	return data.sessions as Array<{
		id: string; title: string; cwd: string; status: string;
		goalId?: string; role?: string; teamGoalId?: string;
	}>;
}

async function apiCreateSession(token: string, body: Record<string, unknown> = {}) {
	const res = await fetch(`${GW_URL}/api/sessions`, {
		method: "POST",
		headers: headers(token),
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(201);
	return res.json() as Promise<{ id: string; cwd: string; goalId?: string }>;
}

async function apiDeleteSession(token: string, id: string) {
	await fetch(`${GW_URL}/api/sessions/${id}`, {
		method: "DELETE",
		headers: headers(token),
	});
}

async function apiGetSession(token: string, id: string) {
	const res = await fetch(`${GW_URL}/api/sessions/${id}`, { headers: headers(token) });
	return { status: res.status, data: res.ok ? await res.json() : null };
}

async function apiStartTeam(token: string, goalId: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/team/start`, {
		method: "POST",
		headers: headers(token),
	});
	return { status: res.status, data: await res.json() };
}

async function apiGetTeamState(token: string, goalId: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/team`, { headers: headers(token) });
	return { status: res.status, data: res.ok ? await res.json() : null };
}

async function apiListTeamAgents(token: string, goalId: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/team/agents`, { headers: headers(token) });
	expect(res.ok).toBe(true);
	const data = await res.json();
	return data.agents as Array<{
		sessionId: string; role: string; status: string;
		worktreePath: string; branch: string; task: string;
	}>;
}

async function apiSpawnRole(token: string, goalId: string, role: string, task: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/team/spawn`, {
		method: "POST",
		headers: headers(token),
		body: JSON.stringify({ role, task }),
	});
	return { status: res.status, data: await res.json() };
}

async function apiDismissRole(token: string, goalId: string, sessionId: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/team/dismiss`, {
		method: "POST",
		headers: headers(token),
		body: JSON.stringify({ sessionId }),
	});
	return { status: res.status, data: await res.json() };
}

async function apiCompleteTeam(token: string, goalId: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/team/complete`, {
		method: "POST",
		headers: headers(token),
	});
	return { status: res.status, data: await res.json() };
}

async function apiTeardownTeam(token: string, goalId: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/team/teardown`, {
		method: "POST",
		headers: headers(token),
	});
	return { status: res.status, data: await res.json() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Team & Goal Session Lifecycle", () => {
	let token: string;
	const cleanupGoalIds: string[] = [];
	const cleanupSessionIds: string[] = [];

	test.beforeAll(() => {
		token = readE2EToken();
	});

	test.afterAll(async () => {
		// Tear down any teams first, then sessions, then goals
		for (const goalId of cleanupGoalIds) {
			await apiTeardownTeam(token, goalId).catch(() => {});
		}
		for (const id of cleanupSessionIds) {
			await apiDeleteSession(token, id).catch(() => {});
		}
		// Small delay to let session terminations complete
		await new Promise((r) => setTimeout(r, 1000));
		for (const id of cleanupGoalIds) {
			await apiDeleteGoal(token, id).catch(() => {});
		}
	});

	// ── Team creation & basic lifecycle ──────────────────────────

	test("create a team goal, start team, verify team lead session", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Team Lifecycle Test",
			team: true,
			spec: "Test team lifecycle",
		});
		cleanupGoalIds.push(goal.id);

		expect(goal.team).toBe(true);
		expect(goal.state).toBe("todo");

		// Start the team — creates a team lead session
		const startResult = await apiStartTeam(token, goal.id);
		expect(startResult.status).toBe(201);
		expect(startResult.data.sessionId).toBeTruthy();
		cleanupSessionIds.push(startResult.data.sessionId);

		// Goal should transition to in-progress
		const updatedGoal = await apiGetGoal(token, goal.id);
		expect(updatedGoal.state).toBe("in-progress");

		// Team state should show the team lead
		const teamState = await apiGetTeamState(token, goal.id);
		expect(teamState.status).toBe(200);
		expect(teamState.data.teamLeadSessionId).toBe(startResult.data.sessionId);
		expect(teamState.data.agents).toHaveLength(0);

		// Team lead session should exist in session list
		const sessions = await apiListSessions(token);
		const teamLead = sessions.find((s) => s.id === startResult.data.sessionId);
		expect(teamLead).toBeTruthy();
		expect(teamLead!.role).toBe("team-lead");
		expect(teamLead!.teamGoalId).toBe(goal.id);
	});

	test("cannot start a second team on the same goal", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Double Team Prevention",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		const first = await apiStartTeam(token, goal.id);
		expect(first.status).toBe(201);
		cleanupSessionIds.push(first.data.sessionId);

		// Second start should fail
		const second = await apiStartTeam(token, goal.id);
		expect(second.status).toBe(400);
		expect(second.data.error).toContain("already active");
	});

	test("cannot start a team on a non-team goal", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Regular Goal No Team",
			team: false,
		});
		cleanupGoalIds.push(goal.id);

		const result = await apiStartTeam(token, goal.id);
		expect(result.status).toBe(400);
		expect(result.data.error).toContain("team mode");
	});

	// ── Spawning role agents ─────────────────────────────────────

	test("spawn role agents and verify they appear in team state", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Team Spawn Test",
			team: true,
			spec: "Test spawning agents",
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartTeam(token, goal.id);
		expect(startResult.status).toBe(201);
		cleanupSessionIds.push(startResult.data.sessionId);

		// Spawn a coder agent
		const coder = await apiSpawnRole(token, goal.id, "coder", "Write a hello world function");
		expect(coder.status).toBe(201);
		expect(coder.data.sessionId).toBeTruthy();
		expect(coder.data.worktreePath).toBeTruthy();
		cleanupSessionIds.push(coder.data.sessionId);

		// Spawn a reviewer agent
		const reviewer = await apiSpawnRole(token, goal.id, "reviewer", "Review the hello world function");
		expect(reviewer.status).toBe(201);
		cleanupSessionIds.push(reviewer.data.sessionId);

		// Verify team state shows both agents
		const teamState = await apiGetTeamState(token, goal.id);
		expect(teamState.data.agents).toHaveLength(2);

		const roles = teamState.data.agents.map((a: any) => a.role).sort();
		expect(roles).toEqual(["coder", "reviewer"]);

		// Verify agents appear in the agents list
		const agents = await apiListTeamAgents(token, goal.id);
		expect(agents).toHaveLength(2);
		expect(agents.find((a) => a.role === "coder")).toBeTruthy();
		expect(agents.find((a) => a.role === "reviewer")).toBeTruthy();
	});

	test("spawn rejects invalid roles", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Invalid Role Test",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartTeam(token, goal.id);
		expect(startResult.status).toBe(201);
		cleanupSessionIds.push(startResult.data.sessionId);

		const result = await apiSpawnRole(token, goal.id, "invalid-role", "Do something");
		expect(result.status).toBe(400);
		expect(result.data.error).toContain("Invalid role");
	});

	test("spawn rejects team-lead role", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Team Lead Spawn Rejection",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartTeam(token, goal.id);
		expect(startResult.status).toBe(201);
		cleanupSessionIds.push(startResult.data.sessionId);

		const result = await apiSpawnRole(token, goal.id, "team-lead", "Be a leader");
		expect(result.status).toBe(400);
		expect(result.data.error).toContain("team-lead");
	});

	// ── Dismissing role agents ───────────────────────────────────

	test("dismiss a role agent removes it from team state", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Dismiss Agent Test",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartTeam(token, goal.id);
		expect(startResult.status).toBe(201);
		cleanupSessionIds.push(startResult.data.sessionId);

		// Spawn then dismiss a coder
		const coder = await apiSpawnRole(token, goal.id, "coder", "Write code");
		expect(coder.status).toBe(201);

		const dismissResult = await apiDismissRole(token, goal.id, coder.data.sessionId);
		expect(dismissResult.status).toBe(200);
		expect(dismissResult.data.ok).toBe(true);

		// Agent should be gone from team state
		const agents = await apiListTeamAgents(token, goal.id);
		expect(agents.find((a) => a.sessionId === coder.data.sessionId)).toBeUndefined();

		// Session should be terminated
		const session = await apiGetSession(token, coder.data.sessionId);
		if (session.data) {
			expect(session.data.status).toBe("archived");
		}
	});

	test("cannot dismiss the team lead via dismiss endpoint", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Team Lead Dismiss Prevention",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartTeam(token, goal.id);
		expect(startResult.status).toBe(201);
		cleanupSessionIds.push(startResult.data.sessionId);

		const dismissResult = await apiDismissRole(token, goal.id, startResult.data.sessionId);
		expect(dismissResult.status).toBe(400);
		expect(dismissResult.data.error).toContain("team lead");
	});

	// ── Completing a team ───────────────────────────────────────

	test("completeTeam dismisses agents but keeps team lead alive", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Complete Team Test",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartTeam(token, goal.id);
		expect(startResult.status).toBe(201);
		const teamLeadId = startResult.data.sessionId;
		cleanupSessionIds.push(teamLeadId);

		// Spawn two agents
		const coder = await apiSpawnRole(token, goal.id, "coder", "Write code");
		expect(coder.status).toBe(201);
		const tester = await apiSpawnRole(token, goal.id, "tester", "Test code");
		expect(tester.status).toBe(201);

		// Complete the team
		const result = await apiCompleteTeam(token, goal.id);
		expect(result.status).toBe(200);
		expect(result.data.ok).toBe(true);

		// Goal should be complete
		const updatedGoal = await apiGetGoal(token, goal.id);
		expect(updatedGoal.state).toBe("complete");

		// Agents should be gone
		const agents = await apiListTeamAgents(token, goal.id);
		expect(agents).toHaveLength(0);

		// Team lead should still exist and be non-terminated
		const teamLeadSession = await apiGetSession(token, teamLeadId);
		expect(teamLeadSession.status).toBe(200);
		expect(teamLeadSession.data.status).not.toBe("archived");
	});

	// ── Tearing down a team ─────────────────────────────────────

	test("teardownTeam terminates everything including team lead", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Teardown Team Test",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartTeam(token, goal.id);
		expect(startResult.status).toBe(201);
		const teamLeadId = startResult.data.sessionId;

		// Spawn an agent
		const coder = await apiSpawnRole(token, goal.id, "coder", "Write code");
		expect(coder.status).toBe(201);

		// Teardown the team
		const result = await apiTeardownTeam(token, goal.id);
		expect(result.status).toBe(200);
		expect(result.data.ok).toBe(true);

		// Team state should be gone
		const teamState = await apiGetTeamState(token, goal.id);
		expect(teamState.status).toBe(404);

		// Team lead session should be terminated
		const teamLeadSession = await apiGetSession(token, teamLeadId);
		if (teamLeadSession.data) {
			expect(teamLeadSession.data.status).toBe("archived");
		}
	});

	// ── Second team after teardown ──────────────────────────────

	test("can start a new team after tearing down the previous one", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Second Team Test",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		// First team
		const first = await apiStartTeam(token, goal.id);
		expect(first.status).toBe(201);
		const firstTeamLeadId = first.data.sessionId;

		// Spawn an agent and let it exist briefly
		const coder1 = await apiSpawnRole(token, goal.id, "coder", "First round task");
		expect(coder1.status).toBe(201);

		// Teardown the first team
		const teardownResult = await apiTeardownTeam(token, goal.id);
		expect(teardownResult.status).toBe(200);

		// Reset goal state so we can start a new team
		await apiUpdateGoal(token, goal.id, { state: "in-progress" });

		// Start a second team on the same goal
		const second = await apiStartTeam(token, goal.id);
		expect(second.status).toBe(201);
		expect(second.data.sessionId).toBeTruthy();
		expect(second.data.sessionId).not.toBe(firstTeamLeadId);
		cleanupSessionIds.push(second.data.sessionId);

		// Second team should be functional
		const coder2 = await apiSpawnRole(token, goal.id, "coder", "Second round task");
		expect(coder2.status).toBe(201);
		cleanupSessionIds.push(coder2.data.sessionId);

		// Verify second team state
		const teamState = await apiGetTeamState(token, goal.id);
		expect(teamState.status).toBe(200);
		expect(teamState.data.teamLeadSessionId).toBe(second.data.sessionId);
		expect(teamState.data.agents).toHaveLength(1);
	});

	// ── Second team after complete (not teardown) ───────────────

	test("can start a new team after completing the previous one (with teardown)", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Second Team After Complete",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		// First team
		const first = await apiStartTeam(token, goal.id);
		expect(first.status).toBe(201);
		cleanupSessionIds.push(first.data.sessionId);

		// Complete (keeps team lead alive)
		await apiCompleteTeam(token, goal.id);

		// The team entry still exists because team lead is alive.
		// We need to teardown to fully clear it before starting another.
		await apiTeardownTeam(token, goal.id);

		// Reset goal state
		await apiUpdateGoal(token, goal.id, { state: "in-progress" });

		// Start a second team
		const second = await apiStartTeam(token, goal.id);
		expect(second.status).toBe(201);
		cleanupSessionIds.push(second.data.sessionId);

		const teamState = await apiGetTeamState(token, goal.id);
		expect(teamState.status).toBe(200);
		expect(teamState.data.teamLeadSessionId).toBe(second.data.sessionId);
	});

	// ── Manual sessions in a goal alongside team ────────────────

	test("create a manual session in a team goal (no team running)", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Manual Session In Goal",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		// Create a regular session under this goal (no team started)
		const session = await apiCreateSession(token, { goalId: goal.id });
		cleanupSessionIds.push(session.id);

		expect(session.goalId).toBe(goal.id);

		// Goal should transition to in-progress
		const updatedGoal = await apiGetGoal(token, goal.id);
		expect(updatedGoal.state).toBe("in-progress");

		// Session should be in the session list under the goal
		const sessions = await apiListSessions(token);
		const found = sessions.find((s) => s.id === session.id);
		expect(found).toBeTruthy();
		expect(found!.goalId).toBe(goal.id);
	});

	test("delete a manual session in a goal", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Delete Manual Session Goal",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		const session = await apiCreateSession(token, { goalId: goal.id });

		// Delete the session
		await apiDeleteSession(token, session.id);

		// Session should be terminated or gone
		const result = await apiGetSession(token, session.id);
		if (result.data) {
			expect(result.data.status).toBe("archived");
		}
	});

	test("manual session and team coexist under the same goal", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Coexist Manual And Team",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		// Create a manual session first
		const manual = await apiCreateSession(token, { goalId: goal.id });
		cleanupSessionIds.push(manual.id);

		// Start a team
		const teamStart = await apiStartTeam(token, goal.id);
		expect(teamStart.status).toBe(201);
		cleanupSessionIds.push(teamStart.data.sessionId);

		// Spawn a coder in the team
		const coder = await apiSpawnRole(token, goal.id, "coder", "Code something");
		expect(coder.status).toBe(201);
		cleanupSessionIds.push(coder.data.sessionId);

		// Both manual and team sessions should exist under the goal
		const sessions = await apiListSessions(token);
		const goalSessions = sessions.filter((s) => s.goalId === goal.id);
		expect(goalSessions.length).toBeGreaterThanOrEqual(2); // manual + team lead + coder

		// Manual session should NOT be in team agents list
		const agents = await apiListTeamAgents(token, goal.id);
		expect(agents.find((a) => a.sessionId === manual.id)).toBeUndefined();

		// Tearing down team should not affect manual session
		await apiTeardownTeam(token, goal.id);

		const manualAfter = await apiGetSession(token, manual.id);
		expect(manualAfter.status).toBe(200);
		expect(manualAfter.data.status).not.toBe("archived");
	});

	// ── No team state for non-team goals ───────────────────────

	test("team state returns 404 for a regular goal", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Regular Goal Team 404",
			team: false,
		});
		cleanupGoalIds.push(goal.id);

		const state = await apiGetTeamState(token, goal.id);
		expect(state.status).toBe(404);
	});

	test("team agents returns empty for a goal without a team", async () => {
		const goal = await apiCreateGoal(token, {
			title: "No Team Agents",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		// No team started — agents list should be empty
		const agents = await apiListTeamAgents(token, goal.id);
		expect(agents).toHaveLength(0);
	});

	// ── Team goal with worktree ─────────────────────────────────

	test("team goal creates a worktree and branch", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Team Worktree Test",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		// Team goals in a git repo should get a worktree
		expect(goal.worktreePath).toBeTruthy();
		expect(goal.branch).toBeTruthy();
		expect(goal.branch).toMatch(/^goal\//);
		expect(goal.repoPath).toBeTruthy();

		// The worktree directory should exist
		expect(fs.existsSync(goal.worktreePath!)).toBe(true);
	});

	// ── Edge cases ───────────────────────────────────────────────

	test("teardown a team that has no agents (only team lead)", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Teardown Empty Team",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartTeam(token, goal.id);
		expect(startResult.status).toBe(201);

		// Teardown immediately — no agents spawned
		const result = await apiTeardownTeam(token, goal.id);
		expect(result.status).toBe(200);
		expect(result.data.ok).toBe(true);

		// Team should be gone
		const teamState = await apiGetTeamState(token, goal.id);
		expect(teamState.status).toBe(404);
	});

	test("complete a team with no agents (only team lead)", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Complete Empty Team",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartTeam(token, goal.id);
		expect(startResult.status).toBe(201);
		cleanupSessionIds.push(startResult.data.sessionId);

		const result = await apiCompleteTeam(token, goal.id);
		expect(result.status).toBe(200);

		// Goal should be complete
		const updatedGoal = await apiGetGoal(token, goal.id);
		expect(updatedGoal.state).toBe("complete");

		// Team lead should still be alive
		const session = await apiGetSession(token, startResult.data.sessionId);
		expect(session.data.status).not.toBe("archived");
	});

	test("teardown a nonexistent team returns 400", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Teardown Nonexistent",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		const result = await apiTeardownTeam(token, goal.id);
		expect(result.status).toBe(400);
	});

	test("complete a nonexistent team returns 400", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Complete Nonexistent",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		const result = await apiCompleteTeam(token, goal.id);
		expect(result.status).toBe(400);
	});

	test("spawn without active team returns 400", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Spawn No Team",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		const result = await apiSpawnRole(token, goal.id, "coder", "Do work");
		expect(result.status).toBe(400);
	});

	// ── Full lifecycle: create → team → agents → complete → teardown → new team

	test("full lifecycle: create goal, team, spawn agents, complete, teardown, second team", async () => {
		// Step 1: Create a team goal
		const goal = await apiCreateGoal(token, {
			title: "Full Lifecycle Test",
			team: true,
			spec: "Complete lifecycle test",
		});
		cleanupGoalIds.push(goal.id);
		expect(goal.state).toBe("todo");

		// Step 2: Start first team
		const firstTeam = await apiStartTeam(token, goal.id);
		expect(firstTeam.status).toBe(201);
		const firstTeamLeadId = firstTeam.data.sessionId;

		const goalInProgress = await apiGetGoal(token, goal.id);
		expect(goalInProgress.state).toBe("in-progress");

		// Step 3: Spawn agents
		const coder = await apiSpawnRole(token, goal.id, "coder", "Implement feature");
		expect(coder.status).toBe(201);
		const tester = await apiSpawnRole(token, goal.id, "tester", "Write tests");
		expect(tester.status).toBe(201);

		// Verify all 2 agents in state
		let agents = await apiListTeamAgents(token, goal.id);
		expect(agents).toHaveLength(2);

		// Step 4: Dismiss one agent
		await apiDismissRole(token, goal.id, coder.data.sessionId);
		agents = await apiListTeamAgents(token, goal.id);
		expect(agents).toHaveLength(1);
		expect(agents[0].role).toBe("tester");

		// Step 5: Complete the team (dismisses remaining agents, keeps team lead)
		const completeResult = await apiCompleteTeam(token, goal.id);
		expect(completeResult.status).toBe(200);

		const goalComplete = await apiGetGoal(token, goal.id);
		expect(goalComplete.state).toBe("complete");

		agents = await apiListTeamAgents(token, goal.id);
		expect(agents).toHaveLength(0);

		// Team lead still alive
		const teamLeadAfterComplete = await apiGetSession(token, firstTeamLeadId);
		expect(teamLeadAfterComplete.data.status).not.toBe("archived");

		// Step 6: Teardown completely
		const teardownResult = await apiTeardownTeam(token, goal.id);
		expect(teardownResult.status).toBe(200);

		// Team gone
		const teamAfterTeardown = await apiGetTeamState(token, goal.id);
		expect(teamAfterTeardown.status).toBe(404);

		// Team lead terminated
		const teamLeadAfterTeardown = await apiGetSession(token, firstTeamLeadId);
		if (teamLeadAfterTeardown.data) {
			expect(teamLeadAfterTeardown.data.status).toBe("archived");
		}

		// Step 7: Reset goal state and start second team
		await apiUpdateGoal(token, goal.id, { state: "in-progress" });

		const secondTeam = await apiStartTeam(token, goal.id);
		expect(secondTeam.status).toBe(201);
		expect(secondTeam.data.sessionId).not.toBe(firstTeamLeadId);
		cleanupSessionIds.push(secondTeam.data.sessionId);

		// Step 8: Verify second team works
		const coder2 = await apiSpawnRole(token, goal.id, "coder", "New implementation");
		expect(coder2.status).toBe(201);
		cleanupSessionIds.push(coder2.data.sessionId);

		const secondState = await apiGetTeamState(token, goal.id);
		expect(secondState.status).toBe(200);
		expect(secondState.data.teamLeadSessionId).toBe(secondTeam.data.sessionId);
		expect(secondState.data.agents).toHaveLength(1);
	});

	// ── Multiple goals with independent teams ───────────────────

	test("independent teams on different goals do not interfere", async () => {
		const goal1 = await apiCreateGoal(token, {
			title: "Independent Team A",
			team: true,
		});
		cleanupGoalIds.push(goal1.id);

		const goal2 = await apiCreateGoal(token, {
			title: "Independent Team B",
			team: true,
		});
		cleanupGoalIds.push(goal2.id);

		// Start teams on both goals
		const team1 = await apiStartTeam(token, goal1.id);
		expect(team1.status).toBe(201);
		cleanupSessionIds.push(team1.data.sessionId);

		const team2 = await apiStartTeam(token, goal2.id);
		expect(team2.status).toBe(201);
		cleanupSessionIds.push(team2.data.sessionId);

		// Spawn agents on goal 1
		const coder1 = await apiSpawnRole(token, goal1.id, "coder", "Task for goal 1");
		expect(coder1.status).toBe(201);
		cleanupSessionIds.push(coder1.data.sessionId);

		// Spawn agents on goal 2
		const reviewer2 = await apiSpawnRole(token, goal2.id, "reviewer", "Task for goal 2");
		expect(reviewer2.status).toBe(201);
		cleanupSessionIds.push(reviewer2.data.sessionId);

		// Verify each team has its own agents
		const agents1 = await apiListTeamAgents(token, goal1.id);
		expect(agents1).toHaveLength(1);
		expect(agents1[0].role).toBe("coder");

		const agents2 = await apiListTeamAgents(token, goal2.id);
		expect(agents2).toHaveLength(1);
		expect(agents2[0].role).toBe("reviewer");

		// Teardown goal 1's team — should not affect goal 2
		await apiTeardownTeam(token, goal1.id);

		const state2After = await apiGetTeamState(token, goal2.id);
		expect(state2After.status).toBe(200);
		expect(state2After.data.agents).toHaveLength(1);
	});

	// ── Deleting a goal that had a team ─────────────────────────

	test("deleting a team goal does not crash (team not running)", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Delete Team Goal",
			team: true,
		});

		// Delete without starting a team
		await apiDeleteGoal(token, goal.id);

		// Goal should be gone
		const res = await fetch(`${GW_URL}/api/goals/${goal.id}`, { headers: headers(token) });
		expect(res.status).toBe(404);
	});

	// ── Session listing with team metadata ──────────────────────

	test("session list includes team role and goal metadata", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Session Metadata Test",
			team: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartTeam(token, goal.id);
		expect(startResult.status).toBe(201);
		cleanupSessionIds.push(startResult.data.sessionId);

		const coder = await apiSpawnRole(token, goal.id, "coder", "Implement feature");
		expect(coder.status).toBe(201);
		cleanupSessionIds.push(coder.data.sessionId);

		const sessions = await apiListSessions(token);

		const teamLead = sessions.find((s) => s.id === startResult.data.sessionId);
		expect(teamLead).toBeTruthy();
		expect(teamLead!.role).toBe("team-lead");
		expect(teamLead!.teamGoalId).toBe(goal.id);
		expect(teamLead!.goalId).toBe(goal.id);

		const coderSession = sessions.find((s) => s.id === coder.data.sessionId);
		expect(coderSession).toBeTruthy();
		expect(coderSession!.role).toBe("coder");
		expect(coderSession!.teamGoalId).toBe(goal.id);
	});
});
