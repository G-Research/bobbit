import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect } from "./in-process-harness.js";
import { apiFetch, bobbitDir, defaultProject, registerProject } from "./e2e-setup.js";

test.describe.configure({ mode: "serial" });

const tempRoots: string[] = [];
const createdProjectIds: string[] = [];

function tempProjectRoot(prefix: string): string {
	const root = mkdtempSync(join(dirname(bobbitDir()), `${prefix}-`));
	tempRoots.push(root);
	return root;
}

async function readJson(resp: Response): Promise<{ text: string; json: any }> {
	const text = await resp.text();
	try { return { text, json: JSON.parse(text) }; }
	catch { return { text, json: {} }; }
}

async function setHeadquartersSandbox(value: "docker" | null): Promise<void> {
	const resp = await apiFetch("/api/project-config", {
		method: "PUT",
		body: JSON.stringify({ sandbox: value }),
	});
	expect(resp.status, `set Headquarters sandbox=${value}: ${await resp.text()}`).toBe(200);
}

async function setProjectSandbox(projectId: string, value: "docker" | null): Promise<void> {
	const resp = await apiFetch(`/api/projects/${projectId}/config`, {
		method: "PUT",
		body: JSON.stringify({ sandbox: value }),
	});
	expect(resp.status, `set project ${projectId} sandbox=${value}: ${await resp.text()}`).toBe(200);
}

async function createTempProject(name: string): Promise<{ id: string; rootPath: string }> {
	const project = await registerProject({
		name,
		rootPath: tempProjectRoot(name),
		seedWorkflows: false,
	});
	createdProjectIds.push(project.id);
	return { id: project.id, rootPath: project.rootPath };
}

test.afterAll(async () => {
	await setHeadquartersSandbox(null).catch(() => undefined);
	for (const projectId of [...createdProjectIds].reverse()) {
		await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => undefined);
	}
	for (const root of tempRoots.reverse()) {
		rmSync(root, { recursive: true, force: true });
	}
});

test("POST /api/sessions rejects an explicit nonexistent cwd outside the selected project", async () => {
	const project = await defaultProject();
	const missingOutsideCwd = join(dirname(project.rootPath), `missing-outside-${Date.now()}`, "child");

	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			projectId: project.id,
			cwd: missingOutsideCwd,
			worktree: false,
		}),
	});
	const body = await readJson(resp);

	expect(resp.status, body.text).toBe(422);
	expect(body.json.code).toBe("CWD_OUTSIDE_PROJECT");
});

test("POST /api/sessions checks sandbox config on the selected normal project", async () => {
	const project = await createTempProject(`sandbox-selected-${Date.now()}`);
	await setHeadquartersSandbox(null);
	await setProjectSandbox(project.id, "docker");

	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			projectId: project.id,
			cwd: project.rootPath,
			worktree: false,
			sandboxed: true,
			// Stop after sandbox preflight without creating a real sandboxed session.
			roleId: "__missing_sandbox_regression_role__",
		}),
	});
	const body = await readJson(resp);

	// With selected project config, the endpoint reaches Docker preflight (503 on
	// hosts without Docker) or later role validation (404 on hosts with Docker).
	// A 400 "not configured" response would mean it read Headquarters config.
	expect([404, 503], body.text).toContain(resp.status);
	if (resp.status === 404) expect(body.json.error).toContain("Role");
	if (resp.status === 503) expect(body.json.error).toContain("Docker is not available");
});

test("POST /api/sessions does not let Headquarters sandbox config authorize a normal project", async () => {
	const project = await createTempProject(`sandbox-unconfigured-${Date.now()}`);
	await setHeadquartersSandbox("docker");

	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			projectId: project.id,
			cwd: project.rootPath,
			worktree: false,
			sandboxed: true,
			roleId: "__missing_sandbox_regression_role__",
		}),
	});
	const body = await readJson(resp);

	expect(resp.status, body.text).toBe(400);
	expect(body.json.error).toContain("Docker sandbox is not configured");
});
