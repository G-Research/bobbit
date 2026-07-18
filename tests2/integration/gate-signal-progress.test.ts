import path from "node:path";

import { test, expect } from "./_e2e/in-process-harness.js";
import { createGoal, deleteGoal } from "./_e2e/e2e-setup.js";
import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import type { WorkflowGate } from "../../src/server/agent/workflow-store.js";
import { buildGateVerificationSnapshot } from "../../src/server/gate-verification-snapshot.js";
import type { GatewayFixture } from "../harness/gateway.js";
import { createMemFs } from "../harness/mem-fs.js";

/**
 * Pins the synchronous gate-signal ordering without launching verification work:
 * beginVerification -> recordSignal -> every reader. This is the production
 * race boundary. Command execution, sockets, Git discovery, and scheduler waits
 * are orthogonal and are covered by their focused suites.
 */

const EXPECTED_STEPS: Array<{ name: string; phase: number }> = [
	{ name: "Slow build", phase: 0 },
	{ name: "Type check", phase: 1 },
	{ name: "Unit tests", phase: 1 },
	{ name: "E2E tests", phase: 2 },
];

const EXPECTED_IN_FLIGHT_STEP_STATE: Array<{ name: string; phase: number; status: string }> = [
	{ name: "Slow build", phase: 0, status: "running" },
	{ name: "Type check", phase: 1, status: "waiting" },
	{ name: "Unit tests", phase: 1, status: "waiting" },
	{ name: "E2E tests", phase: 2, status: "waiting" },
];

const EXPECTED_DOWNSTREAM_SKIP_STEPS = [
	{ name: "Failing check", type: "command" as const, passed: false, status: "failed" as const, skipped: false, phase: 0, output: "exit 7", duration_ms: 0 },
	{ name: "Later command", type: "command" as const, passed: true, status: "skipped" as const, skipped: true, phase: 1, output: "Skipped — earlier phase failed", duration_ms: 0 },
	{ name: "Final command", type: "command" as const, passed: true, status: "skipped" as const, skipped: true, phase: 2, output: "Skipped — earlier phase failed", duration_ms: 0 },
];

function progressGate(): WorkflowGate {
	return {
		id: "slow-multi",
		name: "Slow Multi-Step",
		dependsOn: [],
		verify: [
			{ name: "Slow build", type: "command", run: "true" },
			{ name: "Type check", type: "command", phase: 1, run: "true" },
			{ name: "Unit tests", type: "command", phase: 1, run: "true" },
			{ name: "E2E tests", type: "command", phase: 2, run: "true" },
		],
	};
}

function failingGate(): WorkflowGate {
	return {
		id: "failing-multi",
		name: "Failing Multi-Phase",
		dependsOn: [],
		verify: [
			{ name: "Failing check", type: "command", run: "false" },
			{ name: "Later command", type: "command", phase: 1, run: "true" },
			{ name: "Final command", type: "command", phase: 2, run: "true" },
		],
	};
}

let gatewayFixture: GatewayFixture;
let goalId: string;
let gateStore: any;
let verificationHarness: any;
let signalSequence = 0;

function makeSignal(gateId: string): GateSignal {
	return {
		id: `gate-progress-${process.pid}-${++signalSequence}`,
		goalId,
		gateId,
		sessionId: "gate-progress-fixture",
		timestamp: gatewayFixture.clock.now() + signalSequence,
		commitSha: "fixture",
		verification: { status: "running", steps: [] },
	};
}

function activeMap(): Map<string, any> {
	const active = verificationHarness.activeVerifications;
	if (!(active instanceof Map)) throw new Error("verification harness active map is unavailable");
	return active;
}

function resetFixtureState(): void {
	for (const [signalId, active] of activeMap()) {
		if (active.goalId === goalId) activeMap().delete(signalId);
	}
	verificationHarness._persistActive();
	gateStore.removeGoalGates(goalId);
	gateStore.initGatesForGoal(goalId, ["slow-multi", "failing-multi"]);
}

function beginAndPersist(gate: WorkflowGate): { signal: GateSignal; postBody: any } {
	const signal = makeSignal(gate.id);
	const steps = verificationHarness.beginVerification(signal, gate);
	signal.verification = { status: "running", steps };
	gateStore.recordSignal(signal);
	return {
		signal,
		postBody: { signal: { ...signal, status: "running", steps } },
	};
}

function finishFailed(signal: GateSignal): void {
	gateStore.updateSignalVerification(signal.id, { status: "failed", steps: EXPECTED_DOWNSTREAM_SKIP_STEPS });
	gateStore.updateGateStatus(goalId, signal.gateId, "failed");
	activeMap().delete(signal.id);
	verificationHarness._persistActive();
}

test.beforeAll(async ({ gateway }) => {
	gatewayFixture = gateway;
	verificationHarness = gateway.teamManager.verificationHarness;
	if (!verificationHarness) throw new Error("verification harness was not wired before gate-progress setup");
	goalId = (await createGoal({ title: "Gate Signal Progress", worktree: false })).id;
	const context = gateway.projectContextManager.getContextForGoal(goalId);
	if (!context) throw new Error(`missing project context for gate-progress goal ${goalId}`);
	gateStore = context.gateStore;
	gateStore.initGatesForGoal(goalId, ["slow-multi", "failing-multi"]);
});

test.afterAll(async () => {
	if (goalId) await deleteGoal(goalId).catch(() => undefined);
});

test.describe("Gate-signal step enumeration race (verification-progress race)", () => {
	test.beforeEach(() => resetFixtureState());

	test("persisted gate-store steps[] matches POST response within the same scheduler tick — GATE_SIGNAL_PROGRESS_RACE", () => {
		const { signal, postBody } = beginAndPersist(progressGate());
		const postSteps = postBody.signal.steps;

		expect(postSteps.map((step: any) => step.name), "GATE_SIGNAL_PROGRESS_RACE: POST response steps[] must mirror gate.verify[] names")
			.toEqual(EXPECTED_STEPS.map((step) => step.name));
		expect(postSteps.map((step: any) => ({ name: step.name, phase: step.phase, status: step.status })),
			"GATE_SIGNAL_PHASE_STATUS: POST response must preserve initialized phase/status metadata for the chat renderer")
			.toEqual(EXPECTED_IN_FLIGHT_STEP_STATE);
		expect(postBody.signal.status).toBe("running");

		// Gate summary and inspect both derive from the signal recorded in the same
		// synchronous turn; no HTTP round trip can hide an empty intermediate state.
		const latestSignal = gateStore.getGate(goalId, "slow-multi")?.signals.at(-1);
		expect(latestSignal?.id, "GATE_SIGNAL_PROGRESS_RACE: summary latestSignal.id must match POST response").toBe(signal.id);
		expect(latestSignal?.verification.status).toBe("running");
		expect(latestSignal?.verification.steps.map((step: any) => step.name)).toEqual(postSteps.map((step: any) => step.name));

		const inspect = buildGateVerificationSnapshot({
			goalId,
			gateId: "slow-multi",
			signalId: signal.id,
			verification: latestSignal.verification,
		});
		expect(inspect.steps).toHaveLength(EXPECTED_STEPS.length);
		expect(inspect.steps.map((step) => ({ name: step.name, type: step.type }))).toEqual(
			EXPECTED_STEPS.map((step) => ({ name: step.name, type: "command" })),
		);

		const matching = verificationHarness.getActiveVerifications(goalId).find((entry: any) => entry.signalId === signal.id);
		expect(matching, "GATE_SIGNAL_PROGRESS_RACE: activeVerifications must be populated synchronously").toBeTruthy();
		expect(matching.overallStatus).toBe("running");
		expect(matching.steps.map((step: any) => ({ name: step.name, phase: step.phase, status: step.status })))
			.toEqual(EXPECTED_IN_FLIGHT_STEP_STATE);
		expect(matching.steps.filter((step: any) => step.status === "running")).toHaveLength(1);
		expect(matching.steps.filter((step: any) => step.status === "waiting")).toHaveLength(3);
	});

	test("terminal downstream phase skips persist explicit skipped status and phase — GATE_SIGNAL_PHASE_STATUS", () => {
		const { signal } = beginAndPersist(failingGate());
		finishFailed(signal);

		const stored = gateStore.getGate(goalId, "failing-multi")?.signals.find((candidate: any) => candidate.id === signal.id);
		expect(stored?.verification.steps.map((step: any) => ({
			name: step.name,
			status: step.status,
			skipped: !!step.skipped,
			phase: step.phase,
		})), "GATE_SIGNAL_PHASE_STATUS: failed phase-0 must leave later phases persisted as explicit skipped steps with original phases")
			.toEqual(EXPECTED_DOWNSTREAM_SKIP_STEPS.map(({ name, status, skipped, phase }) => ({ name, status, skipped, phase })));

		// Reopen the persisted rows through the store's in-memory filesystem seam,
		// proving terminal status/phase survives reconstruction without NTFS I/O.
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/gate-progress-reopen");
		const persisted = new GateStore(stateDir, memfs);
		persisted.initGatesForGoal(goalId, ["failing-multi"]);
		persisted.recordSignal(structuredClone(stored));
		const reopened = new GateStore(stateDir, memfs).getGate(goalId, "failing-multi")?.signals[0];
		expect(reopened?.verification.steps).toEqual(EXPECTED_DOWNSTREAM_SKIP_STEPS);
	});
});
