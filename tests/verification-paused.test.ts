/**
 * Tests for `goal.paused` awareness in `VerificationHarness` (Phase 5.3).
 *
 * Spec: docs/design/nested-goals.md §2.4 + Phase 5 task 5.3.
 *
 * Coverage:
 *   - Pausing a goal mid-flight (between phases) blocks phase advancement;
 *     the signal stays parked in `activeVerifications` and no further
 *     children are spawned.
 *   - Resuming the goal (clearing `paused`) unblocks the harness on the
 *     next poll tick — phase 2 advances and downstream subgoal steps spawn.
 *   - An ancestor pause (parent of the signal's goal) also blocks
 *     advancement on the descendant — the harness walks the parentGoalId
 *     chain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GateSignal, GateState } from "../src/server/agent/gate-store.ts";
import type { VerifyStep, WorkflowGate } from "../src/server/agent/workflow-store.ts";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-paused-test-"));
fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

// Tighter polling so the wait loop / pause loop is responsive in tests.
process.env.BOBBIT_SUBGOAL_POLL_MS = "20";
process.env.BOBBIT_PAUSE_POLL_MS = "20";

// ---------------------------------------------------------------------------
// Minimal in-memory mocks (mirror tests/verification-subgoal.test.ts shape).
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
	sandboxed?: boolean;
	paused?: boolean;
	workflow?: { gates: WorkflowGate[] };
}

class FakeGoalStore {
	private goals = new Map<string, FakeGoal>();
	put(g: FakeGoal): void { this.goals.set(g.id, { ...g }); }
	get(id: string): FakeGoal | undefined { return this.goals.get(id); }
	patch(id: string, p: Partial<FakeGoal>): void {
		const cur = this.goals.get(id);
		if (cur) this.goals.set(id, { ...cur, ...p });
	}
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

class FakeGoalManager {
	createCalls: any[] = [];
	mergeCalls: Array<[string, string]> = [];
	archiveCalls: string[] = [];
	mergeResult = { merged: true, conflict: false, output: "merged ok" };
	private nextId = 0;

	constructor(
		private store: FakeGoalStore,
		private gateStore: FakeGateStore,
		private cap = 3,
	) {}

	async createGoal(title: string, cwd: string, opts: any): Promise<FakeGoal> {
		this.createCalls.push({ title, cwd, opts });
		const id = `child-${++this.nextId}`;
		const child: FakeGoal = {
			id,
			title,
			cwd,
			state: "in-progress",
			parentGoalId: opts.parentGoalId,
			rootGoalId: this.store.get(opts.parentGoalId)?.rootGoalId ?? opts.parentGoalId,
			branch: `goal/${id}`,
			worktreePath: `/tmp/wt/${id}`,
			projectId: opts.projectId,
			workflow: { gates: [{ id: "ready-to-merge", name: "Ready to merge", dependsOn: [], verify: [] }] },
		};
		this.store.put(child);
		this.gateStore.initGatesForGoal(id, ["ready-to-merge"]);
		// Auto-flip ready-to-merge to passed quickly so the wait loop exits
		// (we want to reach the next phase boundary, where the pause check lives).
		setTimeout(() => {
			this.gateStore.updateGateStatus(id, "ready-to-merge", "passed");
		}, 25);
		return child as any;
	}

	updateGoal(_id: string, _patch: any): boolean { return true; }

	async mergeChild(parentId: string, childId: string): Promise<typeof this.mergeResult> {
		this.mergeCalls.push([parentId, childId]);
		return this.mergeResult;
	}

	async archiveGoal(id: string): Promise<boolean> {
		this.archiveCalls.push(id);
		this.store.patch(id, { state: "shelved" });
		return true;
	}

	resolveRootMaxConcurrentChildren(_rootId: string): number { return this.cap; }

	async setupWorktreeAndStartTeam(_id: string, _fn: () => Promise<any>): Promise<void> { /* noop */ }
	async setupWorktree(_id: string): Promise<void> { /* noop */ }

	getGoal(id: string): FakeGoal | undefined { return this.store.get(id); }
}

function makePcm(opts: {
	goalStore: FakeGoalStore;
	gateStore: FakeGateStore;
	goalManager: FakeGoalManager;
}): any {
	const ctx = {
		project: { id: "proj-1" },
		goalStore: opts.goalStore,
		gateStore: opts.gateStore,
		goalManager: opts.goalManager,
		projectConfigStore: { getWithDefaults: () => ({}), getComponents: () => [] },
	};
	return { getContextForGoal: (_goalId: string) => ctx };
}

function buildHarness(deps: {
	goalStore: FakeGoalStore;
	gateStore: FakeGateStore;
	goalManager: FakeGoalManager;
	broadcasts?: any[];
}) {
	const broadcasts = deps.broadcasts ?? [];
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
		makePcm({ goalStore: deps.goalStore, gateStore: deps.gateStore, goalManager: deps.goalManager }),
		undefined,
	);
	return { harness, broadcasts };
}

function makeParentGoal(id: string, verify: VerifyStep[]): FakeGoal {
	return {
		id,
		title: "Parent",
		cwd: "/tmp/parent",
		state: "in-progress",
		rootGoalId: id,
		branch: `goal/${id}`,
		worktreePath: `/tmp/wt/${id}`,
		projectId: "proj-1",
		workflow: { gates: [{ id: "execution", name: "Execution", dependsOn: [], verify }] },
	};
}

function makeSubgoalStep(planId: string, name: string, phase: number): VerifyStep {
	return {
		name,
		type: "subgoal",
		phase,
		subgoal: {
			planId,
			title: `Child ${planId}`,
			spec: `## Acceptance criteria\n- Build ${planId}`,
		},
	};
}

function makeSignal(parentId: string, gateId = "execution"): GateSignal {
	return {
		id: `sig-${parentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		gateId,
		goalId: parentId,
		sessionId: "sess-1",
		timestamp: Date.now(),
		commitSha: "deadbeef",
		verification: { status: "running", steps: [] },
	};
}

// ---------------------------------------------------------------------------

test("paused goal blocks phase advancement; resume re-advances", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	const goalManager = new FakeGoalManager(goalStore, gateStore);

	// Two phases, one subgoal step each. Pause the goal *between* them.
	const phase1 = makeSubgoalStep("PLAN-1", "step-1", 1);
	const phase2 = makeSubgoalStep("PLAN-2", "step-2", 2);
	const parent = makeParentGoal("parent-pause", [phase1, phase2]);
	goalStore.put(parent);
	gateStore.initGatesForGoal(parent.id, ["execution"]);

	// Wrap createGoal: the moment phase-1's child is spawned, flip the
	// parent goal to paused. The harness should drain phase 1 (wait + merge)
	// then PARK at the phase boundary — never spawning phase-2's child.
	const realCreate = goalManager.createGoal.bind(goalManager);
	let pausedAt: number | null = null;
	goalManager.createGoal = async (title: string, cwd: string, opts: any) => {
		const child = await realCreate(title, cwd, opts);
		// Pause right after the first child is spawned.
		if (goalManager.createCalls.length === 1) {
			goalStore.patch(parent.id, { paused: true });
			pausedAt = Date.now();
		}
		return child;
	};

	const { harness, broadcasts } = buildHarness({ goalStore, gateStore, goalManager });

	const signal = makeSignal(parent.id);
	gateStore.recordSignal(signal);

	const verifyPromise = harness.verifyGateSignal(
		signal,
		parent.workflow!.gates[0],
		parent.cwd,
		parent.branch,
		"master",
		undefined,
		undefined,
	);

	// Wait long enough for phase-1 to drain and the harness to be parked
	// at the phase-2 boundary. 400ms covers spawn(~0) + RTM-flip(25ms) +
	// merge(~0) + several pause-poll ticks (20ms each).
	await new Promise(r => setTimeout(r, 400));

	// Phase-1 child was spawned. Phase-2 must NOT have been spawned yet.
	assert.equal(goalManager.createCalls.length, 1,
		`paused goal must block phase-2 spawn (createCalls=${goalManager.createCalls.length})`);
	assert.ok(harness.getActiveVerifications(parent.id).length === 1,
		"signal should remain in activeVerifications while paused");
	assert.ok(pausedAt !== null);

	// Now resume: clear the paused flag. Within a few pause-poll ticks the
	// harness should advance to phase 2, spawn its child, wait for ready-to-merge,
	// merge, and complete the verification.
	goalStore.patch(parent.id, { paused: false });

	await verifyPromise;

	assert.equal(goalManager.createCalls.length, 2,
		"after resume, phase-2's child should spawn");
	assert.equal(goalManager.mergeCalls.length, 2,
		"both phase-1 and phase-2 children should be merged");
	const completes = broadcasts.filter(e => e.type === "gate_verification_complete");
	assert.equal(completes.length, 1);
	assert.equal(completes[0].status, "passed");
});

// ---------------------------------------------------------------------------

test("ancestor pause blocks descendant phase advancement", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	const goalManager = new FakeGoalManager(goalStore, gateStore);

	// Tree: root (paused) → child (signal lives here) → 2 phase steps.
	const root: FakeGoal = {
		id: "root-1",
		title: "Root",
		cwd: "/tmp/root",
		state: "in-progress",
		rootGoalId: "root-1",
		branch: "goal/root-1",
		paused: false,
		projectId: "proj-1",
		workflow: { gates: [] },
	};
	goalStore.put(root);

	const phase1 = makeSubgoalStep("D-PLAN-1", "d-step-1", 1);
	const phase2 = makeSubgoalStep("D-PLAN-2", "d-step-2", 2);
	const childGoal: FakeGoal = {
		id: "mid-1",
		title: "Mid",
		cwd: "/tmp/mid",
		state: "in-progress",
		parentGoalId: "root-1",
		rootGoalId: "root-1",
		branch: "goal/mid-1",
		worktreePath: "/tmp/wt/mid-1",
		projectId: "proj-1",
		workflow: { gates: [{ id: "execution", name: "Execution", dependsOn: [], verify: [phase1, phase2] }] },
	};
	goalStore.put(childGoal);
	gateStore.initGatesForGoal(childGoal.id, ["execution"]);

	// Pause the *root* (ancestor) after first descendant child spawns.
	const realCreate = goalManager.createGoal.bind(goalManager);
	goalManager.createGoal = async (title: string, cwd: string, opts: any) => {
		const c = await realCreate(title, cwd, opts);
		if (goalManager.createCalls.length === 1) {
			goalStore.patch("root-1", { paused: true });
		}
		return c;
	};

	const { harness } = buildHarness({ goalStore, gateStore, goalManager });

	const signal = makeSignal(childGoal.id);
	gateStore.recordSignal(signal);

	const verifyPromise = harness.verifyGateSignal(
		signal,
		childGoal.workflow!.gates[0],
		childGoal.cwd,
		childGoal.branch,
		"master",
		undefined,
		undefined,
	);

	await new Promise(r => setTimeout(r, 400));

	// Ancestor pause must block phase 2 spawn on the descendant signal.
	assert.equal(goalManager.createCalls.length, 1,
		"ancestor pause must block descendant phase-2 spawn");

	// Sanity: pause-check helper agrees.
	assert.equal((harness as any)._isGoalPausedForTest(childGoal.id), true,
		"descendant should report paused=true via ancestor walk");

	// Resume root — descendant should advance.
	goalStore.patch("root-1", { paused: false });
	await verifyPromise;

	assert.equal(goalManager.createCalls.length, 2);
});

// ---------------------------------------------------------------------------

test("isGoalPaused walks parent chain safely under cycles", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	const goalManager = new FakeGoalManager(goalStore, gateStore);

	// Construct a corrupted parent cycle: A → B → A. Neither paused.
	goalStore.put({ id: "A", title: "A", cwd: "/tmp/a", state: "in-progress", parentGoalId: "B", rootGoalId: "A", branch: "goal/A", projectId: "proj-1", workflow: { gates: [] } });
	goalStore.put({ id: "B", title: "B", cwd: "/tmp/b", state: "in-progress", parentGoalId: "A", rootGoalId: "A", branch: "goal/B", projectId: "proj-1", workflow: { gates: [] } });

	const { harness } = buildHarness({ goalStore, gateStore, goalManager });
	// Should return false (not paused) and NOT loop forever.
	assert.equal((harness as any)._isGoalPausedForTest("A"), false);
	assert.equal((harness as any)._isGoalPausedForTest("B"), false);

	// Now pause B → A's chain hits B and reports paused.
	goalStore.patch("B", { paused: true });
	assert.equal((harness as any)._isGoalPausedForTest("A"), true);
	assert.equal((harness as any)._isGoalPausedForTest("B"), true);
});
