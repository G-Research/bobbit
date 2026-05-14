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
import path from "node:path";
import yaml from "yaml";
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";

let token: string;

test.beforeAll(async () => {
	token = readE2EToken();
});

async function api(p: string, opts?: RequestInit): Promise<Response> {
	return fetch(`${base()}${p}`, {
		...opts,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(opts?.headers || {}),
		},
	});
}

test("inline workflows from project.yaml drive goal creation @smoke", async ({ gateway }) => {
	// Seed an inline workflows: block in the default project's project.yaml.
	const configDir = path.join(gateway.bobbitDir, ".bobbit", "config");
	fs.mkdirSync(configDir, { recursive: true });
	const yamlFile = path.join(configDir, "project.yaml");
	const existing: Record<string, unknown> = fs.existsSync(yamlFile)
		? (yaml.parse(fs.readFileSync(yamlFile, "utf-8")) as Record<string, unknown> ?? {})
		: {};
	existing.components = [
		{ name: "default", repo: ".", commands: { build: "echo built", check: "echo checked" } },
	];
	existing.workflows = {
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
	fs.writeFileSync(yamlFile, yaml.stringify(existing));

	// Resolve the default project id.
	const projResp = await api("/api/projects");
	const projects = await projResp.json();
	const projectId = projects.projects?.[0]?.id ?? projects[0]?.id;
	expect(projectId).toBeTruthy();

	// GET /api/workflows?projectId=... — both inline workflows must appear in the cascade.
	// Poll briefly to absorb inline-store reload latency on Windows fs.
	let alpha: any, beta: any;
	for (let attempt = 0; attempt < 5; attempt++) {
		const resp = await api(`/api/workflows?projectId=${projectId}`);
		expect(resp.status).toBe(200);
		const { workflows } = await resp.json();
		alpha = workflows.find((w: any) => w.id === "flow-alpha");
		beta = workflows.find((w: any) => w.id === "flow-beta");
		if (alpha && beta) break;
		await new Promise(r => setTimeout(r, 250));
	}
	expect(alpha).toBeTruthy();
	expect(beta).toBeTruthy();
	expect(alpha.name).toBe("Flow Alpha");
	expect(beta.name).toBe("Flow Beta");

	// POST /api/goals — workflowId: flow-alpha. The created goal must have
	// `workflow.gates[0].verify[0].component === "default"` etc.
	const goalResp = await api("/api/goals", {
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
	expect(goal.workflowId).toBe("flow-alpha");
	expect(goal.workflow).toBeTruthy();
	expect(goal.workflow.gates).toHaveLength(1);
	expect(goal.workflow.gates[0].id).toBe("step-one");
	expect(goal.workflow.gates[0].verify[0]).toMatchObject({
		name: "Build", type: "command", component: "default", command: "build",
	});

	// And again for flow-beta to confirm the second workflow snapshot is independent.
	const goalRespB = await api("/api/goals", {
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
	expect(goalB.workflow.gates[0].verify).toHaveLength(2);
	expect(goalB.workflow.gates[0].verify[1]).toMatchObject({
		name: "Echo", type: "command", run: "echo {{branch}}",
	});

	// Cleanup
	await api(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" }).catch(() => {});
	await api(`/api/goals/${goalB.id}?cascade=true`, { method: "DELETE" }).catch(() => {});
});
