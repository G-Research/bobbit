/**
 * Workflow step shape resolution — see docs/design/multi-repo-components.md §3.3.
 *
 * Verifies:
 *   - All three command shapes resolve correctly via resolveStep().
 *   - {{project.X}} tokens are rejected by the validator (Phase 2 break).
 *   - Free-form `run:` substitutes {{branch}} and {{agent.X}} tokens.
 *   - `expect: failure` is honored on all command shapes (validator passes them).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { resolveStep } from "../src/server/agent/verification-harness.ts";
import { substituteVars } from "../src/server/agent/verification-logic.ts";
import { validateWorkflow, type ValidatorWorkflow, type WorkflowComponentRef } from "../src/server/agent/workflow-validator.ts";
import type { Component } from "../src/server/agent/project-config-store.ts";
import type { VerifyStep } from "../src/server/agent/workflow-store.ts";

const components: Component[] = [
	{ name: "api", repo: ".", commands: { build: "npm run build", test: "npm test" } },
	{ name: "web", repo: "web", commands: { build: "vite build" } },
	{ name: "shared", repo: ".", relativePath: "packages/shared", commands: { check: "tsc --noEmit" } },
];

describe("resolveStep — three command shapes", () => {
	it("{ component, command } looks up commands map and uses component root", () => {
		const step: VerifyStep = { name: "Build api", type: "command", component: "api", command: "build" };
		const r = resolveStep(step, components, "/branch");
		assert.equal(r.runString, "npm run build");
		assert.equal(r.cwd, "/branch");
	});

	it("{ component, run } uses literal run at component root", () => {
		const step: VerifyStep = { name: "X", type: "command", component: "web", run: "./scripts/x.sh" };
		const r = resolveStep(step, components, "/branch");
		assert.equal(r.runString, "./scripts/x.sh");
		assert.equal(r.cwd, path.join("/branch", "web"));
	});

	it("{ run } pure free-form runs at branch container root", () => {
		const step: VerifyStep = { name: "Push", type: "command", run: "git push origin {{branch}}" };
		const r = resolveStep(step, components, "/branch");
		assert.equal(r.runString, "git push origin {{branch}}");
		assert.equal(r.cwd, "/branch");
	});

	it("relativePath collapses into component root", () => {
		const step: VerifyStep = { name: "Check shared", type: "command", component: "shared", command: "check" };
		const r = resolveStep(step, components, "/branch");
		assert.equal(r.runString, "tsc --noEmit");
		// repo = "." collapses; relativePath = "packages/shared" appends.
		assert.equal(r.cwd, path.join("/branch", "packages/shared"));
	});

	it("throws WorkflowResolveError on unknown component", () => {
		const step: VerifyStep = { name: "Bad", type: "command", component: "nope", command: "build" };
		assert.throws(() => resolveStep(step, components, "/branch"), /component "nope" not found/i);
	});

	it("throws WorkflowResolveError on unknown command", () => {
		const step: VerifyStep = { name: "Bad", type: "command", component: "api", command: "lint" };
		assert.throws(() => resolveStep(step, components, "/branch"), /no command "lint"/i);
	});
});

describe("Validator — {{project.X}} rejection", () => {
	const refs: WorkflowComponentRef[] = components.map(c => ({ name: c.name, commands: c.commands }));

	it("rejects {{project.build_command}} in pure free-form run", () => {
		const wf: ValidatorWorkflow = {
			id: "x", name: "X",
			gates: [{ id: "g", name: "G", verify: [
				{ name: "Bad", type: "command", run: "{{project.build_command}}" },
			] }],
		};
		const errs = validateWorkflow(wf, refs);
		assert.ok(errs.length > 0);
		assert.match(errs[0].message, /removed token/i);
	});

	it("rejects {{project.X}} embedded inside a llm-review prompt", () => {
		const wf: ValidatorWorkflow = {
			id: "x", name: "X",
			gates: [{ id: "g", name: "G", verify: [
				{ name: "Review", type: "llm-review", prompt: "Use {{project.test_command}}." },
			] }],
		};
		const errs = validateWorkflow(wf, refs);
		assert.ok(errs.length > 0);
	});

	it("accepts {{branch}}, {{master}}, {{agent.x}}, {{<gate>.meta.x}}", () => {
		const wf: ValidatorWorkflow = {
			id: "x", name: "X",
			gates: [{ id: "g", name: "G", verify: [
				{ name: "Push", type: "command", run: "git push origin {{branch}}" },
				{ name: "Run", type: "command", run: "{{agent.test_command}}" },
				{ name: "Meta", type: "command", run: "{{reproducing-test.meta.test_command}}" },
			] }],
		};
		const errs = validateWorkflow(wf, refs);
		assert.deepEqual(errs, []);
	});
});

describe("substituteVars — namespaces (Phase 2)", () => {
	it("substitutes {{branch}} and {{master}} from builtins", () => {
		const out = substituteVars(
			"git push origin {{branch}} (master={{master}})",
			{ branch: "goal/x", master: "main" },
			{},
			{},
		);
		assert.equal(out, "git push origin goal/x (master=main)");
	});

	it("substitutes {{agent.X}} from signal metadata", () => {
		const out = substituteVars(
			"run: {{agent.test_command}}",
			{},
			{},
			{ test_command: "npm test -- --grep foo" },
		);
		assert.equal(out, "run: npm test -- --grep foo");
	});

	it("does NOT substitute {{project.X}} (Phase 2 break)", () => {
		const out = substituteVars(
			"{{project.build_command}}",
			{},
			{ build_command: "npm run build" },
			{},
		);
		// Token is left literal so isCommandStepSkippable() can detect it.
		assert.equal(out, "{{project.build_command}}");
	});

	it("substitutes {{<gate>.meta.X}} from upstream gate metadata", () => {
		const map = new Map<string, { metadata?: Record<string, string> }>();
		map.set("reproducing-test", { metadata: { test_command: "npx test foo" } });
		const out = substituteVars(
			"{{reproducing-test.meta.test_command}}",
			{}, {}, {},
			map as any,
		);
		assert.equal(out, "npx test foo");
	});
});

describe("expect: failure works on all command shapes", () => {
	const refs: WorkflowComponentRef[] = components.map(c => ({ name: c.name, commands: c.commands }));

	it("validator accepts expect:failure on { component, command }", () => {
		const wf: ValidatorWorkflow = {
			id: "tdd", name: "TDD",
			gates: [{ id: "g", name: "G", verify: [
				{ name: "Failing test", type: "command", component: "api", command: "test", expect: "failure" } as any,
			] }],
		};
		assert.deepEqual(validateWorkflow(wf, refs), []);
	});

	it("validator accepts expect:failure on { component, run }", () => {
		const wf: ValidatorWorkflow = {
			id: "tdd", name: "TDD",
			gates: [{ id: "g", name: "G", verify: [
				{ name: "Failing", type: "command", component: "api", run: "exit 1", expect: "failure" } as any,
			] }],
		};
		assert.deepEqual(validateWorkflow(wf, refs), []);
	});

	it("validator accepts expect:failure on { run }", () => {
		const wf: ValidatorWorkflow = {
			id: "tdd", name: "TDD",
			gates: [{ id: "g", name: "G", verify: [
				{ name: "Bare fail", type: "command", run: "false", expect: "failure" } as any,
			] }],
		};
		assert.deepEqual(validateWorkflow(wf, refs), []);
	});
});
