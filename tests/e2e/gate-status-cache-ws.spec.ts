import { expect } from "@playwright/test";
import { test } from "./in-process-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	createGoal,
	deleteGoal,
	connectWs,
} from "./e2e-setup.js";

test.describe("Gate status WebSocket broadcast", () => {
	test("gate_status_changed is broadcast when a gate passes", async () => {
		let sessionId: string | undefined;
		let goalId: string | undefined;
		let conn: Awaited<ReturnType<typeof connectWs>> | undefined;

		try {
			// Create a goal with the "general" workflow, then attach a matching
			// goal-session socket. Goal broadcasts intentionally skip unrelated
			// regular sessions.
			const goal = await createGoal({ title: `WS Gate Test ${Date.now()}`, workflowId: "general" });
			goalId = goal.id;
			sessionId = await createSession({ goalId });
			conn = await connectWs(sessionId);

			// Signal the design-doc gate (no dependencies, has LLM review that auto-passes with mock agent)
			const signalResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({
					content: "# Design\n\nApproach: test approach\n\nFiles: src/test.ts\n\nCriteria: it works",
				}),
			});
			expect(signalResp.status).toBe(201);

			// Wait for gate_status_changed WS message
			const wsMsg = await conn!.waitFor(
				(m) =>
					m.type === "gate_status_changed" &&
					m.goalId === goalId &&
					m.gateId === "design-doc" &&
					m.status === "passed",
				15_000,
			);

			expect(wsMsg.type).toBe("gate_status_changed");
			expect(wsMsg.goalId).toBe(goalId);
			expect(wsMsg.gateId).toBe("design-doc");
			expect(wsMsg.status).toBe("passed");

			// Verify via REST API that the gate is actually passed
			const gateResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc`);
			expect(gateResp.status).toBe(200);
			const gateData = await gateResp.json();
			expect(gateData.status).toBe("passed");
		} finally {
			conn?.close();
			if (goalId) await deleteGoal(goalId);
			if (sessionId) await deleteSession(sessionId);
		}
	});
});
