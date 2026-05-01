/**
 * Pinned regression: brand-new projects whose `.bobbit/config/project.yaml`
 * defines its own `workflows:` map without listing `parent` used to lose
 * access to the `parent` workflow entirely. `goal_spawn_child(workflowId:
 * "parent")` returned 400 with `Error: Workflow not found: parent`.
 *
 * Fix: `BuiltinConfigProvider.getWorkflows()` now returns the canonical
 * built-ins (general / feature / bug-fix / quick-fix / parent) and
 * `ProjectContextManager.setBuiltinWorkflows()` applies them to every
 * project's `InlineWorkflowStore`. Project-defined entries shadow same-id
 * builtins; absent ids fall through to the safety net.
 *
 * Pins:
 *   - `BuiltinConfigProvider.getWorkflows()` returns the five canonicals.
 *   - `parent` in particular has the gates the nested-goals harness needs:
 *     `charter \u2192 plan-review \u2192 goal-plan \u2192 execution \u2192 integration \u2192 ready-to-merge`.
 *   - `InlineWorkflowStore.getAll()` returns local + builtin merged.
 *   - `InlineWorkflowStore.get("parent")` resolves to the builtin when
 *     the project's `workflows:` map doesn't list it.
 *   - `ProjectContextManager.setBuiltinWorkflows()` applies to existing
 *     contexts AND lazily-created ones via `getOrCreate`.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { BuiltinConfigProvider } from "../src/server/agent/builtin-config.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-workflows-test-"));
	configDir = path.join(tmpRoot, ".bobbit", "config");
	fs.mkdirSync(configDir, { recursive: true });
});

function writeProjectYaml(obj: Record<string, unknown>): void {
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify(obj));
}

describe("BuiltinConfigProvider.getWorkflows()", () => {
	it("returns the five canonical built-in workflows", () => {
		const provider = new BuiltinConfigProvider();
		const wfs = provider.getWorkflows();
		const ids = wfs.map(w => w.id).sort();
		assert.deepEqual(ids, ["bug-fix", "feature", "general", "parent", "quick-fix"]);
	});

	// Pinned regression: the seeded workflows in `seed-default-workflows.ts`
	// use snake_case fields (`depends_on`, `inject_downstream`) on their
	// `SeededGate` shape. Before the fix at HEAD <next>, getWorkflows() cast
	// `wf.gates as Workflow["gates"]` directly, leaving `depends_on` in place
	// and `dependsOn` as `undefined` on the runtime gate. The gate-signal
	// route in `server.ts` then crashed with
	//   `TypeError: gateDef.dependsOn is not iterable`
	// the first time anyone signalled a gate from a project that used the
	// builtin `parent` workflow (e.g. agent-memory's v0.1 foundation child).
	it("every gate has dependsOn as an Array (camelCase, never undefined)", () => {
		const provider = new BuiltinConfigProvider();
		for (const wf of provider.getWorkflows()) {
			for (const gate of wf.gates) {
				assert.ok(Array.isArray(gate.dependsOn),
					`workflow=${wf.id} gate=${gate.id} — dependsOn must be an Array, got ${typeof gate.dependsOn}`);
			}
		}
	});

	it("`parent` workflow specifically: every gate has the right dependsOn array", () => {
		const provider = new BuiltinConfigProvider();
		const parent = provider.getWorkflows().find(w => w.id === "parent");
		assert.ok(parent);
		const byId = new Map(parent!.gates.map(g => [g.id, g]));
		assert.deepEqual(byId.get("charter")!.dependsOn, []);
		assert.deepEqual(byId.get("plan-review")!.dependsOn, ["charter"]);
		assert.deepEqual(byId.get("goal-plan")!.dependsOn, ["plan-review"]);
		assert.deepEqual(byId.get("execution")!.dependsOn, ["goal-plan"]);
		assert.deepEqual(byId.get("integration")!.dependsOn, ["execution"]);
		// `ready-to-merge` depended on "documentation" in the standard helper;
		// the parent workflow patches it to depend on "integration" since
		// parent has no documentation gate.
		assert.deepEqual(byId.get("ready-to-merge")!.dependsOn, ["integration"]);
	});

	it("`feature` workflow specifically: depends_on → dependsOn coercion (the agent-memory case)", () => {
		// agent-memory's child of a `parent`-workflow parent uses the
		// `feature` workflow. Its ready-to-merge canonically depends on
		// "documentation" — must show up as a camelCase array, not
		// undefined or as snake_case `depends_on`.
		const provider = new BuiltinConfigProvider();
		const feature = provider.getWorkflows().find(w => w.id === "feature");
		assert.ok(feature);
		const rtm = feature!.gates.find(g => g.id === "ready-to-merge");
		assert.ok(rtm);
		assert.ok(Array.isArray(rtm!.dependsOn));
		assert.deepEqual(rtm!.dependsOn, ["documentation"]);
		// And confirm snake_case is gone post-normalization.
		assert.equal((rtm as any).depends_on, undefined,
			"normalizeWorkflow must drop the snake_case alias — only camelCase survives");
	});

	it("each built-in has a non-empty name and at least one gate", () => {
		const provider = new BuiltinConfigProvider();
		const wfs = provider.getWorkflows();
		assert.equal(wfs.length, 5);
		for (const wf of wfs) {
			assert.ok(wf.name && wf.name.length > 0, `workflow ${wf.id} missing name`);
			assert.ok(wf.gates.length > 0, `workflow ${wf.id} has zero gates`);
		}
	});

	it("`parent` workflow has the canonical nested-goals gate sequence", () => {
		const provider = new BuiltinConfigProvider();
		const parent = provider.getWorkflows().find(w => w.id === "parent");
		assert.ok(parent, "parent workflow missing from builtins");
		const gateIds = parent!.gates.map(g => g.id);
		// Order-sensitive: charter \u2192 plan-review \u2192 goal-plan \u2192 execution \u2192 integration \u2192 ready-to-merge
		assert.deepEqual(gateIds, [
			"charter",
			"plan-review",
			"goal-plan",
			"execution",
			"integration",
			"ready-to-merge",
		]);
	});

	it("`parent.execution` gate starts with empty verify[] (populated by goal_plan_propose)", () => {
		const provider = new BuiltinConfigProvider();
		const parent = provider.getWorkflows().find(w => w.id === "parent");
		const execGate = parent!.gates.find(g => g.id === "execution");
		assert.ok(execGate, "execution gate missing");
		assert.deepEqual(execGate!.verify ?? [], []);
	});

	it("results are stable across calls (cached / deterministic)", () => {
		const provider = new BuiltinConfigProvider();
		const a = provider.getWorkflows().map(w => w.id).sort();
		const b = provider.getWorkflows().map(w => w.id).sort();
		assert.deepEqual(a, b);
	});
});

describe("InlineWorkflowStore + canonical builtin layer", () => {
	it("get('parent') resolves from builtins when project.yaml has no workflows: map", () => {
		writeProjectYaml({
			components: [{ name: "myapp", repo: "." }],
			// No `workflows:` key at all — project relies entirely on the safety net.
		});
		const cfg = new ProjectConfigStore(configDir);
		const store = new InlineWorkflowStore(cfg);
		const provider = new BuiltinConfigProvider();
		store.setBuiltins(provider.getWorkflows());

		const parent = store.get("parent");
		assert.ok(parent, "parent should be available via builtin layer");
		assert.equal(parent!.id, "parent");
		assert.equal(parent!.gates.find(g => g.id === "execution")?.id, "execution");
	});

	it("get('parent') resolves from builtins when project.yaml lists OTHER workflows but not `parent`", () => {
		// This is the exact agent-memory case from the live test \u2014
		// project.yaml lists general/feature/bug-fix/quick-fix/pr-review
		// but NOT parent, expecting the safety net to kick in.
		writeProjectYaml({
			components: [{ name: "myapp", repo: "." }],
			workflows: {
				general: { id: "general", name: "Local General", gates: [{ id: "g", name: "G" }] },
				"pr-review": { id: "pr-review", name: "PR Review", gates: [{ id: "g", name: "G" }] },
			},
		});
		const cfg = new ProjectConfigStore(configDir);
		const store = new InlineWorkflowStore(cfg);
		const provider = new BuiltinConfigProvider();
		store.setBuiltins(provider.getWorkflows());

		const parent = store.get("parent");
		assert.ok(parent, "parent should be available via builtin layer even when project lists other workflows");
		assert.equal(parent!.id, "parent");
	});

	it("project-defined workflow with same id as a builtin shadows the builtin", () => {
		writeProjectYaml({
			components: [{ name: "myapp", repo: "." }],
			workflows: {
				general: { id: "general", name: "Project Override General", gates: [{ id: "only", name: "Only" }] },
			},
		});
		const cfg = new ProjectConfigStore(configDir);
		const store = new InlineWorkflowStore(cfg);
		const provider = new BuiltinConfigProvider();
		store.setBuiltins(provider.getWorkflows());

		const general = store.get("general");
		assert.equal(general!.name, "Project Override General");
		assert.equal(general!.gates.length, 1);
		assert.equal(general!.gates[0].id, "only");
	});

	it("getAll() includes both project-defined AND builtin workflows when ids don't collide", () => {
		writeProjectYaml({
			components: [{ name: "myapp", repo: "." }],
			workflows: {
				custom: { id: "custom", name: "Custom", gates: [{ id: "g", name: "G" }] },
			},
		});
		const cfg = new ProjectConfigStore(configDir);
		const store = new InlineWorkflowStore(cfg);
		const provider = new BuiltinConfigProvider();
		store.setBuiltins(provider.getWorkflows());

		const all = store.getAll();
		const ids = all.map(w => w.id).sort();
		// custom + 5 builtins = 6 total.
		assert.deepEqual(ids, ["bug-fix", "custom", "feature", "general", "parent", "quick-fix"]);
	});

	it("getAllLocal() does NOT include builtins (only project-defined)", () => {
		writeProjectYaml({
			components: [{ name: "myapp", repo: "." }],
			workflows: {
				custom: { id: "custom", name: "Custom", gates: [{ id: "g", name: "G" }] },
			},
		});
		const cfg = new ProjectConfigStore(configDir);
		const store = new InlineWorkflowStore(cfg);
		const provider = new BuiltinConfigProvider();
		store.setBuiltins(provider.getWorkflows());

		const local = store.getAllLocal();
		assert.equal(local.length, 1);
		assert.equal(local[0].id, "custom");
	});
});


// Note: ProjectContextManager-level coverage of `setBuiltinWorkflows()` is
// exercised by the E2E `parent-workflow-availability.spec.ts` because
// importing PCM here pulls in flexsearch, which doesn't load under tsx's
// node-test runner. The unit tests above cover the core mechanism
// (BuiltinConfigProvider returns canonicals + InlineWorkflowStore.setBuiltins
// merges them under project-defined workflows). The PCM wiring is a
// trivial fan-out of `setBuiltins` over the contexts map.
