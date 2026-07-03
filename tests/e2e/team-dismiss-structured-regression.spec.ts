import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession, startTeam, teardownTeam } from "./e2e-setup.js";

async function orchestrate(ownerId: string, verb: string, body?: unknown): Promise<{ status: number; json: any }> {
	const resp = await apiFetch(`/api/sessions/${ownerId}/orchestrate/${verb}`, {
		method: "POST",
		body: JSON.stringify(body ?? {}),
	});
	let json: any = undefined;
	try { json = await resp.json(); } catch { /* empty */ }
	return { status: resp.status, json };
}

async function goalTeamDismiss(goalId: string, sessionId: string): Promise<{ status: number; json: any }> {
	const resp = await apiFetch(`/api/goals/${goalId}/team/dismiss`, {
		method: "POST",
		body: JSON.stringify({ sessionId }),
	});
	let json: any = undefined;
	try { json = await resp.json(); } catch { /* empty */ }
	return { status: resp.status, json };
}

async function goalTeamSpawn(goalId: string): Promise<{ status: number; json: any }> {
	const resp = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
		method: "POST",
		body: JSON.stringify({ role: "coder", task: "structured dismiss real worker" }),
	});
	let json: any = undefined;
	try { json = await resp.json(); } catch { /* empty */ }
	return { status: resp.status, json };
}

async function goalTeamAgents(goalId: string): Promise<any[]> {
	const resp = await apiFetch(`/api/goals/${goalId}/team/agents`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	return Array.isArray(body?.agents) ? body.agents : [];
}

function expectStructuredAlreadyDismissed(result: { status: number; json: any }, sessionId: string): void {
	const body = result.json;
	const valid = result.status === 200
		&& body?.ok === true
		&& body?.status === "already-dismissed"
		&& body?.sessionId === sessionId
		&& typeof body?.message === "string"
		&& body.message.length > 0
		&& body?.retryable === false;
	expect(valid, `expected structured already-dismissed dismiss result for ${sessionId}; got http ${result.status} ${JSON.stringify(body)}`).toBe(true);
}

test.describe("team_dismiss duplicate dismiss regression", () => {
	test("/api/sessions/:id/orchestrate/dismiss duplicate owned-child dismiss is structured already-dismissed", async () => {
		const parent = await createSession();
		let childId: string | undefined;
		try {
			const spawn = await orchestrate(parent, "spawn", { instructions: "duplicate dismiss child" });
			expect(spawn.status).toBe(201);
			childId = spawn.json.childSessionId as string;
			expect(childId).toBeTruthy();

			const first = await orchestrate(parent, "dismiss", { childSessionId: childId });
			expect(first.status).toBe(200);
			expect(first.json?.ok).toBe(true);

			const duplicate = await orchestrate(parent, "dismiss", { childSessionId: childId });
			expectStructuredAlreadyDismissed(duplicate, childId);
			childId = undefined;
		} finally {
			if (childId) await orchestrate(parent, "dismiss", { childSessionId: childId }).catch(() => {});
			await deleteSession(parent);
		}
	});

	test("/api/goals/:id/team/dismiss duplicate team-agent dismiss is structured already-dismissed", async ({ gateway }) => {
		const goal = await createGoal({ title: "Structured duplicate team dismiss", team: true });
		let agentId: string | undefined;
		try {
			await startTeam(goal.id as string);
			agentId = await createSession({ goalId: goal.id as string });
			gateway.teamManager.registerReviewerSession(goal.id as string, agentId, "structured-dismiss-regression");

			const first = await goalTeamDismiss(goal.id as string, agentId);
			expect(first.status).toBe(200);
			expect(first.json?.ok).toBe(true);

			const duplicate = await goalTeamDismiss(goal.id as string, agentId);
			expectStructuredAlreadyDismissed(duplicate, agentId);
			agentId = undefined;
		} finally {
			if (agentId) await goalTeamDismiss(goal.id as string, agentId).catch(() => {});
			await teardownTeam(goal.id as string).catch(() => {});
			await deleteGoal(goal.id as string).catch(() => {});
		}
	});

	test("/api/goals/:id/team/dismiss real core-registered team worker uses TeamManager cleanup", async () => {
		const goal = await createGoal({ title: "Structured real team worker dismiss", team: true });
		let agentId: string | undefined;
		try {
			await startTeam(goal.id as string);
			const spawned = await goalTeamSpawn(goal.id as string);
			expect(spawned.status).toBe(201);
			agentId = spawned.json?.sessionId as string;
			expect(agentId).toBeTruthy();
			expect((await goalTeamAgents(goal.id as string)).some((agent) => agent.sessionId === agentId)).toBe(true);

			const first = await goalTeamDismiss(goal.id as string, agentId);
			expect(first.status).toBe(200);
			expect(first.json?.ok).toBe(true);
			expect(first.json?.status).toBe("dismissed");
			expect(first.json?.message).toContain("Team agent");
			expect((await goalTeamAgents(goal.id as string)).some((agent) => agent.sessionId === agentId)).toBe(false);

			const duplicate = await goalTeamDismiss(goal.id as string, agentId);
			expectStructuredAlreadyDismissed(duplicate, agentId);
			agentId = undefined;
		} finally {
			if (agentId) await goalTeamDismiss(goal.id as string, agentId).catch(() => {});
			await teardownTeam(goal.id as string).catch(() => {});
			await deleteGoal(goal.id as string).catch(() => {});
		}
	});

	test("/api/goals/:id/team/dismiss own-child fallback duplicate dismiss is structured already-dismissed", async () => {
		const goal = await createGoal({ title: "Structured duplicate fallback dismiss", team: true });
		let leadId: string | undefined;
		let childId: string | undefined;
		try {
			leadId = await startTeam(goal.id as string);
			expect(leadId).toBeTruthy();

			const spawn = await orchestrate(leadId!, "spawn", { instructions: "lead fallback duplicate dismiss child" });
			expect(spawn.status).toBe(201);
			childId = spawn.json.childSessionId as string;
			expect(childId).toBeTruthy();

			const first = await goalTeamDismiss(goal.id as string, childId);
			expect(first.status).toBe(200);
			expect(first.json?.ok).toBe(true);

			const duplicate = await goalTeamDismiss(goal.id as string, childId);
			expectStructuredAlreadyDismissed(duplicate, childId);
			childId = undefined;
		} finally {
			if (leadId && childId) await orchestrate(leadId, "dismiss", { childSessionId: childId }).catch(() => {});
			await teardownTeam(goal.id as string).catch(() => {});
			await deleteGoal(goal.id as string).catch(() => {});
		}
	});
});
