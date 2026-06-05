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
import { apiFetch, createGoal, defaultProjectId, deleteGoal } from "./e2e-setup.js";
import { pollUntil as pollUntilCleanup } from "./test-utils/cleanup.js";

type SlowWorkflowGoal = {
	workflowId: string;
	projectId: string;
	goalId: string;
};

function makeSlowWorkflowId(): string {
	return `test-cancel-verif-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a per-test workflow with a slow verification command so we can cancel mid-flight. */
async function createSlowWorkflow(): Promise<{ workflowId: string; projectId: string }> {
	const projectId = await defaultProjectId();
	if (!projectId) throw new Error("cancel-verification requires a default project");
	const workflowId = makeSlowWorkflowId();

	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			projectId,
			id: workflowId,
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
	if (res.status !== 201) {
		throw new Error(`createSlowWorkflow expected 201, got ${res.status}: ${await res.text()}`);
	}

	// Verify through the same project-scoped workflow lookup that POST /api/goals uses.
	const readRes = await apiFetch(`/api/workflows/${encodeURIComponent(workflowId)}?projectId=${encodeURIComponent(projectId)}`);
	if (readRes.status !== 200) {
		throw new Error(`createSlowWorkflow read-after-write expected 200, got ${readRes.status}: ${await readRes.text()}`);
	}

	return { workflowId, projectId };
}

async function createSlowWorkflowGoal(title: string): Promise<SlowWorkflowGoal> {
	const setup = await createSlowWorkflow();
	try {
		const goal = await createGoal({
			title: `${title} ${Date.now()}`,
			workflowId: setup.workflowId,
			projectId: setup.projectId,
			worktree: false,
		});
		return { ...setup, goalId: goal.id };
	} catch (err) {
		await deleteSlowWorkflow(setup.workflowId, setup.projectId);
		throw err;
	}
}

/** Delete the slow workflow (cleanup). */
async function deleteSlowWorkflow(workflowId: string, projectId: string): Promise<void> {
	await apiFetch(`/api/workflows/${encodeURIComponent(workflowId)}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
}

async function cleanupSlowWorkflowGoal(setup: SlowWorkflowGoal | undefined): Promise<void> {
	if (!setup) return;
	await apiFetch(`/api/goals/${setup.goalId}/gates/slow-gate/cancel-verification`, { method: "POST" }).catch(() => {});
	await deleteGoal(setup.goalId).catch(() => {});
	await deleteSlowWorkflow(setup.workflowId, setup.projectId);
}

/** Get active verifications for a goal. */
async function getActiveVerifications(goalId: string): Promise<any[]> {
	const res = await apiFetch(`/api/goals/${goalId}/verifications/active`);
	expect(res.ok).toBe(true);
	const data = await res.json();
	return data.verifications || [];
}

/** Poll until a predicate is satisfied — adapter over the shared pollUntil. */
async function pollUntil<T>(
	fn: () => Promise<T>,
	pred: (val: T) => boolean,
	timeoutMs = 15000,
	intervalMs = 100,
): Promise<T> {
	let captured: T;
	await pollUntilCleanup(async () => {
		captured = await fn();
		return pred(captured);
	}, { timeoutMs, intervalMs, label: "cancel-verif predicate" });
	return captured!;
}

test.describe("Cancel Verification API", () => {
	test.setTimeout(60_000);

	test("cancel a running verification returns cancelled: true", async () => {
		let setup: SlowWorkflowGoal | undefined;
		try {
			setup = await createSlowWorkflowGoal("Cancel Running Verif");
			const { goalId } = setup;

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
			await cleanupSlowWorkflowGoal(setup);
		}
	});

	test("cancel when nothing is running returns cancelled: false (idempotent)", async () => {
		let setup: SlowWorkflowGoal | undefined;
		try {
			setup = await createSlowWorkflowGoal("Cancel Idle Verif");
			const { goalId } = setup;

			// No signal sent — nothing is running
			const cancelRes = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/cancel-verification`, {
				method: "POST",
			});
			expect(cancelRes.status).toBe(200);
			const cancelBody = await cancelRes.json();
			expect(cancelBody.cancelled).toBe(false);
		} finally {
			await cleanupSlowWorkflowGoal(setup);
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
		let setup: SlowWorkflowGoal | undefined;
		try {
			setup = await createSlowWorkflowGoal("Cancel Shelved Verif");
			const { goalId } = setup;

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
			await cleanupSlowWorkflowGoal(setup);
		}
	});

	test("cancel on archived goal returns 409", async () => {
		let setup: SlowWorkflowGoal | undefined;
		try {
			setup = await createSlowWorkflowGoal("Cancel Archived Verif");
			const { goalId } = setup;

			// Archive the goal via DELETE
			const archiveRes = await apiFetch(`/api/goals/${goalId}?cascade=true`, {
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
			await cleanupSlowWorkflowGoal(setup);
		}
	});

	test("re-signal after cancel succeeds (no 409)", async () => {
		let setup: SlowWorkflowGoal | undefined;
		try {
			setup = await createSlowWorkflowGoal("Re-signal After Cancel");
			const { goalId } = setup;

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
			await cleanupSlowWorkflowGoal(setup);
		}
	});

	test("double cancel is idempotent", async () => {
		let setup: SlowWorkflowGoal | undefined;
		try {
			setup = await createSlowWorkflowGoal("Double Cancel");
			const { goalId } = setup;

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
			await cleanupSlowWorkflowGoal(setup);
		}
	});
});
