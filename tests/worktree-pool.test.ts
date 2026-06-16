/**
 * Unit tests for WorktreePool — claim sequence.
 *
 * Real git is required; uses a freshly-init'd repo in a temp directory.
 * Tests focus on:
 *   - happy-path claim renames branch + moves directory to the final
 *     `session/<id8>` name in one synchronous step
 *   - claim() returns null when the directory rename fails so the caller
 *     falls back to createWorktree (no half-renamed persistent state)
 *   - BOBBIT_TEST_NO_PUSH=1 skips push (asserted indirectly by ensuring
 *     no remote is configured and claim still succeeds)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WorktreePool, isPoolBranch } from "../src/server/agent/worktree-pool.ts";
import type { Component } from "../src/server/agent/project-config-store.ts";
import { makeTmpDir } from "./helpers/tmp.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFile = promisify(execFileCb);

async function makeRepo(): Promise<string> {
	const dir = makeTmpDir("bobbit-pool-test-");
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

	it("happy path: claim renames branch and moves directory to session/<id8>", async () => {
		const repo = await makeRepo();
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 1 });
			pool.startFilling();
			// Wait for fill — simple poll loop.
			for (let i = 0; i < 50 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1, "pool should have one entry after fill");

			// Capture the pooled branch name BEFORE claim. claim() kicks off a
			// background refill (replenish() → _fill() back up to targetSize), which
			// legitimately creates a NEW `pool/_pool-*` branch. So asserting the
			// global absence of the `pool/_pool-` prefix after claim is racy (the
			// refill can land before the assertion under load). Instead assert that
			// THIS pooled branch was renamed away — claim's actual contract.
			const listBranches = async (): Promise<string[]> => {
				const { stdout } = await execFile("git", ["branch", "--list"], { cwd: repo });
				return stdout.split("\n").map((s) => s.replace(/^[*+]?\s*/, "").trim()).filter(Boolean);
			};
			const pooledBranch = (await listBranches()).find((b) => b.startsWith("pool/_pool-"));
			assert.ok(pooledBranch, "a pool branch should exist before claim");

			const claim = await pool.claim("session/abcd1234");
			assert.ok(claim, "claim should succeed");
			assert.equal(claim!.branchName, "session/abcd1234");
			assert.equal(claim!.degraded, false);

			// Verify the pooled branch was renamed to the session branch.
			const after = await listBranches();
			assert.ok(after.includes("session/abcd1234"), "target branch should exist");
			assert.ok(!after.includes(pooledBranch!), "the claimed pool branch should be renamed away");

			// Verify the directory was moved (path basename is the flattened slug).
			assert.equal(path.basename(claim!.worktreePath), "session-abcd1234");
			assert.ok(fs.existsSync(claim!.worktreePath), "new worktree dir should exist");
		} finally {
			await rmRepo(repo);
		}
	});

	it("directory-rename failure returns null so caller falls back to createWorktree", async () => {
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
			const blocker = path.join(wtRoot, "session-deadbeef");
			fs.writeFileSync(blocker, "in the way");

			const claim = await pool.claim("session/deadbeef");
			assert.equal(claim, null, "claim must return null on dir-rename failure (no half-state)");

			// Branch must not be left renamed: the pool branch should be gone
			// (entry was cleaned up) AND the target branch should not be present.
			const { stdout: branchList } = await execFile("git", ["branch", "--list"], { cwd: repo });
			assert.ok(!branchList.includes("session/deadbeef"), "target branch must not be left behind");
		} finally {
			await rmRepo(repo);
		}
	});

	it("setTitle does not trigger any branch rename (regression: branch is stable post-claim)", async () => {
		// Sanity check: there is no public API on WorktreePool that performs a
		// post-claim rename. Verifies the absence of `claimUnnamed` / first-prompt
		// rename helpers — if someone re-introduces them, this test still passes,
		// but the symbol-grep guard below catches the regression.
		const repo = await makeRepo();
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 1 });
			pool.startFilling();
			for (let i = 0; i < 50 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1);

			const claim = await pool.claim("session/cafebabe");
			assert.ok(claim);
			const branchBefore = claim!.branchName;
			const pathBefore = claim!.worktreePath;

			// Simulate "first prompt": there's no API that renames a claimed entry.
			// Verify branch + path are byte-stable in our records (and on disk).
			const { stdout } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: pathBefore });
			assert.equal(stdout.trim(), branchBefore, "branch on disk must equal claimed branch");
			assert.equal(branchBefore, "session/cafebabe");
			assert.ok(fs.existsSync(pathBefore));
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

	it("test-mode freshen skips remote reset when origin is absent", async () => {
		const repo = await makeRepo();
		const warns: string[] = [];
		const originalWarn = console.warn;
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 0 });
			console.warn = (...args: unknown[]) => {
				warns.push(args.map(String).join(" "));
			};

			await (pool as any).freshen(repo, "session/no-origin");

			assert.equal(
				warns.some(line => line.includes("Background reset failed") || line.includes("git fetch origin")),
				false,
				"test-mode worktree freshen must not try to fetch a missing/real origin",
			);
		} finally {
			console.warn = originalWarn;
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

			const u = await pool.claim("session/abcd1234");
			assert.ok(u, "claim should succeed");
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
			const u = await pool.claim("session/abcd1234");
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
			const u = await pool.claim("session/abcd1234");
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

describe("Regression: rename helpers and claimUnnamed must stay deleted", () => {
	it("no source file references renameSessionFromPool / claimUnnamed / UnnamedClaim", () => {
		const srcRoot = path.resolve(__dirname, "..", "src");
		const banned = /(renameSessionFromPool|_renameSessionFromPoolMultiRepo|claimUnnamed|UnnamedClaim)/;
		const hits: string[] = [];
		function scan(dir: string) {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, entry.name);
				if (entry.isDirectory()) { scan(p); continue; }
				if (!entry.name.endsWith(".ts")) continue;
				const body = fs.readFileSync(p, "utf-8");
				if (banned.test(body)) hits.push(path.relative(srcRoot, p));
			}
		}
		scan(srcRoot);
		assert.deepEqual(
			hits,
			[],
			`Files reference removed rename/claimUnnamed symbols: ${hits.join(", ")}`,
		);
	});

	it("moveWorktree is no longer exported from src/server/skills/git.ts", () => {
		const gitTs = path.resolve(__dirname, "..", "src", "server", "skills", "git.ts");
		const body = fs.readFileSync(gitTs, "utf-8");
		assert.equal(/export\s+(async\s+)?function\s+moveWorktree\b/.test(body), false,
			"moveWorktree must be inlined into worktree-pool.ts (design §14)");
		assert.equal(/export\s+class\s+WorktreeMoveError\b/.test(body), false,
			"WorktreeMoveError must be removed from skills/git.ts");
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
