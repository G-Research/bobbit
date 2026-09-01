/**
 * Verifies that POST /api/projects no longer silently seeds default workflows
 * when the proposal omits a `workflows` block. Workflows are the project
 * assistant's responsibility — the server has no fallback.
 *
 * See docs/internals.md and the "No default workflow scaffold" design doc.
 */
import { test, expect } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import { readE2EToken, base, registerProject } from "../../../tests/support/harnesses/integration/gateway/e2e-setup.js";
import { pollUntil } from "../../../tests/e2e/test-utils/cleanup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { validateAllWorkflows } from "../../../src/server/agent/workflow-validator.ts";

let token: string;

const headers = () => ({
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

function projectDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "README.md"), "x\n");
}

function readProjectYaml(root: string): Record<string, unknown> | null {
	const p = path.join(root, ".bobbit", "config", "project.yaml");
	if (!fs.existsSync(p)) return null;
	return yaml.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
}

function isWorkflowsAbsentOrEmpty(parsed: Record<string, unknown> | null): boolean {
	if (!parsed) return true;
	const wf = parsed.workflows;
	if (wf === undefined || wf === null) return true;
	if (typeof wf !== "object" || Array.isArray(wf)) return false;
	return Object.keys(wf as Record<string, unknown>).length === 0;
}

test.beforeAll(() => { token = readE2EToken(); });

test.describe("No default workflow scaffold", () => {
	test("Case A — POST /api/projects without workflows persists with zero workflows", async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-nodef-a-")));
		projectDir(root);

		const projName = `nodef-a-${Date.now()}`;
		// seedWorkflows:false suppresses apiFetch's auto-seed helper, which would
		// otherwise PUT a baseline workflows block into the fresh project and
		// defeat the "zero workflows" invariant under test.
		const project = await registerProject({
			name: projName,
			rootPath: root,
			components: [{ name: projName, repo: "." }],
			seedWorkflows: false,
		});

		// Wait briefly for the autosave to flush.
		const yamlPath = path.join(root, ".bobbit", "config", "project.yaml");
		await pollUntil(() => fs.existsSync(yamlPath) ? true : null, { timeoutMs: 2000, intervalMs: 25, label: "project.yaml exists" });

		// On-disk: no workflows: block (or empty mapping).
		const parsed = readProjectYaml(root);
		expect(isWorkflowsAbsentOrEmpty(parsed)).toBe(true);

		// API: GET /api/projects/:id/config — workflows absent or empty.
		const cfgRes = await fetch(`${base()}/api/projects/${project.id}/config`, { headers: headers() });
		expect(cfgRes.status).toBe(200);
		const cfg = await cfgRes.json();
		const cfgWorkflows = cfg && (cfg.workflows ?? cfg.config?.workflows);
		const empty = cfgWorkflows === undefined
			|| cfgWorkflows === null
			|| (typeof cfgWorkflows === "object" && Object.keys(cfgWorkflows).length === 0);
		expect(empty).toBe(true);
	});

	test("Case B — workflows in proposal are kept exactly, no defaults merged", async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-nodef-b-")));
		projectDir(root);

		const projName = `nodef-b-${Date.now()}`;
		const inlineWorkflows = {
			custom: {
				id: "custom",
				name: "Custom",
				description: "project-specific",
				gates: [{ id: "g1", name: "G1" }],
			},
		};

		await registerProject({
			name: projName,
			rootPath: root,
			components: [{ name: projName, repo: "." }],
			workflows: inlineWorkflows,
		});

		const yamlPath = path.join(root, ".bobbit", "config", "project.yaml");
		await pollUntil(() => fs.existsSync(yamlPath) ? true : null, { timeoutMs: 2000, intervalMs: 25, label: "project.yaml exists" });
		const parsed = readProjectYaml(root)!;
		const wf = parsed.workflows as Record<string, any>;
		expect(typeof wf).toBe("object");
		expect(Object.keys(wf).sort()).toEqual(["custom"]);
		expect(wf.custom.name).toBe("Custom");
		// No canonical-default ids merged in.
		expect(wf.general).toBeUndefined();
		expect(wf.feature).toBeUndefined();
		expect(wf["bug-fix"]).toBeUndefined();
		expect(wf["quick-fix"]).toBeUndefined();
	});

	test("Case C — goal-creation in a zero-workflows project auto-seeds default workflows", async () => {
		// Auto-seeding always persists to disk (7b75dca4): when a goal is first
		// created in a project with no workflows, the server seeds the canonical
		// defaults (general, feature, bug-fix, parent) so the goal can succeed.
		// Pinned by goal-creation-auto-seed.spec.ts and this test.
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-nodef-c-")));
		projectDir(root);

		const projName = `nodef-c-${Date.now()}`;
		const project = await registerProject({
			name: projName,
			rootPath: root,
			components: [{ name: projName, repo: "." }],
			seedWorkflows: false,
		});

		const yamlPath = path.join(root, ".bobbit", "config", "project.yaml");
		await pollUntil(() => fs.existsSync(yamlPath) ? true : null, { timeoutMs: 2000, intervalMs: 25, label: "project.yaml exists" });
		expect(isWorkflowsAbsentOrEmpty(readProjectYaml(root))).toBe(true);

		const goalRes = await fetch(`${base()}/api/goals`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				title: `goal-${Date.now()}`,
				cwd: root,
				projectId: project.id,
				team: false,
				autoStartTeam: false,
				workflowId: "feature", // workflowId triggers auto-seeding on empty project
			}),
		});
		// Goal creation should succeed and project.yaml should now have workflows.
		expect([200, 201]).toContain(goalRes.status);
		const seeded = readProjectYaml(root)!;
		expect(isWorkflowsAbsentOrEmpty(seeded)).toBe(false);

		const workflows = seeded.workflows as Record<string, any>;
		const structuralCommands = Object.values(workflows).flatMap((workflow: any) =>
			(workflow.gates ?? []).flatMap((gate: any) =>
				(gate.verify ?? []).filter((step: any) => step.type === "command" && step.component && step.command),
			),
		);
		expect(structuralCommands).toEqual([]);
		expect(
			validateAllWorkflows(workflows, [{ name: projName }]),
		).toEqual([]);
	});

	test("Case D — auto-seeding selects the executable component after a data-only component", async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-nodef-d-")));
		projectDir(root);
		fs.mkdirSync(path.join(root, "data"));
		fs.mkdirSync(path.join(root, "app"));

		const projName = `nodef-d-${Date.now()}`;
		const executableComponent = "app";
		const executableCommands = {
			build: "npm run build",
			check: "npm run check",
			unit: "npm run test:unit",
			browser: "npm run test:browser",
			e2e: "npm run test:e2e",
		};
		const components = [
			{ name: "data", repo: "data" },
			{
				name: executableComponent,
				repo: "app",
				commands: executableCommands,
				config: { qa_start_command: "npm run dev" },
			},
		];
		const project = await registerProject({
			name: projName, // Deliberately matches neither component.
			rootPath: root,
			components,
			seedWorkflows: false,
		});

		const yamlPath = path.join(root, ".bobbit", "config", "project.yaml");
		await pollUntil(() => fs.existsSync(yamlPath) ? true : null, { timeoutMs: 2000, intervalMs: 25, label: "project.yaml exists" });
		expect(isWorkflowsAbsentOrEmpty(readProjectYaml(root))).toBe(true);

		const goalRes = await fetch(`${base()}/api/goals`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				title: `goal-${Date.now()}`,
				cwd: root,
				projectId: project.id,
				team: false,
				autoStartTeam: false,
				worktree: false,
				workflowId: "feature",
			}),
		});
		expect(goalRes.status, await goalRes.clone().text()).toBe(201);
		const createdGoal = await goalRes.json();

		const workflows = readProjectYaml(root)!.workflows as Record<string, any>;
		expect(Object.keys(workflows).sort()).toEqual(["bug-fix", "feature", "general", "parent", "quick-fix"]);
		const expectedStructuralCommands = [
			{ command: "build", phase: 0 },
			{ command: "check", phase: 1 },
			{ command: "unit", phase: 1 },
			{ command: "browser", phase: 1 },
			{ command: "e2e", phase: 1 },
		];
		for (const workflowId of ["general", "feature", "bug-fix", "quick-fix"]) {
			const implementation = workflows[workflowId].gates.find((gate: any) => gate.id === "implementation");
			expect(implementation, `${workflowId} implementation gate`).toBeTruthy();
			const structural = (implementation.verify ?? []).filter((step: any) => step.type === "command" && step.component && step.command);
			expect(
				structural.map((step: any) => ({ command: step.command, phase: step.phase, component: step.component })),
				`${workflowId} structural commands`,
			).toEqual(expectedStructuralCommands.map((step) => ({ ...step, component: executableComponent })));
			const reviews = (implementation.verify ?? [])
				.filter((step: any) => step.type === "llm-review" && step.phase === 2)
				.map((step: any) => step.role)
				.sort();
			expect(reviews).toEqual(["code-reviewer", "security-reviewer", "spec-auditor"]);
		}

		const everyStep = Object.values(workflows).flatMap((workflow: any) =>
			(workflow.gates ?? []).flatMap((gate: any) => gate.verify ?? []),
		);
		expect(everyStep.filter((step: any) => step.component).every((step: any) => step.component === executableComponent)).toBe(true);
		expect(validateAllWorkflows(workflows, components)).toEqual([]);

		const persistedFeature = workflows.feature;
		const frozenFeature = createdGoal.workflow;
		expect(frozenFeature).toBeTruthy();
		const frozenStructural = frozenFeature.gates
			.find((gate: any) => gate.id === "implementation")
			.verify.filter((step: any) => step.type === "command" && step.component && step.command)
			.map((step: any) => ({ command: step.command, phase: step.phase, component: step.component }));
		expect(frozenStructural).toEqual(
			persistedFeature.gates.find((gate: any) => gate.id === "implementation").verify
				.filter((step: any) => step.type === "command" && step.component && step.command)
				.map((step: any) => ({ command: step.command, phase: step.phase, component: step.component })),
		);
	});
});
