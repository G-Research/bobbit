/**
 * Unit tests for WorktreePool — Phase 3 claim sequence.
 *
 * Real git is required; uses a freshly-init'd repo in a temp directory.
 * Tests focus on:
 *   - happy-path claim renames branch + moves directory
 *   - degraded fallback when `git worktree move` fails (we simulate by
 *     creating a directory at the destination so move refuses)
 *   - BOBBIT_TEST_NO_PUSH=1 skips push (asserted indirectly by ensuring
 *     no remote is configured and claim still succeeds)
 *   - claimUnnamed returns the entry as-is and keeps the pool branch
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WorktreePool, isPoolBranch } from "../src/server/agent/worktree-pool.ts";
import type { Component } from "../src/server/agent/project-config-store.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFile = promisify(execFileCb);

async function makeRepo(): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pool-test-"));
	const repo = path.join(dir, "repo");
	fs.mkdirSync(repo, { recursive: true });
	await execFile("git", ["init", "--initial-branch=master"], { cwd: repo });
	await execFile("git", ["config", "user.email", "test@test"], { cwd: repo });
	await execFile("git", ["config", "user.name", "Test"], { cwd: repo });
	await execFile("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repo });
	return repo;
}

async function rmRepo(repoPath: string) {
	const root = path.dirname(repoPath);
	try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

describe("WorktreePool — Phase 3 claim sequence", () => {
	const originalNoPush = process.env.BOBBIT_TEST_NO_PUSH;
	const originalSkipNpm = process.env.BOBBIT_SKIP_NPM_CI;

	before(() => {
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		process.env.BOBBIT_SKIP_NPM_CI = "1";
	});
	after(() => {
		if (originalNoPush === undefined) delete process.env.BOBBIT_TEST_NO_PUSH;
		else process.env.BOBBIT_TEST_NO_PUSH = originalNoPush;
		if (originalSkipNpm === undefined) delete process.env.BOBBIT_SKIP_NPM_CI;
		else process.env.BOBBIT_SKIP_NPM_CI = originalSkipNpm;
	});

	it("isPoolBranch matches new and legacy prefixes", () => {
		assert.equal(isPoolBranch("pool/_pool-abcd1234"), true);
		assert.equal(isPoolBranch("session/_pool-abcd1234"), true);
		assert.equal(isPoolBranch("session/foo-bar"), false);
		assert.equal(isPoolBranch("master"), false);
	});

	it("happy path: claim renames branch and moves directory", async () => {
		const repo = await makeRepo();
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 1 });
			pool.startFilling();
			// Wait for fill — simple poll loop.
			for (let i = 0; i < 50 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1, "pool should have one entry after fill");

			const claim = await pool.claim("session/test-12345678");
			assert.ok(claim, "claim should succeed");
			assert.equal(claim!.branchName, "session/test-12345678");
			assert.equal(claim!.degraded, false);

			// Verify the branch was renamed (no `pool/_pool-*` branch left).
			const { stdout: branchList } = await execFile("git", ["branch", "--list"], { cwd: repo });
			assert.ok(branchList.includes("session/test-12345678"), "target branch should exist");
			assert.ok(!branchList.includes("pool/_pool-"), "pool branch should be gone");

			// Verify the directory was moved (path basename is the flattened slug).
			assert.equal(path.basename(claim!.worktreePath), "session-test-12345678");
			assert.ok(fs.existsSync(claim!.worktreePath), "new worktree dir should exist");
		} finally {
			await rmRepo(repo);
		}
	});

	it("degraded fallback: branch renamed even when move target exists", async () => {
		const repo = await makeRepo();
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 1 });
			pool.startFilling();
			for (let i = 0; i < 50 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1);

			// Pre-create a *file* at the destination path — `git worktree move`
			// refuses with "target already exists" rather than touching it.
			const wtRoot = path.resolve(repo, "..", `${path.basename(repo)}-wt`);
			const blocker = path.join(wtRoot, "session-blocked-deadbeef");
			fs.writeFileSync(blocker, "in the way");

			const claim = await pool.claim("session/blocked-deadbeef");
			assert.ok(claim, "claim should still succeed in degraded mode");
			assert.equal(claim!.branchName, "session/blocked-deadbeef");
			assert.equal(claim!.degraded, true, "degraded flag must be true on move failure");
			// Worktree path stays at the original pool location (basename starts with pool-_pool-).
			assert.ok(
				path.basename(claim!.worktreePath).startsWith("pool-_pool-"),
				`expected pool-_pool- prefix, got ${claim!.worktreePath}`,
			);
		} finally {
			await rmRepo(repo);
		}
	});

	it("claimUnnamed returns entry without renaming and yields a poolId", async () => {
		const repo = await makeRepo();
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 1 });
			pool.startFilling();
			for (let i = 0; i < 50 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1);

			const u = pool.claimUnnamed();
			assert.ok(u, "claimUnnamed should succeed when pool is warm");
			assert.ok(u!.branchName.startsWith("pool/_pool-"), `branch should retain pool prefix, got ${u!.branchName}`);
			assert.ok(u!.poolId.startsWith("_pool-"), `poolId should be _pool-<hex>, got ${u!.poolId}`);
			assert.ok(fs.existsSync(u!.worktreePath));
		} finally {
			await rmRepo(repo);
		}
	});

	it("claim returns null when pool is empty and never throws on push (BOBBIT_TEST_NO_PUSH=1)", async () => {
		const repo = await makeRepo();
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 0 });
			// targetSize 0 → fill loop exits immediately
			pool.startFilling();
			await new Promise(r => setTimeout(r, 100));
			const claim = await pool.claim("session/foo-deadbeef");
			assert.equal(claim, null, "empty pool should return null");
		} finally {
			await rmRepo(repo);
		}
	});
});

describe("WorktreePool — components[*].worktreeSetupCommand is the source of truth", () => {
	// These tests must NOT set BOBBIT_SKIP_NPM_CI — we're asserting the setup
	// hook actually fires. Keep BOBBIT_TEST_NO_PUSH so we don't touch any remote.
	const originalNoPush = process.env.BOBBIT_TEST_NO_PUSH;
	const originalSkipNpm = process.env.BOBBIT_SKIP_NPM_CI;
	before(() => {
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		delete process.env.BOBBIT_SKIP_NPM_CI;
	});
	after(() => {
		if (originalNoPush === undefined) delete process.env.BOBBIT_TEST_NO_PUSH;
		else process.env.BOBBIT_TEST_NO_PUSH = originalNoPush;
		if (originalSkipNpm === undefined) delete process.env.BOBBIT_SKIP_NPM_CI;
		else process.env.BOBBIT_SKIP_NPM_CI = originalSkipNpm;
	});

	it("single-repo pool fill runs the default component's worktreeSetupCommand", async () => {
		const repo = await makeRepo();
		try {
			const components: Component[] = [
				{ name: "app", repo: ".", worktreeSetupCommand: "touch SETUP_RAN" },
			];
			const pool = new WorktreePool({
				repoPath: repo,
				targetSize: 1,
				componentsResolver: () => components,
			});
			pool.startFilling();
			for (let i = 0; i < 100 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1, "pool should have one entry");

			// Peek without claiming — use claimUnnamed which preserves the entry path.
			const u = pool.claimUnnamed();
			assert.ok(u, "claimUnnamed should succeed");
			const marker = path.join(u!.worktreePath, "SETUP_RAN");
			assert.ok(
				fs.existsSync(marker),
				`SETUP_RAN marker missing from pool worktree at ${marker} — setup hook did not run`,
			);
		} finally {
			await rmRepo(repo);
		}
	});

	it("single-repo pool fill is a no-op when no component declares worktreeSetupCommand", async () => {
		const repo = await makeRepo();
		try {
			const components: Component[] = [{ name: "app", repo: "." }];
			const pool = new WorktreePool({
				repoPath: repo,
				targetSize: 1,
				componentsResolver: () => components,
			});
			pool.startFilling();
			for (let i = 0; i < 100 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1);
			const u = pool.claimUnnamed();
			assert.ok(u);
			// Worktree is fully usable; just no SETUP_RAN file.
			assert.ok(fs.existsSync(path.join(u!.worktreePath, ".git")));
		} finally {
			await rmRepo(repo);
		}
	});

	it("BOBBIT_SKIP_NPM_CI=1 bypasses runComponentSetups", async () => {
		const repo = await makeRepo();
		process.env.BOBBIT_SKIP_NPM_CI = "1";
		try {
			const components: Component[] = [
				{ name: "app", repo: ".", worktreeSetupCommand: "touch SETUP_RAN" },
			];
			const pool = new WorktreePool({
				repoPath: repo,
				targetSize: 1,
				componentsResolver: () => components,
			});
			pool.startFilling();
			for (let i = 0; i < 100 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1);
			const u = pool.claimUnnamed();
			assert.ok(u);
			assert.equal(
				fs.existsSync(path.join(u!.worktreePath, "SETUP_RAN")),
				false,
				"SETUP_RAN should NOT exist when BOBBIT_SKIP_NPM_CI=1",
			);
		} finally {
			delete process.env.BOBBIT_SKIP_NPM_CI;
			await rmRepo(repo);
		}
	});
});

describe("Regression: legacy top-level worktree_setup_command must not be read", () => {
	it("no source file under src/ reads `worktree_setup_command` via projectConfigStore.get()", () => {
		// The migration in state-migration/migrate-project-yaml.ts is the only
		// allowed reader of the legacy top-level key. Every other reader is a
		// regression of the components[*].worktreeSetupCommand source-of-truth.
		const srcRoot = path.resolve(__dirname, "..", "src");
		const hits: string[] = [];
		function scan(dir: string) {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, entry.name);
				if (entry.isDirectory()) { scan(p); continue; }
				if (!entry.name.endsWith(".ts")) continue;
				// migrate-project-yaml.ts is the one allowed reader.
				if (p.endsWith(path.join("state-migration", "migrate-project-yaml.ts"))) continue;
				const body = fs.readFileSync(p, "utf-8");
				// Match the exact bug we just fixed: a `.get("worktree_setup_command")`
				// or `.get('worktree_setup_command')` call. Allows the string to appear
				// in comments / migration-specific helpers / settings UI labels.
				if (/\.get\(\s*[\"']worktree_setup_command[\"']\s*\)/.test(body)) {
					hits.push(path.relative(srcRoot, p));
				}
			}
		}
		scan(srcRoot);
		assert.deepEqual(
			hits,
			[],
			`Files reading legacy top-level worktree_setup_command via .get(): ${hits.join(", ")}`,
		);
	});
});
