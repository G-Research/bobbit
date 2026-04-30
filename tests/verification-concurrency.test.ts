/**
 * Tests for the per-tree concurrency cap on subgoal verify steps in
 * `VerificationHarness` (Phase 5.3 hardening).
 *
 * Spec: docs/design/nested-goals.md §1.5 + §2.4 + Phase 5 task 5.3.
 *
 * The concurrency cap is keyed by `rootGoalId` — exactly one cap per
 * goal-tree. Different trees must NOT share a semaphore (no global cap).
 *
 * Coverage:
 *   - Single-tree cap: 5 plan nodes at phase 1 with cap=2 → at most 2
 *     concurrent in-flight subgoal children.
 *   - Cross-tree isolation: two roots, each with cap=2, running 4 children
 *     each → up to 4 (2 + 2) concurrent across the two trees, NOT capped at
 *     2 globally. Each tree gets its own semaphore.
 *   - Each rootGoalId gets exactly one Semaphore instance (not re-created
 *     per acquire).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GateSignal, GateState } from "../src/server/agent/gate-store.ts";
import type { VerifyStep, WorkflowGate } from "../src/server/agent/workflow-store.ts";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-concurrency-test-"));
fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

// Tighter polling for tests so the wait loop is responsive.
process.env.BOBBIT_SUBGOAL_POLL_MS = "20";

// ---------------------------------------------------------------------------
// Minimal in-memory mocks (mirror tests/verification-subgoal.test.ts).
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
	mergeResult = { merged: true, conflict: false, output: "merged ok" };
	private nextId = 0;
	private idPrefix: string;

	constructor(
		private store: FakeGoalStore,
		private gateStore: FakeGateStore,
		private cap = 2,
		idPrefix = "child",
	) {
		this.idPrefix = idPrefix;
	}

	async createGoal(title: string, cwd: string, opts: any): Promise<FakeGoal> {
		this.createCalls.push({ title, cwd, opts });
		const id = `${this.idPrefix}-${++this.nextId}`;
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
		return child as any;
	}

	updateGoal(_id: string, _patch: any): boolean { return true; }

	async mergeChild(parentId: string, childId: string): Promise<typeof this.mergeResult> {
		this.mergeCalls.push([parentId, childId]);
		return this.mergeResult;
	}

	async archiveGoal(_id: string): Promise<boolean> { return true; }

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
		title: id,
		cwd: `/tmp/${id}`,
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

function makeSignal(parentId: string): GateSignal {
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

// ---------------------------------------------------------------------------

test("single tree: 5 phase-1 subgoal steps with cap=2 → max 2 in flight", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	const goalManager = new FakeGoalManager(goalStore, gateStore, /*cap*/ 2);

	const verify: VerifyStep[] = [
		makeSubgoalStep("S1", "step-S1", 1),
		makeSubgoalStep("S2", "step-S2", 1),
		makeSubgoalStep("S3", "step-S3", 1),
		makeSubgoalStep("S4", "step-S4", 1),
		makeSubgoalStep("S5", "step-S5", 1),
	];
	const parent = makeParentGoal("parent-cap", verify);
	goalStore.put(parent);
	gateStore.initGatesForGoal(parent.id, ["execution"]);

	let inFlight = 0;
	let maxInFlight = 0;
	const realCreate = goalManager.createGoal.bind(goalManager);
	goalManager.createGoal = async (title: string, cwd: string, opts: any) => {
		inFlight++;
		if (inFlight > maxInFlight) maxInFlight = inFlight;
		const child = await realCreate(title, cwd, opts);
		// Resolve ready-to-merge after a small delay so multiple steps overlap
		// within the cap window.
		setTimeout(() => {
			gateStore.updateGateStatus(child.id, "ready-to-merge", "passed");
		}, 30);
		return child;
	};
	const realMerge = goalManager.mergeChild.bind(goalManager);
	goalManager.mergeChild = async (a: string, b: string) => {
		const r = await realMerge(a, b);
		inFlight--;
		return r;
	};

	const { harness } = buildHarness({ goalStore, gateStore, goalManager });
	const signal = makeSignal(parent.id);
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

	assert.equal(goalManager.createCalls.length, 5);
	assert.equal(goalManager.mergeCalls.length, 5);
	assert.ok(maxInFlight <= 2,
		`single-tree cap violated: maxInFlight=${maxInFlight}, expected <= 2`);
});

// ---------------------------------------------------------------------------

test("cross-tree isolation: two roots, cap=2 each → up to 4 concurrent (no global cap)", async () => {
	// Each tree gets its own gateStore/goalStore/goalManager so the harness
	// sees them as fully isolated trees with independent rootGoalIds.
	// We share a single VerificationHarness instance so the `subgoalSemaphores`
	// map is shared — that's the actual subject under test.

	const treeAStore = new FakeGoalStore();
	const treeAGate = new FakeGateStore();
	const treeAMgr = new FakeGoalManager(treeAStore, treeAGate, /*cap*/ 2, "A-child");

	const treeBStore = new FakeGoalStore();
	const treeBGate = new FakeGateStore();
	const treeBMgr = new FakeGoalManager(treeBStore, treeBGate, /*cap*/ 2, "B-child");

	const verifyA: VerifyStep[] = [
		makeSubgoalStep("A-S1", "A-step-1", 1),
		makeSubgoalStep("A-S2", "A-step-2", 1),
		makeSubgoalStep("A-S3", "A-step-3", 1),
		makeSubgoalStep("A-S4", "A-step-4", 1),
	];
	const verifyB: VerifyStep[] = [
		makeSubgoalStep("B-S1", "B-step-1", 1),
		makeSubgoalStep("B-S2", "B-step-2", 1),
		makeSubgoalStep("B-S3", "B-step-3", 1),
		makeSubgoalStep("B-S4", "B-step-4", 1),
	];

	const rootA = makeParentGoal("root-A", verifyA);
	const rootB = makeParentGoal("root-B", verifyB);
	treeAStore.put(rootA);
	treeBStore.put(rootB);
	treeAGate.initGatesForGoal(rootA.id, ["execution"]);
	treeBGate.initGatesForGoal(rootB.id, ["execution"]);

	// Build a PCM that routes by goalId across the two trees.
	const ctxA = {
		project: { id: "proj-A" },
		goalStore: treeAStore,
		gateStore: treeAGate,
		goalManager: treeAMgr,
		projectConfigStore: { getWithDefaults: () => ({}), getComponents: () => [] },
	};
	const ctxB = {
		project: { id: "proj-B" },
		goalStore: treeBStore,
		gateStore: treeBGate,
		goalManager: treeBMgr,
		projectConfigStore: { getWithDefaults: () => ({}), getComponents: () => [] },
	};
	const pcm: any = {
		getContextForGoal: (gid: string): any => {
			if (treeAStore.get(gid)) return ctxA;
			if (treeBStore.get(gid)) return ctxB;
			// Children created during the test land back in their tree's store;
			// prefer A first arbitrarily for unknown ids (the manager that
			// created them put them in their own store).
			return ctxA;
		},
	};

	// Track combined in-flight across BOTH trees, plus per-tree, with a
	// gate so we can hold all spawned children at "in-flight" simultaneously
	// to actually OBSERVE the cross-tree count.
	let combinedInFlight = 0;
	let maxCombined = 0;
	let maxPerTreeA = 0;
	let maxPerTreeB = 0;
	let inFlightA = 0;
	let inFlightB = 0;

	// Hold every child at the "waiting for ready-to-merge" stage until a
	// barrier opens. With cap=2 per tree and no cross-tree linkage we should
	// observe up to 4 concurrent children waiting.
	let release: (() => void) | null = null;
	const barrier = new Promise<void>(res => { release = res; });

	function instrument(mgr: FakeGoalManager, tree: "A" | "B") {
		const realCreate = mgr.createGoal.bind(mgr);
		mgr.createGoal = async (title: string, cwd: string, opts: any) => {
			combinedInFlight++;
			if (tree === "A") inFlightA++;
			else inFlightB++;
			if (combinedInFlight > maxCombined) maxCombined = combinedInFlight;
			if (inFlightA > maxPerTreeA) maxPerTreeA = inFlightA;
			if (inFlightB > maxPerTreeB) maxPerTreeB = inFlightB;
			const child = await realCreate(title, cwd, opts);
			// Hold at "waiting for ready-to-merge" until the barrier opens.
			// Note: the harness defensively re-inits the child's ready-to-merge
			// gate immediately after createGoal returns, so we delay the flip
			// by ~25ms to land after that re-init.
			(async () => {
				await barrier;
				await new Promise(r => setTimeout(r, 25));
				const gs = tree === "A" ? treeAGate : treeBGate;
				gs.updateGateStatus(child.id, "ready-to-merge", "passed");
			})();
			return child;
		};
		const realMerge = mgr.mergeChild.bind(mgr);
		mgr.mergeChild = async (a: string, b: string) => {
			const r = await realMerge(a, b);
			combinedInFlight--;
			if (tree === "A") inFlightA--;
			else inFlightB--;
			return r;
		};
	}
	instrument(treeAMgr, "A");
	instrument(treeBMgr, "B");

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
		pcm,
		undefined,
	);

	const sigA = makeSignal(rootA.id);
	const sigB = makeSignal(rootB.id);
	treeAGate.recordSignal(sigA);
	treeBGate.recordSignal(sigB);

	const pA = harness.verifyGateSignal(
		sigA, rootA.workflow!.gates[0], rootA.cwd, rootA.branch, "master", undefined, undefined,
	);
	const pB = harness.verifyGateSignal(
		sigB, rootB.workflow!.gates[0], rootB.cwd, rootB.branch, "master", undefined, undefined,
	);

	// Wait long enough for both trees to fill their cap=2 windows.
	// Poll: as soon as we observe inFlightA === 2 AND inFlightB === 2 we know
	// the per-tree caps are both engaged. This is the moment cross-tree
	// isolation can be verified — with a global cap, combinedInFlight would
	// never reach 4.
	const pollDeadline = Date.now() + 5000;
	while (Date.now() < pollDeadline) {
		if (inFlightA >= 2 && inFlightB >= 2) break;
		await new Promise(r => setTimeout(r, 20));
	}

	assert.ok(inFlightA >= 2,
		`tree A should have >= 2 in-flight (got ${inFlightA})`);
	assert.ok(inFlightB >= 2,
		`tree B should have >= 2 in-flight (got ${inFlightB})`);
	assert.ok(combinedInFlight >= 4,
		`combined cross-tree should be >= 4 — proves no global cap (got ${combinedInFlight})`);
	assert.ok(maxCombined >= 4,
		`maxCombined should reach >= 4 (got ${maxCombined}) — global cap would clamp to 2`);

	// Now release the barrier and let everything drain.
	release!();
	await Promise.all([pA, pB]);

	assert.equal(treeAMgr.createCalls.length, 4);
	assert.equal(treeBMgr.createCalls.length, 4);
	assert.ok(maxPerTreeA <= 2, `tree A cap violated: ${maxPerTreeA}`);
	assert.ok(maxPerTreeB <= 2, `tree B cap violated: ${maxPerTreeB}`);

	// Verify per-rootGoalId semaphore registry: exactly two entries, keyed
	// by the two distinct rootGoalIds.
	const sems: Map<string, any> = (harness as any)._getSubgoalSemaphores();
	assert.ok(sems.has(rootA.id), `semaphore for ${rootA.id} should be registered`);
	assert.ok(sems.has(rootB.id), `semaphore for ${rootB.id} should be registered`);
	assert.notEqual(sems.get(rootA.id), sems.get(rootB.id),
		"each rootGoalId must get its own Semaphore instance (cross-tree isolation)");
});

// ---------------------------------------------------------------------------

test("each rootGoalId gets exactly one Semaphore instance (no per-acquire churn)", async () => {
	const goalStore = new FakeGoalStore();
	const gateStore = new FakeGateStore();
	const goalManager = new FakeGoalManager(goalStore, gateStore, /*cap*/ 2);

	const verify: VerifyStep[] = [
		makeSubgoalStep("X1", "x-1", 1),
		makeSubgoalStep("X2", "x-2", 1),
		makeSubgoalStep("X3", "x-3", 1),
	];
	const parent = makeParentGoal("parent-singleton", verify);
	goalStore.put(parent);
	gateStore.initGatesForGoal(parent.id, ["execution"]);

	const realCreate = goalManager.createGoal.bind(goalManager);
	goalManager.createGoal = async (title: string, cwd: string, opts: any) => {
		const c = await realCreate(title, cwd, opts);
		setTimeout(() => gateStore.updateGateStatus(c.id, "ready-to-merge", "passed"), 20);
		return c;
	};

	const { harness } = buildHarness({ goalStore, gateStore, goalManager });

	const sems: Map<string, any> = (harness as any)._getSubgoalSemaphores();
	assert.equal(sems.size, 0, "registry empty before any verify run");

	const signal = makeSignal(parent.id);
	gateStore.recordSignal(signal);
	await harness.verifyGateSignal(
		signal, parent.workflow!.gates[0], parent.cwd, parent.branch, "master", undefined, undefined,
	);

	// After the run we should have exactly ONE semaphore for the root goal id.
	assert.equal(sems.size, 1);
	assert.ok(sems.has(parent.id));
	const sem = sems.get(parent.id);
	assert.equal(sem.capacity, 2);
});
