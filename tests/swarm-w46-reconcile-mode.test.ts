import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { GoalStore } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";
import { SwarmGroupStore } from "../src/server/agent/swarm-group-store.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-w46-reconcile-"));
	stateDir = path.join(tmpRoot, "state");
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));
});

function makeManager(opts?: { wireStore?: boolean }): { gm: GoalManager; swarmGroupStore: SwarmGroupStore } {
	const goalStore = new GoalStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([
		{ id: "feature", name: "Feature", description: "", gates: [{ id: "ready-to-merge", name: "Ready", dependsOn: [] }], createdAt: 0, updatedAt: 0 },
	]);
	const gm = new GoalManager(goalStore, wf);
	const swarmGroupStore = new SwarmGroupStore(stateDir);
	if (opts?.wireStore) gm.setSwarmGroupStore(swarmGroupStore);
	return { gm, swarmGroupStore };
}

async function makeParentAndChild(gm: GoalManager, swarmGroup = "grp-1") {
	const parent = await gm.createGoal("Parent", tmpRoot, { workflowId: "feature" });
	const child = await gm.createGoal("Worker", tmpRoot, { workflowId: "feature", parentGoalId: parent.id, swarmGroup });
	return { parent, child };
}

describe("SWARM-W4.6 — GoalManager.mergeChild reconcileMode choke point", () => {
	it("unset store: old two-arg construction still suppresses every swarm child", async () => {
		const { gm } = makeManager();
		const { parent, child } = await makeParentAndChild(gm);
		const outcome = await gm.mergeChild(parent.id, child.id);
		assert.equal(outcome.skippedSwarmGroup, true);
	});

	it("store wired, no group record: unchanged suppression", async () => {
		const { gm } = makeManager({ wireStore: true });
		const { parent, child } = await makeParentAndChild(gm);
		const outcome = await gm.mergeChild(parent.id, child.id);
		assert.equal(outcome.skippedSwarmGroup, true);
	});

	it("store wired, group record exists with reconcileMode absent: unchanged suppression", async () => {
		const { gm, swarmGroupStore } = makeManager({ wireStore: true });
		const { parent, child } = await makeParentAndChild(gm, "grp-absent");
		swarmGroupStore.createGroup("grp-absent", [child.id], parent.id, { parentGoalId: parent.id });
		const outcome = await gm.mergeChild(parent.id, child.id);
		assert.equal(outcome.skippedSwarmGroup, true);
	});

	it("store wired, group record exists with reconcileMode pick-best: unchanged suppression", async () => {
		const { gm, swarmGroupStore } = makeManager({ wireStore: true });
		const { parent, child } = await makeParentAndChild(gm, "grp-pick");
		swarmGroupStore.createGroup("grp-pick", [child.id], parent.id, { parentGoalId: parent.id, reconcileMode: "pick-best" });
		const outcome = await gm.mergeChild(parent.id, child.id);
		assert.equal(outcome.skippedSwarmGroup, true);
	});

	it("store wired, reconcileMode merge-all: bypasses suppression and reaches the real merge path", async () => {
		const { gm, swarmGroupStore } = makeManager({ wireStore: true });
		const { parent, child } = await makeParentAndChild(gm, "grp-merge-all");
		swarmGroupStore.createGroup("grp-merge-all", [child.id], parent.id, { parentGoalId: parent.id, reconcileMode: "merge-all" });
		await assert.rejects(
			() => gm.mergeChild(parent.id, child.id),
			(err: any) => err.code === "GOAL_GIT_UNAVAILABLE",
		);
	});

	it("source pin: goal-manager reads the literal `reconcileMode` in exactly one place", () => {
		const src = fs.readFileSync(path.join(process.cwd(), "src/server/agent/goal-manager.ts"), "utf8");
		const hits = src.split(/\r?\n/).flatMap((line, i) => line.includes("reconcileMode") ? [{ line: i + 1, text: line.trim() }] : []);
		assert.equal(hits.length, 1, `expected exactly one reconcileMode read in goal-manager.ts, found:\n${hits.map(h => `${h.line}: ${h.text}`).join("\n")}`);
		assert.match(hits[0].text, /swarmGroupStore\?\.get\(child\.swarmGroup\)\?\.reconcileMode !== "merge-all"/);
	});
});
