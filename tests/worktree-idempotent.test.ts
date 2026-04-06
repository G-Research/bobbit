import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// Skip npm ci / setup commands in tests
process.env.BOBBIT_SKIP_NPM_CI = "1";

import { createWorktree } from "../src/server/skills/git.js";

/** Run git in a given cwd */
async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd });
	return stdout.trim();
}

describe("createWorktree idempotency", () => {
	let bareRepo: string;
	let cloneRepo: string;
	let tmpDir: string;

	before(async () => {
		// Create an isolated temp directory
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-idem-"));

		// Create a bare repo (acts as "origin")
		bareRepo = path.join(tmpDir, "bare.git");
		fs.mkdirSync(bareRepo, { recursive: true });
		await git(["init", "--bare", bareRepo], tmpDir);

		// Clone it to get a working repo
		cloneRepo = path.join(tmpDir, "clone");
		await git(["clone", bareRepo, cloneRepo], tmpDir);

		// Make an initial commit so HEAD exists
		const testFile = path.join(cloneRepo, "README.md");
		fs.writeFileSync(testFile, "# Test\n");
		await git(["add", "."], cloneRepo);
		await git(["commit", "-m", "initial commit"], cloneRepo);
		await git(["push", "origin", "master"], cloneRepo);
	});

	after(async () => {
		// Clean up worktrees first (git requires this before removing the repo)
		try {
			await git(["worktree", "prune"], cloneRepo);
		} catch { /* ignore */ }

		// Remove temp directory
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("normal creation still works (happy path)", async () => {
		const branchName = "goal/happy-path-test";
		const result = await createWorktree(cloneRepo, branchName, { skipPush: true });

		assert.strictEqual(result.branchName, branchName);
		assert.ok(fs.existsSync(result.worktreePath), "worktree directory should exist");
		assert.ok(fs.existsSync(path.join(result.worktreePath, ".git")), ".git should exist in worktree");

		// Clean up this worktree for isolation
		await git(["worktree", "remove", "--force", result.worktreePath], cloneRepo);
		await git(["branch", "-D", branchName], cloneRepo);
	});

	it("succeeds when branch already exists but worktree dir is missing", async () => {
		const branchName = "goal/test-retry-branch-only";

		// Simulate interrupted state: branch was created but worktree wasn't
		await git(["branch", branchName], cloneRepo);

		// This currently FAILS with "fatal: a branch named '...' already exists"
		// After the fix, it should succeed
		const result = await createWorktree(cloneRepo, branchName, { skipPush: true });

		assert.strictEqual(result.branchName, branchName);
		assert.ok(fs.existsSync(result.worktreePath), "worktree directory should exist");
		assert.ok(fs.existsSync(path.join(result.worktreePath, ".git")), ".git should exist in worktree");

		// Clean up
		await git(["worktree", "remove", "--force", result.worktreePath], cloneRepo);
		await git(["branch", "-D", branchName], cloneRepo);
	});

	it("succeeds when branch and valid worktree both exist (full idempotency)", async () => {
		const branchName = "goal/test-retry-full";

		// First call — creates branch + worktree successfully
		const first = await createWorktree(cloneRepo, branchName, { skipPush: true });
		assert.ok(fs.existsSync(first.worktreePath), "first call should create worktree");

		// Second call — same branch name, worktree already exists
		// Should succeed idempotently (currently FAILS with "already exists")
		const second = await createWorktree(cloneRepo, branchName, { skipPush: true });

		assert.strictEqual(second.branchName, branchName);
		assert.strictEqual(second.worktreePath, first.worktreePath);
		assert.ok(fs.existsSync(second.worktreePath), "worktree should still exist");
		assert.ok(fs.existsSync(path.join(second.worktreePath, ".git")), ".git should exist");

		// Clean up
		await git(["worktree", "remove", "--force", first.worktreePath], cloneRepo);
		await git(["branch", "-D", branchName], cloneRepo);
	});

	it("succeeds when branch exists but worktree dir is partial (no .git)", async () => {
		const branchName = "goal/test-retry-partial";

		// Simulate interrupted state: branch created, directory exists but no .git
		await git(["branch", branchName], cloneRepo);
		const wtRoot = path.resolve(cloneRepo, "..", `${path.basename(cloneRepo)}-wt`);
		const safeName = branchName.replace(/\//g, "-");
		const worktreePath = path.join(wtRoot, safeName);
		fs.mkdirSync(worktreePath, { recursive: true });

		// Verify the partial state: dir exists but no .git
		assert.ok(fs.existsSync(worktreePath), "partial dir should exist");
		assert.ok(!fs.existsSync(path.join(worktreePath, ".git")), ".git should NOT exist yet");

		// This currently FAILS with "already exists"
		// After the fix, it should succeed
		const result = await createWorktree(cloneRepo, branchName, { skipPush: true });

		assert.strictEqual(result.branchName, branchName);
		assert.ok(fs.existsSync(result.worktreePath), "worktree directory should exist");
		assert.ok(fs.existsSync(path.join(result.worktreePath, ".git")), ".git should exist in worktree");

		// Clean up
		await git(["worktree", "remove", "--force", result.worktreePath], cloneRepo);
		await git(["branch", "-D", branchName], cloneRepo);
	});
});
