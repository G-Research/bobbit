/**
 * Unit tests for `mergeChildBranchLocal` (skills/git.ts) and
 * `GoalManager.mergeChild` — local-merge semantics for nested goals.
 *
 * See `docs/design/nested-goals.md` §3.3.
 *
 * Filename note: `*.test.ts` (not `.spec.ts`) so it runs under `tsx --test`
 * against `src/` directly — matches the convention set by
 * `tests/goal-manager-nesting.test.ts`.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { mergeChildBranchLocal } from "../src/server/skills/git.ts";
import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";

const execFile = promisify(execFileCb);

// Don't push to a real remote in any of these tests.
process.env.BOBBIT_TEST_NO_PUSH = "1";
// Don't run npm-ci style worktree setup commands.
process.env.BOBBIT_SKIP_NPM_CI = "1";

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd });
	return stdout.trim();
}

/** Initialise an empty git repo with one commit on `master` and basic config. */
async function makeBareRepoWithSeed(): Promise<{ tmp: string; bare: string; clone: string }> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-merge-child-"));
	const bare = path.join(tmp, "bare.git");
	fs.mkdirSync(bare, { recursive: true });
	await git(["-c", "init.defaultBranch=master", "init", "--bare", bare], tmp);
	const clone = path.join(tmp, "clone");
	await git(["-c", "init.defaultBranch=master", "clone", bare, clone], tmp);
	await git(["symbolic-ref", "HEAD", "refs/heads/master"], clone);
	await git(["config", "user.email", "test@example.com"], clone);
	await git(["config", "user.name", "Test"], clone);
	fs.writeFileSync(path.join(clone, "README.md"), "# Test\n");
	await git(["add", "."], clone);
	await git(["commit", "-m", "initial"], clone);
	await git(["push", "origin", "master"], clone);
	return { tmp, bare, clone };
}

/**
 * Set up a parent worktree on `parentBranch` (off master) and a child branch
 * on `childBranch` with one extra commit. Returns the parent worktree path.
 *
 * Optionally accepts content to write at `<file>` on both branches to set up
 * a conflict.
 */
async function makeParentChild(
	clone: string,
	tmp: string,
	parentBranch: string,
	childBranch: string,
	opts?: { conflictFile?: string; parentContent?: string; childContent?: string },
): Promise<{ parentWorktree: string }> {
	// 1. Parent branch from master + worktree.
	await git(["branch", parentBranch, "master"], clone);
	const parentWorktree = path.join(tmp, `wt-${parentBranch.replace(/[^a-z0-9]/gi, "-")}`);
	await git(["worktree", "add", parentWorktree, parentBranch], clone);
	// Worktrees inherit user.* from the repo .gitconfig already set on `clone`.

	// 2. Child branch from master with a unique commit.
	await git(["branch", childBranch, "master"], clone);
	const childWorktree = path.join(tmp, `wt-child-${childBranch.replace(/[^a-z0-9]/gi, "-")}`);
	await git(["worktree", "add", childWorktree, childBranch], clone);
	if (opts?.conflictFile && opts.childContent !== undefined) {
		fs.writeFileSync(path.join(childWorktree, opts.conflictFile), opts.childContent);
	} else {
		fs.writeFileSync(path.join(childWorktree, "CHILD_FILE.txt"), "from child\n");
	}
	await git(["add", "."], childWorktree);
	await git(["commit", "-m", "child commit"], childWorktree);

	// 3. Optional parent-side conflicting commit.
	if (opts?.conflictFile && opts.parentContent !== undefined) {
		fs.writeFileSync(path.join(parentWorktree, opts.conflictFile), opts.parentContent);
		await git(["add", "."], parentWorktree);
		await git(["commit", "-m", "parent commit"], parentWorktree);
	}

	return { parentWorktree };
}

describe("mergeChildBranchLocal — happy path", () => {
	let env: { tmp: string; bare: string; clone: string };

	before(async () => { env = await makeBareRepoWithSeed(); });
	after(() => { try { fs.rmSync(env.tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

	it("merges a child branch with --no-ff, returns commit sha, leaves clean worktree", async () => {
		const parentBranch = "goal/parent-happy";
		const childBranch = "goal/child-happy";
		const { parentWorktree } = await makeParentChild(env.clone, env.tmp, parentBranch, childBranch);

		const result = await mergeChildBranchLocal(parentWorktree, parentBranch, childBranch);

		assert.equal(result.merged, true, `expected merged, got output:\n${result.output}`);
		assert.equal(result.conflict, false);
		assert.match(result.commitSha ?? "", /^[0-9a-f]{40}$/, "commitSha should be a 40-char hex sha");

		// Merge commit message should match the spec'd format and carry the co-author trailer.
		const lastMsg = await git(["log", "-1", "--pretty=%B"], parentWorktree);
		assert.ok(
			lastMsg.startsWith(`Merge child ${childBranch} into ${parentBranch}`),
			`expected merge commit subject, got:\n${lastMsg}`,
		);
		assert.match(lastMsg, /Co-authored-by: bobbit-ai <bobbit@bobbit.ai>/);

		// --no-ff means the merge commit has 2 parents.
		const parents = await git(["log", "-1", "--pretty=%P"], parentWorktree);
		assert.equal(parents.split(" ").length, 2, `expected 2-parent merge, got: ${parents}`);

		// The child's file is present in the parent worktree post-merge.
		assert.ok(fs.existsSync(path.join(parentWorktree, "CHILD_FILE.txt")));

		// Worktree is clean (no merge conflict markers, no MERGE_HEAD).
		const status = await git(["status", "--porcelain"], parentWorktree);
		assert.equal(status, "", `expected clean worktree, got:\n${status}`);
		assert.ok(!fs.existsSync(path.join(parentWorktree, ".git", "MERGE_HEAD")));
	});
});

describe("mergeChildBranchLocal — conflict", () => {
	let env: { tmp: string; bare: string; clone: string };

	before(async () => { env = await makeBareRepoWithSeed(); });
	after(() => { try { fs.rmSync(env.tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

	it("aborts on conflict, returns merged:false/conflict:true, parent worktree clean", async () => {
		const parentBranch = "goal/parent-conflict";
		const childBranch = "goal/child-conflict";
		const { parentWorktree } = await makeParentChild(env.clone, env.tmp, parentBranch, childBranch, {
			conflictFile: "BATTLEGROUND.txt",
			parentContent: "parent-version-line\n",
			childContent: "child-version-line\n",
		});

		const result = await mergeChildBranchLocal(parentWorktree, parentBranch, childBranch);

		assert.equal(result.merged, false, `expected NOT merged, got output:\n${result.output}`);
		assert.equal(result.conflict, true);
		assert.equal(result.commitSha, undefined);

		// Parent worktree should be clean post-abort.
		const status = await git(["status", "--porcelain"], parentWorktree);
		assert.equal(status, "", `expected clean worktree post-abort, got:\n${status}`);
		assert.ok(
			!fs.existsSync(path.join(parentWorktree, ".git", "MERGE_HEAD")),
			"MERGE_HEAD should be absent after merge --abort",
		);

		// Parent's version should be intact (abort restored it).
		const after = fs.readFileSync(path.join(parentWorktree, "BATTLEGROUND.txt"), "utf8");
		assert.equal(after, "parent-version-line\n");

		// HEAD should still point at the parent's pre-merge commit (not the child's tip).
		const headMsg = await git(["log", "-1", "--pretty=%s"], parentWorktree);
		assert.equal(headMsg, "parent commit");
	});
});

describe("mergeChildBranchLocal — missing child branch", () => {
	let env: { tmp: string; bare: string; clone: string };

	before(async () => { env = await makeBareRepoWithSeed(); });
	after(() => { try { fs.rmSync(env.tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

	it("returns merged:false/conflict:false when child ref cannot be resolved", async () => {
		const parentBranch = "goal/parent-missing";
		await git(["branch", parentBranch, "master"], env.clone);
		const parentWorktree = path.join(env.tmp, "wt-parent-missing");
		await git(["worktree", "add", parentWorktree, parentBranch], env.clone);

		const result = await mergeChildBranchLocal(parentWorktree, parentBranch, "goal/does-not-exist");
		assert.equal(result.merged, false);
		assert.equal(result.conflict, false);
		assert.match(result.output, /not found/i);
	});
});

describe("GoalManager.mergeChild", () => {
	let env: { tmp: string; bare: string; clone: string };
	let stateDir: string;

	before(async () => { env = await makeBareRepoWithSeed(); });
	after(() => { try { fs.rmSync(env.tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

	beforeEach(() => {
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-mergechild-state-"));
	});

	function makeManager(): { store: GoalStore; gm: GoalManager } {
		const store = new GoalStore(stateDir);
		const gm = new GoalManager(store);
		return { store, gm };
	}

	function putGoal(store: GoalStore, overrides: Partial<PersistedGoal> & { id: string }): void {
		const now = Date.now();
		store.put({
			title: `Goal ${overrides.id}`,
			cwd: "/",
			state: "todo",
			spec: "",
			createdAt: now,
			updatedAt: now,
			...overrides,
		} as PersistedGoal);
	}

	it("dispatches to mergeChildBranchLocal using parent.worktreePath / parent.branch / child.branch", async () => {
		const parentBranch = "goal/parent-gm-happy";
		const childBranch = "goal/child-gm-happy";
		const { parentWorktree } = await makeParentChild(env.clone, env.tmp, parentBranch, childBranch);

		const { store, gm } = makeManager();
		putGoal(store, {
			id: "p", cwd: parentWorktree, worktreePath: parentWorktree,
			branch: parentBranch, repoPath: env.clone, rootGoalId: "p",
		});
		putGoal(store, {
			id: "c", cwd: env.clone, branch: childBranch, repoPath: env.clone,
			parentGoalId: "p", rootGoalId: "p", mergeTarget: "parent",
		});

		const r = await gm.mergeChild("p", "c");
		assert.equal(r.merged, true);
		assert.equal(r.conflict, false);
		assert.match(r.commitSha ?? "", /^[0-9a-f]{40}$/);
	});

	it("throws when parent goal not found", async () => {
		const { gm } = makeManager();
		await assert.rejects(() => gm.mergeChild("missing", "also-missing"), /parent goal not found/);
	});

	it("throws when child goal not found", async () => {
		const { store, gm } = makeManager();
		putGoal(store, { id: "p", worktreePath: "/", branch: "x", repoPath: "/", rootGoalId: "p" });
		await assert.rejects(() => gm.mergeChild("p", "nope"), /child goal not found/);
	});

	it("throws when child is not a child of parent", async () => {
		const { store, gm } = makeManager();
		putGoal(store, { id: "p", worktreePath: "/", branch: "x", repoPath: "/", rootGoalId: "p" });
		putGoal(store, { id: "c", branch: "y", parentGoalId: "other", rootGoalId: "other" });
		await assert.rejects(() => gm.mergeChild("p", "c"), /not a child of/);
	});

	it("throws when parent has no worktree", async () => {
		const { store, gm } = makeManager();
		// no worktreePath on parent
		putGoal(store, { id: "p", branch: "x", rootGoalId: "p" });
		putGoal(store, { id: "c", branch: "y", parentGoalId: "p", rootGoalId: "p" });
		await assert.rejects(() => gm.mergeChild("p", "c"), /has no worktree/);
	});
});
