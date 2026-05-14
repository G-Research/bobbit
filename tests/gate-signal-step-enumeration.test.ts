/**
 * Reproducing regression test for the gate-signal step-enumeration race.
 *
 * See goal "Fix verification progress race" / Issue Analysis gate.
 *
 * Scenario: when a content gate is signaled, the verification harness
 * builds an `ActiveVerification` entry with one row per `gate.verify[]`
 * step (status `running` for phase=minPhase, `waiting` for higher phases).
 * Currently the entry is only constructed *inside* the fire-and-forget
 * `verifyGateSignal()` async function, several `await`s after the
 * `gateStore.recordSignal()` call. Between those two points the persisted
 * signal carries `verification.steps: []` and `getActiveVerifications()`
 * returns `[]`. Consumers (gate_status, dashboard polling) see no
 * progress for ~15-30s on multi-step gates.
 *
 * EXPECTED (post-fix): the harness exposes a synchronous
 * `beginVerification(signal, gate)` method that
 *   1. populates `activeVerifications` immediately, and
 *   2. returns a `GateSignalStep[]` shaped exactly for the gate-store to
 *      persist into `signal.verification.steps` atomically with
 *      `recordSignal`.
 * After calling it, both the gate-store *and* `getActiveVerifications()`
 * agree on the enumerated step list within the same scheduler tick —
 * there is no observable window where they disagree.
 *
 * CURRENT MASTER (failing): `harness.beginVerification` does not exist
 * (it's an inline block inside `verifyGateSignal`), so step enumeration
 * cannot be performed synchronously before `recordSignal`. The assertion
 * below explicitly pins this missing API as the bug.
 *
 * Marker for error_pattern matching:
 *   GATE_SIGNAL_STEP_ENUMERATION_RACE
 *
 * This test must FAIL on master and PASS once the fix lands.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gate-signal-enum-test-"));
const STATE_DIR = path.join(TEST_DIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");
const { GateStore } = await import("../src/server/agent/gate-store.js");

import type { GateSignal } from "../src/server/agent/gate-store.js";
import type { WorkflowGate } from "../src/server/agent/workflow-store.js";

const GOAL_ID = "goal-enum-test";
const GATE_ID = "implementation";
const SIGNAL_ID = "sig-enum-1";

function makeHarness(gateStore: any) {
	const roleStore = {
		get: () => undefined,
		getAll: () => [],
	} as any;

	return new VerificationHarness(
		STATE_DIR,
		gateStore,                      // gateStore (fallback path)
		() => {},                       // broadcastFn
		roleStore,                      // roleStore
		undefined,                      // preferencesStore
		undefined,                      // sessionManager
		undefined,                      // teamManager
		undefined,                      // projectConfigStore
		undefined,                      // projectContextManager (forces fallback gateStore)
		undefined,                      // configCascade
	);
}

/** Mirror of the seven verify steps on the seeded `bug-fix` workflow's `implementation` gate. */
function buildImplementationGate(): WorkflowGate {
	return {
		id: GATE_ID,
		name: "Implementation",
		dependsOn: [],
		verify: [
			{ name: "Build",            type: "command",    run: "true",   phase: 0 },
			{ name: "Type check",       type: "command",    run: "true",   phase: 0 },
			{ name: "Repro test",       type: "command",    run: "true",   phase: 1 },
			{ name: "Unit",             type: "command",    run: "true",   phase: 1 },
			{ name: "E2E",              type: "command",    run: "true",   phase: 2 },
			{ name: "Code review",      type: "llm-review", prompt: "x",   phase: 3 },
			{ name: "Security review",  type: "llm-review", prompt: "x",   phase: 3 },
		],
	};
}

function buildSignal(): GateSignal {
	return {
		id: SIGNAL_ID,
		gateId: GATE_ID,
		goalId: GOAL_ID,
		sessionId: "session-enum-test",
		timestamp: Date.now(),
		commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		content: "hello",
		contentVersion: 1,
		verification: { status: "running", steps: [] },
	};
}

test("VerificationHarness exposes a synchronous beginVerification(signal, gate) — GATE_SIGNAL_STEP_ENUMERATION_RACE", () => {
	const gateStore = new GateStore(STATE_DIR);
	const harness = makeHarness(gateStore);

	assert.strictEqual(
		typeof (harness as any).beginVerification,
		"function",
		"GATE_SIGNAL_STEP_ENUMERATION_RACE: VerificationHarness.beginVerification(signal, gate) must exist as a synchronous method so the gate_signal REST handler can populate the gate-store's signal.verification.steps[] atomically with recordSignal(). Currently the step enumeration is performed several awaits deep inside the fire-and-forget verifyGateSignal(), leaving a window where gate_status returns empty steps[] and the dashboard shows no in-progress chips.",
	);
});

test("beginVerification populates getActiveVerifications synchronously in the same tick — GATE_SIGNAL_STEP_ENUMERATION_RACE", () => {
	const gateStore = new GateStore(STATE_DIR);
	gateStore.initGatesForGoal(GOAL_ID, [GATE_ID]);
	const harness = makeHarness(gateStore);

	const gate = buildImplementationGate();
	const signal = buildSignal();

	// Pre-condition — no active verifications yet.
	assert.strictEqual(harness.getActiveVerifications(GOAL_ID).length, 0);

	// The fix contract: beginVerification is SYNCHRONOUS — no awaits, returns immediately.
	const beginFn = (harness as any).beginVerification;
	assert.strictEqual(
		typeof beginFn,
		"function",
		"GATE_SIGNAL_STEP_ENUMERATION_RACE: harness.beginVerification must be a function — see previous test for context.",
	);

	const returned = beginFn.call(harness, signal, gate);

	// In the same scheduler tick, the active map MUST already reflect all 7 steps.
	const active = harness.getActiveVerifications(GOAL_ID);
	assert.strictEqual(
		active.length,
		1,
		"GATE_SIGNAL_STEP_ENUMERATION_RACE: beginVerification must populate activeVerifications synchronously — current count: " + active.length,
	);
	assert.strictEqual(
		active[0].signalId,
		SIGNAL_ID,
		"GATE_SIGNAL_STEP_ENUMERATION_RACE: active entry signalId mismatch",
	);
	assert.strictEqual(
		active[0].steps.length,
		7,
		"GATE_SIGNAL_STEP_ENUMERATION_RACE: active entry should have 7 enumerated steps, got " + active[0].steps.length,
	);

	// Phase 0 steps run; higher phases wait.
	const runningCount = active[0].steps.filter(s => s.status === "running").length;
	const waitingCount = active[0].steps.filter(s => s.status === "waiting").length;
	assert.strictEqual(
		runningCount,
		2,
		"GATE_SIGNAL_STEP_ENUMERATION_RACE: expected 2 running steps (phase=0), got " + runningCount,
	);
	assert.strictEqual(
		waitingCount,
		5,
		"GATE_SIGNAL_STEP_ENUMERATION_RACE: expected 5 waiting steps (phase>0), got " + waitingCount,
	);

	// And the returned array must be GateSignalStep-shaped for direct
	// persistence into signal.verification.steps.
	assert.ok(
		Array.isArray(returned),
		"GATE_SIGNAL_STEP_ENUMERATION_RACE: beginVerification must return an array of GateSignalStep entries the caller writes into signal.verification.steps",
	);
	assert.strictEqual(
		returned.length,
		7,
		"GATE_SIGNAL_STEP_ENUMERATION_RACE: beginVerification must return 7 GateSignalStep entries, got " + returned.length,
	);
	for (const row of returned) {
		assert.ok(typeof row.name === "string" && row.name.length > 0, "row.name must be populated");
		assert.ok(row.type === "command" || row.type === "llm-review" || row.type === "agent-qa",
			"row.type must be one of the GateSignalStep types, got " + row.type);
		assert.strictEqual(row.passed, false, "GATE_SIGNAL_STEP_ENUMERATION_RACE: initial passed must be false (step has not yet completed)");
	}
});

test("gate-store and active-verifications agree on enumerated steps in the same tick — GATE_SIGNAL_STEP_ENUMERATION_RACE", () => {
	const gateStore = new GateStore(STATE_DIR);
	gateStore.initGatesForGoal(GOAL_ID, [GATE_ID]);
	const harness = makeHarness(gateStore);

	const gate = buildImplementationGate();
	const signal = buildSignal();

	const beginFn = (harness as any).beginVerification;
	assert.strictEqual(
		typeof beginFn,
		"function",
		"GATE_SIGNAL_STEP_ENUMERATION_RACE: harness.beginVerification must be a function.",
	);

	// Simulate the production gate_signal REST handler ordering:
	//   1) sync enumerate
	//   2) write into signal.verification.steps
	//   3) recordSignal
	const initialSteps = beginFn.call(harness, signal, gate);
	signal.verification = { status: "running", steps: initialSteps };
	gateStore.recordSignal(signal);

	// Immediately read back via the same SSOT the gate_status REST handler uses.
	const persistedGate = gateStore.getGate(GOAL_ID, GATE_ID);
	assert.ok(persistedGate, "GATE_SIGNAL_STEP_ENUMERATION_RACE: gate-store missing gate after recordSignal");
	const persistedSignal = persistedGate!.signals.find(s => s.id === SIGNAL_ID);
	assert.ok(persistedSignal, "GATE_SIGNAL_STEP_ENUMERATION_RACE: gate-store missing signal after recordSignal");
	assert.strictEqual(
		persistedSignal!.verification.steps.length,
		7,
		"GATE_SIGNAL_STEP_ENUMERATION_RACE: gate-store persisted signal.verification.steps is empty after recordSignal — this is the bug. The dashboard's gate_status poll would see zero chips here.",
	);

	// And the two stores must agree on names + order.
	const activeSteps = harness.getActiveVerifications(GOAL_ID)[0].steps;
	const gateStoreNames = persistedSignal!.verification.steps.map(s => s.name);
	const activeNames = activeSteps.map(s => s.name);
	assert.deepStrictEqual(
		gateStoreNames,
		activeNames,
		"GATE_SIGNAL_STEP_ENUMERATION_RACE: gate-store and activeVerifications disagree on step ordering — both should mirror gate.verify[] exactly",
	);
	assert.deepStrictEqual(
		gateStoreNames,
		gate.verify!.map(s => s.name),
		"GATE_SIGNAL_STEP_ENUMERATION_RACE: gate-store steps don't match gate.verify[] declaration",
	);
});
