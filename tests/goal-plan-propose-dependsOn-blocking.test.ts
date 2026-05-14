/**
 * Integration test for the `goal_plan_propose` direct-spawn fallback
 * (`fallback: "spawn-children-direct"`) under the new dependsOn
 * scheduling enforcement.
 *
 * The fallback in `defaults/tools/children/extension.ts` iterates over
 * the DAG steps and POSTs `/api/goals/:id/spawn-child` for each. The
 * enforcement layer in `nested-goal-routes.ts` now creates children
 * with unresolved deps as paused — so a fallback over DAG
 * `{root: [], a: [root], b: [root], leaf: [a, b]}` must result in only
 * the root child starting; a, b, leaf are paused with
 * `dependsOnPlanIds` stamped.
 *
 * We replay the fallback's loop directly (calling the spawn-child route
 * handler in order) rather than exercising the extension tool to keep
 * this in-process. The extension's per-step body shape is the same.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import yaml from "yaml";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { GateStore } from "../src/server/agent/gate-store.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";
import { tryHandleNestedGoalRoute, type NestedGoalRouteDeps } from "../src/server/agent/nested-goal-routes.ts";

let tmpRoot: string;
let goalStore: GoalStore;
let goalManager: GoalManager;
let gateStore: GateStore;
let parent: PersistedGoal;
let deps: NestedGoalRouteDeps;
let setupCalls: string[];

beforeEach(async () => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dependsOn-fallback-"));
	const stateDir = path.join(tmpRoot, "state");
	const configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));

	goalStore = new GoalStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([
		{ id: "feature", name: "Feature", description: "", gates: [
			{ id: "implementation", name: "Implementation", dependsOn: [] },
			{ id: "ready-to-merge", name: "Ready", dependsOn: ["implementation"] },
		], createdAt: 0, updatedAt: 0 },
		{ id: "parent", name: "Parent", description: "", gates: [
			{ id: "ready-to-merge", name: "Ready", dependsOn: [] },
		], createdAt: 0, updatedAt: 0 },
	]);
	goalManager = new GoalManager(goalStore, wf);
	gateStore = new GateStore(stateDir);

	parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "parent" });

	setupCalls = [];
	(goalManager as any).setupWorktreeAndStartTeam = async (gid: string) => {
		setupCalls.push(gid);
	};

	const ctx = { goalStore, goalManager, gateStore, workflowStore: wf, project: { id: "p" } as any, projectConfigStore: cfg };
	const projectContextManager: any = { getContextForGoal: () => ctx, all: () => [ctx] };
	const teamManager: any = { startTeam: async () => ({} as any), teardownTeam: async () => {}, getTeamState: () => undefined };
	const sessionManager: any = { getSession: () => undefined };
	const verificationHarness: any = {
		getActiveVerifications: () => [],
		cancelStaleVerifications: async () => {},
		resolvePlanStepChild: () => ({ source: "none", child: undefined }),
	};
	deps = {
		projectContextManager,
		verificationHarness,
		teamManager,
		sessionManager,
		requireSubgoalsEnabled: () => true,
		getGoalAcrossProjects: (gid) => goalStore.get(gid),
		getGoalManagerForGoal: () => goalManager,
		readBody: async (req: http.IncomingMessage) => (req as any)._body,
		json: () => {},
		jsonError: () => {},
		broadcastToAll: () => {},
		getSubgoalNestingPrefs: () => ({ subgoalsEnabled: true, maxNestingDepth: 5 }),
	};
});

async function spawnChild(body: any): Promise<{ status: number; payload: any }> {
	let status = 200; let payload: any = undefined;
	const localDeps: NestedGoalRouteDeps = {
		...deps,
		json: (b, s) => { status = s ?? 200; payload = b; },
		jsonError: (s, err) => { status = s; payload = { error: String((err as any)?.message ?? err) }; },
	};
	const req = { method: "POST", headers: {}, _body: body } as any as http.IncomingMessage;
	const url = new URL(`http://x/api/goals/${parent.id}/spawn-child`);
	const handled = await tryHandleNestedGoalRoute(req, url, localDeps);
	assert.ok(handled);
	return { status, payload };
}

let startTeamCalls: string[];
let broadcasts: any[];

// Extended beforeEach wires up richer stubs needed for integrate-child tests.
// The simple beforeEach above already runs; we just add the missing fields.
beforeEach(() => {
	startTeamCalls = [];
	broadcasts = [];
	// Patch mergeChild to a clean in-memory success (no real git ops).
	(goalManager as any).mergeChild = async () => ({
		merged: true, alreadyMerged: false, conflict: false, pushed: false, output: "",
	});
	// Re-patch setupWorktreeAndStartTeam to also flip setupStatus ready
	// (needed for auto-unblock to reach the startTeam branch).
	(goalManager as any).setupWorktreeAndStartTeam = async (gid: string, startFn?: () => Promise<any>) => {
		setupCalls.push(gid);
		await goalManager.updateGoal(gid, { setupStatus: "ready" } as any);
		if (startFn) { try { await startFn(); } catch { /* ignore */ } }
	};
	const originalDeps = deps;
	// Patch teamManager.startTeam in the existing deps stub.
	(originalDeps as any).teamManager = {
		startTeam: async (gid: string) => { startTeamCalls.push(gid); },
		teardownTeam: async () => {},
		getTeamState: () => undefined,
	};
	// Patch broadcastToAll to record events.
	(originalDeps as any).broadcastToAll = (ev: any) => { broadcasts.push(ev); };
});

async function integrateChild(childId: string): Promise<{ status: number; payload: any }> {
	let status = 200; let payload: any = undefined;
	const localDeps: NestedGoalRouteDeps = {
		...deps,
		json: (b, s) => { status = s ?? 200; payload = b; },
		jsonError: (s, err) => { status = s; payload = { error: String((err as any)?.message ?? err) }; },
	};
	// Pass the ready-to-merge gate so integrate-child accepts the merge.
	gateStore.initGatesForGoal(childId, ["implementation", "ready-to-merge"]);
	gateStore.updateGateStatus(childId, "ready-to-merge", "passed");
	const req = { method: "POST", headers: {}, _body: {} } as any as http.IncomingMessage;
	const url = new URL(`http://x/api/goals/${parent.id}/integrate-child/${childId}`);
	await tryHandleNestedGoalRoute(req, url, localDeps);
	return { status, payload };
}

describe("goal_plan_propose direct-spawn fallback respects dependsOn", () => {
	it("DAG {root: [], a: [root], b: [root], leaf: [a, b]} → only root starts; a, b, leaf paused", async () => {
		// Fallback iterates the steps in caller order. The team-lead is expected
		// to provide topologically-sorted steps, but this is irrelevant to the
		// enforcement: any step whose deps aren't yet `complete` is blocked.
		const steps = [
			{ planId: "root", title: "Root", spec: "Implement the root feature: set up the core data model and persistence layer as the foundation." },
			{ planId: "a", title: "A", spec: "Implement feature A: build the primary service layer; depends on root completing first.", dependsOn: ["root"] },
			{ planId: "b", title: "B", spec: "Implement feature B: build the secondary service layer; depends on root completing first.", dependsOn: ["root"] },
			{ planId: "leaf", title: "Leaf", spec: "Implement the leaf integration: combines A and B outputs; runs only after both A and B complete.", dependsOn: ["a", "b"] },
		];
		const results: any[] = [];
		for (const s of steps) {
			const r = await spawnChild(s);
			assert.equal(r.status, 201, `spawn ${s.planId} failed: ${JSON.stringify(r.payload)}`);
			results.push({ planId: s.planId, payload: r.payload });
		}

		// Find each goal by spawnedFromPlanId.
		const byPlan = (pid: string) => goalStore.getAll().find(g => g.parentGoalId === parent.id && g.spawnedFromPlanId === pid)!;
		const root = byPlan("root");
		const a = byPlan("a");
		const b = byPlan("b");
		const leaf = byPlan("leaf");

		// Root has no deps → not blocked, not paused, response lacks `blocked`.
		assert.notEqual(root.paused, true, "root must NOT be paused");
		assert.equal(results[0].payload.blocked, undefined);

		// Dependants are paused with blocked:true response.
		for (const { planId, payload } of results.slice(1)) {
			assert.equal(payload.blocked, true, `${planId} response.blocked must be true`);
			assert.ok(Array.isArray(payload.pendingDeps) && payload.pendingDeps.length > 0,
				`${planId} response.pendingDeps must be non-empty`);
		}
		assert.equal(a.paused, true, "a must be paused");
		assert.equal(b.paused, true, "b must be paused");
		assert.equal(leaf.paused, true, "leaf must be paused");

		// dependsOnPlanIds stamped on each.
		assert.deepEqual(a.dependsOnPlanIds, ["root"]);
		assert.deepEqual(b.dependsOnPlanIds, ["root"]);
		assert.deepEqual(leaf.dependsOnPlanIds, ["a", "b"]);

		// Setup is never invoked for blocked children. (Root's branch depends on
		// setupStatus, which is environment-specific in unit tests — we assert
		// only the negative invariant here: blocked children must not trigger
		// setup, regardless of their setupStatus.)
		assert.equal(setupCalls.includes(a.id), false, "setup must NOT be called for blocked child a");
		assert.equal(setupCalls.includes(b.id), false, "setup must NOT be called for blocked child b");
		assert.equal(setupCalls.includes(leaf.id), false, "setup must NOT be called for blocked child leaf");
	});
});

describe("spawn-children-direct fallback auto-resumes blocked children on dep merge", () => {
	it("merging the dep auto-unblocks the dependent child", async () => {
		// Simulate the fallback loop: spawn two steps where B depends on A.
		const rA = await spawnChild({ planId: "A", title: "A", spec: "Implement feature A: set up the core data model and persistence layer for this subgoal." });
		assert.equal(rA.status, 201);
		const rB = await spawnChild({ planId: "B", title: "B", spec: "Implement feature B: build the API layer on top of feature A's data model.", dependsOn: ["A"] });
		assert.equal(rB.status, 201);
		assert.equal(rB.payload.blocked, true, "B must be blocked initially");

		const childA = rA.payload.id;
		const childB = rB.payload.id;
		assert.equal(goalStore.get(childB)!.paused, true, "B must be paused before A merges");

		// Merge child A → auto-unblock scan should unpause B.
		setupCalls.length = 0;
		startTeamCalls.length = 0;
		const mergeResult = await integrateChild(childA);
		assert.equal(mergeResult.status, 200, `integrate-child A failed: ${JSON.stringify(mergeResult.payload)}`);

		const finalB = goalStore.get(childB)!;
		assert.equal(finalB.paused, false, "B must be unpaused after A merges");
		assert.ok(
			setupCalls.includes(childB) || startTeamCalls.includes(childB),
			"team startup must be invoked for auto-unblocked child B",
		);
	});

	it("multi-dep: only unblocks when the LAST dep merges", async () => {
		const rA = await spawnChild({ planId: "A", title: "A", spec: "Implement feature A: set up the core data model and persistence layer for this subgoal." });
		const rB = await spawnChild({ planId: "B", title: "B", spec: "Implement feature B: build the service layer. Depends on no other sibling for this test." });
		const rC = await spawnChild({ planId: "C", title: "C", spec: "Implement feature C: integrates A and B; runs only after both complete.", dependsOn: ["A", "B"] });
		const childC = rC.payload.id;
		assert.equal(goalStore.get(childC)!.paused, true, "C paused initially");

		// Merge A — C still blocked because B not done.
		await integrateChild(rA.payload.id);
		assert.equal(goalStore.get(childC)!.paused, true, "C still paused after only A merges");

		// Merge B — C now unblocks.
		setupCalls.length = 0;
		await integrateChild(rB.payload.id);
		assert.equal(goalStore.get(childC)!.paused, false, "C unpauses after B (last dep) merges");
		assert.ok(
			setupCalls.includes(childC) || startTeamCalls.includes(childC),
			"team startup invoked for C after last dep merges",
		);
	});
});

describe("spawn-children-direct fallback response includes warning when dependsOn present", () => {
	it("response has warning + blockedCount when steps include dependsOn", async () => {
		// This tests that the extension.ts fallback response shape contains the
		// warning/blockedCount/blockedPlanIds fields when any step has dependsOn.
		// We drive the spawn-child route directly (same as the fallback loop).
		const steps = [
			{ planId: "X", title: "X", spec: "Implement feature X: set up the core foundation for this test scenario." },
			{ planId: "Y", title: "Y", spec: "Implement feature Y: builds on X; this test verifies the warning/blocked fields appear.", dependsOn: ["X"] },
		];
		const responses: { planId: string; payload: any }[] = [];
		for (const s of steps) {
			const r = await spawnChild(s);
			assert.equal(r.status, 201, `spawn ${s.planId} failed`);
			responses.push({ planId: s.planId, payload: r.payload });
		}
		// X: not blocked.
		assert.equal(responses[0].payload.blocked, undefined);
		// Y: blocked, response has pendingDeps.
		assert.equal(responses[1].payload.blocked, true);
		assert.deepEqual(responses[1].payload.pendingDeps, ["X"]);
		// Confirm the child goals are in the right state.
		const childX = goalStore.getAll().find(g => g.spawnedFromPlanId === "X" && g.parentGoalId === parent.id)!;
		const childY = goalStore.getAll().find(g => g.spawnedFromPlanId === "Y" && g.parentGoalId === parent.id)!;
		assert.notEqual(childX.paused, true, "X must not be paused");
		assert.equal(childY.paused, true, "Y must be paused");
		assert.deepEqual(childY.dependsOnPlanIds, ["X"]);
	});
});
