/**
 * SWARM-W1 — `createBestOfNSwarm` (design/swarm-orchestration.md §4/§11
 * Wave 1). Exercises the ONE orchestration entry point end-to-end at the
 * module level (real `GoalManager`/`GoalStore`/`SwarmGroupStore`, a fake
 * `harness` standing in for `VerificationHarness`'s scheduler + governor
 * surface) proving, in order:
 *
 *   1. N sibling goals are created, each stamped `swarmGroup` (which forces
 *      `subgoalsAllowed=false`/`maxNestingDepth=0` per SWARM-W0 — asserted
 *      here too, since best-of-N siblings are lowered nodes).
 *   2. The expected-sibling set is persisted (`SwarmGroupStore.createGroup`)
 *      BEFORE any `requestChildStart` call — the SWARM-W0 carry-forward fix
 *      this module exists to close (§14 item 4).
 *   3. Every sibling that gets a free permit is registered with the governor
 *      by the time its team actually starts (§6 must-fix #1). SWARM-W3
 *      (design/swarm-orchestration.md; the scheduler-hook gap flagged by
 *      docs/design/swarm-orchestration-w2.md) overturned the ORIGINAL
 *      version of this invariant — "every sibling is registered with the
 *      governor BEFORE its start is requested" — because that unconditional
 *      eager registration started a capacity-blocked sibling's straggler
 *      wall-clock deadline at request time, before its team ever ran. The
 *      governor is now armed via `requestChildStart`'s `onStart` hook, which
 *      fires exactly at actual team-start: immediately for a sibling with a
 *      free permit, or later (once dequeued) for a capacity-blocked one.
 *   4. `N > cap` (scheduler-invariant, §7): siblings the fake scheduler
 *      reports capacity-blocked are stamped `state:"blocked"` and returned
 *      in `capacityBlocked` — mirrors the real `requestChildStart` contract.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { GoalStore } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore, type WorkflowStore } from "../src/server/agent/workflow-store.ts";
import { SwarmGroupStore } from "../src/server/agent/swarm-group-store.ts";
import { SwarmGovernor } from "../src/server/agent/swarm-governor.ts";
import { createBestOfNSwarm } from "../src/server/agent/swarm-best-of-n.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;
let goalStore: GoalStore;
let goalManager: GoalManager;
let swarmGroupStore: SwarmGroupStore;
let workflowStore: WorkflowStore;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-w1-best-of-n-"));
	stateDir = path.join(tmpRoot, "state");
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));

	goalStore = new GoalStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	workflowStore = new InlineWorkflowStore(cfg);
	(workflowStore as InlineWorkflowStore).setBuiltins([
		{ id: "feature", name: "Feature", description: "", gates: [{ id: "ready-to-merge", name: "Ready", dependsOn: [] }], createdAt: 0, updatedAt: 0 },
	]);
	goalManager = new GoalManager(goalStore, workflowStore);
	swarmGroupStore = new SwarmGroupStore(stateDir);
});

/**
 * Fake scheduler surface: reports capacity-blocked once `cap` starts are in
 * flight, mirroring `ChildTeamScheduler.requestStart`'s real contract —
 * including its `onStart` hook, which fires immediately for a sibling with a
 * free "permit" and is stashed in `pendingOnStart` (keyed by goalId) for a
 * capacity-blocked one, to be invoked later by the test to simulate the real
 * scheduler draining its FIFO queue once a permit frees.
 */
function makeFakeHarness(cap: number) {
	const swarmGovernor = new SwarmGovernor({ schedule: () => ({} as any), clear: () => {} });
	const startedOrder: string[] = [];
	const pendingOnStart = new Map<string, () => void>();
	let running = 0;
	const harness: any = {
		swarmGovernor,
		requestChildStart(goalId: string, onStart?: () => void): "started" | "capacity-blocked" {
			if (running >= cap) {
				if (onStart) pendingOnStart.set(goalId, onStart);
				return "capacity-blocked";
			}
			running++;
			startedOrder.push(goalId);
			onStart?.();
			return "started";
		},
		hardKillSwarmNode: async () => {},
	};
	return { harness, startedOrder, pendingOnStart };
}

function fakeDeps(harness: any) {
	const ctx: any = { goalStore, swarmGroupStore, workflowStore };
	return {
		getContextForGoal: (_goalId: string) => ctx,
		getGoalManagerForGoal: (_goalId: string) => goalManager,
		harness,
	};
}

describe("createBestOfNSwarm", () => {
	it("creates N swarm-tagged siblings, each with the structural cap forced (subgoalsAllowed=false, maxNestingDepth=0)", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const { harness } = makeFakeHarness(8);
		const result = await createBestOfNSwarm(fakeDeps(harness), {
			parentGoalId: parent.id,
			title: "Fix the bug",
			spec: "Reproduce and fix the reported bug — write a regression test.",
			siblings: [{}, {}, {}],
			tokenBudgetPerNode: 50_000,
			wallClockMsPerNode: 60_000,
			verifyCommand: "npm test",
		});
		assert.equal(result.siblingGoalIds.length, 3);
		for (const id of result.siblingGoalIds) {
			const g = goalStore.get(id)!;
			assert.equal(g.swarmGroup, result.swarmGroup);
			assert.equal(g.parentGoalId, parent.id);
			assert.equal(g.subgoalsAllowed, false, "swarm siblings must be lowered nodes — no further fan-out");
			assert.equal(g.maxNestingDepth, 0);
			assert.equal(g.spec, "Reproduce and fix the reported bug — write a regression test.", "best-of-N shares the SAME prompt across siblings");
		}
	});

	it("persists the expected-sibling set BEFORE any sibling is started (SWARM-W0 carry-forward fix)", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const { harness } = makeFakeHarness(8);
		let sawGroupBeforeStart = false;
		const originalRequestChildStart = harness.requestChildStart.bind(harness);
		harness.requestChildStart = (goalId: string, onStart?: () => void) => {
			const rec = swarmGroupStore.getAll().find(g => g.expectedSiblingIds && g.expectedSiblingIds.length === 3);
			if (rec) sawGroupBeforeStart = true;
			return originalRequestChildStart(goalId, onStart);
		};
		const result = await createBestOfNSwarm(fakeDeps(harness), {
			parentGoalId: parent.id, title: "T", spec: "A shared prompt for every candidate to attempt independently.",
			siblings: [{}, {}, {}], tokenBudgetPerNode: 1000, wallClockMsPerNode: 1000, verifyCommand: "true",
		});
		assert.ok(sawGroupBeforeStart, "the group record with the full expected set must exist before the FIRST requestChildStart call");
		const rec = swarmGroupStore.get(result.swarmGroup)!;
		assert.deepEqual(new Set(rec.expectedSiblingIds), new Set(result.siblingGoalIds));
	});

	it("registers an immediately-started sibling with the governor at start time; defers a capacity-blocked sibling's registration until its team actually starts (SWARM-W3 scheduler-hook fix)", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const { harness, pendingOnStart } = makeFakeHarness(1);
		const result = await createBestOfNSwarm(fakeDeps(harness), {
			parentGoalId: parent.id, title: "T", spec: "A shared prompt for every candidate to attempt independently.",
			siblings: [{}, {}], tokenBudgetPerNode: 1000, wallClockMsPerNode: 1000, verifyCommand: "true",
		});
		assert.equal(result.capacityBlocked.length, 1, "cap 1, 2 siblings — exactly one must be capacity-blocked");
		const blockedId = result.capacityBlocked[0];
		const startedId = result.siblingGoalIds.find(id => id !== blockedId)!;

		assert.ok(harness.swarmGovernor.isRegistered(startedId), "the immediately-started sibling must be governor-registered by the time createBestOfNSwarm returns");
		assert.ok(!harness.swarmGovernor.isRegistered(blockedId), "the capacity-blocked sibling must NOT be registered while merely queued — its straggler clock must not tick before its team runs");

		// Simulate the real scheduler later draining its FIFO queue once a permit frees.
		pendingOnStart.get(blockedId)!();
		assert.ok(harness.swarmGovernor.isRegistered(blockedId), "once its team actually starts, the previously-queued sibling is registered");
	});

	it("N > cap: siblings the scheduler reports capacity-blocked are stamped state='blocked' and returned in capacityBlocked", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const { harness } = makeFakeHarness(2);
		const result = await createBestOfNSwarm(fakeDeps(harness), {
			parentGoalId: parent.id, title: "T", spec: "A shared prompt for every candidate to attempt independently.",
			siblings: [{}, {}, {}, {}], tokenBudgetPerNode: 1000, wallClockMsPerNode: 1000, verifyCommand: "true",
		});
		assert.equal(result.capacityBlocked.length, 2, "4 siblings, cap 2 — exactly 2 must be capacity-blocked");
		for (const id of result.capacityBlocked) {
			assert.equal(goalStore.get(id)!.state, "blocked");
		}
		const started = result.siblingGoalIds.filter(id => !result.capacityBlocked.includes(id));
		for (const id of started) {
			assert.notEqual(goalStore.get(id)!.state, "blocked");
		}
	});

	it("per-sibling suggestedRole override is applied when supplied", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const { harness } = makeFakeHarness(8);
		const result = await createBestOfNSwarm(fakeDeps(harness), {
			parentGoalId: parent.id, title: "T", spec: "A shared prompt for every candidate to attempt independently.",
			siblings: [{ suggestedRole: "coder" }, { suggestedRole: "reviewer" }],
			tokenBudgetPerNode: 1000, wallClockMsPerNode: 1000, verifyCommand: "true",
		});
		assert.equal(goalStore.get(result.siblingGoalIds[0])!.suggestedRole, "coder");
		assert.equal(goalStore.get(result.siblingGoalIds[1])!.suggestedRole, "reviewer");
	});

	it("rejects N<2 — a single candidate is `solo`, not best-of-N", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const { harness } = makeFakeHarness(8);
		await assert.rejects(() =>
			createBestOfNSwarm(fakeDeps(harness), {
				parentGoalId: parent.id, title: "T", spec: "x", siblings: [{}],
				tokenBudgetPerNode: 1000, wallClockMsPerNode: 1000, verifyCommand: "true",
			}));
	});
});
