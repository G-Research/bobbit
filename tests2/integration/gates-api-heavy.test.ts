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

});
