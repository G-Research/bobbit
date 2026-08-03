/**
 * Real API lifecycle coverage for an explicit Start team request on a paused
 * goal. The route must resume through the canonical lifecycle before creating
 * a lead, and must remain safe when the same start is requested repeatedly.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	connectWs,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	teardownTeam,
} from "./_e2e/e2e-setup.js";

type Goal = { id: string; state: string; paused?: boolean; archived?: boolean };
type StartBody = { sessionId?: string; title?: string; error?: string; code?: string; stack?: string };

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

async function start(goalId: string): Promise<{ response: Response; body: StartBody }> {
	const response = await apiFetch(`/api/goals/${goalId}/team/start`, { method: "POST" });
	return { response, body: await response.json() };
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
			const { response, body } = await start(goal.id);
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
			const active = await getGoal(goal.id);
			expect(active).toMatchObject({ id: goal.id, state: "in-progress" });
			expect(active.paused).not.toBe(true);
		} finally {
			await teardownTeam(goal.id);
			await deleteGoal(goal.id);
		}
	});

	test("concurrent and repeated POST /team/start requests return one canonical team lead", async ({ gateway }) => {
		const goal = await createManualTeamGoal("idempotent");
		try {
			const concurrent = await Promise.all(Array.from({ length: 4 }, () => start(goal.id)));
			for (const result of concurrent) expect(result.response.status, JSON.stringify(result.body)).toBe(201);
			const leadIds = new Set(concurrent.map(result => result.body.sessionId));
			expect(leadIds.size).toBe(1);
			const [leadId] = leadIds;
			expect(leadId).toEqual(expect.any(String));

			const repeated = await start(goal.id);
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

	test("non-resumable goals return concise structured errors without starting a team", async ({ gateway }) => {
		for (const state of ["complete", "shelved", "archived"] as const) {
			const goal = await createManualTeamGoal(state);
			const context = gateway.projectContextManager.getContextForGoal(goal.id);
			try {
				if (state === "archived") {
					context.goalStore.update(goal.id, { archived: true, archivedAt: Date.now() });
				} else {
					const update = await apiFetch(`/api/goals/${goal.id}`, {
						method: "PUT",
						body: JSON.stringify({ state }),
					});
					expect(update.status).toBe(200);
				}

				const { response, body } = await start(goal.id);
				expect(response.status, `${state}: ${JSON.stringify(body)}`).toBe(409);
				expect(body).toMatchObject({ code: expect.any(String), error: expect.stringMatching(new RegExp(state, "i")) });
				expect(body.error).not.toMatch(/GoalPausedError|\n\s*at\s|\bstack\b/i);
				expect(body.stack).toBeUndefined();
				expect(gateway.teamManager.getTeamState(goal.id)).toBeUndefined();
			} finally {
				context.goalStore.update(goal.id, { archived: false, paused: false, state: "todo" });
				await teardownTeam(goal.id);
				await deleteGoal(goal.id);
			}
		}
	});
});
