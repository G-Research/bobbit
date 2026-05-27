/**
 * Unit tests for the workflow validator — see docs/design/multi-repo-components.md §3.4.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	validateWorkflow,
	validateAllWorkflows,
	WorkflowResolveError,
	type ValidatorWorkflow,
	type WorkflowComponentRef,
} from "../src/server/agent/workflow-validator.ts";

const components: WorkflowComponentRef[] = [
	{ name: "api", commands: { build: "npm run build", test: "npm test", check: "npm run check" } },
	{ name: "web", commands: { build: "npm run build", test: "npm test" } },
	{ name: "shared" }, // data-only
];

describe("workflow-validator — positive cases", () => {
	it("accepts all three command step shapes", () => {
		const wf: ValidatorWorkflow = {
			id: "general",
			name: "General",
			gates: [{
				id: "implementation",
				name: "Implementation",
				verify: [
					{ name: "Build api", type: "command", component: "api", command: "build" },
					{ name: "Custom api", type: "command", component: "api", run: "./scripts/x.sh" },
					{ name: "Push", type: "command", run: "git push origin {{branch}}" },
				],
			}],
		};
		const errs = validateWorkflow(wf, components);
		assert.deepEqual(errs, []);
	});

	it("accepts llm-review and agent-qa step shapes", () => {
		const wf: ValidatorWorkflow = {
			id: "feature",
			name: "Feature",
			gates: [{
				id: "review",
				name: "Review",
				verify: [
					{ name: "Code review", type: "llm-review", role: "code-reviewer", prompt: "Review this." },
					{ name: "QA testing", type: "agent-qa", role: "qa-tester", prompt: "Run scenarios." },
				],
			}],
		};
		assert.deepEqual(validateWorkflow(wf, components), []);
	});

	it("accepts human-signoff step shape with prompt + label", () => {
		const wf: ValidatorWorkflow = {
			id: "signoff",
			name: "Signoff",
			gates: [{
				id: "design",
				name: "Design",
				verify: [
					{ name: "Approve design", type: "human-signoff", label: "Approve design doc", prompt: "Review the design doc and approve or reject." },
				],
			}],
		};
		assert.deepEqual(validateWorkflow(wf, components), []);
	});

	it("accepts optional non-signoff steps using canonical optionalLabel", () => {
		const wf: ValidatorWorkflow = {
			id: "optional-label",
			name: "Optional label",
			gates: [{
				id: "qa",
				name: "QA",
				verify: [
					{ name: "QA", type: "agent-qa", optional: true, optionalLabel: "Enable QA Testing", prompt: "Run QA." },
				],
			}],
		};
		assert.deepEqual(validateWorkflow(wf, components), []);
	});

	it("accepts runtime context tokens in free-form run/prompt without complaint", () => {
		const wf: ValidatorWorkflow = {
			id: "merge",
			name: "Merge",
			gates: [{
				id: "ready-to-merge",
				name: "Ready to Merge",
				verify: [
					{ name: "Push", type: "command", run: "git push origin {{branch}} && [ -n \"{{master}}\" ]" },
					{ name: "Sanity", type: "llm-review", prompt: "Goal: {{goal_spec}}, agent says {{agent.foo}}" },
				],
			}],
		};
		assert.deepEqual(validateWorkflow(wf, components), []);
	});
});

describe("workflow-validator — negative cases", () => {
	it("rejects unknown component with 'Did you mean…' suggestion", () => {
		const wf: ValidatorWorkflow = {
			id: "general",
			name: "General",
			gates: [{
				id: "implementation",
				name: "Implementation",
				verify: [{ name: "Build", type: "command", component: "apii", command: "build" }],
			}],
		};
		const errs = validateWorkflow(wf, components);
		assert.equal(errs.length, 1);
		const e = errs[0];
		assert.ok(e instanceof WorkflowResolveError);
		assert.match(e.message, /^Workflow "general", gate "implementation", step 1 \("Build"\): /);
		assert.match(e.message, /component "apii" not found/);
		assert.match(e.message, /Did you mean "api"\?/);
	});

	it("rejects unknown command on a known component", () => {
		const wf: ValidatorWorkflow = {
			id: "general",
			name: "General",
			gates: [{
				id: "implementation",
				name: "Implementation",
				verify: [{ name: "Lint", type: "command", component: "api", command: "lintt" }],
			}],
		};
		const errs = validateWorkflow(wf, components);
		assert.equal(errs.length, 1);
		assert.match(errs[0].message, /component "api" has no command "lintt"/);
		// "lintt" doesn't suggest from {build,test,check} — but should mention available list
		assert.match(errs[0].message, /Available: build, test, check/);
	});

	it("rejects step with both command: and run:", () => {
		const wf: ValidatorWorkflow = {
			id: "x", name: "X",
			gates: [{
				id: "g", name: "G",
				verify: [{ name: "Bad", type: "command", component: "api", command: "build", run: "echo nope" } as any],
			}],
		};
		const errs = validateWorkflow(wf, components);
		assert.equal(errs.length, 1);
		assert.match(errs[0].message, /both "command" and "run" set/);
	});

	it("rejects type:command step with neither command nor run", () => {
		const wf: ValidatorWorkflow = {
			id: "x", name: "X",
			gates: [{
				id: "g", name: "G",
				verify: [{ name: "Empty", type: "command", component: "api" } as any],
			}],
		};
		const errs = validateWorkflow(wf, components);
		assert.equal(errs.length, 1);
		assert.match(errs[0].message, /neither "command" nor "run" set/);
	});

	it("rejects command: without component:", () => {
		const wf: ValidatorWorkflow = {
			id: "x", name: "X",
			gates: [{
				id: "g", name: "G",
				verify: [{ name: "Loose", type: "command", command: "build" } as any],
			}],
		};
		const errs = validateWorkflow(wf, components);
		assert.equal(errs.length, 1);
		assert.match(errs[0].message, /has "command" but no "component"/);
	});

	it("rejects structural reference to a data-only component", () => {
		const wf: ValidatorWorkflow = {
			id: "x", name: "X",
			gates: [{
				id: "g", name: "G",
				verify: [{ name: "Build shared", type: "command", component: "shared", command: "build" }],
			}],
		};
		const errs = validateWorkflow(wf, components);
		assert.equal(errs.length, 1);
		assert.match(errs[0].message, /no command "build"/);
		assert.match(errs[0].message, /data-only/);
	});

	it("emits the canonical error format with workflow / gate / step number", () => {
		const wf: ValidatorWorkflow = {
			id: "myflow", name: "MyFlow",
			gates: [{
				id: "phase-1", name: "Phase 1",
				verify: [
					{ name: "OK", type: "command", component: "api", command: "build" },
					{ name: "OK2", type: "command", component: "api", command: "test" },
					{ name: "Bad", type: "command", component: "ghost", command: "x" },
				],
			}],
		};
		const errs = validateWorkflow(wf, components);
		assert.equal(errs.length, 1);
		assert.match(errs[0].message, /^Workflow "myflow", gate "phase-1", step 3 \("Bad"\): /);
	});

	it("validateAllWorkflows aggregates errors across all workflows", () => {
		const map: Record<string, ValidatorWorkflow> = {
			alpha: { id: "alpha", name: "A", gates: [
				{ id: "g", name: "G", verify: [{ name: "x", type: "command", component: "nope", command: "build" }] },
			]},
			beta: { id: "beta", name: "B", gates: [
				{ id: "g", name: "G", verify: [{ name: "y", type: "command", component: "api", command: "missing" }] },
			]},
		};
		const errs = validateAllWorkflows(map, components);
		assert.equal(errs.length, 2);
		assert.match(errs[0].message, /^Workflow "alpha"/);
		assert.match(errs[1].message, /^Workflow "beta"/);
	});

	it("rejects optional step without label", () => {
		const wf: ValidatorWorkflow = {
			id: "x", name: "X",
			gates: [{
				id: "g", name: "G",
				verify: [{ name: "QA", type: "agent-qa", optional: true, prompt: "Run." }],
			}],
		};
		const errs = validateWorkflow(wf, components);
		assert.ok(errs.some(e => /optional: true but has no optionalLabel/.test(e.message)));
	});

	it("rejects unknown step type", () => {
		const wf: ValidatorWorkflow = {
			id: "x", name: "X",
			gates: [{ id: "g", name: "G", verify: [{ name: "Q", type: "wat" } as any] }],
		};
		const errs = validateWorkflow(wf, components);
		assert.equal(errs.length, 1);
		assert.match(errs[0].message, /unknown step type "wat"/);
		// human-signoff must appear in the accepted-set hint so authors know about it.
		assert.match(errs[0].message, /human-signoff/);
	});

	it("rejects human-signoff step with missing prompt", () => {
		const wf: ValidatorWorkflow = {
			id: "x", name: "X",
			gates: [{
				id: "g", name: "G",
				verify: [{ name: "Approve", type: "human-signoff", label: "Approve it" } as any],
			}],
		};
		const errs = validateWorkflow(wf, components);
		assert.ok(errs.some(e => /human-signoff step requires a non-empty "prompt"/.test(e.message)),
			`expected prompt error, got: ${errs.map(e => e.message).join("; ")}`);
	});

	it("rejects human-signoff step with empty prompt", () => {
		const wf: ValidatorWorkflow = {
			id: "x", name: "X",
			gates: [{
				id: "g", name: "G",
				verify: [{ name: "Approve", type: "human-signoff", label: "Approve it", prompt: "" } as any],
			}],
		};
		const errs = validateWorkflow(wf, components);
		assert.ok(errs.some(e => /human-signoff step requires a non-empty "prompt"/.test(e.message)));
	});

	it("rejects human-signoff step with missing label", () => {
		const wf: ValidatorWorkflow = {
			id: "x", name: "X",
			gates: [{
				id: "g", name: "G",
				verify: [{ name: "Approve", type: "human-signoff", prompt: "Look it over." } as any],
			}],
		};
		const errs = validateWorkflow(wf, components);
		assert.ok(errs.some(e => /human-signoff step requires a non-empty "label"/.test(e.message)),
			`expected label error, got: ${errs.map(e => e.message).join("; ")}`);
	});

	it("rejects human-signoff step with empty label", () => {
		const wf: ValidatorWorkflow = {
			id: "x", name: "X",
			gates: [{
				id: "g", name: "G",
				verify: [{ name: "Approve", type: "human-signoff", label: "", prompt: "Check." } as any],
			}],
		};
		const errs = validateWorkflow(wf, components);
		assert.ok(errs.some(e => /human-signoff step requires a non-empty "label"/.test(e.message)));
	});
});
