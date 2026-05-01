/**
 * Tests for the `subgoal` verify-step branch on `VerificationHarness`
 * (nested goals — see docs/design/nested-goals.md §2.3, §2.4, §2.5, §6.2).
 *
 * Coverage:
 *   - happy path: child's ready-to-merge flips to "passed", parent harness
 *     calls mergeChild and the step passes;
 *   - idempotent re-spawn: a second `runSubgoalStep` invocation with the
 *     same planId rebinds to the existing child via the active record,
 *     never calls createGoal twice;
 *   - concurrency cap: 5 phase-1 subgoal steps with a tree-cap of 2 produce
 *     at most 2 concurrent child spawns;
 *   - cancel: parent verification cancellation tears down the child team
 *     and archives the child goal;
 *   - in-flight append (§6.2): a goal-store mutation adding a new subgoal
 *     verify step mid-flight is detected at the next phase iteration;
 *     the appended step's phase is bumped to `max(currentPhases) + 1`;
 *     the harness broadcasts `gate_verification_step_appended` and the
 *     appended step runs in a subsequent phase.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GateSignal, GateSignalStep, GateState } from "../src/server/agent/gate-store.ts";
import type { VerifyStep, WorkflowGate } from "../src/server/agent/workflow-store.ts";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-subgoal-test-"));
fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

// ---------------------------------------------------------------------------
// Minimal in-memory mocks for the harness's dependencies. The harness reads
// project context via projectContextManager.getContextForGoal(goalId), so the
// mocks live behind that interface.
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
	maxConcurrentChildren?: number;
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
	updateGateVerify(id: string, gateId: string, verify: VerifyStep[]): void {
		const cur = this.goals.get(id);
		if (!cur?.workflow) return;
		const gate = cur.workflow.gates.find(g => g.id === gateId);
		if (gate) gate.verify = verify;
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
	mergeResult: { merged: boolean; conflict: boolean; commitSha?: string; output: string } = {
		merged: true, conflict: false, output: "merged ok",
	};
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
			sandboxed: opts.sandboxed,
			workflow: { gates: [{ id: "ready-to-merge", name: "Ready to merge", dependsOn: [], verify: [] }] },
		};
		this.store.put(child);
		// Auto-init the ready-to-merge gate for the child so the harness's
		// poll loop can flip its status without crashing.
		this.gateStore.initGatesForGoal(id, ["ready-to-merge"]);
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

	async archiveGoalAfterMerge(id: string): Promise<boolean> {
		// Mirrors the production helper: stamp state=complete then archive.
		this.store.patch(id, { state: "complete" });
		this.archiveCalls.push(id);
		return true;
	}

	resolveRootMaxConcurrentChildren(_rootId: string): number { return this.cap; }

	async setupWorktreeAndStartTeam(_id: string, _fn: () => Promise<any>): Promise<void> { /* noop */ }
	async setupWorktree(_id: string): Promise<void> { /* noop */ }

	getGoal(id: string): FakeGoal | undefined { return this.store.get(id); }
}

class FakeTeamManager {
	teardownCalls: string[] = [];
	async teardownTeam(goalId: string): Promise<void> {
		this.teardownCalls.push(goalId);
	}
}

function makePcm(opts: {
	goalStore: FakeGoalStore;
	gateStore: FakeGateStore;
	goalManager: FakeGoalManager;
	projectId?: string;
}): any {
	const ctx = {
		project: { id: opts.projectId ?? "proj-1" },
		goalStore: opts.goalStore,
		gateStore: opts.gateStore,
		goalManager: opts.goalManager,
		projectConfigStore: { getWithDefaults: () => ({}), getComponents: () => [] },
	};
	return {
		getContextForGoal: (_goalId: string) => ctx,
	};
}

function buildHarness(deps: {
	goalStore: FakeGoalStore;
	gateStore: FakeGateStore;
	goalManager: FakeGoalManager;
	teamManager?: FakeTeamManager;
	broadcasts?: any[];
}) {
	const broadcasts = deps.broadcasts ?? [];
	const stateDir = fs.mkdtempSync(path.join(TEST_DIR, "state-"));
	const harness = new VerificationHarness(
		stateDir,
		undefined, // gateStore (resolved via pcm)
		(_goalId: string, ev: any) => { broadcasts.push(ev); },
		{ get: () => null, getAll: () => [] } as any, // roleStore
		undefined,
		undefined,
		deps.teamManager as any,
		undefined,
		makePcm({ goalStore: deps.goalStore, gateStore: deps.gateStore, goalManager: deps.goalManager }),
		undefined,
	);
	return { harness, broadcasts };
}

function makeParentGoal(id = "parent-1", verify: VerifyStep[] = []): FakeGoal {
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

function makeSubgoalStep(planId: string, name = `step-${planId}`, phase = 0): VerifyStep {
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

function makeSignal(parentId: string, verifySteps: VerifyStep[]): GateSignal {
	return {
		id: `sig-${parentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		gateId: "execution",
		goalId: parentId,
		sessionId: "sess-1",
		timestamp: Date.now(),
		commitSha: "deadbeef",
		verification: { status: "running", steps: [] },
	};
}

// Tighter polling for tests so the wait loop is responsive.
process.env.BOBBIT_SUBGOAL_POLL_MS = "20";

// ---------------------------------------------------------------------------

test("subgoal step happy path: spawn child, wait for ready-to-merge=passed, mergeChild succeeds, step passes", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	const goalManager = new FakeGoalManager(goalStore, gateStore);
	const teamManager = new FakeTeamManager();

	const parent = makeParentGoal("parent-happy");
	const subgoalStep = makeSubgoalStep("PLAN-A", "child-A");
	parent.workflow!.gates[0].verify = [subgoalStep];
	goalStore.put(parent);
	gateStore.initGatesForGoal(parent.id, ["execution"]);

	const { harness, broadcasts } = buildHarness({ goalStore, gateStore, goalManager, teamManager });

	const signal = makeSignal(parent.id, [subgoalStep]);
	gateStore.recordSignal(signal);

	// Flip child's ready-to-merge to "passed" after the harness has had a
	// chance to spawn + start polling.
	const flipper = setTimeout(() => {
		const child = goalManager.createCalls[0];
		if (!child) return; // not yet
		const childId = goalStore.get("child-1")?.id ?? "child-1";
		gateStore.updateGateStatus(childId, "ready-to-merge", "passed");
	}, 60);

	const verifyPromise = harness.verifyGateSignal(
		signal,
		parent.workflow!.gates[0],
		parent.cwd,
		parent.branch,
		"master",
		undefined,
		undefined,
	);

	// Belt-and-braces: keep flipping until the wait-loop sees the passed status.
	const interval = setInterval(() => {
		gateStore.updateGateStatus("child-1", "ready-to-merge", "passed");
	}, 30);

	await verifyPromise;
	clearTimeout(flipper);
	clearInterval(interval);

	assert.equal(goalManager.createCalls.length, 1, "child goal should have been spawned exactly once");
	assert.equal(goalManager.mergeCalls.length, 1, "mergeChild should have been called once");
	assert.deepEqual(goalManager.mergeCalls[0], [parent.id, "child-1"]);

	// Auto-archive on successful merge: child must be torn-down + archived.
	// Mirrors the agent-finished archival pattern; once the child's branch
	// is merged into the parent and the parent's verify step has accepted,
	// the child's worktree + team-lead session have served their purpose.
	assert.equal(teamManager.teardownCalls.length, 1, "team should be torn down post-merge");
	assert.deepEqual(teamManager.teardownCalls[0], "child-1");
	assert.equal(goalManager.archiveCalls.length, 1, "merged child should be archived");
	assert.deepEqual(goalManager.archiveCalls[0], "child-1");

	const completes = broadcasts.filter(e => e.type === "gate_verification_complete");
	assert.equal(completes.length, 1);
	assert.equal(completes[0].status, "passed");

	const stepCompletes = broadcasts.filter(e => e.type === "gate_verification_step_complete");
	assert.equal(stepCompletes.length, 1);
	assert.equal(stepCompletes[0].status, "passed");

	// Persistence: GateSignalStep should carry the subgoal idempotency record.
	const sig = gateStore.getGate(parent.id, "execution")!.signals[0];
	const finalStep = sig.verification.steps[0] as GateSignalStep;
	assert.equal(finalStep.type, "subgoal");
	assert.ok(finalStep.subgoal);
	assert.equal(finalStep.subgoal!.planId, "PLAN-A");
	assert.equal(finalStep.subgoal!.childGoalId, "child-1");
});

// ---------------------------------------------------------------------------

test("subgoal step is idempotent on planId — re-entry rebinds to existing child", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	const goalManager = new FakeGoalManager(goalStore, gateStore);

	const parent = makeParentGoal("parent-idem");
	const subgoalStep = makeSubgoalStep("PLAN-IDEM");
	parent.workflow!.gates[0].verify = [subgoalStep];
	goalStore.put(parent);
	gateStore.initGatesForGoal(parent.id, ["execution"]);

	const { harness } = buildHarness({ goalStore, gateStore, goalManager });

	const signal = makeSignal(parent.id, [subgoalStep]);
	gateStore.recordSignal(signal);

	// Pre-seed the persisted GateSignalStep with an existing child so the
	// harness must rebind via the persisted-step lookup path (idempotency
	// after restart).
	const prevSig: GateSignal = {
		...signal,
		id: signal.id + "-prev",
		verification: {
			status: "running",
			steps: [
				{
					name: subgoalStep.name,
					type: "subgoal",
					passed: false,
					output: "",
					duration_ms: 0,
					subgoal: { planId: "PLAN-IDEM", childGoalId: "child-existing" },
				},
			],
		},
	};
	gateStore.recordSignal(prevSig);
	// Place the existing child + its ready-to-merge gate in the store so
	// the wait loop sees it.
	goalStore.put({
		id: "child-existing",
		title: "Existing child",
		cwd: "/tmp/parent",
		state: "in-progress",
		parentGoalId: parent.id,
		rootGoalId: parent.id,
		branch: "goal/child-existing",
		worktreePath: "/tmp/wt/child-existing",
		projectId: "proj-1",
		workflow: { gates: [{ id: "ready-to-merge", name: "RtM", dependsOn: [], verify: [] }] },
	});
	gateStore.initGatesForGoal("child-existing", ["ready-to-merge"]);

	// Pre-flip the gate so the wait loop exits immediately on first poll.
	gateStore.updateGateStatus("child-existing", "ready-to-merge", "passed");

	// The harness's idempotency check looks at `active.steps[stepIndex].subgoal`
	// FIRST (the in-memory active-verification record), so for the post-restart
	// path we want the lookup to fall through to the persisted-step. To force
	// that, pass a *fresh* signal whose verification is empty in the active
	// record. The persisted-step lookup matches by signal.id — we hijack it by
	// running the harness against `prevSig`, which already has the persisted
	// record on it.
	await harness.verifyGateSignal(
		prevSig,
		parent.workflow!.gates[0],
		parent.cwd,
		parent.branch,
		"master",
		undefined,
		undefined,
	);

	assert.equal(goalManager.createCalls.length, 0, "createGoal should NOT be called when an existing childGoalId is recorded on the persisted step");
	assert.equal(goalManager.mergeCalls.length, 1, "mergeChild should still be called for the rebound child");
	assert.deepEqual(goalManager.mergeCalls[0], [parent.id, "child-existing"]);
});

// ---------------------------------------------------------------------------

test("concurrency cap: 5 phase-1 subgoal steps with cap=2 produce at most 2 concurrent spawns", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	const goalManager = new FakeGoalManager(goalStore, gateStore, /*cap*/ 2);

	const parent = makeParentGoal("parent-cap");
	const verify: VerifyStep[] = [
		makeSubgoalStep("P1", "step-P1", 1),
		makeSubgoalStep("P2", "step-P2", 1),
		makeSubgoalStep("P3", "step-P3", 1),
		makeSubgoalStep("P4", "step-P4", 1),
		makeSubgoalStep("P5", "step-P5", 1),
	];
	parent.workflow!.gates[0].verify = verify;
	goalStore.put(parent);
	gateStore.initGatesForGoal(parent.id, ["execution"]);

	let inFlight = 0;
	let maxInFlight = 0;
	const realCreate = goalManager.createGoal.bind(goalManager);
	goalManager.createGoal = async (title: string, cwd: string, opts: any) => {
		inFlight++;
		if (inFlight > maxInFlight) maxInFlight = inFlight;
		const child = await realCreate(title, cwd, opts);
		// Resolve the wait loop quickly so the next slot opens up.
		setTimeout(() => {
			gateStore.updateGateStatus(child.id, "ready-to-merge", "passed");
		}, 30);
		// Decrement when wait-loop exits + merge completes is too late;
		// approximate: decrement on the merge call.
		return child;
	};
	const realMerge = goalManager.mergeChild.bind(goalManager);
	goalManager.mergeChild = async (a: string, b: string) => {
		const r = await realMerge(a, b);
		inFlight--;
		return r;
	};

	const { harness } = buildHarness({ goalStore, gateStore, goalManager });
	const signal = makeSignal(parent.id, verify);
	gateStore.recordSignal(signal);

	await harness.verifyGateSignal(
		signal,
		parent.workflow!.gates[0],
		parent.cwd,
		parent.branch,
		"master",
		undefined,
		undefined,
	);

	assert.equal(goalManager.createCalls.length, 5, "all 5 subgoal children should be spawned over the run");
	assert.equal(goalManager.mergeCalls.length, 5);
	assert.ok(maxInFlight <= 2, `concurrency cap violated: maxInFlight=${maxInFlight}, expected <= 2`);
});

// ---------------------------------------------------------------------------

test("cancel: parent verification cancellation tears down the child team and archives the child goal", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	const goalManager = new FakeGoalManager(goalStore, gateStore);
	const teamManager = new FakeTeamManager();

	const parent = makeParentGoal("parent-cancel");
	const subgoalStep = makeSubgoalStep("PLAN-CANCEL");
	parent.workflow!.gates[0].verify = [subgoalStep];
	goalStore.put(parent);
	gateStore.initGatesForGoal(parent.id, ["execution"]);

	const { harness } = buildHarness({ goalStore, gateStore, goalManager, teamManager });

	const signal = makeSignal(parent.id, [subgoalStep]);
	gateStore.recordSignal(signal);

	// Don't flip ready-to-merge — leave it pending. Cancel after spawn.
	const verifyPromise = harness.verifyGateSignal(
		signal,
		parent.workflow!.gates[0],
		parent.cwd,
		parent.branch,
		"master",
		undefined,
		undefined,
	);

	// Wait until child is spawned, then cancel.
	for (let i = 0; i < 100 && goalManager.createCalls.length === 0; i++) {
		await new Promise(r => setTimeout(r, 10));
	}
	assert.equal(goalManager.createCalls.length, 1, "child should be spawned before we cancel");

	await harness.cancelAllVerifications(parent.id);
	await verifyPromise;

	assert.deepEqual(teamManager.teardownCalls, ["child-1"]);
	assert.deepEqual(goalManager.archiveCalls, ["child-1"]);
});

// ---------------------------------------------------------------------------

test("in-flight append (§6.2): mid-run subgoal verify step is detected, defaults to max-phase+1, broadcasts gate_verification_step_appended, runs in a later phase", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	const goalManager = new FakeGoalManager(goalStore, gateStore);

	const parent = makeParentGoal("parent-append");
	const initial = makeSubgoalStep("PLAN-INIT", "step-init", 1);
	parent.workflow!.gates[0].verify = [initial];
	goalStore.put(parent);
	gateStore.initGatesForGoal(parent.id, ["execution"]);

	const { harness, broadcasts } = buildHarness({ goalStore, gateStore, goalManager });

	const signal = makeSignal(parent.id, [initial]);
	gateStore.recordSignal(signal);

	// Spawn-then-flip-then-mutate orchestration: when the first child is
	// spawned, append a new subgoal step to the goal-store snapshot BEFORE
	// flipping the first child's ready-to-merge to passed. The harness
	// should pick up the append on its post-phase scan.
	let appended = false;
	const realCreate = goalManager.createGoal.bind(goalManager);
	goalManager.createGoal = async (title: string, cwd: string, opts: any) => {
		const child = await realCreate(title, cwd, opts);
		if (!appended) {
			appended = true;
			// Append a new subgoal step to the goal's snapshotted workflow.
			const appendedStep = makeSubgoalStep("PLAN-APPEND", "step-append" /* phase undefined → defaults */);
			goalStore.updateGateVerify(parent.id, "execution", [initial, appendedStep]);
		}
		// Flip ready-to-merge so phase-1 completes.
		setTimeout(() => {
			gateStore.updateGateStatus(child.id, "ready-to-merge", "passed");
		}, 30);
		return child;
	};

	await harness.verifyGateSignal(
		signal,
		parent.workflow!.gates[0],
		parent.cwd,
		parent.branch,
		"master",
		undefined,
		undefined,
	);

	const appendedEvents = broadcasts.filter(e => e.type === "gate_verification_step_appended");
	assert.equal(appendedEvents.length, 1, "harness should broadcast exactly one gate_verification_step_appended event");
	assert.equal(appendedEvents[0].stepName, "step-append");
	assert.equal(appendedEvents[0].planId, "PLAN-APPEND");
	// max(currentPhases) was 1 → appended phase should be 2.
	assert.equal(appendedEvents[0].phase, 2, `appended step phase should default to max(currentPhases)+1=2 but got ${appendedEvents[0].phase}`);

	// Both children should have been spawned (initial + appended).
	assert.equal(goalManager.createCalls.length, 2, "appended subgoal step should have been executed in a later phase");
	assert.equal(goalManager.mergeCalls.length, 2);

	// Final verdict is passed (both subgoals merged cleanly).
	const completes = broadcasts.filter(e => e.type === "gate_verification_complete");
	assert.equal(completes.length, 1);
	assert.equal(completes[0].status, "passed");
});

// ---------------------------------------------------------------------------

test("subgoal step does NOT archive the child when mergeChild fails (conflict)", async () => {
	// Pinned regression: auto-archive only fires on a clean merge. A merge
	// conflict leaves the child live so the team-lead can inspect, fix,
	// and retry. Without this guard, a merge conflict would archive the
	// child + lose the work-in-progress.
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	const goalManager = new FakeGoalManager(goalStore, gateStore);
	goalManager.mergeResult = { merged: false, conflict: true, output: "CONFLICT" };
	const teamManager = new FakeTeamManager();
	const { harness } = buildHarness({ goalStore, gateStore, goalManager, teamManager });

	const verifySteps = [makeSubgoalStep("PLAN-CONFLICT")];
	const parent = makeParentGoal("parent-conflict", verifySteps);
	goalStore.put(parent);
	gateStore.initGatesForGoal(parent.id, ["execution"]);
	const signal = makeSignal(parent.id, verifySteps);
	gateStore.recordSignal(signal);

	const verifyPromise = harness.verifyGateSignal(
		signal, parent.workflow!.gates[0], parent.cwd, parent.branch!, "master", undefined, undefined,
	);

	const flipper = setTimeout(() => {
		gateStore.updateGateStatus("child-1", "ready-to-merge", "passed");
	}, 50);
	const interval = setInterval(() => {
		gateStore.updateGateStatus("child-1", "ready-to-merge", "passed");
	}, 30);

	await verifyPromise;
	clearTimeout(flipper);
	clearInterval(interval);

	assert.equal(goalManager.mergeCalls.length, 1);
	// Critically: NO archive, NO teardown. Child stays live for retry.
	assert.equal(goalManager.archiveCalls.length, 0,
		"merge conflict must NOT archive the child — work-in-progress preserved for retry");
	assert.equal(teamManager.teardownCalls.length, 0,
		"merge conflict must NOT tear down the child team");
});
