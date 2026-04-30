/**
 * Inline workflow loader — see docs/design/multi-repo-components.md §3.2.
 *
 * Verifies:
 *   - InlineWorkflowStore reads from project.yaml::workflows.
 *   - Empty/missing workflows → goal creation rejects with the canonical message.
 *   - Valid workflows → getAll() returns them, builtins layered underneath.
 *   - Mutations (put/remove) round-trip through ProjectConfigStore.setWorkflows.
 *   - Validator rejects invalid step shapes via WorkflowManager.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore, type Workflow } from "../src/server/agent/workflow-store.ts";
import { WorkflowManager } from "../src/server/agent/workflow-manager.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { GoalStore } from "../src/server/agent/goal-store.ts";

let tmpRoot: string;
let configDir: string;
let stateDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inline-workflow-test-"));
	configDir = path.join(tmpRoot, "config");
	stateDir = path.join(tmpRoot, "state");
	fs.mkdirSync(configDir, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
});

function writeProjectYaml(obj: Record<string, unknown>): void {
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify(obj));
}

function makeStores(): { cfg: ProjectConfigStore; store: InlineWorkflowStore } {
	const cfg = new ProjectConfigStore(configDir);
	const store = new InlineWorkflowStore(cfg);
	return { cfg, store };
}

describe("InlineWorkflowStore — reads from project.yaml::workflows", () => {
	it("getAll() returns inline workflows", () => {
		writeProjectYaml({
			components: [{ name: "myapp", repo: ".", commands: { build: "npm run build", check: "npm run check" } }],
			workflows: {
				general: {
					id: "general",
					name: "General",
					gates: [
						{ id: "implementation", name: "Implementation", verify: [
							{ name: "Build", type: "command", component: "myapp", command: "build" },
						] },
					],
				},
			},
		});
		const { store } = makeStores();
		const all = store.getAll();
		assert.equal(all.length, 1);
		assert.equal(all[0].id, "general");
		assert.equal(all[0].gates.length, 1);
		assert.equal(all[0].gates[0].verify?.[0].component, "myapp");
		assert.equal(all[0].gates[0].verify?.[0].command, "build");
	});

	it("get(id) prefers local over builtins", () => {
		writeProjectYaml({
			workflows: {
				general: { id: "general", name: "Local General", gates: [{ id: "g", name: "G" }] },
			},
		});
		const { store } = makeStores();
		const builtin: Workflow = {
			id: "general",
			name: "Builtin General",
			description: "",
			gates: [{ id: "x", name: "X", dependsOn: [] }],
			createdAt: 0, updatedAt: 0,
		};
		store.setBuiltins([builtin]);
		assert.equal(store.get("general")?.name, "Local General");
	});

	it("empty file → getAll() returns only builtins", () => {
		writeProjectYaml({});
		const { store } = makeStores();
		const builtin: Workflow = {
			id: "feature", name: "Feature", description: "",
			gates: [{ id: "g", name: "G", dependsOn: [] }],
			createdAt: 0, updatedAt: 0,
		};
		store.setBuiltins([builtin]);
		const all = store.getAll();
		assert.equal(all.length, 1);
		assert.equal(all[0].id, "feature");
	});
});

describe("InlineWorkflowStore — mutations round-trip via ProjectConfigStore", () => {
	it("put() persists workflow into project.yaml", () => {
		writeProjectYaml({});
		const { cfg, store } = makeStores();
		store.put({
			id: "myflow", name: "My Flow", description: "",
			gates: [{ id: "g", name: "G", dependsOn: [] }],
			createdAt: 1, updatedAt: 1,
		});
		// Re-load fresh to confirm disk write.
		const cfg2 = new ProjectConfigStore(configDir);
		const block = cfg2.getWorkflows();
		assert.ok(block && "myflow" in block);
		assert.equal((block!.myflow as any).name, "My Flow");
		// Original cfg should also see it.
		assert.ok(cfg.getWorkflows()?.myflow);
	});

	it("remove() deletes from project.yaml", () => {
		writeProjectYaml({
			workflows: { a: { id: "a", name: "A", gates: [{ id: "g", name: "G" }] } },
		});
		const { store } = makeStores();
		assert.ok(store.get("a"));
		store.remove("a");
		const cfg2 = new ProjectConfigStore(configDir);
		const block = cfg2.getWorkflows();
		assert.ok(!block || !("a" in block));
	});
});

describe("Goal creation — empty workflows rejected", () => {
	it("throws canonical message when both local and builtins are empty", async () => {
		writeProjectYaml({});
		const { store } = makeStores();
		// No builtins set.
		const goalStore = new GoalStore(stateDir);
		const gm = new GoalManager(goalStore, store);
		await assert.rejects(
			() => gm.createGoal("test", tmpRoot, { workflowId: "general", workflowStore: store }),
			/no workflows configured/i,
		);
	});

	it("succeeds when a builtin workflow is available even if inline is empty", async () => {
		writeProjectYaml({});
		const { store } = makeStores();
		store.setBuiltins([{
			id: "general", name: "G", description: "",
			gates: [{ id: "g", name: "G", dependsOn: [] }],
			createdAt: 0, updatedAt: 0,
		}]);
		const goalStore = new GoalStore(stateDir);
		const gm = new GoalManager(goalStore, store);
		// Use a non-git tmp dir to avoid worktree creation in tests.
		const goal = await gm.createGoal("test", tmpRoot, { workflowId: "general", workflowStore: store });
		assert.equal(goal.workflowId, "general");
	});
});

describe("WorkflowManager — validator runs at create + update", () => {
	it("rejects invalid step shape (component+command+run all set)", () => {
		writeProjectYaml({
			components: [{ name: "api", repo: ".", commands: { build: "npm run build" } }],
		});
		const { cfg, store } = makeStores();
		const mgr = new WorkflowManager(store, cfg);
		assert.throws(
			() => mgr.createWorkflow({
				id: "bad", name: "Bad",
				gates: [{ id: "g", name: "G", dependsOn: [], verify: [
					{ name: "Step", type: "command", component: "api", command: "build", run: "extra" } as any,
				] }],
			}),
			/both "command" and "run"/i,
		);
	});

	it("rejects unknown component reference", () => {
		writeProjectYaml({
			components: [{ name: "api", repo: ".", commands: { build: "npm run build" } }],
		});
		const { cfg, store } = makeStores();
		const mgr = new WorkflowManager(store, cfg);
		assert.throws(
			() => mgr.createWorkflow({
				id: "bad", name: "Bad",
				gates: [{ id: "g", name: "G", dependsOn: [], verify: [
					{ name: "Step", type: "command", component: "apii", command: "build" } as any,
				] }],
			}),
			/component "apii" not found/i,
		);
	});

	it("rejects {{project.X}} tokens in run/prompt", () => {
		writeProjectYaml({
			components: [{ name: "api", repo: ".", commands: { build: "npm run build" } }],
		});
		const { cfg, store } = makeStores();
		const mgr = new WorkflowManager(store, cfg);
		assert.throws(
			() => mgr.createWorkflow({
				id: "bad", name: "Bad",
				gates: [{ id: "g", name: "G", dependsOn: [], verify: [
					{ name: "Step", type: "command", run: "{{project.build_command}}" },
				] }],
			}),
			/removed token/i,
		);
	});

	it("accepts valid component-linked step", () => {
		writeProjectYaml({
			components: [{ name: "api", repo: ".", commands: { build: "npm run build", check: "npm run check" } }],
		});
		const { cfg, store } = makeStores();
		const mgr = new WorkflowManager(store, cfg);
		const wf = mgr.createWorkflow({
			id: "good", name: "Good",
			gates: [{ id: "impl", name: "Impl", dependsOn: [], verify: [
				{ name: "Build", type: "command", component: "api", command: "build" },
			] }],
		});
		assert.equal(wf.id, "good");
		assert.equal(store.get("good")?.gates[0].verify?.[0].command, "build");
	});
});
