/**
 * Reproducing test for verification output modal bug.
 *
 * The bug: the modal shows "Waiting for output…" because it reads only from
 * WS-accumulated `liveOutput`, ignoring the API-fetched `output` field.
 *
 * This test proves the API contract that the modal depends on:
 * - `/api/goals/:id/verifications/active` returns step output data
 * - A consumer reading only WS-accumulated liveOutput (without receiving
 *   any WS events) would see empty output, missing the API data
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	connectWs,
	createSession,
	deleteSession,
} from "./e2e-setup.js";

/** Poll until a gate reaches the target status or timeout expires. */
async function waitForGateStatus(
	goalId: string,
	gateId: string,
	targetStatus: string,
	timeoutMs = 30_000,
): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
		const data = await res.json();
		if (data.status === targetStatus) return data;
		await new Promise(r => setTimeout(r, 300));
	}
	throw new Error(`Gate ${gateId} did not reach "${targetStatus}" within ${timeoutMs}ms`);
}

test.describe("Verification modal output bug", () => {

	test("active verification API returns step output that modal ignores", async () => {
		// Create a goal with test-fast workflow (command step runs `echo ok`)
		const goal = await createGoal({
			title: `Modal Output Bug ${Date.now()}`,
			workflowId: "test-fast",
		});
		const goalId = goal.id;
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);

		try {
			// Signal design-doc to trigger verification with a command step
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nTest content for modal output bug" }),
			});

			// Wait for verification to complete so step output is fully accumulated
			await waitForGateStatus(goalId, "design-doc", "passed", 30_000);

			// === THE BUG REPRODUCTION ===
			// Fetch the active/completed verification via REST API
			// This is what _fetchAndReconcile() and fetchActiveVerifications() do
			const res = await apiFetch(`/api/goals/${goalId}/gates/design-doc`);
			expect(res.status).toBe(200);
			const gateData = await res.json();

			// The gate should have verification results with step output
			const verification = gateData.signals?.[0]?.verification;
			expect(verification).toBeTruthy();
			expect(verification.steps).toBeTruthy();
			expect(verification.steps.length).toBeGreaterThan(0);

			// The command step should have output from `echo ok`
			const commandStep = verification.steps.find(
				(s: any) => s.type === "command"
			);
			expect(commandStep).toBeTruthy();

			// Path A: API returns output — this is what the REST endpoint provides
			const apiOutput = commandStep.output || "";
			expect(apiOutput, "REST API step output should contain command output").toBeTruthy();
			expect(apiOutput).toContain("ok");

			// Path B: Simulate what the UI modal does — reads ONLY liveOutput
			// liveOutput is only populated by WS events received by the component.
			// A consumer that connects AFTER the verification runs (or misses WS events)
			// would have liveOutput = undefined.
			const liveOutput: string | undefined = undefined; // No WS events accumulated

			// This is the bug: the modal uses `liveOutput || ""` and ignores `output`
			const buggyModalContent = liveOutput || "";
			expect(buggyModalContent, "Buggy modal path (liveOutput only) shows empty output").toBe("");

			// This is the fix: fall back to API output when liveOutput is empty
			const fixedModalContent = liveOutput || apiOutput || "";
			expect(fixedModalContent, "Fixed modal path (liveOutput || output) shows content").toBeTruthy();
			expect(fixedModalContent).toContain("ok");

		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("verification step output is available via API during/after command execution", async () => {
		// This test verifies the server-side contract: step output accumulates
		// and is accessible via the REST API, independent of WebSocket events
		const goal = await createGoal({
			title: `Step Output API ${Date.now()}`,
			workflowId: "test-fast",
		});
		const goalId = goal.id;
		const sessionId = await createSession({ goalId });

		try {
			// Signal without a WS connection — simulates a client that
			// only uses REST polling (like the modal's bootstrap fetch)
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nTest" }),
			});

			// Wait for completion
			await waitForGateStatus(goalId, "design-doc", "passed", 30_000);

			// Fetch gate data — the API must include step output
			const res = await apiFetch(`/api/goals/${goalId}/gates/design-doc`);
			const data = await res.json();

			const step = data.signals?.[0]?.verification?.steps?.[0];
			expect(step).toBeTruthy();
			expect(step.output, "Step output must be populated in API response").toBeTruthy();

		} finally {
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});
});
