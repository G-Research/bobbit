/**
 * Reproducing test for per-project worktree pool bug.
 *
 * The worktree pool is currently a single global instance tied to the default
 * project. Multi-project setups don't get per-project pools, and the API
 * `GET /api/worktree-pool` returns a flat status object instead of per-project data.
 *
 * This test registers two git-repo projects and asserts that the pool status API
 * returns a `pools` object keyed by projectId. It is expected to FAIL on the
 * pre-fix codebase because the current API returns `{ enabled, ready, target, filling }`.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

test.describe("per-project worktree pool", () => {
	let repoA: string;
	let repoB: string;
	let projectAId: string;
	let projectBId: string;

	test.beforeAll(() => {
		const base = join(tmpdir(), `bobbit-e2e-pool-${Date.now()}`);
		repoA = join(base, "repo-a");
		repoB = join(base, "repo-b");

		// Create two separate git repos with initial commits
		for (const repoPath of [repoA, repoB]) {
			mkdirSync(repoPath, { recursive: true });
			execFileSync("git", ["init"], { cwd: repoPath });
			execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoPath });
			execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath });
			execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoPath });
		}
	});

	test("registering two git-repo projects returns per-project pool data", async () => {
		// Register project A
		const respA = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "pool-project-a", rootPath: repoA }),
		});
		expect(respA.status).toBe(201);
		const projA = await respA.json();
		projectAId = projA.id;

		// Register project B
		const respB = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "pool-project-b", rootPath: repoB }),
		});
		expect(respB.status).toBe(201);
		const projB = await respB.json();
		projectBId = projB.id;

		// GET /api/worktree-pool should return per-project pools
		const poolResp = await apiFetch("/api/worktree-pool");
		expect(poolResp.status).toBe(200);
		const poolData = await poolResp.json();

		// The fixed API should return { pools: { [projectId]: { enabled, ready, target, filling } } }
		// The current (buggy) API returns a flat { enabled, ready, target, filling } with no per-project awareness
		expect(poolData).toHaveProperty("pools");
		expect(poolData.pools).toHaveProperty(projectAId);
		expect(poolData.pools).toHaveProperty(projectBId);

		// Each project's pool entry should have the expected shape
		for (const pid of [projectAId, projectBId]) {
			const entry = poolData.pools[pid];
			expect(entry).toHaveProperty("enabled");
			expect(entry).toHaveProperty("ready");
			expect(entry).toHaveProperty("target");
		}
	});
});
