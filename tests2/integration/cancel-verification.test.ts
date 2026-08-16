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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";
import { resetAndInstallFakeCommandStepTestState, trackFakeCommandStepConnection } from "./_e2e/fake-cmd-setup.js";
import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import { VerificationHarness, type ActiveVerification } from "../../src/server/agent/verification-harness.js";
import { createManualClock, type ManualClock } from "../harness/clock.js";

import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, connectWs, createGoal, createSession, defaultProjectId, deleteGoal, deleteSession, gitCwd, startTeam, teardownTeam, type WsConnection } from "./_e2e/e2e-setup.js";
import type { VerificationCommandRunner, VerificationCommandSpawnSpec } from "../../src/server/agent/verification-command-runner.js";
import type { TrackedChild } from "../../src/server/agent/spawn-tree.js";

type SlowWorkflowGoal = {
	workflowId: string;
	projectId: string;
	goalId: string;
};
type SlowGateSignal = { signal: { id: string } };
type SlowGateState = {
	status: string;
	signals: Array<{
		id: string;
		verification: {
			status: string;
			cancellation?: { cause: string; requestedAt: number; finalizedAt?: number };
			steps: Array<{
				name: string;
				status?: string;
				output?: string;
				cancellation?: { cause: string; requestedAt: number; finalizedAt?: number };
			}>;
		};
	}>;
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
			cwd: gitCwd(),
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

/**
 * Cancelled rows remain in the harness ownership map until exact cleanup
 * settles, but are deliberately hidden by the public live-verifications API.
 */
function getCancellationOwnershipRecord(gateway: any, signalId: string): ActiveVerification {
	const record = gateway.teamManager.verificationHarness!.activeVerifications.get(signalId) as ActiveVerification | undefined;
	expect(record, "CANCELLATION_OWNERSHIP_RECORD_MUST_SURVIVE_UNTIL_EXACT_CLEANUP").toBeTruthy();
	return record!;
}

async function cancelSlowVerification(goalId: string): Promise<Response> {
	return apiFetch(`/api/goals/${goalId}/gates/slow-gate/cancel-verification`, { method: "POST" });
}

async function signalSlowVerification(goalId: string, content: string): Promise<Response> {
	return apiFetch(`/api/goals/${goalId}/gates/slow-gate/signal`, {
		method: "POST",
		body: JSON.stringify({ content }),
	});
}

async function getGateState(goalId: string): Promise<SlowGateState> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/slow-gate`);
	expect(res.status).toBe(200);
	return await res.json() as SlowGateState;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}

async function expectNoSignalAdmission(gateway: any, goalId: string, expectedSignalCount = 0): Promise<void> {
	const gate = await getGateState(goalId);
	expect(gate.signals, "REJECTED_SIGNAL_MUST_NOT_CREATE_A_SIGNAL_RECORD").toHaveLength(expectedSignalCount);
	expect(gateway.teamManager.verificationHarness!.getActiveVerifications(goalId),
		"REJECTED_SIGNAL_MUST_NOT_CREATE_AN_ACTIVE_VERIFICATION").toEqual([]);
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

const RESTART_CANCEL_GOAL_ID = "restart-cancel-publication-goal";
const RESTART_CANCEL_GATE_ID = "restart-cancel-publication-gate";
const RESTART_CANCEL_ROLE_STORE = Object.freeze({ get: () => undefined, getAll: () => [] });

type RestartCancellationFixture = {
	stateDir: string;
	clock: ManualClock;
	gateStore: GateStore;
	harness: VerificationHarness;
	oldSignalId: string;
	newSignalId?: string;
	events: any[];
	setCleanupReady: () => void;
	cleanupAttempts: () => number;
};

function restartCancellationSignal(id: string, contentVersion: number): GateSignal {
	return {
		id,
		goalId: RESTART_CANCEL_GOAL_ID,
		gateId: RESTART_CANCEL_GATE_ID,
		sessionId: "restart-cancel-owner",
		timestamp: 1_700_000_000_000 + contentVersion,
		commitSha: "0123456789abcdef0123456789abcdef01234567",
		content: `restart cancellation generation ${contentVersion}`,
		contentVersion,
		verification: {
			status: "running",
			steps: [
				{ name: "Completed prerequisite", type: "command", passed: true, status: "passed", phase: 0, output: "completed output survives restart cancellation", duration_ms: 10 },
				{ name: "Exact cleanup", type: "command", passed: false, status: "running", phase: 1, output: "", duration_ms: 0 },
			],
		},
	};
}

/**
 * Model a restart at the durable boundary. The injected reaper is the exact
 * sentinel authority: it either acknowledges the persisted sentinel once or
 * returns the typed pending state that drives the manual-clock retry.
 */
function createRestartCancellationFixture(options: { pendingFirst?: boolean; newerSignal?: boolean } = {}): RestartCancellationFixture {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-verification-restart-"));
	const clock = createManualClock(1_700_000_000_000);
	const gateStore = new GateStore(stateDir, undefined, { persistence: "json" });
	gateStore.initGatesForGoal(RESTART_CANCEL_GOAL_ID, [RESTART_CANCEL_GATE_ID]);
	const oldSignalId = `restart-cancel-old-${Math.random().toString(36).slice(2)}`;
	gateStore.recordSignal(restartCancellationSignal(oldSignalId, 1));
	let newSignalId: string | undefined;
	if (options.newerSignal) {
		newSignalId = `restart-cancel-new-${Math.random().toString(36).slice(2)}`;
		gateStore.recordSignal(restartCancellationSignal(newSignalId, 2));
	}

	const persisted: ActiveVerification = {
		goalId: RESTART_CANCEL_GOAL_ID,
		gateId: RESTART_CANCEL_GATE_ID,
		signalId: oldSignalId,
		overallStatus: "cancelled",
		cancelled: true,
		// Process kill mechanics remain separate from durable orchestration
		// provenance. The typed cancellation field is assigned through `any` until
		// the production contract lands on this testing branch.
		cancelReason: "cancelled",
		cancelRequestedAt: clock.now(),
		startedAt: clock.now(),
		steps: [
			{
				name: "Completed prerequisite",
				type: "command",
				status: "passed",
				phase: 0,
				startedAt: clock.now() - 10,
				output: "completed output survives restart cancellation",
				durationMs: 10,
			},
			{
				name: "Exact cleanup",
				type: "command",
				status: "running",
				phase: 1,
				startedAt: clock.now(),
				sentinelFile: path.join(stateDir, "exact-owner.sentinel.json"),
				killRequestedAt: clock.now(),
				killReason: "cancelled",
				killSignal: "SIGKILL",
			},
		],
	};
	(persisted as any).cancellation = { cause: "manual", requestedAt: clock.now() };
	fs.writeFileSync(path.join(stateDir, "active-verifications.json"), JSON.stringify({ verifications: [persisted] }));

	let cleanupReady = !options.pendingFirst;
	let attempts = 0;
	const events: any[] = [];
	const harness = new VerificationHarness(
		stateDir,
		gateStore,
		(_goalId, event) => events.push(event),
		RESTART_CANCEL_ROLE_STORE as any,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			clock,
			platform: "linux",
			recoveredSentinelReaper: async (step) => {
				attempts++;
				expect(step.sentinelFile, "RESTART_CANCEL_MUST_REAP_THE_PERSISTED_EXACT_SENTINEL").toBe(persisted.steps[1].sentinelFile);
				if (cleanupReady) return;
				const pending = new Error("exact persisted ownership cleanup remains pending");
				pending.name = "PendingCommandCleanupError";
				throw pending;
			},
		},
	);
	return {
		stateDir,
		clock,
		gateStore,
		harness,
		oldSignalId,
		newSignalId,
		events,
		setCleanupReady: () => { cleanupReady = true; },
		cleanupAttempts: () => attempts,
	};
}

function restartCancellationState(fixture: RestartCancellationFixture) {
	const gate = fixture.gateStore.getGate(RESTART_CANCEL_GOAL_ID, RESTART_CANCEL_GATE_ID)!;
	const oldSignal = gate.signals.find(signal => signal.id === fixture.oldSignalId)!;
	return {
		gateStatus: gate.status,
		oldVerificationStatus: oldSignal.verification.status,
		completionEvents: fixture.events.filter(event => event.type === "gate_verification_complete" && event.signalId === fixture.oldSignalId),
		active: (fixture.harness as any).activeVerifications.has(fixture.oldSignalId),
	};
}

function waitForNextRestartFinalization(harness: VerificationHarness): Promise<Promise<void>> {
	const original = (harness as any)._finalizeCancelledVerification.bind(harness);
	let finalizer: ReturnType<typeof vi.spyOn>;
	return new Promise((resolve, reject) => {
		finalizer = vi.spyOn(harness as any, "_finalizeCancelledVerification").mockImplementation((...args: any[]) => {
			try {
				const publication = original(...args) as Promise<void>;
				finalizer.mockRestore();
				resolve(publication);
				return publication;
			} catch (error) {
				finalizer.mockRestore();
				reject(error);
				throw error;
			}
		});
	});
}

async function disposeRestartCancellationFixture(fixture: RestartCancellationFixture): Promise<void> {
	try {
		// If an assertion exits while the retry owner still exists, finish that
		// exact owner before closing its store. Do not delete a state directory
		// beneath a coalesced GateStore write or an owned cleanup retry.
		const commandRetryTimers = (fixture.harness as any)._commandKillRetryTimers as Map<string, unknown>;
		if (commandRetryTimers.has(fixture.oldSignalId)) {
			fixture.setCleanupReady();
			const finalization = waitForNextRestartFinalization(fixture.harness);
			fixture.clock.advance(1_000);
			await (await finalization);
		}
		await Promise.all([
			...(fixture.harness as any)._cancelledCleanupPromises.values(),
			...(fixture.harness as any)._cancelledFinalizationPromises.values(),
		]);
		await fixture.gateStore.close();
	} finally {
		fs.rmSync(fixture.stateDir, { recursive: true, force: true });
	}
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
			const signalId = (await signalRes.json() as SlowGateSignal).signal.id;

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
			expect(cancelBody).toMatchObject({
				cancelled: true,
				outcome: "cancelled",
				cause: "manual",
				signalId,
				pending: false,
			});

			// Cancellation bookkeeping is synchronous; drive any queued cleanup with
			// the gateway's manual clock instead of sleeping between REST reads.
			await observeUntil(
				gateway.clock,
				() => getActiveVerifications(goalId),
				(v) => !v.some(a => a.gateId === "slow-gate" && a.overallStatus === "running"),
				5000,
			);
			const gate = await getGateState(goalId);
			const summaryRes = await apiFetch(`/api/goals/${goalId}/gates/slow-gate?view=summary`);
			expect(summaryRes.status).toBe(200);
			expect((await summaryRes.json()).latestSignal?.verification?.cancellation,
				"GATE_DETAIL_SUMMARY_MUST_EXPOSE_DURABLE_CANCELLATION_CAUSE").toMatchObject({ cause: "manual" });
			expect(gate.status, "MANUAL_CANCEL_MUST_LEAVE_GATE_ELIGIBLE_TO_RUN_AGAIN").toBe("pending");
			expect(gate.signals.at(-1)?.verification, "MANUAL_CANCEL_MUST_BE_DURABLE_AND_NEVER_A_PRODUCT_FAILURE").toMatchObject({
				status: "cancelled",
				cancellation: { cause: "manual", requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
				steps: [expect.objectContaining({
					name: "Slow check",
					status: "cancelled",
					cancellation: { cause: "manual", requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
				})],
			});
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

	test("shelving durably fences a running verification before the terminal goal update", async ({ gateway }) => {
		let setup: SlowWorkflowGoal | undefined;
		const runner = new PendingExactCleanupRunner();
		gateway.teamManager.verificationHarness!.commandStepRunner = runner;
		try {
			setup = await createSlowWorkflowGoal("Shelve Running Verification");
			const signalRes = await signalSlowVerification(setup.goalId, "shelve while running");
			expect(signalRes.status).toBe(201);
			const signalId = (await signalRes.json() as SlowGateSignal).signal.id;
			await runner.waitForSpawn(0);

			const shelveRequest = apiFetch(`/api/goals/${setup.goalId}`, {
				method: "PUT",
				body: JSON.stringify({ state: "shelved" }),
			});
			await runner.waitForKill(0);
			const shelveRes = await shelveRequest;
			expect(shelveRes.status).toBe(200);
			const shelvedGoal = await apiFetch(`/api/goals/${setup.goalId}`);
			const shelvedGoalBody = await shelvedGoal.json() as { state: string };
			expect(shelvedGoalBody.state).toBe("shelved");
			const beforeCleanup = await getGateState(setup.goalId);
			expect(beforeCleanup.status, "SHELVE_MUST_NOT_MANUFACTURE_A_FAILED_GATE_WHILE_EXACT_CLEANUP_IS_PENDING").toBe("pending");
			expect(beforeCleanup.signals.find(signal => signal.id === signalId)?.verification.status, "SHELVE_MUST_NOT_PUBLISH_CANCELLED_BEFORE_EXACT_CLEANUP").toBe("running");
			expect(getCancellationOwnershipRecord(gateway, signalId)).toMatchObject({
				cancellation: { cause: "shelved", requestedAt: expect.any(Number) },
			});
			expect(await getActiveVerifications(setup.goalId), "CANCELLED_OWNERSHIP_MUST_BE_EXCLUDED_FROM_PUBLIC_LIVE_API").toEqual([]);

			runner.settle(0);
			const gate = await observeUntil(
				gateway.clock,
				() => getGateState(setup!.goalId),
				state => state.signals.at(-1)?.verification.status === "cancelled",
				5_000,
			);
			expect(gate.signals.at(-1)?.verification).toMatchObject({
				status: "cancelled",
				cancellation: { cause: "shelved", finalizedAt: expect.any(Number) },
			});
		} finally {
			runner.settleAll();
			await cleanupSlowWorkflowGoal(setup);
		}
	});

	test("completing durably fences a running verification without awaiting exact cleanup", async ({ gateway }) => {
		let setup: SlowWorkflowGoal | undefined;
		const runner = new PendingExactCleanupRunner();
		gateway.teamManager.verificationHarness!.commandStepRunner = runner;
		try {
			setup = await createSlowWorkflowGoal("Complete Running Verification");
			const signalRes = await signalSlowVerification(setup.goalId, "complete while running");
			expect(signalRes.status).toBe(201);
			const signalId = (await signalRes.json() as SlowGateSignal).signal.id;
			await runner.waitForSpawn(0);

			const completeRequest = apiFetch(`/api/goals/${setup.goalId}`, {
				method: "PUT",
				body: JSON.stringify({ state: "complete" }),
			});
			await runner.waitForKill(0);
			const completeRes = await completeRequest;
			expect(completeRes.status).toBe(200);
			const completedGoal = await apiFetch(`/api/goals/${setup.goalId}`);
			const completedGoalBody = await completedGoal.json() as { state: string };
			expect(completedGoalBody.state).toBe("complete");
			const beforeCleanup = await getGateState(setup.goalId);
			expect(beforeCleanup.status).toBe("pending");
			expect(beforeCleanup.signals.find(signal => signal.id === signalId)?.verification.status).toBe("running");
			expect(getCancellationOwnershipRecord(gateway, signalId)).toMatchObject({
				cancellation: { cause: "goal-complete", requestedAt: expect.any(Number) },
			});
			expect(await getActiveVerifications(setup.goalId), "CANCELLED_OWNERSHIP_MUST_BE_EXCLUDED_FROM_PUBLIC_LIVE_API").toEqual([]);

			runner.settle(0);
			const gate = await observeUntil(
				gateway.clock,
				() => getGateState(setup!.goalId),
				state => state.signals.at(-1)?.verification.status === "cancelled",
				5_000,
			);
			expect(gate.signals.at(-1)?.verification).toMatchObject({
				status: "cancelled",
				cancellation: { cause: "goal-complete", finalizedAt: expect.any(Number) },
			});
		} finally {
			runner.settleAll();
			await cleanupSlowWorkflowGoal(setup);
		}
	});

	test("completed and shelved goals reject fresh signals without creating a verification", async ({ gateway }) => {
		const setups: SlowWorkflowGoal[] = [];
		try {
			for (const [state, code] of [["complete", "GOAL_COMPLETE"], ["shelved", "GOAL_SHELVED"]] as const) {
				const setup = await createSlowWorkflowGoal(`Reject Signal On ${state}`);
				setups.push(setup);
				const terminal = await apiFetch(`/api/goals/${setup.goalId}`, {
					method: "PUT",
					body: JSON.stringify({ state }),
				});
				expect(terminal.status).toBe(200);

				const rejected = await signalSlowVerification(setup.goalId, `must reject ${state}`);
				expect(rejected.status).toBe(409);
				expect(await rejected.json()).toMatchObject({ code });
				await expectNoSignalAdmission(gateway, setup.goalId);
			}
		} finally {
			await Promise.all(setups.map(cleanupSlowWorkflowGoal));
		}
	});

	test("terminal goal lifecycle fence rejects a concurrent signal until the authoritative write completes", async ({ gateway }) => {
		let setup: SlowWorkflowGoal | undefined;
		let releaseUpdate: (() => void) | undefined;
		let updateSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			setup = await createSlowWorkflowGoal("Terminal Lifecycle Admission Race");
			const context = gateway.projectContextManager.getContextForGoal(setup.goalId)!;
			const originalUpdateGoal = context.goalManager.updateGoal.bind(context.goalManager);
			const entered = deferred();
			const release = deferred();
			releaseUpdate = release.resolve;
			let blocked = false;
			updateSpy = vi.spyOn(context.goalManager, "updateGoal").mockImplementation(async (goalId, updates) => {
				if (goalId === setup!.goalId && (updates as { state?: string }).state === "complete" && !blocked) {
					blocked = true;
					entered.resolve();
					await release.promise;
				}
				return originalUpdateGoal(goalId, updates);
			});

			const terminalRequest = apiFetch(`/api/goals/${setup.goalId}`, {
				method: "PUT",
				body: JSON.stringify({ state: "complete" }),
			});
			await entered.promise;
			expect(gateway.teamManager.verificationHarness!.isGoalLifecycleFenced(setup.goalId),
				"TERMINAL_WRITE_MUST_ACQUIRE_THE_LIFECYCLE_FENCE_BEFORE_THE_GOAL_STORE_WRITE").toBe(true);

			const rejected = await signalSlowVerification(setup.goalId, "signal during terminal write");
			expect(rejected.status).toBe(409);
			expect(await rejected.json()).toMatchObject({ code: "GOAL_LIFECYCLE_IN_PROGRESS", retryable: true });
			await expectNoSignalAdmission(gateway, setup.goalId);

			release.resolve();
			releaseUpdate = undefined;
			const terminal = await terminalRequest;
			expect(terminal.status).toBe(200);
			expect((await (await apiFetch(`/api/goals/${setup.goalId}`)).json())).toMatchObject({ state: "complete" });
		} finally {
			releaseUpdate?.();
			updateSpy?.mockRestore();
			await cleanupSlowWorkflowGoal(setup);
		}
	});

	test("archive lifecycle fence rejects a concurrent signal until the authoritative archive completes", async ({ gateway }) => {
		let setup: SlowWorkflowGoal | undefined;
		let releaseArchive: (() => void) | undefined;
		let archiveSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			setup = await createSlowWorkflowGoal("Archive Lifecycle Admission Race");
			const context = gateway.projectContextManager.getContextForGoal(setup.goalId)!;
			const originalArchiveGoal = context.goalManager.archiveGoal.bind(context.goalManager);
			const entered = deferred();
			const release = deferred();
			releaseArchive = release.resolve;
			let blocked = false;
			archiveSpy = vi.spyOn(context.goalManager, "archiveGoal").mockImplementation(async goalId => {
				if (goalId === setup!.goalId && !blocked) {
					blocked = true;
					entered.resolve();
					await release.promise;
				}
				return originalArchiveGoal(goalId);
			});

			const archiveRequest = apiFetch(`/api/goals/${setup.goalId}?cascade=false`, { method: "DELETE" });
			await entered.promise;
			expect(gateway.teamManager.verificationHarness!.isGoalLifecycleFenced(setup.goalId),
				"ARCHIVE_MUST_ACQUIRE_THE_LIFECYCLE_FENCE_BEFORE_THE_GOAL_STORE_WRITE").toBe(true);

			const rejected = await signalSlowVerification(setup.goalId, "signal during archive");
			expect(rejected.status).toBe(409);
			expect(await rejected.json()).toMatchObject({ code: "GOAL_LIFECYCLE_IN_PROGRESS", retryable: true });
			await expectNoSignalAdmission(gateway, setup.goalId);

			release.resolve();
			releaseArchive = undefined;
			const archived = await archiveRequest;
			expect(archived.status).toBe(200);
			expect(await (await apiFetch(`/api/goals/${setup.goalId}`)).json()).toMatchObject({ archived: true });
		} finally {
			releaseArchive?.();
			archiveSpy?.mockRestore();
			await cleanupSlowWorkflowGoal(setup);
		}
	});

	test("terminal lifecycle and archive fail closed when the durable cancellation fence cannot persist", async ({ gateway }) => {
		let terminal: SlowWorkflowGoal | undefined;
		let archive: SlowWorkflowGoal | undefined;
		const harness = gateway.teamManager.verificationHarness!;
		const originalFence = harness.fenceAndCancelAllVerifications.bind(harness);
		(harness as any).fenceAndCancelAllVerifications = () => {
			throw new Error("simulated durable fence failure");
		};
		try {
			terminal = await createSlowWorkflowGoal("Terminal Fence Persistence Failure");
			const terminalRes = await apiFetch(`/api/goals/${terminal.goalId}`, {
				method: "PUT", body: JSON.stringify({ state: "shelved" }),
			});
			expect(terminalRes.status).toBe(503);
			expect(await terminalRes.json()).toMatchObject({ code: "VERIFICATION_CANCELLATION_FENCE_FAILED", retryable: true });
			expect((await (await apiFetch(`/api/goals/${terminal.goalId}`)).json()).state).not.toBe("shelved");

			archive = await createSlowWorkflowGoal("Archive Fence Persistence Failure");
			const archiveRes = await apiFetch(`/api/goals/${archive.goalId}?cascade=false`, { method: "DELETE" });
			expect(archiveRes.status).toBe(503);
			expect(await archiveRes.json()).toMatchObject({ code: "VERIFICATION_CANCELLATION_FENCE_FAILED", retryable: true });
			const stillLive = await (await apiFetch(`/api/goals/${archive.goalId}`)).json();
			expect(stillLive.archived).not.toBe(true);
		} finally {
			(harness as any).fenceAndCancelAllVerifications = originalFence;
			await cleanupSlowWorkflowGoal(terminal);
			await cleanupSlowWorkflowGoal(archive);
		}
	});

	test("team completion fences signal admission through its authoritative completion write", async ({ gateway }) => {
		let setup: SlowWorkflowGoal | undefined;
		let releaseUpdate: (() => void) | undefined;
		let updateSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			setup = await createSlowWorkflowGoal("Team Complete Lifecycle Admission Race");
			const context = gateway.projectContextManager.getContextForGoal(setup.goalId)!;
			const bypass = await apiFetch(`/api/goals/${setup.goalId}/gates/slow-gate/bypass`, {
				method: "POST",
				body: JSON.stringify({ whyBypassed: "exercise lifecycle fence", whoAmI: "test@example.com", isInitiatedByHuman: true }),
			});
			expect(bypass.status).toBe(200);
			// This deliberately makes completion workflow-exempt: the race asserts the
			// lifecycle fence, not final gate validation.
			context.goalStore.update(setup.goalId, { skipGateRequirements: ["workflow"] });
			await startTeam(setup.goalId);
			const before = await getGateState(setup.goalId);
			expect(before.status).toBe("bypassed");

			const originalUpdate = context.goalManager.updateGoal.bind(context.goalManager);
			const entered = deferred();
			const release = deferred();
			releaseUpdate = release.resolve;
			let blocked = false;
			updateSpy = vi.spyOn(context.goalManager, "updateGoal").mockImplementation(async (goalId, updates) => {
				if (goalId === setup!.goalId && (updates as { state?: string }).state === "complete" && !blocked) {
					blocked = true;
					entered.resolve();
					await release.promise;
				}
				return originalUpdate(goalId, updates);
			});

			const completing = apiFetch(`/api/goals/${setup.goalId}/team/complete`, { method: "POST", body: JSON.stringify({}) });
			await entered.promise;
			expect(gateway.teamManager.verificationHarness!.isGoalLifecycleFenced(setup.goalId)).toBe(true);
			const rejected = await signalSlowVerification(setup.goalId, "must not escape team completion");
			expect(rejected.status).toBe(409);
			expect(await rejected.json()).toMatchObject({ code: "GOAL_LIFECYCLE_IN_PROGRESS", retryable: true });
			await expectNoSignalAdmission(gateway, setup.goalId, before.signals.length);
			expect((await getGateState(setup.goalId)).status).toBe("bypassed");

			release.resolve();
			releaseUpdate = undefined;
			expect((await completing).status).toBe(200);
			expect(await (await apiFetch(`/api/goals/${setup.goalId}`)).json()).toMatchObject({ state: "complete" });
		} finally {
			releaseUpdate?.();
			updateSpy?.mockRestore();
			if (setup) await teardownTeam(setup.goalId).catch(() => {});
			await cleanupSlowWorkflowGoal(setup);
		}
	});

	test("team teardown fences signal admission until lead termination and tracking removal finish", async ({ gateway }) => {
		let setup: SlowWorkflowGoal | undefined;
		let releaseTermination: (() => void) | undefined;
		let terminateSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			setup = await createSlowWorkflowGoal("Team Teardown Lifecycle Admission Race");
			const leadId = await startTeam(setup.goalId);
			const originalTerminate = gateway.sessionManager.terminateSession.bind(gateway.sessionManager);
			const entered = deferred();
			const release = deferred();
			releaseTermination = release.resolve;
			terminateSpy = vi.spyOn(gateway.sessionManager, "terminateSession").mockImplementation(async sessionId => {
				if (sessionId === leadId) {
					entered.resolve();
					await release.promise;
				}
				return originalTerminate(sessionId);
			});

			const tearingDown = apiFetch(`/api/goals/${setup.goalId}/team/teardown?cascade=false`, { method: "POST" });
			await entered.promise;
			expect(gateway.teamManager.verificationHarness!.isGoalLifecycleFenced(setup.goalId)).toBe(true);
			const rejected = await signalSlowVerification(setup.goalId, "must not escape team teardown");
			expect(rejected.status).toBe(409);
			expect(await rejected.json()).toMatchObject({ code: "GOAL_LIFECYCLE_IN_PROGRESS", retryable: true });
			await expectNoSignalAdmission(gateway, setup.goalId);

			release.resolve();
			releaseTermination = undefined;
			expect((await tearingDown).status).toBe(200);
			expect(gateway.teamManager.getTeamState(setup.goalId)).toBeUndefined();
		} finally {
			releaseTermination?.();
			terminateSpy?.mockRestore();
			await cleanupSlowWorkflowGoal(setup);
		}
	});

	test("team completion and teardown fail closed when their durable cancellation fence fails", async ({ gateway }) => {
		let setup: SlowWorkflowGoal | undefined;
		const harness = gateway.teamManager.verificationHarness!;
		const originalFence = harness.fenceAndCancelAllVerifications.bind(harness);
		try {
			setup = await createSlowWorkflowGoal("Team Lifecycle Fence Persistence Failure");
			const leadId = await startTeam(setup.goalId);
			(harness as any).fenceAndCancelAllVerifications = () => { throw new Error("simulated durable fence failure"); };

			const complete = await apiFetch(`/api/goals/${setup.goalId}/team/complete`, { method: "POST", body: JSON.stringify({}) });
			expect(complete.status).toBe(503);
			expect(await complete.json()).toMatchObject({ code: "VERIFICATION_CANCELLATION_FENCE_FAILED", retryable: true });
			expect(gateway.teamManager.getTeamState(setup.goalId)?.teamLeadSessionId).toBe(leadId);
			expect(gateway.sessionManager.getSession(leadId)).toBeTruthy();

			const teardown = await apiFetch(`/api/goals/${setup.goalId}/team/teardown?cascade=false`, { method: "POST" });
			expect(teardown.status).toBe(503);
			expect(await teardown.json()).toMatchObject({ code: "VERIFICATION_CANCELLATION_FENCE_FAILED", retryable: true });
			expect(gateway.teamManager.getTeamState(setup.goalId)?.teamLeadSessionId).toBe(leadId);
			expect(gateway.sessionManager.getSession(leadId)).toBeTruthy();
		} finally {
			(harness as any).fenceAndCancelAllVerifications = originalFence;
			if (setup) await teardownTeam(setup.goalId).catch(() => {});
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
			const cancelledGate = await getGateState(goalId);
			expect(cancelledGate.status, "MANUAL_CANCEL_MUST_NOT_REQUIRE_A_RESET_BEFORE_RESIGNAL").toBe("pending");
			expect(cancelledGate.signals.at(-1)?.verification).toMatchObject({
				status: "cancelled", cancellation: { cause: "manual" },
			});

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

			const signalRes = await signalSlowVerification(setup.goalId, "Cancellation must await exact cleanup.");
			expect(signalRes.status).toBe(201);
			const signalId = (await signalRes.json() as SlowGateSignal).signal.id;
			await runner.waitForSpawn(0);
			const eventCursor = conn.messageCount();

			cancelRequest = cancelSlowVerification(setup.goalId);
			await runner.waitForKill(0);

			const pending = await getGateState(setup.goalId);
			expect(pending.status, "PENDING_CANCEL_GATE_STATUS_PUBLISHED_EARLY").toBe("pending");
			expect(pending.signals.find(signal => signal.id === signalId)?.verification.status,
				"PENDING_CANCEL_SIGNAL_FINALIZED_EARLY").toBe("running");
			expect(conn.messages.slice(eventCursor).filter((event: any) =>
				event.type === "gate_verification_complete" && event.signalId === signalId),
				"PENDING_CANCEL_COMPLETION_PUBLISHED_EARLY").toHaveLength(0);

			// This is the sole release point: it models successful exact witness
			// verification and the terminal tree-reap acknowledgement.
			runner.settle(0);
			const cancelRes = await cancelRequest;
			expect(cancelRes.status).toBe(200);
			expect(await cancelRes.json()).toMatchObject({
				cancelled: true,
				outcome: "cancelled",
				cause: "manual",
				signalId,
				pending: false,
			});

			const finalized = await getGateState(setup.goalId);
			const cancelledSignals = finalized.signals.filter(signal => signal.id === signalId && signal.verification.status === "cancelled");
			expect(cancelledSignals, "EXACT_CLEANUP_MUST_FINALIZE_CURRENT_SIGNAL_ONCE").toHaveLength(1);
			expect(cancelledSignals[0]?.verification.cancellation, "EXACT_CLEANUP_MUST_PRESERVE_MANUAL_CAUSE").toMatchObject({
				cause: "manual", requestedAt: expect.any(Number), finalizedAt: expect.any(Number),
			});
			expect(cancelledSignals[0]?.verification.steps, "EXACT_CLEANUP_MUST_KEEP_REAL_WORKFLOW_ROWS").toEqual([
				expect.objectContaining({
					name: "Slow check",
					status: "cancelled",
					cancellation: { cause: "manual", requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
				}),
			]);
			expect(finalized.status, "EXACT_CLEANUP_MUST_NOT_MANUFACTURE_A_FAILED_GATE").toBe("pending");
			expect(conn.messages.slice(eventCursor).filter((event: any) =>
				event.type === "gate_verification_complete" && event.signalId === signalId && event.status === "cancelled" && event.cancellation?.cause === "manual"),
				"EXACT_CLEANUP_MUST_PUBLISH_ONE_CAUSE_LABELLED_COMPLETION").toHaveLength(1);
		} finally {
			runner.settleAll();
			await cancelRequest?.catch(() => {});
			conn?.close();
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await cleanupSlowWorkflowGoal(setup);
		}
	});

	test("inactive duplicate replacement records zombie recovery without serializing the new generation or nudging", async ({ gateway }) => {
		let setup: SlowWorkflowGoal | undefined;
		let sessionId: string | undefined;
		let conn: WsConnection | undefined;
		let resignalRequest: Promise<Response> | undefined;
		const runner = new PendingExactCleanupRunner();
		const harness = gateway.teamManager.verificationHarness!;
		const recoveryNudges: string[] = [];
		const originalNotifier = (harness as any).notifyTeamLeadFn;
		harness.setTeamLeadNotifier((_goalId: string, message: string) => { recoveryNudges.push(message); });
		harness.commandStepRunner = runner;
		try {
			setup = await createSlowWorkflowGoal("Pending Re-signal Generation");
			sessionId = await createSession({ goalId: setup.goalId });
			conn = trackFakeCommandStepConnection(await connectWs(sessionId));

			const firstRes = await signalSlowVerification(setup.goalId, "Old generation");
			expect(firstRes.status).toBe(201);
			const firstSignalId = (await firstRes.json() as SlowGateSignal).signal.id;
			await runner.waitForSpawn(0);
			const eventCursor = conn.messageCount();

			resignalRequest = signalSlowVerification(setup.goalId, "New generation");
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
			expect(afterOldCleanup.signals.find(signal => signal.id === firstSignalId)?.verification.status).toBe("cancelled");
			expect(afterOldCleanup.signals.find(signal => signal.id === firstSignalId)?.verification.cancellation,
				"INACTIVE_DUPLICATE_MUST_RETAIN_ZOMBIE_RECOVERY_CAUSE").toMatchObject({ cause: "zombie-recovery" });
			expect(afterOldCleanup.signals.find(signal => signal.id === secondSignalId)?.verification.status,
				"ZOMBIE_CLEANUP_MUST_NOT_FINALIZE_NEW_SIGNAL").toBe("running");
			expect(afterOldCleanup.status, "ZOMBIE_CLEANUP_MUST_NOT_OVERWRITE_NEW_GATE_STATE").toBe("pending");
			expect(recoveryNudges, "ZOMBIE_RECOVERY_MUST_NOT_EMIT_A_RESIGNAL_NUDGE").toEqual([]);
		} finally {
			(harness as any).notifyTeamLeadFn = originalNotifier;
			runner.settleAll();
			await resignalRequest?.catch(() => {});
			conn?.close();
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await cleanupSlowWorkflowGoal(setup);
		}
	});

	test("restart finalizes an explicitly cancelled current signal once after exact cleanup, identically on first attempt or retry", async () => {
		const firstAttempt = createRestartCancellationFixture();
		const pendingThenRetry = createRestartCancellationFixture({ pendingFirst: true });
		try {
			await firstAttempt.harness.resumeInterruptedVerifications();
			const firstState = restartCancellationState(firstAttempt);
			expect(firstAttempt.cleanupAttempts(), "RESTART_CANCEL_FIRST_RESUME_MUST_USE_EXACT_CLEANUP_ONCE").toBe(1);
			expect(firstState, "RESTART_CANCEL_FIRST_RESUME_MUST_FINALIZE_CURRENT_SIGNAL_BEFORE_REMOVAL").toMatchObject({
				gateStatus: "pending",
				oldVerificationStatus: "cancelled",
				active: false,
			});
			const firstSignal = firstAttempt.gateStore.getGate(RESTART_CANCEL_GOAL_ID, RESTART_CANCEL_GATE_ID)!.signals.find(signal => signal.id === firstAttempt.oldSignalId)!;
			expect((firstSignal.verification as any), "RESTART_CANCEL_MUST_KEEP_TYPED_CAUSE_AND_COMPLETED_OUTPUT").toMatchObject({
				cancellation: { cause: "manual", requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
				steps: [
					{ name: "Completed prerequisite", status: "passed", output: "completed output survives restart cancellation" },
					{
						name: "Exact cleanup",
						status: "cancelled",
						cancellation: { cause: "manual", requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
					},
				],
			});
			expect(firstState.completionEvents, "RESTART_CANCEL_FIRST_RESUME_MUST_EMIT_ONE_COMPLETION").toEqual([
				expect.objectContaining({ status: "cancelled" }),
			]);

			await pendingThenRetry.harness.resumeInterruptedVerifications();
			expect(restartCancellationState(pendingThenRetry), "RESTART_CANCEL_PENDING_MUST_NOT_PUBLISH_TERMINAL_STATE").toMatchObject({
				gateStatus: "pending",
				oldVerificationStatus: "running",
				active: true,
				completionEvents: [],
			});
			pendingThenRetry.setCleanupReady();
			const finalization = waitForNextRestartFinalization(pendingThenRetry.harness);
			pendingThenRetry.clock.advance(1_000);
			// The manual clock dispatches the retry callback but cannot return its
			// promise. Await the owned finalizer through strict signal/gate writes
			// and exact resource release before observing active-record removal.
			await (await finalization);

			const retryState = restartCancellationState(pendingThenRetry);
			expect(pendingThenRetry.cleanupAttempts(), "RESTART_CANCEL_RETRY_MUST_REUSE_THE_EXACT_CLEANUP_AUTHORITY").toBe(2);
			expect(retryState).toMatchObject({
				gateStatus: firstState.gateStatus,
				oldVerificationStatus: firstState.oldVerificationStatus,
				active: firstState.active,
			});
			expect(retryState.completionEvents.map(event => event.status), "RESTART_CANCEL_RETRY_MUST_HAVE_IDENTICAL_TERMINAL_PUBLICATION").toEqual(
				firstState.completionEvents.map(event => event.status),
			);
		} finally {
			await disposeRestartCancellationFixture(firstAttempt);
			await disposeRestartCancellationFixture(pendingThenRetry);
		}
	});

	test("restart finalizes an old explicit cancellation without overwriting a newer current signal", async () => {
		const fixture = createRestartCancellationFixture({ newerSignal: true });
		try {
			await fixture.harness.resumeInterruptedVerifications();
			const gate = fixture.gateStore.getGate(RESTART_CANCEL_GOAL_ID, RESTART_CANCEL_GATE_ID)!;
			const oldSignal = gate.signals.find(signal => signal.id === fixture.oldSignalId)!;
			const newSignal = gate.signals.find(signal => signal.id === fixture.newSignalId)!;
			const state = restartCancellationState(fixture);

			expect(fixture.cleanupAttempts()).toBe(1);
			expect(oldSignal.verification.status, "RESTART_CANCEL_MUST_FINALIZE_THE_OLD_SIGNAL").toBe("cancelled");
			expect((oldSignal.verification as any).cancellation,
				"RESTART_CANCEL_MUST_KEEP_OLD_GENERATION_CAUSE").toMatchObject({ cause: "manual" });
			expect(newSignal.verification.status, "RESTART_CANCEL_MUST_NOT_FINALIZE_THE_NEW_SIGNAL").toBe("running");
			expect(gate.status, "RESTART_CANCEL_MUST_NOT_OVERWRITE_THE_NEW_GATE_STATE").toBe("pending");
			expect(state.active, "RESTART_CANCEL_MUST_REMOVE_THE_FINALIZED_OLD_ACTIVE_RECORD").toBe(false);
			expect(state.completionEvents, "RESTART_CANCEL_MUST_EMIT_ONE_OLD_SIGNAL_COMPLETION").toEqual([
			expect.objectContaining({ status: "cancelled" }),
			]);
			expect(fixture.events.filter(event => event.type === "gate_verification_complete" && event.signalId === fixture.newSignalId),
			"RESTART_CANCEL_MUST_NOT_EMIT_A_NEW_SIGNAL_COMPLETION").toHaveLength(0);
		} finally {
			await disposeRestartCancellationFixture(fixture);
		}
	});

	for (const scenario of [
		{ name: "ordinary replacement", cause: "superseded", makeZombie: false },
		{ name: "inactive zombie replacement", cause: "zombie-recovery", makeZombie: true },
	]) {
		test(`${scenario.name} fails closed when its gate-scoped cancellation fence cannot persist`, async ({ gateway }) => {
		let setup: SlowWorkflowGoal | undefined;
		const runner = new PendingExactCleanupRunner();
		const harness = gateway.teamManager.verificationHarness! as any;
		let persistSpy: ReturnType<typeof vi.spyOn> | undefined;
		let cleanupSpy: ReturnType<typeof vi.spyOn> | undefined;
		let aliveSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			harness.commandStepRunner = runner;
			setup = await createSlowWorkflowGoal(`Fence Failure ${scenario.name}`);
			const first = await signalSlowVerification(setup.goalId, "original durable content");
			expect(first.status).toBe(201);
			const firstSignalId = (await first.json() as SlowGateSignal).signal.id;
			await runner.waitForSpawn(0);

			const context = gateway.projectContextManager.getContextForGoal(setup.goalId)!;
			if (!scenario.makeZombie) {
				// A regular explicit re-signal reaches the new admission fence when its
				// predecessor belongs to a different commit. The zombie path below uses
				// the same commit and its inactive-owner branch instead.
				context.gateStore.getGate(setup.goalId, "slow-gate")!.signals.find((signal: any) => signal.id === firstSignalId)!.commitSha = "old-commit";
			} else {
				aliveSpy = vi.spyOn(harness, "areVerificationSessionsAlive").mockReturnValue(false);
			}
			const beforeGate = await getGateState(setup.goalId);
			const oldOwner = getCancellationOwnershipRecord(gateway, firstSignalId);
			const beforeOwner = structuredClone(oldOwner);
			const beforePersisted = structuredClone(harness._loadActive());
			cleanupSpy = vi.spyOn(harness, "_startCancelledVerificationCleanup");
			persistSpy = vi.spyOn(harness, "_persistActive").mockReturnValue(false);

			const rejected = await signalSlowVerification(setup.goalId, "replacement must not be recorded");
			expect(rejected.status).toBe(503);
			expect(await rejected.json()).toMatchObject({ code: "VERIFICATION_CANCELLATION_FENCE_FAILED", retryable: true });

			expect(getCancellationOwnershipRecord(gateway, firstSignalId),
				"FAILED_REPLACEMENT_FENCE_MUST_RESTORE_OLD_OWNER_AND_KILL_INTENTS").toEqual(beforeOwner);
			expect(harness._loadActive(),
				"FAILED_REPLACEMENT_FENCE_MUST_NOT_REWRITE_DURABLE_OLD_STATE").toEqual(beforePersisted);
			expect(await getGateState(setup.goalId),
				"FAILED_REPLACEMENT_FENCE_MUST_NOT_MUTATE_SIGNAL_CONTENT_OR_GATE").toEqual(beforeGate);
			expect(runner.children[0]?.killed,
				"FAILED_REPLACEMENT_FENCE_MUST_NOT_START_EXACT_COMMAND_CLEANUP").toBe(false);
			expect(cleanupSpy, "FAILED_REPLACEMENT_FENCE_MUST_NOT_START_BACKGROUND_CLEANUP").not.toHaveBeenCalled();
			expect(runner.children, "FAILED_REPLACEMENT_FENCE_MUST_NOT_DISPATCH_A_REPLACEMENT").toHaveLength(1);
		} finally {
			persistSpy?.mockRestore();
			cleanupSpy?.mockRestore();
			aliveSpy?.mockRestore();
			runner.settleAll();
			await cleanupSlowWorkflowGoal(setup);
		}
		});
	}

	test("replacement dispatches once after its old supersession cause is durably observable", async ({ gateway }) => {
		let setup: SlowWorkflowGoal | undefined;
		const runner = new PendingExactCleanupRunner();
		const harness = gateway.teamManager.verificationHarness! as any;
		let beginSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			harness.commandStepRunner = runner;
			setup = await createSlowWorkflowGoal("Durable Replacement Fence");
			const first = await signalSlowVerification(setup.goalId, "old generation");
			expect(first.status).toBe(201);
			const firstSignalId = (await first.json() as SlowGateSignal).signal.id;
			await runner.waitForSpawn(0);
			const context = gateway.projectContextManager.getContextForGoal(setup.goalId)!;
			context.gateStore.getGate(setup.goalId, "slow-gate")!.signals.find((signal: any) => signal.id === firstSignalId)!.commitSha = "old-commit";

			const originalBegin = harness.beginVerification.bind(harness);
			const persistedCauses: any[] = [];
			beginSpy = vi.spyOn(harness, "beginVerification").mockImplementation((signal: any, gate: any) => {
				const persisted = harness._loadActive();
				persistedCauses.push(persisted.find((record: any) => record.signalId === firstSignalId)?.cancellation);
				return originalBegin(signal, gate);
			});

			const replacement = signalSlowVerification(setup.goalId, "replacement generation");
			await runner.waitForKill(0);
			await runner.waitForSpawn(1);
			expect((await replacement).status).toBe(201);
			expect(persistedCauses, "REPLACEMENT_MUST_NOT_DISPATCH_BEFORE_OLD_CAUSE_IS_DURABLE").toEqual([
				expect.objectContaining({ cause: "superseded", requestedAt: expect.any(Number) }),
			]);
			expect(getCancellationOwnershipRecord(gateway, firstSignalId),
				"OLD_OWNER_MUST_REMAIN_UNTIL_HELD_EXACT_CLEANUP_SETTLES").toMatchObject({
					cancellation: { cause: "superseded" },
				});
			expect(runner.children, "REPLACEMENT_MUST_DISPATCH_EXACTLY_ONCE").toHaveLength(2);

			runner.settle(0);
			await observeUntil(gateway.clock, () => getGateState(setup!.goalId), state =>
				state.signals.find(signal => signal.id === firstSignalId)?.verification.status === "cancelled", 5_000);
		} finally {
			beginSpy?.mockRestore();
			runner.settleAll();
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
