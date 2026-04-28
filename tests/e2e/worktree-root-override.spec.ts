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
import path from "node:path";

import { worktreeRoot, branchContainer } from "../../src/server/skills/worktree-paths.js";

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
