import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// Skip push + npm ci / setup commands in tests. Must be set BEFORE importing git.js.
process.env.BOBBIT_TEST_NO_PUSH = "1";
process.env.BOBBIT_SKIP_NPM_CI = "1";

import { createWorktreeSet } from "../src/server/skills/git.js";

/** Run git in a given cwd */
async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd });
	return stdout.trim();
}

/** Build a real git sub-repo with an initial commit under `parent/<name>`. */
async function makeGitRepo(parent: string, name: string): Promise<string> {
	const repoDir = path.join(parent, name);
	fs.mkdirSync(repoDir, { recursive: true });
	await git(["-c", "init.defaultBranch=master", "init", repoDir], parent);
	fs.writeFileSync(path.join(repoDir, "README.md"), `# ${name}\n`);
	await git(["add", "."], repoDir);
	await git(
		["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial commit"],
		repoDir,
	);
	return repoDir;
}

/**
 * Reproducing test for the poly-repo staff worktree bug.
 *
 * A poly-repo project has a NON-git container `rootPath` containing git
 * sub-repos one level deep, each registered as a component with `repo != "."`.
 * The component list also includes the non-git container as `repo: "."`.
 *
 * `createWorktreeSet` (the single source of truth) must NOT run
 * `git worktree add` against the non-git container — it should skip the
 * `repo: "."` entry in multi-repo mode and produce exactly one worktree per
 * git sub-repo.
 *
 * On CURRENT (buggy) code this test FAILS: the multi-repo loop runs
 * `git worktree add -b <branch> <wt> HEAD` with cwd = the non-git container,
 * throwing `createWorktreeSet: git worktree add failed for repo "."` /
 * `fatal: not a git repository`.
 */
describe("createWorktreeSet poly-repo (non-git container + git sub-repos)", () => {
	let root: string;
	let wtRoot: string;
	const branch = "staff-test-abcdef12";

	before(async () => {
		// Non-git container directory (deliberately NOT a git repo).
		root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-polyrepo-"));
		// Two real git sub-repos one level deep.
		await makeGitRepo(root, "repo-a");
		await makeGitRepo(root, "repo-b");
		wtRoot = path.resolve(path.dirname(root), path.basename(root) + "-wt");
	});

	after(() => {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(wtRoot, { recursive: true, force: true });
	});

	it("skips the non-git '.' container and worktrees only the git sub-repos", async () => {
		const components = [
			{ name: "container", repo: "." },
			{ name: "a", repo: "repo-a" },
			{ name: "b", repo: "repo-b" },
		];

		// 1. The call must resolve (must NOT throw). On buggy code this throws
		//    `git worktree add failed for repo "."` / `not a git repository`.
		const set = await createWorktreeSet(root, components, branch);

		// 2. Exactly the two git sub-repos are worktree'd — never the "." container.
		const repos = set.worktrees.map((w) => w.repo).sort();
		assert.deepStrictEqual(repos, ["repo-a", "repo-b"], "should worktree exactly the two git sub-repos");
		assert.ok(
			!set.worktrees.some((w) => w.repo === "."),
			'no worktree entry should exist for the non-git "." container',
		);

		// 3. Each sub-repo worktree dir exists under <root>-wt/<branch>/<repo>/ with a .git.
		for (const repo of ["repo-a", "repo-b"]) {
			const expected = path.join(wtRoot, branch, repo);
			const entry = set.worktrees.find((w) => w.repo === repo);
			assert.ok(entry, `worktree entry for ${repo} should exist`);
			assert.strictEqual(entry!.worktreePath, expected, `worktree path for ${repo} should be under the branch container`);
			assert.ok(fs.existsSync(expected), `worktree dir for ${repo} should exist`);
			assert.ok(fs.existsSync(path.join(expected, ".git")), `.git should exist in ${repo} worktree`);
		}

		// 4. The non-git container itself was never worktree'd — the branch
		//    container directory must hold no top-level `.git` (which would mean
		//    `git worktree add` ran against the container root).
		const container = path.join(wtRoot, branch);
		assert.ok(
			!fs.existsSync(path.join(container, ".git")),
			"the non-git container root must never be worktree'd",
		);
	});
});
