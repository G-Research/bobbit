// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
/**
 * Durable orchestration-cancellation contract. These cases deliberately drive
 * the harness through its public cancellation boundary rather than equating a
 * process kill with a product failure.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

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
const gateStores: GateStore[] = [];

afterEach(async () => {
	// GateStore's JSON writer coalesces non-strict state writes. Drain every
	// fixture-owned writer before deleting its root so a retry cannot attempt a
	// late rename into an already-removed directory.
	await Promise.all(gateStores.splice(0).map(store => store.close()));
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeFixture(
	signalId: string,
	persistence: "json" | "sqlite" = "json",
	goal?: { state: "todo" | "in-progress" | "complete" | "shelved" | "blocked"; archived?: boolean },
	cleanupManagers: { sessionManager?: any; teamManager?: any; clock?: any } = {},
) {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-cancellation-provenance-"));
	roots.push(stateDir);
	const gateStore = new GateStore(stateDir, undefined, { persistence });
	gateStores.push(gateStore);
	gateStore.initGatesForGoal(GOAL_ID, [GATE_ID]);
	const events: any[] = [];
	const projectContextManager = goal ? {
		getContextForGoal: (goalId: string) => goalId === GOAL_ID ? { gateStore, goalStore: { get: () => goal } } : undefined,
	} : undefined;
	const harness = new VerificationHarness(
		stateDir, gateStore, (_goalId, event) => events.push(event), ROLE_STORE as any,
		undefined, cleanupManagers.sessionManager, cleanupManagers.teamManager, undefined, projectContextManager as any,
		undefined, cleanupManagers.clock ? { clock: cleanupManagers.clock } : undefined,
	);
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

/** A deterministic clock keeps cleanup-retry timers inert until this test drives the retry itself. */
function makeManualClock() {
	let nextId = 0;
	const timers = new Map<number, () => void>();
	return {
		now: () => 1_700_000_000_000,
		setTimeout: (handler: () => void) => {
			const id = ++nextId;
			timers.set(id, handler);
			return id as any;
		},
		clearTimeout: (id: number) => timers.delete(id),
		setInterval: () => 0 as any,
		clearInterval: () => {},
	};
}

function makeReviewerCleanupFixture(
	signalId: string,
	cleanupManagers: { sessionManager: any; teamManager: any; clock: any },
) {
	const fixture = makeFixture(signalId, "json", undefined, cleanupManagers);
	const active = (fixture.harness as any).activeVerifications.get(signalId) as ActiveVerification;
	const reviewerSessionId = `${signalId}-reviewer-session`;
	Object.assign(active.steps[0], {
		type: "llm-review",
		status: "running",
		sessionId: reviewerSessionId,
		output: "Reviewer still owns an active session.",
		startedAt: 1_700_000_000_000,
	});
	fixture.gateStore.updateSignalVerification(signalId, {
		status: "running",
		steps: [{
			name: "Running sign-off",
			type: "llm-review",
			passed: false,
			status: "running",
			phase: 0,
			output: "Reviewer still owns an active session.",
			duration_ms: 0,
		}],
	} as any);
	return { ...fixture, active, reviewerSessionId };
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

test("failed supersession fence restores state without interrupting verifier waiters, signoffs, or cleanup", () => {
	const { harness, signal, signoffCancelled } = makeFixture("terminal-fence-persistence-failure");
	const active = (harness as any).activeVerifications.get(signal.id) as ActiveVerification;
	const steps = active.steps;
	const runningStep = active.steps[0]!;
	const waiter = vi.fn();
	const cleanup = vi.spyOn(harness as any, "_startCancelledVerificationCleanup");
	(harness as any).verifierDispatchCancellationWaiters.set(signal.id, new Set([waiter]));
	const persist = (harness as any)._persistActive;
	(harness as any)._persistActive = () => false;
	try {
		expect(() => (harness as any).fenceStaleVerificationsForGates(GOAL_ID, [GATE_ID], "superseded"))
			.toThrow(/persist cancellation fence/i);
	} finally {
		(harness as any)._persistActive = persist;
	}
	expect(active).toMatchObject({ overallStatus: "running" });
	expect(active.cancelled).toBeUndefined();
	expect(active.cancellation).toBeUndefined();
	expect(active.steps, "FAILED_SUPERSESSION_FENCE_MUST_RETAIN_THE_LIVE_STEP_ARRAY").toBe(steps);
	expect(active.steps[0], "FAILED_SUPERSESSION_FENCE_MUST_RETAIN_IN_FLIGHT_STEP_IDENTITY").toBe(runningStep);
	expect(active.steps[0]?.cancellation, "FAILED_SUPERSESSION_FENCE_MUST_RESTORE_STEP_INTERRUPTION_INTENT").toBeUndefined();
	expect(waiter, "FAILED_SUPERSESSION_FENCE_MUST_NOT_RESOLVE_VERIFIER_ADMISSION_WAITERS").not.toHaveBeenCalled();
	expect(signoffCancelled(), "FAILED_SUPERSESSION_FENCE_MUST_NOT_DRAIN_HUMAN_SIGNOFFS").toBe(false);
	expect((harness as any).pendingSignoffs.has(`${signal.id}::Running sign-off`),
		"FAILED_SUPERSESSION_FENCE_MUST_RETAIN_LIVE_HUMAN_SIGNOFF").toBe(true);
	expect(cleanup, "FAILED_SUPERSESSION_FENCE_MUST_NOT_START_BACKGROUND_CLEANUP").not.toHaveBeenCalled();
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

test("a cleanup-settled finalizer retry publishes after an earlier cleanup-pending no-op", async () => {
	const { gateStore, harness, signal } = makeFixture("finalizer-cleanup-race");
	const active = (harness as any).activeVerifications.get(signal.id) as ActiveVerification;
	const requestedAt = 1_700_000_000_000;
	const cleanupCompletedAt = requestedAt + 1;

	active.cancelled = true;
	active.overallStatus = "cancelled";
	active.cancellation = { cause: "manual", requestedAt };
	Object.assign(active.steps[0], {
		type: "command",
		status: "running",
		commandSpawnState: "spawned",
		killRequestedAt: requestedAt,
		killReason: "cancelled",
		cancellation: { cause: "manual", requestedAt },
	});
	// Prove that finalization resets an otherwise eligible current gate, rather
	// than merely observing the fixture's initial pending state.
	gateStore.updateGateStatus(GOAL_ID, GATE_ID, "passed");

	// The first call must be a no-op while exact command cleanup is durable but
	// unsettled. Do not yield: this leaves its returned async wrapper in flight,
	// reproducing the duplicate-finalizer ownership race deterministically.
	const cleanupPendingFinalizer = (harness as any)._finalizeCancelledVerification(active);
	(active.steps[0] as any).killCompletedAt = cleanupCompletedAt;
	const cleanupSettledFinalizer = (harness as any)._finalizeCancelledVerification(active);
	await Promise.all([cleanupPendingFinalizer, cleanupSettledFinalizer]);

	const verification = gateStore.getGate(GOAL_ID, GATE_ID)!.signals.find(entry => entry.id === signal.id)!.verification as any;
	expect(verification, "CLEANUP_SETTLED_FINALIZER_RETRY: terminal publication must not share a prior no-op promise").toMatchObject({
		status: "cancelled",
		cancellation: { cause: "manual", requestedAt, finalizedAt: expect.any(Number) },
	});
	expect(gateStore.getGate(GOAL_ID, GATE_ID)!.status,
		"CLEANUP_SETTLED_FINALIZER_RETRY: a cancelled eligible gate must be re-signalable").toBe("pending");
	expect(harness.getActiveVerification(signal.id),
		"CLEANUP_SETTLED_FINALIZER_RETRY: terminal publication must retire its active owner").toBeUndefined();
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
	// SQLite owns persisted legacy-record normalization on reload.
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

test.each([
	["completed", { state: "complete" as const }],
	["shelved", { state: "shelved" as const }],
	["archived", { state: "in-progress" as const, archived: true }],
])("legacy unknown cancellation preserves a terminal %s goal gate status", async (_terminal, goal) => {
	const { gateStore, harness, signal } = makeFixture(`legacy-terminal-${_terminal}`, "json", goal);
	gateStore.updateGateStatus(GOAL_ID, GATE_ID, "passed");

	const active = (harness as any).activeVerifications.get(signal.id) as ActiveVerification;
	active.cancelled = true;
	active.overallStatus = "cancelled";
	active.cancellation = { cause: "unknown", requestedAt: Date.now() };
	active.steps[0].cancellation = { ...active.cancellation };
	await (harness as any)._finalizeCancelledVerification(active);

	const verification = gateStore.getGate(GOAL_ID, GATE_ID)!.signals.find(entry => entry.id === signal.id)!.verification as any;
	expect(verification.cancellation).toMatchObject({ cause: "unknown" });
	expect(gateStore.getGate(GOAL_ID, GATE_ID)!.status).toBe("passed");
});

test("legacy unknown cancellation keeps a live eligible goal pending", async () => {
	const { gateStore, harness, signal } = makeFixture("legacy-live", "json", { state: "in-progress" });
	gateStore.updateGateStatus(GOAL_ID, GATE_ID, "passed");
	const active = (harness as any).activeVerifications.get(signal.id) as ActiveVerification;
	active.cancelled = true;
	active.overallStatus = "cancelled";
	active.cancellation = { cause: "unknown", requestedAt: Date.now() };
	active.steps[0].cancellation = { ...active.cancellation };

	await (harness as any)._finalizeCancelledVerification(active);

	expect(gateStore.getGate(GOAL_ID, GATE_ID)!.status).toBe("pending");
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

test("reviewer cleanup failure stays durable and blocks cancellation publication until its idempotent retry settles", async () => {
	const clock = makeManualClock();
	const terminated: string[] = [];
	const unregistered: string[] = [];
	let terminateAttempts = 0;
	const sessionManager = {
		terminateSession: async (sessionId: string) => {
			terminated.push(sessionId);
			if (++terminateAttempts === 1) throw new Error("REVIEWER_CLEANUP_TERMINATE_ONCE");
		},
	};
	const teamManager = {
		unregisterReviewerSession: async (goalId: string, sessionId: string) => {
			expect(goalId).toBe(GOAL_ID);
			unregistered.push(sessionId);
		},
	};
	const fixture = makeReviewerCleanupFixture("reviewer-cleanup-retry", { sessionManager, teamManager, clock });

	await (fixture.harness as any).cancelStaleVerifications(GOAL_ID, GATE_ID, "manual");

	const pending = (fixture.harness as any).activeVerifications.get(fixture.signal.id) as ActiveVerification;
	expect(pending, "REVIEWER_CLEANUP_FAILURE_MUST_KEEP_EXACT_OWNER: a swallowed terminate failure must not retire its active row").toMatchObject({
		cancelled: true,
		overallStatus: "cancelled",
		reviewerCleanupPending: true,
		cancellation: { cause: "manual", requestedAt: expect.any(Number) },
		steps: [expect.objectContaining({ sessionId: fixture.reviewerSessionId, status: "running" })],
	});
	const durablePending = (fixture.harness as any)._loadActive()
		.find((verification: ActiveVerification) => verification.signalId === fixture.signal.id)!;
	expect(durablePending).toMatchObject({
		signalId: fixture.signal.id,
		reviewerCleanupPending: true,
		cancellation: expect.objectContaining({ cause: "manual" }),
		steps: [expect.objectContaining({ sessionId: fixture.reviewerSessionId })],
	});
	expect(fixture.gateStore.getGate(GOAL_ID, GATE_ID)!.signals.find(signal => signal.id === fixture.signal.id)!.verification?.status,
		"REVIEWER_CLEANUP_FAILURE_MUST_NOT_PUBLISH_CANCELLED_EARLY").toBe("running");
	expect(fixture.events.filter(event => event.type === "gate_verification_complete"),
		"REVIEWER_CLEANUP_FAILURE_MUST_NOT_EMIT_TERMINAL_EVENT_EARLY").toHaveLength(0);

	// A late reviewer result can make the live row terminal after cancellation
	// was fenced. reviewerCleanupPending still owns the exact persisted session
	// cleanup; retry must not lose that owner by filtering only running rows.
	Object.assign(pending.steps[0], { status: "passed", passed: true, output: "Late reviewer callback." });
	(fixture.harness as any)._persistActive();
	const durableLateCallback = (fixture.harness as any)._loadActive()
		.find((verification: ActiveVerification) => verification.signalId === fixture.signal.id)!;
	expect(durableLateCallback).toMatchObject({
		reviewerCleanupPending: true,
		steps: [expect.objectContaining({ sessionId: fixture.reviewerSessionId, status: "passed" })],
	});

	// A test-owned direct re-drive replaces timer sleeps/polling and proves that
	// retrying the same exact reviewer ownership can settle safely.
	await (fixture.harness as any)._startCancelledVerificationCleanup(pending);

	const historical = fixture.gateStore.getGate(GOAL_ID, GATE_ID)!.signals.find(signal => signal.id === fixture.signal.id)!;
	expect(terminated, "REVIEWER_CLEANUP_RETRY_MUST_TERMINATE_THE_SAME_SESSION").toEqual([fixture.reviewerSessionId, fixture.reviewerSessionId]);
	expect(unregistered, "REVIEWER_CLEANUP_RETRY_MUST_UNREGISTER_THE_SAME_SESSION").toEqual([fixture.reviewerSessionId, fixture.reviewerSessionId]);
	expect(historical.verification).toMatchObject({ status: "cancelled", cancellation: { cause: "manual" } });
	expect(fixture.gateStore.getGate(GOAL_ID, GATE_ID)!.status).toBe("pending");
	expect(fixture.harness.getActiveVerification(fixture.signal.id)).toBeUndefined();
	expect(fixture.events.filter(event => event.type === "gate_verification_complete")).toEqual([
		expect.objectContaining({ signalId: fixture.signal.id, status: "cancelled", cancellation: expect.objectContaining({ cause: "manual" }) }),
	]);
});

test("restart re-drives persisted reviewer cleanup failure without losing the exact session owner or publishing early", async () => {
	const clock = makeManualClock();
	const reviewerSessionId = "restart-reviewer-owner";
	const firstTerminations: string[] = [];
	const firstUnregistrations: string[] = [];
	const initial = makeReviewerCleanupFixture("restart-reviewer-cleanup", {
		clock,
		sessionManager: { terminateSession: async (sessionId: string) => { firstTerminations.push(sessionId); throw new Error("RESTART_REVIEWER_TERMINATE_ONCE"); } },
		teamManager: { unregisterReviewerSession: async (_goalId: string, sessionId: string) => { firstUnregistrations.push(sessionId); } },
	});
	Object.assign(initial.active, {
		cancelled: true,
		overallStatus: "cancelled",
		reviewerCleanupPending: true,
		cancellation: { cause: "goal-pause", requestedAt: 1_700_000_000_000 },
	});
	Object.assign(initial.active.steps[0], { sessionId: reviewerSessionId, cancellation: { cause: "goal-pause", requestedAt: 1_700_000_000_000 } });
	(initial.harness as any)._persistActive();

	const failedEvents: any[] = [];
	const failedRecovery = new VerificationHarness(
		initial.stateDir, initial.gateStore, (_goalId, event) => failedEvents.push(event), ROLE_STORE as any,
		undefined,
		{ terminateSession: async (sessionId: string) => { firstTerminations.push(sessionId); throw new Error("RESTART_REVIEWER_TERMINATE_ONCE"); } } as any,
		{ unregisterReviewerSession: async (_goalId: string, sessionId: string) => { firstUnregistrations.push(sessionId); } } as any,
		undefined, undefined, undefined, { clock: makeManualClock() as any },
	);
	await failedRecovery.resumeInterruptedVerifications();

	const retained = (failedRecovery as any).activeVerifications.get(initial.signal.id) as ActiveVerification;
	expect(retained, "RESTART_REVIEWER_CLEANUP_FAILURE_MUST_RETAIN_ACTIVE_ROW").toMatchObject({
		cancelled: true,
		reviewerCleanupPending: true,
		cancellation: { cause: "goal-pause" },
		steps: [expect.objectContaining({ sessionId: reviewerSessionId })],
	});
	const durableRetained = (failedRecovery as any)._loadActive()
		.find((verification: ActiveVerification) => verification.signalId === initial.signal.id)!;
	expect(durableRetained).toMatchObject({
		reviewerCleanupPending: true,
		cancellation: { cause: "goal-pause" },
		steps: [expect.objectContaining({ sessionId: reviewerSessionId })],
	});
	expect(initial.gateStore.getGate(GOAL_ID, GATE_ID)!.signals.find(signal => signal.id === initial.signal.id)!.verification?.status).toBe("running");
	expect(failedEvents.filter(event => event.type === "gate_verification_complete")).toHaveLength(0);

	const recoveredEvents: any[] = [];
	const finalTerminations: string[] = [];
	const finalUnregistrations: string[] = [];
	const successfulRecovery = new VerificationHarness(
		initial.stateDir, initial.gateStore, (_goalId, event) => recoveredEvents.push(event), ROLE_STORE as any,
		undefined,
		{ terminateSession: async (sessionId: string) => { finalTerminations.push(sessionId); } } as any,
		{ unregisterReviewerSession: async (_goalId: string, sessionId: string) => { finalUnregistrations.push(sessionId); } } as any,
		undefined, undefined, undefined, { clock: makeManualClock() as any },
	);
	await successfulRecovery.resumeInterruptedVerifications();

	expect(firstTerminations).toEqual([reviewerSessionId]);
	expect(firstUnregistrations).toEqual([reviewerSessionId]);
	expect(finalTerminations, "RESTART_REVIEWER_CLEANUP_RETRY_MUST_TERMINATE_PERSISTED_SESSION").toEqual([reviewerSessionId]);
	expect(finalUnregistrations, "RESTART_REVIEWER_CLEANUP_RETRY_MUST_UNREGISTER_PERSISTED_SESSION").toEqual([reviewerSessionId]);
	expect(initial.gateStore.getGate(GOAL_ID, GATE_ID)!.signals.find(signal => signal.id === initial.signal.id)!.verification).toMatchObject({
		status: "cancelled",
		cancellation: { cause: "goal-pause" },
	});
	expect(initial.gateStore.getGate(GOAL_ID, GATE_ID)!.status).toBe("pending");
	expect(successfulRecovery.getActiveVerification(initial.signal.id)).toBeUndefined();
	expect(recoveredEvents.filter(event => event.type === "gate_verification_complete")).toEqual([
		expect.objectContaining({ signalId: initial.signal.id, status: "cancelled", cancellation: expect.objectContaining({ cause: "goal-pause" }) }),
	]);
});
