/**
 * Unit tests for WorktreePool — `base_ref` plumbing (§7 of `docs/design/base-ref.md`).
 *
 * Verifies that:
 *   1. `_fill()` uses the live `baseRefResolver()` value for the start-point
 *      of new pool entries (no recorded base, no restart).
 *   2. `freshenInBackground()` re-resolves the base on every call so a
 *      claimed entry adopts the *currently-configured* base, not whatever
 *      was in effect at fill time.
 *   3. An empty/undefined resolver preserves today's `resolveRemotePrimary`
 *      fallback — backward-compat with projects that haven't configured
 *      `base_ref`.
 *
 * Pattern mirrors `tests/worktree-pool.test.ts` — local-only repo, no
 * remote, BOBBIT_TEST_NO_PUSH=1 to keep the test offline.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { WorktreePool } from "../src/server/agent/worktree-pool.ts";

const execFile = promisify(execFileCb);

/**
 * Create a repo with two divergent branches (`master` and `develop`), each
 * with a single distinct commit on top of an empty root, plus a bare `origin`
 * clone that has both branches pushed. The bare clone is necessary so the
 * pool's `git fetch origin` succeeds in `freshen()` — otherwise fetch fails
 * and the reset never runs (today's pre-existing behaviour).
 *
 * Returns the working repo path and the SHAs of both branches.
 */
async function makeRepoWithTwoBranches(): Promise<{ repo: string; masterSha: string; developSha: string }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pool-base-ref-"));
	const repo = path.join(dir, "repo");
	const bare = path.join(dir, "origin.git");
	fs.mkdirSync(repo, { recursive: true });
	await execFile("git", ["init", "--initial-branch=master"], { cwd: repo });
	await execFile("git", ["config", "user.email", "test@test"], { cwd: repo });
	await execFile("git", ["config", "user.name", "Test"], { cwd: repo });
	// Initial commit on master so the branch ref exists.
	await execFile("git", ["commit", "--allow-empty", "-m", "init master"], { cwd: repo });
	const { stdout: masterShaOut } = await execFile("git", ["rev-parse", "HEAD"], { cwd: repo });
	const masterSha = masterShaOut.trim();

	// Diverge: create `develop` from master with one extra commit.
	await execFile("git", ["checkout", "-b", "develop"], { cwd: repo });
	await execFile("git", ["commit", "--allow-empty", "-m", "develop commit"], { cwd: repo });
	const { stdout: developShaOut } = await execFile("git", ["rev-parse", "HEAD"], { cwd: repo });
	const developSha = developShaOut.trim();

	// Park HEAD back on master so the repo's "current" branch is stable; new
	// worktrees pick their start-point from the resolved ref, not HEAD.
	await execFile("git", ["checkout", "master"], { cwd: repo });

	// Create a bare origin and push both branches so `git fetch origin`
	// succeeds in the pool's background freshen. Without this the fetch fails
	// (no remote) and the entire try block bails before reset — hiding the
	// base-ref behaviour we want to assert. Using a local bare repo keeps the
	// test offline (no BOBBIT_TEST_NO_PUSH dependency for fetch).
	await execFile("git", ["init", "--bare", "--initial-branch=master", bare]);
	await execFile("git", ["remote", "add", "origin", bare], { cwd: repo });
	await execFile("git", ["push", "origin", "master", "develop"], { cwd: repo });
	// Set origin/HEAD so `resolveRemotePrimary` (the empty-resolver fallback)
	// has a real value to return rather than the "HEAD" sentinel.
	await execFile("git", ["remote", "set-head", "origin", "master"], { cwd: repo });

	return { repo, masterSha, developSha };
}

async function rmRepo(repoPath: string) {
	const root = path.dirname(repoPath);
	try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

describe("WorktreePool — base_ref plumbing", () => {
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

	it("initial fill uses the current baseRefResolver() value as the start-point", async () => {
		const { repo, developSha } = await makeRepoWithTwoBranches();
		try {
			const pool = new WorktreePool({
				repoPath: repo,
				targetSize: 1,
				baseRefResolver: () => "develop",
			});
			pool.startFilling();
			for (let i = 0; i < 50 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1, "pool should have one entry after fill");

			const claim = await pool.claim("session/abcd1234");
			assert.ok(claim, "claim should succeed");
			// Background freshen runs after claim — we're asserting the
			// post-fill HEAD here. Read HEAD immediately after rename; if a
			// future change makes freshen reset HEAD synchronously this still
			// asserts the right invariant.
			const { stdout: headOut } = await execFile("git", ["rev-parse", "HEAD"], { cwd: claim!.worktreePath });
			assert.equal(
				headOut.trim(),
				developSha,
				`pool entry should have been branched from develop (${developSha}), got ${headOut.trim()}`,
			);
		} finally {
			await rmRepo(repo);
		}
	});

	it("freshen re-resolves baseRefResolver() on every call — claimed entries adopt the current base", async () => {
		const { repo, masterSha, developSha } = await makeRepoWithTwoBranches();
		try {
			// Start with develop as the base, fill, then flip to master and
			// freshen — the entry's HEAD must follow.
			let configured: string = "develop";
			const pool = new WorktreePool({
				repoPath: repo,
				targetSize: 1,
				baseRefResolver: () => configured,
			});
			pool.startFilling();
			for (let i = 0; i < 50 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1);

			const claim = await pool.claim("session/cafebabe");
			assert.ok(claim);

			// Sanity: post-fill HEAD is develop.
			let headOut = (await execFile("git", ["rev-parse", "HEAD"], { cwd: claim!.worktreePath })).stdout.trim();
			assert.equal(headOut, developSha, "initial pool entry should be at develop");

			// Flip the resolver and trigger an awaitable freshen. Accessing the
			// private helper via `as any` is intentional — the public surface
			// is fire-and-forget; the inner async block is factored out so the
			// test can await completion without a flaky poll loop.
			configured = "master";
			await (pool as any).freshen(claim!.worktreePath, claim!.branchName);

			headOut = (await execFile("git", ["rev-parse", "HEAD"], { cwd: claim!.worktreePath })).stdout.trim();
			assert.equal(
				headOut,
				masterSha,
				`after flipping baseRefResolver to "master", freshen should reset HEAD to ${masterSha}, got ${headOut}`,
			);
		} finally {
			await rmRepo(repo);
		}
	});

	it("empty/undefined resolver preserves today's resolveRemotePrimary fallback (back-compat)", async () => {
		const { repo } = await makeRepoWithTwoBranches();
		try {
			// No baseRefResolver at all — must behave exactly like a project
			// that hasn't configured base_ref (today's behaviour: pool builds
			// from resolveRemotePrimary, which for a no-remote local-only repo
			// falls back to "HEAD" and the worktree is still created).
			const pool = new WorktreePool({
				repoPath: repo,
				targetSize: 1,
			});
			pool.startFilling();
			for (let i = 0; i < 50 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1, "pool should fill even without a baseRefResolver");

			// Same when resolver returns an empty string — must also collapse
			// to the fallback rather than treating "" as a literal ref.
			const pool2 = new WorktreePool({
				repoPath: repo,
				targetSize: 1,
				baseRefResolver: () => "",
			});
			pool2.startFilling();
			for (let i = 0; i < 50 && pool2.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool2.size, 1, "empty-string resolver must fall back to today's behaviour");
		} finally {
			await rmRepo(repo);
		}
	});
});
