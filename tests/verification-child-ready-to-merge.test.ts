/**
 * Tests for the child-goal `ready-to-merge` short-circuit (design §3.4).
 *
 * Spec: docs/design/nested-goals.md §3.4.
 *
 * Coverage:
 *   - Child goal (`mergeTarget === "parent"`) signalling `ready-to-merge`
 *     auto-passes the gate without invoking any verify[] step (no
 *     git/shell side effects, no LLM calls). A single synthetic step
 *     "Child ready-to-merge" is recorded on the signal.
 *   - Top-level goal (`mergeTarget === "master"` or undefined) on the
 *     same gate runs the verify[] normally — the short-circuit MUST
 *     NOT trigger.
 *   - The short-circuit only matches `gateId === "ready-to-merge"`;
 *     other gates on a child goal still run their verify[] normally.
 *   - The short-circuit broadcasts `gate_verification_complete` and
 *     `gate_status_changed` so dashboard / parent harness loops observe
 *     the state transition exactly like a real verification run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GateSignal, GateState } from "../src/server/agent/gate-store.ts";
import type { VerifyStep, WorkflowGate } from "../src/server/agent/workflow-store.ts";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-child-rtm-test-"));
fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

// ---------------------------------------------------------------------------
// In-memory mocks (mirror tests/verification-paused.test.ts shape).
// ---------------------------------------------------------------------------

interface FakeGoal {
	id: string;
	title: string;
	cwd: string;
	state: "todo" | "in-progress" | "complete" | "shelved";
	parentGoalId?: string;
	rootGoalId?: string;
	branch?: string;
	worktreePath?: string;
	projectId?: string;
	mergeTarget?: "master" | "parent";
	workflow?: { gates: WorkflowGate[] };
}

class FakeGoalStore {
	private goals = new Map<string, FakeGoal>();
	put(g: FakeGoal): void { this.goals.set(g.id, { ...g }); }
	get(id: string): FakeGoal | undefined { return this.goals.get(id); }
}

class FakeGateStore {
	private gates = new Map<string, GateState>();
	private signalIndex = new Map<string, { goalId: string; gateId: string }>();
	private key(goalId: string, gateId: string): string { return `${goalId}::${gateId}`; }
	initGatesForGoal(goalId: string, gateIds: string[]): void {
		for (const gid of gateIds) {
			this.gates.set(this.key(goalId, gid), {
				gateId: gid, goalId, status: "pending", signals: [], updatedAt: Date.now(),
			});
		}
	}
	getGate(goalId: string, gateId: string): GateState | undefined {
		return this.gates.get(this.key(goalId, gateId));
	}
	getGatesForGoal(goalId: string): GateState[] {
		return [...this.gates.values()].filter(g => g.goalId === goalId);
	}
	recordSignal(signal: GateSignal): void {
		const gate = this.gates.get(this.key(signal.goalId, signal.gateId));
		if (gate) {
			gate.signals.push(signal);
			this.signalIndex.set(signal.id, { goalId: signal.goalId, gateId: signal.gateId });
		}
	}
	updateGateStatus(goalId: string, gateId: string, status: GateState["status"]): void {
		const g = this.gates.get(this.key(goalId, gateId));
		if (g) g.status = status;
	}
	updateSignalVerification(signalId: string, verification: GateSignal["verification"]): void {
		const idx = this.signalIndex.get(signalId);
		if (!idx) return;
		const gate = this.gates.get(this.key(idx.goalId, idx.gateId));
		if (!gate) return;
		const sig = gate.signals.find(s => s.id === signalId);
		if (sig) sig.verification = verification;
	}
	updateGateContent(): void { /* noop */ }
	updateGateMetadata(): void { /* noop */ }
	cascadeReset(): void { /* noop */ }
	removeGoalGates(): void { /* noop */ }
}

function makePcm(opts: { goalStore: FakeGoalStore; gateStore: FakeGateStore }): any {
	const ctx = {
		project: { id: "proj-1" },
		goalStore: opts.goalStore,
		gateStore: opts.gateStore,
		projectConfigStore: { getWithDefaults: () => ({}), getComponents: () => [] },
	};
	return { getContextForGoal: (_goalId: string) => ctx };
}

function buildHarness(deps: {
	goalStore: FakeGoalStore;
	gateStore: FakeGateStore;
}) {
	const broadcasts: any[] = [];
	const stateDir = fs.mkdtempSync(path.join(TEST_DIR, "state-"));
	const harness = new VerificationHarness(
		stateDir,
		undefined,
		(_goalId: string, ev: any) => { broadcasts.push(ev); },
		{ get: () => null, getAll: () => [] } as any,
		undefined,
		undefined,
		undefined as any,
		undefined,
		makePcm(deps),
		undefined,
	);
	return { harness, broadcasts };
}

function makeReadyToMergeGate(verify: VerifyStep[] = []): WorkflowGate {
	return { id: "ready-to-merge", name: "Ready to merge", dependsOn: [], verify };
}

function makeSignal(goalId: string, gateId = "ready-to-merge"): GateSignal {
	return {
		id: `sig-${goalId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		gateId,
		goalId,
		sessionId: "sess-1",
		timestamp: Date.now(),
		commitSha: "deadbeef",
		verification: { status: "running", steps: [] },
	};
}

// A "trip-wire" verify step: type=command with a bash command we'd notice
// running. The short-circuit must NEVER reach this step. We don't actually
// expect it to run anyway in this synthetic harness (no real shell wired),
// but its presence proves the early-return branch fires *before* any
// verify[] iteration.
const TRIPWIRE_STEPS: VerifyStep[] = [
	{
		name: "Branch pushed to remote",
		type: "command",
		run: "git rev-parse --is-bare-repository",
		expect: "success",
		phase: 1,
	},
	{
		name: "Master merged into branch",
		type: "command",
		run: "exit 1",
		expect: "success",
		phase: 1,
	},
];

// ---------------------------------------------------------------------------

test("child goal (mergeTarget=parent) ready-to-merge short-circuits to passed", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	const child: FakeGoal = {
		id: "child-1",
		title: "Child A",
		cwd: "/tmp/child",
		state: "in-progress",
		parentGoalId: "parent-1",
		rootGoalId: "parent-1",
		branch: "goal/child-1",
		worktreePath: "/tmp/wt/child-1",
		projectId: "proj-1",
		mergeTarget: "parent",
		workflow: { gates: [makeReadyToMergeGate(TRIPWIRE_STEPS)] },
	};
	goalStore.put(child);
	gateStore.initGatesForGoal(child.id, ["ready-to-merge"]);

	const { harness, broadcasts } = buildHarness({ goalStore, gateStore });
	const signal = makeSignal(child.id);
	gateStore.recordSignal(signal);

	await harness.verifyGateSignal(
		signal,
		child.workflow!.gates[0],
		child.cwd,
		child.branch,
		"master",
		undefined,
		undefined,
	);

	// Gate must be marked passed.
	const gate = gateStore.getGate(child.id, "ready-to-merge");
	assert.equal(gate?.status, "passed", "ready-to-merge should be passed for child");

	// The recorded signal must contain exactly ONE synthetic step.
	const recorded = gate!.signals.find(s => s.id === signal.id);
	assert.ok(recorded, "signal must be recorded");
	assert.equal(recorded!.verification.status, "passed");
	assert.equal(recorded!.verification.steps.length, 1,
		"short-circuit must record exactly one synthetic step (no verify[] iteration)");
	assert.equal(recorded!.verification.steps[0].name, "Child ready-to-merge");
	assert.equal(recorded!.verification.steps[0].passed, true);
	assert.match(recorded!.verification.steps[0].output, /merge handled by parent/i);
	assert.equal(recorded!.verification.steps[0].duration_ms, 0);

	// Broadcast contracts.
	const completes = broadcasts.filter(b => b.type === "gate_verification_complete");
	assert.equal(completes.length, 1);
	assert.equal(completes[0].status, "passed");
	assert.equal(completes[0].goalId, child.id);
	assert.equal(completes[0].gateId, "ready-to-merge");

	const statusChanges = broadcasts.filter(b => b.type === "gate_status_changed");
	assert.equal(statusChanges.length, 1);
	assert.equal(statusChanges[0].status, "passed");

	// Critically: NO verification_started (it's emitted only on the
	// real verify[] path) and no per-step events.
	const starts = broadcasts.filter(b => b.type === "gate_verification_started");
	assert.equal(starts.length, 0,
		"short-circuit must NOT emit gate_verification_started — verify[] never ran");
	const stepEvents = broadcasts.filter(b => b.type === "gate_verification_step_started" || b.type === "gate_verification_step_completed");
	assert.equal(stepEvents.length, 0,
		"short-circuit must NOT emit any per-step events");
});

test("top-level goal (mergeTarget=master) ready-to-merge does NOT short-circuit — runs verify[]", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	// Top-level goal with mergeTarget="master". A trip-wire verify[] would
	// normally run; we use an *empty* verify[] so the harness takes the
	// "no verification — auto-pass" branch (which DOES emit
	// gate_verification_complete the same as short-circuit) but
	// distinguishably WITHOUT recording the synthetic "Child ready-to-merge"
	// step. That's the behavioural difference we assert on.
	const top: FakeGoal = {
		id: "top-1",
		title: "Top",
		cwd: "/tmp/top",
		state: "in-progress",
		rootGoalId: "top-1",
		branch: "goal/top-1",
		worktreePath: "/tmp/wt/top-1",
		projectId: "proj-1",
		mergeTarget: "master",
		workflow: { gates: [makeReadyToMergeGate([])] },
	};
	goalStore.put(top);
	gateStore.initGatesForGoal(top.id, ["ready-to-merge"]);

	const { harness } = buildHarness({ goalStore, gateStore });
	const signal = makeSignal(top.id);
	gateStore.recordSignal(signal);

	await harness.verifyGateSignal(
		signal,
		top.workflow!.gates[0],
		top.cwd,
		top.branch,
		"master",
		undefined,
		undefined,
	);

	// Empty verify[] auto-passes — but the short-circuit (which would record
	// the synthetic step) MUST NOT have fired. The auto-pass path records
	// `steps: []`.
	const gate = gateStore.getGate(top.id, "ready-to-merge");
	assert.equal(gate?.status, "passed");
	const recorded = gate!.signals.find(s => s.id === signal.id);
	assert.equal(recorded!.verification.steps.length, 0,
		"top-level goal must take the empty-verify auto-pass path, NOT the short-circuit");
});

test("top-level goal (mergeTarget undefined) ready-to-merge does NOT short-circuit", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	// Pre-migration goal with no mergeTarget — must be treated as top-level.
	const top: FakeGoal = {
		id: "legacy-1",
		title: "Legacy",
		cwd: "/tmp/legacy",
		state: "in-progress",
		rootGoalId: "legacy-1",
		branch: "goal/legacy-1",
		projectId: "proj-1",
		// mergeTarget intentionally omitted
		workflow: { gates: [makeReadyToMergeGate([])] },
	};
	goalStore.put(top);
	gateStore.initGatesForGoal(top.id, ["ready-to-merge"]);

	const { harness } = buildHarness({ goalStore, gateStore });
	const signal = makeSignal(top.id);
	gateStore.recordSignal(signal);

	await harness.verifyGateSignal(
		signal,
		top.workflow!.gates[0],
		top.cwd,
		top.branch,
		"master",
		undefined,
		undefined,
	);

	const gate = gateStore.getGate(top.id, "ready-to-merge");
	const recorded = gate!.signals.find(s => s.id === signal.id);
	assert.equal(recorded!.verification.steps.length, 0,
		"undefined mergeTarget = legacy top-level; short-circuit must NOT fire");
});

test("child goal short-circuit only triggers on `ready-to-merge` gate id", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	// Child with a non-RTM gate (e.g. `documentation`) and an empty verify[].
	const child: FakeGoal = {
		id: "child-doc-1",
		title: "Child doc",
		cwd: "/tmp/child-doc",
		state: "in-progress",
		parentGoalId: "parent-x",
		rootGoalId: "parent-x",
		branch: "goal/child-doc-1",
		projectId: "proj-1",
		mergeTarget: "parent",
		workflow: { gates: [{ id: "documentation", name: "Documentation", dependsOn: [], verify: [] }] },
	};
	goalStore.put(child);
	gateStore.initGatesForGoal(child.id, ["documentation"]);

	const { harness } = buildHarness({ goalStore, gateStore });
	const signal = makeSignal(child.id, "documentation");
	gateStore.recordSignal(signal);

	await harness.verifyGateSignal(
		signal,
		child.workflow!.gates[0],
		child.cwd,
		child.branch,
		"master",
		undefined,
		undefined,
	);

	const gate = gateStore.getGate(child.id, "documentation");
	const recorded = gate!.signals.find(s => s.id === signal.id);
	// `documentation` with empty verify[] takes the auto-pass path → steps: [].
	// The short-circuit's synthetic step would have name "Child ready-to-merge"
	// — its absence proves the short-circuit didn't fire on this gate id.
	assert.equal(recorded!.verification.steps.length, 0,
		"short-circuit must only trigger for gateId === 'ready-to-merge'");
});

// User-feedback regression from the agent-memory live test: the
// `feature` workflow's canonical `ready-to-merge` gate is master-
// hardcoded ("Branch pushed" / "Master merged into branch" / "PR raised")
// and the team-lead worried this would reject every nested child by
// design. Confirms the short-circuit fires for the EXACT canonical
// 3-step verify[] copied verbatim from
// `seed-default-workflows.ts::readyToMergeGate()`. None of the master-
// oriented steps run — the synthetic step records a pass and the
// parent's harness handles the local merge.
const CANONICAL_FEATURE_RTM_STEPS: VerifyStep[] = [
	{
		name: "Branch pushed to remote",
		type: "command",
		run: "git push origin {{branch}} && git ls-remote --heads origin {{branch}} | grep -q .",
	},
	{
		name: "Master merged into branch",
		type: "command",
		run: "git fetch origin {{master}} && git merge-base --is-ancestor origin/{{master}} {{branch}}",
	},
	{
		name: "PR raised",
		type: "command",
		run: "gh pr list --head {{branch}} --base {{master}} --state open --json url -q '.[0].url' | grep -q .",
	},
];

test("child on `feature` workflow short-circuits the canonical 3-step master-hardcoded ready-to-merge", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	const child: FakeGoal = {
		id: "feature-child-1",
		title: "Feature-workflow Child",
		cwd: "/tmp/fchild",
		state: "in-progress",
		parentGoalId: "parent-1",
		rootGoalId: "parent-1",
		branch: "goal/feature-child-1",
		worktreePath: "/tmp/wt/feature-child-1",
		projectId: "proj-1",
		mergeTarget: "parent",
		workflow: { gates: [makeReadyToMergeGate(CANONICAL_FEATURE_RTM_STEPS)] },
	};
	goalStore.put(child);
	gateStore.initGatesForGoal(child.id, ["ready-to-merge"]);

	const { harness, broadcasts } = buildHarness({ goalStore, gateStore });
	const signal = makeSignal(child.id);
	gateStore.recordSignal(signal);

	await harness.verifyGateSignal(
		signal,
		child.workflow!.gates[0],
		child.cwd,
		child.branch,
		"master",
		undefined,
		undefined,
	);

	const gate = gateStore.getGate(child.id, "ready-to-merge");
	assert.equal(gate?.status, "passed",
		"short-circuit must auto-pass even with the canonical master-hardcoded verify[]");

	const recorded = gate!.signals.find(s => s.id === signal.id);
	assert.equal(recorded!.verification.steps.length, 1,
		"none of the 3 master-hardcoded steps should run — only the synthetic short-circuit step");
	assert.equal(recorded!.verification.steps[0].name, "Child ready-to-merge");
	assert.equal(recorded!.verification.steps[0].passed, true);

	// No per-step events for any of "Branch pushed", "Master merged...", "PR raised".
	const stepEvents = broadcasts.filter(b => b.type === "gate_verification_step_started" || b.type === "gate_verification_step_completed");
	assert.equal(stepEvents.length, 0,
		"none of the canonical feature-workflow ready-to-merge steps should emit per-step events");
});
