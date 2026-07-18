import { vi } from "vitest";
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	base,
	connectWs,
	createGoal,
	createSession,
	defaultProjectId,
	deleteGoal,
	deleteSession,
	gitCwd,
	startTeam,
	teardownTeam,
	type WsConnection,
} from "./_e2e/e2e-setup.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";
import {
	trackGateApiConnection,
	useGateApiTestSupport,
	waitForAuthoredGateStatus,
} from "./helpers/gate-api-test-support.js";

useGateApiTestSupport();

function workflowId(prefix: string): string {
	return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createWorkflow(id: string, gates: Array<Record<string, unknown>>): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id,
			name: `Gate Reset ${id}`,
			description: "Workflow fixture for gate reset API tests",
			gates,
		}),
	});
	expect(res.status, `workflow create failed: ${res.status} ${await res.text().catch(() => "")}`).toBe(201);
}

async function deleteWorkflow(id: string): Promise<void> {
	await apiFetch(`/api/workflows/${id}`, { method: "DELETE" }).catch(() => {});
}

async function signalGate(goalId: string, gateId: string, body: Record<string, unknown> = {}): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signal`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	const text = await res.text();
	expect(res.status, `signal ${gateId} failed: ${res.status} ${text}`).toBe(201);
	return text ? JSON.parse(text) : null;
}

async function waitForGateStatus(goalId: string, gateId: string, status: "pending" | "passed" | "failed"): Promise<any> {
	return waitForAuthoredGateStatus(goalId, gateId, status);
}

async function getGate(goalId: string, gateId: string): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	expect(res.status).toBe(200);
	return res.json();
}

async function waitForGoalSetupReady(goalId: string): Promise<any> {
	return pollUntil(async () => {
		const res = await apiFetch(`/api/goals/${goalId}`);
		if (!res.ok) return null;
		const goal = await res.json();
		if (goal.setupStatus === "error") throw new Error(`Goal setup failed: ${JSON.stringify(goal)}`);
		return goal.setupStatus === "ready" ? goal : null;
	}, { timeoutMs: 60_000, intervalMs: 250, label: `goal ${goalId} setup ready` });
}

async function getSignals(goalId: string, gateId: string): Promise<any[]> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signals`);
	expect(res.status).toBe(200);
	return (await res.json()).signals || [];
}

async function latestVerificationOutput(goalId: string, gateId: string): Promise<string> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/inspect?section=verification`);
	expect(res.status).toBe(200);
	const body = await res.json();
	return (body.steps || []).map((s: any) => String(s.output || "")).join("\n");
}

async function resetGate(goalId: string, gateId: string): Promise<{ status: number; body: any }> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/reset`, { method: "POST" });
	const text = await res.text();
	let body: any = null;
	try { body = text ? JSON.parse(text) : null; } catch { body = text; }
	return { status: res.status, body };
}

async function activeVerifications(goalId: string): Promise<any[]> {
	const res = await apiFetch(`/api/goals/${goalId}/verifications/active`);
	expect(res.status).toBe(200);
	return (await res.json()).verifications || [];
}

async function getGoal(goalId: string): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}`);
	expect(res.status).toBe(200);
	return res.json();
}

async function updateGoal(goalId: string, updates: Record<string, unknown>): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}`, {
		method: "PUT",
		body: JSON.stringify(updates),
	});
	const text = await res.text();
	expect(res.status, `goal update failed: ${res.status} ${text}`).toBe(200);
	return text ? JSON.parse(text) : null;
}

async function createCompletedTask(goalId: string): Promise<any> {
	const create = await apiFetch(`/api/goals/${goalId}/tasks`, {
		method: "POST",
		body: JSON.stringify({ title: "Preserved completed task", type: "testing", spec: "Task fixture preserved across gate reset." }),
	});
	expect(create.status).toBe(201);
	const task = await create.json();
	for (const state of ["in-progress", "complete"]) {
		const update = await apiFetch(`/api/tasks/${task.id}`, {
			method: "PUT",
			body: JSON.stringify({ state, ...(state === "complete" ? { resultSummary: "Fixture complete" } : {}) }),
		});
		expect(update.status).toBe(200);
	}
	const read = await apiFetch(`/api/tasks/${task.id}`);
	expect(read.status).toBe(200);
	return read.json();
}

async function completeTeam(goalId: string): Promise<void> {
	const res = await apiFetch(`/api/goals/${goalId}/team/complete`, {
		method: "POST",
		body: JSON.stringify({}),
	});
	const text = await res.text();
	expect(res.status, `team complete failed: ${res.status} ${text}`).toBe(200);
}

function resetNotificationCalls(spies: any[], teamLeadId: string): any[][] {
	return spies.flatMap(spy => spy.mock.calls)
		.filter((call: any[]) => call[0] === teamLeadId && String(call[1]).includes("Gate reset:"));
}

test.describe("POST /api/goals/:goalId/gates/:gateId/reset", () => {
	test("reopens a completed active goal while preserving its team, session, work, history, and PR association", async ({ gateway }) => {
		const wf = workflowId("gate-reset-reopen");
		await createWorkflow(wf, [
			{ id: "root", name: "Root Gate", dependsOn: [], verify: [{ name: "root ok", type: "command", run: "echo ok" }] },
			{ id: "child", name: "Child Gate", dependsOn: ["root"], verify: [{ name: "child ok", type: "command", run: "echo ok" }] },
		]);

		const goal = await createGoal({ title: `Gate Reset Reopen ${Date.now()}`, cwd: gitCwd(), workflowId: wf, worktree: false, team: true, autoStartTeam: false });
		const goalId = goal.id;
		let teamLeadId: string | undefined;
		let conn: WsConnection | undefined;
		let enqueueSpy: any;
		let steerSpy: any;
		let context: any;
		try {
			await waitForGoalSetupReady(goalId);
			const taskBefore = await createCompletedTask(goalId);
			const rootSignal = await signalGate(goalId, "root", { content: "Root history must survive reopen." });
			await waitForGateStatus(goalId, "root", "passed");
			const childSignal = await signalGate(goalId, "child", { content: "Child history must survive reopen." });
			await waitForGateStatus(goalId, "child", "passed");

			teamLeadId = await startTeam(goalId);
			context = gateway.projectContextManager.getContextForGoal(goalId);
			expect(context, "project context for completed goal").toBeTruthy();
			const liveGoal = context.goalStore.get(goalId);
			const preservedGit = {
				branch: `goal/preserved-reset-${goalId.slice(0, 8)}`,
				worktreePath: liveGoal.cwd,
				repoPath: liveGoal.cwd,
			};
			context.goalStore.update(goalId, preservedGit);
			const preservedPr = { state: "OPEN", url: `https://github.com/example/bobbit/pull/${Date.now()}` };
			gateway.sessionManager.prStatusStore.set(goalId, preservedPr);

			await completeTeam(goalId);
			const completedGoal = await getGoal(goalId);
			expect(completedGoal.state).toBe("complete");
			const teamBefore = gateway.teamManager.getTeamState(goalId);
			expect(teamBefore?.teamLeadSessionId).toBe(teamLeadId);
			const leadSessionBefore = gateway.sessionManager.getSession(teamLeadId);
			expect(leadSessionBefore, "team completion must retain the lead session").toBeTruthy();
			conn = trackGateApiConnection(await connectWs(teamLeadId));

			enqueueSpy = vi.spyOn(gateway.sessionManager, "enqueuePrompt");
			steerSpy = vi.spyOn(gateway.sessionManager, "deliverLiveSteer");
			const cursor = conn.messageCount();
			const first = await resetGate(goalId, "root");
			expect(first.status, JSON.stringify(first.body)).toBe(200);
			expect(
				first.body.reopen,
				"GATE_RESET_REOPEN_MISSING: completed-goal gate reset must report its lifecycle transition",
			).toEqual({ reopened: true, previousState: "complete", state: "in-progress" });
			expect(first.body.changedGateIds).toEqual(expect.arrayContaining(["root", "child"]));
			expect(first.body.teamLeadNotified).toBe(true);

			const persisted = await getGoal(goalId);
			expect(persisted.state, "completed goal must be persisted as reopened").toBe("in-progress");
			expect(context.goalStore.get(goalId)?.state).toBe("in-progress");
			expect(persisted).toMatchObject({
				id: completedGoal.id,
				cwd: completedGoal.cwd,
				team: completedGoal.team,
				...preservedGit,
			});
			expect(gateway.teamManager.getTeamState(goalId)?.teamLeadSessionId).toBe(teamBefore?.teamLeadSessionId);
			expect(gateway.sessionManager.getSession(teamLeadId)).toBe(leadSessionBefore);
			expect(gateway.sessionManager.prStatusStore.get(goalId)).toEqual(preservedPr);

			await waitForGateStatus(goalId, "root", "pending");
			await waitForGateStatus(goalId, "child", "pending");
			expect((await getSignals(goalId, "root")).map(signal => signal.id)).toContain(rootSignal.signal.id);
			expect((await getSignals(goalId, "child")).map(signal => signal.id)).toContain(childSignal.signal.id);
			const taskAfterRes = await apiFetch(`/api/tasks/${taskBefore.id}`);
			expect(taskAfterRes.status).toBe(200);
			expect(await taskAfterRes.json()).toMatchObject({ id: taskBefore.id, state: "complete", resultSummary: "Fixture complete" });

			const firstEvents = conn.messages.slice(cursor);
			expect(firstEvents.filter(message => message.type === "goal_state_changed" && message.goalId === goalId)).toHaveLength(1);
			const resetEvent = firstEvents.find(message => message.type === "gate_reset" && message.goalId === goalId && message.gateId === "root");
			expect(resetEvent?.reopen).toEqual(first.body.reopen);
			const firstNotifications = resetNotificationCalls([enqueueSpy, steerSpy], teamLeadId);
			expect(firstNotifications).toHaveLength(1);
			expect(String(firstNotifications[0][1])).toMatch(/reopen[\s\S]*in-progress|in-progress[\s\S]*reopen/i);

			enqueueSpy.mockClear();
			steerSpy.mockClear();
			const repeatedCursor = conn.messageCount();
			const repeated = await resetGate(goalId, "root");
			expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
			expect(repeated.body.reopen).toEqual({ reopened: false, previousState: "in-progress", state: "in-progress" });
			expect(repeated.body.changedGateIds).toEqual([]);
			expect(repeated.body.teamLeadNotified).toBe(false);
			expect(resetNotificationCalls([enqueueSpy, steerSpy], teamLeadId)).toHaveLength(0);
			expect(conn.messages.slice(repeatedCursor).filter(message => message.type === "goal_state_changed" && message.goalId === goalId)).toHaveLength(0);
			expect((await getGoal(goalId)).state).toBe("in-progress");
		} finally {
			enqueueSpy?.mockRestore();
			steerSpy?.mockRestore();
			conn?.close();
			gateway.sessionManager.prStatusStore.remove(goalId);
			const stored = context?.goalStore.get(goalId);
			if (stored) {
				delete stored.branch;
				delete stored.worktreePath;
				delete stored.repoPath;
			}
			await teardownTeam(goalId).catch(() => {});
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("restores a completed goal when gate invalidation fails without lifecycle side effects", async ({ gateway }) => {
		const wf = workflowId("gate-reset-compensation");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Reset Compensation ${Date.now()}`, workflowId: wf, worktree: false, team: true, autoStartTeam: false });
		const goalId = goal.id;
		let teamLeadId: string | undefined;
		let conn: WsConnection | undefined;
		let resetSpy: any;
		let reopenSpy: any;
		let enqueueSpy: any;
		let steerSpy: any;
		try {
			await signalGate(goalId, "root");
			await waitForGateStatus(goalId, "root", "passed");
			teamLeadId = await startTeam(goalId);
			await completeTeam(goalId);
			expect((await getGoal(goalId)).state).toBe("complete");

			const context = gateway.projectContextManager.getContextForGoal(goalId);
			conn = trackGateApiConnection(await connectWs(teamLeadId));
			resetSpy = vi.spyOn(context.gateStore, "resetGateAndDependentsStrict")
				.mockImplementation(() => {
					expect(context.goalStore.get(goalId)?.state).toBe("in-progress");
					throw new Error("forced gate reset persistence failure");
				});
			reopenSpy = vi.spyOn(gateway.teamManager, "reopenCompletedTeam");
			enqueueSpy = vi.spyOn(gateway.sessionManager, "enqueuePrompt");
			steerSpy = vi.spyOn(gateway.sessionManager, "deliverLiveSteer");
			const cursor = conn.messageCount();

			const reset = await resetGate(goalId, "root");
			expect(reset.status, JSON.stringify(reset.body)).toBe(500);
			expect(reset.body).toMatchObject({
				error: "Failed to reset gate",
				code: "GATE_RESET_PERSIST_FAILED",
				retryable: true,
			});
			expect((await getGoal(goalId)).state).toBe("complete");
			expect((await getGate(goalId, "root")).status).toBe("passed");
			expect(reopenSpy).not.toHaveBeenCalled();
			expect(resetNotificationCalls([enqueueSpy, steerSpy], teamLeadId)).toHaveLength(0);
			const errorEvents = conn.messages.slice(cursor);
			expect(errorEvents.filter(message => message.type === "goal_state_changed" && message.goalId === goalId)).toHaveLength(0);
			expect(errorEvents.filter(message => message.type === "gate_reset" && message.goalId === goalId)).toHaveLength(0);
		} finally {
			resetSpy?.mockRestore();
			reopenSpy?.mockRestore();
			enqueueSpy?.mockRestore();
			steerSpy?.mockRestore();
			conn?.close();
			await teardownTeam(goalId).catch(() => {});
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("retains the durable intent and retries a failed team runtime rearm", async ({ gateway }) => {
		const wf = workflowId("gate-reset-rearm-retry");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Reset Rearm Retry ${Date.now()}`, workflowId: wf, worktree: false, team: true, autoStartTeam: false });
		const goalId = goal.id;
		let teamLeadId: string | undefined;
		let reopenSpy: any;
		try {
			await signalGate(goalId, "root");
			await waitForGateStatus(goalId, "root", "passed");
			teamLeadId = await startTeam(goalId);
			await completeTeam(goalId);

			const context = gateway.projectContextManager.getContextForGoal(goalId);
			reopenSpy = vi.spyOn(gateway.teamManager, "reopenCompletedTeam")
				.mockReturnValueOnce(false)
				.mockReturnValueOnce(true);

			const failed = await resetGate(goalId, "root");
			expect(failed.status).toBe(503);
			expect(failed.body).toMatchObject({
				code: "TEAM_REOPEN_FAILED",
				retryable: true,
				durableReset: true,
				reopen: { reopened: true, previousState: "complete", state: "in-progress" },
			});
			expect((await getGoal(goalId)).state).toBe("in-progress");
			expect((await getGate(goalId, "root")).status).toBe("pending");
			expect(context.gateResetCoordinator.intents.get(goalId)).toBeTruthy();

			const retried = await resetGate(goalId, "root");
			expect(retried.status, JSON.stringify(retried.body)).toBe(200);
			expect(retried.body.reopen).toEqual({ reopened: true, previousState: "complete", state: "in-progress" });
			expect(retried.body.changedGateIds).toEqual(["root"]);
			expect(reopenSpy).toHaveBeenCalledTimes(2);
			expect(context.gateResetCoordinator.intents.get(goalId)).toBeUndefined();
		} finally {
			reopenSpy?.mockRestore();
			await teardownTeam(goalId).catch(() => {});
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("reopens and finalizes a reset after the completed team's runtime was torn down", async ({ gateway }) => {
		const wf = workflowId("gate-reset-torn-down-team");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "root ok", type: "command", run: "echo ok" }] },
			{ id: "other", name: "Other", dependsOn: [], verify: [{ name: "other ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Reset Torn Down Team ${Date.now()}`, workflowId: wf, worktree: false, team: true, autoStartTeam: false });
		const goalId = goal.id;
		let teamLeadId: string | undefined;
		let reopenSpy: any;
		try {
			await signalGate(goalId, "root");
			await waitForGateStatus(goalId, "root", "passed");
			await signalGate(goalId, "other");
			await waitForGateStatus(goalId, "other", "passed");
			teamLeadId = await startTeam(goalId);
			await completeTeam(goalId);
			expect((await getGoal(goalId)).state).toBe("complete");

			await teardownTeam(goalId);
			expect(gateway.teamManager.getTeamState(goalId)).toBeUndefined();
			const sessionsAfterTeardown = gateway.sessionManager.listSessions()
				.filter((session: any) => session.goalId === goalId || session.teamGoalId === goalId)
				.map((session: any) => session.id);
			expect(sessionsAfterTeardown).toEqual([]);

			const context = gateway.projectContextManager.getContextForGoal(goalId);
			reopenSpy = vi.spyOn(gateway.teamManager, "reopenCompletedTeam");
			const first = await resetGate(goalId, "root");
			expect(first.status, JSON.stringify(first.body)).toBe(200);
			expect(first.body.reopen).toEqual({ reopened: true, previousState: "complete", state: "in-progress" });
			expect(first.body.changedGateIds).toEqual(["root"]);
			expect(first.body.teamLeadNotified).toBe(false);
			expect((await getGoal(goalId)).state).toBe("in-progress");
			expect((await getGate(goalId, "root")).status).toBe("pending");
			expect((await getGate(goalId, "other")).status).toBe("passed");
			expect(gateway.teamManager.getTeamState(goalId)).toBeUndefined();
			expect(reopenSpy).not.toHaveBeenCalled();
			expect(
				gateway.sessionManager.listSessions()
					.filter((session: any) => session.goalId === goalId || session.teamGoalId === goalId)
					.map((session: any) => session.id),
			).toEqual(sessionsAfterTeardown);
			expect(context.gateResetCoordinator.intents.get(goalId)).toBeUndefined();

			const later = await resetGate(goalId, "other");
			expect(later.status, JSON.stringify(later.body)).toBe(200);
			expect(later.body.reopen).toEqual({ reopened: false, previousState: "in-progress", state: "in-progress" });
			expect(later.body.changedGateIds).toEqual(["other"]);
			expect((await getGate(goalId, "other")).status).toBe("pending");
			expect(context.gateResetCoordinator.intents.get(goalId)).toBeUndefined();
		} finally {
			reopenSpy?.mockRestore();
			await teardownTeam(goalId).catch(() => {});
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("resets an already in-progress goal without a lifecycle transition", async () => {
		const wf = workflowId("gate-reset-active");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Reset Active ${Date.now()}`, workflowId: wf, worktree: false, team: false });
		const goalId = goal.id;
		let conn: WsConnection | undefined;
		let sessionId: string | undefined;
		try {
			await updateGoal(goalId, { state: "in-progress" });
			await signalGate(goalId, "root");
			await waitForGateStatus(goalId, "root", "passed");
			sessionId = await createSession({ goalId });
			conn = trackGateApiConnection(await connectWs(sessionId));
			const cursor = conn.messageCount();
			const reset = await resetGate(goalId, "root");
			expect(reset.status, JSON.stringify(reset.body)).toBe(200);
			expect(reset.body.reopen).toEqual({ reopened: false, previousState: "in-progress", state: "in-progress" });
			expect(reset.body.changedGateIds).toEqual(["root"]);
			expect((await getGoal(goalId)).state).toBe("in-progress");
			expect((await getGate(goalId, "root")).status).toBe("pending");
			expect(conn.messages.slice(cursor).filter(message => message.type === "goal_state_changed" && message.goalId === goalId)).toHaveLength(0);
		} finally {
			conn?.close();
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("rejects archived, shelved, and paused goals before cancellation or gate mutation", async ({ gateway }) => {
		const wf = workflowId("gate-reset-dormant");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const fixtures: Array<{ kind: "archived" | "shelved" | "paused"; code?: string }> = [
			{ kind: "archived" },
			{ kind: "shelved", code: "GOAL_SHELVED" },
			{ kind: "paused", code: "GOAL_PAUSED" },
		];

		try {
			for (const fixture of fixtures) {
				const goal = await createGoal({ title: `Gate Reset ${fixture.kind} ${Date.now()}`, workflowId: wf, worktree: false, team: false });
				const goalId = goal.id;
				const context = gateway.projectContextManager.getContextForGoal(goalId);
				try {
					await signalGate(goalId, "root", { content: `${fixture.kind} history` });
					await waitForGateStatus(goalId, "root", "passed");
					if (fixture.kind === "archived") {
						context.goalStore.update(goalId, { archived: true, archivedAt: Date.now() });
					} else if (fixture.kind === "shelved") {
						await updateGoal(goalId, { state: "shelved" });
					} else {
						const pause = await apiFetch(`/api/goals/${goalId}/pause`, {
							method: "POST",
							body: JSON.stringify({ cascade: false }),
						});
						expect(pause.status).toBe(200);
					}
					const goalBefore = await getGoal(goalId);
					const signalsBefore = await getSignals(goalId, "root");
					const cancelSpy = vi.spyOn(gateway.teamManager.verificationHarness, "cancelStaleVerificationsForGates");
					try {
						const reset = await resetGate(goalId, "root");
						expect(reset.status, `${fixture.kind} goals must remain dormant`).toBe(409);
						if (fixture.code) expect(reset.body.code).toBe(fixture.code);
						expect(cancelSpy.mock.calls.filter((call: any[]) => call[0] === goalId)).toHaveLength(0);
						expect((await getGate(goalId, "root")).status).toBe("passed");
						expect(await getSignals(goalId, "root")).toEqual(signalsBefore);
						const goalAfter = await getGoal(goalId);
						expect(goalAfter.id).toBe(goalBefore.id);
						expect(goalAfter.state).toBe(goalBefore.state);
						expect(Boolean(goalAfter.archived)).toBe(Boolean(goalBefore.archived));
						expect(Boolean(goalAfter.paused)).toBe(Boolean(goalBefore.paused));
					} finally {
						cancelSpy.mockRestore();
					}
				} finally {
					context.goalStore.update(goalId, { archived: false, paused: false, state: "in-progress" });
					await deleteGoal(goalId).catch(() => {});
				}
			}
		} finally {
			await deleteWorkflow(wf);
		}
	});
	test("manual reset invalidates cached verification output for same-commit re-signals", async () => {
		const wf = workflowId("gate-reset-cache");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "root fresh marker", type: "command", run: "node -e \"console.log('FRESH_ROOT_AFTER_RESET')\"" }] },
			{ id: "child", name: "Child", dependsOn: ["root"], verify: [{ name: "child fresh marker", type: "command", run: "node -e \"console.log('FRESH_CHILD_AFTER_RESET')\"" }] },
		]);

		const goal = await createGoal({ title: `Gate Reset Cache ${Date.now()}`, cwd: gitCwd(), workflowId: wf, worktree: false, team: false, autoStartTeam: false });
		const goalId = goal.id;
		try {
			await waitForGoalSetupReady(goalId);
			await signalGate(goalId, "root");
			await waitForGateStatus(goalId, "root", "passed");
			expect(await latestVerificationOutput(goalId, "root")).toContain("FRESH_ROOT_AFTER_RESET");

			await signalGate(goalId, "child");
			await waitForGateStatus(goalId, "child", "passed");
			expect(await latestVerificationOutput(goalId, "child")).toContain("FRESH_CHILD_AFTER_RESET");

			const reset = await resetGate(goalId, "root");
			expect(reset.status, JSON.stringify(reset.body)).toBe(200);
			expect(reset.body.affectedGateIds).toEqual(expect.arrayContaining(["root", "child"]));
			await waitForGateStatus(goalId, "root", "pending");
			await waitForGateStatus(goalId, "child", "pending");

			await signalGate(goalId, "root");
			await waitForGateStatus(goalId, "root", "passed");
			const rootOutput = await latestVerificationOutput(goalId, "root");
			expect(rootOutput).toContain("FRESH_ROOT_AFTER_RESET");
			expect.soft(
				rootOutput,
				"FRESH_GATE_RESET_CACHE_REUSED: root gate reused pre-reset verification output after manual reset",
			).not.toContain("[cached from prior signal]");

			await signalGate(goalId, "child");
			await waitForGateStatus(goalId, "child", "passed");
			const childOutput = await latestVerificationOutput(goalId, "child");
			expect(childOutput).toContain("FRESH_CHILD_AFTER_RESET");
			expect.soft(
				childOutput,
				"FRESH_GATE_RESET_CACHE_REUSED: downstream child gate reused pre-reset verification output after upstream manual reset",
			).not.toContain("[cached from prior signal]");
		} finally {
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("invalidates the selected gate plus transitive dependents by DAG, preserves history/content, and is idempotent", async () => {
		const wf = workflowId("gate-reset-dag");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", content: true, injectDownstream: true, dependsOn: [], verify: [{ name: "root ok", type: "command", run: "echo ok" }] },
			// Intentionally before its dependency in display order. Reset must not report/use this order.
			{ id: "leaf", name: "Leaf", dependsOn: ["middle"], verify: [{ name: "leaf ok", type: "command", run: "echo ok" }] },
			{ id: "failed-child", name: "Failed Child", dependsOn: ["root"], verify: [{ name: "fails", type: "command", run: "node -e \"process.exit(1)\"" }] },
			{ id: "pending-child", name: "Pending Child", dependsOn: ["root"], verify: [{ name: "pending ok", type: "command", run: "echo ok" }] },
			{ id: "middle", name: "Middle", dependsOn: ["root"], verify: [{ name: "middle ok", type: "command", run: "echo ok" }] },
			{ id: "unrelated", name: "Unrelated", dependsOn: [], verify: [{ name: "unrelated ok", type: "command", run: "echo ok" }] },
		]);

		const goal = await createGoal({ title: `Gate Reset DAG ${Date.now()}`, workflowId: wf, worktree: false, team: false });
		const goalId = goal.id;
		let conn: WsConnection | undefined;
		let sessionId: string | undefined;
		try {
			sessionId = await createSession({ goalId });
			conn = trackGateApiConnection(await connectWs(sessionId));

			const rootSignal = await signalGate(goalId, "root", {
				content: "# Root content\n\nReset must preserve this content.",
				metadata: { ticket: "GATE-RESET", owner: "test" },
			});
			await waitForGateStatus(goalId, "root", "passed");
			await signalGate(goalId, "middle");
			await waitForGateStatus(goalId, "middle", "passed");
			const leafSignal = await signalGate(goalId, "leaf", { content: "leaf signal body" });
			await waitForGateStatus(goalId, "leaf", "passed");
			await signalGate(goalId, "failed-child");
			await waitForGateStatus(goalId, "failed-child", "failed");
			await signalGate(goalId, "unrelated");
			await waitForGateStatus(goalId, "unrelated", "passed");

			const beforeRoot = await getGate(goalId, "root");
			expect(beforeRoot.currentContent).toContain("Reset must preserve this content");
			expect(beforeRoot.currentContentVersion).toBe(1);
			expect(beforeRoot.currentMetadata).toEqual({ ticket: "GATE-RESET", owner: "test" });

			const cursor = conn.messageCount();
			const first = await resetGate(goalId, "root");
			expect(first.status, JSON.stringify(first.body)).toBe(200);
			expect(first.body.ok).toBe(true);
			expect(first.body.gateId).toBe("root");
			expect(first.body.affectedGateIds[0]).toBe("root");
			expect(first.body.affectedGateIds).toEqual(expect.arrayContaining(["root", "middle", "leaf", "failed-child", "pending-child"]));
			expect(first.body.affectedGateIds).not.toContain("unrelated");
			expect(first.body.affectedGateIds.indexOf("middle"), "dependency must appear before dependent leaf").toBeLessThan(first.body.affectedGateIds.indexOf("leaf"));
			expect(first.body.changedGateIds).toEqual(expect.arrayContaining(["root", "middle", "leaf", "failed-child"]));
			expect(first.body.changedGateIds).not.toContain("pending-child");
			expect(first.body.unchangedGateIds).toContain("pending-child");
			expect(first.body.previousStatuses).toMatchObject({
				root: "passed",
				middle: "passed",
				leaf: "passed",
				"failed-child": "failed",
				"pending-child": "pending",
			});

			for (const gateId of ["root", "middle", "leaf", "failed-child", "pending-child"]) {
				await conn.waitForFrom(cursor, (m) => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === gateId && m.status === "pending", 10_000);
				await waitForGateStatus(goalId, gateId, "pending");
			}
			await waitForGateStatus(goalId, "unrelated", "passed");

			const afterRoot = await getGate(goalId, "root");
			expect(afterRoot.status).toBe("pending");
			expect(afterRoot.currentContent).toBe(beforeRoot.currentContent);
			expect(afterRoot.currentContentVersion).toBe(1);
			expect(afterRoot.currentMetadata).toEqual(beforeRoot.currentMetadata);
			expect(afterRoot.signals.map((s: any) => s.id)).toContain(rootSignal.signal.id);
			expect((await getSignals(goalId, "leaf")).map((s) => s.id)).toContain(leafSignal.signal.id);

			const second = await resetGate(goalId, "root");
			expect(second.status, JSON.stringify(second.body)).toBe(200);
			expect(second.body.affectedGateIds).toEqual(first.body.affectedGateIds);
			expect(second.body.changedGateIds).toEqual([]);
			expect(second.body.unchangedGateIds).toEqual(expect.arrayContaining(first.body.affectedGateIds));
		} finally {
			conn?.close();
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("denies sandbox-scoped tokens", async ({ gateway }) => {
		const wf = workflowId("gate-reset-sandbox");
		await createWorkflow(wf, [
			{ id: "root", name: "Root", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Reset Sandbox ${Date.now()}`, workflowId: wf, worktree: false, team: false });
		const goalId = goal.id;
		try {
			const projectId = (goal.projectId as string | undefined) || await defaultProjectId();
			expect(projectId).toBeTruthy();
			const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(projectId);
			gateway.sessionManager.sandboxTokenStore.addGoal(projectId, goalId);

			const res = await fetch(`${base()}/api/goals/${goalId}/gates/root/reset`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${sandboxToken}` },
			});
			expect(res.status).toBe(403);
			const body = await res.json();
			expect(String(body.error)).toMatch(/sandbox token cannot access|forbidden/i);
		} finally {
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("cancels active verifications for affected gates", async () => {
		const wf = workflowId("gate-reset-cancel");
		await createWorkflow(wf, [
			{ id: "slow-root", name: "Slow Root", dependsOn: [], verify: [{ name: "slow", type: "command", run: "node -e \"setTimeout(()=>process.exit(0), 3000)\"" }] },
			{ id: "downstream", name: "Downstream", dependsOn: ["slow-root"], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Reset Cancel ${Date.now()}`, workflowId: wf, worktree: false, team: false });
		const goalId = goal.id;
		const sessionId = await createSession({ goalId });
		let conn: WsConnection | undefined;
		try {
			conn = trackGateApiConnection(await connectWs(sessionId));
			const cursor = conn.messageCount();
			const signal = await signalGate(goalId, "slow-root", { content: "slow verification" });
			const signalId = signal.signal.id;
			await conn.waitForFrom(cursor, (m) => m.type === "gate_verification_started" && m.goalId === goalId && m.gateId === "slow-root" && m.signalId === signalId, 10_000);
			expect((await activeVerifications(goalId)).some((v) => v.signalId === signalId)).toBe(true);

			const resetCursor = conn.messageCount();
			const reset = await resetGate(goalId, "slow-root");
			expect(reset.status, JSON.stringify(reset.body)).toBe(200);
			expect(reset.body.affectedGateIds).toEqual(expect.arrayContaining(["slow-root", "downstream"]));
			await conn.waitForFrom(resetCursor, (m) => m.type === "gate_verification_complete" && m.goalId === goalId && m.gateId === "slow-root" && m.signalId === signalId && m.status === "cancelled", 10_000);
			expect((await activeVerifications(goalId)).some((v) => v.signalId === signalId)).toBe(false);
			await waitForGateStatus(goalId, "slow-root", "pending");
		} finally {
			conn?.close();
			await deleteSession(sessionId).catch(() => {});
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});

	test("notifies the team lead with reset, invalidation, and downstream-work context", async ({ gateway }) => {
		const wf = workflowId("gate-reset-team");
		await createWorkflow(wf, [
			{ id: "root", name: "Root Gate", dependsOn: [], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
			{ id: "child", name: "Child Gate", dependsOn: ["root"], verify: [{ name: "ok", type: "command", run: "echo ok" }] },
		]);
		const goal = await createGoal({ title: `Gate Reset Team ${Date.now()}`, workflowId: wf, worktree: false, team: true, autoStartTeam: false });
		const goalId = goal.id;
		let teamLeadId: string | undefined;
		try {
			await signalGate(goalId, "root");
			await waitForGateStatus(goalId, "root", "passed");
			await signalGate(goalId, "child");
			await waitForGateStatus(goalId, "child", "passed");

			teamLeadId = await startTeam(goalId);
			const reset = await resetGate(goalId, "root");
			expect(reset.status, JSON.stringify(reset.body)).toBe(200);
			expect(reset.body.teamLeadNotified).toBe(true);

			await pollUntil(async () => {
				const session = gateway.sessionManager.getSession(teamLeadId);
				if (!session) return null;
				const messagesResp = await session.rpcClient.getMessages();
				const messages = messagesResp.data?.messages || messagesResp.data || [];
				const queued = session.promptQueue?.toArray?.() || [];
				const text = JSON.stringify({ messages, queued, lastPromptText: session.lastPromptText, inFlightSteerTexts: session.inFlightSteerTexts });
				return text.includes("Gate reset: Root Gate")
					&& text.includes("Child Gate")
					&& /downstream work|revisit dependent implementation|Why this matters/i.test(text)
					? text
					: null;
			}, { timeoutMs: 10_000, intervalMs: 100, label: "team lead reset notification" });
		} finally {
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			await teardownTeam(goalId).catch(() => {});
			await deleteGoal(goalId).catch(() => {});
			await deleteWorkflow(wf);
		}
	});
});
