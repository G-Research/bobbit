/**
 * API E2E — inline workflows in project.yaml drive goal creation.
 *
 * See docs/design/multi-repo-components.md §3.2.
 *
 * Verifies:
 *   - A project with two inline workflows lists both via GET /api/workflows.
 *   - POST /api/goals snapshots the inline workflow definition onto the goal.
 *   - The snapshotted workflow matches the inline yaml exactly.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, registerProject } from "./_e2e/e2e-setup.js";

const COMPONENTS = [
	{ name: "default", repo: ".", commands: { build: "echo built", check: "echo checked" } },
];

const INLINE_WORKFLOWS = {
	"flow-alpha": {
		id: "flow-alpha",
		name: "Flow Alpha",
		description: "First inline workflow",
		gates: [
			{ id: "step-one", name: "Step One", verify: [
				{ name: "Build", type: "command", component: "default", command: "build" },
			] },
		],
	},
	"flow-beta": {
		id: "flow-beta",
		name: "Flow Beta",
		description: "Second inline workflow",
		gates: [
			{ id: "implementation", name: "Implementation", verify: [
				{ name: "Check", type: "command", component: "default", command: "check" },
				{ name: "Echo", type: "command", run: "echo {{branch}}" },
			] },
		],
	},
};

let projectId = "";
let projectRoot = "";

test.beforeAll(async () => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-inline-workflow-"));
	const project = await registerProject({
		name: `inline-workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		rootPath: projectRoot,
		components: COMPONENTS,
		workflows: INLINE_WORKFLOWS,
		seedWorkflows: false,
	});
	projectId = project.id;
});

test.afterAll(async () => {
	if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
	if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("inline workflows from project.yaml drive goal creation @smoke", async () => {
	const createdGoalIds: string[] = [];
	try {
		// The suite owns a registered project whose declaration persists these two
		// workflows inline in project.yaml. Registration updates the live project
		// context synchronously, so discovery needs no filesystem polling.
		const resp = await apiFetch(`/api/workflows?projectId=${projectId}`);
		expect(resp.status).toBe(200);
		const { workflows } = await resp.json();
		const alpha = workflows.find((workflow: any) => workflow.id === "flow-alpha");
		const beta = workflows.find((workflow: any) => workflow.id === "flow-beta");
		expect(alpha).toMatchObject(INLINE_WORKFLOWS["flow-alpha"]);
		expect(beta).toMatchObject(INLINE_WORKFLOWS["flow-beta"]);

		// POST /api/goals — workflowId: flow-alpha. The created goal must snapshot
		// the project declaration, including component-command verification.
		const goalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "inline-flow-test",
				workflowId: "flow-alpha",
				projectId,
				autoStartTeam: false,
			}),
		});
		expect(goalResp.status).toBe(201);
		const goal = await goalResp.json();
		createdGoalIds.push(goal.id);
		expect(goal.workflowId).toBe("flow-alpha");
		expect(goal.workflow).toBeTruthy();
		expect(goal.workflow.gates).toHaveLength(1);
		expect(goal.workflow.gates[0].id).toBe("step-one");
		expect(goal.workflow.gates[0].verify[0]).toMatchObject({
			name: "Build", type: "command", component: "default", command: "build",
		});

		// A second goal gets an independent snapshot of the other declaration.
		const goalRespB = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "inline-flow-test-b",
				workflowId: "flow-beta",
				projectId,
				autoStartTeam: false,
			}),
		});
		expect(goalRespB.status).toBe(201);
		const goalB = await goalRespB.json();
		createdGoalIds.push(goalB.id);
		expect(goalB.workflow.gates[0].verify).toHaveLength(2);
		expect(goalB.workflow.gates[0].verify[1]).toMatchObject({
			name: "Echo", type: "command", run: "echo {{branch}}",
		});
	} finally {
		for (const goalId of createdGoalIds) {
			await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {});
		}
	}
});
