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

const GOAL_ID = "verification-cancellation-outcome-goal";
const GATE_ID = "verification-cancellation-outcome-gate";
const SIGNAL_ID = "verification-cancellation-outcome-signal";
const COMPLETED_OUTPUT = "completed prerequisite output must survive cancellation";
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
		{ name: "Late failed restart result", type: "command", run: "exit 1", phase: 0 },
		{ name: "Late timeout restart result", type: "command", run: "sleep 1", phase: 1 },
	],
};

test("restart recovery keeps live passed evidence and neutralizes late failed or timeout rows — VERIFICATION_CANCELLATION_OUTCOME_AUDIT", async () => {
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

	// These are live/restart-resumed terminal observations. The durable signal
	// still contains only beginVerification's running/waiting seed rows.
	const active = (harness as any).activeVerifications.get(restartSignal.id);
	Object.assign(active.steps[0], {
		status: "passed",
		output: COMPLETED_OUTPUT,
		durationMs: 23,
	});
	Object.assign(active.steps[1], {
		status: "failed",
		output: "Step was interrupted by server restart before a verdict was durable.",
		durationMs: 29,
	});
	Object.assign(active.steps[2], {
		status: "timeout",
		output: "Verification timed out while resuming after server restart.",
		durationMs: 31,
	});

	// The restart interruption seam is deterministic: no timer, polling, or
	// temp-state inspection is needed to exercise the terminal publication.
	await (harness as any)._finalizeRestartInterruptedVerification(active);

	const verification = gateStore.getGate(GOAL_ID, GATE_ID)!.signals.find(entry => entry.id === restartSignal.id)!.verification as any;
	expect(verification).toMatchObject({
		status: "cancelled",
		cancellation: { cause: "gateway-restart-recovery", requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
		steps: [
			// A terminal status is authoritative even when an older active shape did
			// not carry the redundant boolean result field.
			{ name: "Completed before restart", status: "passed", passed: true, output: COMPLETED_OUTPUT, duration_ms: 23 },
			{ name: "Late failed restart result", status: "cancelled", passed: false, cancellation: { cause: "gateway-restart-recovery" } },
			{ name: "Late timeout restart result", status: "cancelled", passed: false, cancellation: { cause: "gateway-restart-recovery" } },
		],
	});
	expect(verification.steps.some((step: any) => step.status === "failed"),
		"VERIFICATION_CANCELLATION_OUTCOME_AUDIT: a cancelled restart verification cannot retain a failed product row").toBe(false);
	expect(events).toContainEqual(expect.objectContaining({
		type: "gate_verification_complete",
		signalId: restartSignal.id,
		status: "cancelled",
		cancellation: expect.objectContaining({ cause: "gateway-restart-recovery" }),
	}));
});
