import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, createSession, defaultProjectId, deleteGoal, deleteSession } from "./_e2e/e2e-setup.js";

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

async function sandboxGoalTeamDismiss(baseURL: string, token: string, goalId: string, sessionId: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
	const resp = await fetch(`${baseURL}/api/goals/${goalId}/team/dismiss`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
		body: JSON.stringify({ sessionId }),
	});
	let json: any = undefined;
	try { json = await resp.json(); } catch { /* empty */ }
	return { status: resp.status, json };
}

function seedTeam(gateway: any, goalId: string, leadId: string): void {
	gateway.teamManager.teams.set(goalId, {
		goalId,
		teamLeadSessionId: leadId,
		agents: [],
		maxConcurrent: 12,
	});
}

function dropTeam(gateway: any, goalId: string): void {
	gateway.teamManager.teams.delete(goalId);
}

async function createOwnedChild(gateway: any, ownerId: string): Promise<string> {
	const childId = await createSession();
	gateway.sessionManager.updateSessionMeta(childId, {
		delegateOf: ownerId,
		parentSessionId: ownerId,
		childKind: "delegate",
	});
	gateway.orchestrationCore.registerChild({
		sessionId: childId,
		ownerSessionId: ownerId,
		childKind: "delegate",
	});
	return childId;
}

async function createTeamWorker(gateway: any, goalId: string, label: string): Promise<string> {
	const sessionId = await createSession({ goalId });
	gateway.teamManager.registerReviewerSession(goalId, sessionId, label);
	return sessionId;
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

function expectStructuredNotOwned(result: { status: number; json: any }, sessionId: string): void {
	const body = result.json;
	const valid = result.status === 403
		&& body?.ok === false
		&& body?.status === "not-owned"
		&& body?.sessionId === sessionId
		&& typeof body?.message === "string"
		&& body.message.length > 0
		&& body?.retryable === false;
	expect(valid, `expected structured not-owned dismiss result for ${sessionId}; got http ${result.status} ${JSON.stringify(body)}`).toBe(true);
}

let sharedOwnerId: string;

test.beforeAll(async () => {
	sharedOwnerId = await createSession();
});

test.afterAll(async () => {
	await deleteSession(sharedOwnerId).catch(() => {});
});

test.describe("team_dismiss duplicate dismiss regression", () => {
	test("/api/sessions/:id/orchestrate/dismiss duplicate owned-child dismiss is structured already-dismissed", async ({ gateway }) => {
		const parent = sharedOwnerId;
		let childId: string | undefined;
		try {
			childId = await createOwnedChild(gateway, parent);
			expect(childId).toBeTruthy();

			const first = await orchestrate(parent, "dismiss", { childSessionId: childId });
			expect(first.status).toBe(200);
			expect(first.json?.ok).toBe(true);

			const duplicate = await orchestrate(parent, "dismiss", { childSessionId: childId });
			expectStructuredAlreadyDismissed(duplicate, childId);
			childId = undefined;
		} finally {
			if (childId) await orchestrate(parent, "dismiss", { childSessionId: childId }).catch(() => {});
		}
	});

	test("/api/goals/:id/team/dismiss duplicate team-agent dismiss is structured already-dismissed", async ({ gateway }) => {
		const goal = await createGoal({ title: "Structured duplicate team dismiss", team: true });
		let agentId: string | undefined;
		try {
			seedTeam(gateway, goal.id as string, sharedOwnerId);
			agentId = await createTeamWorker(gateway, goal.id as string, "structured-dismiss-regression");

			const first = await goalTeamDismiss(goal.id as string, agentId);
			expect(first.status).toBe(200);
			expect(first.json?.ok).toBe(true);

			const duplicate = await goalTeamDismiss(goal.id as string, agentId);
			expectStructuredAlreadyDismissed(duplicate, agentId);
			agentId = undefined;
		} finally {
			if (agentId) await goalTeamDismiss(goal.id as string, agentId).catch(() => {});
			dropTeam(gateway, goal.id as string);
			await deleteGoal(goal.id as string).catch(() => {});
		}
	});

	test("/api/goals/:id/team/dismiss real core-registered team worker uses TeamManager cleanup", async ({ gateway }) => {
		const goal = await createGoal({ title: "Structured real team worker dismiss", team: true });
		let agentId: string | undefined;
		try {
			seedTeam(gateway, goal.id as string, sharedOwnerId);
			agentId = await createTeamWorker(gateway, goal.id as string, "structured-real-worker");
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
			dropTeam(gateway, goal.id as string);
			await deleteGoal(goal.id as string).catch(() => {});
		}
	});

	test("/api/goals/:id/team/dismiss denies same-goal non-lead sandbox callers before TeamManager cleanup", async ({ gateway }) => {
		const goal = await createGoal({ title: "Structured dismiss team-lead authz", team: true });
		let attackerId: string | undefined;
		let victimId: string | undefined;
		try {
			seedTeam(gateway, goal.id as string, sharedOwnerId);
			attackerId = await createTeamWorker(gateway, goal.id as string, "structured-attacker");
			expect(attackerId).toBeTruthy();

			victimId = await createTeamWorker(gateway, goal.id as string, "structured-victim");
			expect(victimId).toBeTruthy();

			const projectId = (goal.projectId as string | undefined) ?? await defaultProjectId();
			if (!projectId) throw new Error("Expected a project id for sandbox token registration");
			const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(projectId);
			gateway.sessionManager.sandboxTokenStore.addGoal(projectId, goal.id as string);
			gateway.sessionManager.sandboxTokenStore.addSession(projectId, attackerId!);
			const attackerSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(attackerId!);

			const noSecret = await sandboxGoalTeamDismiss(gateway.baseURL, sandboxToken, goal.id as string, victimId!);
			expectStructuredNotOwned(noSecret, victimId!);

			const attackerAttempt = await sandboxGoalTeamDismiss(gateway.baseURL, sandboxToken, goal.id as string, victimId!, {
				"X-Bobbit-Session-Secret": attackerSecret,
			});
			expectStructuredNotOwned(attackerAttempt, victimId!);
			expect((await goalTeamAgents(goal.id as string)).some((agent) => agent.sessionId === victimId)).toBe(true);

			const leadDismiss = await goalTeamDismiss(goal.id as string, victimId!);
			expect(leadDismiss.status).toBe(200);
			expect(leadDismiss.json?.ok).toBe(true);
			expect(leadDismiss.json?.status).toBe("dismissed");
			victimId = undefined;
		} finally {
			if (victimId) await goalTeamDismiss(goal.id as string, victimId).catch(() => {});
			if (attackerId) await goalTeamDismiss(goal.id as string, attackerId).catch(() => {});
			dropTeam(gateway, goal.id as string);
			await deleteGoal(goal.id as string).catch(() => {});
		}
	});

	test("/api/goals/:id/team/dismiss own-child fallback duplicate dismiss is structured already-dismissed", async ({ gateway }) => {
		const goal = await createGoal({ title: "Structured duplicate fallback dismiss", team: true });
		const leadId = sharedOwnerId;
		let childId: string | undefined;
		try {
			seedTeam(gateway, goal.id as string, leadId);
			expect(leadId).toBeTruthy();

			childId = await createOwnedChild(gateway, leadId);
			expect(childId).toBeTruthy();

			const first = await goalTeamDismiss(goal.id as string, childId);
			expect(first.status).toBe(200);
			expect(first.json?.ok).toBe(true);

			const duplicate = await goalTeamDismiss(goal.id as string, childId);
			expectStructuredAlreadyDismissed(duplicate, childId);
			childId = undefined;
		} finally {
			if (childId) await orchestrate(leadId, "dismiss", { childSessionId: childId }).catch(() => {});
			dropTeam(gateway, goal.id as string);
			await deleteGoal(goal.id as string).catch(() => {});
		}
	});
});
