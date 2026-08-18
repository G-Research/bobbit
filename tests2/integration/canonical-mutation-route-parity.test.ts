import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = "";
let projectId = "";
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const roleName = `parity-role-${suffix}`;
const workflowId = `parity-workflow-${suffix}`;
let staffId = "";

test.beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "bobbit-canonical-route-parity-"));
	mkdirSync(join(root, ".bobbit", "config"), { recursive: true });
	const response = await apiFetch("/api/projects", { method: "POST", body: JSON.stringify({ name: "canonical mutation parity", rootPath: root, __e2e_seed_skip__: true }) });
	expect(response.status).toBe(201);
	projectId = (await response.json()).id;
});

test.afterAll(async () => {
	if (staffId) await apiFetch(`/api/staff/${staffId}`, { method: "DELETE" }).catch(() => undefined);
	if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => undefined);
	if (root) rmSync(root, { recursive: true, force: true });
});

test("ordinary role, workflow, and staff routes retain durable records through canonical mutations", async () => {
	const role = await apiFetch("/api/roles", { method: "POST", body: JSON.stringify({ projectId, name: roleName, label: "Parity role", promptTemplate: "Be helpful.", accessory: "none", thinkingLevel: "low" }) });
	expect(role.status).toBe(201);
	expect((await (await apiFetch(`/api/roles?projectId=${encodeURIComponent(projectId)}`)).json()).roles.some((item: any) => item.name === roleName && item.thinkingLevel === "low")).toBe(true);

	const workflow = await apiFetch("/api/workflows", { method: "POST", body: JSON.stringify({ projectId, id: workflowId, name: "Parity workflow", gates: [{ id: "build", name: "Build", dependsOn: [], verify: [{ name: "Build", type: "command", run: "echo ok" }] }] }) });
	expect(workflow.status).toBe(201);
	expect((await (await apiFetch(`/api/workflows/${workflowId}?projectId=${encodeURIComponent(projectId)}`)).json()).id).toBe(workflowId);

	const staff = await apiFetch("/api/staff", { method: "POST", body: JSON.stringify({ projectId, name: `Parity staff ${suffix}`, systemPrompt: "Help with parity checks.", roleId: roleName, worktree: false }) });
	expect(staff.status).toBe(201);
	const record = await staff.json();
	staffId = record.id;
	expect((await (await apiFetch(`/api/staff/${staffId}`)).json())).toMatchObject({ id: staffId, roleId: roleName, projectId });
});
