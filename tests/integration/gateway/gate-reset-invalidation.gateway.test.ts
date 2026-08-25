import {
	connectWs,
	createGoal,
	createSession,
	createWorkflow,
	deleteGoal,
	deleteSession,
	deleteWorkflow,
	expect,
	getGate,
	getSignals,
	gitCwd,
	latestVerificationOutput,
	resetGate,
	signalAndWaitForAuthoredGateWithFakeCommandBarrier,
	signalGate,
	test,
	trackGateApiConnection,
	useGateApiTestSupport,
	waitForGateStatus,
	waitForGoalSetupReady,
	workflowId,
	type WsConnection,
} from "../../support/helpers/integration/gateway/gate-reset-test-support.js";

useGateApiTestSupport();

test.describe("POST /api/goals/:goalId/gates/:gateId/reset", () => {
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
			await signalAndWaitForAuthoredGateWithFakeCommandBarrier(goalId, "root", {}, "passed");
			expect(await latestVerificationOutput(goalId, "root")).toContain("FRESH_ROOT_AFTER_RESET");

			await signalAndWaitForAuthoredGateWithFakeCommandBarrier(goalId, "child", {}, "passed");
			expect(await latestVerificationOutput(goalId, "child")).toContain("FRESH_CHILD_AFTER_RESET");

			const reset = await resetGate(goalId, "root");
			expect(reset.status, JSON.stringify(reset.body)).toBe(200);
			expect(reset.body.affectedGateIds).toEqual(expect.arrayContaining(["root", "child"]));
			await waitForGateStatus(goalId, "root", "pending");
			await waitForGateStatus(goalId, "child", "pending");

			await signalAndWaitForAuthoredGateWithFakeCommandBarrier(goalId, "root", {}, "passed");
			const rootOutput = await latestVerificationOutput(goalId, "root");
			expect(rootOutput).toContain("FRESH_ROOT_AFTER_RESET");
			expect.soft(
				rootOutput,
				"FRESH_GATE_RESET_CACHE_REUSED: root gate reused pre-reset verification output after manual reset",
			).not.toContain("[cached from prior signal]");

			await signalAndWaitForAuthoredGateWithFakeCommandBarrier(goalId, "child", {}, "passed");
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

});
