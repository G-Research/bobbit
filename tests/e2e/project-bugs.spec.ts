/**
 * Reproducing tests for project management bugs 1, 3, and 3b.
 *
 * These tests assert the DESIRED (post-fix) behavior and are expected
 * to FAIL on the current (pre-fix) codebase, proving the bugs exist.
 *
 * Bug 1: Fresh folder with no .bobbit/ should start with zero projects.
 * Bug 3: POST /api/projects with upsert should be idempotent.
 * Bug 3b: PUT /api/projects/:id/config should validate atomically.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base, apiFetch, nonGitCwd } from "./e2e-setup.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test.describe("Bug 1: Fresh folder auto-project creation", () => {
	test("gateway started in a folder with no .bobbit/ should have zero projects", async () => {
		// The in-process harness creates an isolated directory with NO .bobbit/
		// folder pre-existing (it scaffolds one during setup). However, the key
		// behavior is: ensureDefaultProject() should NOT run if the original
		// folder had no .bobbit/. The harness sets BOBBIT_DIR to an ephemeral
		// temp dir — not a real project root — so no real project should be
		// auto-registered.
		//
		// Current bug: ensureDefaultProject() runs unconditionally, so this
		// returns 1 project. After fix, it should return 0.
		const resp = await apiFetch("/api/projects");
		expect(resp.status).toBe(200);
		const projects = await resp.json();
		expect(projects).toHaveLength(0);
	});
});

test.describe("Bug 3: Project registration upsert (idempotent)", () => {
	let projectRootPath: string;

	test.beforeAll(() => {
		// Create a real directory to use as project root
		projectRootPath = join(tmpdir(), `bobbit-e2e-project-${Date.now()}`);
		mkdirSync(projectRootPath, { recursive: true });
	});

	test("registering the same rootPath twice with upsert returns existing project", async () => {
		// First registration — should succeed
		const resp1 = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "test-project", rootPath: projectRootPath }),
		});
		expect(resp1.status).toBe(201);
		const project1 = await resp1.json();
		expect(project1.id).toBeTruthy();

		// Second registration with same rootPath and upsert: true
		// Current bug: this returns 400 "already registered"
		// After fix: should return 200 with the same project
		const resp2 = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({
				name: "test-project",
				rootPath: projectRootPath,
				upsert: true,
			}),
		});
		expect(resp2.status).toBeLessThan(400);
		const project2 = await resp2.json();
		expect(project2.id).toBe(project1.id);
	});
});

test.describe("Bug 3b: Config write atomicity", () => {
	let projectId: string;
	let projectRootPath: string;

	test.beforeAll(async () => {
		projectRootPath = join(tmpdir(), `bobbit-e2e-config-${Date.now()}`);
		mkdirSync(projectRootPath, { recursive: true });

		const resp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "config-test", rootPath: projectRootPath }),
		});
		// May be 201 or 200 depending on whether Bug 1 fix is in place
		const project = await resp.json();
		projectId = project.id;
	});

	test("PUT config with one invalid key should write nothing (atomic)", async () => {
		// Write a mix of valid and invalid keys
		// The key "invalid.key" contains a dot, which should fail validation.
		// Current bug: valid keys before the invalid one are written (partial write).
		// After fix: nothing should be written if any key is invalid.
		const resp = await apiFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({
				build_command: "npm run build",
				"invalid.key": "bad-value",
				test_command: "npm test",
			}),
		});
		expect(resp.status).toBe(400);

		// Verify NO keys were written — build_command should NOT exist
		const getResp = await apiFetch(`/api/projects/${projectId}/config`);
		expect(getResp.status).toBe(200);
		const config = await getResp.json();

		// After atomic fix: build_command should not have been written
		// Current bug: build_command IS written because the loop processes
		// it before hitting the invalid key
		expect(config.build_command).toBeUndefined();
	});

	test("PUT config with all valid keys succeeds", async () => {
		const resp = await apiFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({
				build_command: "npm run build",
				test_command: "npm test",
			}),
		});
		expect(resp.status).toBe(200);

		const getResp = await apiFetch(`/api/projects/${projectId}/config`);
		const config = await getResp.json();
		expect(config.build_command).toBe("npm run build");
		expect(config.test_command).toBe("npm test");
	});
});
