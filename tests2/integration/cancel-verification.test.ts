/**
 * Tier-1 API tests for the cancel-verification endpoint. The integration
 * project injects the non-spawning fake command-step runner: these assertions
 * cover API state, idempotency, cancellation bookkeeping, and re-signal
 * behavior without claiming OS process-tree fidelity.
 *
 * Tests:
 * 1. Cancel a running verification via POST /api/goals/:goalId/gates/:gateId/cancel-verification
 * 2. Idempotent cancel when nothing is running (returns 200 with cancelled: false)
 * 3. Cancel on non-existent goal (404)
 * 4. Cancel on shelved goal (400)
 * 4b. Cancel on archived goal (409)
 * 5. Re-signal after cancel succeeds (no 409)
 */
// This suite owns command-step cancellation bookkeeping, not OS process
// fidelity. Opt into the non-spawning runner before the gateway singleton is
// imported and booted.
import { EventEmitter } from "node:events";

import { resetAndInstallFakeCommandStepTestState, trackFakeCommandStepConnection } from "./_e2e/fake-cmd-setup.js";

import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, connectWs, createGoal, createSession, defaultProjectId, deleteGoal, deleteSession, type WsConnection } from "./_e2e/e2e-setup.js";
import type { ManualClock } from "../harness/clock.js";
import type { VerificationCommandRunner, VerificationCommandSpawnSpec } from "../../src/server/agent/verification-command-runner.js";
import type { TrackedChild } from "../../src/server/agent/spawn-tree.js";

type SlowWorkflowGoal = {
	workflowId: string;
	projectId: string;
	goalId: string;
};

function makeSlowWorkflowId(): string {
	return `test-cancel-verif-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a per-test workflow whose scripted fake step remains cancellable. */
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

async function getGateState(goalId: string): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/slow-gate`);
	expect(res.status).toBe(200);
	return res.json();
}

/**
 * A deterministic command-runner seam: `settle()` is the test's stand-in for
 * exact identity proof plus tree reaping. Until then `waitForTreeExit()` stays
 * pending even after `killTree()`, so no wall-clock race is involved.
 */
interface PendingCleanupChild {
	killed: boolean;
	settled: boolean;
	settle: () => void;
	waitForKill: () => Promise<void>;
}

class PendingExactCleanupRunner implements VerificationCommandRunner {
	readonly nonDurable = true;
	readonly children: PendingCleanupChild[] = [];
	private readonly spawnWaiters = new Map<number, Array<() => void>>();

	spawn(_spec: VerificationCommandSpawnSpec): TrackedChild {
		const child = Object.assign(new EventEmitter(), {
			pid: 970_000 + this.children.length,
			stdout: Object.assign(new EventEmitter(), { destroy() {} }),
			stderr: Object.assign(new EventEmitter(), { destroy() {} }),
			unref() {},
			kill() { return true; },
		});
		let resolveTreeExit!: (settled: boolean) => void;
		let resolveKill!: () => void;
		const treeExit = new Promise<boolean>(resolve => { resolveTreeExit = resolve; });
		const killed = new Promise<void>(resolve => { resolveKill = resolve; });
		const record: PendingCleanupChild = {
			killed: false,
			settled: false,
			settle: () => {
				if (record.settled) return;
				record.settled = true;
				child.emit("exit", null, "SIGTERM");
				child.emit("close", null, "SIGTERM");
				resolveTreeExit(true);
			},
			waitForKill: () => killed,
		};
		this.children.push(record);
		for (const resolve of this.spawnWaiters.get(this.children.length - 1) ?? []) resolve();
		this.spawnWaiters.delete(this.children.length - 1);

		return {
			child: child as unknown as TrackedChild["child"],
			ownershipReady: Promise.resolve(),
			waitForTreeExit: async () => treeExit,
			killed: () => record.killed,
			timedOut: () => false,
			markSurvival: () => {},
			killTree: () => {
				if (record.killed) return;
				record.killed = true;
				resolveKill();
			},
		};
	}

	waitForSpawn(index: number): Promise<void> {
		if (this.children[index]) return Promise.resolve();
		return new Promise(resolve => {
			const waiters = this.spawnWaiters.get(index) ?? [];
			waiters.push(resolve);
			this.spawnWaiters.set(index, waiters);
		});
	}

	async waitForKill(index: number): Promise<void> {
		await this.waitForSpawn(index);
		return this.children[index].waitForKill();
	}

	settle(index: number): void {
		this.children[index]?.settle();
	}

	settleAll(): void {
		for (const child of this.children) child.settle();
	}
}

/** Observe cancellation state without adding wall-clock sleeps to tier 1. */
async function observeUntil<T>(
	clock: ManualClock,
	fn: () => Promise<T>,
	pred: (val: T) => boolean,
	maxVirtualMs = 15000,
): Promise<T> {
	for (let advanced = 0; advanced <= maxVirtualMs; advanced += 100) {
		const captured = await fn();
		if (pred(captured)) return captured;
		await new Promise<void>((resolve) => setImmediate(resolve));
		clock.advance(100);
	}
	throw new Error(`cancel-verification state did not settle after ${maxVirtualMs}ms of virtual time`);
}

// Keep the stateful cancellation cases serial so cleanup and re-signal
// transitions cannot overlap in the shared verification harness.
test.describe.configure({ mode: "serial" });

test.describe("Cancel Verification API", () => {
	test.setTimeout(60_000);
	test.beforeEach(async ({ gateway }) => resetAndInstallFakeCommandStepTestState(gateway));
	test.afterEach(async ({ gateway }) => resetAndInstallFakeCommandStepTestState(gateway));

	test("cancel a running verification returns cancelled: true", async ({ gateway }) => {
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

			// Observe the running record without a wall-clock polling interval.
			await observeUntil(
				gateway.clock,
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

			// Cancellation bookkeeping is synchronous; drive any queued cleanup with
			// the gateway's manual clock instead of sleeping between REST reads.
			await observeUntil(
				gateway.clock,
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

	test("re-signal after cancel succeeds (no 409)", async ({ gateway }) => {
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

			await observeUntil(
				gateway.clock,
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

			await observeUntil(
				gateway.clock,
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

			// Verify the new signal starts verification without a real wait.
			await observeUntil(
				gateway.clock,
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

	test("defers explicit cancellation publication until exact cleanup settles", async ({ gateway }) => {
		let setup: SlowWorkflowGoal | undefined;
		let sessionId: string | undefined;
		let conn: WsConnection | undefined;
		let cancelRequest: Promise<Response> | undefined;
		const runner = new PendingExactCleanupRunner();
		gateway.teamManager.verificationHarness!.commandStepRunner = runner;
		try {
			setup = await createSlowWorkflowGoal("Pending Explicit Cancel");
			sessionId = await createSession({ goalId: setup.goalId });
			conn = trackFakeCommandStepConnection(await connectWs(sessionId));

			const signalRes = await apiFetch(`/api/goals/${setup.goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "Cancellation must await exact cleanup." }),
			});
			expect(signalRes.status).toBe(201);
			const signalId = (await signalRes.json()).signal.id as string;
			await runner.waitForSpawn(0);
			const eventCursor = conn.messageCount();

			cancelRequest = apiFetch(`/api/goals/${setup.goalId}/gates/slow-gate/cancel-verification`, { method: "POST" });
			await runner.waitForKill(0);

			const pending = await getGateState(setup.goalId);
			expect(pending.status, "PENDING_CANCEL_GATE_STATUS_PUBLISHED_EARLY").toBe("pending");
			expect(pending.signals.find((signal: any) => signal.id === signalId)?.verification.status,
				"PENDING_CANCEL_SIGNAL_FINALIZED_EARLY").toBe("running");
			expect(conn.messages.slice(eventCursor).filter((event: any) =>
				event.type === "gate_verification_complete" && event.signalId === signalId),
				"PENDING_CANCEL_COMPLETION_PUBLISHED_EARLY").toHaveLength(0);

			// This is the sole release point: it models successful exact witness
			// verification and the terminal tree-reap acknowledgement.
			runner.settle(0);
			const cancelRes = await cancelRequest;
			expect(cancelRes.status).toBe(200);
			expect((await cancelRes.json()).cancelled).toBe(true);

			const finalized = await getGateState(setup.goalId);
			const cancelledSignals = finalized.signals.filter((signal: any) => signal.id === signalId && signal.verification.status === "failed");
			expect(cancelledSignals, "EXACT_CLEANUP_MUST_FINALIZE_CURRENT_SIGNAL_ONCE").toHaveLength(1);
			expect(finalized.status).toBe("failed");
			expect(conn.messages.slice(eventCursor).filter((event: any) =>
				event.type === "gate_verification_complete" && event.signalId === signalId && event.status === "cancelled"),
				"EXACT_CLEANUP_MUST_PUBLISH_ONE_COMPLETION").toHaveLength(1);
		} finally {
			runner.settleAll();
			await cancelRequest?.catch(() => {});
			conn?.close();
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await cleanupSlowWorkflowGoal(setup);
		}
	});

	test("late cancellation finalization cannot overwrite a newer re-signal", async ({ gateway }) => {
		let setup: SlowWorkflowGoal | undefined;
		let sessionId: string | undefined;
		let conn: WsConnection | undefined;
		let resignalRequest: Promise<Response> | undefined;
		const runner = new PendingExactCleanupRunner();
		gateway.teamManager.verificationHarness!.commandStepRunner = runner;
		try {
			setup = await createSlowWorkflowGoal("Pending Re-signal Generation");
			sessionId = await createSession({ goalId: setup.goalId });
			conn = trackFakeCommandStepConnection(await connectWs(sessionId));

			const firstRes = await apiFetch(`/api/goals/${setup.goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "Old generation" }),
			});
			expect(firstRes.status).toBe(201);
			const firstSignalId = (await firstRes.json()).signal.id as string;
			await runner.waitForSpawn(0);
			const eventCursor = conn.messageCount();

			resignalRequest = apiFetch(`/api/goals/${setup.goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "New generation" }),
			});
			await runner.waitForKill(0);
			await new Promise<void>(resolve => setImmediate(resolve));

			const beforeOldCleanup = await getGateState(setup.goalId);
			expect(beforeOldCleanup.signals, "RESIGNAL_MUST_CREATE_NEW_GENERATION_BEFORE_OLD_CLEANUP_SETTLES").toHaveLength(2);
			const secondSignalId = beforeOldCleanup.signals.at(-1)?.id as string;
			expect(secondSignalId).not.toBe(firstSignalId);
			expect(beforeOldCleanup.signals.at(-1)?.verification.status).toBe("running");

			const oldCompletion = conn.waitForFrom(eventCursor, (event: any) =>
				event.type === "gate_verification_complete" && event.signalId === firstSignalId && event.status === "cancelled");
			runner.settle(0);
			await oldCompletion;
			const resignalRes = await resignalRequest;
			expect(resignalRes.status).toBe(201);

			const afterOldCleanup = await getGateState(setup.goalId);
			expect(afterOldCleanup.signals.find((signal: any) => signal.id === firstSignalId)?.verification.status).toBe("failed");
			expect(afterOldCleanup.signals.find((signal: any) => signal.id === secondSignalId)?.verification.status,
				"LATE_CANCEL_MUST_NOT_FINALIZE_NEW_SIGNAL").toBe("running");
			expect(afterOldCleanup.status, "LATE_CANCEL_MUST_NOT_OVERWRITE_NEW_GATE_STATE").toBe("pending");
		} finally {
			runner.settleAll();
			await resignalRequest?.catch(() => {});
			conn?.close();
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await cleanupSlowWorkflowGoal(setup);
		}
	});

	test("double cancel is idempotent", async ({ gateway }) => {
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

			await observeUntil(
				gateway.clock,
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

			await observeUntil(
				gateway.clock,
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
