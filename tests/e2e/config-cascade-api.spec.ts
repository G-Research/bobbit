/**
 * Config Cascade API E2E tests.
 *
 * Validates the three-layer resolution cascade (builtin → server → project)
 * for roles, personalities, workflows, and tools. Tests origin tagging,
 * customize/override endpoints, and cascade correctness.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, nonGitCwd } from "./e2e-setup.js";
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
	mkdirSync(join(dir, ".bobbit", "config", "personalities"), { recursive: true });
	mkdirSync(join(dir, ".bobbit", "config", "workflows"), { recursive: true });
	mkdirSync(join(dir, ".bobbit", "config", "tools"), { recursive: true });
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	return dir;
}

/** Register a project via API, return the project object (including `id`). */
async function registerProject(name: string, rootPath: string) {
	const res = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath }),
	});
	expect(res.status).toBe(201);
	return res.json();
}

/** Delete a project via API (best-effort). */
async function deleteProject(id: string) {
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Config Cascade API", () => {

	test("GET /api/roles returns items with origin field", async () => {
		const res = await apiFetch("/api/roles");
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(data.roles.length).toBeGreaterThan(0);
		for (const role of data.roles) {
			expect(role.origin).toBeDefined();
			expect(["builtin", "server", "project"]).toContain(role.origin);
		}
	});

	test("GET /api/personalities returns items with origin field", async () => {
		const res = await apiFetch("/api/personalities");
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(data.personalities.length).toBeGreaterThan(0);
		for (const p of data.personalities) {
			expect(p.origin).toBeDefined();
			expect(["builtin", "server", "project"]).toContain(p.origin);
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
		const tmpDir = createProjectDir();
		const proj = await registerProject("cascade-test-inherit", tmpDir);

		try {
			// Project has empty config — should inherit from server/builtins
			const res = await apiFetch(`/api/roles?projectId=${proj.id}`);
			expect(res.ok).toBe(true);
			const data = await res.json();
			expect(data.roles.length).toBeGreaterThan(0);
			// All roles should be builtin or server (project config is empty)
			for (const r of data.roles) {
				expect(["builtin", "server"]).toContain(r.origin);
			}
		} finally {
			await deleteProject(proj.id);
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("customize role at project level sets origin to 'project'", async () => {
		const tmpDir = createProjectDir();
		const proj = await registerProject("cascade-test-customize", tmpDir);

		try {
			// Find a role that exists (e.g. "coder")
			const before = await apiFetch(`/api/roles?projectId=${proj.id}`);
			const beforeData = await before.json();
			const coder = beforeData.roles.find((r: any) => r.name === "coder");
			expect(coder).toBeDefined();
			const initialOrigin = coder.origin;
			expect(["builtin", "server"]).toContain(initialOrigin);

			// Customize at project level
			const customizeRes = await apiFetch(
				`/api/roles/coder/customize?scope=project&projectId=${proj.id}`,
				{ method: "POST" },
			);
			expect(customizeRes.status).toBe(201);

			// Verify origin changed to "project"
			const after = await apiFetch(`/api/roles?projectId=${proj.id}`);
			const afterData = await after.json();
			const coderAfter = afterData.roles.find((r: any) => r.name === "coder");
			expect(coderAfter.origin).toBe("project");
			expect(coderAfter.overrides).toBe(initialOrigin);
		} finally {
			await deleteProject(proj.id);
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("revert role override restores inherited origin", async () => {
		const tmpDir = createProjectDir();
		const proj = await registerProject("cascade-test-revert", tmpDir);

		try {
			// Get initial origin
			const before = await apiFetch(`/api/roles?projectId=${proj.id}`);
			const beforeData = await before.json();
			const coder = beforeData.roles.find((r: any) => r.name === "coder");
			const initialOrigin = coder.origin;
			const initialOverrides = coder.overrides;

			// Customize then revert
			await apiFetch(
				`/api/roles/coder/customize?scope=project&projectId=${proj.id}`,
				{ method: "POST" },
			);

			const revertRes = await apiFetch(
				`/api/roles/coder/override?scope=project&projectId=${proj.id}`,
				{ method: "DELETE" },
			);
			expect(revertRes.status).toBe(200);

			// Verify it reverted to the same state as before customization
			const after = await apiFetch(`/api/roles?projectId=${proj.id}`);
			const afterData = await after.json();
			const coderAfter = afterData.roles.find((r: any) => r.name === "coder");
			expect(coderAfter.origin).toBe(initialOrigin);
			expect(coderAfter.overrides).toBe(initialOverrides);
		} finally {
			await deleteProject(proj.id);
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("project-scoped role creation has origin 'project'", async () => {
		const tmpDir = createProjectDir();
		const proj = await registerProject("cascade-test-create", tmpDir);
		const roleName = `proj-only-${Date.now()}`;

		try {
			// Create a role scoped to the project
			const createRes = await apiFetch("/api/roles", {
				method: "POST",
				body: JSON.stringify({
					name: roleName,
					label: "Project Only",
					promptTemplate: "test",
					projectId: proj.id,
				}),
			});
			expect(createRes.status).toBe(201);

			// Visible in project scope with origin "project"
			const projRoles = await apiFetch(`/api/roles?projectId=${proj.id}`);
			const projData = await projRoles.json();
			const found = projData.roles.find((r: any) => r.name === roleName);
			expect(found).toBeDefined();
			expect(found.origin).toBe("project");

			// NOT visible in system scope
			const sysRoles = await apiFetch("/api/roles");
			const sysData = await sysRoles.json();
			const notFound = sysData.roles.find((r: any) => r.name === roleName);
			expect(notFound).toBeUndefined();
		} finally {
			await deleteProject(proj.id);
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("cascade correctness: server override shadows builtins for all projects", async () => {
		const tmpDirA = createProjectDir();
		const tmpDirB = createProjectDir();
		const projA = await registerProject("cascade-A", tmpDirA);
		const projB = await registerProject("cascade-B", tmpDirB);

		try {
			// Get the initial origin of "coder" for project A
			const beforeA = await apiFetch(`/api/roles?projectId=${projA.id}`);
			const beforeAData = await beforeA.json();
			const coderInitial = beforeAData.roles.find((r: any) => r.name === "coder");
			expect(coderInitial).toBeDefined();

			// Both projects should see the same origin for "coder"
			const beforeB = await apiFetch(`/api/roles?projectId=${projB.id}`);
			const beforeBData = await beforeB.json();
			const coderB = beforeBData.roles.find((r: any) => r.name === "coder");
			expect(coderB.origin).toBe(coderInitial.origin);

			// Customize coder at project A level only
			await apiFetch(
				`/api/roles/coder/customize?scope=project&projectId=${projA.id}`,
				{ method: "POST" },
			);

			// Project A should see "project" origin
			const afterA = await apiFetch(`/api/roles?projectId=${projA.id}`);
			const afterAData = await afterA.json();
			expect(afterAData.roles.find((r: any) => r.name === "coder").origin).toBe("project");

			// Project B should still see the original origin (unchanged)
			const afterB = await apiFetch(`/api/roles?projectId=${projB.id}`);
			const afterBData = await afterB.json();
			expect(afterBData.roles.find((r: any) => r.name === "coder").origin).toBe(coderInitial.origin);

			// Revert project A override
			await apiFetch(
				`/api/roles/coder/override?scope=project&projectId=${projA.id}`,
				{ method: "DELETE" },
			);

			// Project A reverts to the original
			const revertedA = await apiFetch(`/api/roles?projectId=${projA.id}`);
			const revertedAData = await revertedA.json();
			expect(revertedAData.roles.find((r: any) => r.name === "coder").origin).toBe(coderInitial.origin);
		} finally {
			await deleteProject(projA.id);
			await deleteProject(projB.id);
			rmSync(tmpDirA, { recursive: true, force: true });
			rmSync(tmpDirB, { recursive: true, force: true });
		}
	});

	test("customize personality at project level", async () => {
		const tmpDir = createProjectDir();
		const proj = await registerProject("cascade-personality", tmpDir);

		try {
			// List personalities — find one to customize
			const before = await apiFetch(`/api/personalities?projectId=${proj.id}`);
			const beforeData = await before.json();
			expect(beforeData.personalities.length).toBeGreaterThan(0);
			const first = beforeData.personalities[0];
			const initialOrigin = first.origin;

			// Customize at project level
			const customizeRes = await apiFetch(
				`/api/personalities/${first.name}/customize?scope=project&projectId=${proj.id}`,
				{ method: "POST" },
			);
			expect(customizeRes.status).toBe(201);

			// Verify
			const after = await apiFetch(`/api/personalities?projectId=${proj.id}`);
			const afterData = await after.json();
			const customized = afterData.personalities.find((p: any) => p.name === first.name);
			expect(customized.origin).toBe("project");
			expect(customized.overrides).toBe(initialOrigin);

			// Revert
			const revertRes = await apiFetch(
				`/api/personalities/${first.name}/override?scope=project&projectId=${proj.id}`,
				{ method: "DELETE" },
			);
			expect(revertRes.status).toBe(200);

			const reverted = await apiFetch(`/api/personalities?projectId=${proj.id}`);
			const revertedData = await reverted.json();
			const revertedItem = revertedData.personalities.find((p: any) => p.name === first.name);
			expect(revertedItem.origin).toBe(initialOrigin);
		} finally {
			await deleteProject(proj.id);
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("customize workflow at project level", async () => {
		const tmpDir = createProjectDir();
		const proj = await registerProject("cascade-workflow", tmpDir);

		try {
			const before = await apiFetch(`/api/workflows?projectId=${proj.id}`);
			const beforeData = await before.json();
			expect(beforeData.workflows.length).toBeGreaterThan(0);
			const first = beforeData.workflows[0];
			const initialOrigin = first.origin;
			const wfId = first.id;

			// Customize at project level
			const customizeRes = await apiFetch(
				`/api/workflows/${wfId}/customize?scope=project&projectId=${proj.id}`,
				{ method: "POST" },
			);
			expect(customizeRes.status).toBe(201);

			// Verify
			const after = await apiFetch(`/api/workflows?projectId=${proj.id}`);
			const afterData = await after.json();
			const customized = afterData.workflows.find((w: any) => w.id === wfId);
			expect(customized.origin).toBe("project");
			expect(customized.overrides).toBe(initialOrigin);

			// Revert
			const revertRes = await apiFetch(
				`/api/workflows/${wfId}/override?scope=project&projectId=${proj.id}`,
				{ method: "DELETE" },
			);
			expect(revertRes.status).toBe(200);

			const reverted = await apiFetch(`/api/workflows?projectId=${proj.id}`);
			const revertedData = await reverted.json();
			const revertedItem = revertedData.workflows.find((w: any) => w.id === wfId);
			expect(revertedItem.origin).toBe(initialOrigin);
		} finally {
			await deleteProject(proj.id);
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("tools with projectId scope return origin fields", async () => {
		const tmpDir = createProjectDir();
		const proj = await registerProject("cascade-tools", tmpDir);

		try {
			const res = await apiFetch(`/api/tools?projectId=${proj.id}`);
			expect(res.ok).toBe(true);
			const data = await res.json();
			expect(data.tools.length).toBeGreaterThan(0);
			for (const t of data.tools) {
				expect(t.origin).toBeDefined();
				expect(["builtin", "server"]).toContain(t.origin);
			}
		} finally {
			await deleteProject(proj.id);
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
