/**
 * Tests for `GateSignalStep.subgoal` idempotency record persistence
 * (nested goals — see docs/design/nested-goals.md §2.5).
 *
 * Verifies:
 *   - A signal carrying a `type: "subgoal"` step with an attached
 *     `subgoal: { planId, childGoalId, ... }` payload survives a save/reload
 *     of the GateStore (mirroring server restart).
 *   - `updateSignalVerification` preserves the subgoal idempotency record
 *     when finalising a previously-running verification.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GateStore, type GateSignal, type GateSignalStep } from "../src/server/agent/gate-store.ts";

let tmpRoot: string;
let stateDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gate-store-subgoal-test-"));
	stateDir = path.join(tmpRoot, "state");
	fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeSignal(overrides: Partial<GateSignal> = {}): GateSignal {
	return {
		id: "sig-1",
		gateId: "execution",
		goalId: "goal-parent",
		sessionId: "sess-1",
		timestamp: 1700000000000,
		commitSha: "deadbeef",
		verification: {
			status: "running",
			steps: [],
		},
		...overrides,
	};
}

describe("GateStore — GateSignalStep.subgoal idempotency record", () => {
	it("persists a subgoal verification step across reload", () => {
		const store = new GateStore(stateDir);
		store.initGatesForGoal("goal-parent", ["execution"]);

		const subgoalStep: GateSignalStep = {
			name: "Spawn API client subgoal",
			type: "subgoal",
			passed: false,
			output: "spawning child goal-child-1",
			duration_ms: 0,
			subgoal: {
				planId: "01HQX3PLAN1",
				childGoalId: "goal-child-1",
			},
		};
		store.recordSignal(makeSignal({
			verification: { status: "running", steps: [subgoalStep] },
		}));

		// Reload from disk — simulate restart.
		const store2 = new GateStore(stateDir);
		const gate = store2.getGate("goal-parent", "execution");
		assert.ok(gate);
		assert.equal(gate!.signals.length, 1);
		const sig = gate!.signals[0];
		assert.equal(sig.id, "sig-1");
		assert.equal(sig.verification.steps.length, 1);
		const step = sig.verification.steps[0];
		assert.equal(step.type, "subgoal");
		assert.ok(step.subgoal, "subgoal idempotency record should survive reload");
		assert.equal(step.subgoal!.planId, "01HQX3PLAN1");
		assert.equal(step.subgoal!.childGoalId, "goal-child-1");
		assert.equal(step.subgoal!.childMergedAt, undefined);
		assert.equal(step.subgoal!.childMergeConflict, undefined);
	});

	it("preserves childMergedAt and childMergeConflict on the persisted record", () => {
		const store = new GateStore(stateDir);
		store.initGatesForGoal("goal-parent", ["execution"]);

		const mergedStep: GateSignalStep = {
			name: "Merged child A",
			type: "subgoal",
			passed: true,
			output: "child merged at parent tip",
			duration_ms: 12_345,
			subgoal: {
				planId: "P-MERGED",
				childGoalId: "goal-child-A",
				childMergedAt: 1700000123456,
			},
		};
		const conflictStep: GateSignalStep = {
			name: "Conflicted child B",
			type: "subgoal",
			passed: false,
			output: "merge conflict — manual resolution required",
			duration_ms: 5_000,
			subgoal: {
				planId: "P-CONFLICT",
				childGoalId: "goal-child-B",
				childMergeConflict: true,
			},
		};
		store.recordSignal(makeSignal({
			id: "sig-2",
			verification: { status: "failed", steps: [mergedStep, conflictStep] },
		}));

		const store2 = new GateStore(stateDir);
		const sig = store2.getGate("goal-parent", "execution")!.signals[0];
		assert.equal(sig.verification.status, "failed");
		assert.equal(sig.verification.steps[0].subgoal!.childMergedAt, 1700000123456);
		assert.equal(sig.verification.steps[1].subgoal!.childMergeConflict, true);
	});

	it("updateSignalVerification preserves subgoal record when finalising a running signal", () => {
		const store = new GateStore(stateDir);
		store.initGatesForGoal("goal-parent", ["execution"]);

		const initialStep: GateSignalStep = {
			name: "Spawn child",
			type: "subgoal",
			passed: false,
			output: "running",
			duration_ms: 0,
			subgoal: { planId: "P-FINAL", childGoalId: "goal-child-final" },
		};
		store.recordSignal(makeSignal({
			id: "sig-final",
			verification: { status: "running", steps: [initialStep] },
		}));

		// Now finalise — harness rewrites the verification block once the child
		// merges. The subgoal record on the resulting step still carries the
		// original planId + childGoalId plus a freshly populated childMergedAt.
		const finalisedStep: GateSignalStep = {
			...initialStep,
			passed: true,
			output: "child merged",
			duration_ms: 30_000,
			subgoal: {
				planId: "P-FINAL",
				childGoalId: "goal-child-final",
				childMergedAt: 1700000999999,
			},
		};
		store.updateSignalVerification("sig-final", {
			status: "passed",
			steps: [finalisedStep],
		});

		// Reload from disk.
		const store2 = new GateStore(stateDir);
		const sig = store2.getGate("goal-parent", "execution")!.signals[0];
		assert.equal(sig.verification.status, "passed");
		const step = sig.verification.steps[0];
		assert.equal(step.passed, true);
		assert.equal(step.subgoal!.planId, "P-FINAL");
		assert.equal(step.subgoal!.childGoalId, "goal-child-final");
		assert.equal(step.subgoal!.childMergedAt, 1700000999999);
	});

	it("non-subgoal step types persist with no subgoal field", () => {
		const store = new GateStore(stateDir);
		store.initGatesForGoal("goal-parent", ["implementation"]);

		const step: GateSignalStep = {
			name: "Build",
			type: "command",
			passed: true,
			output: "ok",
			duration_ms: 100,
		};
		store.recordSignal(makeSignal({
			id: "sig-cmd",
			gateId: "implementation",
			verification: { status: "passed", steps: [step] },
		}));

		const sig = new GateStore(stateDir)
			.getGate("goal-parent", "implementation")!
			.signals[0];
		assert.equal(sig.verification.steps[0].type, "command");
		assert.equal(sig.verification.steps[0].subgoal, undefined);
	});
});
