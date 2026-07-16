import { test, expect } from "./_e2e/in-process-harness.js";
import { createGoal, deleteGoal } from "./_e2e/e2e-setup.js";
import type { GatewayFixture } from "../harness/gateway.js";

/**
 * Gate re-signal cancellation is bookkeeping, not WebSocket or subprocess
 * fidelity. The fixture seeds the legitimate pre-command-start race directly:
 * an overall-running verification whose command step is still waiting. That
 * exercises the production cancellation method without a socket, process
 * identity retry, project discovery, or host-timer wait.
 */

const GATE_ID = "slow-gate";
let gatewayFixture: GatewayFixture;
let goalId: string;
let gateStore: any;
let verificationHarness: any;
let originalBroadcast: ((goalId: string, event: any) => void) | undefined;
let events: any[] = [];
let signalSequence = 0;

function activeMap(): Map<string, any> {
	const active = verificationHarness.activeVerifications;
	if (!(active instanceof Map)) throw new Error("verification harness active map is unavailable");
	return active;
}

function resetFixtureState(): void {
	for (const [signalId, active] of activeMap()) {
		if (active.goalId === goalId) activeMap().delete(signalId);
	}
	gateStore.removeGoalGates(goalId);
	gateStore.initGatesForGoal(goalId, [GATE_ID]);
	events = [];
}

function seedRunningSignal(content: string): any {
	const signalId = `resignal-${process.pid}-${++signalSequence}`;
	const signal = {
		id: signalId,
		goalId,
		gateId: GATE_ID,
		sessionId: "gate-resignal-fixture",
		timestamp: gatewayFixture.clock.now() + signalSequence,
		commitSha: "fixture",
		content,
		verification: {
			status: "running" as const,
			steps: [{
				name: "Slow check",
				type: "command" as const,
				passed: false,
				status: "waiting" as const,
				phase: 0,
				output: "",
				duration_ms: 0,
			}],
		},
	};
	gateStore.recordSignal(signal);
	activeMap().set(signalId, {
		goalId,
		gateId: GATE_ID,
		signalId,
		steps: [{ name: "Slow check", type: "command", status: "waiting", phase: 0, startedAt: gatewayFixture.clock.now() }],
		overallStatus: "running",
		startedAt: gatewayFixture.clock.now(),
	});
	return signal;
}

async function resignal(content: string): Promise<any> {
	await verificationHarness.cancelStaleVerifications(goalId, GATE_ID);
	return seedRunningSignal(content);
}

function completeSignal(signalId: string): void {
	gateStore.updateSignalVerification(signalId, {
		status: "passed",
		steps: [{ name: "Slow check", type: "command", passed: true, status: "passed", phase: 0, output: "done", duration_ms: 0 }],
	});
	gateStore.updateGateStatus(goalId, GATE_ID, "passed");
	activeMap().delete(signalId);
	verificationHarness.broadcastFn(goalId, {
		type: "gate_status_changed",
		goalId,
		gateId: GATE_ID,
		status: "passed",
	});
}

function activeVerifications(): any[] {
	return verificationHarness.getActiveVerifications(goalId);
}

function signals(): any[] {
	return gateStore.getGate(goalId, GATE_ID)?.signals ?? [];
}

test.beforeAll(async ({ gateway }) => {
	gatewayFixture = gateway;
	verificationHarness = gateway.teamManager.verificationHarness;
	if (!verificationHarness) throw new Error("verification harness was not wired before gate-resignal setup");
	goalId = (await createGoal({ title: "Gate Re-signal Cancellation", worktree: false })).id;
	const context = gateway.projectContextManager.getContextForGoal(goalId);
	if (!context) throw new Error(`missing project context for gate-resignal goal ${goalId}`);
	gateStore = context.gateStore;
	gateStore.initGatesForGoal(goalId, [GATE_ID]);

	originalBroadcast = verificationHarness._rawBroadcastFn;
	verificationHarness._rawBroadcastFn = (eventGoalId: string, event: any) => {
		if (eventGoalId === goalId) events.push(structuredClone(event));
		originalBroadcast?.(eventGoalId, event);
	};
});

test.afterAll(async () => {
	if (verificationHarness && originalBroadcast) verificationHarness._rawBroadcastFn = originalBroadcast;
	if (goalId) await deleteGoal(goalId).catch(() => undefined);
});

test.describe("Gate Re-signal Cancellation", () => {
	test.beforeEach(() => resetFixtureState());

	test("re-signaling a gate cancels the previous verification", async () => {
		const signal1 = seedRunningSignal("Signal v1");

		const activeBeforeResignal = activeVerifications();
		expect(activeBeforeResignal).toHaveLength(1);
		expect(activeBeforeResignal[0]).toMatchObject({ signalId: signal1.id, overallStatus: "running" });

		const signal2 = await resignal("Signal v2");
		expect(signal2.id).not.toBe(signal1.id);
		expect(events).toContainEqual(expect.objectContaining({
			type: "gate_verification_complete",
			goalId,
			gateId: GATE_ID,
			signalId: signal1.id,
			status: "cancelled",
		}));
		expect(activeVerifications().find((entry) => entry.signalId === signal1.id)).toBeUndefined();

		completeSignal(signal2.id);
		const terminal = events.find((event) => event.type === "gate_status_changed" && event.gateId === GATE_ID);
		expect(terminal?.status).toBe("passed");

		const history = signals();
		expect(history).toHaveLength(2);
		expect(history[0].verification).toMatchObject({ status: "failed", steps: [{ name: "Cancelled", status: "failed" }] });
		expect(history.at(-1)).toMatchObject({ id: signal2.id, verification: { status: "passed" } });
	});

	test("triple re-signal — only final signal determines outcome", async () => {
		const signal1 = seedRunningSignal("Signal v1");
		const signal2 = await resignal("Signal v2");
		const signal3 = await resignal("Signal v3");

		const cancellations = events.filter((event) => event.type === "gate_verification_complete" && event.status === "cancelled");
		expect(cancellations.map((event) => event.signalId)).toEqual([signal1.id, signal2.id]);
		expect(activeVerifications()).toEqual([expect.objectContaining({ signalId: signal3.id, overallStatus: "running" })]);

		completeSignal(signal3.id);
		expect(activeVerifications()).toHaveLength(0);
		expect(gateStore.getGate(goalId, GATE_ID)?.status).toBe("passed");
		expect(signals().map((signal) => signal.verification.status)).toEqual(["failed", "failed", "passed"]);
	});
});
