import { vi } from "vitest";
import { expect, test } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	createGoal,
	createSession,
	startTeam,
	waitForSessionStatus,
} from "./_e2e/e2e-setup.js";
import { seedSessionTranscript } from "./helpers/session-fixtures.js";

test.setTimeout(60_000);

async function archiveGoal(goalId: string): Promise<void> {
	const response = await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" });
	const body = await response.json().catch(() => ({}));
	expect(response.status, `archive goal ${goalId}: ${JSON.stringify(body)}`).toBe(200);
}

async function spawnWorker(goalId: string, task: string): Promise<string> {
	const response = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
		method: "POST",
		body: JSON.stringify({ role: "coder", task }),
	});
	const body = await response.json().catch(() => ({}));
	expect(response.status, `spawn worker for ${goalId}: ${JSON.stringify(body)}`).toBe(201);
	expect(body.sessionId).toEqual(expect.any(String));
	return body.sessionId as string;
}

async function leavePersistedOnly(sessionManager: any, sessionId: string): Promise<void> {
	const live = sessionManager.sessions.get(sessionId);
	expect(live, `session ${sessionId} must be live before simulating a store-only row`).toBeTruthy();
	try { live.unsubscribe?.(); } catch { /* fixture teardown is best-effort */ }
	try { await live.rpcClient.stop(); } catch { /* the mock bridge may already be idle */ }
	sessionManager.sessions.delete(sessionId);
}

function archivedText(messages: unknown[]): string {
	return JSON.stringify(messages);
}

test.describe("archived team reconciliation", () => {
	test("operator archive preserves evidence while archiving the lead and workers and removing team state", async ({ gateway }) => {
		const marker = `archive-team-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const goal = await createGoal({ title: marker, team: true, autoStartTeam: false });
		const leadId = await startTeam(goal.id);
		const [firstWorkerId, secondWorkerId] = await Promise.all([
			spawnWorker(goal.id, "first archive reconciliation worker"),
			spawnWorker(goal.id, "second archive reconciliation worker"),
		]);
		const teamSessionIds = [leadId, firstWorkerId, secondWorkerId];
		await Promise.all([
			waitForSessionStatus(firstWorkerId, "idle"),
			waitForSessionStatus(secondWorkerId, "idle"),
		]);
		const transcriptMarker = `${marker}-retained-transcript`;
		seedSessionTranscript(gateway, firstWorkerId, [
			{ role: "user", text: transcriptMarker },
			{ role: "assistant", text: "retained answer" },
		]);

		const context = gateway.projectContextManager.getContextForGoal(goal.id)!;
		expect(gateway.teamManager.getTeamState(goal.id)?.agents.map((agent: any) => agent.sessionId).sort())
			.toEqual([firstWorkerId, secondWorkerId].sort());
		expect(context.teamStore.get(goal.id)?.teamLeadSessionId).toBe(leadId);

		await archiveGoal(goal.id);

		expect(context.goalStore.get(goal.id)?.archived).toBe(true);
		expect(gateway.teamManager.getTeamState(goal.id)).toBeUndefined();
		expect(context.teamStore.get(goal.id)).toBeUndefined();
		for (const sessionId of teamSessionIds) {
			expect(gateway.sessionManager.getPersistedSession(sessionId)?.archived, `${sessionId} must be durably archived`).toBe(true);
			expect(gateway.sessionManager.getSession(sessionId), `${sessionId} must leave the live runtime map`).toBeUndefined();
		}

		const messages = await gateway.sessionManager.getArchivedMessages(firstWorkerId);
		expect(archivedText(messages), "soft archival must retain the worker transcript").toContain(transcriptMarker);

		const agentsResponse = await apiFetch(`/api/goals/${goal.id}/team/agents?include=archived`);
		expect(agentsResponse.status).toBe(200);
		const agentsBody = await agentsResponse.json();
		const archivedAgents = (agentsBody.agents as any[]).filter(agent => teamSessionIds.includes(agent.sessionId));
		expect(archivedAgents.map(agent => agent.sessionId).sort()).toEqual([...teamSessionIds].sort());
		expect(archivedAgents.every(agent => agent.status === "archived")).toBe(true);
		for (const workerId of [firstWorkerId, secondWorkerId]) {
			expect(archivedAgents.find(agent => agent.sessionId === workerId)?.teamLeadSessionId).toBe(leadId);
		}

		const goalsResponse = await apiFetch(`/api/goals?archived=true&q=${encodeURIComponent(marker)}&limit=50`);
		expect(goalsResponse.status).toBe(200);
		const goalsBody = await goalsResponse.json();
		expect((goalsBody.goals as any[]).map(item => item.id)).toContain(goal.id);
		const affiliated = (goalsBody.archivedSessions as any[]).filter(session => teamSessionIds.includes(session.id));
		expect(affiliated.map(session => session.id).sort(), "archived sidebar affiliation must remain readable")
			.toEqual([...teamSessionIds].sort());
		expect(affiliated.find(session => session.id === firstWorkerId)?.teamLeadSessionId, "worker hierarchy must survive reconciliation")
			.toBe(leadId);
	});

	test("archive reconciles a store-only teamGoalId session when team state is missing", async ({ gateway }) => {
		const goal = await createGoal({ title: `store-only-team-owner-${Date.now()}`, team: true, autoStartTeam: false });
		const sessionId = await createSession({ goalId: goal.id });
		const sessionManager = gateway.sessionManager as any;
		expect(sessionManager.updateSessionMeta(sessionId, { role: "coder", teamGoalId: goal.id })).toBe(true);
		await leavePersistedOnly(sessionManager, sessionId);

		const context = gateway.projectContextManager.getContextForGoal(goal.id)!;
		expect(context.teamStore.get(goal.id)).toBeUndefined();
		expect(gateway.teamManager.getTeamState(goal.id)).toBeUndefined();
		expect(sessionManager.getPersistedSession(sessionId)?.teamGoalId).toBe(goal.id);
		expect(sessionManager.getPersistedSession(sessionId)?.archived).not.toBe(true);

		await archiveGoal(goal.id);

		expect(sessionManager.getPersistedSession(sessionId)).toMatchObject({ teamGoalId: goal.id, archived: true });
		expect(context.teamStore.get(goal.id)).toBeUndefined();
	});

	test("operator archive durably promotes recovered team ownership before archiving its exact owner", async ({ gateway }) => {
		const goal = await createGoal({ title: `recovered-team-marker-${Date.now()}`, team: false, autoStartTeam: false });
		const ownedId = await createSession({ goalId: goal.id });
		const standaloneId = await createSession({ goalId: goal.id });
		const sessionManager = gateway.sessionManager as any;
		const context = gateway.projectContextManager.getContextForGoal(goal.id)!;
		expect(sessionManager.updateSessionMeta(ownedId, { role: "coder", teamGoalId: goal.id })).toBe(true);
		expect(context.goalStore.get(goal.id)?.team).not.toBe(true);
		expect(context.teamStore.get(goal.id)).toBeUndefined();

		const publicationOrder: string[] = [];
		const originalMarker = context.goalStore.updateStrict.bind(context.goalStore);
		const originalArchive = context.sessionStore.archiveAsync.bind(context.sessionStore);
		const markerSpy = vi.spyOn(context.goalStore, "updateStrict").mockImplementation(async (...args: unknown[]) => {
			publicationOrder.push("team-marker");
			return originalMarker(args[0] as string, args[1] as any);
		});
		const archiveSpy = vi.spyOn(context.sessionStore, "archiveAsync").mockImplementation(async (...args: unknown[]) => {
			const id = args[0] as string;
			publicationOrder.push(`session-archive:${id}`);
			return originalArchive(id);
		});
		try {
			await archiveGoal(goal.id);

			expect(publicationOrder[0]).toBe("team-marker");
			expect(publicationOrder).toContain(`session-archive:${ownedId}`);
			expect(context.goalStore.get(goal.id)).toMatchObject({ archived: true, team: true });
			expect(sessionManager.getPersistedSession(ownedId)).toMatchObject({ teamGoalId: goal.id, archived: true });
			expect(sessionManager.getPersistedSession(standaloneId)?.archived).not.toBe(true);
			expect(context.teamStore.get(goal.id)).toBeUndefined();

			publicationOrder.length = 0;
			await archiveGoal(goal.id);
			expect(markerSpy).toHaveBeenCalledTimes(1);
			expect(publicationOrder).toEqual([]);
			expect(sessionManager.getPersistedSession(standaloneId)?.archived).not.toBe(true);
		} finally {
			markerSpy.mockRestore();
			archiveSpy.mockRestore();
		}
	});

	test("a termination failure falls back to durable archival and cannot dispatch the team session on restore", async ({ gateway }) => {
		const goal = await createGoal({ title: `termination-fallback-${Date.now()}`, team: true, autoStartTeam: false });
		const leadId = await startTeam(goal.id);
		const sessionManager = gateway.sessionManager as any;
		const originalTerminate = sessionManager.terminateSession.bind(sessionManager);
		const terminateSpy = vi.spyOn(sessionManager, "terminateSession").mockImplementation((async (...args: unknown[]) => {
			const sessionId = args[0] as string;
			if (sessionId === leadId) return false;
			return originalTerminate(sessionId);
		}) as any);
		let restoreSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			await archiveGoal(goal.id);
			expect(terminateSpy).toHaveBeenCalledWith(leadId, expect.objectContaining({ preserveEvidence: true }));
			expect(sessionManager.getPersistedSession(leadId)?.archived, "fallback must publish archival despite stop failure").toBe(true);
			expect(gateway.projectContextManager.getContextForGoal(goal.id)!.teamStore.get(goal.id)).toBeUndefined();

			terminateSpy.mockRestore();
			const restoredIds: string[] = [];
			restoreSpy = vi.spyOn(sessionManager as any, "restoreOneSession").mockImplementation(async (persisted: any) => {
				restoredIds.push(persisted.id);
			});
			await sessionManager.restoreSessions();
			expect(restoredIds, "an archived team lead must never be respawned").not.toContain(leadId);
		} finally {
			if ((terminateSpy as any).mockRestore) terminateSpy.mockRestore();
			restoreSpy?.mockRestore();
			if (sessionManager.getSession(leadId)) await originalTerminate(leadId).catch(() => {});
		}
	});

	test("direct REST delegates reject every matching teamGoalId owner after archive", async ({ gateway }) => {
		const goal = await createGoal({ title: `trusted-delegate-admission-${Date.now()}`, team: true, autoStartTeam: false });
		const standaloneRootId = await createSession({ goalId: goal.id });
		const genuineTeamRootId = await createSession({ goalId: goal.id });
		const sessionManager = gateway.sessionManager as any;
		const context = gateway.projectContextManager.getContextForGoal(goal.id)!;
		expect(sessionManager.updateSessionMeta(genuineTeamRootId, { role: "coder", teamGoalId: goal.id })).toBe(true);

		const firstDelegateResponse = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ delegateOf: standaloneRootId, instructions: "inherit durable team ownership" }),
		});
		expect(firstDelegateResponse.status).toBe(201);
		const firstDelegateId = (await firstDelegateResponse.json()).id as string;
		expect(sessionManager.getPersistedSession(firstDelegateId)?.teamGoalId).toBe(goal.id);
		expect(sessionManager.getTrustedTeamGoalIdForSession(firstDelegateId)).toBe(goal.id);

		await context.goalStore.archiveStrict(goal.id);
		const rowsBeforeRejectedCreate = context.sessionStore.getAll().length;
		const inheritedResponse = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ delegateOf: firstDelegateId, instructions: "must be rejected" }),
		});
		const inheritedBody = await inheritedResponse.json().catch(() => ({}));
		expect(inheritedResponse.status, JSON.stringify(inheritedBody)).toBe(409);
		expect(inheritedBody).toMatchObject({ code: "GOAL_ARCHIVED", goalId: goal.id });
		expect(context.sessionStore.getAll().length, "matching metadata admission creates no persisted row").toBe(rowsBeforeRejectedCreate);
		expect(sessionManager.getPersistedSession(standaloneRootId)?.archived).not.toBe(true);

		const teamResponse = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ delegateOf: genuineTeamRootId, instructions: "must also be rejected" }),
		});
		const teamBody = await teamResponse.json().catch(() => ({}));
		expect(teamResponse.status, JSON.stringify(teamBody)).toBe(409);
		expect(teamBody).toMatchObject({ code: "GOAL_ARCHIVED", goalId: goal.id });
		expect(context.sessionStore.getAll().length, "terminal admission creates no persisted row").toBe(rowsBeforeRejectedCreate);
	});

	test("boot repair runs before event resubscription and restores only goal-only and genuinely live controls", async ({ gateway }) => {
		const marker = `boot-repair-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const goal = await createGoal({ title: marker, team: true, autoStartTeam: false });
		const leadId = await startTeam(goal.id);
		const goalOnlySessionId = await createSession({ goalId: goal.id });
		const liveControlId = await createSession();
		const context = gateway.projectContextManager.getContextForGoal(goal.id)!;
		const sessionManager = gateway.sessionManager as any;
		const teamManager = gateway.teamManager as any;

		expect(context.teamStore.get(goal.id)?.teamLeadSessionId).toBe(leadId);
		expect(sessionManager.getPersistedSession(goalOnlySessionId)?.teamGoalId).toBeUndefined();
		// Simulate a hard kill after durable goal archival but before the archive
		// reconciliation callback. The live session and TeamStore rows remain stale.
		await context.goalStore.archiveStrict(goal.id);
		expect(context.goalStore.get(goal.id)?.archived).toBe(true);
		expect(sessionManager.getPersistedSession(leadId)?.archived).not.toBe(true);
		expect(context.teamStore.get(goal.id)).toBeTruthy();

		const restoredIds: string[] = [];
		const restoreSpy = vi.spyOn(sessionManager as any, "restoreOneSession").mockImplementation(async (persisted: any) => {
			restoredIds.push(persisted.id);
		});
		const originalResubscribe = teamManager.resubscribeTeamEvents.bind(teamManager);
		const resubscribeSpy = vi.spyOn(teamManager, "resubscribeTeamEvents").mockImplementation(() => {
			expect(context.teamStore.get(goal.id), "repair must delete persisted team state before event resubscription").toBeUndefined();
			expect(teamManager.getTeamState(goal.id), "repair must deactivate runtime team state before event resubscription").toBeUndefined();
			expect(sessionManager.getPersistedSession(leadId)?.archived, "repair must archive the leaked lead before event resubscription").toBe(true);
			originalResubscribe();
		});
		try {
			const suppression = await teamManager.reconcileArchivedTeamOwnership();
			await sessionManager.restoreSessions(suppression);
			teamManager.resubscribeTeamEvents();

			expect(resubscribeSpy).toHaveBeenCalledTimes(1);
			expect(restoredIds, "archived team ownership must not reach restoreOneSession").not.toContain(leadId);
			expect(restoredIds, "goalId-only standalone sessions are not team-owned and remain eager").toContain(goalOnlySessionId);
			expect(restoredIds, "an unrelated genuinely live session must still restore eagerly").toContain(liveControlId);
			expect(sessionManager.getPersistedSession(goalOnlySessionId)?.archived).not.toBe(true);
			expect(sessionManager.getPersistedSession(liveControlId)?.archived).not.toBe(true);
		} finally {
			restoreSpy.mockRestore();
			resubscribeSpy.mockRestore();
		}
	});
});
