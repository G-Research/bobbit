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
	// A parked human sign-off is live work with no process tree. It can be
	// cancelled only after its resolver is drained, making this fixture a valid
	// cleanup-free cancellation boundary for every orchestration producer.
	verify: [{ name: "Running sign-off", type: "human-signoff", prompt: "Awaiting cancellation" }],
};
const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeFixture(signalId: string, persistence: "json" | "sqlite" = "json") {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-cancellation-provenance-"));
	roots.push(stateDir);
	const gateStore = new GateStore(stateDir, undefined, { persistence });
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
	const active = (harness as any).activeVerifications.get(signal.id);
	active.steps[0].awaitingHuman = true;
	let signoffCancelled = false;
	harness.pendingSignoffs.set(`${signal.id}::Running sign-off`, (outcome: any) => {
		signoffCancelled = outcome.cancelled === true;
	});
	gateStore.recordSignal(signal);
	return { stateDir, gateStore, harness, signal, events, signoffCancelled: () => signoffCancelled };
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
	const { gateStore, signal, events, signoffCancelled } = await cancelForProducer(cause);
	const gate = gateStore.getGate(GOAL_ID, GATE_ID)!;
	const historical = gate.signals.find(entry => entry.id === signal.id)!;
	const verification = historical.verification as any;

	expect(verification, `CANCELLATION_CAUSE_${cause}: signal outcome is cancelled, not product failure`).toMatchObject({
		status: "cancelled",
		cancellation: { cause, requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
		steps: [expect.objectContaining({
			name: "Running sign-off",
			status: "cancelled",
			cancellation: { cause, requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
		})],
	});
	expect(signoffCancelled(), `CANCELLATION_CAUSE_${cause}: cancellation must drain the live human-signoff resolver before final publication`).toBe(true);
	expect(gate.status, `CANCELLATION_CAUSE_${cause}: orchestration cancellation leaves gate eligible to re-signal`).toBe("pending");
	expect(events.filter(event => event.type === "gate_verification_complete"), `CANCELLATION_CAUSE_${cause}: exactly one terminal transport event`).toEqual([
		expect.objectContaining({ signalId: signal.id, status: "cancelled", cancellation: expect.objectContaining({ cause }) }),
	]);
});

test("reset, bypass, and terminal lifecycle admission fences reject a generation until released", () => {
	const { harness, signal } = makeFixture("mutation-fence");
	const releaseGate = harness.acquireGateMutationFence(GOAL_ID, [GATE_ID]);
	expect(harness.isGateMutationFenced(GOAL_ID, GATE_ID)).toBe(true);
	expect(() => harness.beginVerification({ ...signal, id: "blocked-gate-generation" }, GATE)).toThrow(/reset or bypassed/i);
	releaseGate();

	const releaseGoal = harness.acquireGoalLifecycleFence(GOAL_ID);
	expect(harness.isGoalLifecycleFenced(GOAL_ID)).toBe(true);
	expect(harness.isSignalAdmissionFenced(GOAL_ID, GATE_ID)).toBe(true);
	expect(() => harness.beginVerification({ ...signal, id: "blocked-goal-generation" }, GATE)).toThrow(/completing, shelving, or archiving/i);
	releaseGoal();
	expect(harness.isSignalAdmissionFenced(GOAL_ID, GATE_ID)).toBe(false);
	expect(harness.beginVerification({ ...signal, id: "admitted-generation" }, GATE)).toHaveLength(1);
});

test("failed terminal fence rolls back in-memory cancellation so lifecycle requests can retry", () => {
	const { harness, signal } = makeFixture("terminal-fence-persistence-failure");
	const active = (harness as any).activeVerifications.get(signal.id) as ActiveVerification;
	const persist = (harness as any)._persistActive;
	(harness as any)._persistActive = () => false;
	try {
		expect(() => harness.fenceAndCancelAllVerifications(GOAL_ID, "archive")).toThrow(/persist cancellation fence/i);
	} finally {
		(harness as any)._persistActive = persist;
	}
	expect(active).toMatchObject({ overallStatus: "running" });
	expect(active.cancelled).toBeUndefined();
	expect(active.cancellation).toBeUndefined();
	expect(harness.getActiveVerification(signal.id)).toBe(active);
});

test("cancelled result coerces any residual live step to cancelled audit state", () => {
	const { harness, signal } = makeFixture("residual-live-step");
	const active = (harness as any).activeVerifications.get(signal.id) as ActiveVerification;
	// Model a crash/late callback that left a live status without the normal
	// cancellation stamp. Terminal cancelled history must still contain no live row.
	active.cancellation = { cause: "manual", requestedAt: Date.now() };
	active.steps[0].status = "running";
	delete active.steps[0].cancellation;
	const result = (harness as any)._cancelledVerificationResult(active);
	expect(result.steps[0]).toMatchObject({
		status: "cancelled",
		cancellation: { cause: "manual", finalizedAt: expect.any(Number) },
	});
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
	// JSON is intentionally a lightweight test adapter and does not run the
	// production persistence validator. Use the durable SQLite adapter, which
	// owns legacy-record normalization on write and reload.
	const { stateDir, gateStore, signal } = makeFixture("legacy-unknown", "sqlite");
	gateStore.updateSignalVerification(signal.id, {
		status: "cancelled",
		steps: [{ name: "Legacy cancelled", type: "command", passed: false, status: "cancelled", output: "Verification cancelled.", duration_ms: 0 }],
	} as any);
	await gateStore.close();

	const reloaded = new GateStore(stateDir, undefined, { persistence: "sqlite" });
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
		// Simulate a process crash after the old process marked reviewer teardown
		// pending but before it actually terminated the reviewer. Boot must clear
		// and re-drive this marker rather than strand cancellation forever.
		reviewerCleanupPending: true,
		steps: [
			{ name: "Completed evidence", type: "command", status: "passed", output: "retain this completed output", durationMs: 12, phase: 0, startedAt: Date.now() - 12 },
			// A running human-signoff is process-free live work. Its durable
			// cancellation requires no fabricated ownerless command cleanup.
			{ name: "Interrupted sign-off", type: "human-signoff", status: "running", phase: 1, startedAt: Date.now() - 10, awaitingHuman: true },
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
			{
				name: "Interrupted sign-off",
				status: "cancelled",
				cancellation: { cause: "goal-pause", requestedAt: expect.any(Number), finalizedAt: expect.any(Number) },
			},
		],
	});
	expect(gateStore.getGate(GOAL_ID, GATE_ID)!.status).toBe("pending");
});

test("only current-generation gateway restart recovery nudges the team lead once", async () => {
	const current = makeFixture("current-restart-recovery");
	const currentNotifications: string[] = [];
	current.harness.setTeamLeadNotifier((_goalId, message) => currentNotifications.push(message));
	await current.harness.cancelStaleVerifications(GOAL_ID, GATE_ID, "gateway-restart-recovery");
	expect(currentNotifications).toHaveLength(1);
	expect(currentNotifications[0]).toMatch(/did not fail.*re-signal/i);

	const zombie = makeFixture("zombie-recovery");
	const zombieNotifications: string[] = [];
	zombie.harness.setTeamLeadNotifier((_goalId, message) => zombieNotifications.push(message));
	await zombie.harness.cancelStaleVerifications(GOAL_ID, GATE_ID, "zombie-recovery");
	expect(zombieNotifications, "zombie recovery is created by a replacement request and must not nudge").toHaveLength(0);

	const historical = makeFixture("historical-restart-recovery");
	const historicalNotifications: string[] = [];
	historical.harness.setTeamLeadNotifier((_goalId, message) => historicalNotifications.push(message));
	historical.gateStore.recordSignal({
		...historical.signal,
		id: "newer-generation",
		timestamp: historical.signal.timestamp + 1,
		verification: { status: "running", steps: [] },
	});
	await historical.harness.cancelStaleVerifications(GOAL_ID, GATE_ID, "gateway-restart-recovery");
	expect(historicalNotifications, "historical recovery must not nudge after a newer signal exists").toHaveLength(0);
});
