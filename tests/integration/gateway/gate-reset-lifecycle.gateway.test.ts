import {
	apiFetch,
	completeTeam,
	connectWs,
	createCompletedTask,
	createGoal,
	createWorkflow,
	deleteGoal,
	deleteSession,
	deleteWorkflow,
	expect,
	getGate,
	getGoal,
	getSignals,
	gitCwd,
	resetGate,
	resetNotificationCalls,
	signalGate,
	startTeam,
	teardownTeam,
	test,
	trackGateApiConnection,
	useGateApiTestSupport,
	vi,
	waitForGateStatus,
	waitForGoalSetupReady,
	workflowId,
	type WsConnection,
} from "../../support/helpers/integration/gateway/gate-reset-test-support.js";

useGateApiTestSupport();

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

});
