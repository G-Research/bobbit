import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createSession, connectWs, nonGitCwd } from "./_e2e/e2e-setup.js";
import {
	signalAndWaitForAuthoredGate,
	trackGateApiConnection,
	useGateApiTestSupport,
} from "./helpers/gate-api-test-support.js";

useGateApiTestSupport();

/** Create a goal with a specific workflow, returning its ID. */
async function createGoalWithWorkflow(workflowId: string): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `Gate Test ${workflowId} ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			workflowId,
		}),
	});
	expect(resp.status).toBe(201);
	const goal = await resp.json();
	return goal.id;
}

async function deleteGoal(goalId: string): Promise<void> {
	await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" });
}

test.describe("Gates API (verification)", () => {
	test("ordinary gate list and detail responses omit persisted verification cache bodies", async ({ gateway }) => {
		const goalId = await createGoalWithWorkflow("test-fast");
		try {
			const gateStore = gateway.projectContextManager.getContextForGoal(goalId)?.gateStore;
			expect(gateStore).toBeTruthy();
			const marker = `INTERNAL_GATE_CACHE_BODY_${"z".repeat(128 * 1024)}`;
			const timestamp = Date.now();
			gateStore!.recordSignal({
				id: `cache-source-${timestamp}`,
				goalId,
				gateId: "design-doc",
				sessionId: "cache-response-boundary-test",
				timestamp,
				commitSha: "cache-response-boundary-commit",
				verification: {
					status: "passed",
					steps: [{
						name: "cached command",
						type: "command",
						passed: true,
						output: marker,
						duration_ms: 1,
						status: "passed",
					}],
				},
			});
			gateStore!.updateGateStatus(goalId, "design-doc", "passed");
			await gateStore!.flush();

			const stored = gateStore!.getGate(goalId, "design-doc");
			expect(stored?.verificationCache?.length).toBeGreaterThan(0);
			const cachedSignals = gateStore!.getVerificationCacheSignals(goalId, "design-doc");
			expect(cachedSignals).toHaveLength(1);
			expect(cachedSignals[0]?.verification.steps[0]?.output).toBe(marker);

			const listResponse = await apiFetch(`/api/goals/${goalId}/gates`);
			expect(listResponse.status).toBe(200);
			const listText = await listResponse.text();
			expect(listText).not.toContain(marker);
			const listed = JSON.parse(listText).gates.find((gate: any) => gate.gateId === "design-doc");
			expect(listed).not.toHaveProperty("verificationCache");
			expect(listed).toMatchObject({ status: "passed", signalCount: 1 });

			const detailResponse = await apiFetch(`/api/goals/${goalId}/gates/design-doc`);
			expect(detailResponse.status).toBe(200);
			const detailText = await detailResponse.text();
			expect(detailText).not.toContain(marker);
			const detail = JSON.parse(detailText);
			expect(detail).not.toHaveProperty("verificationCache");
			expect(detail).toMatchObject({ status: "passed", gateId: "design-doc" });
			expect(detail.signals).toHaveLength(1);

			// Response projection must not mutate the internal cache used by reuse.
			expect(gateStore!.getVerificationCacheSignals(goalId, "design-doc")[0]?.verification.steps[0]?.output).toBe(marker);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("cascade reset — re-signaling upstream resets downstream", async () => {
		const goalId = await createGoalWithWorkflow("test-fast");
		const sessionId = await createSession({ goalId });
		const ws = trackGateApiConnection(await connectWs(sessionId));
		try {
			await signalAndWaitForAuthoredGate(ws, goalId, "design-doc",
				{ content: "# Design v1\n\nApproach: X\nFiles: a.ts\nCriteria: Y" }, "passed");

			await signalAndWaitForAuthoredGate(ws, goalId, "implementation", {}, "passed");

			const gatesResp1 = await apiFetch(`/api/goals/${goalId}/gates`);
			const { gates: gates1 } = await gatesResp1.json();
			expect(gates1.find((g: any) => g.gateId === "design-doc").status).toBe("passed");
			expect(gates1.find((g: any) => g.gateId === "implementation").status).toBe("passed");

			// Re-signal and await the newly authored gate state, not a stale WS event.
			await signalAndWaitForAuthoredGate(ws, goalId, "design-doc",
				{ content: "# Design v2\n\nApproach: Y\nFiles: b.ts\nCriteria: Z" }, "passed");

			const gatesResp2 = await apiFetch(`/api/goals/${goalId}/gates`);
			const { gates: gates2 } = await gatesResp2.json();
			expect(gates2.find((g: any) => g.gateId === "implementation").status).toBe("pending");
			expect(gates2.find((g: any) => g.gateId === "ready-to-merge").status).toBe("pending");
		} finally {
			ws.close();
			await deleteGoal(goalId);
		}
	});

	test("metadata variable resolution", async () => {
		const goalId = await createGoalWithWorkflow("bug-fix");
		const sessionId = await createSession({ goalId });
		const ws = trackGateApiConnection(await connectWs(sessionId));
		try {
			await signalAndWaitForAuthoredGate(ws, goalId, "issue-analysis",
				{ content: "# Analysis\n\nSteps: run echo\nRoot cause: src/a.ts:1" }, "passed");

			// expect:failure gate — "echo metadata-works" exits 0 so gate fails
			await signalAndWaitForAuthoredGate(ws, goalId, "reproducing-test",
				{ metadata: { test_command: "echo metadata-works", error_pattern: "some error" } },
				"failed");

			const signalsResp = await apiFetch(`/api/goals/${goalId}/gates/reproducing-test/signals`);
			const { signals } = await signalsResp.json();
			const lastSignal = signals[signals.length - 1];
			const step = lastSignal.verification.steps[0];
			expect(step.output).toContain("metadata-works");
		} finally {
			ws.close();
			await deleteGoal(goalId);
		}
	});
});
