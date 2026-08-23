/**
 * Real API lifecycle coverage for an explicit Start team request on a paused
 * goal. The route must resume through the canonical lifecycle before creating
 * a lead, and must remain safe when the same start is requested repeatedly.
 */
import { vi } from "vitest";
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	connectWs,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	rawApiFetch,
	teardownTeam,
	waitForSessionStatus,
} from "./_e2e/e2e-setup.js";

type Goal = { id: string; state: string; paused?: boolean; archived?: boolean };
type StartBody = { sessionId?: string; title?: string; error?: string; code?: string; goalId?: string; stack?: string };

async function createManualTeamGoal(label: string): Promise<Goal> {
	return createGoal({
		title: `Paused team start ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		team: true,
		autoStartTeam: false,
		worktree: false,
		spec: "# Start team lifecycle\n\nThis manual team-start goal has a complete specification.",
	}) as Promise<Goal>;
}

async function getGoal(goalId: string): Promise<Goal> {
	const response = await apiFetch(`/api/goals/${goalId}`);
	expect(response.status).toBe(200);
	return response.json();
}

async function start(goalId: string, headers?: Record<string, string>): Promise<{ response: Response; body: StartBody }> {
	const response = await rawApiFetch(`/api/goals/${goalId}/team/start`, { method: "POST", headers });
	return { response, body: await response.json() };
}

let humanCookie = "";

test.beforeAll(async () => {
	// Mint the same signed UI cookie that authorizes the canonical resume route.
	const response = await rawApiFetch("/api/goals", {
		headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
	});
	const setCookies = (response.headers as any).getSetCookie?.() as string[] | undefined
		?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : []);
	humanCookie = setCookies.map(cookie => cookie.split(";")[0]).find(cookie => cookie.startsWith("bobbit_session=")) ?? "";
	expect(humanCookie, "browser-signaled operator auth must mint a signed cookie").not.toBe("");
});

function humanHeaders(): Record<string, string> {
	return { Cookie: humanCookie };
}

test.describe("paused team-start API lifecycle", () => {
	test("POST /team/start resumes a paused goal, persists the live state, and broadcasts it before starting the lead", async () => {
		const goal = await createManualTeamGoal("resume");
		const observerId = await createSession();
		const observer = await connectWs(observerId);
		try {
			const pause = await apiFetch(`/api/goals/${goal.id}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: false }),
			});
			expect(pause.status).toBe(200);
			expect((await getGoal(goal.id)).paused).toBe(true);

			const cursor = observer.messageCount();
			const { response, body } = await start(goal.id, humanHeaders());
			expect(response.status, JSON.stringify(body)).toBe(201);
			expect(body.sessionId).toEqual(expect.any(String));
			await observer.waitForFrom(cursor, message => message.type === "goal_state_changed" && message.goalId === goal.id);

			const resumed = await getGoal(goal.id);
			expect(resumed).toMatchObject({ id: goal.id, paused: false, state: "in-progress" });
			const team = await apiFetch(`/api/goals/${goal.id}/team`);
			expect(team.status).toBe(200);
			expect((await team.json()).teamLeadSessionId).toBe(body.sessionId);
		} finally {
			observer.close();
			await teardownTeam(goal.id);
			await deleteSession(observerId);
			await deleteGoal(goal.id);
		}
	});

	test("POST /team/start retry releases one retained guarded prompt without duplicate activity", async ({ gateway }) => {
		const goal = await createManualTeamGoal("guarded resume");
		let leadId: string | undefined;
		let prompt: any;
		let redrain: any;
		try {
			const initial = await start(goal.id);
			expect(initial.response.status, JSON.stringify(initial.body)).toBe(201);
			leadId = initial.body.sessionId;
			expect(leadId).toEqual(expect.any(String));
			await waitForSessionStatus(leadId!, "idle", 30_000);

			const context = gateway.projectContextManager.getContextForGoal(goal.id);
			await context.goalStore.updateStrict(goal.id, {
				setupStatus: "ready",
				worktreeOwnerSessionId: leadId,
			});
			const live = gateway.sessionManager.getSession(leadId!);
			prompt = vi.spyOn(live.rpcClient, "prompt");
			const text = `team-start resume guarded prompt ${goal.id}`;
			const intentId = `team-start-resume:${goal.id}`;

			const pause = await apiFetch(`/api/goals/${goal.id}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: false }),
			});
			expect(pause.status).toBe(200);
			await gateway.sessionManager.enqueuePrompt(leadId!, text, {
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

			// Model interruption after startTeam commits the pause clear but before
			// its nonblocking release can begin. The durable guarded row survives.
			redrain = vi.spyOn(gateway.sessionManager, "drainGoalGuardedPrompts")
				.mockImplementationOnce(() => {});
			const resumed = await start(goal.id, humanHeaders());
			expect(resumed.response.status, JSON.stringify(resumed.body)).toBe(201);
			expect(resumed.body.sessionId).toBe(leadId);
			expect(redrain).toHaveBeenCalledTimes(1);
			expect((await getGoal(goal.id)).paused).toBe(false);
			expect(prompt).not.toHaveBeenCalled();
			expect(live.promptQueue.toArray()).toEqual([
				expect.objectContaining({ id: intentId, text, goalDispatchGuardId: goal.id }),
			]);

			redrain.mockClear();
			const retry = await start(goal.id);
			expect(retry.response.status, JSON.stringify(retry.body)).toBe(201);
			expect(retry.body.sessionId).toBe(leadId);
			expect(redrain).toHaveBeenCalledTimes(1);
			await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
			expect(prompt.mock.calls[0]?.[0]).toMatch(new RegExp(`${text}$`));
			expect(live.promptQueue.toArray()).toEqual([]);

			const repeated = await start(goal.id);
			expect(repeated.response.status, JSON.stringify(repeated.body)).toBe(201);
			expect(repeated.body.sessionId).toBe(leadId);
			expect(redrain).toHaveBeenCalledTimes(2);
			expect(prompt).toHaveBeenCalledTimes(1);
		} finally {
			redrain?.mockRestore();
			prompt?.mockRestore();
			const context = gateway.projectContextManager.getContextForGoal(goal.id);
			const cleanupGoal = context?.goalStore.get(goal.id);
			if (cleanupGoal) delete cleanupGoal.worktreeOwnerSessionId;
			await teardownTeam(goal.id);
			await deleteGoal(goal.id);
		}
	});

	test("POST /team/start retains ordinary active-goal behavior", async () => {
		const goal = await createManualTeamGoal("active");
		try {
			const activate = await apiFetch(`/api/goals/${goal.id}`, {
				method: "PUT",
				body: JSON.stringify({ state: "in-progress" }),
			});
			expect(activate.status).toBe(200);

			const { response, body } = await start(goal.id);
			expect(response.status, JSON.stringify(body)).toBe(201);
			expect(body.sessionId).toEqual(expect.any(String));
			// Every REST start is explicitly idempotent, including an active
			// snapshot that has no paused-goal resume authority.
			const repeated = await start(goal.id);
			expect(repeated.response.status, JSON.stringify(repeated.body)).toBe(201);
			expect(repeated.body.sessionId).toBe(body.sessionId);
			const active = await getGoal(goal.id);
			expect(active).toMatchObject({ id: goal.id, state: "in-progress" });
			expect(active.paused).not.toBe(true);
		} finally {
			await teardownTeam(goal.id);
			await deleteGoal(goal.id);
		}
	});

	test("POST /team/start preserves a completed goal's ordinary restart after team teardown", async () => {
		const goal = await createManualTeamGoal("completed restart");
		try {
			const initial = await start(goal.id);
			expect(initial.response.status, JSON.stringify(initial.body)).toBe(201);
			await teardownTeam(goal.id);

			const complete = await apiFetch(`/api/goals/${goal.id}`, {
				method: "PUT",
				body: JSON.stringify({ state: "complete" }),
			});
			expect(complete.status).toBe(200);

			const restarted = await start(goal.id);
			expect(restarted.response.status, JSON.stringify(restarted.body)).toBe(201);
			expect(restarted.body.sessionId).toEqual(expect.any(String));
			expect(restarted.body.sessionId).not.toBe(initial.body.sessionId);
		} finally {
			await teardownTeam(goal.id);
			await deleteGoal(goal.id);
		}
	});

	test("POST /team/start revalidates a non-startable mutation after paused resume", async ({ gateway }) => {
		const goal = await createManualTeamGoal("post-resume mutation");
		const context = gateway.projectContextManager.getContextForGoal(goal.id);
		const originalUpdateGoal = context.goalManager.updateGoal.bind(context.goalManager);
		let mutatedAfterResume = false;
		const updateGoal = vi.spyOn(context.goalManager, "updateGoal").mockImplementation(async (goalId, updates) => {
			const result = await originalUpdateGoal(goalId, updates);
			if (goalId === goal.id && (updates as { paused?: boolean }).paused === false && !mutatedAfterResume) {
				mutatedAfterResume = true;
				await originalUpdateGoal(goalId, { state: "complete" });
			}
			return result;
		});
		try {
			const pause = await apiFetch(`/api/goals/${goal.id}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: false }),
			});
			expect(pause.status).toBe(200);

			const { response, body } = await start(goal.id, humanHeaders());
			expect(response.status, JSON.stringify(body)).toBe(409);
			expect(body).toMatchObject({ code: "GOAL_COMPLETE", goalId: goal.id });
			expect(mutatedAfterResume).toBe(true);
			expect((await getGoal(goal.id))).toMatchObject({ paused: false, state: "complete" });
			expect(gateway.teamManager.getTeamState(goal.id)).toBeUndefined();
		} finally {
			updateGoal.mockRestore();
			await teardownTeam(goal.id);
			await deleteGoal(goal.id);
		}
	});

	test("concurrent and repeated paused POST /team/start requests return one canonical team lead", async ({ gateway }) => {
		const goal = await createManualTeamGoal("idempotent");
		try {
			const pause = await apiFetch(`/api/goals/${goal.id}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: false }),
			});
			expect(pause.status).toBe(200);
			const concurrent = await Promise.all(Array.from({ length: 4 }, () => start(goal.id, humanHeaders())));
			for (const result of concurrent) expect(result.response.status, JSON.stringify(result.body)).toBe(201);
			const leadIds = new Set(concurrent.map(result => result.body.sessionId));
			expect(leadIds.size).toBe(1);
			const [leadId] = leadIds;
			expect(leadId).toEqual(expect.any(String));

			const repeated = await start(goal.id, humanHeaders());
			expect(repeated.response.status, JSON.stringify(repeated.body)).toBe(201);
			expect(repeated.body.sessionId).toBe(leadId);

			const team = await apiFetch(`/api/goals/${goal.id}/team`);
			expect(team.status).toBe(200);
			expect((await team.json()).teamLeadSessionId).toBe(leadId);
			expect(gateway.teamManager.getTeamState(goal.id)?.teamLeadSessionId).toBe(leadId);
			const liveLeads = gateway.sessionManager.listSessions()
				.filter((session: any) => session.goalId === goal.id && session.role === "team-lead");
			expect(liveLeads).toEqual([expect.objectContaining({ id: leadId })]);
		} finally {
			await teardownTeam(goal.id);
			await deleteGoal(goal.id);
		}
	});

	test("rejects unauthorized paused starts without resuming or creating a session", async ({ gateway }) => {
		const goal = await createManualTeamGoal("authz");
		let foreignSessionId: string | undefined;
		try {
			const active = await start(goal.id);
			expect(active.response.status, JSON.stringify(active.body)).toBe(201);
			const leadId = active.body.sessionId!;
			const pause = await apiFetch(`/api/goals/${goal.id}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: false }),
			});
			expect(pause.status).toBe(200);
			foreignSessionId = await createSession();
			const foreignSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(foreignSessionId);
			const leadCount = () => gateway.sessionManager.listSessions()
				.filter((session: any) => session.goalId === goal.id && session.role === "team-lead").length;
			const initialLeadCount = leadCount();

			for (const [label, headers] of [
				["Bearer only", {}],
				["forged public lead header", { "X-Bobbit-Spawning-Session": leadId }],
				["foreign session secret", { "X-Bobbit-Session-Secret": foreignSecret }],
			] as const) {
				const result = await start(goal.id, headers);
				expect(result.response.status, `${label}: ${JSON.stringify(result.body)}`).toBe(403);
				expect(result.body).toMatchObject({
					code: "NOT_TEAM_LEAD",
					error: expect.stringMatching(/authorized/i),
					goalId: goal.id,
				});
				expect((await getGoal(goal.id)).paused, `${label} must not resume the goal`).toBe(true);
				expect(leadCount(), `${label} must not create another team lead`).toBe(initialLeadCount);
				expect(gateway.teamManager.getTeamState(goal.id)?.teamLeadSessionId).toBe(leadId);
			}

			// An established lead can use its authentic secret, unlike the forged
			// public identity header above.
			const leadSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(leadId);
			const authorized = await start(goal.id, { "X-Bobbit-Session-Secret": leadSecret });
			expect(authorized.response.status, JSON.stringify(authorized.body)).toBe(201);
			expect(authorized.body.sessionId).toBe(leadId);
			expect((await getGoal(goal.id)).paused).not.toBe(true);
			expect(leadCount()).toBe(initialLeadCount);
		} finally {
			await teardownTeam(goal.id);
			if (foreignSessionId) await deleteSession(foreignSessionId);
			await deleteGoal(goal.id);
		}
	});

	test("paused non-resumable goals return concise structured errors without starting a team", async ({ gateway }) => {
		const cases = [
			{ label: "blocked", patch: { state: "blocked" }, code: "GOAL_BLOCKED" },
			{ label: "archived", patch: { archived: true, archivedAt: Date.now() }, code: "GOAL_ARCHIVED" },
			{ label: "complete", patch: { state: "complete" }, code: "GOAL_COMPLETE" },
			{ label: "shelved", patch: { state: "shelved" }, code: "GOAL_SHELVED" },
			{ label: "setup incomplete", patch: { setupStatus: "preparing" }, code: "GOAL_SETUP_INCOMPLETE" },
			{ label: "team disabled", patch: { team: false }, code: "TEAM_DISABLED" },
		] as const;
		for (const { label, patch, code } of cases) {
			const goal = await createManualTeamGoal(label);
			const context = gateway.projectContextManager.getContextForGoal(goal.id);
			try {
				context.goalStore.update(goal.id, { ...patch, paused: true });

				const { response, body } = await start(goal.id, humanHeaders());
				expect(response.status, `${label}: ${JSON.stringify(body)}`).toBe(409);
				expect(body).toMatchObject({ code, error: expect.any(String), goalId: goal.id });
				expect(body.error).not.toMatch(/GoalPausedError|\n\s*at\s|\bstack\b/i);
				expect(body.stack).toBeUndefined();
				expect((await getGoal(goal.id)).paused, `${label} must not resume`).toBe(true);
				expect(gateway.teamManager.getTeamState(goal.id)).toBeUndefined();
			} finally {
				context.goalStore.update(goal.id, { archived: false, paused: false, state: "todo", team: true, setupStatus: "ready" });
				await teardownTeam(goal.id);
				await deleteGoal(goal.id);
			}
		}
	});
});
