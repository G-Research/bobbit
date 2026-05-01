/**
 * Pinned regression: builtin workflow component-name substitution.
 *
 * Live test (PR #409 team-lead-317cdb83): the parent workflow's
 * integration gate hardcodes `component: "app"` for every command
 * verify step (Build / Type check / Unit tests / E2E tests). Cause:
 * `BuiltinConfigProvider.getWorkflows()` calls
 * `buildDefaultWorkflows("app")` once at boot, so every project's
 * workflow store ends up with the literal "app" baked in.
 *
 * Projects whose primary component isn't named "app" (e.g.
 * agent-memory's is "agent-memory") hit
 *   `component "app" not found in components[]`
 * when the parent workflow's integration gate fires.
 *
 * Fix: at per-project workflow-store seeding time, substitute the
 * placeholder "app" with the project's first component name. This
 * pure helper is the substitution logic; project-context-manager.ts
 * wires it into setBuiltinWorkflows + getOrCreate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	substituteBuiltinComponent,
	substituteBuiltinComponents,
	PLACEHOLDER_COMPONENT_NAME,
} from "../src/server/agent/substitute-builtin-component.js";
import type { Workflow } from "../src/server/agent/workflow-store.js";

const wfWithPlaceholder = (): Workflow => ({
	id: "parent",
	name: "Parent Goal",
	description: "",
	createdAt: 0,
	updatedAt: 0,
	gates: [
		{
			id: "integration",
			name: "Integration",
			dependsOn: ["execution"],
			verify: [
				{ name: "Build", type: "command", component: PLACEHOLDER_COMPONENT_NAME, command: "build" },
				{ name: "Type check", type: "command", phase: 1, component: PLACEHOLDER_COMPONENT_NAME, command: "check" },
				{ name: "Unit tests", type: "command", phase: 1, component: PLACEHOLDER_COMPONENT_NAME, command: "unit" },
				{ name: "E2E tests", type: "command", phase: 1, component: PLACEHOLDER_COMPONENT_NAME, command: "e2e" },
				{ name: "Code review", type: "llm-review" },
			],
		} as never,
		{
			id: "ready-to-merge",
			name: "Ready to merge",
			dependsOn: ["integration"],
			verify: [
				{ name: "Branch pushed", type: "command", run: "git push origin {{branch}}" },
			],
		} as never,
	],
});

describe("substituteBuiltinComponent — the live-test bug regression", () => {
	it("rewrites all command-type steps with component='app' to the project's primary name", () => {
		const wf = wfWithPlaceholder();
		const result = substituteBuiltinComponent(wf, "agent-memory");
		const integration = result.gates[0];
		const components = (integration.verify as Array<{ component?: string; type: string }>).map(s => s.component);
		assert.deepEqual(
			components,
			["agent-memory", "agent-memory", "agent-memory", "agent-memory", undefined],
			"all 4 command steps got rewritten; the llm-review step has no component",
		);
	});

	it("leaves the ready-to-merge gate's free-form run steps untouched (no component:)", () => {
		const wf = wfWithPlaceholder();
		const result = substituteBuiltinComponent(wf, "agent-memory");
		const r2m = result.gates[1];
		const step = (r2m.verify as Array<{ run?: string }>)[0];
		// Run-string preserved.
		assert.ok(step.run && step.run.includes("git push origin"));
	});

	it("does not mutate the input workflow (returns a fresh object)", () => {
		const wf = wfWithPlaceholder();
		const result = substituteBuiltinComponent(wf, "agent-memory");
		const inputComponent = (wf.gates[0].verify as Array<{ component?: string }>)[0].component;
		assert.equal(inputComponent, PLACEHOLDER_COMPONENT_NAME, "input untouched");
		assert.notEqual(result, wf, "fresh outer object");
	});

	it("idempotent on workflows already substituted (placeholder absent → unchanged)", () => {
		const wf = wfWithPlaceholder();
		const once = substituteBuiltinComponent(wf, "agent-memory");
		const twice = substituteBuiltinComponent(once, "agent-memory");
		// Component fields should be identical after a second pass.
		assert.deepEqual(
			(once.gates[0].verify as unknown[]),
			(twice.gates[0].verify as unknown[]),
		);
	});

	it("returns input unchanged when project's primary name IS the placeholder (no-op)", () => {
		const wf = wfWithPlaceholder();
		const result = substituteBuiltinComponent(wf, PLACEHOLDER_COMPONENT_NAME);
		// Same reference — no rewrite work done.
		assert.equal(result, wf);
	});

	it("returns input unchanged when primary name is undefined (project has no components)", () => {
		// Defensive: when getComponents()[0] is undefined, leave the
		// placeholder in place so the resulting harness error is still
		// actionable (\"app not found\") rather than silently substituted.
		const wf = wfWithPlaceholder();
		const result = substituteBuiltinComponent(wf, undefined);
		assert.equal(result, wf);
	});

	it("returns input unchanged when primary name is empty string", () => {
		const wf = wfWithPlaceholder();
		const result = substituteBuiltinComponent(wf, "");
		assert.equal(result, wf);
	});

	it("does NOT rewrite steps with component set to a non-placeholder value", () => {
		// Project authors who named a component literally "app" or any
		// other value get exact-match behaviour — only the documented
		// placeholder is substituted.
		const wf: Workflow = {
			id: "test",
			name: "Test",
			description: "",
			createdAt: 0,
			updatedAt: 0,
			gates: [{
				id: "g",
				name: "g",
				dependsOn: [],
				verify: [
					{ name: "A", type: "command", component: "explicitly-not-app", command: "build" } as never,
				],
			} as never],
		};
		const result = substituteBuiltinComponent(wf, "agent-memory");
		assert.equal(
			(result.gates[0].verify as Array<{ component: string }>)[0].component,
			"explicitly-not-app",
			"non-placeholder components are exact-match, not rewritten",
		);
	});

	it("does NOT rewrite non-command steps even if they happened to have component: 'app'", () => {
		// Defensive: only `type === 'command'` + `component === 'app'`
		// triggers substitution. An llm-review or agent-qa step that
		// happens to carry a component field is left alone.
		const wf: Workflow = {
			id: "test",
			name: "Test",
			description: "",
			createdAt: 0,
			updatedAt: 0,
			gates: [{
				id: "g",
				name: "g",
				dependsOn: [],
				verify: [
					{ name: "Review", type: "llm-review", component: PLACEHOLDER_COMPONENT_NAME } as never,
				],
			} as never],
		};
		const result = substituteBuiltinComponent(wf, "agent-memory");
		// Same reference — no rewrite (type !== command).
		assert.equal(result, wf);
	});

	it("handles workflow with no gates / empty gates array", () => {
		const wf: Workflow = {
			id: "empty",
			name: "Empty",
			description: "",
			createdAt: 0,
			updatedAt: 0,
			gates: [],
		};
		const result = substituteBuiltinComponent(wf, "agent-memory");
		assert.equal(result, wf, "no gates → no work, same reference");
	});

	it("handles a gate with no verify[] (returns same reference)", () => {
		const wf: Workflow = {
			id: "x",
			name: "X",
			description: "",
			createdAt: 0,
			updatedAt: 0,
			gates: [{
				id: "g",
				name: "g",
				dependsOn: [],
				// no verify field at all
			} as never],
		};
		const result = substituteBuiltinComponent(wf, "agent-memory");
		assert.equal(result, wf);
	});
});

describe("substituteBuiltinComponent — prune undeclared commands (issue 9)", () => {
	const wfWithMixed = (): Workflow => ({
		id: "parent",
		name: "Parent Goal",
		description: "",
		createdAt: 0,
		updatedAt: 0,
		gates: [{
			id: "integration",
			name: "Integration",
			dependsOn: ["execution"],
			verify: [
				{ name: "Build", type: "command", component: "app", command: "build" },
				{ name: "Type check", type: "command", component: "app", command: "check" },
				{ name: "Unit tests", type: "command", component: "app", command: "unit" },
				{ name: "E2E tests", type: "command", component: "app", command: "e2e" },
				{ name: "Code review", type: "llm-review" },
			] as never,
		} as never],
	});

	it("prunes the e2e step when the project's component declares no e2e command (THE bug)", () => {
		// Live test PR #409 v0.1-foundation: agent-memory's component
		// has build/check/unit but no e2e. Without prune, the integration
		// gate hard-fails on a step the project legitimately doesn't have.
		const wf = wfWithMixed();
		const result = substituteBuiltinComponent(wf, {
			name: "agent-memory",
			commands: { build: "npm run build", check: "tsc", unit: "jest" }, // no e2e
		});
		const integration = result.gates[0];
		const names = (integration.verify as Array<{ name: string }>).map(s => s.name);
		assert.deepEqual(names, ["Build", "Type check", "Unit tests", "Code review"], "e2e dropped, others kept");
	});

	it("keeps all command steps when the project declares all of them", () => {
		const wf = wfWithMixed();
		const result = substituteBuiltinComponent(wf, {
			name: "agent-memory",
			commands: {
				build: "npm run build",
				check: "tsc",
				unit: "jest",
				e2e: "playwright test",
			},
		});
		const names = (result.gates[0].verify as Array<{ name: string }>).map(s => s.name);
		assert.deepEqual(names, ["Build", "Type check", "Unit tests", "E2E tests", "Code review"]);
	});

	it("keeps the LLM-review step regardless of commands map (not a command step)", () => {
		const wf = wfWithMixed();
		const result = substituteBuiltinComponent(wf, {
			name: "agent-memory",
			commands: {}, // no commands at all
		});
		// All command steps pruned; LLM review survives.
		const kinds = (result.gates[0].verify as Array<{ type: string }>).map(s => s.type);
		assert.deepEqual(kinds, ["llm-review"]);
	});

	it("prunes ALL command steps when the project has empty commands map", () => {
		const wf = wfWithMixed();
		const result = substituteBuiltinComponent(wf, {
			name: "agent-memory",
			commands: {},
		});
		const types = (result.gates[0].verify as Array<{ type: string }>).map(s => s.type);
		assert.deepEqual(types, ["llm-review"], "only the llm-review survives");
	});

	it("BACK-COMPAT: when primary is just a name string (no commands map), only substitutes — no prune", () => {
		// PR-aa913742-era callers passed just the name. Prune requires
		// the commands map; without it we can't tell what's declared, so
		// fall through to substitution-only.
		const wf = wfWithMixed();
		const result = substituteBuiltinComponent(wf, "agent-memory");
		const names = (result.gates[0].verify as Array<{ name: string }>).map(s => s.name);
		assert.deepEqual(names, ["Build", "Type check", "Unit tests", "E2E tests", "Code review"], "all kept; only substitution applied");
	});

	it("does NOT prune steps targeting a different component (only primary's component scoped)", () => {
		// Defensive: if a gate has a command step targeting a sibling
		// component, the prune logic only fires for the primary's name.
		const wf: Workflow = {
			id: "x",
			name: "X",
			description: "",
			createdAt: 0,
			updatedAt: 0,
			gates: [{
				id: "g",
				name: "g",
				dependsOn: [],
				verify: [
					{ name: "Other", type: "command", component: "sibling-component", command: "e2e" } as never,
				],
			} as never],
		};
		const result = substituteBuiltinComponent(wf, { name: "agent-memory", commands: {} });
		// Untouched — step's component isn't primary's.
		assert.equal(result, wf);
	});

	it("prune is idempotent: a second pass on already-pruned workflow is a no-op", () => {
		const wf = wfWithMixed();
		const once = substituteBuiltinComponent(wf, { name: "agent-memory", commands: { build: "x" } });
		const twice = substituteBuiltinComponent(once, { name: "agent-memory", commands: { build: "x" } });
		// Same shape; further calls don't shrink.
		const onceNames = (once.gates[0].verify as Array<{ name: string }>).map(s => s.name);
		const twiceNames = (twice.gates[0].verify as Array<{ name: string }>).map(s => s.name);
		assert.deepEqual(onceNames, twiceNames);
	});

	it("prune skips command steps using free-form 'run:' (no command field set)", () => {
		// The ready-to-merge gate's branch-pushed/master-merged/PR-raised
		// steps use `run:` not `command:` — they bypass the lookup
		// entirely and must NOT be pruned regardless of commands map.
		const wf: Workflow = {
			id: "x",
			name: "X",
			description: "",
			createdAt: 0,
			updatedAt: 0,
			gates: [{
				id: "ready-to-merge",
				name: "Ready",
				dependsOn: [],
				verify: [
					{ name: "Branch pushed", type: "command", run: "git push origin {{branch}}" } as never,
					{ name: "Master merged", type: "command", run: "git fetch origin {{master}}" } as never,
				],
			} as never],
		};
		const result = substituteBuiltinComponent(wf, { name: "agent-memory", commands: {} });
		// Same reference — no prune (no command: field; no component match).
		assert.equal(result, wf);
	});
});

describe("substituteBuiltinComponents — array helper", () => {
	it("applies substitution across multiple workflows", () => {
		const wfs = [wfWithPlaceholder(), wfWithPlaceholder()];
		const result = substituteBuiltinComponents(wfs, "agent-memory");
		assert.equal(result.length, 2);
		for (const r of result) {
			const step = (r.gates[0].verify as Array<{ component?: string }>)[0];
			assert.equal(step.component, "agent-memory");
		}
	});

	it("preserves array length and order", () => {
		const wfs = [
			{ ...wfWithPlaceholder(), id: "first" },
			{ ...wfWithPlaceholder(), id: "second" },
			{ ...wfWithPlaceholder(), id: "third" },
		];
		const result = substituteBuiltinComponents(wfs, "agent-memory");
		assert.deepEqual(result.map(r => r.id), ["first", "second", "third"]);
	});

	it("returns empty array for empty input", () => {
		assert.deepEqual(substituteBuiltinComponents([], "agent-memory"), []);
	});
});
