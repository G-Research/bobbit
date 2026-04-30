/**
 * Fixture-based parity tests for `runBatchGitStatusNative`. Each test
 * bootstraps a real git repo in `os.tmpdir()` via `execFileSync("git", [...])`
 * and asserts every field of the `GitStatusResult` shape matches the legacy
 * bash-script behavior.
 *
 * Run with: `node --test --test-force-exit` via tsx (see package.json
 * `test:unit`). Each fixture is created in a `before` hook and cleaned up in
 * `after`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBatchGitStatusNative } from "../src/server/skills/git-status-native.ts";

function rmDir(p: string): void {
	try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", windowsHide: true }).trim();
}

function makeFixtureDir(name: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-git-status-${name}-`));
	return root;
}

function initRepo(cwd: string, branch = "master"): void {
	git(cwd, "init", "-q");
	git(cwd, "config", "user.email", "test@example.com");
	git(cwd, "config", "user.name", "Test");
	git(cwd, "config", "commit.gpgsign", "false");
	// Force the initial branch name regardless of git's `init.defaultBranch`.
	git(cwd, "checkout", "-q", "-b", branch);
}

function commit(cwd: string, file: string, content: string, message: string): string {
	fs.writeFileSync(path.join(cwd, file), content);
	git(cwd, "add", file);
	git(cwd, "commit", "-q", "-m", message);
	return git(cwd, "rev-parse", "HEAD");
}

describe("runBatchGitStatusNative — fixtures", () => {
	const cleanup: string[] = [];
	after(() => { for (const d of cleanup) rmDir(d); });

	it("clean repo on master, no remote", async () => {
		const cwd = makeFixtureDir("clean");
		cleanup.push(cwd);
		initRepo(cwd, "master");
		commit(cwd, "README.md", "hello\n", "init");

		const r = await runBatchGitStatusNative(cwd);
		assert.ok(r, "result not null");
		assert.equal(r!.branch, "master");
		assert.equal(r!.primaryBranch, "master");
		assert.equal(r!.isOnPrimary, true);
		assert.deepStrictEqual(r!.status, []);
		assert.equal(r!.hasUpstream, false);
		assert.equal(r!.ahead, 0);
		assert.equal(r!.behind, 0);
		assert.equal(r!.aheadOfPrimary, 0);
		assert.equal(r!.behindPrimary, 0);
		// On primary, mergedIntoPrimary stays default-false (parity with legacy).
		assert.equal(r!.mergedIntoPrimary, false);
		assert.equal(r!.clean, true);
		assert.equal(r!.summary, "clean");
		// hasUpstream=false → unpushed=!mergedIntoPrimary=true
		assert.equal(r!.unpushed, true);
		assert.equal(r!.partial, false);
		assert.equal(r!.untrackedIncluded, false);
	});

	it("dirty: tracked-modified + untracked, untracked=false omits untracked", async () => {
		const cwd = makeFixtureDir("dirty");
		cleanup.push(cwd);
		initRepo(cwd, "master");
		commit(cwd, "tracked.txt", "v1\n", "init");
		fs.writeFileSync(path.join(cwd, "tracked.txt"), "v2\n");
		fs.writeFileSync(path.join(cwd, "untracked.txt"), "new\n");

		const rNoUntracked = await runBatchGitStatusNative(cwd, { untracked: false });
		assert.ok(rNoUntracked);
		assert.equal(rNoUntracked!.untrackedIncluded, false);
		// -uno hides the untracked file → only the modified tracked file shows
		assert.equal(rNoUntracked!.status.length, 1);
		assert.equal(rNoUntracked!.status[0].file, "tracked.txt");
		assert.equal(rNoUntracked!.status[0].status, "M");
		assert.equal(rNoUntracked!.clean, false);
		assert.equal(rNoUntracked!.summary, "1M");

		const rUntracked = await runBatchGitStatusNative(cwd, { untracked: true });
		assert.ok(rUntracked);
		assert.equal(rUntracked!.untrackedIncluded, true);
		assert.equal(rUntracked!.status.length, 2);
		assert.equal(rUntracked!.clean, false);
		// Summary is "1? 1M" or "1M 1?" depending on Object.entries order;
		// just check both buckets are present.
		assert.match(rUntracked!.summary, /1\?/);
		assert.match(rUntracked!.summary, /1M/);
	});

	it("feature branch, no upstream, primary detected as master", async () => {
		const cwd = makeFixtureDir("no-upstream");
		cleanup.push(cwd);
		initRepo(cwd, "master");
		commit(cwd, "a.txt", "a\n", "init");
		git(cwd, "checkout", "-q", "-b", "feature/x");

		const r = await runBatchGitStatusNative(cwd);
		assert.ok(r);
		assert.equal(r!.branch, "feature/x");
		assert.equal(r!.primaryBranch, "master");
		assert.equal(r!.isOnPrimary, false);
		assert.equal(r!.hasUpstream, false);
		assert.equal(r!.ahead, 0);
		assert.equal(r!.behind, 0);
		// No commits since branching from master → aheadOfPrimary=0
		assert.equal(r!.aheadOfPrimary, 0);
		assert.equal(r!.behindPrimary, 0);
		assert.equal(r!.mergedIntoPrimary, true);
		assert.equal(r!.clean, true);
		// hasUpstream=false → unpushed=!mergedIntoPrimary=false
		assert.equal(r!.unpushed, false);
	});

	it("detached HEAD: branch === 'HEAD'", async () => {
		const cwd = makeFixtureDir("detached");
		cleanup.push(cwd);
		initRepo(cwd, "master");
		const sha = commit(cwd, "a.txt", "a\n", "init");
		commit(cwd, "b.txt", "b\n", "second");
		git(cwd, "checkout", "-q", sha);

		const r = await runBatchGitStatusNative(cwd);
		assert.ok(r);
		assert.equal(r!.branch, "HEAD");
		assert.equal(r!.primaryBranch, "master");
		assert.equal(r!.isOnPrimary, false);
		assert.equal(r!.hasUpstream, false);
		// rev-list against pref still works → counts may be non-zero, but
		// the field shape is what we assert here.
		assert.equal(typeof r!.aheadOfPrimary, "number");
		assert.equal(typeof r!.behindPrimary, "number");
	});

	it("master and main both present, on master, primaryBranch=master", async () => {
		const cwd = makeFixtureDir("master-and-main");
		cleanup.push(cwd);
		initRepo(cwd, "master");
		commit(cwd, "a.txt", "a\n", "init");
		git(cwd, "branch", "main");
		// stay on master

		const r = await runBatchGitStatusNative(cwd);
		assert.ok(r);
		assert.equal(r!.branch, "master");
		// Fallback chain: no origin/HEAD → master exists → primaryBranch=master.
		assert.equal(r!.primaryBranch, "master");
		assert.equal(r!.isOnPrimary, true);
	});

	it("only main exists (no master), no origin/HEAD → primaryBranch=main", async () => {
		const cwd = makeFixtureDir("main-only");
		cleanup.push(cwd);
		initRepo(cwd, "main");
		commit(cwd, "a.txt", "a\n", "init");

		const r = await runBatchGitStatusNative(cwd);
		assert.ok(r);
		assert.equal(r!.branch, "main");
		assert.equal(r!.primaryBranch, "main");
		assert.equal(r!.isOnPrimary, true);
	});

	it("with-upstream-ahead: 2 commits past origin/master via local bare remote", async () => {
		const remote = makeFixtureDir("upstream-ahead-remote");
		cleanup.push(remote);
		// Create a bare repo to act as 'origin'.
		execFileSync("git", ["init", "-q", "--bare"], { cwd: remote, windowsHide: true });

		const cwd = makeFixtureDir("upstream-ahead");
		cleanup.push(cwd);
		initRepo(cwd, "master");
		commit(cwd, "a.txt", "a\n", "init");
		git(cwd, "remote", "add", "origin", remote);
		git(cwd, "push", "-q", "-u", "origin", "master");
		commit(cwd, "b.txt", "b\n", "second");
		commit(cwd, "c.txt", "c\n", "third");

		const r = await runBatchGitStatusNative(cwd);
		assert.ok(r);
		assert.equal(r!.branch, "master");
		assert.equal(r!.hasUpstream, true);
		assert.equal(r!.ahead, 2);
		assert.equal(r!.behind, 0);
		assert.equal(r!.unpushed, true);
	});

	it("returns null for non-git directory", async () => {
		const cwd = makeFixtureDir("not-a-repo");
		cleanup.push(cwd);
		const r = await runBatchGitStatusNative(cwd);
		assert.equal(r, null);
	});
});
