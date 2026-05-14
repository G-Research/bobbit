/**
 * Pins the call-site contract between `goalBranchContainer()` and
 * `resolveStep()` / `componentRoot()` in src/server/agent/verification-harness.ts.
 *
 * Bug: `goal.cwd` already has the project subdirectory offset baked in
 * (see src/server/agent/goal-manager.ts — `relativeOffset` join). The
 * verification call site at src/server/server.ts:5109-5111 historically passed
 * `goal.cwd` as the `branchContainer` to `verifyGateSignal`, which then flowed
 * into `resolveStep` → `componentRoot()`. `componentRoot()` layers
 * `repo + relativePath` on top of its input, so for a single-repo project with
 * `{ repo: ".", relativePath: "sub" }` the offset gets applied twice and the
 * resolved cwd becomes `/wt/branch/sub/sub` — ENOENT at command execution.
 *
 * The contract pinned here: `goalBranchContainer(goal)` must return the
 * **un-offset** container, i.e. `goal.worktreePath ?? goal.cwd`. Composed with
 * `resolveStep`, the resulting cwd then matches the agent-session cwd
 * exactly once, regardless of whether a `relativePath` offset is in play.
 *
 * Pattern mirrors tests/worktree-setup-multi.test.ts, which pins the analogous
 * case for `runComponentSetups`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { goalBranchContainer, resolveStep } from "../src/server/agent/verification-harness.ts";
import type { Component } from "../src/server/agent/project-config-store.ts";

describe("verify step resolution — goalBranchContainer composed with resolveStep", () => {
	it("single-repo with relativePath — goalBranchContainer must not double the offset", () => {
		// Mirrors a real goal where the project's rootPath sits in a subdirectory
		// of the git repo (e.g. /persist/code/monorepo/agentic-fluyt-experiments).
		// goalManager.createGoal() writes:
		//   worktreePath = "/wt/branch"                (un-offset)
		//   cwd          = "/wt/branch/sub"            (offset by relativePath)
		const goal = { worktreePath: "/wt/branch", cwd: "/wt/branch/sub" };
		const components: Component[] = [
			{ name: "bobbit", repo: ".", relativePath: "sub", commands: { lint: "echo ok" } },
		];
		const step = { name: "lint", type: "command", component: "bobbit", command: "lint" } as any;

		const branchContainer = goalBranchContainer(goal);
		const resolved = resolveStep(step, components, branchContainer);

		// The bug produces /wt/branch/sub/sub (relativePath applied twice).
		// The contract: relativePath applied EXACTLY ONCE on top of the un-offset container.
		assert.equal(
			resolved.cwd,
			path.join("/wt/branch", "sub"),
			`goalBranchContainer must not double the offset (got ${resolved.cwd})`,
		);
		assert.ok(
			!resolved.cwd.includes(`${path.sep}sub${path.sep}sub`),
			`expected single 'sub' segment, got doubled offset: ${resolved.cwd}`,
		);
	});

	it("single-repo without relativePath — cwd is the worktreePath unchanged", () => {
		// No project subdirectory offset: worktreePath === cwd.
		const goal = { worktreePath: "/wt/branch", cwd: "/wt/branch" };
		const components: Component[] = [
			{ name: "self", repo: ".", commands: { lint: "echo ok" } },
		];
		const step = { name: "lint", type: "command", component: "self", command: "lint" } as any;

		const resolved = resolveStep(step, components, goalBranchContainer(goal));
		assert.equal(resolved.cwd, "/wt/branch");
	});

	it("multi-repo — repo and relativePath each applied exactly once", () => {
		// Multi-repo project: components carry repo + relativePath, branchContainer
		// holds them all at the top.
		const goal = { worktreePath: "/wt/branch", cwd: "/wt/branch" };
		const components: Component[] = [
			{ name: "api", repo: "api", relativePath: "packages/api", commands: { lint: "echo ok" } },
		];
		const step = { name: "lint", type: "command", component: "api", command: "lint" } as any;

		const resolved = resolveStep(step, components, goalBranchContainer(goal));
		assert.equal(
			resolved.cwd,
			path.join("/wt/branch", "api", "packages", "api"),
			`expected each path segment applied exactly once, got ${resolved.cwd}`,
		);
	});

	it("legacy goal with no worktreePath — falls back to goal.cwd", () => {
		// Pre-worktree goals (or goals where worktreePath is undefined) carry no
		// project subdirectory offset on cwd, so the fallback is safe.
		const goal = { cwd: "/legacy/repo" } as { worktreePath?: string; cwd: string };
		const components: Component[] = [
			{ name: "self", repo: ".", commands: { lint: "echo ok" } },
		];
		const step = { name: "lint", type: "command", component: "self", command: "lint" } as any;

		const resolved = resolveStep(step, components, goalBranchContainer(goal));
		assert.equal(resolved.cwd, "/legacy/repo");
	});
});
