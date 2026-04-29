/**
 * `worktree_root` override — pure path-helper test.
 *
 * Verifies that the `worktreeRoot()` helper resolves a project's
 * `worktree_root` setting against `rootPath` consistently and that
 * `branchContainer()` lays out under the override.
 *
 * See docs/design/multi-repo-components.md §4.1.
 */
import { test, expect } from "./in-process-harness.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { worktreeRoot, branchContainer } from "../../src/server/skills/worktree-paths.js";
import { createWorktree, createWorktreeSet, cleanupWorktree } from "../../src/server/skills/git.js";

function gitInit(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--quiet", "-b", "master"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@b.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "README.md"), "x\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: dir });
}

test("absolute worktree_root override is used as-is", () => {
	const wt = worktreeRoot({ rootPath: "/repo", worktreeRoot: "/abs/wts" });
	expect(wt).toBe(path.resolve("/abs/wts"));
});

test("relative worktree_root override resolves against rootPath", () => {
	const wt = worktreeRoot({ rootPath: "/repo", worktreeRoot: "../my-wts" });
	expect(wt).toBe(path.resolve("/repo", "../my-wts"));
	const c = branchContainer({ rootPath: "/repo", worktreeRoot: "../my-wts" }, "feat-x");
	expect(c).toBe(path.join(path.resolve("/repo", "../my-wts"), "feat-x"));
});

test("default worktree_root falls back to <rootPath>-wt", () => {
	const wt = worktreeRoot({ rootPath: "/repo" });
	expect(wt).toBe(path.resolve("/", "repo-wt"));
});

test("single-repo createWorktree honors worktreeRoot override on disk", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-wtr-single-"));
	const repo = path.join(tmp, "repo");
	const override = path.join(tmp, "custom-wt");
	gitInit(repo);

	const branch = `feat/wtr-${Date.now()}`;
	process.env.BOBBIT_TEST_NO_PUSH = "1";
	try {
		const result = await createWorktree(repo, branch, { worktreeRoot: override, skipPush: true });
		expect(result.worktreePath.startsWith(override)).toBe(true);
		expect(fs.existsSync(result.worktreePath)).toBe(true);
		expect(fs.existsSync(path.join(result.worktreePath, ".git"))).toBe(true);

		await cleanupWorktree(repo, result.worktreePath, branch, true);
		expect(fs.existsSync(result.worktreePath)).toBe(false);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("multi-repo createWorktreeSet honors worktreeRoot override (claim + cleanup)", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-wtr-multi-"));
	const rootPath = path.join(tmp, "proj");
	fs.mkdirSync(rootPath);
	gitInit(path.join(rootPath, "api"));
	gitInit(path.join(rootPath, "web"));
	gitInit(path.join(rootPath, "shared"));
	const override = path.join(tmp, "shared-wt");

	const branch = `goal/wtr-${Date.now()}`;
	process.env.BOBBIT_TEST_NO_PUSH = "1";
	try {
		const components = [
			{ name: "api", repo: "api" },
			{ name: "web", repo: "web" },
			{ name: "shared", repo: "shared" },
		];
		const set = await createWorktreeSet(rootPath, components, branch, undefined, { worktreeRoot: override });
		expect(set.container.startsWith(override)).toBe(true);
		expect(set.worktrees).toHaveLength(3);
		for (const w of set.worktrees) {
			expect(w.worktreePath.startsWith(override)).toBe(true);
			expect(fs.existsSync(w.worktreePath)).toBe(true);
			expect(fs.existsSync(path.join(w.worktreePath, ".git"))).toBe(true);
		}

		// Cleanup each per-repo worktree.
		for (const w of set.worktrees) {
			await cleanupWorktree(w.repoPath, w.worktreePath, branch, true);
			expect(fs.existsSync(w.worktreePath)).toBe(false);
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
