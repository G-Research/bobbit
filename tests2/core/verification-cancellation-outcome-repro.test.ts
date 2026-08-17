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

import { GateStore, type GateSignal, type GateStatus } from "../../src/server/agent/gate-store.js";
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

test.each([
	{ type: "llm-review" as const, verdict: true, trigger: "terminate" as const, restartRetry: true },
	{ type: "llm-review" as const, verdict: false, trigger: "unregister" as const, restartRetry: false },
	{ type: "agent-qa" as const, verdict: true, trigger: "unregister" as const, restartRetry: false },
	{ type: "agent-qa" as const, verdict: false, trigger: "terminate" as const, restartRetry: false },
])("$type $verdict late verdict stays fenced when $trigger cleanup rejects", async ({ type, verdict, trigger, restartRetry }) => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `verification-late-cleanup-${type}-${verdict ? "pass" : "fail"}-`));
	const signalId = `${SIGNAL_ID}-late-cleanup-${type}-${verdict ? "pass" : "fail"}`;
	const sessionId = `${signalId}-session`;
	const summary = `${type} durable ${verdict ? "approval" : "rejection"}`;
	const clock = createManualClock(40_000);
	const events: any[] = [];
	const notifications: string[] = [];
	const publications: any[] = [];
	const storedSignal: any = {
		id: signalId, goalId: GOAL_ID, gateId: GATE_ID, sessionId: "owner", timestamp: 1,
		commitSha: "0123456789abcdef0123456789abcdef01234567", content: "", contentVersion: 1,
		verification: { status: "running", steps: [{ name: "Recovered verdict", type, status: "running", passed: false, output: "", duration_ms: 0 }] },
	};
	const storedGate: any = { status: "pending", signals: [storedSignal] };
	const publishSignal = (requestedSignalId: string, verification: any) => {
		expect(requestedSignalId).toBe(signalId);
		storedSignal.verification = verification;
		publications.push({ kind: "signal", verification });
	};
	const publishGate = (_goalId: string, _gateId: string, status: string) => {
		storedGate.status = status;
		publications.push({ kind: "gate", status });
	};
	const store: any = {
		getGate: () => storedGate,
		getGatesForGoal: () => [],
		updateSignalVerification: publishSignal,
		updateGateStatus: publishGate,
		updateSignalVerificationStrict: async (requestedSignalId: string, verification: any) => publishSignal(requestedSignalId, verification),
		updateGateStatusStrict: async (goalId: string, gateId: string, status: string) => publishGate(goalId, gateId, status),
	};
	const cleanupCalls = { terminate: [] as string[], unregister: [] as string[] };
	const cleanupRejected = deferredVoid();
	let activeHarness: any;
	const cleanupOperation = async (operation: "terminate" | "unregister", requestedSessionId: string) => {
		cleanupCalls[operation].push(requestedSessionId);
		const attempt = cleanupCalls[operation].length;
		if (operation !== trigger || attempt > 2) return;
		if (attempt === 1) {
			const resolver = activeHarness.pendingResults.get(requestedSessionId);
			expect(resolver, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: teardown retains the exact late-verdict resolver").toBeTypeOf("function");
			resolver({ verdict, summary });
			cleanupRejected.resolve();
		}
		// The resumed-review teardown and its immediate shared-owner re-drive both
		// fail. Only the scheduled/restarted third attempt may publish the verdict.
		throw new Error(`injected ${operation} cleanup rejection ${attempt}`);
	};
	const sessionManager = {
		getSession: () => ({ id: sessionId, status: "idle", rpcClient: { onEvent: () => () => {} } }),
		waitForIdle: async () => {},
		waitForStreaming: async () => {},
		terminateSession: async (requestedSessionId: string) => cleanupOperation("terminate", requestedSessionId),
	};
	const teamManager = {
		registerReviewerSession: () => {},
		unregisterReviewerSession: async (_goalId: string, requestedSessionId: string) => cleanupOperation("unregister", requestedSessionId),
	};
	const makeHarness = (harnessClock = clock) => {
		const harness: any = new VerificationHarness(
			stateDir!, store, (_goalId, event) => events.push(event), { get: () => undefined, getAll: () => [] } as any,
			undefined, sessionManager as any, teamManager as any, undefined, undefined, undefined, { clock: harnessClock },
		);
		harness.setTeamLeadNotifier((_goalId: string, message: string) => notifications.push(message));
		harness.waitForReviewerErroredTurnRecovery = async () => ({ type: "idle" });
		harness.dispatchVerifierPrompt = async () => ({ type: "accepted" });
		harness.waitForReviewTurn = async () => ({ type: "idle" });
		return harness;
	};
	activeHarness = makeHarness();
	const active: any = {
		goalId: GOAL_ID, gateId: GATE_ID, signalId, overallStatus: "running", startedAt: 1,
		steps: [{ name: "Recovered verdict", type, status: "running", startedAt: 1, sessionId }],
	};
	activeHarness.activeVerifications.set(signalId, active);
	expect(activeHarness._persistActive()).toBe(true);
	const recovery = activeHarness._resumeOneVerification(active);
	await cleanupRejected.promise;
	await recovery;

	const persisted = activeHarness._loadActive().find((entry: any) => entry.signalId === signalId);
	const expectedStatus = verdict ? "passed" : "failed";
	expect(persisted, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: cleanup failure retains durable terminal ownership").toMatchObject({
		reviewerCleanupPending: true,
		pendingTerminalIntent: {
			kind: "terminal",
			gateStatus: expectedStatus,
			verification: {
				status: expectedStatus,
				steps: [{ name: "Recovered verdict", type, status: expectedStatus, passed: verdict, output: summary }],
			},
		},
		steps: [{
			name: "Recovered verdict", type, sessionId,
			status: verdict ? "passed" : "failed", passed: verdict, output: summary, verdictObtained: true,
		}],
	});
	expect(publications, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: reviewer cleanup gates signal and gate publication").toEqual([]);
	expect(events.filter(event => event.type === "gate_verification_complete"), "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: reviewer cleanup gates WS terminal publication").toEqual([]);
	expect(notifications, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: reviewer cleanup gates transcript notification").toEqual([]);

	let owner = activeHarness;
	let ownerClock = clock;
	if (restartRetry) {
		// A fresh gateway must consume the durable reviewer cleanup fence before it
		// can publish the already-captured product verdict.
		ownerClock = createManualClock(clock.now());
		owner = makeHarness(ownerClock);
		activeHarness = owner;
		await owner.resumeInterruptedVerifications();
	} else {
		expect(clock.pending()).toBe(1);
		clock.advance(1_000);
		await Promise.resolve();
		const retry = owner._cancelledCleanupPromises.get(signalId);
		if (retry) await retry;
	}

	expect(cleanupCalls[trigger], "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: both failed cleanup owners and the successful retry target the same session").toEqual([sessionId, sessionId, sessionId]);
	expect(publications.filter(call => call.kind === "signal")).toEqual([
		expect.objectContaining({ verification: expect.objectContaining({ status: expectedStatus, steps: [expect.objectContaining({ passed: verdict, status: expectedStatus, output: summary })] }) }),
	]);
	expect(publications.filter(call => call.kind === "gate")).toEqual([{ kind: "gate", status: expectedStatus }]);
	expect(events.filter(event => event.type === "gate_verification_complete")).toEqual([
		expect.objectContaining({ signalId, status: expectedStatus }),
	]);
	expect(notifications).toHaveLength(1);
	expect(notifications[0]).toMatch(verdict ? /PASSED/ : /FAILED/);
	expect(owner.activeVerifications.has(signalId)).toBe(false);
	expect(owner._loadActive().some((entry: any) => entry.signalId === signalId)).toBe(false);
	expect(ownerClock.pending()).toBe(0);
});

function installHeldResumeResolver(type: "llm-review" | "agent-qa", suffix: string) {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `verification-resolver-${suffix}-`));
	const signalId = `${SIGNAL_ID}-${suffix}`;
	const sessionId = `${signalId}-session`;
	const clock = createManualClock(30_000);
	let terminateCalls = 0;
	const sessionManager = {
		getSession: () => ({
			id: sessionId,
			status: "streaming",
			rpcClient: { onEvent: () => () => {} },
		}),
		waitForIdle: async () => {},
		terminateSession: async () => { terminateCalls++; },
	};
	const harness: any = new VerificationHarness(
		stateDir, {} as any, () => {}, { get: () => undefined, getAll: () => [] } as any,
		undefined, sessionManager as any, undefined, undefined, undefined, undefined, { clock },
	);
	const step: any = {
		name: `${type} recovered verdict`, type, status: "running", startedAt: 29_000,
		sessionId, restartInterrupted: true, output: "pre-result diagnostic", durationMs: 5,
	};
	const active: any = {
		goalId: GOAL_ID, gateId: GATE_ID, signalId, overallStatus: "running", startedAt: 29_000,
		steps: [step],
	};
	harness.activeVerifications.set(signalId, active);
	expect(harness._persistActive()).toBe(true);
	const resolverInstalled = deferredVoid();
	harness.waitForReviewTurn = async (_requestedSessionId: string, resultPromise: Promise<any>) => {
		resolverInstalled.resolve();
		const result = await resultPromise;
		return { type: "result", ...result };
	};
	const recovery = harness._tryResumeFromSession(active, step);
	return {
		harness, active, step, signalId, sessionId, clock, recovery,
		resolverInstalled: resolverInstalled.promise,
		terminateCalls: () => terminateCalls,
	};
}

test.each(["llm-review", "agent-qa"] as const)("%s resolver rolls back an undurable verdict and accepts the same retry exactly once", async (type) => {
	const fixture = installHeldResumeResolver(type, `persist-retry-${type}`);
	await fixture.resolverInstalled;
	const resolver = fixture.harness.pendingResults.get(fixture.sessionId);
	expect(resolver).toBeTypeOf("function");
	const before = structuredClone(fixture.step);
	const persistActive = fixture.harness._persistActive.bind(fixture.harness);
	let rejectPersistence = true;
	let successfulResolverPersists = 0;
	fixture.harness._persistActive = () => {
		if (rejectPersistence) return false;
		successfulResolverPersists++;
		return persistActive();
	};
	let recoveryOutcome: "pending" | "resolved" | "rejected" = "pending";
	let recoveryResolutions = 0;
	void fixture.recovery.then(
		() => { recoveryOutcome = "resolved"; recoveryResolutions++; },
		() => { recoveryOutcome = "rejected"; },
	);

	expect(() => resolver({ verdict: false, summary: "Rejected after restart." })).toThrow(/Could not persist recovered verification result/);
	expect(fixture.step, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: failed verdict persistence must restore every exact active-step field").toStrictEqual(before);
	expect(fixture.step.restartInterrupted).toBe(true);
	await Promise.resolve();
	expect(recoveryOutcome, "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: an undurable result must not resolve the captured reviewer promise").toBe("pending");
	expect(fixture.clock.pending(), "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: resolver rejection must not depend on a retry timer").toBe(0);
	expect(fixture.terminateCalls()).toBe(0);

	rejectPersistence = false;
	expect(() => resolver({ verdict: false, summary: "Rejected after restart." })).not.toThrow();
	const result = await fixture.recovery;
	expect(result).toMatchObject({ passed: false, output: "Rejected after restart.", verdictObtained: true });
	await Promise.resolve();
	expect(recoveryOutcome).toBe("resolved");
	expect(recoveryResolutions).toBe(1);
	expect(successfulResolverPersists).toBe(1);
	expect(fixture.terminateCalls()).toBe(1);
	expect(fixture.harness._loadActive().find((entry: any) => entry.signalId === fixture.signalId)?.steps[0]).toMatchObject({
		status: "failed", passed: false, output: "Rejected after restart.", verdictObtained: true,
	});
	expect(fixture.harness._loadActive().find((entry: any) => entry.signalId === fixture.signalId)?.steps[0]?.restartInterrupted).toBeUndefined();
});

test("recovered verdict resolver rejects a missing active row without resolving its captured promise", async () => {
	const fixture = installHeldResumeResolver("llm-review", "missing-active-row");
	await fixture.resolverInstalled;
	const resolver = fixture.harness.pendingResults.get(fixture.sessionId);
	expect(resolver).toBeTypeOf("function");
	fixture.harness.activeVerifications.delete(fixture.signalId);
	let recoveryOutcome: "pending" | "resolved" | "rejected" = "pending";
	void fixture.recovery.then(
		() => { recoveryOutcome = "resolved"; },
		() => { recoveryOutcome = "rejected"; },
	);

	expect(() => resolver({ verdict: true, summary: "Must not resolve." })).toThrow(/no active row/);
	await Promise.resolve();
	expect(recoveryOutcome).toBe("pending");
	expect(fixture.terminateCalls()).toBe(0);
	expect(fixture.clock.pending()).toBe(0);
});

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

test("empty active-state removal fails closed on non-ENOENT unlink errors", () => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-empty-unlink-failure-"));
	const persistedPath = path.join(stateDir, "active-verifications.json");
	const harness: any = new VerificationHarness(
		stateDir, {} as any, () => {}, { get: () => undefined, getAll: () => [] } as any,
	);
	expect(harness.activeVerifications.size).toBe(0);
	// A directory at the owned file path deterministically makes unlink fail with
	// EISDIR/EPERM without permissions, platform timing, or filesystem mocking.
	fs.mkdirSync(persistedPath);
	expect(harness._persistActive(), "VERIFICATION_CANCELLATION_OUTCOME_AUDIT: non-ENOENT unlink failure cannot acknowledge durable owner retirement").toBe(false);
	expect(fs.statSync(persistedPath).isDirectory()).toBe(true);
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

test.each([true, false])("late %s reviewer verdict survives an undurable terminal intent and restart re-drives exact cleanup before one publication", async (verdict) => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `verification-undurable-terminal-intent-${verdict ? "pass" : "fail"}-`));
	const signalId = `${SIGNAL_ID}-undurable-terminal-${verdict ? "pass" : "fail"}`;
	const reviewerSessionId = `${signalId}-reviewer`;
	const status = verdict ? "passed" as const : "failed" as const;
	const summary = `Late reviewer ${verdict ? "approval" : "rejection"} persisted before terminal intent.`;
	const storedSignal: any = {
		...signal(), id: signalId,
		verification: { status: "running", steps: [{ name: "Late reviewer verdict", type: "llm-review", status: "running", passed: false, phase: 0, output: "", duration_ms: 0 }] },
	};
	const storedGate: any = { status: "pending", signals: [storedSignal] };
	const publications: any[] = [];
	const events: any[] = [];
	const notifications: string[] = [];
	const store: any = {
		getGate: () => storedGate,
		getGatesForGoal: () => [],
		updateSignalVerification: (id: string, verification: any) => {
			expect(id).toBe(signalId);
			storedSignal.verification = verification;
			publications.push({ kind: "signal", verification });
		},
		updateGateStatus: (_goalId: string, _gateId: string, gateStatus: string) => {
			storedGate.status = gateStatus;
			publications.push({ kind: "gate", status: gateStatus });
		},
		updateSignalVerificationStrict: async (id: string, verification: any) => {
			expect(id).toBe(signalId);
			storedSignal.verification = verification;
			publications.push({ kind: "signal", verification });
		},
		updateGateStatusStrict: async (_goalId: string, _gateId: string, gateStatus: string) => {
			storedGate.status = gateStatus;
			publications.push({ kind: "gate", status: gateStatus });
		},
	};
	const initialClock = createManualClock(50_000);
	const initial: any = new VerificationHarness(
		stateDir, store, () => {}, { get: () => undefined, getAll: () => [] } as any,
		undefined, undefined, undefined, undefined, undefined, undefined, { clock: initialClock },
	);
	const active: any = {
		goalId: GOAL_ID, gateId: GATE_ID, signalId, overallStatus: "running", startedAt: 1,
		reviewerCleanupPending: true,
		steps: [{ name: "Late reviewer verdict", type: "llm-review", status, passed: verdict, output: summary, durationMs: 9, startedAt: 1, sessionId: reviewerSessionId, verdictObtained: true }],
	};
	initial.activeVerifications.set(signalId, active);
	// The late result and its exact reviewer-cleanup owner reached disk before
	// staging the terminal intent. The next write fails, so a fresh harness must
	// reconstruct the terminal work from this durable fence rather than publish.
	expect(initial._persistActive()).toBe(true);
	const persistInitial = initial._persistActive.bind(initial);
	initial._persistActive = () => false;
	await expect(initial._stageTerminalIntentIfCleanupPending(active, {
		status,
		steps: [{ name: "Late reviewer verdict", type: "llm-review", status, passed: verdict, phase: 0, output: summary, duration_ms: 9 }],
	}, status)).resolves.toBe(true);
	initial._persistActive = persistInitial;

	const clock = createManualClock(60_000);
	const terminated: string[] = [];
	const unregistered: string[] = [];
	let rejectExactCleanup = true;
	const restarted: any = new VerificationHarness(
		stateDir, store, (_goalId, event) => events.push(event), { get: () => undefined, getAll: () => [] } as any,
		undefined,
		{ terminateSession: async (id: string) => { terminated.push(id); if (rejectExactCleanup) throw new Error("UNDURABLE_TERMINAL_TERMINATE"); } } as any,
		{ unregisterReviewerSession: async (_goalId: string, id: string) => { unregistered.push(id); if (rejectExactCleanup) throw new Error("UNDURABLE_TERMINAL_UNREGISTER"); } } as any,
		undefined, undefined, undefined, { clock },
	);
	restarted.setTeamLeadNotifier((_goalId: string, message: string) => notifications.push(message));
	await restarted.resumeInterruptedVerifications();

	expect(terminated, "UNDURABLE_TERMINAL_INTENT: restart must re-drive the persisted terminate identity before publication").toEqual([reviewerSessionId]);
	expect(unregistered, "UNDURABLE_TERMINAL_INTENT: restart must re-drive the persisted unregister identity before publication").toEqual([reviewerSessionId]);
	expect(restarted.getActiveVerification(signalId), "UNDURABLE_TERMINAL_INTENT: rejected exact cleanup retains the durable terminal owner").toMatchObject({
		reviewerCleanupPending: true,
		steps: [expect.objectContaining({ sessionId: reviewerSessionId, status, passed: verdict, output: summary })],
	});
	expect(publications, "UNDURABLE_TERMINAL_INTENT: no signal or gate terminal publication may precede exact cleanup").toEqual([]);
	expect(events.filter(event => event.type === "gate_verification_complete"), "UNDURABLE_TERMINAL_INTENT: no WS terminal publication may precede exact cleanup").toEqual([]);
	expect(notifications, "UNDURABLE_TERMINAL_INTENT: no transcript terminal publication may precede exact cleanup").toEqual([]);

	rejectExactCleanup = false;
	expect(clock.pending(), "UNDURABLE_TERMINAL_INTENT: failed exact cleanup schedules one clock-owned retry").toBe(1);
	clock.advance(1_000);
	await Promise.resolve();
	const retry = restarted._cancelledCleanupPromises.get(signalId);
	expect(retry, "UNDURABLE_TERMINAL_INTENT: the scheduled retry must own the recovered terminal publication").toBeDefined();
	await retry;

	expect(terminated).toEqual([reviewerSessionId, reviewerSessionId]);
	expect(unregistered).toEqual([reviewerSessionId, reviewerSessionId]);
	expect(publications.filter(publication => publication.kind === "signal")).toEqual([
		expect.objectContaining({ verification: expect.objectContaining({ status, steps: [expect.objectContaining({ passed: verdict, status, output: summary })] }) }),
	]);
	expect(publications.filter(publication => publication.kind === "gate")).toEqual([{ kind: "gate", status }]);
	expect(events.filter(event => event.type === "gate_verification_complete")).toEqual([
		expect.objectContaining({ signalId, status }),
	]);
	expect(notifications).toHaveLength(1);
	expect(restarted.getActiveVerification(signalId)).toBeUndefined();
	expect(clock.pending()).toBe(0);
});

test("a held stale strict gate write cannot overwrite a replacement generation or emit terminal events", async () => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-held-stale-gate-write-"));
	gateStore = new GateStore(stateDir, undefined, { persistence: "json" });
	gateStore.initGatesForGoal(GOAL_ID, [GATE_ID]);
	const oldSignal = { ...signal(), id: `${SIGNAL_ID}-held-old` };
	gateStore.recordSignal(oldSignal);
	const events: any[] = [];
	const harness: any = new VerificationHarness(
		stateDir, gateStore, (_goalId, event) => events.push(event), { get: () => undefined, getAll: () => [] } as any,
	);
	const oldActive: any = {
		goalId: GOAL_ID, gateId: GATE_ID, signalId: oldSignal.id, overallStatus: "running", startedAt: 1,
		steps: [],
		pendingTerminalIntent: {
			kind: "terminal", preparedAt: 1,
			verification: { status: "passed", steps: [{ name: "Old generation pass", type: "command", passed: true, status: "passed", phase: 0, output: "old output", duration_ms: 1 }] },
			gateStatus: "passed",
		},
	};
	harness.activeVerifications.set(oldSignal.id, oldActive);
	expect(harness._persistActive()).toBe(true);

	const strictWriteStarted = deferredVoid();
	const releaseStrictWrite = deferredVoid();
	const updateGateStatusStrict = gateStore.updateGateStatusStrict.bind(gateStore);
	(gateStore as any).updateGateStatusStrict = (goalId: string, gateId: string, status: GateStatus) => {
		// GateStore updates its in-memory gate synchronously before returning the
		// strict persistence promise. Hold only that promise's resolution so the
		// replacement interleaves with a real durable-write await, not before the
		// finalizer invokes the strict method.
		const persisted = updateGateStatusStrict(goalId, gateId, status);
		strictWriteStarted.resolve();
		return Promise.all([persisted, releaseStrictWrite.promise]).then(() => undefined);
	};
	const oldFinalization = harness._finalizePendingMixedRestartFailure(oldActive);
	await strictWriteStarted.promise;

	const replacement = { ...signal(), id: `${SIGNAL_ID}-held-replacement`, timestamp: oldSignal.timestamp + 1 };
	replacement.verification.steps = harness.beginVerification(replacement, { ...GATE, verify: [] });
	// recordSignal synchronously restores the replacement run's pending gate
	// while the old generation's strict durability promise remains held.
	gateStore.recordSignal(replacement);
	expect(gateStore.getGate(GOAL_ID, GATE_ID)!.signals.at(-1)?.id).toBe(replacement.id);
	expect(gateStore.getGate(GOAL_ID, GATE_ID)!.status).toBe("pending");

	releaseStrictWrite.resolve();
	await oldFinalization;

	const gate = gateStore.getGate(GOAL_ID, GATE_ID)!;
	expect(gate.status, "HELD_STALE_STRICT_GATE_WRITE: an old terminal write cannot replace the replacement generation's pending gate").toBe("pending");
	expect(gate.signals.find(entry => entry.id === replacement.id)?.verification?.status).toBe("running");
	expect(events.filter(event => event.type === "gate_verification_complete"), "HELD_STALE_STRICT_GATE_WRITE: a stale generation cannot authorize terminal WS completion").toEqual([]);
});

test("staged catch-path Error intent keeps workflowAligned false for the team-lead notification", async () => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-staged-error-notification-"));
	const signalId = `${SIGNAL_ID}-staged-error`;
	const storedSignal: any = { ...signal(), id: signalId, verification: { status: "running", steps: [] } };
	const storedGate: any = { status: "pending", signals: [storedSignal] };
	const store: any = {
		getGate: () => storedGate,
		getGatesForGoal: () => [],
		updateSignalVerificationStrict: async (_id: string, verification: any) => { storedSignal.verification = verification; },
		updateGateStatusStrict: async (_goalId: string, _gateId: string, status: string) => { storedGate.status = status; },
		updateSignalVerification: (_id: string, verification: any) => { storedSignal.verification = verification; },
		updateGateStatus: (_goalId: string, _gateId: string, status: string) => { storedGate.status = status; },
	};
	const frozenGate: WorkflowGate = {
		id: GATE_ID,
		name: "Frozen workflow context",
		dependsOn: [],
		verify: [{ name: "Error", type: "command", run: "echo unreachable", failureGuidance: "WORKFLOW_GUIDANCE_MUST_NOT_LEAK" }],
	};
	const projectContextManager = {
		getContextForGoal: () => ({ gateStore: store, goalStore: { get: () => ({ workflow: { gates: [frozenGate] } }) } }),
	};
	const notifications: string[] = [];
	const harness: any = new VerificationHarness(
		stateDir, store, () => {}, { get: () => undefined, getAll: () => [] } as any,
		undefined, undefined, undefined, undefined, projectContextManager as any,
	);
	harness.setTeamLeadNotifier((_goalId: string, message: string) => notifications.push(message));
	const gate: WorkflowGate = { ...frozenGate };
	const run = { ...storedSignal, verification: { status: "running" as const, steps: [] } };
	run.verification.steps = harness.beginVerification(run, gate);
	const active = harness.getActiveVerification(signalId);
	active.reviewerCleanupPending = true;
	expect(harness._persistActive()).toBe(true);
	harness.runCommandStep = async () => { throw new Error("STAGED_CATCH_PATH_ERROR"); };

	await harness.verifyGateSignal(run, gate, stateDir);

	expect(storedSignal.verification).toMatchObject({ status: "failed", steps: [{ name: "Error", status: "failed", output: "STAGED_CATCH_PATH_ERROR" }] });
	expect(notifications).toHaveLength(1);
	expect(notifications[0]).toContain("`Error`");
	expect(notifications[0], "STAGED_CATCH_PATH_ERROR: synthesized Error rows must not inherit frozen workflow guidance").not.toContain("WORKFLOW_GUIDANCE_MUST_NOT_LEAK");
});

test("restart keeps a late reviewer cleanup owner when complete lifecycle cancellation follows recovery", async () => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-complete-late-reviewer-owner-"));
	gateStore = new GateStore(stateDir, undefined, { persistence: "json" });
	gateStore.initGatesForGoal(GOAL_ID, [GATE_ID]);
	const signalId = `${SIGNAL_ID}-complete-late-reviewer`;
	const reviewerSessionId = `${signalId}-reviewer`;
	const run = { ...signal(), id: signalId, verification: { status: "running" as const, steps: [] } };
	gateStore.recordSignal(run);
	const projectContextManager = {
		getContextForGoal: () => ({ gateStore, goalStore: { get: () => ({ state: "complete" }) } }),
	};
	const seed: any = new VerificationHarness(
		stateDir, gateStore, () => {}, { get: () => undefined, getAll: () => [] } as any,
		undefined, undefined, undefined, undefined, projectContextManager as any,
	);
	seed.activeVerifications.set(signalId, {
		goalId: GOAL_ID, gateId: GATE_ID, signalId, overallStatus: "running", startedAt: 1,
		reviewerCleanupPending: true,
		steps: [{ name: "Late reviewer verdict", type: "llm-review", status: "passed", passed: true, output: "Late approval.", durationMs: 2, startedAt: 1, sessionId: reviewerSessionId }],
	});
	expect(seed._persistActive()).toBe(true);
	const terminated: string[] = [];
	const unregistered: string[] = [];
	const resumed: any = new VerificationHarness(
		stateDir, gateStore, () => {}, { get: () => undefined, getAll: () => [] } as any,
		undefined,
		{ terminateSession: async (id: string) => { terminated.push(id); } } as any,
		{ unregisterReviewerSession: async (_goalId: string, id: string) => { unregistered.push(id); } } as any,
		undefined, projectContextManager as any,
	);
	resumed._resumeOneVerification = async () => { throw new Error("COMPLETE_GOAL_MUST_NOT_RESUME_REVIEWER"); };

	await resumed.resumeInterruptedVerifications();

	expect(terminated, "COMPLETE_LIFECYCLE_LATE_REVIEWER: exact reviewer ownership remains cleanup-owned even after its late verdict").toEqual([reviewerSessionId]);
	expect(unregistered, "COMPLETE_LIFECYCLE_LATE_REVIEWER: terminal lifecycle cancellation must unregister the same reviewer identity").toEqual([reviewerSessionId]);
	expect(gateStore.getGate(GOAL_ID, GATE_ID)!.signals.find(entry => entry.id === signalId)?.verification?.status).toBe("cancelled");
});

test("scheduled cleanup continuation retains a live generation when rerun context is unavailable", async () => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-cleanup-continuation-context-"));
	const signalId = `${SIGNAL_ID}-cleanup-continuation`;
	const clock = createManualClock(70_000);
	const harness: any = new VerificationHarness(
		stateDir, {} as any, () => {}, { get: () => undefined, getAll: () => [] } as any,
		undefined, undefined, undefined, undefined, undefined, undefined, { clock },
	);
	const active: any = {
		goalId: GOAL_ID, gateId: GATE_ID, signalId, overallStatus: "running", startedAt: 1,
		steps: [{
			name: "Interrupted spawned command", type: "command", status: "running", startedAt: 1,
			commandSpawnState: "spawned", killRequestedAt: 2, killReason: "cancelled", killSignal: "SIGKILL",
		}],
	};
	harness.activeVerifications.set(signalId, active);
	expect(harness._persistActive()).toBe(true);
	harness._killPersistedCommandSteps = async () => {
		active.steps[0].killCompletedAt = 3;
		return true;
	};
	harness._killTrackedForSignal = async () => true;
	harness._gatherRerunContext = async () => null;
	harness._resumeOneVerification = async (candidate: any) => {
		// This is the real no-context continuation outcome: no terminal verdict
		// was published and this active owner still needs a deterministic retry.
		expect(await harness._continueResumeWithRemainingPhases(candidate)).toBe(false);
	};

	harness._scheduleCommandKillCleanupRetry(signalId);
	expect(clock.pending()).toBe(1);
	clock.advance(1_000);
	await Promise.resolve();

	expect(harness.getActiveVerification(signalId), "CLEANUP_CONTINUATION_CONTEXT: missing rerun context must retain the live durable owner instead of deleting it").toBe(active);
});
