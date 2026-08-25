import {
	activeVerifications,
	connectWs,
	createGoal,
	createSession,
	createWorkflow,
	deleteGoal,
	deleteSession,
	deleteWorkflow,
	expect,
	pollUntil,
	resetGate,
	signalGate,
	startTeam,
	teardownTeam,
	test,
	trackGateApiConnection,
	useGateApiTestSupport,
	waitForGateStatus,
	workflowId,
	type WsConnection,
} from "../../support/helpers/integration/gateway/gate-reset-test-support.js";

useGateApiTestSupport();

test.describe("POST /api/goals/:goalId/gates/:gateId/reset", () => {
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
