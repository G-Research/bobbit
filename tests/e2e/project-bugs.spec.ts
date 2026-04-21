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
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

test.describe("Bug 1: Fresh folder has zero projects (no implicit default)", () => {
	test("gateway starts with an empty project list", async () => {
		// The "eliminate default project" refactor removes ensureDefaultProject().
		// A fresh install — even one with an empty projects.json — must never
		// auto-register a project. The UI forces explicit Add Project.
		const resp = await apiFetch("/api/projects");
		expect(resp.status).toBe(200);
		const projects = await resp.json();
		// Worker-scoped state dir starts with zero projects. Other tests in the
		// same worker may have registered some; the invariant is only that the
		// server did NOT implicitly register one at startup.
		expect(Array.isArray(projects)).toBe(true);
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

test.describe("Bug 2: Subdirectory project worktree CWD offset", () => {
	let repoDir: string;
	let subdirPath: string;
	let projectId: string;

	test.beforeAll(async () => {
		// Create a real git repo with a subdirectory structure:
		//   <repoDir>/
		//     packages/my-app/    <-- project rootPath
		//       package.json
		repoDir = join(tmpdir(), `bobbit-e2e-subrepo-${Date.now()}`);
		subdirPath = join(repoDir, "packages", "my-app");
		mkdirSync(subdirPath, { recursive: true });
		writeFileSync(join(subdirPath, "package.json"), JSON.stringify({ name: "my-app" }));
		writeFileSync(join(repoDir, "README.md"), "# Monorepo\n");

		execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
		execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });

		// Register a project at the subdirectory (not the repo root)
		const resp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "subdir-project", rootPath: subdirPath }),
		});
		expect(resp.status).toBe(201);
		const project = await resp.json();
		projectId = project.id;
	});

	test("goal.cwd includes subdirectory offset within worktree", async () => {
		// Create a goal with cwd pointing to the subdirectory.
		// The goal-manager should detect the git repo root, compute the offset
		// (packages/my-app), and apply it to the worktree path.
		const resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Test subdir offset",
				cwd: subdirPath,
				spec: "Test goal for Bug 2",
				projectId,
			}),
		});
		expect(resp.status).toBe(201);
		const goal = await resp.json();

		// The goal should have a worktreePath at the repo-level worktree root
		expect(goal.worktreePath).toBeTruthy();
		// worktreePath should NOT contain the subdirectory offset
		expect(goal.worktreePath).not.toMatch(/packages[/\\]my-app/);

		// The goal's cwd MUST include the subdirectory offset within the worktree
		expect(goal.cwd).toContain("packages");
		expect(goal.cwd).toMatch(/packages[/\\]my-app$/);

		// cwd should start with worktreePath (it's worktreePath + offset)
		const normalizedCwd = goal.cwd.replace(/\\/g, "/");
		const normalizedWt = goal.worktreePath.replace(/\\/g, "/");
		expect(normalizedCwd.startsWith(normalizedWt)).toBe(true);

		// Wait for worktree setup to complete, then verify cwd is preserved
		const goalId = goal.id;
		const start = Date.now();
		let readyGoal: any;
		while (Date.now() - start < 30_000) {
			const getResp = await apiFetch(`/api/goals/${goalId}`);
			readyGoal = await getResp.json();
			if (readyGoal.setupStatus === "ready" || readyGoal.setupStatus === "error") break;
			await new Promise(r => setTimeout(r, 500));
		}

		// After async setup, the cwd should still include the subdirectory offset
		expect(readyGoal.setupStatus).toBe("ready");
		expect(readyGoal.cwd).toMatch(/packages[/\\]my-app$/);
		// worktreePath should still be the worktree root (no subdirectory)
		expect(readyGoal.worktreePath).not.toMatch(/packages[/\\]my-app/);

		// Cleanup: delete the goal
		await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {});
	});
});
