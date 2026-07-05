/**
 * SWARM-W2 — `reArmSwarmGovernorsOnBoot` (design/swarm-orchestration.md §11
 * Wave 2 "restart-resume"; the gap explicitly flagged by
 * docs/design/swarm-orchestration-w1.md's "Deliberately NOT built this wave"
 * note: "a hard-killed governor timer does not re-arm on restart (the
 * `SwarmGovernor` instance is in-memory only)").
 *
 * Exercises the boot-time sweep against REAL `GoalStore`/`SwarmGroupStore`
 * instances (restart-durable, on disk) with a fake `ProjectContextManager`/
 * `VerificationHarness` surface (only `.all()` / `.swarmGovernor` are used),
 * proving:
 *   1. A group whose barrier already fired is skipped entirely.
 *   2. A group with no persisted `config` (legacy/direct-`recordArtifact`
 *      callers) is skipped — nothing to re-arm a budget FROM.
 *   3. Within a live (unfired) group, only siblings WITHOUT a captured
 *      artifact are re-armed — a sibling that already went terminal must
 *      not be re-registered.
 *   4. A sibling goal that no longer exists (or is archived) is skipped
 *      silently, not treated as an error.
 *   5. The straggler wall-clock deadline re-armed reflects ELAPSED time
 *      since the sibling goal's `createdAt`, not a fresh full budget.
 *   6. Aggregates across multiple project contexts.
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
import { reArmSwarmGovernorsOnBoot } from "../src/server/agent/swarm-restart-resume.ts";

let tmpRoot: string;

function makeProject(id: string) {
	const dir = path.join(tmpRoot, id);
	const stateDir = path.join(dir, "state");
	const configDir = path.join(dir, "config");
	fs.mkdirSync(stateDir, { recursive: true });
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));

	const goalStore = new GoalStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const workflowStore: WorkflowStore = new InlineWorkflowStore(cfg);
	(workflowStore as InlineWorkflowStore).setBuiltins([
		{ id: "feature", name: "Feature", description: "", gates: [{ id: "ready-to-merge", name: "Ready", dependsOn: [] }], createdAt: 0, updatedAt: 0 },
	]);
	const goalManager = new GoalManager(goalStore, workflowStore);
	const swarmGroupStore = new SwarmGroupStore(stateDir);
	return { project: { id }, goalStore, goalManager, swarmGroupStore, workflowStore, dir };
}

function fakeHarness() {
	const registered: Array<{ goalId: string; budget: { tokenBudget: number; hardKillMarginMultiplier?: number; wallClockMs: number }; elapsedMs?: number }> = [];
	const swarmGovernor = new SwarmGovernor({ schedule: () => ({} as any), clear: () => {} });
	const originalRegisterNode = swarmGovernor.registerNode.bind(swarmGovernor);
	(swarmGovernor as any).registerNode = (goalId: string, budget: any, onStraggler: any, opts?: { elapsedMs?: number }) => {
		registered.push({ goalId, budget, elapsedMs: opts?.elapsedMs });
		return originalRegisterNode(goalId, budget, onStraggler, opts);
	};
	return { harness: { swarmGovernor, hardKillSwarmNode: async () => {} } as any, registered };
}

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-w2-restart-resume-"));
});

describe("reArmSwarmGovernorsOnBoot", () => {
	it("re-arms only the still-in-flight sibling of an unfired group", async () => {
		const p = makeProject("proj-a");
		const parent = await p.goalManager.createGoal("Parent", p.dir, { workflowId: "feature" });
		const done = await p.goalManager.createGoal("Sibling A", p.dir, { workflowId: "feature", parentGoalId: parent.id, swarmGroup: "swarm-1" });
		const running = await p.goalManager.createGoal("Sibling B", p.dir, { workflowId: "feature", parentGoalId: parent.id, swarmGroup: "swarm-1" });
		p.swarmGroupStore.createGroup("swarm-1", [done.id, running.id], parent.id, {
			parentGoalId: parent.id, tokenBudgetPerNode: 50_000, wallClockMsPerNode: 60_000, verifyCommand: "true",
		});
		p.swarmGroupStore.recordArtifact("swarm-1", { goalId: done.id, output: "", status: "done", verifierScore: null, capturedAt: Date.now() }, [done.id, running.id], parent.id);

		const { harness, registered } = fakeHarness();
		const pcm: any = { all: () => [p as any] };
		const result = reArmSwarmGovernorsOnBoot(pcm, harness);

		assert.equal(result.groupsScanned, 1);
		assert.equal(result.nodesReArmed, 1);
		assert.equal(registered.length, 1);
		assert.equal(registered[0].goalId, running.id, "the DONE sibling must not be re-armed — only the still-in-flight one");
	});

	it("skips a group whose barrier already fired", async () => {
		const p = makeProject("proj-b");
		const parent = await p.goalManager.createGoal("Parent", p.dir, { workflowId: "feature" });
		const a = await p.goalManager.createGoal("A", p.dir, { workflowId: "feature", parentGoalId: parent.id, swarmGroup: "swarm-2" });
		const b = await p.goalManager.createGoal("B", p.dir, { workflowId: "feature", parentGoalId: parent.id, swarmGroup: "swarm-2" });
		p.swarmGroupStore.createGroup("swarm-2", [a.id, b.id], parent.id, { parentGoalId: parent.id, tokenBudgetPerNode: 1000, wallClockMsPerNode: 1000, verifyCommand: "true" });
		p.swarmGroupStore.recordArtifact("swarm-2", { goalId: a.id, output: "", status: "done", verifierScore: null, capturedAt: Date.now() }, [a.id, b.id], parent.id);
		p.swarmGroupStore.recordArtifact("swarm-2", { goalId: b.id, output: "", status: "failed", verifierScore: null, capturedAt: Date.now() }, [a.id, b.id], parent.id);

		const { harness, registered } = fakeHarness();
		const result = reArmSwarmGovernorsOnBoot({ all: () => [p as any] } as any, harness);
		assert.equal(result.groupsScanned, 0, "a fully-barriered group has nothing left to re-arm");
		assert.equal(registered.length, 0);
	});

	it("skips a group with no persisted config (legacy/direct recordArtifact callers)", () => {
		const p = makeProject("proj-c");
		p.swarmGroupStore.recordArtifact("swarm-legacy", { goalId: "x", output: "", status: "failed", verifierScore: null, capturedAt: Date.now() }, ["x", "y"]);
		const { harness, registered } = fakeHarness();
		const result = reArmSwarmGovernorsOnBoot({ all: () => [p as any] } as any, harness);
		assert.equal(result.groupsScanned, 0);
		assert.equal(registered.length, 0);
	});

	it("skips a sibling whose goal record is gone or archived", async () => {
		const p = makeProject("proj-d");
		const parent = await p.goalManager.createGoal("Parent", p.dir, { workflowId: "feature" });
		const archived = await p.goalManager.createGoal("Archived", p.dir, { workflowId: "feature", parentGoalId: parent.id, swarmGroup: "swarm-3" });
		p.swarmGroupStore.createGroup("swarm-3", [archived.id, "ghost-goal-id"], parent.id, { parentGoalId: parent.id, tokenBudgetPerNode: 1000, wallClockMsPerNode: 1000, verifyCommand: "true" });
		await p.goalManager.archiveGoal(archived.id);

		const { harness, registered } = fakeHarness();
		const result = reArmSwarmGovernorsOnBoot({ all: () => [p as any] } as any, harness);
		assert.equal(result.groupsScanned, 1, "the group itself is still scan-eligible (config present, barrier unfired)");
		assert.equal(registered.length, 0, "neither the archived sibling nor the nonexistent ghost id should be re-armed");
	});

	it("computes elapsedMs from the sibling goal's createdAt, not a fresh wallClockMs budget", async () => {
		const p = makeProject("proj-e");
		const parent = await p.goalManager.createGoal("Parent", p.dir, { workflowId: "feature" });
		const running = await p.goalManager.createGoal("Running", p.dir, { workflowId: "feature", parentGoalId: parent.id, swarmGroup: "swarm-4" });
		p.swarmGroupStore.createGroup("swarm-4", [running.id], parent.id, { parentGoalId: parent.id, tokenBudgetPerNode: 1000, wallClockMsPerNode: 60_000, verifyCommand: "true" });

		const goal = p.goalStore.get(running.id)!;
		const fixedNow = goal.createdAt + 15_000; // pretend 15s of real elapsed time passed pre-restart
		(goal as any).createdAt = goal.createdAt; // sanity: unchanged

		const { harness, registered } = fakeHarness();
		reArmSwarmGovernorsOnBoot({ all: () => [p as any] } as any, harness, () => fixedNow);
		assert.equal(registered.length, 1);
		assert.equal(registered[0].elapsedMs, 15_000);
	});

	it("aggregates across multiple project contexts", async () => {
		const p1 = makeProject("multi-a");
		const p2 = makeProject("multi-b");
		const parent1 = await p1.goalManager.createGoal("Parent1", p1.dir, { workflowId: "feature" });
		const s1 = await p1.goalManager.createGoal("S1", p1.dir, { workflowId: "feature", parentGoalId: parent1.id, swarmGroup: "g1" });
		p1.swarmGroupStore.createGroup("g1", [s1.id], parent1.id, { parentGoalId: parent1.id, tokenBudgetPerNode: 1000, wallClockMsPerNode: 1000, verifyCommand: "true" });

		const parent2 = await p2.goalManager.createGoal("Parent2", p2.dir, { workflowId: "feature" });
		const s2 = await p2.goalManager.createGoal("S2", p2.dir, { workflowId: "feature", parentGoalId: parent2.id, swarmGroup: "g2" });
		p2.swarmGroupStore.createGroup("g2", [s2.id], parent2.id, { parentGoalId: parent2.id, tokenBudgetPerNode: 1000, wallClockMsPerNode: 1000, verifyCommand: "true" });

		const { harness, registered } = fakeHarness();
		const result = reArmSwarmGovernorsOnBoot({ all: () => [p1 as any, p2 as any] } as any, harness);
		assert.equal(result.groupsScanned, 2);
		assert.equal(result.nodesReArmed, 2);
		assert.deepEqual(new Set(registered.map(r => r.goalId)), new Set([s1.id, s2.id]));
	});
});
