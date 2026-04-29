/**
 * Unit tests for MissionGit (design §12).
 *
 * Stubs the runGit primitive and the createWorktree helper so these tests
 * never touch a real filesystem or git remote — they verify the exact
 * argv sequences the design document mandates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MissionGit,
	missionBranchName,
	slugifyTitle,
} from "../src/server/agent/mission-git.js";

interface Call { args: string[]; cwd: string }

function recorder(impl?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>) {
	const calls: Call[] = [];
	const run = async (args: string[], cwd: string) => {
		calls.push({ args, cwd });
		if (impl) return impl(args, cwd);
		return { stdout: "", stderr: "", code: 0 };
	};
	return { calls, run };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("slugifyTitle: lowercases, collapses non-alnum, trims", () => {
	assert.equal(slugifyTitle("Build Unified-Memory System"), "build-unified-memory-system");
	assert.equal(slugifyTitle("  --weird-- "), "weird");
	assert.equal(slugifyTitle("!!!"), "mission");
	// truncation at 30 chars
	const long = "a".repeat(50);
	assert.equal(slugifyTitle(long).length, 30);
});

test("missionBranchName: mission/<slug>-<id8>", () => {
	const id = "abcd1234-5678-90ab-cdef-1234567890ab";
	assert.equal(missionBranchName(id, "Hello World"), "mission/hello-world-abcd1234");
});

// ---------------------------------------------------------------------------
// createIntegrationBranch
// ---------------------------------------------------------------------------

test("createIntegrationBranch: branches off origin/master, returns base SHA", async () => {
	const r = recorder(async (args) => {
		if (args[0] === "rev-parse" && args[1] === "HEAD") {
			return { stdout: "deadbeef\n", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	});
	let createWorktreeArgs: { repoPath: string; branch: string; opts?: { startPoint?: string; skipPush?: boolean } } | null = null;
	const git = new MissionGit({
		repoPath: "/tmp/repo",
		runGit: r.run,
		createWorktreeFn: async (rp, branch, opts) => {
			createWorktreeArgs = { repoPath: rp, branch, opts };
			return { worktreePath: "/tmp/repo-wt/mission-x", branchName: branch };
		},
	});
	const out = await git.createIntegrationBranch("abcd1234-...", "Test Mission");
	assert.equal(out.branch, "mission/test-mission-abcd1234");
	assert.equal(out.worktreePath, "/tmp/repo-wt/mission-x");
	assert.equal(out.baseSha, "deadbeef");
	assert.ok(createWorktreeArgs);
	assert.equal(createWorktreeArgs!.opts?.startPoint, "origin/master");
	assert.equal(createWorktreeArgs!.opts?.skipPush, true, "must NOT push integration branch yet");
});

test("createIntegrationBranch: respects custom masterRef", async () => {
	let captured: { startPoint?: string } = {};
	const git = new MissionGit({
		repoPath: "/tmp/repo",
		runGit: async () => ({ stdout: "sha\n", stderr: "", code: 0 }),
		createWorktreeFn: async (_rp, branch, opts) => {
			captured = opts ?? {};
			return { worktreePath: "/tmp/wt", branchName: branch };
		},
	});
	await git.createIntegrationBranch("id-123", "T", "origin/main");
	assert.equal(captured.startPoint, "origin/main");
});

// ---------------------------------------------------------------------------
// childStartPoint
// ---------------------------------------------------------------------------

test("childStartPoint: returns HEAD SHA of integration worktree", async () => {
	const r = recorder(async () => ({ stdout: "abc123\n", stderr: "", code: 0 }));
	const git = new MissionGit({ repoPath: "/tmp/repo", runGit: r.run });
	const sha = await git.childStartPoint("/tmp/wt");
	assert.equal(sha, "abc123");
	assert.deepEqual(r.calls[0].args, ["rev-parse", "HEAD"]);
	assert.equal(r.calls[0].cwd, "/tmp/wt");
});

test("childStartPoint: throws on git failure", async () => {
	const r = recorder(async () => ({ stdout: "", stderr: "fatal: bad", code: 1 }));
	const git = new MissionGit({ repoPath: "/tmp/repo", runGit: r.run });
	await assert.rejects(() => git.childStartPoint("/tmp/wt"), /rev-parse HEAD failed/);
});

// ---------------------------------------------------------------------------
// mergeChild
// ---------------------------------------------------------------------------

test("mergeChild: already-merged path short-circuits before merge", async () => {
	const r = recorder(async (args) => {
		if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
		if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: "sha", stderr: "", code: 0 };
		if (args[0] === "merge-base" && args[1] === "--is-ancestor") return { stdout: "", stderr: "", code: 0 }; // ancestor → already merged
		return { stdout: "", stderr: "", code: 0 };
	});
	const git = new MissionGit({ repoPath: "/tmp/repo", runGit: r.run });
	const result = await git.mergeChild("/tmp/wt", "goal/x-12345678", "Mission", "Plan");
	assert.equal(result.status, "already-merged");
	// Must not have invoked `git merge`.
	assert.equal(r.calls.find(c => c.args[0] === "merge" && c.args[1] !== "--abort"), undefined);
});

test("mergeChild: success returns mergeSha and uses --no-ff with conventional commit msg", async () => {
	const r = recorder(async (args) => {
		if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
		if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: "sha", stderr: "", code: 0 };
		if (args[0] === "merge-base") return { stdout: "", stderr: "not ancestor", code: 1 };
		if (args[0] === "merge") return { stdout: "", stderr: "", code: 0 };
		if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "newmerge\n", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	});
	const git = new MissionGit({ repoPath: "/tmp/repo", runGit: r.run });
	const result = await git.mergeChild("/tmp/wt", "goal/x-12345678", "Build Memory", "Implement Cache");
	assert.equal(result.status, "merged");
	if (result.status === "merged") assert.equal(result.mergeSha, "newmerge");
	const mergeCall = r.calls.find(c => c.args[0] === "merge" && c.args[1] !== "--abort");
	assert.ok(mergeCall);
	assert.equal(mergeCall!.args[1], "--no-ff");
	assert.equal(mergeCall!.args[2], "-m");
	assert.match(mergeCall!.args[3], /^Mission: Build Memory — merge goal: Implement Cache$/);
});

test("mergeChild: conflict path collects unmerged files and aborts", async () => {
	const r = recorder(async (args) => {
		if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
		if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: "sha", stderr: "", code: 0 };
		if (args[0] === "merge-base") return { stdout: "", stderr: "", code: 1 };
		if (args[0] === "merge" && args[1] === "--no-ff") return { stdout: "", stderr: "CONFLICT", code: 1 };
		if (args[0] === "diff" && args.includes("--diff-filter=U")) {
			return { stdout: "src/foo.ts\nsrc/bar.ts\n", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	});
	const git = new MissionGit({ repoPath: "/tmp/repo", runGit: r.run });
	const result = await git.mergeChild("/tmp/wt", "goal/x", "M", "P");
	assert.equal(result.status, "conflict");
	if (result.status === "conflict") {
		assert.deepEqual(result.conflictFiles, ["src/foo.ts", "src/bar.ts"]);
	}
	// Must have aborted to leave worktree clean.
	const abort = r.calls.find(c => c.args[0] === "merge" && c.args[1] === "--abort");
	assert.ok(abort, "expected `git merge --abort`");
});

test("mergeChild: throws if child branch missing locally and on origin", async () => {
	const r = recorder(async (args) => {
		if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
		if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: "", stderr: "fatal", code: 1 };
		return { stdout: "", stderr: "", code: 0 };
	});
	const git = new MissionGit({ repoPath: "/tmp/repo", runGit: r.run });
	await assert.rejects(
		() => git.mergeChild("/tmp/wt", "goal/missing", "M", "P"),
		/child branch not found/,
	);
});

test("mergeChild: falls back to local branch ref when origin/<branch> missing", async () => {
	let mergeRefUsed = "";
	const r = recorder(async (args) => {
		if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
		if (args[0] === "rev-parse" && args[1] === "--verify" && args[2].startsWith("origin/")) {
			return { stdout: "", stderr: "fatal", code: 1 }; // origin missing
		}
		if (args[0] === "rev-parse" && args[1] === "--verify") {
			return { stdout: "sha", stderr: "", code: 0 }; // local exists
		}
		if (args[0] === "merge-base") return { stdout: "", stderr: "", code: 1 };
		if (args[0] === "merge" && args[1] === "--no-ff") {
			mergeRefUsed = args[args.length - 1];
			return { stdout: "", stderr: "", code: 0 };
		}
		if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "newmerge", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	});
	const git = new MissionGit({ repoPath: "/tmp/repo", runGit: r.run });
	const result = await git.mergeChild("/tmp/wt", "child/local-only", "M", "P");
	assert.equal(result.status, "merged");
	assert.equal(mergeRefUsed, "child/local-only", "should merge from local branch ref");
});

// ---------------------------------------------------------------------------
// forwardMergeMaster
// ---------------------------------------------------------------------------

test("forwardMergeMaster: up-to-date when origin/master is ancestor of HEAD", async () => {
	const r = recorder(async (args) => {
		if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
		if (args[0] === "merge-base" && args[1] === "--is-ancestor") return { stdout: "", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	});
	const git = new MissionGit({ repoPath: "/tmp/repo", runGit: r.run });
	const result = await git.forwardMergeMaster("/tmp/wt", "master");
	assert.equal(result.status, "up-to-date");
});

test("forwardMergeMaster: merges and returns sha when behind", async () => {
	const r = recorder(async (args) => {
		if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
		if (args[0] === "merge-base") return { stdout: "", stderr: "", code: 1 };
		if (args[0] === "merge") return { stdout: "", stderr: "", code: 0 };
		if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "abc", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	});
	const git = new MissionGit({ repoPath: "/tmp/repo", runGit: r.run });
	const result = await git.forwardMergeMaster("/tmp/wt", "master");
	assert.equal(result.status, "merged");
	if (result.status === "merged") assert.equal(result.mergeSha, "abc");
});

test("forwardMergeMaster: conflict path aborts and reports files", async () => {
	const r = recorder(async (args) => {
		if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
		if (args[0] === "merge-base") return { stdout: "", stderr: "", code: 1 };
		if (args[0] === "merge" && args[1] === "--no-ff") return { stdout: "", stderr: "CONFLICT", code: 1 };
		if (args[0] === "diff" && args.includes("--diff-filter=U")) return { stdout: "x.ts\n", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	});
	const git = new MissionGit({ repoPath: "/tmp/repo", runGit: r.run });
	const result = await git.forwardMergeMaster("/tmp/wt", "master");
	assert.equal(result.status, "conflict");
	if (result.status === "conflict") assert.deepEqual(result.conflictFiles, ["x.ts"]);
	const abort = r.calls.find(c => c.args[0] === "merge" && c.args[1] === "--abort");
	assert.ok(abort);
});

// ---------------------------------------------------------------------------
// pushIntegration
// ---------------------------------------------------------------------------

test("pushIntegration: skipped under BOBBIT_TEST_NO_PUSH=1", async () => {
	const original = process.env.BOBBIT_TEST_NO_PUSH;
	process.env.BOBBIT_TEST_NO_PUSH = "1";
	try {
		const r = recorder();
		const git = new MissionGit({ repoPath: "/tmp/repo", runGit: r.run });
		await git.pushIntegration("/tmp/wt", "mission/x-12345678");
		assert.equal(r.calls.length, 0, "no git calls when test mode is set");
	} finally {
		if (original === undefined) delete process.env.BOBBIT_TEST_NO_PUSH;
		else process.env.BOBBIT_TEST_NO_PUSH = original;
	}
});

test("pushIntegration: pushes with -u when not in test mode", async () => {
	const original = process.env.BOBBIT_TEST_NO_PUSH;
	delete process.env.BOBBIT_TEST_NO_PUSH;
	try {
		const r = recorder();
		const git = new MissionGit({ repoPath: "/tmp/repo", runGit: r.run });
		await git.pushIntegration("/tmp/wt", "mission/x-12345678");
		assert.equal(r.calls.length, 1);
		assert.deepEqual(r.calls[0].args, ["push", "-u", "origin", "mission/x-12345678"]);
	} finally {
		if (original !== undefined) process.env.BOBBIT_TEST_NO_PUSH = original;
	}
});

test("pushIntegration: throws on push failure", async () => {
	const original = process.env.BOBBIT_TEST_NO_PUSH;
	delete process.env.BOBBIT_TEST_NO_PUSH;
	try {
		const r = recorder(async () => ({ stdout: "", stderr: "denied", code: 1 }));
		const git = new MissionGit({ repoPath: "/tmp/repo", runGit: r.run });
		await assert.rejects(() => git.pushIntegration("/tmp/wt", "mission/x"), /pushIntegration failed/);
	} finally {
		if (original !== undefined) process.env.BOBBIT_TEST_NO_PUSH = original;
	}
});
