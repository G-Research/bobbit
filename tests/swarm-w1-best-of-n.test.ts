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
 *   3. Every sibling is registered with the governor BEFORE its start is
 *      requested (§6 must-fix #1 depends on this ordering — a straggler
 *      clock that starts ticking after the team already exists would be a
 *      false negative window).
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

/** Fake scheduler surface: reports capacity-blocked once `cap` starts are in flight, mirroring `ChildTeamScheduler.requestStart`'s real contract. */
function makeFakeHarness(cap: number) {
	const swarmGovernor = new SwarmGovernor({ schedule: () => ({} as any), clear: () => {} });
	const registeredBeforeStart: string[] = [];
	const startedOrder: string[] = [];
	let running = 0;
	const harness: any = {
		swarmGovernor,
		requestChildStart(goalId: string): "started" | "capacity-blocked" {
			// Registration must have already happened for this goalId by the
			// time start is requested — pins ordering requirement #3.
			if (swarmGovernor.isRegistered(goalId)) registeredBeforeStart.push(goalId);
			if (running >= cap) return "capacity-blocked";
			running++;
			startedOrder.push(goalId);
			return "started";
		},
		hardKillSwarmNode: async () => {},
	};
	return { harness, registeredBeforeStart, startedOrder };
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
		harness.requestChildStart = (goalId: string) => {
			const rec = swarmGroupStore.getAll().find(g => g.expectedSiblingIds && g.expectedSiblingIds.length === 3);
			if (rec) sawGroupBeforeStart = true;
			return originalRequestChildStart(goalId);
		};
		const result = await createBestOfNSwarm(fakeDeps(harness), {
			parentGoalId: parent.id, title: "T", spec: "A shared prompt for every candidate to attempt independently.",
			siblings: [{}, {}, {}], tokenBudgetPerNode: 1000, wallClockMsPerNode: 1000, verifyCommand: "true",
		});
		assert.ok(sawGroupBeforeStart, "the group record with the full expected set must exist before the FIRST requestChildStart call");
		const rec = swarmGroupStore.get(result.swarmGroup)!;
		assert.deepEqual(new Set(rec.expectedSiblingIds), new Set(result.siblingGoalIds));
	});

	it("registers every sibling with the governor BEFORE requesting its start", async () => {
		const parent = await goalManager.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const { harness, registeredBeforeStart } = makeFakeHarness(8);
		const result = await createBestOfNSwarm(fakeDeps(harness), {
			parentGoalId: parent.id, title: "T", spec: "A shared prompt for every candidate to attempt independently.",
			siblings: [{}, {}], tokenBudgetPerNode: 1000, wallClockMsPerNode: 1000, verifyCommand: "true",
		});
		assert.equal(registeredBeforeStart.length, result.siblingGoalIds.length, "EVERY sibling must already be governor-registered by the time its start is requested");
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
