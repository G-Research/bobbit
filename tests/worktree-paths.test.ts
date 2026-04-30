/**
 * Unit tests for worktree-paths helpers — see docs/design/multi-repo-components.md §4.1.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
	worktreeRoot,
	branchContainer,
	repoWorktreePath,
	componentRoot,
	branchToSlug,
} from "../src/server/skills/worktree-paths.ts";

describe("branchToSlug", () => {
	it("flattens slashes to dashes", () => {
		assert.equal(branchToSlug("goal/multi-repo-93752e63"), "goal-multi-repo-93752e63");
		assert.equal(branchToSlug("session/foo-bar"), "session-foo-bar");
	});
	it("is idempotent on slugs without slashes", () => {
		assert.equal(branchToSlug("plain-branch"), "plain-branch");
	});
});

describe("worktreeRoot", () => {
	it("defaults to <rootPath>-wt sibling when worktree_root is unset", () => {
		const project = { rootPath: path.resolve("/home/me/w/myapp") };
		assert.equal(
			worktreeRoot(project),
			path.resolve("/home/me/w/myapp-wt"),
		);
	});

	it("uses absolute worktree_root as-is", () => {
		const abs = path.resolve("/var/lib/wts");
		const project = { rootPath: path.resolve("/home/me/w/myapp"), worktreeRoot: abs };
		assert.equal(worktreeRoot(project), abs);
	});

	it("resolves relative worktree_root against rootPath", () => {
		const project = { rootPath: path.resolve("/home/me/w/myapp"), worktreeRoot: "../my-wts" };
		assert.equal(
			worktreeRoot(project),
			path.resolve("/home/me/w/my-wts"),
		);
	});
});

describe("branchContainer", () => {
	it("joins worktreeRoot and branchSlug", () => {
		const project = { rootPath: path.resolve("/home/me/w/myapp") };
		assert.equal(
			branchContainer(project, "goal-foo-1234"),
			path.resolve("/home/me/w/myapp-wt/goal-foo-1234"),
		);
	});
});

describe("repoWorktreePath", () => {
	it("collapses to branchContainer in single-repo mode (repo === '.')", () => {
		const project = { rootPath: path.resolve("/home/me/w/myapp") };
		const got = repoWorktreePath(project, [{ name: "myapp", repo: "." }], "goal-x", ".");
		assert.equal(got, path.resolve("/home/me/w/myapp-wt/goal-x"));
		assert.equal(got, branchContainer(project, "goal-x"),
			"single-repo: repoWorktreePath must equal branchContainer");
	});

	it("appends repo subfolder in multi-repo mode", () => {
		const project = { rootPath: path.resolve("/home/me/w/myproj") };
		const components = [
			{ name: "api", repo: "api" },
			{ name: "web", repo: "web" },
		];
		assert.equal(
			repoWorktreePath(project, components, "goal-x", "api"),
			path.resolve("/home/me/w/myproj-wt/goal-x/api"),
		);
		assert.equal(
			repoWorktreePath(project, components, "goal-x", "web"),
			path.resolve("/home/me/w/myproj-wt/goal-x/web"),
		);
	});
});

describe("componentRoot", () => {
	it("collapses to branchContainer for single-repo component without relativePath", () => {
		const container = path.resolve("/wt/branch");
		const got = componentRoot({ name: "x", repo: "." }, container);
		assert.equal(got, container);
	});

	it("appends relativePath for monorepo subdir", () => {
		const container = path.resolve("/wt/branch");
		const got = componentRoot({ name: "api", repo: ".", relativePath: "packages/api" }, container);
		assert.equal(got, path.join(container, "packages/api"));
	});

	it("appends repo for multi-repo component", () => {
		const container = path.resolve("/wt/branch");
		const got = componentRoot({ name: "api", repo: "api" }, container);
		assert.equal(got, path.join(container, "api"));
	});

	it("appends repo + relativePath", () => {
		const container = path.resolve("/wt/branch");
		const got = componentRoot({ name: "api", repo: "services", relativePath: "api" }, container);
		assert.equal(got, path.join(container, "services", "api"));
	});
});
