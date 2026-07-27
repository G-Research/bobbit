// v2-native — mandatory Systems Interaction Review workflow/snapshot coverage.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
	SYSTEMS_INTERACTION_REVIEW_PROMPT,
	SYSTEMS_INTERACTION_REVIEW_PROMPT_ID,
	SYSTEMS_INTERACTION_REVIEW_PROMPT_SHA256,
} from "../../src/server/agent/systems-interaction-review-contract.ts";
import { normalizeWorkflow } from "../../src/server/agent/workflow-store.ts";
import {
	freezeWorkflowDefinition,
	validateAllWorkflows,
	type WorkflowComponentRef,
} from "../../src/server/agent/workflow-validator.ts";
import {
	buildDefaultWorkflows,
} from "../../src/server/state-migration/seed-default-workflows.ts";
import {
	buildAllComponentsWorkflow,
	buildPerComponentWorkflow,
} from "../../src/server/state-migration/per-component-workflows.ts";
import {
	migrateSystemsInteractionWorkflows,
} from "../../src/server/state-migration/migrate-systems-interaction-workflows.ts";
import type { Component } from "../../src/server/agent/project-config-store.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SYSTEM_STEP_NAME = "Systems interaction review";
const SPECIALIST_ROLES = new Set(["spec-auditor", "code-reviewer", "bug-hunter", "security-reviewer"]);

type AnyStep = Record<string, unknown> & { name?: string; type?: string; role?: string; phase?: number; optional?: boolean };
type AnyGate = Record<string, unknown> & { id?: string; verify?: AnyStep[] };
type AnyWorkflow = Record<string, unknown> & { id?: string; gates?: AnyGate[] };

function implementationGates(workflow: AnyWorkflow): AnyGate[] {
	return (workflow.gates ?? []).filter((gate) => gate.id === "implementation");
}

function assertSystemsStep(workflowLabel: string, gate: AnyGate): AnyStep {
	const matches = (gate.verify ?? []).filter((step) => step.name === SYSTEM_STEP_NAME);
	expect(matches, `${workflowLabel}.implementation must contain exactly one ${SYSTEM_STEP_NAME}`).toHaveLength(1);
	const step = matches[0];
	expect(step.type, `${workflowLabel}: type`).toBe("llm-review");
	expect(step.role, `${workflowLabel}: role`).toBe("systems-reviewer");
	expect(step.reviewGroup, `${workflowLabel}: reviewGroup`).toBe("specialist");
	expect(step.optional, `${workflowLabel}: mandatory`).not.toBe(true);
	expect(step.promptRef, `${workflowLabel}: shared prompt ref`).toBe(SYSTEMS_INTERACTION_REVIEW_PROMPT_ID);
	expect(step.prompt, `${workflowLabel}: prompt body must not be embedded`).toBeUndefined();
	expect(step.resolvedPrompt, `${workflowLabel}: authored definitions must not embed resolved text`).toBeUndefined();
	return step;
}

function assertPhaseOrdering(workflowLabel: string, gate: AnyGate, systems: AnyStep): void {
	expect(Number.isInteger(systems.phase), `${workflowLabel}: Systems phase`).toBe(true);
	const systemPhase = systems.phase as number;
	const specialistPeers = (gate.verify ?? []).filter((step) =>
		step !== systems
		&& step.type === "llm-review"
		&& (step.reviewGroup === "specialist" || SPECIALIST_ROLES.has(String(step.role))),
	);
	for (const peer of specialistPeers)
		expect(peer.phase, `${workflowLabel}: ${peer.name} must run concurrently with Systems`).toBe(systemPhase);

	for (const command of (gate.verify ?? []).filter((step) => step.type === "command"))
		expect(command.phase ?? 0, `${workflowLabel}: command ${command.name} must precede specialist reviews`).toBeLessThan(systemPhase);
	for (const qa of (gate.verify ?? []).filter((step) => step.type === "agent-qa")) {
		expect(qa.optional, `${workflowLabel}: existing QA remains optional`).toBe(true);
		expect(qa.phase, `${workflowLabel}: QA remains after specialist reviews`).toBeGreaterThan(systemPhase);
	}
}

function assertWorkflowCoverage(label: string, workflow: AnyWorkflow): void {
	for (const [index, gate] of implementationGates(workflow).entries()) {
		const gateLabel = implementationGates(workflow).length === 1 ? label : `${label}#${index}`;
		assertPhaseOrdering(gateLabel, gate, assertSystemsStep(gateLabel, gate));
	}
}

function readYaml(file: string): unknown {
	return YAML.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

function currentProjectWorkflows(): Record<string, AnyWorkflow> {
	const project = readYaml(".bobbit/config/project.yaml") as { workflows?: Record<string, AnyWorkflow> };
	return project.workflows ?? {};
}

const COMPONENTS: Component[] = [
	{ name: "api", repo: "api", commands: { build: "build", check: "check", unit: "unit", e2e: "e2e" } },
	{ name: "web", repo: "web", commands: { build: "build", check: "check", unit: "unit", e2e: "e2e" } },
	{ name: "data", repo: "data" },
];
const COMPONENT_REFS: WorkflowComponentRef[] = COMPONENTS.map(({ name, commands }) => ({ name, commands }));

describe("Systems Interaction Review workflow coverage", () => {
	it("covers every canonical and generated implementation gate", () => {
		const generated: Record<string, AnyWorkflow> = {
			...buildDefaultWorkflows("api") as unknown as Record<string, AnyWorkflow>,
			"feature-api": buildPerComponentWorkflow("api", COMPONENTS) as unknown as AnyWorkflow,
			"all-components": buildAllComponentsWorkflow(COMPONENTS) as unknown as AnyWorkflow,
		};
		const withImplementation = Object.entries(generated).filter(([, workflow]) => implementationGates(workflow).length > 0);
		expect(withImplementation.map(([id]) => id).sort()).toEqual([
			"all-components",
			"bug-fix",
			"feature",
			"feature-api",
			"general",
			"quick-fix",
		]);
		for (const [id, workflow] of withImplementation) assertWorkflowCoverage(id, workflow);
	});

	it("covers every current-project implementation gate, including custom/test workflows", () => {
		const workflows = currentProjectWorkflows();
		const covered = Object.entries(workflows).filter(([, workflow]) => implementationGates(workflow).length > 0);
		expect(covered.length).toBeGreaterThanOrEqual(5);
		for (const [id, workflow] of covered) assertWorkflowCoverage(`project:${id}`, workflow);
	});

	it("keeps shipped/fixture test-fast plus current custom test definitions covered", () => {
		const shipped = readYaml("workflows/test-fast.yaml") as AnyWorkflow;
		const fixture = readYaml("tests/fixtures/workflows/test-fast.yaml") as AnyWorkflow;
		assertWorkflowCoverage("workflows/test-fast.yaml", shipped);
		assertWorkflowCoverage("tests/fixtures/workflows/test-fast.yaml", fixture);

		const currentTests = Object.entries(currentProjectWorkflows()).filter(([id, workflow]) =>
			id.includes("test") && implementationGates(workflow).length > 0,
		);
		expect(currentTests.length).toBeGreaterThan(0);
		for (const [id, workflow] of currentTests) assertWorkflowCoverage(`project:${id}`, workflow);
	});

	it("accepts promptRef-only generated workflows and preserves the reference through normalization", () => {
		const generated = {
			...buildDefaultWorkflows("api"),
			"feature-api": buildPerComponentWorkflow("api", COMPONENTS),
			"all-components": buildAllComponentsWorkflow(COMPONENTS),
		};
		expect(validateAllWorkflows(generated as never, COMPONENT_REFS)).toEqual([]);

		for (const [id, workflow] of Object.entries(generated)) {
			if (implementationGates(workflow as unknown as AnyWorkflow).length === 0) continue;
			const normalized = normalizeWorkflow(workflow, id) as unknown as AnyWorkflow;
			const system = assertSystemsStep(`normalized:${id}`, implementationGates(normalized)[0]);
			expect(system.promptRef).toBe(SYSTEMS_INTERACTION_REVIEW_PROMPT_ID);
		}
	});

	it("resolves the shared contract exactly once into a new immutable workflow snapshot", () => {
		const snapshot = freezeWorkflowDefinition({
			id: "snapshot-test",
			name: "Snapshot test",
			gates: [{
				id: "implementation",
				name: "Implementation",
				verify: [{
					name: SYSTEM_STEP_NAME,
					type: "llm-review",
					role: "systems-reviewer",
					reviewGroup: "specialist",
					phase: 2,
					promptRef: SYSTEMS_INTERACTION_REVIEW_PROMPT_ID,
				}],
			}],
		}) as unknown as AnyWorkflow;
		const step = implementationGates(snapshot)[0].verify?.[0] as AnyStep;
		expect(step.promptId).toBe(SYSTEMS_INTERACTION_REVIEW_PROMPT_ID);
		expect(step.promptSha256).toBe(SYSTEMS_INTERACTION_REVIEW_PROMPT_SHA256);
		expect(step.resolvedPrompt).toBe(SYSTEMS_INTERACTION_REVIEW_PROMPT);
		expect(step.prompt).toBeUndefined();
	});

	it("migrates compatible legacy definitions transactionally and idempotently", () => {
		const legacy = {
			feature: {
				id: "feature",
				name: "Feature",
				gates: [{
					id: "implementation",
					name: "Implementation",
					verify: [
						{ name: "Tests", type: "command", phase: 1, run: "npm test" },
						{ name: "Code quality review", type: "llm-review", phase: 2, role: "code-reviewer", prompt: "review" },
						{ name: "QA testing", type: "agent-qa", phase: 3, optional: true, prompt: "qa" },
					],
				}],
			},
		};
		const before = structuredClone(legacy);
		const migrated = migrateSystemsInteractionWorkflows(legacy);
		expect(legacy).toEqual(before);
		expect(migrated.changed).toBe(true);
		expect(migrated.upgradedWorkflowIds).toEqual(["feature"]);
		expect(migrated.diagnostics).toEqual([]);
		const workflow = migrated.workflows.feature as AnyWorkflow;
		const gate = implementationGates(workflow)[0];
		assertPhaseOrdering("migrated:feature", gate, assertSystemsStep("migrated:feature", gate));
		expect(gate.verify?.find((step) => step.name === "Code quality review")?.reviewGroup).toBe("specialist");

		const repeated = migrateSystemsInteractionWorkflows(migrated.workflows);
		expect(repeated.changed).toBe(false);
		expect(repeated.diagnostics).toEqual([]);
		expect(repeated.workflows).toEqual(migrated.workflows);
	});

	it("leaves ambiguous legacy workflows byte-for-byte intact with manual-upgrade diagnostics", () => {
		const ambiguous = {
			custom: {
				id: "custom",
				name: "Custom",
				gates: [
					{ id: "research", name: "Research", verify: [{ name: "Review", type: "llm-review", prompt: "unrelated" }] },
					{
						id: "implementation",
						name: "Implementation",
						verify: [
							{ name: "Code quality review", type: "llm-review", phase: 2, role: "code-reviewer", prompt: "review" },
							{ name: "Security review", type: "llm-review", phase: 3, role: "security-reviewer", prompt: "secure" },
						],
					},
				],
			},
		};
		const before = structuredClone(ambiguous);
		const migrated = migrateSystemsInteractionWorkflows(ambiguous);
		expect(migrated.changed).toBe(false);
		expect(migrated.workflows).toEqual(before);
		expect(migrated.diagnostics).toEqual([
			expect.objectContaining({
				status: "manual-upgrade-required",
				workflowId: "custom",
				gateId: "implementation",
				code: "ambiguous-specialist-phase",
			}),
		]);
	});

	it("does not retrofit historical goal workflow snapshots during ordinary normalization", () => {
		const historical = normalizeWorkflow({
			id: "historical",
			name: "Historical",
			gates: [{
				id: "implementation",
				name: "Implementation",
				verify: [{ name: "Old review", type: "llm-review", prompt: "old immutable prompt" }],
			}],
		}, "historical") as unknown as AnyWorkflow;
		const steps = implementationGates(historical)[0].verify ?? [];
		expect(steps.map((step) => step.name)).toEqual(["Old review"]);
		expect(steps.some((step) => step.name === SYSTEM_STEP_NAME)).toBe(false);
	});
});
