/**
 * E2E API tests for cancel verification endpoint.
 *
 * Tests:
 * 1. Cancel a running verification via POST /api/goals/:goalId/gates/:gateId/cancel-verification
 * 2. Idempotent cancel when nothing is running (returns 200 with cancelled: false)
 * 3. Cancel on non-existent goal (404)
 * 4. Cancel on shelved goal (400)
 * 4b. Cancel on archived goal (409)
 * 5. Re-signal after cancel succeeds (no 409)
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, deleteGoal } from "./e2e-setup.js";

const SLOW_WORKFLOW_ID = `test-cancel-verif-${Date.now()}`;

/** Create a workflow with a slow verification command so we can cancel mid-flight. */
async function createSlowWorkflow(): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id: SLOW_WORKFLOW_ID,
			name: "Test Cancel Verification",
			description: "Workflow with slow command for cancel-verification tests",
			gates: [
				{
					id: "slow-gate",
					name: "Slow Gate",
					dependsOn: [],
					verify: [
						{
							name: "Slow check",
							type: "command",
							// 10-second sleep — long enough to cancel before it finishes
							run: 'node -e "setTimeout(()=>{console.log(\'done\');process.exit(0)},10000)"',
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

/** Get gate status. */
async function getGateStatus(goalId: string, gateId: string): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	expect(res.ok).toBe(true);
	return res.json();
}

/** Poll until a condition is met. */
async function pollUntil<T>(
	fn: () => Promise<T>,
	pred: (val: T) => boolean,
	timeoutMs = 15000,
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

test.describe("Cancel Verification API", () => {
	test.setTimeout(60_000);

	test.beforeAll(async () => {
		await createSlowWorkflow();
	});

	test.afterAll(async () => {
		await deleteSlowWorkflow();
	});

	test("cancel a running verification returns cancelled: true", async () => {
		const goal = await createGoal({
			title: `Cancel Running Verif ${Date.now()}`,
			workflowId: SLOW_WORKFLOW_ID,
			worktree: false,
		});
		const goalId = goal.id;

		try {
			// Signal the gate to start a slow verification
			const signalRes = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "Test signal" }),
			});
			expect(signalRes.status).toBe(201);

			// Wait for verification to start running
			await pollUntil(
				() => getActiveVerifications(goalId),
				(v) => v.length > 0 && v.some(a => a.overallStatus === "running"),
				10000,
			);

			// Cancel the verification
			const cancelRes = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/cancel-verification`, {
				method: "POST",
			});
			expect(cancelRes.status).toBe(200);
			const cancelBody = await cancelRes.json();
			expect(cancelBody.cancelled).toBe(true);

			// Verification should no longer be running
			await pollUntil(
				() => getActiveVerifications(goalId),
				(v) => !v.some(a => a.gateId === "slow-gate" && a.overallStatus === "running"),
				5000,
			);
		} finally {
			await deleteGoal(goalId).catch(() => {});
		}
	});

	test("cancel when nothing is running returns cancelled: false (idempotent)", async () => {
		const goal = await createGoal({
			title: `Cancel Idle Verif ${Date.now()}`,
			workflowId: SLOW_WORKFLOW_ID,
			worktree: false,
		});
		const goalId = goal.id;

		try {
			// No signal sent — nothing is running
			const cancelRes = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/cancel-verification`, {
				method: "POST",
			});
			expect(cancelRes.status).toBe(200);
			const cancelBody = await cancelRes.json();
			expect(cancelBody.cancelled).toBe(false);
		} finally {
			await deleteGoal(goalId).catch(() => {});
		}
	});

	test("cancel on non-existent goal returns 404", async () => {
		const cancelRes = await apiFetch("/api/goals/nonexistent-goal-id/gates/slow-gate/cancel-verification", {
			method: "POST",
		});
		expect(cancelRes.status).toBe(404);
		const body = await cancelRes.json();
		expect(body.error).toContain("not found");
	});

	test("cancel on shelved goal returns 400", async () => {
		const goal = await createGoal({
			title: `Cancel Shelved Verif ${Date.now()}`,
			workflowId: SLOW_WORKFLOW_ID,
			worktree: false,
		});
		const goalId = goal.id;

		try {
			// Shelve the goal via PUT
			const shelveRes = await apiFetch(`/api/goals/${goalId}`, {
				method: "PUT",
				body: JSON.stringify({ state: "shelved" }),
			});
			expect(shelveRes.ok).toBe(true);

			// Try to cancel verification on shelved goal
			const cancelRes = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/cancel-verification`, {
				method: "POST",
			});
			expect(cancelRes.status).toBe(400);
			const body = await cancelRes.json();
			expect(body.error).toContain("shelved");
		} finally {
			await deleteGoal(goalId).catch(() => {});
		}
	});

	test("cancel on archived goal returns 409", async () => {
		const goal = await createGoal({
			title: `Cancel Archived Verif ${Date.now()}`,
			workflowId: SLOW_WORKFLOW_ID,
			worktree: false,
		});
		const goalId = goal.id;

		try {
			// Archive the goal via DELETE
			const archiveRes = await apiFetch(`/api/goals/${goalId}`, {
				method: "DELETE",
			});
			expect(archiveRes.ok).toBe(true);

			// Try to cancel verification on archived goal
			const cancelRes = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/cancel-verification`, {
				method: "POST",
			});
			expect(cancelRes.status).toBe(409);
			const body = await cancelRes.json();
			expect(body.error).toContain("archived");
		} finally {
			await deleteGoal(goalId).catch(() => {});
		}
	});

	test("re-signal after cancel succeeds (no 409)", async () => {
		const goal = await createGoal({
			title: `Re-signal After Cancel ${Date.now()}`,
			workflowId: SLOW_WORKFLOW_ID,
			worktree: false,
		});
		const goalId = goal.id;

		try {
			// Signal the gate to start verification
			const signal1Res = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "Signal v1" }),
			});
			expect(signal1Res.status).toBe(201);

			// Wait for verification to start running
			await pollUntil(
				() => getActiveVerifications(goalId),
				(v) => v.length > 0 && v.some(a => a.overallStatus === "running"),
				10000,
			);

			// Cancel the verification
			const cancelRes = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/cancel-verification`, {
				method: "POST",
			});
			expect(cancelRes.status).toBe(200);
			expect((await cancelRes.json()).cancelled).toBe(true);

			// Wait for the cancellation to fully propagate
			await pollUntil(
				() => getActiveVerifications(goalId),
				(v) => !v.some(a => a.gateId === "slow-gate" && a.overallStatus === "running"),
				5000,
			);

			// Re-signal — should succeed, not 409
			const signal2Res = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "Signal v2" }),
			});
			expect(signal2Res.status).toBe(201);

			// Verify the new signal starts verification
			await pollUntil(
				() => getActiveVerifications(goalId),
				(v) => v.length > 0,
				10000,
			);

			// Cancel again to clean up the slow verification
			await apiFetch(`/api/goals/${goalId}/gates/slow-gate/cancel-verification`, {
				method: "POST",
			});
		} finally {
			await deleteGoal(goalId).catch(() => {});
		}
	});

	test("double cancel is idempotent", async () => {
		const goal = await createGoal({
			title: `Double Cancel ${Date.now()}`,
			workflowId: SLOW_WORKFLOW_ID,
			worktree: false,
		});
		const goalId = goal.id;

		try {
			// Signal the gate
			const signalRes = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "Test signal" }),
			});
			expect(signalRes.status).toBe(201);

			// Wait for verification to start
			await pollUntil(
				() => getActiveVerifications(goalId),
				(v) => v.length > 0 && v.some(a => a.overallStatus === "running"),
				10000,
			);

			// Cancel once
			const cancel1 = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/cancel-verification`, {
				method: "POST",
			});
			expect(cancel1.status).toBe(200);
			expect((await cancel1.json()).cancelled).toBe(true);

			// Wait for cancellation to take effect
			await pollUntil(
				() => getActiveVerifications(goalId),
				(v) => !v.some(a => a.gateId === "slow-gate" && a.overallStatus === "running"),
				5000,
			);

			// Cancel again — should be no-op
			const cancel2 = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/cancel-verification`, {
				method: "POST",
			});
			expect(cancel2.status).toBe(200);
			expect((await cancel2.json()).cancelled).toBe(false);
		} finally {
			await deleteGoal(goalId).catch(() => {});
		}
	});
});
