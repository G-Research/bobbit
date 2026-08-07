// v2-native — Claude runtime workflow remains an inline configuration of the existing verifier.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { RoleLoader, PackResolver } from "../../src/server/agent/pack-resolver.ts";
import type { Role } from "../../src/server/agent/role-store.ts";
import {
	validateWorkflowDefinition,
	type ValidatorVerifyStep,
	type ValidatorWorkflow,
} from "../../src/server/agent/workflow-validator.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const defaultsDir = path.join(repoRoot, "defaults");
const projectYaml = path.join(repoRoot, ".bobbit", "config", "project.yaml");
const supportedStepTypes = new Set(["command", "llm-review", "agent-qa", "subgoal", "human-signoff"]);
const runtimeReviewRoles = new Set(["backend-parity-reviewer", "billing-safety-auditor"]);

function workflow(): ValidatorWorkflow {
	const project = YAML.parse(fs.readFileSync(projectYaml, "utf8")) as { workflows?: Record<string, ValidatorWorkflow> };
	const runtimeWorkflow = project.workflows?.["claude-runtime"];
	expect(runtimeWorkflow, "project.yaml must define the claude-runtime inline workflow").toBeDefined();
	return runtimeWorkflow!;
}

function gate(wf: ValidatorWorkflow, id: string) {
	const value = wf.gates?.find(candidate => candidate.id === id);
	expect(value, `claude-runtime must contain the ${id} gate`).toBeDefined();
	return value!;
}

function steps(wf: ValidatorWorkflow, gateId: string): ValidatorVerifyStep[] {
	return gate(wf, gateId).verify ?? [];
}

function review(wf: ValidatorWorkflow, gateId: string, role: string): ValidatorVerifyStep {
	const step = steps(wf, gateId).find(candidate => candidate.type === "llm-review" && candidate.role === role);
	expect(step, `${gateId} must have an llm-review for ${role}`).toBeDefined();
	return step!;
}

function resolvedBuiltinRoles(): Map<string, Role> {
	const builtinEntry = {
		id: "builtin",
		kind: "builtin" as const,
		scope: "builtin" as const,
		path: defaultsDir,
		readOnly: true,
		layout: "defaults-tree" as const,
	};
	return new Map(
		new PackResolver([builtinEntry], [new RoleLoader()])
			.resolve<Role>("roles")
			.map(({ name, item }) => [name, item]),
	);
}

function normalized(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ");
}

describe("claude-runtime inline workflow", () => {
	it("is accepted by the existing schema and bobbit component command table", () => {
		const wf = workflow();
		const errors = validateWorkflowDefinition(wf, [{
			name: "bobbit",
			commands: {
				build: "npm run build",
				check: "npm run check",
				unit: "npm run test:unit",
				browser: "npm run test:browser",
				e2e: "npm run test:e2e",
			},
		}]);
		expect(errors.map(error => error.message)).toEqual([]);
	});

	it("pins the protocol → design → implementation DAG with dogfood and documentation convergence", () => {
		const wf = workflow();
		expect(wf.id).toBe("claude-runtime");
		expect(wf.gates?.map(candidate => candidate.id)).toEqual([
			"protocol-spike",
			"design-doc",
			"implementation",
			"dogfood",
			"documentation",
			"ready-to-merge",
		]);
		expect(gate(wf, "protocol-spike")).toMatchObject({ content: true, inject_downstream: true });
		expect(gate(wf, "design-doc")).toMatchObject({ content: true, inject_downstream: true, depends_on: ["protocol-spike"] });
		expect(gate(wf, "implementation").depends_on).toEqual(["design-doc"]);
		expect(gate(wf, "dogfood")).toMatchObject({ content: true, depends_on: ["implementation"] });
		expect(gate(wf, "documentation")).toMatchObject({ content: true, depends_on: ["implementation"] });
		expect(gate(wf, "ready-to-merge").depends_on).toEqual(["dogfood", "documentation"]);
	});

	it("runs the established bobbit command phases before specialist implementation reviews", () => {
		const wf = workflow();
		const commands = steps(wf, "implementation")
			.filter(step => step.type === "command")
			.map(step => ({ component: step.component, command: step.command, phase: step.phase }));
		expect(commands).toEqual([
			{ component: "bobbit", command: "build", phase: 0 },
			{ component: "bobbit", command: "check", phase: 1 },
			{ component: "bobbit", command: "unit", phase: 1 },
			{ component: "bobbit", command: "browser", phase: 1 },
			{ component: "bobbit", command: "e2e", phase: 1 },
		]);

		for (const role of [
			"backend-parity-reviewer",
			"billing-safety-auditor",
			"spec-auditor",
			"code-reviewer",
			"verifiable-bug-hunter",
			"security-reviewer",
		]) {
			expect(review(wf, "implementation", role).phase, `${role} must run after deterministic commands`).toBe(4);
		}
	});

	it("uses the runtime specialists in the evidence and implementation reviews", () => {
		const wf = workflow();
		for (const role of ["backend-parity-reviewer", "billing-safety-auditor"]) {
			expect(review(wf, "design-doc", role).prompt).toEqual(expect.any(String));
			expect(review(wf, "implementation", role).prompt).toEqual(expect.any(String));
		}

		const protocolPrompt = normalized(steps(wf, "protocol-spike").find(step => step.type === "llm-review")?.prompt);
		expect(protocolPrompt).toMatch(/(?:saniti[sz]|redact).{0,140}(?:fixture|evidence|transcript)/i);
		expect(protocolPrompt).toMatch(/(?:SDK|Claude).{0,100}version/i);
		expect(normalized(review(wf, "implementation", "backend-parity-reviewer").prompt)).toMatch(/(?:Pi|fixture|tool|transcript|usage)/i);
		expect(normalized(review(wf, "implementation", "billing-safety-auditor").prompt)).toMatch(/(?:subscription|apiKeySource|fallback|sandbox|notional)/i);
	});

	it("requires sanitized real-model subscription evidence for dogfood and documents runtime selection", () => {
		const wf = workflow();
		const dogfoodPrompt = normalized(steps(wf, "dogfood").find(step => step.type === "llm-review" || step.type === "agent-qa")?.prompt);
		expect(dogfoodPrompt).toMatch(/(?:saniti[sz]|redact)/i);
		expect(dogfoodPrompt).toMatch(/(?:real[- ]?(?:model|subscription)|subscription.{0,80}(?:model|manual)|manual.{0,80}(?:model|subscription))/i);
		expect(dogfoodPrompt).toMatch(/(?:transcript|usage|readiness|prompt|steer|interrupt|stop)/i);

		const documentationPrompt = normalized(steps(wf, "documentation").find(step => step.type === "llm-review")?.prompt);
		expect(documentationPrompt).toMatch(/claude-runtime/i);
		expect(documentationPrompt).toMatch(/(?:subscription|SDK selection|workflow selection)/i);
	});

	it("uses no custom step engine, resolves every referenced shipped role, and stays within UTF-8 prompt budgets", () => {
		const wf = workflow();
		const roles = resolvedBuiltinRoles();
		for (const gate of wf.gates ?? []) {
			for (const step of gate.verify ?? []) {
				expect(supportedStepTypes.has(step.type ?? "command"), `${gate.id}/${step.name} must use an existing verification step type`).toBe(true);
				if (step.role) {
					const role = roles.get(step.role);
					expect(role, `${gate.id}/${step.name} references missing role ${step.role}`).toBeDefined();
					if (step.type === "llm-review" && runtimeReviewRoles.has(step.role)) {
						expect(
							Buffer.byteLength(role!.promptTemplate, "utf8") + Buffer.byteLength(step.prompt ?? "", "utf8"),
							`${gate.id}/${step.name} fixed runtime-review role plus workflow prompt must be at most 12 KiB`,
						).toBeLessThanOrEqual(12 * 1024);
					}
				}
				if (step.type !== "llm-review") continue;
				expect(Buffer.byteLength(step.prompt ?? "", "utf8"), `${gate.id}/${step.name} workflow prompt must be at most 4 KiB`).toBeLessThanOrEqual(4 * 1024);
			}
		}
	});
});
