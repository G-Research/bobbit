/**
 * Phase 2 — `mergeChildBranchLocal` against a real temp git repo.
 *
 * Covered cases:
 *   1. Clean merge: a child branch with one fresh commit merges via --no-ff
 *      and produces a merge commit on the parent.
 *   2. Already-merged: re-running the same merge a second time returns
 *      `alreadyMerged: true` and does not produce a second commit.
 *   3. Conflict: parent and child both modify the same line — merge fails
 *      with `conflict: true` AND the parent worktree is left clean (no
 *      unmerged paths in `git status --porcelain`).
 *   4. Wrong branch: the parent worktree is on the wrong branch — throws
 *      with a structured message identifying the mismatch.
 *
 * The repo is a "primary" git directory plus two `git worktree add` worktrees
 * (one for "parent goal", one for "child goal"). This mirrors how the
 * production code calls mergeChildBranchLocal — from inside the parent's
 * worktree, with the child checked out as a sibling worktree.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { mergeChildBranchLocal } from "../src/server/skills/git.ts";

const execFile = promisify(execFileCb);

let tmpRoot: string;
let primary: string;
let parentWt: string;
let childWt: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd, timeout: 30_000 });
	return stdout.toString();
}

async function commitFile(cwd: string, file: string, contents: string, msg: string): Promise<string> {
	fs.writeFileSync(path.join(cwd, file), contents);
	await git(cwd, "add", file);
	await git(cwd, "commit", "-m", msg);
	return (await git(cwd, "rev-parse", "HEAD")).trim();
}

beforeEach(async () => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "merge-child-test-"));
	primary = path.join(tmpRoot, "primary");
	fs.mkdirSync(primary);

	// Initialise the primary repo with one commit on `master` (the convention
	// used everywhere else in the codebase — never `main`).
	await git(primary, "init", "--initial-branch=master");
	await git(primary, "config", "user.email", "test@example.com");
	await git(primary, "config", "user.name", "Test");
	// commit.gpgsign=false so a developer's global ~/.gitconfig with a
	// keyring lookup doesn't break the test in CI.
	await git(primary, "config", "commit.gpgsign", "false");
	await commitFile(primary, "seed.txt", "seed\n", "seed");

	// Create parent and child worktrees off master.
	parentWt = path.join(tmpRoot, "parent-wt");
	childWt = path.join(tmpRoot, "child-wt");
	await git(primary, "worktree", "add", "-b", "goal/parent", parentWt, "master");
	await git(primary, "worktree", "add", "-b", "goal/child", childWt, "goal/parent");
	// Worktrees inherit user config from the primary; ensure commit.gpgsign
	// is sticky here too.
	await git(parentWt, "config", "commit.gpgsign", "false");
	await git(childWt, "config", "commit.gpgsign", "false");
});

afterEach(() => {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("mergeChildBranchLocal", () => {
	it("clean merge: produces a --no-ff merge commit and returns merged=true", async () => {
		// Add one commit on the child branch.
		await commitFile(childWt, "feature.txt", "child work\n", "feat: child work");

		const parentTipBefore = (await git(parentWt, "rev-parse", "HEAD")).trim();
		const result = await mergeChildBranchLocal("goal/parent", "goal/child", parentWt);
		assert.equal(result.merged, true);
		assert.equal(result.alreadyMerged, false);
		assert.equal(result.conflict, false);
		assert.match(result.output, /Merge|merge/);

		// A merge commit (parent has 2 parents) should now sit on top of
		// goal/parent. --no-ff guarantees a true merge commit even on a
		// fast-forwardable history.
		const parentTipAfter = (await git(parentWt, "rev-parse", "HEAD")).trim();
		assert.notEqual(parentTipBefore, parentTipAfter, "parent tip must advance");
		const log = await git(parentWt, "log", "--pretty=%P", "-1");
		const parents = log.trim().split(/\s+/);
		assert.equal(parents.length, 2, `--no-ff merge commit must have 2 parents (got ${parents.length}: ${log.trim()})`);
	});

	it("already merged: returns alreadyMerged=true on a no-op merge", async () => {
		// First merge — produces a merge commit.
		await commitFile(childWt, "feature.txt", "child work\n", "feat: child work");
		const first = await mergeChildBranchLocal("goal/parent", "goal/child", parentWt);
		assert.equal(first.merged, true);
		const tipAfterFirst = (await git(parentWt, "rev-parse", "HEAD")).trim();

		// Second merge — should be a no-op.
		const second = await mergeChildBranchLocal("goal/parent", "goal/child", parentWt);
		assert.equal(second.alreadyMerged, true);
		assert.equal(second.merged, false);
		assert.equal(second.conflict, false);

		const tipAfterSecond = (await git(parentWt, "rev-parse", "HEAD")).trim();
		assert.equal(tipAfterFirst, tipAfterSecond, "second merge must not advance the tip");
	});

	it("conflict: returns conflict=true and leaves parent worktree clean (merge --abort fired)", async () => {
		// Both branches modify shared.txt in incompatible ways.
		await commitFile(parentWt, "shared.txt", "parent line\n", "parent: shared");
		await commitFile(childWt, "shared.txt", "child line\n", "child: shared");

		const result = await mergeChildBranchLocal("goal/parent", "goal/child", parentWt);
		assert.equal(result.conflict, true);
		assert.equal(result.merged, false);
		assert.equal(result.alreadyMerged, false);

		// After abort, no unmerged paths should remain.
		const status = await git(parentWt, "status", "--porcelain");
		assert.doesNotMatch(status, /^(UU|AU|UA|DU|UD|AA|DD) /m,
			`parent worktree must be clean after merge --abort, got: ${JSON.stringify(status)}`);
		// And the merge HEAD ref must not exist.
		const mergeHeadPath = path.join(primary, ".git", "worktrees", "parent-wt", "MERGE_HEAD");
		assert.equal(fs.existsSync(mergeHeadPath), false, "MERGE_HEAD must be cleaned up by --abort");
	});

	it("wrong branch in parentCwd: throws a structured error", async () => {
		// Create a third branch and check it out in the parent worktree, then
		// call mergeChildBranchLocal claiming we're on goal/parent.
		// Cannot reuse master (already checked out by the primary worktree —
		// `git checkout master` errors with "already used by worktree").
		await git(parentWt, "checkout", "-b", "decoy");
		await assert.rejects(
			() => mergeChildBranchLocal("goal/parent", "goal/child", parentWt),
			/on branch "decoy", expected "goal\/parent"/,
		);
	});
});
