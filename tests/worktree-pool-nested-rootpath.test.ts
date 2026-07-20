/**
 * Regression: WorktreePool with a nested rootPath (project dir is a
 * subdirectory inside a larger git repo) must produce pool entries under
 * `<repoRoot>-wt/`, NOT under `<projectDir>-wt/`.
 *
 * Bug: the two `initWorktreePoolForProject` call sites in
 * `src/server/server.ts` (~lines 1223 and 2066) pass `project.rootPath`
 * directly as the pool's `repoPath`. When `rootPath` is a subdirectory,
 * `createWorktree(this.repoPath, …)` computes `wtRoot = <repoPath>-wt`
 * (= `<projectDir>-wt`) instead of the correct `<gitRoot>-wt`.
 *
 * This test exercises `WorktreePool` directly (no gateway, no HTTP) and
 * MUST FAIL on master to prove the bug. Once the bug is fixed by passing
 * the resolved git root to the pool, this test will pass.
 *
 * The fix is NOT applied here — the test pins the contract.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WorktreePool } from "../src/server/agent/worktree-pool.ts";

// Force `BOBBIT_TEST_NO_PUSH=1` regardless of environment so the pool's
// background freshen path never hits the network.
process.env.BOBBIT_TEST_NO_PUSH = "1";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (predicate()) return;
		await new Promise(r => setTimeout(r, 50));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

describe("WorktreePool — nested project rootPath", () => {
	let fixtureRoot: string;
	let repoRoot: string;     // <fixture>/repo  — the actual git root
	let projectDir: string;   // <repo>/x/project-root — the registered (nested) project dir
	let pool: WorktreePool | undefined;

	before(() => {
		// Use os.tmpdir() — equally valid on Windows (TEMP) and Unix (/tmp).
		fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pool-nested-"));
		repoRoot = path.join(fixtureRoot, "repo");
		fs.mkdirSync(repoRoot, { recursive: true });

		git(repoRoot, "init", "-q", "-b", "master");
		git(repoRoot, "config", "user.email", "test@bobbit.local");
		git(repoRoot, "config", "user.name", "Bobbit Test");
		git(repoRoot, "config", "commit.gpgsign", "false");

		fs.writeFileSync(path.join(repoRoot, "README.md"), "# nested-pool fixture\n");

		projectDir = path.join(repoRoot, "x", "project-root");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ name: "nested-pool", version: "0.0.0" }, null, 2) + "\n",
		);

		git(repoRoot, "add", ".");
		git(repoRoot, "commit", "-q", "-m", "init");
	});

	after(async () => {
		if (pool) {
			try { await pool.drain(); } catch { /* best-effort */ }
		}
		try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
	});

	it("places pool entries under <repoRoot>-wt/, NOT <projectDir>-wt/", async () => {
		// Mirror the buggy production call site in src/server/server.ts:
		// the pool is constructed with the NESTED project rootPath as repoPath.
		// On a fixed system, the gateway would resolve repoPath to the git root
		// before handing it to the pool — that's the contract this test pins.
		pool = new WorktreePool({ repoPath: projectDir, targetSize: 1 });
		pool.startFilling();

		// Poll until the pool has 1 ready entry.
		await waitFor(() => pool!.size >= 1, 30_000, "pool to fill 1 entry");

		// Sanity: the pool reports it's full.
		const status = pool.getStatus();
		assert.equal(status.ready, 1, `expected pool.size === 1, got ${status.ready}`);

		// Inspect the on-disk worktree directories. The bug shows up as the
		// worktree being placed under `<projectDir>-wt/` instead of `<repoRoot>-wt/`.
		const projectWtParent = projectDir + "-wt";
		const repoWtParent = repoRoot + "-wt";

		const projectWtExists = fs.existsSync(projectWtParent);
		const repoWtExists = fs.existsSync(repoWtParent);

		// Failure-message diagnostics: list what's actually on disk.
		const projectWtChildren = projectWtExists
			? fs.readdirSync(projectWtParent)
			: [];
		const repoWtChildren = repoWtExists
			? fs.readdirSync(repoWtParent)
			: [];

		const diag = [
			`project-wt parent (BUG location): ${projectWtParent}`,
			`  exists=${projectWtExists}  children=${JSON.stringify(projectWtChildren)}`,
			`repo-wt parent (CORRECT location): ${repoWtParent}`,
			`  exists=${repoWtExists}  children=${JSON.stringify(repoWtChildren)}`,
		].join("\n");

		// Primary contract: no <projectDir>-wt/ directory should EVER be created
		// for a nested-rootPath project. If it exists, the pool has placed worktrees
		// at the wrong filesystem location.
		assert.equal(
			projectWtExists,
			false,
			`worktree pool created <projectDir>-wt at ${projectWtParent} — must use <repoRoot>-wt at ${repoWtParent} instead.\n${diag}`,
		);

		// Corollary: <repoRoot>-wt/ MUST exist with at least one pool entry.
		assert.equal(
			repoWtExists,
			true,
			`expected pool worktree under <repoRoot>-wt at ${repoWtParent}, but it does not exist.\n${diag}`,
		);
		assert.ok(
			repoWtChildren.length >= 1,
			`expected at least one pool worktree under ${repoWtParent}, got ${JSON.stringify(repoWtChildren)}.\n${diag}`,
		);
	});
});

describe("WorktreePool — nested project with relative worktreeRoot", () => {
	it("uses one project-relative absolute root for reclaim and replacement fill", async () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pool-relative-root-"));
		const repo = path.join(fixture, "repo");
		const project = path.join(repo, "packages", "nested-app");
		const configuredRoot = path.join(fixture, "configured-worktrees");
		const relativeRoot = path.relative(project, configuredRoot);
		let relativePool: WorktreePool | undefined;
		try {
			fs.mkdirSync(project, { recursive: true });
			git(repo, "init", "-q", "-b", "master");
			git(repo, "config", "user.email", "test@bobbit.local");
			git(repo, "config", "user.name", "Bobbit Test");
			git(repo, "config", "commit.gpgsign", "false");
			fs.writeFileSync(path.join(project, "package.json"), "{}\n");
			git(repo, "add", ".");
			git(repo, "commit", "-q", "-m", "init");

			fs.mkdirSync(configuredRoot, { recursive: true });
			const orphanPath = path.join(configuredRoot, "pool-_pool-relative");
			git(repo, "worktree", "add", "-q", "-b", "pool/_pool-relative", orphanPath, "HEAD");

			relativePool = new WorktreePool({
				repoPath: project,
				projectRoot: project,
				worktreeRoot: relativeRoot,
				targetSize: 2,
			});
			await relativePool.initialize();
			await waitFor(() => relativePool!.size === 2, 30_000, "orphan reclaim plus replacement fill");

			const entries = relativePool.snapshotEntries().entries;
			assert.equal(entries.some(entry => entry.worktreePath === orphanPath), true, "startup should reclaim the existing relative-root entry");
			assert.equal(
				entries.every(entry => path.dirname(entry.worktreePath) === configuredRoot),
				true,
				`reclaim and fill must share ${configuredRoot}; got ${entries.map(entry => entry.worktreePath).join(", ")}`,
			);
		} finally {
			if (relativePool) {
				try { await relativePool.drain(); } catch { /* best-effort */ }
			}
			try { fs.rmSync(fixture, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});
});
