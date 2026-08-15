// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
/**
 * Durable orchestration-cancellation contract. These cases deliberately drive
 * the harness through its public cancellation boundary rather than equating a
 * process kill with a product failure.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import { VerificationHarness, type ActiveVerification } from "../../src/server/agent/verification-harness.js";
import type { WorkflowGate } from "../../src/server/agent/workflow-store.js";

const GOAL_ID = "cancellation-provenance-goal";
const GATE_ID = "cancellation-provenance-gate";
const ROLE_STORE = Object.freeze({ get: () => undefined, getAll: () => [] });
const CAUSES = [
	"manual",
	"goal-pause",
	"superseded",
	"gate-reset",
	"bypass",
	"goal-complete",
	"team-teardown",
	"shelved",
	"archive",
	"zombie-recovery",
	"gateway-restart-recovery",
] as const;
type CancellationCause = typeof CAUSES[number];

const GATE: WorkflowGate = {
	id: GATE_ID,
	name: "Cancellation provenance fixture",
	dependsOn: [],
	verify: [{ name: "Long running command", type: "command", run: "echo fixture" }],
};
const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeFixture(signalId: string) {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-cancellation-provenance-"));
	roots.push(stateDir);
	const gateStore = new GateStore(stateDir, undefined, { persistence: "json" });
	gateStore.initGatesForGoal(GOAL_ID, [GATE_ID]);
	const events: any[] = [];
	const harness = new VerificationHarness(stateDir, gateStore, (_goalId, event) => events.push(event), ROLE_STORE as any);
	const signal: GateSignal = {
		id: signalId,
		goalId: GOAL_ID,
		gateId: GATE_ID,
		sessionId: "cancellation-provenance-owner",
		timestamp: Date.now(),
		commitSha: "0123456789abcdef0123456789abcdef01234567",
		content: "Cancellation provenance fixture",
		contentVersion: 1,
		verification: { status: "running", steps: [] },
	};
	signal.verification.steps = harness.beginVerification(signal, GATE);
	gateStore.recordSignal(signal);
	return { stateDir, gateStore, harness, signal, events };
}

async function cancelForProducer(cause: CancellationCause) {
	const fixture = makeFixture(`producer-${cause}`);
	// The third argument is intentionally the producer-owned orchestration
	// cause. It is not a command kill reason and must be accepted by every
	// caller (manual endpoint, pause/reset/bypass lifecycle routes, teardown,
	// shelf/archive, zombie recovery, and restart recovery).
	await (fixture.harness as any).cancelStaleVerifications(GOAL_ID, GATE_ID, cause);
	return fixture;
}

test.each(CAUSES)("%s is durable, typed, and never becomes a failed gate", async (cause) => {
	const { gateStore, signal, events } = await cancelForProducer(cause);
	const gate = gateStore.getGate(GOAL_ID, GATE_ID)!;
	const historical = gate.signals.find(entry => entry.id === signal.id)!;
	const verification = historical.verification as any;

	expect(verification, `CANCELLATION_CAUSE_${cause}: signal outcome is cancelled, not product failure`).toMatchObject({
		status: "cancelled",
		cancellation: { cause, requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
		steps: [expect.objectContaining({
			name: "Long running command",
			status: "cancelled",
			cancellation: { cause, requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
		})],
	});
	expect(gate.status, `CANCELLATION_CAUSE_${cause}: orchestration cancellation leaves gate eligible to re-signal`).toBe("pending");
	expect(events.filter(event => event.type === "gate_verification_complete"), `CANCELLATION_CAUSE_${cause}: exactly one terminal transport event`).toEqual([
		expect.objectContaining({ signalId: signal.id, status: "cancelled", cancellation: expect.objectContaining({ cause }) }),
	]);
});

test("first cancellation writer is persisted before cleanup and cannot be overwritten by a later lifecycle event", () => {
	const { stateDir, harness, signal } = makeFixture("first-writer-wins");
	const active = (harness as any).activeVerifications.get(signal.id) as ActiveVerification;

	(harness as any)._markVerificationCancelled(active, "manual");
	(harness as any)._persistActive();
	const beforeCleanup = JSON.parse(fs.readFileSync(path.join(stateDir, "active-verifications.json"), "utf8"));
	expect(beforeCleanup.verifications[0].cancellation,
		"CANCELLATION_FIRST_WRITER_WINS: durable intent must exist before asynchronous cleanup").toMatchObject({
		cause: "manual", requestedAt: expect.any(Number),
	});

	(harness as any)._markVerificationCancelled(active, "goal-pause");
	expect((active as any).cancellation,
		"CANCELLATION_FIRST_WRITER_WINS: delayed pause/reset/recovery must not replace manual provenance").toMatchObject({ cause: "manual" });
});

test("legacy generic cancelled rows deserialize as unknown without inventing a historical cause", async () => {
	const { stateDir, gateStore, signal } = makeFixture("legacy-unknown");
	gateStore.updateSignalVerification(signal.id, {
		status: "cancelled",
		steps: [{ name: "Legacy cancelled", type: "command", passed: false, status: "cancelled", output: "Verification cancelled.", duration_ms: 0 }],
	} as any);
	await gateStore.close();

	const reloaded = new GateStore(stateDir, undefined, { persistence: "json" });
	const legacy = reloaded.getGate(GOAL_ID, GATE_ID)!.signals.find(entry => entry.id === signal.id)!.verification as any;
	expect(legacy.cancellation,
		"CANCELLATION_LEGACY_UNKNOWN: old records must remain readable but must never be guessed from generic kill text").toMatchObject({ cause: "unknown" });
	expect(legacy.cancellation).not.toMatchObject({ cause: "manual" });
	await reloaded.close();
});

test("restart preserves an already completed output and the persisted cause until exact cleanup finalizes", async () => {
	const { stateDir, gateStore, signal } = makeFixture("restart-preserves-audit");
	gateStore.updateSignalVerification(signal.id, {
		status: "running",
		steps: [
			{ name: "Completed evidence", type: "command", passed: true, status: "passed", output: "retain this completed output", duration_ms: 12, phase: 0 },
			{ name: "Interrupted command", type: "command", passed: false, status: "running", output: "", duration_ms: 0, phase: 1 },
		],
	} as any);
	const persisted: ActiveVerification = {
		goalId: GOAL_ID,
		gateId: GATE_ID,
		signalId: signal.id,
		overallStatus: "cancelled",
		cancelled: true,
		startedAt: Date.now() - 12,
		cancelRequestedAt: Date.now() - 10,
		cancelReason: "cancelled",
		steps: [
			{ name: "Completed evidence", type: "command", status: "passed", output: "retain this completed output", durationMs: 12, phase: 0, startedAt: Date.now() - 12 },
			{ name: "Interrupted command", type: "command", status: "running", phase: 1, startedAt: Date.now() - 10 },
		],
	};
	(persisted as any).cancellation = { cause: "goal-pause", requestedAt: Date.now() - 10 };
	fs.writeFileSync(path.join(stateDir, "active-verifications.json"), JSON.stringify({ verifications: [persisted] }));

	const resumed = new VerificationHarness(stateDir, gateStore, () => {}, ROLE_STORE as any);
	await resumed.resumeInterruptedVerifications();
	const verification = gateStore.getGate(GOAL_ID, GATE_ID)!.signals.find(entry => entry.id === signal.id)!.verification as any;
	expect(verification, "CANCELLATION_RESTART_AUDIT: restart must preserve cause and real evidence instead of fabricating Cancelled").toMatchObject({
		status: "cancelled",
		cancellation: { cause: "goal-pause", requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
		steps: [
			{ name: "Completed evidence", status: "passed", output: "retain this completed output" },
			{ name: "Interrupted command", status: "cancelled", cancellation: { cause: "goal-pause" } },
		],
	});
	expect(gateStore.getGate(GOAL_ID, GATE_ID)!.status).toBe("pending");
});
