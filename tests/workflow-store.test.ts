/**
 * Workflow-store normalization & serialization — pins the
 * `label` / `optionalLabel` split and the loud-failure behaviour for
 * unknown step types.
 *
 * See:
 *   - `src/server/agent/workflow-store.ts::normalizeStep`
 *   - `src/server/agent/workflow-store.ts::serializeStep`
 *   - `docs/design/human-signoff-gates.md` (field-split rationale)
 *
 * Tested through the public `InlineWorkflowStore` API (writes
 * `project.yaml` to a tmp dir, then reads it back). This mirrors
 * `tests/inline-workflow-load.test.ts` and avoids exporting the
 * private normalization helpers just for tests.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-store-test-"));
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(configDir, { recursive: true });
});

function writeProjectYaml(obj: Record<string, unknown>): void {
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify(obj));
}

function makeStore(): InlineWorkflowStore {
	return new InlineWorkflowStore(new ProjectConfigStore(configDir));
}

/** Build a minimal project.yaml around a single workflow gate's verify[]. */
function projectFor(verify: unknown[]): Record<string, unknown> {
	return {
		components: [{ name: "app", repo: ".", commands: { build: "npm run build" } }],
		workflows: {
			wf: {
				id: "wf",
				name: "Test workflow",
				gates: [{ id: "g", name: "Gate", verify }],
			},
		},
	};
}

describe("normalizeStep — unknown type loud-failure", () => {
	it("throws on a present-but-unrecognised type value", () => {
		writeProjectYaml(projectFor([{ name: "approve", type: "human-approval", prompt: "ok" }]));
		const store = makeStore();
		assert.throws(
			() => store.getAll(),
			/Workflow step "approve" has unknown type: "human-approval"\. Expected one of: command, llm-review, agent-qa, subgoal, human-signoff/,
		);
	});

	it("does NOT throw when type:command (the canonical valid case)", () => {
		writeProjectYaml(projectFor([{ name: "build", type: "command", run: "npm run build" }]));
		const store = makeStore();
		const wfs = store.getAll();
		assert.equal(wfs.length, 1);
		assert.equal(wfs[0].gates[0].verify![0].type, "command");
	});

	it("defaults type to \"command\" when absent (documented behaviour)", () => {
		writeProjectYaml(projectFor([{ name: "no-type", run: "echo hi" }]));
		const store = makeStore();
		const step = store.getAll()[0].gates[0].verify![0];
		assert.equal(step.type, "command");
		assert.equal(step.run, "echo hi");
	});

	it("accepts each of the four valid type values", () => {
		writeProjectYaml(projectFor([
			{ name: "a", type: "command", run: "ok" },
			{ name: "b", type: "llm-review", prompt: "review" },
			{ name: "c", type: "agent-qa", prompt: "qa" },
			{ name: "d", type: "human-signoff", label: "Approve", prompt: "approve please" },
		]));
		const types = makeStore().getAll()[0].gates[0].verify!.map(s => s.type);
		assert.deepEqual(types, ["command", "llm-review", "agent-qa", "human-signoff"]);
	});
});

describe("normalizeStep — label / optionalLabel split & migration", () => {
	it("migrates an overloaded label on an optional non-human-signoff step", () => {
		writeProjectYaml(projectFor([
			{ name: "QA", type: "agent-qa", prompt: "qa", optional: true, label: "Enable QA" },
		]));
		const step = makeStore().getAll()[0].gates[0].verify![0];
		assert.equal(step.optionalLabel, "Enable QA");
		assert.equal(step.label, undefined,
			"legacy `label` on an optional non-human-signoff step must be moved to `optionalLabel`, not duplicated");
	});

	it("keeps label on a human-signoff step (no migration in that direction)", () => {
		writeProjectYaml(projectFor([
			{ name: "approve", type: "human-signoff", label: "Approve design", prompt: "do it" },
		]));
		const step = makeStore().getAll()[0].gates[0].verify![0];
		assert.equal(step.label, "Approve design");
		assert.equal(step.optionalLabel, undefined);
	});

	it("keeps both label and optionalLabel when both are explicit on a human-signoff + optional step", () => {
		writeProjectYaml(projectFor([
			{
				name: "approve",
				type: "human-signoff",
				optional: true,
				label: "Approve release",
				optionalLabel: "Enable release sign-off",
				prompt: "approve please",
			},
		]));
		const step = makeStore().getAll()[0].gates[0].verify![0];
		assert.equal(step.label, "Approve release");
		assert.equal(step.optionalLabel, "Enable release sign-off");
	});

	it("drops stray label on non-human-signoff steps", () => {
		writeProjectYaml(projectFor([
			{ name: "build", type: "command", run: "npm run build", label: "stray label" },
		]));
		const step = makeStore().getAll()[0].gates[0].verify![0];
		assert.equal(step.label, undefined);
		assert.equal(step.optionalLabel, undefined);
	});

	it("prefers an explicit optionalLabel over migrating label", () => {
		writeProjectYaml(projectFor([
			{
				name: "QA",
				type: "agent-qa",
				prompt: "qa",
				optional: true,
				label: "Old overloaded label",
				optionalLabel: "New explicit label",
			},
		]));
		const step = makeStore().getAll()[0].gates[0].verify![0];
		assert.equal(step.optionalLabel, "New explicit label");
		assert.equal(step.label, undefined,
			"non-human-signoff `label` must be dropped so saves emit canonical shape");
	});
});

describe("InlineWorkflowStore — round-trip", () => {
	it("saved optionalLabel round-trips through put/getAll", () => {
		writeProjectYaml(projectFor([]));
		const store = makeStore();

		store.put({
			id: "wf",
			name: "Test workflow",
			description: "",
			gates: [{
				id: "g",
				name: "Gate",
				dependsOn: [],
				verify: [{
					name: "QA",
					type: "agent-qa",
					prompt: "qa",
					optional: true,
					optionalLabel: "Enable QA",
				}],
			}],
			createdAt: 0,
			updatedAt: 0,
		});

		// Re-read from disk through a fresh store instance.
		const reloaded = makeStore().getAll();
		const step = reloaded[0].gates[0].verify![0];
		assert.equal(step.optionalLabel, "Enable QA");
		assert.equal(step.label, undefined);

		// And the on-disk YAML uses the canonical key name.
		const raw = fs.readFileSync(path.join(configDir, "project.yaml"), "utf-8");
		assert.match(raw, /optionalLabel: Enable QA/);
		assert.doesNotMatch(raw, /^\s+label: Enable QA\s*$/m);
	});

	it("saved human-signoff label round-trips through put/getAll", () => {
		writeProjectYaml(projectFor([]));
		const store = makeStore();

		store.put({
			id: "wf",
			name: "Test workflow",
			description: "",
			gates: [{
				id: "g",
				name: "Gate",
				dependsOn: [],
				verify: [{
					name: "approve",
					type: "human-signoff",
					prompt: "review",
					label: "Approve design",
				}],
			}],
			createdAt: 0,
			updatedAt: 0,
		});

		const step = makeStore().getAll()[0].gates[0].verify![0];
		assert.equal(step.label, "Approve design");
		assert.equal(step.optionalLabel, undefined);
	});
});

// VER-05/W3.3 — the new `solo-fast` seed workflow (see
// tests/seed-default-workflows.test.ts for its shape assertions) goes
// through the exact same put()->normalizeWorkflow->serializeWorkflow->
// getAll() round trip every other seeded workflow does; pin that its
// snake_case `depends_on` / phased llm-review step survive that round trip
// intact, same as the other four built-ins.
describe("solo-fast seed workflow round-trips through put/getAll", () => {
	it("preserves gates, depends_on, and the single consolidated review step", async () => {
		const { buildDefaultWorkflows } = await import("../src/server/state-migration/seed-default-workflows.ts");
		const seeded = buildDefaultWorkflows("myproj")["solo-fast"];

		writeProjectYaml(projectFor([]));
		const store = makeStore();
		store.put(seeded as unknown as Parameters<InlineWorkflowStore["put"]>[0]);

		const roundTripped = makeStore().get("solo-fast");
		assert.ok(roundTripped, "solo-fast should round-trip through the store");
		assert.equal(roundTripped!.name, "Solo Fast");

		const gateIds = roundTripped!.gates.map((g) => g.id);
		assert.deepEqual(gateIds, ["implementation", "ready-to-merge"]);

		const readyToMerge = roundTripped!.gates.find((g) => g.id === "ready-to-merge")!;
		assert.deepEqual(readyToMerge.dependsOn, ["implementation"]);

		const impl = roundTripped!.gates.find((g) => g.id === "implementation")!;
		const reviews = (impl.verify ?? []).filter((s) => s.type === "llm-review");
		assert.equal(reviews.length, 1, "exactly one review step should survive the round trip");
		assert.equal(reviews[0]!.role, "reviewer");
		assert.equal(reviews[0]!.phase, 2);
		assert.ok(!(impl.verify ?? []).some((s) => s.name === "E2E tests"), "e2e should stay absent after round trip");
	});
});
