/**
 * Tests for SandboxPool team repo operations and buildDockerRunArgs.
 * These are pure git/filesystem operations — no Docker needed.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

// Create a temp git repo to use as source
let tmpRepo: string;
let pool: InstanceType<typeof import("../dist/server/agent/sandbox-pool.js").SandboxPool>;

before(async () => {
	tmpRepo = path.join(os.tmpdir(), `sandbox-repo-test-${Date.now()}`);
	fs.mkdirSync(tmpRepo, { recursive: true });
	fs.writeFileSync(path.join(tmpRepo, "README.md"), "# test\n");
	execFileSync("git", ["init"], { cwd: tmpRepo, stdio: "pipe" });
	execFileSync("git", ["add", "."], { cwd: tmpRepo, stdio: "pipe" });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@t.com", "commit", "-m", "init"], { cwd: tmpRepo, stdio: "pipe" });

	const { SandboxPool } = await import("../dist/server/agent/sandbox-pool.js");
	pool = new SandboxPool({
		poolSize: 0,
		maxIdleSeconds: 300,
		image: "node:20-slim",
		projectDir: tmpRepo,
		repoPath: tmpRepo,
		healthCheckIntervalMs: 30_000,
	});
	// NOTE: we intentionally skip pool.init() — it needs Docker.
	// createTeamRepo/destroyTeamRepo only need _poolDir which is set in the constructor.
	// Ensure the pool directory exists (init() normally does this).
	const poolDir = (pool as any)._poolDir;
	fs.mkdirSync(poolDir, { recursive: true });
});

after(async () => {
	if (pool) await pool.destroyTeamRepo("test-create").catch(() => {});
	if (pool) await pool.destroyTeamRepo("test-idempotent").catch(() => {});
	fs.rmSync(tmpRepo, { recursive: true, force: true });
	const poolDir = (pool as any)?._poolDir;
	if (poolDir) fs.rmSync(poolDir, { recursive: true, force: true });
});

describe("SandboxPool team repo (no Docker)", () => {
	it("createTeamRepo creates a valid bare git repo on disk", async () => {
		const result = await pool.createTeamRepo("test-create", tmpRepo, "master");

		assert.ok(result.includes("team-test-create.git"));
		assert.ok(fs.existsSync(result));
		assert.ok(fs.existsSync(path.join(result, "HEAD")));
		assert.ok(fs.existsSync(path.join(result, "refs")));
	});

	it("createTeamRepo is idempotent — same path on second call", async () => {
		const goalId = "test-idempotent";
		const first = await pool.createTeamRepo(goalId, tmpRepo, "master");
		const second = await pool.createTeamRepo(goalId, tmpRepo, "master");

		assert.strictEqual(first, second);
		assert.ok(fs.existsSync(path.join(first, "HEAD")));
	});

	it("destroyTeamRepo removes the bare repo directory", async () => {
		const goalId = `test-destroy-${Date.now()}`;
		const created = await pool.createTeamRepo(goalId, tmpRepo, "master");
		assert.ok(fs.existsSync(created));

		await pool.destroyTeamRepo(goalId);
		assert.ok(!fs.existsSync(created));
	});
});

describe("buildDockerRunArgs (no Docker)", () => {
	it("output has no token env vars", async () => {
		const { buildDockerRunArgs } = await import("../dist/server/agent/docker-args.js");

		const args = buildDockerRunArgs({
			image: "node:20-slim",
			workspaceDir: os.tmpdir(),
		});

		const joined = args.join(" ");
		assert.ok(!joined.includes("BOBBIT_TOKEN"));
		assert.ok(!joined.includes("BOBBIT_GATEWAY_URL"));
		assert.ok(joined.includes("NODE_TLS_REJECT_UNAUTHORIZED=0"));
	});
});
