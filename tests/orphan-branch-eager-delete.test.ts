/**
 * Unit tests for `eagerDeleteRemoteSessionBranch` (Bug 2 of
 * docs/design/orphan-remote-branch-cleanup.md). Stubs the git invocation
 * primitive so no real git or network is involved.
 *
 * Why a focused unit test rather than extending in-process-harness: the
 * in-process E2E harness sets BOBBIT_TEST_NO_PUSH=1 globally, which is
 * exactly the wrong shape for asserting we *would* have called
 * `git push --delete` here. A stubbed-helper test is cleaner, faster, and
 * doesn't depend on git semantics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eagerDeleteRemoteSessionBranch } from "../src/server/agent/session-eager-branch-delete.js";

interface Call { args: string[]; cwd: string }

function recorder(impl?: (args: string[], cwd: string) => Promise<void>) {
	const calls: Call[] = [];
	const run = async (args: string[], cwd: string) => {
		calls.push({ args, cwd });
		if (impl) await impl(args, cwd);
	};
	return { calls, run };
}

test("merged session branch is push-deleted exactly once", async () => {
	const r = recorder();
	const result = await eagerDeleteRemoteSessionBranch({
		branch: "session/abc-12345678",
		repoPath: "/tmp/repo",
		skipPush: false,
		detectPrimary: async () => "master",
		runGit: r.run,
	});
	assert.equal(result.deleted, true);
	const pushCalls = r.calls.filter(c => c.args[0] === "push");
	assert.equal(pushCalls.length, 1, "expected exactly one push --delete call");
	assert.deepEqual(pushCalls[0].args, [
		"push", "origin", "--delete", "session/abc-12345678",
	]);
	// Ancestor check ran first.
	assert.equal(r.calls[0].args[0], "merge-base");
	assert.deepEqual(r.calls[0].args, [
		"merge-base", "--is-ancestor", "session/abc-12345678", "origin/master",
	]);
});

test("unmerged session branch is NOT deleted", async () => {
	const r = recorder(async (args) => {
		if (args[0] === "merge-base") throw new Error("not ancestor (exit 1)");
	});
	const result = await eagerDeleteRemoteSessionBranch({
		branch: "session/foo-abcdef",
		repoPath: "/tmp/repo",
		skipPush: false,
		detectPrimary: async () => "master",
		runGit: r.run,
	});
	assert.equal(result.deleted, false);
	assert.equal(result.reason, "unmerged-or-missing-ref");
	// merge-base ran, push did not.
	assert.equal(r.calls.filter(c => c.args[0] === "push").length, 0);
});

test("non-session branch is skipped (no git calls)", async () => {
	const r = recorder();
	const result = await eagerDeleteRemoteSessionBranch({
		branch: "goal/something",
		repoPath: "/tmp/repo",
		skipPush: false,
		detectPrimary: async () => "master",
		runGit: r.run,
	});
	assert.equal(result.deleted, false);
	assert.equal(result.reason, "non-session-branch");
	assert.equal(r.calls.length, 0);
});

test("delegate session is skipped (no git calls)", async () => {
	const r = recorder();
	const result = await eagerDeleteRemoteSessionBranch({
		branch: "session/delegate-abc",
		repoPath: "/tmp/repo",
		delegateOf: "parent-id",
		skipPush: false,
		detectPrimary: async () => "master",
		runGit: r.run,
	});
	assert.equal(result.deleted, false);
	assert.equal(result.reason, "delegate");
	assert.equal(r.calls.length, 0);
});

test("shouldSkipRemotePush short-circuits before any git invocation", async () => {
	const r = recorder();
	const result = await eagerDeleteRemoteSessionBranch({
		branch: "session/foo-abcdef",
		repoPath: "/tmp/repo",
		skipPush: true,
		detectPrimary: async () => "master",
		runGit: r.run,
	});
	assert.equal(result.deleted, false);
	assert.equal(result.reason, "skip-push");
	assert.equal(r.calls.length, 0);
});
