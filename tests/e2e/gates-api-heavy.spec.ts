import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, connectWs, nonGitCwd, signalAndWaitForGate } from "./e2e-setup.js";

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
	test("cascade reset — re-signaling upstream resets downstream", async () => {
		const goalId = await createGoalWithWorkflow("test-fast");
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			await signalAndWaitForGate(ws, goalId, "design-doc",
				{ content: "# Design v1\n\nApproach: X\nFiles: a.ts\nCriteria: Y" }, "passed");

			await signalAndWaitForGate(ws, goalId, "implementation", {}, "passed");

			const gatesResp1 = await apiFetch(`/api/goals/${goalId}/gates`);
			const { gates: gates1 } = await gatesResp1.json();
			expect(gates1.find((g: any) => g.gateId === "design-doc").status).toBe("passed");
			expect(gates1.find((g: any) => g.gateId === "implementation").status).toBe("passed");

			// Re-signal — signalAndWaitForGate captures cursor before signaling,
			// so it ignores the stale "passed" event from the first signal.
			await signalAndWaitForGate(ws, goalId, "design-doc",
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
		const ws = await connectWs(sessionId);
		try {
			await signalAndWaitForGate(ws, goalId, "issue-analysis",
				{ content: "# Analysis\n\nSteps: run echo\nRoot cause: src/a.ts:1" }, "passed");

			// expect:failure gate — "echo metadata-works" exits 0 so gate fails
			await signalAndWaitForGate(ws, goalId, "reproducing-test",
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
