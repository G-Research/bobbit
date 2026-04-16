import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, connectWs, nonGitCwd } from "./e2e-setup.js";

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

/** Delete a goal. */
async function deleteGoal(goalId: string): Promise<void> {
	await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" });
}

test.describe("Gates API (verification)", () => {
	test("cascade reset — re-signaling upstream resets downstream", async () => {
		// Use test-fast workflow — general runs npm run check/test which is too slow for 30s timeout
		const goalId = await createGoalWithWorkflow("test-fast");
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			// Signal design-doc → pass
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design v1\n\nApproach: X\nFiles: a.ts\nCriteria: Y" }),
			});
			await ws.waitFor(m => m.type === "gate_status_changed" && m.gateId === "design-doc" && m.status === "passed", 15_000);

			// Signal implementation (test-fast just runs "echo ok")
			await apiFetch(`/api/goals/${goalId}/gates/implementation/signal`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			await ws.waitFor(m => m.type === "gate_status_changed" && m.gateId === "implementation" && m.status === "passed", 15_000);

			// Verify both are passed
			const gatesResp1 = await apiFetch(`/api/goals/${goalId}/gates`);
			const { gates: gates1 } = await gatesResp1.json();
			expect(gates1.find((g: any) => g.gateId === "design-doc").status).toBe("passed");
			expect(gates1.find((g: any) => g.gateId === "implementation").status).toBe("passed");

			// Re-signal design-doc with new content
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design v2\n\nApproach: Y\nFiles: b.ts\nCriteria: Z" }),
			});
			await ws.waitFor(m => m.type === "gate_status_changed" && m.gateId === "design-doc" && m.status === "passed", 15_000);

			// Implementation and ready-to-merge should be reset to pending
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
			// Signal issue-analysis
			await apiFetch(`/api/goals/${goalId}/gates/issue-analysis/signal`, {
				method: "POST",
				body: JSON.stringify({
					content: "# Analysis\n\nSteps: run echo\nRoot cause: src/a.ts:1",
				}),
			});
			await ws.waitFor(m => m.type === "gate_status_changed" && m.gateId === "issue-analysis" && m.status === "passed", 15_000);

			// Signal reproducing-test with metadata
			await apiFetch(`/api/goals/${goalId}/gates/reproducing-test/signal`, {
				method: "POST",
				body: JSON.stringify({
					metadata: { test_command: "echo metadata-works", error_pattern: "some error" },
				}),
			});
			// This gate has expect:failure but "echo metadata-works" exits 0, so it fails
			// That's fine — we want to check the verification output contains the resolved command
			await ws.waitFor(m => m.type === "gate_status_changed" && m.gateId === "reproducing-test" && m.status === "failed", 15_000);

			// Check the signal's verification step output — the {{test_command}} should have resolved
			const signalsResp = await apiFetch(`/api/goals/${goalId}/gates/reproducing-test/signals`);
			const { signals } = await signalsResp.json();
			const lastSignal = signals[signals.length - 1];
			// The command "echo metadata-works" ran and its output should contain the string
			const step = lastSignal.verification.steps[0];
			expect(step.output).toContain("metadata-works");
		} finally {
			ws.close();
			await deleteGoal(goalId);
		}
	});
});
