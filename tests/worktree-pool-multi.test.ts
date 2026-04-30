/**
 * WorktreePool — multi-repo prebuild + claim (Phase 4a).
 *
 * Asserts:
 *   - When components specify multiple repos, `_fill()` builds multi-repo
 *     pool entries via `createWorktreeSet`. Each entry pre-creates one
 *     worktree per repo (incl. data-only) under the same `pool/_pool-<id>`
 *     branch.
 *   - `claim()` returns the full set with the new branch + container path.
 *   - Pool replenishes after a claim.
 *
 * Real git is required; uses freshly init'd sibling repos in a temp
 * container directory mirroring multi-repo project layout.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { WorktreePool } from "../src/server/agent/worktree-pool.ts";
import type { Component } from "../src/server/agent/project-config-store.ts";

const execFile = promisify(execFileCb);

async function makeMultiRepoRoot(repos: string[]): Promise<string> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pool-multi-"));
	for (const repo of repos) {
		const dir = path.join(root, repo);
		fs.mkdirSync(dir, { recursive: true });
		await execFile("git", ["init", "--initial-branch=master"], { cwd: dir });
		await execFile("git", ["config", "user.email", "test@test"], { cwd: dir });
		await execFile("git", ["config", "user.name", "Test"], { cwd: dir });
		await execFile("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
	}
	return root;
}

async function rmRoot(root: string): Promise<void> {
	try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

describe("WorktreePool — multi-repo prebuild + claim", () => {
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

	it("fills multi-repo pool sets and claim returns the full set", async () => {
		const root = await makeMultiRepoRoot(["api", "web", "shared"]);
		try {
			const components: Component[] = [
				{ name: "api", repo: "api", commands: { build: "echo ok" } },
				{ name: "web", repo: "web", commands: { build: "echo ok" } },
				{ name: "shared", repo: "shared" }, // data-only — must be in the set
			];
			const pool = new WorktreePool({ repoPath: root, targetSize: 1, componentsResolver: () => components });
			pool.startFilling();

			for (let i = 0; i < 100 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1, "pool should have one multi-repo entry after fill");

			const claim = await pool.claim("session/multi-test-12345678");
			assert.ok(claim, "claim should succeed");
			assert.equal(claim!.branchName, "session/multi-test-12345678");
			assert.ok(claim!.worktrees, "multi-repo claim should expose per-repo worktrees");
			assert.equal(claim!.worktrees!.length, 3, "all three repos (incl. data-only) should be in the set");

			const repoNames = claim!.worktrees!.map(w => w.repo).sort();
			assert.deepEqual(repoNames, ["api", "shared", "web"]);

			// Per-repo worktree paths must exist on disk.
			for (const w of claim!.worktrees!) {
				assert.ok(fs.existsSync(w.worktreePath), `worktree should exist on disk: ${w.worktreePath}`);
				const { stdout } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: w.worktreePath });
				assert.equal(stdout.trim(), "session/multi-test-12345678", `repo ${w.repo} should be on the renamed branch`);
			}

			assert.ok(claim!.container, "container path should be set on multi-repo claim");
			assert.equal(path.basename(claim!.container!), "session-multi-test-12345678");

			// Replenishment: pool should fill again after claim.
			for (let i = 0; i < 100 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1, "pool should replenish after claim");
		} finally {
			await rmRoot(root);
		}
	});

	it("claimUnnamed returns multi-repo entry as-is with worktrees array", async () => {
		const root = await makeMultiRepoRoot(["api", "web"]);
		try {
			const components: Component[] = [
				{ name: "api", repo: "api" },
				{ name: "web", repo: "web" },
			];
			const pool = new WorktreePool({ repoPath: root, targetSize: 1, componentsResolver: () => components });
			pool.startFilling();
			for (let i = 0; i < 100 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1);

			const u = pool.claimUnnamed();
			assert.ok(u);
			assert.ok(u!.branchName.startsWith("pool/_pool-"));
			assert.ok(u!.worktrees, "claimUnnamed should expose multi-repo worktrees");
			assert.equal(u!.worktrees!.length, 2);
			for (const w of u!.worktrees!) {
				assert.ok(fs.existsSync(w.worktreePath));
			}
		} finally {
			await rmRoot(root);
		}
	});
});
