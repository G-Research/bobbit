/**
 * Phase 2 — sandbox compatibility for nested goals.
 *
 * The original SUBGOALS-SPEC §3.4 said reject sandboxed children with
 * HTTP 400. The user has reversed this: sandbox MUST work. The mechanism
 * is already in place — `ProjectSandbox.createWorktree(name, branch,
 * baseBranch?)` accepts an optional baseBranch and threads it into
 * `git worktree add -b <branch> <path> <baseBranch>` inside the
 * container. Since sandboxed worktrees share `/workspace/.git`, the
 * parent goal's branch ref IS visible to the child worktree creation.
 *
 * This test pins the contract:
 *   - When called with `baseBranch="goal/parent-xyz"`, the sandbox issues
 *     `git worktree add -b <child> <wt-path> goal/parent-xyz` (NOT
 *     origin/master, NOT origin/HEAD).
 *   - When called with no `baseBranch`, the existing default behaviour
 *     (resolve `origin/HEAD`, fall back to `origin/master`) is unchanged.
 *
 * Method: subclass `ProjectSandbox` and override the private
 * `_dockerExec` via `(this as any)` to a recording stub. This is the
 * lightest-weight mock that pins the wire format without spinning up a
 * real Docker daemon.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ProjectSandbox } from "../src/server/agent/project-sandbox.ts";

interface ExecCall {
	containerId: string;
	args: string[];
	cwd?: string;
}

class TestProjectSandbox extends ProjectSandbox {
	calls: ExecCall[] = [];
	stubResponse: string | ((args: string[]) => string) = "";

	constructor() {
		super({
			projectId: "test-project",
			projectDir: "/tmp/test-project",
			repoUrl: "https://example.com/test.git",
			image: "test:latest",
		});
		// Force-set containerId so getContainerId() resolves immediately
		// without spinning up Docker.
		(this as any).containerId = "test-container-id";
		(this as any)._readyPromise = Promise.resolve();
		(this as any)._status = "ready";
	}

	// Override the private docker-exec method to record calls.
	async _dockerExec(containerId: string, args: string[], opts?: { cwd?: string }): Promise<string> {
		this.calls.push({ containerId, args, cwd: opts?.cwd });
		const r = typeof this.stubResponse === "function" ? this.stubResponse(args) : this.stubResponse;
		return r;
	}
}

describe("ProjectSandbox.createWorktree — Phase 2 baseBranch threading", () => {
	it("baseBranch='goal/parent-xyz' → docker exec issues `git worktree add -b <child> /workspace-wt/<name> goal/parent-xyz`", async () => {
		const sb = new TestProjectSandbox();
		// Force BOBBIT_TEST_NO_PUSH so the post-commit hook + push branches
		// short-circuit and don't pollute the call log.
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		try {
			const result = await sb.createWorktree("session-abc", "goal/child-abc", "goal/parent-xyz");
			assert.equal(result, "/workspace-wt/session-abc");
		} finally {
			delete process.env.BOBBIT_TEST_NO_PUSH;
		}

		// Among the recorded docker-exec calls, find the `git worktree add`
		// invocation. It must include `goal/parent-xyz` as the start point.
		const wtAdd = sb.calls.find(c => c.args[0] === "git" && c.args[1] === "worktree" && c.args[2] === "add");
		assert.ok(wtAdd, `expected a 'git worktree add' call, got: ${JSON.stringify(sb.calls.map(c => c.args))}`);
		assert.deepEqual(wtAdd!.args, [
			"git", "worktree", "add", "/workspace-wt/session-abc", "-b", "goal/child-abc", "goal/parent-xyz",
		]);
	});

	it("no baseBranch → resolves origin/HEAD via symbolic-ref, falls back to origin/master", async () => {
		const sb = new TestProjectSandbox();
		// Stub symbolic-ref to return refs/remotes/origin/master.
		sb.stubResponse = (args: string[]) => {
			if (args[0] === "git" && args[1] === "symbolic-ref") {
				return "refs/remotes/origin/master\n";
			}
			return "";
		};
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		try {
			await sb.createWorktree("session-def", "goal/child-def");
		} finally {
			delete process.env.BOBBIT_TEST_NO_PUSH;
		}

		const wtAdd = sb.calls.find(c => c.args[0] === "git" && c.args[1] === "worktree" && c.args[2] === "add");
		assert.ok(wtAdd, `expected a 'git worktree add' call, got: ${JSON.stringify(sb.calls.map(c => c.args))}`);
		// Last positional arg is the start point — must be origin/master, NOT
		// "goal/<anything>" or HEAD.
		assert.equal(wtAdd!.args[wtAdd!.args.length - 1], "origin/master");
	});

	it("symbolic-ref failure → falls back to origin/master literal", async () => {
		const sb = new TestProjectSandbox();
		sb.stubResponse = (args: string[]) => {
			if (args[0] === "git" && args[1] === "symbolic-ref") {
				throw new Error("fatal: ref refs/remotes/origin/HEAD is not a symbolic ref");
			}
			return "";
		};
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		try {
			await sb.createWorktree("session-ghi", "goal/child-ghi");
		} finally {
			delete process.env.BOBBIT_TEST_NO_PUSH;
		}

		const wtAdd = sb.calls.find(c => c.args[0] === "git" && c.args[1] === "worktree" && c.args[2] === "add");
		assert.ok(wtAdd);
		assert.equal(wtAdd!.args[wtAdd!.args.length - 1], "origin/master");
	});

	it("Phase 2 invariant: baseBranch is passed through verbatim — no string mangling", async () => {
		// Defensive: a future refactor could accidentally prefix
		// "origin/" or strip slashes. Pin the exact string.
		const sb = new TestProjectSandbox();
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		try {
			await sb.createWorktree("c", "goal/grandchild", "goal/intermediate-child-12345678");
		} finally {
			delete process.env.BOBBIT_TEST_NO_PUSH;
		}
		const wtAdd = sb.calls.find(c => c.args[0] === "git" && c.args[1] === "worktree" && c.args[2] === "add");
		assert.ok(wtAdd);
		assert.equal(wtAdd!.args[wtAdd!.args.length - 1], "goal/intermediate-child-12345678");
	});
});
