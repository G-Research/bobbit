import {
	apiFetch,
	base,
	connectWs,
	createGoal,
	createSession,
	createWorkflow,
	defaultProjectId,
	deleteGoal,
	deleteSession,
	deleteWorkflow,
	expect,
	getGate,
	getGoal,
	getSignals,
	resetGate,
	signalGate,
	test,
	trackGateApiConnection,
	updateGoal,
	useGateApiTestSupport,
	vi,
	waitForGateStatus,
	workflowId,
	type WsConnection,
} from "../../support/helpers/integration/gateway/gate-reset-test-support.js";

useGateApiTestSupport();

test.describe("POST /api/goals/:goalId/gates/:gateId/reset", () => {
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

});
