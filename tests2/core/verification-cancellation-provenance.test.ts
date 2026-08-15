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
import { createManualClock } from "../harness/clock.js";
import { FakePinnedCheckoutManager, pinnedCheckoutReference } from "../harness/fake-pinned-checkout-manager.js";

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
		undefined, undefined, undefined, undefined, projectContextManager as any,
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

function makeExactResourceFixture(signalId: string, cause: CancellationCause | "gateway-restart-recovery" = "gateway-restart-recovery") {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-cancellation-resource-barrier-"));
	roots.push(stateDir);
	const clock = createManualClock(1_700_000_000_000);
	const gateStore = new GateStore(stateDir, undefined, { persistence: "json" });
	gateStores.push(gateStore);
	gateStore.initGatesForGoal(GOAL_ID, [GATE_ID]);
	const signal: GateSignal = {
		id: signalId, goalId: GOAL_ID, gateId: GATE_ID, sessionId: "resource-owner", timestamp: clock.now(),
		commitSha: "0123456789abcdef0123456789abcdef01234567", content: "exact resource barrier", contentVersion: 1,
		verification: { status: "running", steps: [{ name: "Completed command", type: "command", passed: true, status: "passed", phase: 0, output: "command cleanup already settled", duration_ms: 10 }] },
	};
	gateStore.recordSignal(signal);
	const checkoutManager = new FakePinnedCheckoutManager(path.join(stateDir, "checkouts"));
	const checkout = checkoutManager.seed(signalId, stateDir, "resource-project");
	const order: string[] = [];
	let sidecarAttempts = 0;
	let releaseAttempts = 0;
	const sandbox = {
		removeVerificationSidecar: async () => {
			order.push(`sidecar:${++sidecarAttempts}`);
			if (sidecarAttempts === 1) throw new Error("sidecar deliberately unavailable once");
		},
	};
	const originalRelease = checkoutManager.release.bind(checkoutManager);
	checkoutManager.release = async (id, projectId) => {
		order.push(`checkout:${++releaseAttempts}`);
		if (releaseAttempts === 1) throw new Error("checkout deliberately unavailable once");
		await originalRelease(id, projectId);
	};
	const events: any[] = [];
	const harness = new VerificationHarness(
		stateDir, gateStore, (_goalId, event) => events.push(event), ROLE_STORE as any,
		undefined,
		{ getSandboxManager: () => ({ get: () => sandbox }) } as any,
		undefined, undefined, undefined, undefined,
		{ clock, pinnedCheckoutManager: checkoutManager as any },
	) as any;
	const active: ActiveVerification = {
		goalId: GOAL_ID, gateId: GATE_ID, signalId, projectId: "resource-project",
		overallStatus: "cancelled", cancelled: true, startedAt: clock.now() - 10,
		cancellation: { cause, requestedAt: clock.now() - 5 },
		pinnedCheckout: pinnedCheckoutReference(checkout),
		verificationContainer: { version: 1, projectId: "resource-project", signalId, containerId: "exact-sidecar", cwd: "/frozen", ignoredOutputDirs: [] },
		steps: [{ name: "Completed command", type: "command", status: "passed", phase: 0, startedAt: clock.now() - 10, output: "command cleanup already settled", durationMs: 10, passed: true }],
	};
	harness.activeVerifications.set(signalId, active);
	harness._persistActive();
	const notifications: string[] = [];
	harness.setTeamLeadNotifier((_goalId: string, message: string) => notifications.push(message));
	return { clock, gateStore, harness, active, events, notifications, order, checkoutManager };
}

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

test("exact sidecar and checkout retries suppress terminal cancellation publication until both settle", async () => {
	const fixture = makeExactResourceFixture("exact-resource-retry");
	const strict = vi.spyOn(fixture.gateStore, "updateSignalVerificationStrict");
	const gateStatus = vi.spyOn(fixture.gateStore, "updateGateStatusStrict");
	const finalizer = vi.spyOn(fixture.harness, "_finalizeCancelledVerification");

	await fixture.harness._finalizeCancelledVerification(fixture.active);
	expect(fixture.order).toEqual(["sidecar:1"]);
	expect(strict, "EXACT_RESOURCE_BARRIER_MUST_NOT_STRICTLY_UPDATE_SIGNAL_BEFORE_SIDECAR_SETTLES").not.toHaveBeenCalled();
	expect(gateStatus, "EXACT_RESOURCE_BARRIER_MUST_NOT_MARK_GATE_PENDING_EARLY").not.toHaveBeenCalled();
	expect(fixture.events, "EXACT_RESOURCE_BARRIER_MUST_NOT_PUBLISH_WS_COMPLETION_EARLY").toEqual([]);
	expect(fixture.notifications, "EXACT_RESOURCE_BARRIER_MUST_NOT_NOTIFY_EARLY").toEqual([]);
	expect(fixture.harness.activeVerifications.get(fixture.active.signalId),
		"EXACT_RESOURCE_BARRIER_MUST_RETAIN_OWNER_AFTER_SIDECAR_FAILURE").toBe(fixture.active);

	finalizer.mockClear();
	fixture.clock.advance(1_000);
	// The manual clock has no timer promise. Await the exact finalizer dispatched
	// by its retry, rather than assuming a fixed number of event-loop turns.
	await Promise.all(finalizer.mock.results.map(result => result.value));
	expect(finalizer).toHaveBeenCalledTimes(1);
	expect(fixture.order).toEqual(["sidecar:1", "sidecar:2", "checkout:1"]);
	expect(strict, "EXACT_RESOURCE_BARRIER_MUST_NOT_STRICTLY_UPDATE_SIGNAL_BEFORE_CHECKOUT_RELEASE").not.toHaveBeenCalled();
	expect(gateStatus).not.toHaveBeenCalled();
	expect(fixture.events).toEqual([]);
	expect(fixture.notifications).toEqual([]);
	expect(fixture.harness.activeVerifications.get(fixture.active.signalId),
		"EXACT_RESOURCE_BARRIER_MUST_RETAIN_OWNER_AFTER_CHECKOUT_FAILURE").toBe(fixture.active);

	finalizer.mockClear();
	fixture.clock.advance(2_000);
	await Promise.all(finalizer.mock.results.map(result => result.value));
	expect(finalizer).toHaveBeenCalledTimes(1);
	expect(fixture.order, "SIDECAR_MUST_FINISH_BEFORE_EACH_CHECKOUT_RELEASE_ATTEMPT").toEqual([
		"sidecar:1", "sidecar:2", "checkout:1", "checkout:2",
	]);
	expect(strict, "EXACT_RESOURCE_BARRIER_MUST_STRICTLY_PUBLISH_ONCE_AFTER_ALL_RESOURCES_SETTLE").toHaveBeenCalledTimes(1);
	expect(gateStatus, "EXACT_RESOURCE_BARRIER_MUST_MARK_CURRENT_GATE_PENDING_ONCE").toHaveBeenCalledTimes(1);
	expect(fixture.events.filter(event => event.type === "gate_verification_complete"),
		"EXACT_RESOURCE_BARRIER_MUST_EMIT_ONE_WS_COMPLETION_AFTER_SETTLEMENT").toEqual([
			expect.objectContaining({ signalId: fixture.active.signalId, status: "cancelled", cancellation: { cause: "gateway-restart-recovery", requestedAt: expect.any(Number), finalizedAt: expect.any(Number) } }),
		]);
	expect(fixture.notifications, "EXACT_RESOURCE_BARRIER_MUST_NOTIFY_ONLY_AFTER_DURABLE_PUBLICATION").toHaveLength(1);
	expect(fixture.checkoutManager.releasedSignalIds, "EXACT_RESOURCE_BARRIER_MUST_RELEASE_THE_EXACT_CHECKOUT_ONCE").toEqual([fixture.active.signalId]);
	expect(fixture.harness.activeVerifications.has(fixture.active.signalId),
		"EXACT_RESOURCE_BARRIER_MUST_REMOVE_OWNER_ONLY_AFTER_PUBLICATION_AND_RELEASE").toBe(false);
});

test("release-owner finalization does not self-join and concurrent cancellation callers settle", async () => {
	const fixture = makeExactResourceFixture("release-owner-reentrancy", "manual");
	(fixture.harness as any).sessionManager.getSandboxManager().get().removeVerificationSidecar = async () => {
		fixture.order.push("sidecar:reentrant");
	};
	fixture.checkoutManager.release = async (signalId, projectId) => {
		fixture.order.push("checkout:reentrant");
		await FakePinnedCheckoutManager.prototype.release.call(fixture.checkoutManager, signalId, projectId);
	};

	const outerRelease = (fixture.harness as any)._releaseTerminalVerificationResources(fixture.active);
	const secondCancellation = fixture.harness.cancelAllVerifications(GOAL_ID, "manual");
	await expect(Promise.all([outerRelease, secondCancellation])).resolves.toHaveLength(2);
	expect((fixture.harness as any)._terminalCleanupPromises.size,
		"RELEASE_OWNER_FINALIZER_MUST_NOT_LEAVE_A_SELF_JOINED_PROMISE").toBe(0);
	expect((fixture.harness as any)._cancelledCleanupPromises.size,
		"CONCURRENT_CANCEL_CALLERS_MUST_RELEASE_THEIR_CLEANUP_OWNER").toBe(0);
	expect(fixture.harness.activeVerifications.has(fixture.active.signalId)).toBe(false);
});

test("direct cancellation finalization owns resource settlement while a release owner arrives later", async () => {
	const fixture = makeExactResourceFixture("direct-finalizer-owns-settlement", "manual");
	let releaseSidecar!: () => void;
	(fixture.harness as any).sessionManager.getSandboxManager().get().removeVerificationSidecar = async () => {
		fixture.order.push("sidecar:held");
		await new Promise<void>(resolve => { releaseSidecar = resolve; });
	};
	fixture.checkoutManager.release = async (signalId, projectId) => {
		fixture.order.push("checkout:once");
		await FakePinnedCheckoutManager.prototype.release.call(fixture.checkoutManager, signalId, projectId);
	};
	const strict = vi.spyOn(fixture.gateStore, "updateSignalVerificationStrict").mockRejectedValueOnce(new Error("strict signal rejects once"));
	const finalizer = vi.spyOn(fixture.harness, "_finalizeCancelledVerification");

	const directFinalizer = fixture.harness._finalizeCancelledVerification(fixture.active);
	for (let turn = 0; turn < 4 && !releaseSidecar; turn++) await new Promise<void>(resolve => setImmediate(resolve));
	const releaseOwner = fixture.harness._releaseTerminalVerificationResources(fixture.active);
	await expect(releaseOwner).resolves.toBe(false);
	expect(fixture.order, "COMPETING_RELEASE_MUST_NOT_REMOVE_THE_SIDECAR_TWICE").toEqual(["sidecar:held"]);
	expect(fixture.harness.activeVerifications.get(fixture.active.signalId),
		"COMPETING_RELEASE_MUST_RETAIN_THE_FINALIZER_OWNER_UNTIL_PUBLICATION").toBe(fixture.active);

	releaseSidecar();
	await expect(directFinalizer).rejects.toThrow(/strict signal rejects once/i);
	expect(fixture.order, "DIRECT_FINALIZER_MUST_SETTLE_EACH_RESOURCE_EXACTLY_ONCE").toEqual(["sidecar:held", "checkout:once"]);
	expect(fixture.harness.activeVerifications.get(fixture.active.signalId),
		"STRICT_SIGNAL_REJECTION_MUST_NOT_EVICT_THE_DURABLE_RETRY_OWNER").toBe(fixture.active);
	expect((fixture.harness as any)._terminalCleanupRetryTimers.has(fixture.active.signalId),
		"COMPETING_RELEASE_MUST_LEAVE_A_RETRY_OWNER_AFTER_DIRECT_FINALIZER_REJECTION").toBe(true);

	const retryStart = finalizer.mock.results.length;
	fixture.clock.advance(1_000);
	await Promise.all(finalizer.mock.results.slice(retryStart).map(result => result.value));
	expect(strict).toHaveBeenCalledTimes(2);
	expect(fixture.order).toEqual(["sidecar:held", "checkout:once"]);
	expect(fixture.events.filter(event => event.type === "gate_verification_complete")).toHaveLength(1);
	expect(fixture.harness.activeVerifications.has(fixture.active.signalId)).toBe(false);
});

test("terminal cleanup retry catches strict publication rejection and schedules its next owner", async () => {
	const fixture = makeExactResourceFixture("terminal-retry-strict-rejection", "manual");
	fixture.checkoutManager.release = async (signalId, projectId) => {
		fixture.order.push("checkout:success");
		await FakePinnedCheckoutManager.prototype.release.call(fixture.checkoutManager, signalId, projectId);
	};
	const strict = vi.spyOn(fixture.gateStore, "updateSignalVerificationStrict").mockRejectedValueOnce(new Error("retry strict signal rejects once"));
	const finalizer = vi.spyOn(fixture.harness, "_finalizeCancelledVerification");
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		await fixture.harness._finalizeCancelledVerification(fixture.active);
		expect(fixture.order).toEqual(["sidecar:1"]);

		const retryStart = finalizer.mock.results.length;
		fixture.clock.advance(1_000);
		await Promise.all(finalizer.mock.results.slice(retryStart).map(result => result.value.catch(() => {})));
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(strict).toHaveBeenCalledTimes(1);
		expect(unhandled, "DETACHED_TERMINAL_RETRY_MUST_NOT_LEAK_A_STRICT_WRITE_REJECTION").toEqual([]);
		expect((fixture.harness as any)._cancelledCleanupRetryTimers.has(fixture.active.signalId),
			"STRICT_PUBLICATION_REJECTION_MUST_SCHEDULE_A_FOLLOW_UP_CANCELLATION_OWNER").toBe(true);

		fixture.clock.advance(1_000);
		await Promise.all([...(fixture.harness as any)._cancelledCleanupPromises.values()]);
		expect(strict).toHaveBeenCalledTimes(2);
		expect(fixture.events.filter(event => event.type === "gate_verification_complete")).toHaveLength(1);
		expect(fixture.harness.activeVerifications.has(fixture.active.signalId)).toBe(false);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("failed stale publication fence keeps step identity and retries durable supersession", async () => {
	const fixture = makeExactResourceFixture("stale-fence-retry", "superseded");
	fixture.gateStore.recordSignal({
		id: "stale-fence-retry-newer", goalId: GOAL_ID, gateId: GATE_ID, sessionId: "newer-owner", timestamp: Date.now(),
		commitSha: "0123456789abcdef0123456789abcdef01234567", content: "newer generation", contentVersion: 1,
		verification: { status: "running", steps: [] },
	});
	fixture.active.overallStatus = "running";
	delete fixture.active.cancelled;
	const steps = fixture.active.steps;
	const step = fixture.active.steps[0]!;
	(fixture.harness as any).sessionManager.getSandboxManager().get().removeVerificationSidecar = async () => {};
	fixture.checkoutManager.release = async (signalId, projectId) => {
		await FakePinnedCheckoutManager.prototype.release.call(fixture.checkoutManager, signalId, projectId);
	};
	const persist = vi.spyOn(fixture.harness, "_persistActive").mockReturnValueOnce(false);

	expect((fixture.harness as any)._cancellationOwnsTerminalPublication(fixture.active)).toBe(true);
	expect(fixture.active.steps).toBe(steps);
	expect(fixture.active.steps[0]).toBe(step);
	expect(fixture.active.cancelled).toBeUndefined();
	expect((fixture.harness as any)._failedCancellationFenceRetryTimers.has(fixture.active.signalId)).toBe(true);

	fixture.clock.advance(1_000);
	await new Promise<void>(resolve => setImmediate(resolve));
	await Promise.all([...(fixture.harness as any)._cancelledCleanupPromises.values()]);
	expect(persist.mock.calls.length, "STALE_FENCE_RETRY_MUST_RETRY_DURABLE_PERSISTENCE").toBeGreaterThanOrEqual(2);
	expect(fixture.harness.activeVerifications.has(fixture.active.signalId),
		"STALE_FENCE_RETRY_MUST_EVENTUALLY_TRANSFER_TO_CANCELLED_CLEANUP").toBe(false);
});

test("stale terminal release cannot evict a replacement active object or its retry timer", async () => {
	const fixture = makeExactResourceFixture("stale-release-owner", "manual");
	fixture.active.cancelled = false;
	fixture.active.overallStatus = "passed";
	fixture.active.terminalVerdictPublished = true;
	(fixture.harness as any).sessionManager.getSandboxManager().get().removeVerificationSidecar = async () => {};
	let releaseOld!: () => void;
	fixture.checkoutManager.release = async () => await new Promise<void>(resolve => { releaseOld = resolve; });
	(fixture.harness as any)._scheduleTerminalCleanupRetry(fixture.active.signalId);
	const release = (fixture.harness as any)._releaseTerminalVerificationResources(fixture.active);
	for (let turn = 0; turn < 4 && !releaseOld; turn++) await new Promise<void>(resolve => setImmediate(resolve));
	const replacement: ActiveVerification = {
		...structuredClone(fixture.active),
		overallStatus: "running",
		terminalVerdictPublished: undefined,
		cancelled: undefined,
		startedAt: fixture.active.startedAt + 1,
	};
	fixture.harness.activeVerifications.set(fixture.active.signalId, replacement);
	releaseOld();
	await expect(release).resolves.toBe(false);
	expect(fixture.harness.activeVerifications.get(fixture.active.signalId),
		"STALE_RELEASE_MUST_NOT_DELETE_REPLACEMENT_ACTIVE_OWNER").toBe(replacement);
	expect((fixture.harness as any)._terminalCleanupRetryTimers.has(fixture.active.signalId),
		"STALE_RELEASE_MUST_NOT_CLEAR_REPLACEMENT_RETRY_TIMER").toBe(true);
});

test("gate durable-write failure after strict signal publication retains the owner and publishes exactly once on retry", async () => {
	const fixture = makeExactResourceFixture("strict-signal-gate-failure", "gateway-restart-recovery");
	(fixture.harness as any).sessionManager.getSandboxManager().get().removeVerificationSidecar = async () => {
		fixture.order.push("sidecar:strict");
	};
	fixture.checkoutManager.release = async (signalId, projectId) => {
		fixture.order.push("checkout:strict");
		await FakePinnedCheckoutManager.prototype.release.call(fixture.checkoutManager, signalId, projectId);
	};
	const strict = vi.spyOn(fixture.gateStore, "updateSignalVerificationStrict");
	const updateGate = vi.spyOn(fixture.gateStore, "updateGateStatusStrict");
	updateGate.mockRejectedValueOnce(new Error("gate durable write interrupted after strict signal write"));

	await expect(fixture.harness._finalizeCancelledVerification(fixture.active))
		.rejects.toThrow(/gate durable write interrupted/i);
	expect(strict, "STRICT_SIGNAL_GATE_FAILURE_MUST_REACH_THE_SIGNAL_DURABILITY_BOUNDARY").toHaveBeenCalledTimes(1);
	expect(fixture.active.terminalVerdictPublished,
		"STRICT_SIGNAL_GATE_FAILURE_MUST_NOT_MARK_THE_TERMINAL_VERDICT_PUBLISHED").toBeUndefined();
	expect(fixture.harness.activeVerifications.get(fixture.active.signalId),
		"STRICT_SIGNAL_GATE_FAILURE_MUST_RETAIN_RETRY_OWNERSHIP").toBe(fixture.active);
	expect(fixture.events, "STRICT_SIGNAL_GATE_FAILURE_MUST_NOT_EMIT_INCOMPLETE_TERMINAL_WS_EVENT").toEqual([]);
	expect(fixture.notifications, "STRICT_SIGNAL_GATE_FAILURE_MUST_NOT_NOTIFY_BEFORE_GATE_DURABILITY").toEqual([]);

	await fixture.harness._finalizeCancelledVerification(fixture.active);
	const stored = fixture.gateStore.getGate(GOAL_ID, GATE_ID)!.signals.find(signal => signal.id === fixture.active.signalId)!;
	expect(stored.verification, "STRICT_SIGNAL_GATE_RETRY_MUST_CONVERGE_THE_SIGNAL_AUDIT").toMatchObject({
		status: "cancelled", cancellation: { cause: "gateway-restart-recovery", finalizedAt: expect.any(Number) },
	});
	expect(fixture.gateStore.getGate(GOAL_ID, GATE_ID)!.status,
		"STRICT_SIGNAL_GATE_RETRY_MUST_CONVERGE_GATE_PENDING_STATE").toBe("pending");
	expect(fixture.events.filter(event => event.type === "gate_verification_complete"),
		"STRICT_SIGNAL_GATE_RETRY_MUST_EMIT_ONE_COMPLETE_NOTIFICATION").toHaveLength(1);
	expect(fixture.notifications, "STRICT_SIGNAL_GATE_RETRY_MUST_NOTIFY_AFTER_BOTH_DURABLE_WRITES").toHaveLength(1);
	expect(fixture.harness.activeVerifications.has(fixture.active.signalId),
		"STRICT_SIGNAL_GATE_RETRY_MUST_REMOVE_OWNER_ONLY_AFTER_THE_COMPLETE_TRANSACTION").toBe(false);
});

test("legacy terminal publication retains exact cleanup ownership without republishing its cancellation", async () => {
	const fixture = makeExactResourceFixture("legacy-published-cleanup", "manual");
	fixture.active.terminalVerdictPublished = true;
	// This regression is about an old process that published before crashing. Its
	// already-settled sidecar avoids the fail-first seam used by the retry test.
	(fixture.harness as any).sessionManager.getSandboxManager().get().removeVerificationSidecar = async () => {
		fixture.order.push("sidecar:legacy");
	};
	fixture.checkoutManager.release = async (signalId, projectId) => {
		fixture.order.push("checkout:legacy");
		await FakePinnedCheckoutManager.prototype.release.call(fixture.checkoutManager, signalId, projectId);
	};
	const strict = vi.spyOn(fixture.gateStore, "updateSignalVerificationStrict");
	const gateStatus = vi.spyOn(fixture.gateStore, "updateGateStatusStrict");

	await fixture.harness._finalizeCancelledVerification(fixture.active);

	expect(fixture.order).toEqual(["sidecar:legacy", "checkout:legacy"]);
	expect(strict, "LEGACY_PUBLISHED_CLEANUP_MUST_NOT_REPUBLISH_SIGNAL_VERDICT").not.toHaveBeenCalled();
	expect(gateStatus, "LEGACY_PUBLISHED_CLEANUP_MUST_NOT_REWRITE_GATE_STATUS").not.toHaveBeenCalled();
	expect(fixture.events, "LEGACY_PUBLISHED_CLEANUP_MUST_NOT_EMIT_A_DUPLICATE_COMPLETION").toEqual([]);
	expect(fixture.notifications, "LEGACY_PUBLISHED_CLEANUP_MUST_NOT_NOTIFY_TWICE").toEqual([]);
	expect(fixture.harness.activeVerifications.has(fixture.active.signalId),
		"LEGACY_PUBLISHED_CLEANUP_MUST_RELEASE_ITS_DURABLE_OWNER").toBe(false);
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
