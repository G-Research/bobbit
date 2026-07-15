// Reproducing + decision-matrix tests for the destructive pre-verification
// goal-worktree sync bug.
//
// Bug: `src/server/agent/verification-harness.ts` pre-verification sync block
// unconditionally runs `git reset --hard origin/<goalBranch>` when the goal
// branch is published. Under the team-lead local-merge model the local goal
// worktree is normally AHEAD of origin, so the reset silently discards
// un-pushed local commits and verification runs against stale code.
//
// These tests exercise the REAL VerificationHarness against REAL temp git
// repos (bare origin + clone), stubbing only `runCommandStep` so the verify
// STEP always passes — we assert on the git HEAD state after the sync, not on
// step results. Follows the pattern in verification-basebranch-regression.test.ts.
//
// Expected against CURRENT (buggy) code:
//   - "local-ahead ... NOT discarded"  => FAILS (HEAD reset back to A)
//   - "diverged ... keeps local"       => FAILS (HEAD reset to origin C, no warning)
//   - "local-behind ... fast-forward"  => PASSES (reset == fast-forward here)
//   - "local up-to-date ... unchanged" => PASSES
// After the ancestry-aware fix, all four PASS.

import { afterAll, beforeAll, test } from "vitest";
import assert from "node:assert/strict";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect, promisify } from "node:util";

const { VerificationHarness } = await import("../../src/server/agent/verification-harness.js");

const execFileAsync = promisify(execFileCb);
const GOAL_BRANCH = "goal/nondestructive-sync";
type PublishedFixture = { root: string; repoDir: string; remoteDir: string; goalBranch: string; shaA: string };
let templateRoot: string;
let templateRemoteDir: string;
let templateShaA: string;
let repoFixtures: PublishedFixture[] = [];

beforeAll(async () => {
	templateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verif-nondestructive-sync-template-"));
	templateRemoteDir = path.join(templateRoot, "remote.git");
	const seedDir = path.join(templateRoot, "seed");
	execFileSync("git", ["init", "--bare", templateRemoteDir], { stdio: "ignore" });
	gitQuiet(templateRemoteDir, ["symbolic-ref", "HEAD", "refs/heads/master"]);
	execFileSync("git", ["init", seedDir], { stdio: "ignore" });
	gitQuiet(seedDir, ["checkout", "-B", "master"]);
	writeAndCommit(seedDir, "README.md", "published master\n", "Initial commit");
	gitQuiet(seedDir, ["checkout", "-b", GOAL_BRANCH]);
	templateShaA = writeAndCommit(seedDir, "feature.txt", "commit A\n", "commit A");
	gitQuiet(seedDir, ["remote", "add", "origin", templateRemoteDir]);
	gitQuiet(seedDir, ["push", "origin", "master", GOAL_BRANCH]);
	repoFixtures = await Promise.all(Array.from({ length: 5 }, () => makePublishedGoalBranchRepo()));
});

afterAll(() => {
	for (const fixture of repoFixtures) fs.rmSync(fixture.root, { recursive: true, force: true });
	fs.rmSync(templateRoot, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitQuiet(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function commit(cwd: string, message: string): void {
	execFileSync(
		"git",
		["-c", "user.name=Bobbit Test", "-c", "user.email=bobbit@example.test", "commit", "-m", message],
		{ cwd, stdio: "ignore" },
	);
}

function writeAndCommit(cwd: string, file: string, contents: string, message: string): string {
	fs.writeFileSync(path.join(cwd, file), contents);
	gitQuiet(cwd, ["add", file]);
	commit(cwd, message);
	return git(cwd, ["rev-parse", "HEAD"]);
}

function makeTempStateDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "verif-nondestructive-sync-state-"));
	const stateDir = path.join(root, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	return stateDir;
}

/**
 * Build a bare `origin` remote with a `master` branch, clone into `repo`, then
 * create + PUBLISH the goal branch at commit A. The returned `repoDir` has the
 * goal branch checked out at A, and `origin/<goalBranch>` also points at A.
 */
async function makePublishedGoalBranchRepo(): Promise<PublishedFixture> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "verif-nondestructive-sync-"));
	const remoteDir = path.join(root, "remote.git");
	const repoDir = path.join(root, "repo");

	// Clone a real independent bare remote from the immutable published template.
	// Refs remain per-test mutable while immutable Git objects may be hard-linked.
	await execFileAsync("git", ["clone", "--bare", "--local", templateRemoteDir, remoteDir], { windowsHide: true });
	await execFileAsync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], { cwd: remoteDir, windowsHide: true });
	await execFileAsync("git", ["clone", remoteDir, repoDir], { windowsHide: true });
	await execFileAsync("git", ["checkout", GOAL_BRANCH], { cwd: repoDir, windowsHide: true });
	const shaA = git(repoDir, ["rev-parse", "HEAD"]);
	assert.equal(shaA, templateShaA, "fixture precondition: cloned goal branch must start at commit A");
	assert.doesNotThrow(
		() => execFileSync("git", ["ls-remote", "--exit-code", "--heads", "origin", GOAL_BRANCH], { cwd: repoDir, stdio: "pipe" }),
		"fixture precondition: goal branch must be published to origin",
	);

	return { root, repoDir, remoteDir, goalBranch: GOAL_BRANCH, shaA };
}

/**
 * Push an extra commit onto `origin/<goalBranch>` via a throwaway clone, WITHOUT
 * touching `repoDir`. Returns the sha of the new origin tip. Used to advance
 * origin ahead of (or divergent from) the local worktree.
 */
function pushExtraOriginCommit(root: string, remoteDir: string, goalBranch: string, file: string, contents: string, message: string): string {
	const pusherDir = path.join(root, `pusher-${Math.random().toString(36).slice(2)}`);
	execFileSync("git", ["clone", remoteDir, pusherDir], { stdio: "ignore" });
	gitQuiet(pusherDir, ["checkout", goalBranch]);
	const sha = writeAndCommit(pusherDir, file, contents, message);
	gitQuiet(pusherDir, ["push", "origin", goalBranch]);
	fs.rmSync(pusherDir, { recursive: true, force: true });
	return sha;
}

function makeProjectConfigStore(baseRef: string) {
	return {
		get: (key: string) => key === "base_ref" ? baseRef : "",
		getWithDefaults: () => ({
			build_command: "npm run build",
			test_command: "npm test",
			typecheck_command: "npm run check",
			test_unit_command: "npm run test:unit",
			test_e2e_command: "npm run test:e2e",
			base_ref: baseRef,
		}),
		getComponents: () => [],
	};
}

function makeGateStore(signal: any) {
	const gateState: any = {
		goalId: signal.goalId,
		gateId: signal.gateId,
		status: "pending",
		signals: [signal],
	};
	return {
		getGate: () => gateState,
		getGatesForGoal: () => [gateState],
		updateSignalVerification: (signalId: string, verification: any) => {
			const target = gateState.signals.find((s: any) => s.id === signalId);
			assert.ok(target, `test fixture missing signal ${signalId}`);
			target.verification = verification;
		},
		updateGateStatus: (_goalId: string, _gateId: string, status: string) => {
			gateState.status = status;
		},
		_gateState: gateState,
	};
}

function makeHarnessFixture(baseRef = "origin/master") {
	const signal = {
		id: "signal-nondestructive-sync",
		goalId: "goal-nondestructive-sync",
		gateId: "implementation",
		sessionId: "session-nondestructive-sync",
		timestamp: Date.now(),
		commitSha: "abcdef1234567890",
		content: "ready",
		metadata: {},
	};
	const gateStore = makeGateStore(signal);
	const goal = {
		id: signal.goalId,
		branch: GOAL_BRANCH,
		cwd: process.cwd(),
		worktreePath: process.cwd(),
		spec: "Reproduce destructive goal-worktree sync",
		state: "in-progress",
		workflowId: "feature",
	};
	const projectConfigStore = makeProjectConfigStore(baseRef);
	const projectContextManager = {
		getContextForGoal: (goalId: string) => goalId === signal.goalId ? {
			project: { id: "project-nondestructive-sync" },
			goalStore: { get: (id: string) => id === signal.goalId ? goal : undefined },
			gateStore,
			projectConfigStore,
		} : null,
	};
	const harness = new VerificationHarness(
		makeTempStateDir(),
		undefined,
		() => {},
		{ get: () => null, getAll: () => [] } as any,
		undefined,
		undefined,
		undefined,
		projectConfigStore as any,
		projectContextManager as any,
	);
	return { harness, signal, gateStore, goal };
}

const GATE_DEF = {
	id: "implementation",
	name: "Implementation",
	dependsOn: [],
	verify: [{
		name: "Trivial verify step",
		type: "command",
		run: "echo nondestructive-sync-check",
	}],
} as any;

/**
 * Drive the pre-verification sync by running a trivial (always-passing) verify
 * step. Captures console.warn output for assertions. Returns final HEAD + warnings.
 */
async function runVerificationCapturingWarnings(
	harness: any,
	signal: any,
	repoDir: string,
	goalBranch: string,
): Promise<{ head: string; warnings: string }> {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	harness.runCommandStep = async (command: string) => ({ passed: true, output: `executed ${command}` });
	console.warn = (...args: any[]) => {
		warnings.push(args.map(arg => typeof arg === "string" ? arg : inspect(arg)).join(" "));
	};
	try {
		await harness.verifyGateSignal(
			signal,
			GATE_DEF,
			repoDir,
			goalBranch,
			"master",
			new Map(),
			"Reproduce destructive goal-worktree sync",
		);
	} finally {
		console.warn = originalWarn;
	}
	return { head: git(repoDir, ["rev-parse", "HEAD"]), warnings: warnings.join("\n") };
}

test("local-ahead goal worktree: un-pushed local commit B is NOT discarded by pre-verification sync", async () => {
	const { root, repoDir, goalBranch, shaA } = repoFixtures[0]!;
	const { harness, signal } = makeHarnessFixture("origin/master");
	try {
		// Add a LOCAL-ONLY commit B on top of the published A (worktree now AHEAD of origin).
		const shaB = writeAndCommit(repoDir, "feature.txt", "commit A\ncommit B (local only)\n", "commit B local only");
		assert.notEqual(shaB, shaA, "fixture precondition: B must differ from A");

		const { head } = await runVerificationCapturingWarnings(harness, signal, repoDir, goalBranch);

		assert.equal(
			head,
			shaB,
			`NONDESTRUCTIVE_SYNC_REPRO: local-ahead commit B was discarded by pre-verification reset (HEAD=${head} expected ${shaB}, origin tip A=${shaA})`,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("local-behind goal worktree: sync fast-forwards HEAD to origin tip (published-work behaviour preserved)", async () => {
	const { root, repoDir, remoteDir, goalBranch, shaA } = repoFixtures[1]!;
	const { harness, signal } = makeHarnessFixture("origin/master");
	try {
		// Advance origin ahead with commit C; local worktree stays at A (behind, nothing unique).
		const shaC = pushExtraOriginCommit(root, remoteDir, goalBranch, "feature.txt", "commit A\ncommit C (origin)\n", "commit C on origin");
		assert.equal(git(repoDir, ["rev-parse", "HEAD"]), shaA, "fixture precondition: local still at A before sync");

		const { head, warnings } = await runVerificationCapturingWarnings(harness, signal, repoDir, goalBranch);

		assert.equal(
			head,
			shaC,
			`local-behind sync must fast-forward HEAD to origin tip C (HEAD=${head} expected ${shaC})`,
		);
		assert.doesNotMatch(
			warnings,
			/diverged|Failed to sync worktree/i,
			`local-behind fast-forward must not emit divergence/sync-failure warnings:\n${warnings}`,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("diverged goal worktree: sync keeps local commit B and surfaces a warning (no hard reset)", async () => {
	const { root, repoDir, remoteDir, goalBranch, shaA } = repoFixtures[2]!;
	const { harness, signal } = makeHarnessFixture("origin/master");
	try {
		// Local commit B on top of A (not pushed).
		const shaB = writeAndCommit(repoDir, "local.txt", "local commit B\n", "commit B local only");
		// Origin advances to a DIFFERENT commit C on top of A → local and origin have diverged.
		const shaC = pushExtraOriginCommit(root, remoteDir, goalBranch, "origin.txt", "origin commit C\n", "commit C on origin");
		assert.notEqual(shaB, shaC, "fixture precondition: B and C must differ");
		assert.notEqual(shaB, shaA, "fixture precondition: B must differ from A");

		const { head, warnings } = await runVerificationCapturingWarnings(harness, signal, repoDir, goalBranch);

		assert.equal(
			head,
			shaB,
			`NONDESTRUCTIVE_SYNC_REPRO: diverged local commit B was discarded by pre-verification reset (HEAD=${head} expected ${shaB}, origin tip C=${shaC})`,
		);
		assert.match(
			warnings,
			/diverged/i,
			`diverged sync must surface a visible warning that local commits were kept (diverged-kept-local); warnings:\n${warnings}`,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("local-behind fast-forward does NOT execute repo-local git hooks (reset --hard, not merge --ff-only)", async () => {
	const { root, repoDir, remoteDir, goalBranch, shaA } = repoFixtures[3]!;
	const { harness, signal } = makeHarnessFixture("origin/master");
	try {
		// Install an executable post-merge hook that writes a sentinel. `git merge
		// --ff-only` would run this hook (local code-execution vector); `git reset
		// --hard` must NOT. On Windows the hook runs under Git Bash via the shebang.
		const hooksDir = path.join(repoDir, ".git", "hooks");
		fs.mkdirSync(hooksDir, { recursive: true });
		const hookPath = path.join(hooksDir, "post-merge");
		const sentinelPath = path.join(root, "post-merge-hook-sentinel.txt");
		const sentinelForShell = sentinelPath.replace(/\\/g, "/");
		fs.writeFileSync(hookPath, `#!/bin/sh\necho ran > "${sentinelForShell}"\n`);
		fs.chmodSync(hookPath, 0o755);

		// Advance origin ahead with commit C; local stays at A (behind → fast-forward).
		const shaC = pushExtraOriginCommit(root, remoteDir, goalBranch, "feature.txt", "commit A\ncommit C (origin)\n", "commit C on origin");
		assert.equal(git(repoDir, ["rev-parse", "HEAD"]), shaA, "fixture precondition: local still at A before sync");

		const { head } = await runVerificationCapturingWarnings(harness, signal, repoDir, goalBranch);

		assert.equal(
			head,
			shaC,
			`fast-forward must advance HEAD to origin tip C (HEAD=${head} expected ${shaC})`,
		);
		assert.equal(
			fs.existsSync(sentinelPath),
			false,
			`SYNC_RAN_GIT_HOOK: pre-verification fast-forward executed a repo-local post-merge hook (sentinel written at ${sentinelPath}) — sync must use "git reset --hard", which does not run hooks`,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("up-to-date goal worktree: sync leaves HEAD unchanged when local == origin", async () => {
	const { root, repoDir, goalBranch, shaA } = repoFixtures[4]!;
	const { harness, signal } = makeHarnessFixture("origin/master");
	try {
		// Local HEAD == origin/<goalBranch> == A.
		assert.equal(git(repoDir, ["rev-parse", "HEAD"]), shaA, "fixture precondition: local at A");

		const { head, warnings } = await runVerificationCapturingWarnings(harness, signal, repoDir, goalBranch);

		assert.equal(head, shaA, `up-to-date sync must leave HEAD at A (HEAD=${head} expected ${shaA})`);
		assert.doesNotMatch(
			warnings,
			/diverged|Failed to sync worktree/i,
			`up-to-date sync must not emit divergence/sync-failure warnings:\n${warnings}`,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
