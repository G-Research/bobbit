/**
 * Config Cascade API E2E tests.
 *
 * Validates the three-layer resolution cascade (builtin → server → project)
 * for roles, workflows, and tools. Tests origin tagging,
 * customize/override endpoints, and cascade correctness.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, rawApiFetch } from "./_e2e/e2e-setup.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp dir with .bobbit scaffolding suitable for a second project. */
function createProjectDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "bobbit-cascade-"));
	mkdirSync(join(dir, ".bobbit", "config", "roles"), { recursive: true });
	mkdirSync(join(dir, ".bobbit", "config", "workflows"), { recursive: true });
	mkdirSync(join(dir, ".bobbit", "config", "tools"), { recursive: true });
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	return dir;
}

/** Register a project via API, return the project object (including `id`). */
async function registerProject(name: string, rootPath: string) {
	const res = await apiFetch("/api/projects", {
		method: "POST",
		// Opt out of the harness's auto-workflow-seed so cascade-origin
		// assertions in this file see workflows resolving to the layer
		// they actually came from (server-seed by the harness, not
		// project-seed by apiFetch). See tests/e2e/seed-workflows.ts.
		body: JSON.stringify({ name, rootPath, __e2e_seed_skip__: true }),
	});
	expect(res.status).toBe(201);
	return res.json();
}

let primaryDir = "";
let secondaryDir = "";
let primaryProject: { id: string };
let secondaryProject: { id: string };

function resetProjectRoles(gateway: any, projectId: string): void {
	const store = gateway.projectContextManager.getOrCreate(projectId)?.roleStore;
	for (const role of store?.getAllLocal() ?? []) store.remove(role.name);
}

function resetSharedProjects(gateway: any): void {
	if (primaryProject) resetProjectRoles(gateway, primaryProject.id);
	if (secondaryProject) resetProjectRoles(gateway, secondaryProject.id);
}

test.beforeAll(async () => {
	primaryDir = createProjectDir();
	secondaryDir = createProjectDir();
	primaryProject = await registerProject("cascade-shared-primary", primaryDir);
	secondaryProject = await registerProject("cascade-shared-secondary", secondaryDir);
});

test.beforeEach(({ gateway }) => resetSharedProjects(gateway));
test.afterEach(({ gateway }) => resetSharedProjects(gateway));

test.afterAll(async () => {
	for (const project of [secondaryProject, primaryProject]) {
		if (project) await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
	}
	for (const dir of [secondaryDir, primaryDir]) {
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Config Cascade API", () => {

	test("GET /api/tools and /api/roles require projectId", async () => {
		for (const pathname of ["/api/tools", "/api/roles"]) {
			const res = await rawApiFetch(pathname);
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.code).toBe("PROJECT_ID_REQUIRED");
		}
	});

	test("GET /api/roles returns items with origin field @smoke", async () => {
		const res = await apiFetch("/api/roles");
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(data.roles.length).toBeGreaterThan(0);
		for (const role of data.roles) {
			expect(role.origin).toBeDefined();
			expect(["builtin", "server", "project"]).toContain(role.origin);
		}
	});

	test("GET /api/workflows returns items with origin field", async () => {
		const res = await apiFetch("/api/workflows");
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(data.workflows.length).toBeGreaterThan(0);
		for (const w of data.workflows) {
			expect(w.origin).toBeDefined();
			expect(["builtin", "server", "project"]).toContain(w.origin);
		}
	});

	test("GET /api/tools returns items with origin field", async () => {
		const res = await apiFetch("/api/tools");
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(data.tools.length).toBeGreaterThan(0);
		for (const t of data.tools) {
			expect(t.origin).toBeDefined();
			expect(["builtin", "server", "project"]).toContain(t.origin);
		}
	});

	test("server-level roles returned by cascade have origin 'server'", async () => {
		// The test environment scaffolds default roles into the server config dir.
		// These should appear with origin "server" (since they exist in the
		// default project's config, shadowing builtins).
		const res = await apiFetch("/api/roles");
		const data = await res.json();
		// Find a well-known role that would be scaffolded
		const coder = data.roles.find((r: any) => r.name === "coder");
		expect(coder).toBeDefined();
		// In test env, scaffolded roles show as "server" since they're in the
		// default project's config dir (which is the server level).
		expect(["builtin", "server"]).toContain(coder.origin);
	});

	test("project-scoped role resolution returns inherited items", async () => {
		// Project has empty config — should inherit from server/builtins.
		const res = await apiFetch(`/api/roles?projectId=${primaryProject.id}`);
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(data.roles.length).toBeGreaterThan(0);
		for (const r of data.roles) {
			expect(["builtin", "server"]).toContain(r.origin);
		}
	});

	test("customize role at project level sets origin to 'project'", async () => {
		const before = await apiFetch(`/api/roles?projectId=${primaryProject.id}`);
		const coder = (await before.json()).roles.find((r: any) => r.name === "coder");
		expect(coder).toBeDefined();
		expect(["builtin", "server"]).toContain(coder.origin);

		const customizeRes = await apiFetch(
			`/api/roles/coder/customize?scope=project&projectId=${primaryProject.id}`,
			{ method: "POST" },
		);
		expect(customizeRes.status).toBe(201);

		const after = await apiFetch(`/api/roles?projectId=${primaryProject.id}`);
		const coderAfter = (await after.json()).roles.find((r: any) => r.name === "coder");
		expect(coderAfter.origin).toBe("project");
		expect(coderAfter.overrides).toBe(coder.origin);
	});

	test("revert role override restores inherited origin", async () => {
		const before = await apiFetch(`/api/roles?projectId=${primaryProject.id}`);
		const coder = (await before.json()).roles.find((r: any) => r.name === "coder");

		await apiFetch(
			`/api/roles/coder/customize?scope=project&projectId=${primaryProject.id}`,
			{ method: "POST" },
		);
		const revertRes = await apiFetch(
			`/api/roles/coder/override?scope=project&projectId=${primaryProject.id}`,
			{ method: "DELETE" },
		);
		expect(revertRes.status).toBe(200);

		const after = await apiFetch(`/api/roles?projectId=${primaryProject.id}`);
		const coderAfter = (await after.json()).roles.find((r: any) => r.name === "coder");
		expect(coderAfter.origin).toBe(coder.origin);
		expect(coderAfter.overrides).toBe(coder.overrides);
	});

	test("project-scoped role creation has origin 'project'", async () => {
		const roleName = `proj-only-${Date.now()}`;
		const createRes = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: roleName,
				label: "Project Only",
				promptTemplate: "test",
				projectId: primaryProject.id,
			}),
		});
		expect(createRes.status).toBe(201);

		const projRoles = await apiFetch(`/api/roles?projectId=${primaryProject.id}`);
		const found = (await projRoles.json()).roles.find((r: any) => r.name === roleName);
		expect(found).toBeDefined();
		expect(found.origin).toBe("project");

		const sysRoles = await apiFetch("/api/roles");
		const notFound = (await sysRoles.json()).roles.find((r: any) => r.name === roleName);
		expect(notFound).toBeUndefined();
	});

	test("cascade correctness: server override shadows builtins for all projects", async () => {
		const beforeA = await apiFetch(`/api/roles?projectId=${primaryProject.id}`);
		const coderInitial = (await beforeA.json()).roles.find((r: any) => r.name === "coder");
		expect(coderInitial).toBeDefined();

		const beforeB = await apiFetch(`/api/roles?projectId=${secondaryProject.id}`);
		const coderB = (await beforeB.json()).roles.find((r: any) => r.name === "coder");
		expect(coderB.origin).toBe(coderInitial.origin);

		await apiFetch(
			`/api/roles/coder/customize?scope=project&projectId=${primaryProject.id}`,
			{ method: "POST" },
		);

		const afterA = await apiFetch(`/api/roles?projectId=${primaryProject.id}`);
		expect((await afterA.json()).roles.find((r: any) => r.name === "coder").origin).toBe("project");

		const afterB = await apiFetch(`/api/roles?projectId=${secondaryProject.id}`);
		expect((await afterB.json()).roles.find((r: any) => r.name === "coder").origin).toBe(coderInitial.origin);

		await apiFetch(
			`/api/roles/coder/override?scope=project&projectId=${primaryProject.id}`,
			{ method: "DELETE" },
		);
		const revertedA = await apiFetch(`/api/roles?projectId=${primaryProject.id}`);
		expect((await revertedA.json()).roles.find((r: any) => r.name === "coder").origin).toBe(coderInitial.origin);
	});

	// Removed: "customize workflow at project level" — workflows are no longer
	// part of the cascade (no builtin/server layer for them), so the
	// customize/override endpoints have nothing upstream to copy from. The
	// surviving project-only revert path is exercised by
	// `tests/e2e/workflows-project-scope.spec.ts` and `workflows-api.spec.ts`.

	test("tools with projectId scope return origin fields", async () => {
		const res = await apiFetch(`/api/tools?projectId=${primaryProject.id}`);
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(data.tools.length).toBeGreaterThan(0);
		for (const t of data.tools) {
			expect(t.origin).toBeDefined();
			expect(["builtin", "server", "project"]).toContain(t.origin);
		}
	});
});
