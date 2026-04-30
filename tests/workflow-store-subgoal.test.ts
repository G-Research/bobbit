/**
 * Round-trip tests for the `subgoal` verify-step extension on
 * `InlineWorkflowStore` (nested goals — see docs/design/nested-goals.md §2.1
 * & §2.2).
 *
 * Verifies:
 *   - A workflow whose gate.verify[] contains a `subgoal` step persists
 *     through ProjectConfigStore::setWorkflows / getWorkflows().
 *   - All SubgoalStepParams fields (title, spec, workflowId, inlineWorkflow,
 *     suggestedRole, enabledOptionalSteps, planId, phase) survive the round-
 *     trip in serializeStep / normalizeStep.
 *   - Malformed subgoal payloads (missing planId / title) are warn-and-skip
 *     dropped from the loaded workflow.
 *   - snake_case aliases on inline YAML (workflow_id, plan_id, etc.) are
 *     accepted on the way in.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore, type Workflow, type VerifyStep, type SubgoalStepParams } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-store-subgoal-test-"));
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(configDir, { recursive: true });
});

function writeProjectYaml(obj: Record<string, unknown>): void {
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify(obj));
}

function makeStore(): InlineWorkflowStore {
	return new InlineWorkflowStore(new ProjectConfigStore(configDir));
}

describe("InlineWorkflowStore — subgoal verify step round-trip", () => {
	it("loads a subgoal step from project.yaml with all SubgoalStepParams fields", () => {
		writeProjectYaml({
			workflows: {
				parent: {
					id: "parent",
					name: "Parent Goal",
					gates: [
						{
							id: "execution",
							name: "Execution",
							verify: [
								{
									name: "Build API client subgoal",
									type: "subgoal",
									phase: 1,
									subgoal: {
										title: "Build API client",
										spec: "## Spec\nImplement the HTTP client.",
										workflowId: "feature",
										suggestedRole: "coder",
										enabledOptionalSteps: ["QA testing"],
										planId: "01HQX3PLAN1",
									},
								},
							],
						},
					],
				},
			},
		});
		const store = makeStore();
		const wf = store.get("parent");
		assert.ok(wf);
		const verify = wf!.gates[0].verify!;
		assert.equal(verify.length, 1);
		const step = verify[0];
		assert.equal(step.type, "subgoal");
		assert.equal(step.phase, 1);
		assert.ok(step.subgoal);
		const sg = step.subgoal!;
		assert.equal(sg.title, "Build API client");
		assert.match(sg.spec, /Implement the HTTP client/);
		assert.equal(sg.workflowId, "feature");
		assert.equal(sg.suggestedRole, "coder");
		assert.deepEqual(sg.enabledOptionalSteps, ["QA testing"]);
		assert.equal(sg.planId, "01HQX3PLAN1");
	});

	it("put() then re-read preserves every subgoal field including inlineWorkflow", () => {
		writeProjectYaml({});
		const store = makeStore();
		const inlineWf: Workflow = {
			id: "inline-child",
			name: "Inline Child",
			description: "",
			gates: [{ id: "ready-to-merge", name: "Ready", dependsOn: [] }],
			createdAt: 0,
			updatedAt: 0,
		};
		const subgoal: SubgoalStepParams = {
			title: "Inline child",
			spec: "Do the thing.",
			workflowId: "feature",
			inlineWorkflow: inlineWf,
			suggestedRole: "coder",
			enabledOptionalSteps: ["QA testing", "Security review"],
			planId: "01HQX3PLAN2",
			phase: 2,
		};
		const wf: Workflow = {
			id: "parent",
			name: "Parent",
			description: "",
			gates: [
				{
					id: "execution",
					name: "Execution",
					dependsOn: [],
					verify: [
						{ name: "Spawn inline child", type: "subgoal", phase: 2, subgoal },
					],
				},
			],
			createdAt: 0,
			updatedAt: 0,
		};
		store.put(wf);

		// Read back via a fresh store to make sure we hit serialize → disk → normalize.
		const store2 = makeStore();
		const round = store2.get("parent");
		assert.ok(round);
		const got = round!.gates[0].verify![0];
		assert.equal(got.type, "subgoal");
		assert.equal(got.phase, 2);
		assert.deepEqual(got.subgoal, subgoal);
	});

	it("warn-and-skip drops subgoal step missing planId", (t) => {
		// Suppress the expected console.warn so test output stays clean.
		const origWarn = console.warn;
		console.warn = () => {};
		t.after(() => { console.warn = origWarn; });
		writeProjectYaml({
			workflows: {
				parent: {
					id: "parent",
					name: "Parent",
					gates: [
						{
							id: "execution",
							name: "Execution",
							verify: [
								{
									name: "Bad subgoal",
									type: "subgoal",
									subgoal: { title: "x", spec: "y" /* no planId */ },
								},
								{
									name: "Good subgoal",
									type: "subgoal",
									subgoal: { title: "ok", spec: "ok", planId: "P1" },
								},
							],
						},
					],
				},
			},
		});
		const wf = makeStore().get("parent");
		assert.ok(wf);
		const verify = wf!.gates[0].verify!;
		assert.equal(verify.length, 1, "malformed subgoal step should be dropped");
		assert.equal(verify[0].name, "Good subgoal");
		assert.equal(verify[0].subgoal!.planId, "P1");
	});

	it("warn-and-skip drops subgoal step missing title", (t) => {
		const origWarn = console.warn;
		console.warn = () => {};
		t.after(() => { console.warn = origWarn; });
		writeProjectYaml({
			workflows: {
				parent: {
					id: "parent",
					name: "Parent",
					gates: [
						{
							id: "execution",
							name: "Execution",
							verify: [
								{
									name: "Bad subgoal — no title",
									type: "subgoal",
									subgoal: { spec: "y", planId: "P1" /* no title */ },
								},
							],
						},
					],
				},
			},
		});
		const wf = makeStore().get("parent");
		assert.ok(wf);
		const verify = wf!.gates[0].verify ?? [];
		assert.equal(verify.length, 0);
	});

	it("accepts snake_case aliases (workflow_id, plan_id, suggested_role, inline_workflow, enabled_optional_steps)", () => {
		writeProjectYaml({
			workflows: {
				parent: {
					id: "parent",
					name: "Parent",
					gates: [
						{
							id: "execution",
							name: "Execution",
							verify: [
								{
									name: "Snake-case subgoal",
									type: "subgoal",
									subgoal: {
										title: "Build it",
										spec: "Do the thing",
										workflow_id: "feature",
										suggested_role: "coder",
										enabled_optional_steps: ["QA testing"],
										plan_id: "P-SNAKE",
										inline_workflow: {
											id: "inline-x",
											name: "Inline X",
											gates: [{ id: "g", name: "G" }],
										},
									},
								},
							],
						},
					],
				},
			},
		});
		const wf = makeStore().get("parent");
		assert.ok(wf);
		const sg = wf!.gates[0].verify![0].subgoal!;
		assert.equal(sg.planId, "P-SNAKE");
		assert.equal(sg.workflowId, "feature");
		assert.equal(sg.suggestedRole, "coder");
		assert.deepEqual(sg.enabledOptionalSteps, ["QA testing"]);
		assert.ok(sg.inlineWorkflow);
		assert.equal((sg.inlineWorkflow as { id: string }).id, "inline-x");
	});

	it("non-subgoal step types are unchanged by the schema extension", () => {
		writeProjectYaml({
			components: [{ name: "api", repo: ".", commands: { build: "npm run build" } }],
			workflows: {
				wf: {
					id: "wf",
					name: "WF",
					gates: [
						{
							id: "implementation",
							name: "Implementation",
							verify: [
								{ name: "Build", type: "command", component: "api", command: "build" },
								{ name: "Review", type: "llm-review", prompt: "be thorough" },
							],
						},
					],
				},
			},
		});
		const wf = makeStore().get("wf");
		assert.ok(wf);
		const verify = wf!.gates[0].verify!;
		assert.equal(verify.length, 2);
		assert.equal(verify[0].type, "command");
		assert.equal(verify[0].subgoal, undefined);
		assert.equal(verify[1].type, "llm-review");
		assert.equal(verify[1].subgoal, undefined);
	});

	it("update() round-trips a subgoal step modification", () => {
		writeProjectYaml({
			workflows: {
				parent: {
					id: "parent",
					name: "Parent",
					gates: [
						{
							id: "execution",
							name: "Execution",
							verify: [
								{
									name: "Subgoal A",
									type: "subgoal",
									subgoal: { title: "A", spec: "old", planId: "P1" },
								},
							],
						},
					],
				},
			},
		});
		const store = makeStore();
		const wf = store.get("parent")!;
		// Mutate spec, write back via update().
		const newGates = wf.gates.map(g => ({
			...g,
			verify: g.verify?.map((s: VerifyStep): VerifyStep => (
				s.subgoal ? { ...s, subgoal: { ...s.subgoal, spec: "new spec" } } : s
			)),
		}));
		store.update("parent", { gates: newGates });
		const re = makeStore().get("parent")!;
		assert.equal(re.gates[0].verify![0].subgoal!.spec, "new spec");
		assert.equal(re.gates[0].verify![0].subgoal!.planId, "P1");
	});
});
