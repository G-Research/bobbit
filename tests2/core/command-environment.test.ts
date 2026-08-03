import { afterEach, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import {
	MAX_COMMAND_ENV_ENTRIES,
	MAX_COMMAND_ENV_KEY_LENGTH,
	MAX_COMMAND_ENV_VALUE_LENGTH,
	normalizeCommandEnvironment,
	resolveCommandEnvironment,
	validateCommandEnvironment,
} from "../../src/server/agent/command-environment.ts";
import { ProjectConfigStore } from "../../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore, stripSubgoalStepsForChildInheritance } from "../../src/server/agent/workflow-store.ts";
import { freezeWorkflowDefinition, validateWorkflowDefinition } from "../../src/server/agent/workflow-validator.ts";

const tmpRoots: string[] = [];
afterEach(() => {
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function configDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "command-environment-"));
	tmpRoots.push(root);
	const dir = path.join(root, "config");
	fs.mkdirSync(dir);
	return dir;
}

function workflow(step: Record<string, unknown>) {
	return {
		id: "command-env", name: "Command environment", gates: [
			{ id: "verify", name: "Verify", dependsOn: [], verify: [step] },
		],
	};
}

describe("command environment validation and normalization", () => {
	it("accepts blank, literal values and rejects invalid maps at every boundary", () => {
		expect(validateCommandEnvironment({ EMPTY: "", LITERAL: "$VAR; $(whoami) %PATH%" }, "env")).toBeNull();
		const cases: Array<[unknown, RegExp]> = [
			[undefined, /must be an object/i],
			[{ "BAD-NAME": "x" }, /must match/i],
			[{ PATH: "a", Path: "b" }, /duplicate keys.*case-insensitive/i],
			[{ GOOD: 1 }, /must be a string/i],
			[Object.fromEntries(Array.from({ length: MAX_COMMAND_ENV_ENTRIES + 1 }, (_, i) => [`KEY_${i}`, "x"])), /exceeds 100 entries/i],
			[{ ["A".repeat(MAX_COMMAND_ENV_KEY_LENGTH + 1)]: "x" }, /key exceeds/i],
			[{ VALUE: "x".repeat(MAX_COMMAND_ENV_VALUE_LENGTH + 1) }, /value exceeds/i],
		];
		for (const [value, expected] of cases) {
			expect(validateCommandEnvironment(value, "env")).toMatch(expected);
			expect(normalizeCommandEnvironment(value)).toBeUndefined();
		}
	});

	it("overlays case-insensitively into independent, literal snapshots", () => {
		const base = { Path: "host", HOST: "yes" };
		const component = { PATH: "component", LITERAL: "$(echo no-expand)" };
		const step = { path: "step", EMPTY: "" };
		const resolved = resolveCommandEnvironment(base, component, step);
		expect(resolved).toEqual({ HOST: "yes", LITERAL: "$(echo no-expand)", path: "step", EMPTY: "" });
		step.path = "later";
		expect(resolved.path).toBe("step");
		expect(base).toEqual({ Path: "host", HOST: "yes" });
		expect(component).toEqual({ PATH: "component", LITERAL: "$(echo no-expand)" });
	});
});

describe("command environment native models", () => {
	it("round-trips component declarations natively without changing legacy command maps", () => {
		const dir = configDir();
		const store = new ProjectConfigStore(dir);
		store.setComponents([
			{ name: "api", repo: ".", commands: { test: "npm test" }, env: { CI: "1", EMPTY: "" }, config: { preserved: "yes" } },
			{ name: "docs", repo: "docs", commands: { check: "npm run check" } },
		]);

		const persisted = yaml.parse(fs.readFileSync(path.join(dir, "project.yaml"), "utf8"));
		expect(persisted.components[0]).toEqual({
			name: "api", repo: ".", commands: { test: "npm test" }, env: { CI: "1", EMPTY: "" }, config: { preserved: "yes" },
		});
		expect(new ProjectConfigStore(dir).getComponents()).toEqual([
			{ name: "api", repo: ".", commands: { test: "npm test" }, env: { CI: "1", EMPTY: "" }, config: { preserved: "yes" } },
			{ name: "docs", repo: "docs", commands: { check: "npm run check" }, env: undefined, config: undefined },
		]);
	});

	it("keeps project YAML without env and existing string command maps backward compatible", () => {
		const dir = configDir();
		fs.writeFileSync(path.join(dir, "project.yaml"), "components:\n  - name: api\n    repo: .\n    commands:\n      test: npm test\n");
		const component = new ProjectConfigStore(dir).getComponent("api");
		expect(component).toMatchObject({ name: "api", commands: { test: "npm test" } });
		expect(component?.env).toBeUndefined();
	});

	it("validates command-only workflow env and deep-clones it through workflow snapshots and storage", () => {
		const raw = workflow({ name: "Test", type: "command", run: "echo ok", env: { CI: "1", EMPTY: "" } });
		expect(validateWorkflowDefinition(raw)).toEqual([]);
		const frozen = freezeWorkflowDefinition(raw);
		(frozen.gates[0].verify![0].env as Record<string, string>).CI = "mutated";
		expect((raw.gates[0].verify[0].env as Record<string, string>).CI).toBe("1");

		const dir = configDir();
		const workflows = new InlineWorkflowStore(new ProjectConfigStore(dir));
		workflows.put(frozen);
		const reloaded = workflows.get("command-env")!;
		expect(reloaded.gates[0].verify![0].env).toEqual({ CI: "mutated", EMPTY: "" });
		(reloaded.gates[0].verify![0].env as Record<string, string>).CI = "caller-change";
		expect(workflows.get("command-env")!.gates[0].verify![0].env).toEqual({ CI: "mutated", EMPTY: "" });

		for (const type of ["llm-review", "agent-qa", "human-signoff", "subgoal"]) {
			const invalid = workflow({
				name: type, type, prompt: "required prompt", label: type === "human-signoff" ? "Approve" : undefined,
				subgoal: type === "subgoal" ? { planId: "p", title: "T", spec: "S" } : undefined,
				env: { CI: "1" },
			});
			expect(validateWorkflowDefinition(invalid).map(error => error.message).join("\n")).toMatch(/env is only valid/i);
		}
	});

	it("preserves independent environment maps when child-workflow inheritance clones a non-meta workflow", () => {
		const source = freezeWorkflowDefinition(workflow({ name: "Test", type: "command", run: "echo ok", env: { CI: "1" } }));
		const child = stripSubgoalStepsForChildInheritance(source);
		assert.notStrictEqual(child, source);
		assert.notStrictEqual(child.gates[0].verify![0].env, source.gates[0].verify![0].env);
		(child.gates[0].verify![0].env as Record<string, string>).CI = "child";
		expect(source.gates[0].verify![0].env).toEqual({ CI: "1" });
	});
});
