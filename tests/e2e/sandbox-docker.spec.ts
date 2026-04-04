/**
 * Docker sandbox E2E tests — cross-agent commit visibility.
 *
 * This is the only test that genuinely requires Docker containers.
 * All other sandbox tests (args, team repo CRUD, remote setup, hook,
 * mount args) have been migrated to tests/sandbox-team-repo.test.ts.
 *
 * Requires Docker — auto-skips when Docker is unavailable.
 */
import { test, expect } from "./in-process-harness.js";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFileCb);

// Check Docker availability at module level — skip all tests if unavailable.
let dockerAvailable = false;
try {
	await execFileAsync("docker", ["info"], { timeout: 10_000 });
	dockerAvailable = true;
} catch {
	/* Docker not available */
}

// /proc/1/environ, buildDockerRunArgs, pool mount — migrated to tests/sandbox-team-repo.test.ts

test.describe("Sandbox Docker — shared team repo", () => {
	test.skip(!dockerAvailable, "Docker not available");

	// Docker + git clone operations need generous timeouts
	test.setTimeout(120_000);

	// Use a unique goal ID per test run to avoid collisions
	const goalId = `test-${Date.now()}`;
	// We'll use the current repo as the source for createTeamRepo
	const repoPath = path.resolve(process.cwd());
	let pool: InstanceType<typeof import("../../dist/server/agent/sandbox-pool.js").SandboxPool> | null = null;

	// Track containers and paths for cleanup
	const claimedContainers: string[] = [];
	let teamRepoPath: string | null = null;

	test.beforeAll(async () => {
		const { SandboxPool } = await import("../../dist/server/agent/sandbox-pool.js");
		pool = new SandboxPool({
			poolSize: 0, // don't pre-warm — we create slots on demand
			maxIdleSeconds: 300,
			image: "node:20-slim",
			projectDir: repoPath,
			repoPath,
			healthCheckIntervalMs: 30_000,
		});
		await pool.init();
	});

	test.afterAll(async () => {
		// Clean up any claimed containers
		for (const cid of claimedContainers) {
			await execFileAsync("docker", ["rm", "-f", cid], { timeout: 10_000 }).catch(() => {});
		}
		// Destroy team repo if created
		if (pool) {
			await pool.destroyTeamRepo(goalId).catch(() => {});
			await pool.shutdown();
		}
	});

	// All other tests migrated to tests/sandbox-team-repo.test.ts (no Docker needed)

	test("cross-agent commit visibility via shared team repo", { timeout: 180_000 }, async () => {
		const crossGoalId = `test-cross-${Date.now()}`;
		const trPath = await pool!.createTeamRepo(crossGoalId, repoPath, "master");

		// Claim two slots, both with teamRepoPath
		const sessionA = "test-agent-a-" + Date.now();
		const sessionB = "test-agent-b-" + Date.now();
		const branchName = `test-branch-${Date.now()}`;

		const slotA = await pool!.claim(sessionA, {
			branch: branchName,
			teamRepoPath: trPath,
		});
		expect(slotA).not.toBeNull();
		claimedContainers.push(slotA!.containerId);

		const slotB = await pool!.claim(sessionB, {
			branch: branchName,
			teamRepoPath: trPath,
		});
		expect(slotB).not.toBeNull();
		claimedContainers.push(slotB!.containerId);

		// In slot A: create a file, add, commit
		const testFileName = "team-repo-test.txt";
		const testContent = `cross-agent-test-${Date.now()}`;
		fs.writeFileSync(path.join(slotA!.worktreePath, testFileName), testContent);

		await execFileAsync("git", ["add", testFileName], {
			cwd: slotA!.worktreePath, timeout: 5_000,
		});
		await execFileAsync("git", [
			"-c", "user.name=Test", "-c", "user.email=test@test.com",
			"commit", "-m", "test: cross-agent commit visibility",
		], {
			cwd: slotA!.worktreePath, timeout: 10_000,
		});

		// Manually push to the team repo using the host-side path
		// (the post-commit hook uses container-internal paths; in tests we push directly)
		await execFileAsync("git", ["push", trPath, branchName], {
			cwd: slotA!.worktreePath, timeout: 15_000,
		});

		// In slot B: fetch from the team repo using host-side path and verify visibility
		await execFileAsync("git", ["fetch", trPath, branchName], {
			cwd: slotB!.worktreePath, timeout: 15_000,
		});

		const { stdout: logOutput } = await execFileAsync(
			"git", ["log", "FETCH_HEAD", "--oneline", "-5"],
			{ cwd: slotB!.worktreePath, timeout: 5_000 },
		);
		expect(logOutput).toContain("test: cross-agent commit visibility");

		// Cleanup
		await pool!.release(sessionA, slotA!.containerId);
		await pool!.release(sessionB, slotB!.containerId);
		claimedContainers.length = 0; // cleared by release
		await pool!.destroyTeamRepo(crossGoalId);
	});
});
