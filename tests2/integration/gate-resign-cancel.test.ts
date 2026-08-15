import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import type { CommandRunner } from "../../src/server/gateway-deps.js";
import type { VerificationCommandRunner, VerificationCommandSpawnSpec } from "../../src/server/agent/verification-command-runner.js";
import type { TrackedChild } from "../../src/server/agent/spawn-tree.js";
import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import { GoalStore, type PersistedGoal } from "../../src/server/agent/goal-store.js";
import { VerificationHarness } from "../../src/server/agent/verification-harness.js";
import type { Workflow, WorkflowGate } from "../../src/server/agent/workflow-store.js";
import { createManualClock, type ManualClock } from "../harness/clock.js";
import { FakePinnedCheckoutManager } from "../harness/fake-pinned-checkout-manager.js";
import { createFakeVerificationCommandRunner } from "../harness/fake-verification-command-runner.js";

const GOAL_ID = "gate-resignal-suite-goal";
const GATE_ID = "slow-gate";
const START_TIME = 1_700_000_000_000;

const GATE: WorkflowGate = {
	id: GATE_ID,
	name: "Slow Gate",
	dependsOn: [],
	verify: [
		{
			name: "Optional approval",
			type: "human-signoff",
			prompt: "Approve the suite-owned fixture",
			label: "Approve fixture",
			optional: true,
			phase: 0,
		},
		{ name: "Final signal check", type: "command", run: "echo final-signal", phase: 1 },
	],
};

const WORKFLOW: Workflow = {
	id: "gate-resignal-suite-workflow",
	name: "Gate Re-signal Suite Workflow",
	description: "Suite-owned workflow for verification cancellation coverage.",
	gates: [GATE],
	createdAt: START_TIME,
	updatedAt: START_TIME,
};

const ROLE_STORE = Object.freeze({ get: () => undefined, getAll: () => [] });

let stateDir: string;
let clock: ManualClock;
let goalStore: GoalStore;
let gateStore: GateStore;
let harness: VerificationHarness;
let pinnedCheckoutManager: FakePinnedCheckoutManager;
let events: any[];
let notifications: Array<{ goalId: string; message: string }>;
let signalSequence: number;

const fakeGitRunner: CommandRunner = {
	execFile: async (file, args) => {
		if (file === "git" && args.join(" ") === "symbolic-ref refs/remotes/origin/HEAD") {
			return { stdout: "refs/remotes/origin/master\n", stderr: "" };
		}
		throw new Error(`Unexpected command in gate re-signal fixture: ${file} ${args.join(" ")}`);
	},
};

function makeGoal(): PersistedGoal {
	return {
		id: GOAL_ID,
		title: "Gate Re-signal Cancellation",
		cwd: stateDir,
		state: "in-progress",
		spec: "Exercise stale verification cancellation.",
		createdAt: START_TIME,
		updatedAt: START_TIME,
		workflowId: WORKFLOW.id,
		workflow: WORKFLOW,
		enabledOptionalSteps: [],
	};
}

function declareSignal(content: string): GateSignal {
	const sequence = ++signalSequence;
	const signal: GateSignal = {
		id: `resignal-${sequence}`,
		goalId: GOAL_ID,
		gateId: GATE_ID,
		sessionId: "gate-resignal-suite-owner",
		timestamp: clock.now() + sequence,
		commitSha: "0123456789abcdef0123456789abcdef01234567",
		content,
		contentVersion: sequence,
		verification: { status: "running", steps: [] },
	};

	// Mirror the production signal ordering: enumerate synchronously, persist the
	// authored signal, then let asynchronous verification run separately.
	signal.verification.steps = harness.beginVerification(signal, GATE);
	gateStore.recordSignal(signal);
	return signal;
}

async function resignal(content: string): Promise<GateSignal> {
	await harness.cancelStaleVerifications(GOAL_ID, GATE_ID);
	return declareSignal(content);
}

async function completeSignal(signal: GateSignal): Promise<void> {
	await harness.verifyGateSignal(signal, GATE, stateDir);
}

/**
 * Exact-cleanup barrier for the re-signal generation test. The test owns both
 * edges: cancellation has issued the kill intent, then exact tree cleanup has
 * settled. It never depends on the shared gateway command semaphore.
 */
class ExactCleanupBarrierRunner implements VerificationCommandRunner {
	readonly nonDurable = true;
	private spawnedResolve!: () => void;
	private killedResolve!: () => void;
	private readonly spawned = new Promise<void>(resolve => { this.spawnedResolve = resolve; });
	private readonly killed = new Promise<void>(resolve => { this.killedResolve = resolve; });
	private settleExit!: () => void;

	spawn(_spec: VerificationCommandSpawnSpec): TrackedChild {
		const child = Object.assign(new EventEmitter(), {
			pid: 971_001,
			stdout: Object.assign(new EventEmitter(), { destroy() {} }),
			stderr: Object.assign(new EventEmitter(), { destroy() {} }),
			unref() {},
			kill() { return true; },
		});
		let resolveTreeExit!: (settled: boolean) => void;
		const treeExit = new Promise<boolean>(resolve => { resolveTreeExit = resolve; });
		let killed = false;
		this.settleExit = () => {
			child.emit("exit", null, "SIGTERM");
			child.emit("close", null, "SIGTERM");
			resolveTreeExit(true);
		};
		this.spawnedResolve();
		return {
			child: child as unknown as TrackedChild["child"],
			ownershipReady: Promise.resolve(),
			waitForTreeExit: async () => treeExit,
			killed: () => killed,
			timedOut: () => false,
			markSurvival: () => {},
			killTree: () => {
				if (killed) return;
				killed = true;
				this.killedResolve();
			},
		};
	}

	waitForSpawn(): Promise<void> { return this.spawned; }
	waitForKill(): Promise<void> { return this.killed; }
	settle(): void { this.settleExit(); }
}

/** Hold post-sync frozen materialization so cancellation is ordered before spawn. */
function holdPinnedCheckoutAcquire(manager: FakePinnedCheckoutManager): {
	waitForAcquire: () => Promise<void>;
	releaseAcquire: () => void;
} {
	let observeAcquire!: () => void;
	const acquireObserved = new Promise<void>(resolve => { observeAcquire = resolve; });
	let release!: () => void;
	const heldAcquire = new Promise<void>(resolve => { release = resolve; });
	const acquire = manager.acquire.bind(manager);
	manager.acquire = async (input) => {
		observeAcquire();
		await heldAcquire;
		return acquire(input);
	};
	return {
		waitForAcquire: () => acquireObserved,
		releaseAcquire: () => release(),
	};
}

function activeVerifications() {
	return harness.getActiveVerifications(GOAL_ID);
}

/** Includes cancelled records still owned by exact cleanup. */
function allActiveVerifications() {
	return Array.from((harness as any).activeVerifications.values());
}

function signals(): GateSignal[] {
	return gateStore.getGate(GOAL_ID, GATE_ID)?.signals ?? [];
}

test.beforeEach(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-resignal-core-"));
	clock = createManualClock(START_TIME);
	goalStore = new GoalStore(stateDir, undefined, { persistence: "json" });
	gateStore = new GateStore(stateDir, undefined, { persistence: "json" });
	goalStore.put(makeGoal());
	gateStore.initGatesForGoal(GOAL_ID, WORKFLOW.gates.map((gate) => gate.id));
	events = [];
	notifications = [];
	signalSequence = 0;

	const context = {
		goalStore,
		gateStore,
		projectConfigStore: undefined,
		project: { id: "gate-resignal-suite-project", name: "Gate Re-signal Suite" },
		goalManager: { resolveRootMaxConcurrentChildren: () => 3 },
	};
	const projectContextManager = {
		getContextForGoal: (goalId: string) => goalId === GOAL_ID ? context : undefined,
	};

	pinnedCheckoutManager = new FakePinnedCheckoutManager(path.join(stateDir, "verification-checkouts"));
	harness = new VerificationHarness(
		stateDir,
		gateStore,
		(goalId, event) => events.push({ ...event, goalId }),
		ROLE_STORE as any,
		undefined,
		undefined,
		undefined,
		undefined,
		projectContextManager as any,
		undefined,
		{
			clock,
			commandRunner: fakeGitRunner,
			commandStepRunner: createFakeVerificationCommandRunner(),
			pinnedCheckoutManager: pinnedCheckoutManager as any,
		},
	);
	harness.setTeamLeadNotifier((goalId, message) => notifications.push({ goalId, message }));
});

test.afterEach(async () => {
	await Promise.allSettled([goalStore.close(), gateStore.close()]);
	fs.rmSync(stateDir, { recursive: true, force: true });
});

test.describe("Gate Re-signal Cancellation", () => {
	test("reset cancellation finalizes a queued command while frozen materialization is pending without spawning", async () => {
		const checkout = holdPinnedCheckoutAcquire(pinnedCheckoutManager);
		const baseRunner = createFakeVerificationCommandRunner();
		let spawnCalls = 0;
		const trackingRunner: VerificationCommandRunner = {
			nonDurable: true,
			spawn: spec => {
				spawnCalls++;
				return baseRunner.spawn(spec);
			},
		};
		(harness as any).commandStepRunner = trackingRunner;
		const signal = declareSignal("Reset before command spawn.");
		const verification = harness.verifyGateSignal(signal, GATE, stateDir, undefined, "master");
		await checkout.waitForAcquire();

		const queued = activeVerifications().find(active => active.signalId === signal.id)?.steps.find(step => step.type === "command");
		expect(queued?.commandSpawnState, "RESET_PRE_SPAWN_COMMAND_MUST_REMAIN_EXPLICITLY_QUEUED").toBe("queued");
		expect(await harness.cancelStaleVerificationsForGates(GOAL_ID, [GATE_ID]), "RESET_PRE_SPAWN_CANCEL_MUST_NOT_WAIT_FOR_NONEXISTENT_PROCESS").toBe(true);
		expect(spawnCalls, "RESET_PRE_SPAWN_CANCEL_MUST_NOT_START_A_COMMAND_AFTER_FINALIZATION").toBe(0);

		checkout.releaseAcquire();
		await verification;
		expect(spawnCalls, "RESET_PRE_SPAWN_MATERIALIZATION_RESUME_MUST_NOT_SPAWN_CANCELLED_COMMAND").toBe(0);
		expect(activeVerifications()).toEqual([]);
		expect(signals().find(candidate => candidate.id === signal.id)?.verification).toMatchObject({
			status: "failed",
			steps: [{ name: "Cancelled", status: "failed" }],
		});
		expect(events).toContainEqual(expect.objectContaining({
			type: "gate_verification_complete", signalId: signal.id, status: "cancelled",
		}));
	});

	test("re-signaling durably marks the old generation before exact cleanup settles", async () => {
		const runner = new ExactCleanupBarrierRunner();
		(harness as any).commandStepRunner = runner;
		const oldSignal = declareSignal("Old generation");
		const oldVerification = completeSignal(oldSignal);
		await runner.waitForSpawn();

		// Do not await: this mirrors the REST re-signal handler. The harness must
		// publish cancellation intent before it waits for exact tree cleanup.
		const cancellation = harness.cancelStaleVerifications(GOAL_ID, GATE_ID);
		await runner.waitForKill();
		const newSignal = declareSignal("New generation");
		expect(signals()).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: oldSignal.id, verification: expect.objectContaining({ status: "running" }) }),
			expect.objectContaining({ id: newSignal.id, verification: expect.objectContaining({ status: "running" }) }),
		]));
		expect(allActiveVerifications()).toEqual(expect.arrayContaining([
			expect.objectContaining({ signalId: oldSignal.id, overallStatus: "cancelled", cancelled: true }),
			expect.objectContaining({ signalId: newSignal.id, overallStatus: "running" }),
		]));

		runner.settle();
		await cancellation;
		await oldVerification;
		expect(signals().find(signal => signal.id === oldSignal.id)?.verification.status).toBe("failed");
		expect(signals().find(signal => signal.id === newSignal.id)?.verification.status).toBe("running");
		expect(gateStore.getGate(GOAL_ID, GATE_ID)?.status).toBe("pending");
		expect(events.filter(event => event.type === "gate_verification_complete" && event.signalId === oldSignal.id && event.status === "cancelled")).toHaveLength(1);

		await harness.cancelStaleVerifications(GOAL_ID, GATE_ID);
	});

	test("re-signaling a gate cancels the previous verification", async () => {
		const signal1 = declareSignal("Signal v1");

		expect(activeVerifications()).toEqual([
			expect.objectContaining({ signalId: signal1.id, overallStatus: "running" }),
		]);

		const signal2 = await resignal("Signal v2");
		expect(signal2.id).not.toBe(signal1.id);
		expect(events).toContainEqual(expect.objectContaining({
			type: "gate_verification_complete",
			goalId: GOAL_ID,
			gateId: GATE_ID,
			signalId: signal1.id,
			status: "cancelled",
		}));
		expect(activeVerifications()).toEqual([
			expect.objectContaining({ signalId: signal2.id, overallStatus: "running" }),
		]);

		await completeSignal(signal2);
		expect(gateStore.getGate(GOAL_ID, GATE_ID)?.status).toBe("passed");
		expect(events).toContainEqual(expect.objectContaining({
			type: "gate_verification_complete",
			signalId: signal2.id,
			status: "passed",
		}));

		const history = signals();
		expect(history).toHaveLength(2);
		expect(history[0].verification).toMatchObject({
			status: "failed",
			steps: [{ name: "Cancelled", status: "failed" }],
		});
		expect(history.at(-1)).toMatchObject({
			id: signal2.id,
			verification: {
				status: "passed",
				steps: [
					{ name: "Optional approval", status: "skipped" },
					{ name: "Final signal check", status: "passed" },
				],
			},
		});
		expect(notifications).toEqual([
			expect.objectContaining({ goalId: GOAL_ID, message: expect.stringContaining("PASSED") }),
		]);
	});

	test("triple re-signal — only final signal determines outcome", async () => {
		const signal1 = declareSignal("Signal v1");
		const signal2 = await resignal("Signal v2");
		const signal3 = await resignal("Signal v3");

		const cancellations = events.filter((event) =>
			event.type === "gate_verification_complete" && event.status === "cancelled");
		expect(cancellations.map((event) => event.signalId)).toEqual([signal1.id, signal2.id]);
		expect(activeVerifications()).toEqual([
			expect.objectContaining({ signalId: signal3.id, overallStatus: "running" }),
		]);

		await completeSignal(signal3);
		expect(activeVerifications()).toHaveLength(0);
		expect(gateStore.getGate(GOAL_ID, GATE_ID)?.status).toBe("passed");
		expect(signals().map((signal) => signal.verification.status)).toEqual(["failed", "failed", "passed"]);
		expect(events.filter((event) => event.type === "gate_verification_complete" && event.status === "passed"))
			.toEqual([expect.objectContaining({ signalId: signal3.id })]);
		expect(notifications).toEqual([
			expect.objectContaining({ goalId: GOAL_ID, message: expect.stringContaining("PASSED") }),
		]);
	});
});
