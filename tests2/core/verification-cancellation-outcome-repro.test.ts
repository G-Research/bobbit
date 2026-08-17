// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
/**
 * Regression contract for cancellation outcome semantics.
 *
 * Re-signalling must record the orchestration cause separately from command
 * kill mechanics, preserve completed evidence, mark only unfinished rows as
 * cancelled, and leave the current gate eligible to run again.  The fixture
 * uses the public stale-generation cancellation path with a real JSON
 * GateStore, so the asserted record is the durable API history.
 *
 * Marker for error_pattern matching:
 *   VERIFICATION_CANCELLATION_OUTCOME_AUDIT
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import { VerificationHarness } from "../../src/server/agent/verification-harness.js";
import type { WorkflowGate } from "../../src/server/agent/workflow-store.js";
import { createManualClock } from "../harness/clock.js";

const GOAL_ID = "verification-cancellation-outcome-goal";
const GATE_ID = "verification-cancellation-outcome-gate";
const SIGNAL_ID = "verification-cancellation-outcome-signal";
const COMPLETED_OUTPUT = "completed prerequisite output must survive cancellation";
// Former restart-provenance text is deliberately retained only as hostile
// reviewer content. It must never classify a product verdict as cancellation.
const FORMER_RESTART_PHRASES = [
	"Step was running but had no session ID",
	"Step was interrupted by server restart",
	"Session lost during server restart",
	"Agent process exited unexpectedly",
	"Reviewer agent process died",
	"Agent did not call verification_result after server restart",
	"timed out while resuming after server restart",
] as const;
let stateDir: string | undefined;
let gateStore: GateStore | undefined;

afterEach(async () => {
	await gateStore?.close();
	gateStore = undefined;
	if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
	stateDir = undefined;
});

function signal(): GateSignal {
	return {
		id: SIGNAL_ID,
		goalId: GOAL_ID,
		gateId: GATE_ID,
		sessionId: "verification-cancellation-owner",
		timestamp: 1_700_000_000_000,
		commitSha: "0123456789abcdef0123456789abcdef01234567",
		content: "first signal generation",
		contentVersion: 1,
		verification: { status: "running", steps: [] },
	};
}

const GATE: WorkflowGate = {
	id: GATE_ID,
	name: "Cancellation outcome fixture",
	dependsOn: [],
	verify: [
		{ name: "Completed prerequisite", type: "command", run: "echo completed", phase: 0 },
		{ name: "Unfinished follow-up", type: "human-signoff", prompt: "Awaiting operator", phase: 1 },
	],
};

test("re-signalling preserves a cause-labelled cancelled audit instead of fabricating a failed gate — VERIFICATION_CANCELLATION_OUTCOME_AUDIT", async () => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-cancellation-outcome-"));
	gateStore = new GateStore(stateDir, undefined, { persistence: "json" });
	gateStore.initGatesForGoal(GOAL_ID, [GATE_ID]);

	const harness = new VerificationHarness(
		stateDir,
		gateStore,
		() => {},
		{ get: () => undefined, getAll: () => [] } as any,
	);
	const firstSignal = signal();
	firstSignal.verification.steps = harness.beginVerification(firstSignal, GATE);
	gateStore.recordSignal(firstSignal);

	// This mirrors a genuine completed phase before the re-signal interrupts the
	// next phase. Deliberately do not mirror the live result into GateStore: the
	// persisted signal must remain exactly as beginVerification() seeded it.
	const active = (harness as any).activeVerifications.get(SIGNAL_ID);
	active.steps[0] = {
		...active.steps[0],
		status: "passed",
		output: COMPLETED_OUTPUT,
		durationMs: 17,
	};
	// A human-signoff is legitimate live work without an owned process tree.
	// Register its resolver so supersession must acknowledge the parked work
	// before it can publish the cancelled audit.
	const drainedSignoffs: any[] = [];
	active.steps[1] = { ...active.steps[1], status: "running", awaitingHuman: true };
	harness.pendingSignoffs.set(`${SIGNAL_ID}::Unfinished follow-up`, (outcome: any) => drainedSignoffs.push(outcome));
	await harness.cancelStaleVerifications(GOAL_ID, GATE_ID);
	// The parked sign-off resolver is the cleanup acknowledgement for this
	// process-free fixture; cancellation must drain it before final publication.
	expect(drainedSignoffs).toEqual([{ cancelled: true }]);

	const cancelledSignal = gateStore.getGate(GOAL_ID, GATE_ID)!.signals.find(entry => entry.id === SIGNAL_ID)!;
	const verification = cancelledSignal.verification as any;
	expect(verification.status, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: orchestration cancellation must persist cancelled, never failed").toBe("cancelled");
	expect(verification.cancellation, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: durable orchestration cause must be superseded, not the command kill reason").toMatchObject({
		cause: "superseded",
		requestedAt: expect.any(Number),
		finalizedAt: expect.any(Number),
	});
	expect(verification.steps, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: completed evidence survives and only unfinished work is cancelled").toMatchObject([
		{ name: "Completed prerequisite", status: "passed", passed: true, output: COMPLETED_OUTPUT, duration_ms: 17 },
		{
			name: "Unfinished follow-up",
			status: "cancelled",
			passed: false,
			cancellation: { cause: "superseded", requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
		},
	]);
	expect(gateStore.getGate(GOAL_ID, GATE_ID)!.status,
		"VERIFICATION_CANCELLATION_OUTCOME_AUDIT: cancellation leaves the gate pending and eligible to re-signal").toBe("pending");

	// Reopen the JSON store to make the provenance contract explicitly durable.
	await gateStore.close();
	gateStore = new GateStore(stateDir, undefined, { persistence: "json" });
	const reloaded = gateStore.getGate(GOAL_ID, GATE_ID)!.signals.find(entry => entry.id === SIGNAL_ID)!.verification as any;
	expect(reloaded.cancellation, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: cancellation cause survives GateStore reload").toMatchObject({ cause: "superseded" });
});

const RESTART_GATE: WorkflowGate = {
	id: GATE_ID,
	name: "Restart cancellation aggregate fixture",
	dependsOn: [],
	verify: [
		{ name: "Completed before restart", type: "command", run: "echo completed", phase: 0 },
		{ name: "Interrupted review result", type: "llm-review", prompt: "Review", phase: 0 },
		{ name: "Interrupted QA result", type: "agent-qa", prompt: "QA", phase: 1 },
	],
};

function restartAggregateFixture() {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-cancellation-restart-"));
	gateStore = new GateStore(stateDir, undefined, { persistence: "json" });
	gateStore.initGatesForGoal(GOAL_ID, [GATE_ID]);
	const events: any[] = [];
	const harness = new VerificationHarness(
		stateDir,
		gateStore,
		(_goalId, event) => events.push(event),
		{ get: () => undefined, getAll: () => [] } as any,
	);
	const restartSignal = { ...signal(), id: `${SIGNAL_ID}-restart` };
	restartSignal.verification.steps = harness.beginVerification(restartSignal, RESTART_GATE);
	gateStore.recordSignal(restartSignal);
	const active = (harness as any).activeVerifications.get(restartSignal.id);
	Object.assign(active.steps[0], {
		status: "passed",
		output: COMPLETED_OUTPUT,
		durationMs: 23,
	});
	// This flag is harness-owned provenance, not reviewer output. Its diagnostic
	// text deliberately has none of the historic restart phrases.
	Object.assign(active.steps[1], {
		status: "failed",
		passed: false,
		output: "The recovered reviewer turn ended before a durable result.",
		durationMs: 29,
		restartInterrupted: true,
	});
	Object.assign(active.steps[2], {
		status: "timeout",
		passed: false,
		output: "The recovered QA turn ended before a durable result.",
		durationMs: 31,
		restartInterrupted: true,
	});
	return { harness, restartSignal, active, events };
}

test("restart recovery uses structured interruption provenance and preserves completed evidence — VERIFICATION_CANCELLATION_OUTCOME_AUDIT", async () => {
	const { harness, restartSignal, active, events } = restartAggregateFixture();

	// The restart interruption seam is deterministic: no timer, polling, or
	// raw state-file reads are needed to exercise terminal publication.
	await (harness as any)._finalizeRestartInterruptedVerification(active);

	const verification = gateStore!.getGate(GOAL_ID, GATE_ID)!.signals.find(entry => entry.id === restartSignal.id)!.verification as any;
	expect(verification).toMatchObject({
		status: "cancelled",
		cancellation: { cause: "gateway-restart-recovery", requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
		steps: [
			{ name: "Completed before restart", status: "passed", passed: true, output: COMPLETED_OUTPUT, duration_ms: 23 },
			{ name: "Interrupted review result", status: "cancelled", passed: false, cancellation: { cause: "gateway-restart-recovery" } },
			{ name: "Interrupted QA result", status: "cancelled", passed: false, cancellation: { cause: "gateway-restart-recovery" } },
		],
	});
	expect(verification.steps.some((step: any) => step.status === "failed"),
		"VERIFICATION_CANCELLATION_OUTCOME_AUDIT: a structured restart interruption cannot retain a failed product row").toBe(false);
	expect(gateStore!.getGate(GOAL_ID, GATE_ID)!.status).toBe("pending");
	expect(events).toContainEqual(expect.objectContaining({
		type: "gate_verification_complete",
		signalId: restartSignal.id,
		status: "cancelled",
		cancellation: expect.objectContaining({ cause: "gateway-restart-recovery" }),
	}));
});

test("structured restart provenance persists across recovery before cleanup finalizes — VERIFICATION_CANCELLATION_OUTCOME_AUDIT", async () => {
	const { harness, active } = restartAggregateFixture();
	let releaseCleanup!: () => void;
	const cleanupBlocked = new Promise<void>(resolve => { releaseCleanup = resolve; });
	let capturePersisted!: (value: any) => void;
	const persistedDuringCleanup = new Promise<any>(resolve => { capturePersisted = resolve; });
	(harness as any)._terminateCancelledReviewersFor = async () => {
		// _loadActive is the harness persistence seam; it models a new gateway
		// reading the record without polling or opening the state file in the test.
		const restarted = new VerificationHarness(
			stateDir!, gateStore!, () => {}, { get: () => undefined, getAll: () => [] } as any,
		);
		capturePersisted((restarted as any)._loadActive().find((entry: any) => entry.signalId === active.signalId));
		await cleanupBlocked;
	};

	const finalization = (harness as any)._finalizeRestartInterruptedVerification(active);
	const persisted = await persistedDuringCleanup;
	expect(persisted, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: restart cancellation intent must reach durable active state before cleanup yields").toMatchObject({
		cancelled: true,
		overallStatus: "cancelled",
		cancellation: { cause: "gateway-restart-recovery", requestedAt: expect.any(Number) },
		steps: [
			{ name: "Completed before restart", status: "passed" },
			{ name: "Interrupted review result", status: "running", restartInterrupted: true, cancellation: { cause: "gateway-restart-recovery" } },
			{ name: "Interrupted QA result", status: "running", restartInterrupted: true, cancellation: { cause: "gateway-restart-recovery" } },
		],
	});
	releaseCleanup();
	await finalization;
});

test("restart recovery continues to a second persisted verification when the first interruption fence cannot persist", async () => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-restart-fence-continue-"));
	const first = { goalId: `${GOAL_ID}-first`, gateId: `${GATE_ID}-first`, signalId: `${SIGNAL_ID}-first`, overallStatus: "running" as const, startedAt: 1, steps: [] };
	const second = { goalId: `${GOAL_ID}-second`, gateId: `${GATE_ID}-second`, signalId: `${SIGNAL_ID}-second`, overallStatus: "running" as const, startedAt: 1, steps: [] };
	const stored = new Map([
		[first.signalId, {
			status: "running", signals: [{
				id: first.signalId, goalId: first.goalId, gateId: first.gateId, sessionId: "owner", timestamp: 1,
				commitSha: "0123456789abcdef0123456789abcdef01234567", content: "", contentVersion: 1,
				verification: { status: "running", steps: [] },
			}],
		}],
		[second.signalId, {
			status: "running", signals: [{
				id: second.signalId, goalId: second.goalId, gateId: second.gateId, sessionId: "owner", timestamp: 2,
				commitSha: "0123456789abcdef0123456789abcdef01234567", content: "", contentVersion: 1,
				verification: { status: "running", steps: [] },
			}],
		}],
	]);
	const publications: any[] = [];
	const store = {
		getGate: (goalId: string, gateId: string) => [...stored.values()].find(gate => gate.signals[0]!.goalId === goalId && gate.signals[0]!.gateId === gateId),
		updateSignalVerification: (signalId: string, verification: any) => {
			stored.get(signalId)!.signals[0]!.verification = verification;
			publications.push({ kind: "signal", signalId, verification });
		},
		updateGateStatus: (goalId: string, gateId: string, status: string) => {
			const gate = [...stored.values()].find(candidate => candidate.signals[0]!.goalId === goalId && candidate.signals[0]!.gateId === gateId)!;
			gate.status = status;
			publications.push({ kind: "gate", goalId, status });
		},
		getGatesForGoal: () => [],
	} as any;
	const seed = new VerificationHarness(stateDir, store, () => {}, { get: () => undefined, getAll: () => [] } as any);
	(seed as any).activeVerifications.set(first.signalId, first);
	(seed as any).activeVerifications.set(second.signalId, second);
	expect((seed as any)._persistActive(), "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: both recoveries must cross the active persistence seam").toBe(true);

	const recovered = new VerificationHarness(stateDir, store, () => {}, { get: () => undefined, getAll: () => [] } as any);
	const resumed: string[] = [];
	const persist = (recovered as any)._persistActive.bind(recovered);
	let rejectFirstFence = true;
	(recovered as any)._persistActive = () => {
		const firstActive = (recovered as any).activeVerifications.get(first.signalId);
		if (rejectFirstFence && firstActive?.cancelled) {
			rejectFirstFence = false;
			return false;
		}
		return persist();
	};
	(recovered as any)._resumeOneVerification = async (active: any) => {
		resumed.push(active.signalId);
		if (active.signalId === first.signalId) throw new Error("Command timed out: known restart RPC error");
		active.overallStatus = "passed";
	};

	await expect(recovered.resumeInterruptedVerifications(), "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: one restart fence failure must not abort unrelated recovery").resolves.toBeUndefined();
	expect(resumed, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: second durable verification must still be resumed after the first fence failure").toEqual([first.signalId, second.signalId]);
	expect((recovered as any).activeVerifications.has(first.signalId), "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: a failed restart fence must keep its in-memory owner").toBe(true);
	expect((recovered as any)._loadActive().some((entry: any) => entry.signalId === first.signalId), "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: a failed restart fence must keep its durable owner").toBe(true);
	expect(publications.filter(call => call.signalId === first.signalId)).toEqual([]);

	// Re-drive through the public restart seam after persistence recovers. The
	// retained first record settles once; the already-processed sibling stays done.
	await recovered.resumeInterruptedVerifications();
	expect(resumed, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: durable structured recovery must re-enter cleanup without recursive resume").toEqual([first.signalId, second.signalId]);
	expect((recovered as any).activeVerifications.has(first.signalId)).toBe(false);
	expect((recovered as any)._loadActive().some((entry: any) => entry.signalId === first.signalId)).toBe(false);
	expect(publications.filter(call => call.kind === "signal" && call.signalId === first.signalId)).toEqual([
		expect.objectContaining({ verification: expect.objectContaining({ status: "cancelled", cancellation: expect.objectContaining({ cause: "gateway-restart-recovery" }) }) }),
	]);
});

test.each(["llm-review", "agent-qa"] as const)("%s durably captures a failed verification_result before teardown yields", async (type) => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `verification-late-${type}-verdict-`));
	const signalId = `${SIGNAL_ID}-late-${type}`;
	const sessionId = `${signalId}-session`;
	let harness: any;
	let releaseTerminate!: () => void;
	const terminateBlocked = new Promise<void>(resolve => { releaseTerminate = resolve; });
	let acceptedResolver!: () => void;
	const acceptedDuringTerminate = new Promise<void>(resolve => { acceptedResolver = resolve; });
	const lateSummary = `Late ${type} rejection accepted during teardown.`;
	const calls: any[] = [];
	let terminateAttempts = 0;
	const sessionManager = {
		getSession: () => ({ id: sessionId, status: "idle", rpcClient: { onEvent: () => () => {} } }),
		waitForIdle: async () => {}, waitForStreaming: async () => {},
		terminateSession: async (id: string) => {
			// The first call is the `_tryResumeFromSession` teardown boundary. A
			// later cancellation cleanup retry is deliberately idempotent and must
			// not turn the pre-publication assertion into an unhandled rejection.
			if (++terminateAttempts !== 1) return;
			const resolver = harness.pendingResults.get(id);
			expect(resolver, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: teardown must retain the exact pending verifier resolver").toBeTypeOf("function");
			resolver?.({ verdict: false, summary: lateSummary });
			acceptedResolver();
			await terminateBlocked;
		},
	};
	const storedSignal = {
		id: signalId, goalId: GOAL_ID, gateId: GATE_ID, sessionId: "owner", timestamp: 1,
		commitSha: "0123456789abcdef0123456789abcdef01234567", content: "", contentVersion: 1,
		verification: {
			status: "running",
			steps: [{ name: `Late ${type} verdict`, type, status: "running", passed: false, phase: 0, output: "", duration_ms: 0 }],
		},
	};
	const storedGate = { status: "running", signals: [storedSignal] };
	const store = {
		getGate: () => storedGate,
		updateSignalVerification: (_id: string, update: any) => { storedSignal.verification = update; calls.push({ kind: "signal", update }); },
		updateGateStatus: (_goal: string, _gate: string, status: string) => { storedGate.status = status; calls.push({ kind: "gate", status }); },
		getGatesForGoal: () => [],
	} as any;
	harness = new VerificationHarness(stateDir, store, () => {}, { get: () => undefined, getAll: () => [] } as any, undefined, sessionManager as any);
	harness.waitForReviewerErroredTurnRecovery = async () => ({ type: "idle" });
	harness.dispatchVerifierPrompt = async () => ({ type: "accepted" });
	harness.waitForReviewTurn = async () => ({ type: "idle" });
	const active = {
		goalId: GOAL_ID, gateId: GATE_ID, signalId, overallStatus: "running" as const, startedAt: 1,
		steps: [{ name: `Late ${type} verdict`, type, status: "running" as const, startedAt: 1, sessionId }],
	};
	harness.activeVerifications.set(signalId, active);
	expect(harness._persistActive()).toBe(true);
	const recovery = harness._resumeOneVerification(active);
	try {
		await acceptedDuringTerminate;
		// A new harness models the crash/restart boundary without direct file IO.
		const restarted = new VerificationHarness(stateDir, store, () => {}, { get: () => undefined, getAll: () => [] } as any);
		const persisted = (restarted as any)._loadActive().find((entry: any) => entry.signalId === signalId);
		expect(persisted?.steps[0]).toMatchObject({ status: "failed", passed: false, output: lateSummary, verdictObtained: true });
		expect(persisted?.steps[0]?.restartInterrupted, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: accepted reviewer verdict clears stale restart provenance before teardown can finish").not.toBe(true);
		expect(calls, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: exact teardown blocks all terminal publication").toEqual([]);
	} finally {
		releaseTerminate();
	}
	await recovery;
	const published = calls.find(call => call.kind === "signal")?.update;
	expect(published).toMatchObject({ status: "failed" });
	expect(published?.cancellation).toBeUndefined();
	expect(calls.filter(call => call.kind === "gate").map(call => call.status)).toEqual(["failed"]);
});


function createStrictTerminalStore(signalId: string, initialSteps: any[]) {
	const signalRecord: any = {
		id: signalId, goalId: GOAL_ID, gateId: GATE_ID, sessionId: "owner", timestamp: 1,
		commitSha: "0123456789abcdef0123456789abcdef01234567", content: "", contentVersion: 1,
		verification: { status: "running", steps: initialSteps },
	};
	const gate: any = { status: "running", signals: [signalRecord] };
	const calls: any[] = [];
	return {
		gate,
		signalRecord,
		calls,
		store: {
			getGate: () => gate,
			getGatesForGoal: () => [],
			updateSignalVerificationStrict: async (requestedSignalId: string, verification: any) => {
				expect(requestedSignalId).toBe(signalId);
				signalRecord.verification = verification;
				calls.push({ kind: "signal", signalId: requestedSignalId, verification });
			},
			updateGateStatusStrict: async (_goalId: string, _gateId: string, status: string) => {
				gate.status = status;
				calls.push({ kind: "gate", status });
			},
			updateSignalVerification: () => { throw new Error("mixed terminal publication must use the strict signal seam"); },
			updateGateStatus: () => { throw new Error("mixed terminal publication must use the strict gate seam"); },
		},
	};
}

function deferredVoid() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

test("mixed restart command intent is durable until exact tracked cleanup settles, then publishes once", async () => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-mixed-command-intent-"));
	const signalId = `${SIGNAL_ID}-mixed-command`;
	const events: any[] = [];
	const terminal = createStrictTerminalStore(signalId, [
		{ name: "Genuine command failure", type: "command", passed: false, status: "failed", phase: 0, output: "real failure", duration_ms: 7 },
		{ name: "Interrupted spawned command", type: "command", passed: false, status: "running", phase: 0, output: "partial output", duration_ms: 3 },
	]);
	const harness: any = new VerificationHarness(
		stateDir, terminal.store as any, (_goalId, event) => events.push(event), { get: () => undefined, getAll: () => [] } as any,
	);
	const active: any = {
		goalId: GOAL_ID, gateId: GATE_ID, signalId, overallStatus: "running", startedAt: 1,
		steps: [
			{ name: "Genuine command failure", type: "command", status: "failed", passed: false, output: "real failure", durationMs: 7, startedAt: 1 },
			{
				name: "Interrupted spawned command", type: "command", status: "running", passed: false,
				output: "partial output", durationMs: 3, startedAt: 1, restartInterrupted: true,
				commandSpawnState: "spawned", commandSpawnedAt: 2,
			},
		],
	};
	harness.activeVerifications.set(signalId, active);
	expect(harness._persistActive()).toBe(true);

	const cleanupStarted = deferredVoid();
	const releaseCleanup = deferredVoid();
	let killCalls = 0;
	const tracked = {
		ownershipReady: Promise.resolve(),
		killTree: () => { killCalls++; cleanupStarted.resolve(); },
		waitForTreeExit: () => releaseCleanup.promise.then(() => true),
	};
	harness._trackedCommandChildren.set(`${signalId}:1`, tracked);

	const preparation = harness._prepareMixedRestartFailureFromActive(active);
	await cleanupStarted.promise;
	const durable = harness._loadActive().find((entry: any) => entry.signalId === signalId);
	expect(durable).toMatchObject({
		pendingTerminalIntent: {
			kind: "mixed-restart-failed",
			verification: {
				status: "failed",
				steps: [
					{ name: "Genuine command failure", status: "failed", passed: false, output: "real failure" },
					{ name: "Interrupted spawned command", status: "cancelled", passed: false, cancellation: { cause: "gateway-restart-recovery" } },
				],
			},
		},
		steps: [
			{ name: "Genuine command failure", status: "failed" },
			{ name: "Interrupted spawned command", status: "running", restartInterrupted: true, killRequestedAt: expect.any(Number), killReason: "cancelled", killSignal: "SIGKILL" },
		],
	});
	expect(terminal.calls).toEqual([]);
	expect(terminal.gate.status).toBe("running");
	expect(events.filter(event => event.type === "gate_verification_complete")).toEqual([]);

	releaseCleanup.resolve();
	await preparation;
	expect(killCalls).toBe(1);
	expect(terminal.calls.filter(call => call.kind === "signal")).toEqual([
		expect.objectContaining({ verification: expect.objectContaining({ status: "failed" }) }),
	]);
	expect(terminal.calls.filter(call => call.kind === "gate")).toEqual([{ kind: "gate", status: "failed" }]);
	expect(terminal.signalRecord.verification.steps).toMatchObject([
		{ name: "Genuine command failure", status: "failed", passed: false, output: "real failure" },
		{ name: "Interrupted spawned command", status: "cancelled", passed: false, cancellation: { cause: "gateway-restart-recovery" } },
	]);
	expect(events.filter(event => event.type === "gate_verification_complete")).toEqual([
		expect.objectContaining({ signalId, status: "failed" }),
	]);
	expect(harness._loadActive().some((entry: any) => entry.signalId === signalId)).toBe(false);
});

test("mixed reviewer cleanup failure retains its exact session and intent until deterministic retry", async () => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-mixed-reviewer-intent-"));
	const signalId = `${SIGNAL_ID}-mixed-reviewer`;
	const sessionId = `${signalId}-session`;
	const clock = createManualClock(10_000);
	const events: any[] = [];
	const terminal = createStrictTerminalStore(signalId, [
		{ name: "Genuine sibling failure", type: "command", passed: false, status: "failed", phase: 0, output: "real failure", duration_ms: 4 },
		{ name: "Interrupted reviewer", type: "llm-review", passed: false, status: "running", phase: 0, output: "", duration_ms: 0 },
	]);
	let failTerminate = true;
	const terminated: string[] = [];
	const sessionManager = {
		terminateSession: async (requestedSessionId: string) => {
			terminated.push(requestedSessionId);
			if (failTerminate) throw new Error("injected reviewer teardown failure");
		},
	};
	const harness: any = new VerificationHarness(
		stateDir, terminal.store as any, (_goalId, event) => events.push(event), { get: () => undefined, getAll: () => [] } as any,
		undefined, sessionManager as any, undefined, undefined, undefined, undefined, { clock },
	);
	const active: any = {
		goalId: GOAL_ID, gateId: GATE_ID, signalId, overallStatus: "running", startedAt: 1, reviewerCleanupPending: true,
		steps: [
			{ name: "Genuine sibling failure", type: "command", status: "failed", passed: false, output: "real failure", durationMs: 4, startedAt: 1 },
			{ name: "Interrupted reviewer", type: "llm-review", status: "running", passed: false, output: "", startedAt: 1, restartInterrupted: true, sessionId },
		],
	};
	harness.activeVerifications.set(signalId, active);
	expect(harness._persistActive()).toBe(true);

	await harness._prepareMixedRestartFailureFromActive(active);
	const durablePending = harness._loadActive().find((entry: any) => entry.signalId === signalId);
	expect(durablePending).toMatchObject({
		reviewerCleanupPending: true,
		pendingTerminalIntent: { kind: "mixed-restart-failed", verification: { status: "failed" } },
		steps: [expect.any(Object), { name: "Interrupted reviewer", sessionId, restartInterrupted: true }],
	});
	expect(terminated).toEqual([sessionId]);
	expect(terminal.calls).toEqual([]);
	expect(events.filter(event => event.type === "gate_verification_complete")).toEqual([]);
	expect(clock.pending()).toBe(1);

	failTerminate = false;
	clock.advance(1_000);
	const retry = harness._cancelledCleanupPromises.get(signalId);
	expect(retry).toBeDefined();
	await retry;
	expect(terminated).toEqual([sessionId, sessionId]);
	expect(terminal.calls.filter(call => call.kind === "signal")).toHaveLength(1);
	expect(terminal.calls.filter(call => call.kind === "gate")).toEqual([{ kind: "gate", status: "failed" }]);
	expect(terminal.signalRecord.verification.steps).toMatchObject([
		{ name: "Genuine sibling failure", status: "failed", passed: false },
		{ name: "Interrupted reviewer", status: "cancelled", passed: false, cancellation: { cause: "gateway-restart-recovery" } },
	]);
	expect(events.filter(event => event.type === "gate_verification_complete")).toEqual([
		expect.objectContaining({ signalId, status: "failed" }),
	]);
	expect(harness._loadActive().some((entry: any) => entry.signalId === signalId)).toBe(false);
	expect(clock.pending()).toBe(0);
});

test.each(["cancelled", "mixed"] as const)("missing goal/store retires a %s exact-cleanup owner without events or retries", async (kind) => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `verification-missing-store-${kind}-`));
	const signalId = `${SIGNAL_ID}-missing-store-${kind}`;
	const clock = createManualClock(20_000);
	const events: any[] = [];
	const missingProjectContext = { getContextForGoal: () => undefined };
	const harness: any = new VerificationHarness(
		stateDir, undefined, (_goalId, event) => events.push(event), { get: () => undefined, getAll: () => [] } as any,
		undefined, undefined, undefined, undefined, missingProjectContext as any, undefined, { clock },
	);
	const active: any = {
		goalId: `${GOAL_ID}-removed`, gateId: GATE_ID, signalId, overallStatus: kind === "cancelled" ? "cancelled" : "running", startedAt: 1,
		steps: [],
		...(kind === "cancelled"
			? { cancelled: true, cancellation: { cause: "archive", requestedAt: 19_000 } }
			: {
				pendingTerminalIntent: {
					kind: "mixed-restart-failed", preparedAt: 19_000, gateStatus: "failed",
					verification: { status: "failed", steps: [] },
				},
			}),
	};
	harness.activeVerifications.set(signalId, active);
	expect(harness._persistActive()).toBe(true);

	await harness._startCancelledVerificationCleanup(active);
	expect(harness.activeVerifications.has(signalId), "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: missing goal/store cannot retain an unpublishable active owner").toBe(false);
	expect(harness._loadActive().some((entry: any) => entry.signalId === signalId)).toBe(false);
	expect(events).toEqual([]);
	expect(clock.pending(), "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: retired missing-store ownership must not schedule an infinite cleanup retry").toBe(0);
});

async function resumeGenuineRestartLikeVerdict(type: "llm-review" | "agent-qa", output: string) {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-genuine-restart-like-"));
	const calls: Array<{ kind: string; value: any }> = [];
	const notifications: string[] = [];
	const signalId = `${SIGNAL_ID}-${type}-${output ? "phrases" : "empty"}`;
	const store = {
		getGate: () => ({ status: "running", signals: [{ id: signalId, timestamp: 1 }] }),
		updateSignalVerification: (_id: string, value: any) => calls.push({ kind: "verification", value }),
		updateGateStatus: (_goalId: string, _gateId: string, value: string) => calls.push({ kind: "gate", value }),
		getGatesForGoal: () => [],
	} as any;
	const harness = new VerificationHarness(
		stateDir, store, () => {}, { get: () => undefined, getAll: () => [] } as any,
	);
	const active = {
		goalId: GOAL_ID, gateId: GATE_ID, signalId, overallStatus: "running" as const, startedAt: 1,
		steps: [{ name: `Genuine ${type} verdict`, type, status: "running" as const, startedAt: 1, sessionId: "reviewer" }],
	};
	(harness as any).activeVerifications.set(signalId, active);
	expect((harness as any)._persistActive(), "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: the legacy active record must cross the durable restart seam").toBe(true);

	// Recover the old, unmarked record through the same persisted-active seam as
	// gateway boot. The synthetic reviewer result is a genuine verdict whose
	// text is adversarial; it has no harness-owned `restartInterrupted` marker.
	const recovered = new VerificationHarness(
		stateDir, store, () => {}, { get: () => undefined, getAll: () => [] } as any,
	);
	// This models an actual recovered `verification_result`, not a transport
	// interruption. Even hostile historical text (or an intentionally empty
	// summary) must not authorize a replacement reviewer/QA run.
	(recovered as any)._tryResumeFromSession = async (_recoveredActive: any, step: any) => ({
		name: step.name, type, passed: false, status: "failed", output, duration_ms: 4,
		verdictObtained: true,
	});
	const rerunAttempts: string[] = [];
	(recovered as any)._rerunLlmReviewStep = async () => {
		rerunAttempts.push("llm-review");
		return { name: `Genuine ${type} verdict`, type: "llm-review", passed: true, status: "passed", output: "Rerun must never replace the verdict.", duration_ms: 1 };
	};
	(recovered as any)._rerunAgentQaStep = async () => {
		rerunAttempts.push("agent-qa");
		return { name: `Genuine ${type} verdict`, type: "agent-qa", passed: true, status: "passed", output: "Rerun must never replace the verdict.", duration_ms: 1 };
	};
	recovered.setTeamLeadNotifier((_goalId, message) => notifications.push(message));
	await recovered.resumeInterruptedVerifications();
	return { calls, notifications, rerunAttempts };
}

test("a marked restart interruption cannot cancel its unmarked failed reviewer sibling — VERIFICATION_CANCELLATION_OUTCOME_AUDIT", async () => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-restart-sibling-verdict-"));
	const calls: Array<{ kind: string; value: any }> = [];
	const events: any[] = [];
	const notifications: string[] = [];
	const signalId = `${SIGNAL_ID}-restart-sibling-verdict`;
	const store = {
		getGate: () => ({ status: "running", signals: [{ id: signalId, timestamp: 1 }] }),
		updateSignalVerification: (_id: string, value: any) => calls.push({ kind: "verification", value }),
		updateGateStatus: (_goalId: string, _gateId: string, value: string) => calls.push({ kind: "gate", value }),
		getGatesForGoal: () => [],
	} as any;
	const seed = new VerificationHarness(
		stateDir, store, (_goalId, event) => events.push(event), { get: () => undefined, getAll: () => [] } as any,
	);
	const active = {
		goalId: GOAL_ID, gateId: GATE_ID, signalId, overallStatus: "running" as const, startedAt: 1,
		steps: [
			{
				name: "Marked no-verdict review", type: "llm-review", status: "failed" as const, passed: false, startedAt: 1,
				output: "", restartInterrupted: true,
			},
			{
				name: "Genuine reviewer rejection", type: "llm-review", status: "failed" as const, passed: false, startedAt: 1,
				output: `Actual reviewer rejection.\n${FORMER_RESTART_PHRASES.join("\n")}`,
			},
		],
	};
	(seed as any).activeVerifications.set(signalId, active);
	expect((seed as any)._persistActive(), "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: sibling verdict fixture must cross the durable active-record recovery seam").toBe(true);

	const recovered = new VerificationHarness(
		stateDir, store, (_goalId, event) => events.push(event), { get: () => undefined, getAll: () => [] } as any,
	);
	const rerunAttempts: string[] = [];
	(recovered as any)._tryResumeFromSession = async (_active: any, step: any) => {
		rerunAttempts.push(step.name);
		throw new Error(`unexpected rerun of persisted terminal step ${step.name}`);
	};
	recovered.setTeamLeadNotifier((_goalId, message) => notifications.push(message));
	await recovered.resumeInterruptedVerifications();

	const verification = calls.find(call => call.kind === "verification")?.value;
	expect(verification, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: an unmarked genuine failed sibling must publish a terminal verification").toMatchObject({
		status: "failed",
		steps: [
			{
				name: "Marked no-verdict review",
				status: "cancelled",
				passed: false,
				cancellation: {
					cause: "gateway-restart-recovery",
					requestedAt: expect.any(Number),
					finalizedAt: expect.any(Number),
				},
			},
			{ name: "Genuine reviewer rejection", status: "failed", passed: false, output: expect.stringContaining("Actual reviewer rejection.") },
		],
	});
	expect(verification?.cancellation, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: a genuine failure sibling forbids cancellation provenance on the signal").toBeUndefined();
	expect(calls.filter(call => call.kind === "gate").map(call => call.value)).toEqual(["failed"]);
	expect(events).toContainEqual(expect.objectContaining({ type: "gate_verification_complete", signalId, status: "failed" }));
	expect(events.some(event => event.type === "gate_verification_complete" && event.status === "cancelled"),
		"VERIFICATION_CANCELLATION_OUTCOME_AUDIT: sibling verdict failure must not emit a cancelled completion event").toBe(false);
	expect(notifications.join("\n"), "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: only the genuine product failure belongs in the failure notification").toContain('step="Genuine reviewer rejection"');
	expect(notifications.join("\n"), "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: an interrupted audit row must not appear as a failed notification step").not.toContain('step="Marked no-verdict review"');
	expect(rerunAttempts, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: persisted terminal marked interruption is audit evidence, never rerunnable work").toEqual([]);
});

test.each([
	["llm-review", FORMER_RESTART_PHRASES.join("\n")],
	["agent-qa", FORMER_RESTART_PHRASES.join("\n")],
	["llm-review", ""],
	["agent-qa", ""],
] as const)("unmarked genuine %s restart-like verdicts fail closed instead of becoming cancellation", async (type, output) => {
	const { calls, notifications, rerunAttempts } = await resumeGenuineRestartLikeVerdict(type, output);
	const verification = calls.find(call => call.kind === "verification")?.value;
	expect(verification, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: genuine reviewer verdict must publish normally").toMatchObject({ status: "failed" });
	expect(verification?.cancellation).toBeUndefined();
	expect(verification?.steps).toMatchObject([{ status: "failed", passed: false, output }]);
	expect(calls.filter(call => call.kind === "gate").map(call => call.value)).toEqual(["failed"]);
	expect(notifications.join("\n"), "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: genuine failure notification must not be suppressed by restart-like content").toContain(`step="Genuine ${type} verdict"`);
	expect(rerunAttempts, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: a recovered verification_result with verdictObtained=true must never be replaced by a rerun").toEqual([]);
});
