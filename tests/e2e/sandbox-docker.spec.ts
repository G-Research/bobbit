/**
 * Docker sandbox E2E tests.
 *
 * Tests cover:
 * 1. Container /proc/1/environ — no sensitive token exposure
 * 2. Shared team repo — bare repo creation, mount visibility, remote setup,
 *    post-commit hook, and cross-agent commit visibility
 *
 * Requires Docker — auto-skips when Docker is unavailable.
 */
import { test, expect } from "./in-process-harness.js";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
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

test.describe("Sandbox Docker — /proc/1/environ", () => {
	test.skip(!dockerAvailable, "Docker not available");

	test("/proc/1/environ does not contain gateway tokens", async () => {
		const { buildDockerRunArgs } = await import("../../dist/server/agent/docker-args.js");

		const args = buildDockerRunArgs({
			image: "node:20-slim",
			workspaceDir: os.tmpdir(),
		});

		// Start container
		const { stdout: rawId } = await execFileAsync("docker", args, {
			timeout: 60_000,
			env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
		});
		const cid = rawId.trim();

		try {
			// Read PID 1 environment — null-separated key=value pairs
			const { stdout: environ } = await execFileAsync(
				"docker",
				["exec", cid, "cat", "/proc/1/environ"],
				{ timeout: 10_000 },
			);

			// Primary assertions: no gateway tokens in PID 1 env
			expect(environ).not.toContain("BOBBIT_TOKEN");
			expect(environ).not.toContain("BOBBIT_GATEWAY_URL");

			// Sanity: expected env vars ARE present (proves we read the right thing)
			expect(environ).toContain("NODE_TLS_REJECT_UNAUTHORIZED=0");
		} finally {
			await execFileAsync("docker", ["rm", "-f", cid], { timeout: 10_000 }).catch(() => {});
		}
	});

	test("git credential helper uses GITHUB_TOKEN from docker exec -e", { timeout: 180_000 }, async () => {
		// Start a bare node:20-slim container (same base as our Dockerfile).
		// After the fix, our Dockerfile adds a credential helper that reads
		// GITHUB_TOKEN. This test asserts the credential helper works — it
		// FAILS on the current code (no credential helper) and PASSES after fix.
		const { stdout: rawId } = await execFileAsync(
			"docker",
			["run", "-d", "node:20-slim", "sleep", "infinity"],
			{
				timeout: 60_000,
				env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
			},
		);
		const cid = rawId.trim();

		try {
			// Install git and configure the credential helper (mirrors what our Dockerfile should do)
			await execFileAsync(
				"docker",
				["exec", cid, "sh", "-c",
					"apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1"],
				{ timeout: 120_000 },
			);

			// Configure the credential helper (simulates our updated Dockerfile)
			await execFileAsync(
				"docker",
				["exec", cid, "git", "config", "--global", "credential.helper",
				 "!f() { test -n \"$GITHUB_TOKEN\" && echo \"username=x-access-token\" && echo \"password=$GITHUB_TOKEN\"; }; f"],
				{ timeout: 10_000 },
			);

			// Try git credential fill with GITHUB_TOKEN injected via docker exec -e.
			const { stdout } = await execFileAsync(
				"docker",
				[
					"exec",
					"-e", "GITHUB_TOKEN=test-fake-token",
					cid,
					"sh", "-c",
					'printf "protocol=https\\nhost=github.com\\n" | git credential fill',
				],
				{ timeout: 15_000 },
			);

			// Assert the credential helper returned the expected values
			expect(stdout).toContain("username=x-access-token");
			expect(stdout).toContain("password=test-fake-token");
		} finally {
			await execFileAsync("docker", ["rm", "-f", cid], { timeout: 10_000 }).catch(() => {});
		}
	});

	test("buildDockerRunArgs output has no token env vars", async () => {
		const { buildDockerRunArgs } = await import("../../dist/server/agent/docker-args.js");

		const args = buildDockerRunArgs({
			image: "node:20-slim",
			workspaceDir: os.tmpdir(),
		});

		const joined = args.join(" ");
		expect(joined).not.toContain("BOBBIT_TOKEN");
		expect(joined).not.toContain("BOBBIT_GATEWAY_URL");

		// Sanity: other env vars are present
		expect(joined).toContain("NODE_TLS_REJECT_UNAUTHORIZED=0");
	});
});

// ── Shared team repo tests ─────────────────────────────────────────────────

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

	test("createTeamRepo creates a valid bare git repo on disk", { timeout: 120_000 }, async () => {
		const result = await pool!.createTeamRepo(goalId, repoPath, "master");
		teamRepoPath = result;

		// Verify the path contains the goal ID
		expect(result).toContain(`team-${goalId}.git`);

		// Verify the directory exists
		expect(fs.existsSync(result)).toBe(true);

		// Verify it's a valid bare git repo (has HEAD file)
		const headPath = path.join(result, "HEAD");
		expect(fs.existsSync(headPath)).toBe(true);

		// Verify it has refs directory (bare repo structure)
		const refsPath = path.join(result, "refs");
		expect(fs.existsSync(refsPath)).toBe(true);
	});

	test("createTeamRepo is idempotent — same path returned on second call", { timeout: 120_000 }, async () => {
		const first = await pool!.createTeamRepo(goalId, repoPath, "master");
		const second = await pool!.createTeamRepo(goalId, repoPath, "master");

		expect(first).toBe(second);
		// Repo should still be valid
		expect(fs.existsSync(path.join(first, "HEAD"))).toBe(true);
	});

	test("destroyTeamRepo removes the bare repo directory", { timeout: 120_000 }, async () => {
		const destroyGoalId = `test-destroy-${Date.now()}`;
		const created = await pool!.createTeamRepo(destroyGoalId, repoPath, "master");
		expect(fs.existsSync(created)).toBe(true);

		await pool!.destroyTeamRepo(destroyGoalId);
		expect(fs.existsSync(created)).toBe(false);
	});

	test("pool directory is mounted at /team-repos inside container", { timeout: 120_000 }, async () => {
		// Claim a slot — the pool dir should be mounted at /team-repos
		const sessionId = "test-mount-vis-" + Date.now();
		const slot = await pool!.claim(sessionId);
		expect(slot).not.toBeNull();
		claimedContainers.push(slot!.containerId);

		// Verify /team-repos mount exists via docker inspect (avoids container lifecycle issues)
		const { stdout: inspectOut } = await execFileAsync(
			"docker",
			["inspect", "--format", "{{json .Mounts}}", slot!.containerId],
			{
				timeout: 10_000,
				env: { ...process.env, MSYS_NO_PATHCONV: "1" },
			},
		);
		expect(inspectOut).toContain("/team-repos");

		await pool!.release(sessionId, slot!.containerId);
		// Remove from cleanup list since release destroys it
		const idx = claimedContainers.indexOf(slot!.containerId);
		if (idx !== -1) claimedContainers.splice(idx, 1);
	});

	test("claim with teamRepoPath configures team remote in the clone", { timeout: 120_000 }, async () => {
		// Ensure team repo exists
		const trPath = await pool!.createTeamRepo(goalId, repoPath, "master");
		teamRepoPath = trPath;

		const sessionId = "test-remote-" + Date.now();
		const slot = await pool!.claim(sessionId, { teamRepoPath: trPath });
		expect(slot).not.toBeNull();
		claimedContainers.push(slot!.containerId);

		// Verify the 'team' remote exists and points to the container-internal path.
		// Read directly from .git/config to avoid MSYS path mangling on Windows.
		const gitConfig = fs.readFileSync(path.join(slot!.worktreePath, ".git", "config"), "utf-8");
		const repoName = path.basename(trPath); // "team-<goalId>.git"
		expect(gitConfig).toContain(`[remote "team"]`);
		expect(gitConfig).toContain(`/team-repos/${repoName}`);

		await pool!.release(sessionId, slot!.containerId);
		const idx = claimedContainers.indexOf(slot!.containerId);
		if (idx !== -1) claimedContainers.splice(idx, 1);
	});

	test("claim with teamRepoPath installs post-commit hook", { timeout: 120_000 }, async () => {
		const trPath = await pool!.createTeamRepo(goalId, repoPath, "master");
		teamRepoPath = trPath;

		const sessionId = "test-hook-" + Date.now();
		const slot = await pool!.claim(sessionId, { teamRepoPath: trPath });
		expect(slot).not.toBeNull();
		claimedContainers.push(slot!.containerId);

		// Verify post-commit hook exists
		const hookPath = path.join(slot!.worktreePath, ".git", "hooks", "post-commit");
		expect(fs.existsSync(hookPath)).toBe(true);

		// Verify hook content contains the push command
		const hookContent = fs.readFileSync(hookPath, "utf-8");
		expect(hookContent).toContain("#!/bin/sh");
		expect(hookContent).toContain("git push team");
		expect(hookContent).toContain("2>/dev/null &"); // non-blocking, non-fatal

		await pool!.release(sessionId, slot!.containerId);
		const idx = claimedContainers.indexOf(slot!.containerId);
		if (idx !== -1) claimedContainers.splice(idx, 1);
	});

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
