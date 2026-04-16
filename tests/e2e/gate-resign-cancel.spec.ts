import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, deleteGoal, createSession, deleteSession, connectWs, type WsConnection } from "./e2e-setup.js";

/**
 * E2E test for gate re-signal cancellation.
 *
 * Verifies that when a gate is re-signaled while verification is running:
 * 1. The old verification is cancelled (removed from active verifications)
 * 2. Only the new signal's verification is active/completed
 * 3. The gate status reflects the new signal's result
 */

const SLOW_WORKFLOW_ID = `test-slow-${Date.now()}`;

/** Create a workflow with a slow verification command for testing cancellation. */
async function createSlowWorkflow(): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id: SLOW_WORKFLOW_ID,
			name: "Test Slow Verification",
			description: "Workflow with a slow command for testing re-signal cancellation",
			gates: [
				{
					id: "slow-gate",
					name: "Slow Gate",
					dependsOn: [],
					verify: [
						{
							name: "Slow check",
							type: "command",
							// 5-second sleep — long enough to re-signal before it finishes
							run: 'node -e "setTimeout(()=>{console.log(\'done\');process.exit(0)},2000)"',
						},
					],
				},
			],
		}),
	});
	expect(res.status).toBe(201);
}

/** Delete the slow workflow (cleanup). */
async function deleteSlowWorkflow(): Promise<void> {
	await apiFetch(`/api/workflows/${SLOW_WORKFLOW_ID}`, { method: "DELETE" }).catch(() => {});
}

/** Get active verifications for a goal. */
async function getActiveVerifications(goalId: string): Promise<any[]> {
	const res = await apiFetch(`/api/goals/${goalId}/verifications/active`);
	expect(res.ok).toBe(true);
	const data = await res.json();
	return data.verifications || [];
}

/** Get signal history for a gate. */
async function getSignals(goalId: string, gateId: string): Promise<any[]> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signals`);
	expect(res.ok).toBe(true);
	const data = await res.json();
	return data.signals || [];
}

/**
 * Poll until a condition is met, with timeout.
 */
async function pollUntil<T>(
	fn: () => Promise<T>,
	pred: (val: T) => boolean,
	timeoutMs = 20000,
	intervalMs = 100,
): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const val = await fn();
		if (pred(val)) return val;
		await new Promise(r => setTimeout(r, intervalMs));
	}
	const lastVal = await fn();
	if (pred(lastVal)) return lastVal;
	throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

test.describe("Gate Re-signal Cancellation", () => {
	// These tests use slow verification commands (5s each), so they need more time
	test.setTimeout(60_000);

	test.beforeAll(async () => {
		await createSlowWorkflow();
	});

	test.afterAll(async () => {
		await deleteSlowWorkflow();
	});

	test("re-signaling a gate cancels the previous verification", async () => {
		// 1. Create a goal with the slow workflow
		const goal = await createGoal({
			title: `Re-signal Cancel Test ${Date.now()}`,
			workflowId: SLOW_WORKFLOW_ID,
			worktree: false,
		});
		const goalId = goal.id;

		// Open a WS connection to receive gate events
		const sessionId = await createSession();
		let conn: WsConnection | undefined;

		try {
			conn = await connectWs(sessionId);

			// 2. Signal the gate — starts verification with the 2s command
			const signal1Res = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "Signal v1" }),
			});
			expect(signal1Res.status).toBe(201);
			const signal1Data = await signal1Res.json();
			const signal1Id = signal1Data.signal.id;

			// 3. Wait for verification to start via WS event
			await conn.waitFor(
				(m) => m.type === "gate_verification_started" && m.gateId === "slow-gate" && m.signalId === signal1Id,
				5000,
			);

			// 4. Verify the first signal's verification is active via REST
			const activeBeforeResignal = await getActiveVerifications(goalId);
			expect(activeBeforeResignal.length).toBeGreaterThanOrEqual(1);
			const firstVerification = activeBeforeResignal.find(v => v.signalId === signal1Id);
			expect(firstVerification).toBeTruthy();
			expect(firstVerification.overallStatus).toBe("running");

			// 5. Re-signal the same gate (second signal)
			const signal2Res = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "Signal v2" }),
			});
			expect(signal2Res.status).toBe(201);
			const signal2Data = await signal2Res.json();
			const signal2Id = signal2Data.signal.id;
			expect(signal2Id).not.toBe(signal1Id);

			// 6. Wait for old verification to be cancelled via WS event
			await conn.waitFor(
				(m) => m.type === "gate_verification_complete" && m.signalId === signal1Id && m.status === "cancelled",
				10_000,
			);

			// Confirm old verification is no longer in active list
			const activeAfterResignal = await getActiveVerifications(goalId);
			expect(activeAfterResignal.find(v => v.signalId === signal1Id)).toBeFalsy();

			// 7. Wait for the gate to pass via WS event
			const wsMsg = await conn.waitFor(
				(m) => m.type === "gate_status_changed" && m.gateId === "slow-gate" && (m.status === "passed" || m.status === "failed"),
				20_000,
			);

			// 8. Gate status should be determined by the new signal (passed, since command exits 0)
			expect(wsMsg.status).toBe("passed");

			// Verify signal history: both signals recorded, latest is v2
			const signals = await getSignals(goalId, "slow-gate");
			expect(signals.length).toBe(2);

			// The latest signal (v2) should have passed verification
			const latestSignal = signals[signals.length - 1];
			expect(latestSignal.id).toBe(signal2Id);
			expect(latestSignal.verification.status).toBe("passed");
		} finally {
			conn?.close();
			await deleteGoal(goalId).catch(() => {});
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("triple re-signal — only final signal determines outcome", async () => {
		const goal = await createGoal({
			title: `Triple Re-signal Test ${Date.now()}`,
			workflowId: SLOW_WORKFLOW_ID,
			worktree: false,
		});
		const goalId = goal.id;

		// Open a WS connection to receive gate events
		const sessionId = await createSession();
		let conn: WsConnection | undefined;

		try {
			conn = await connectWs(sessionId);

			// Signal 1
			const s1Res = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "Signal v1" }),
			});
			expect(s1Res.status).toBe(201);

			// Wait for verification to start via WS
			await conn.waitFor(
				(m) => m.type === "gate_verification_started" && m.gateId === "slow-gate",
				5000,
			);

			// Signal 2 (cancels signal 1)
			const s2Res = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "Signal v2" }),
			});
			expect(s2Res.status).toBe(201);

			// Wait briefly for signal 2's verification to start
			await new Promise(r => setTimeout(r, 200));

			// Signal 3 (cancels signal 2)
			const s3Res = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "Signal v3" }),
			});
			expect(s3Res.status).toBe(201);
			const s3Data = await s3Res.json();
			const signal3Id = s3Data.signal.id;

			// Only the latest verification should be active
			await pollUntil(
				() => getActiveVerifications(goalId),
				(verifs) => {
					// Should have at most 1 active verification, and it should be the latest
					return verifs.length <= 1 && (!verifs.length || verifs[0].signalId === signal3Id);
				},
				5000,
			);

			// Wait for the gate to pass via WS event (replaces REST polling)
			const wsMsg = await conn.waitFor(
				(m) => m.type === "gate_status_changed" && m.gateId === "slow-gate" && (m.status === "passed" || m.status === "failed"),
				20_000,
			);
			expect(wsMsg.status).toBe("passed");

			// Verify no stale verifications remain active
			const activeAfter = await getActiveVerifications(goalId);
			expect(activeAfter.length).toBe(0);
		} finally {
			conn?.close();
			await deleteGoal(goalId).catch(() => {});
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
