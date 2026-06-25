import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { WorktreePool } from "../src/server/agent/worktree-pool.ts";
import { createWorktree, createWorktreeSet } from "../src/server/skills/git.ts";

const execFile = promisify(execFileCb);

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd });
	return stdout.trim();
}

async function gitMaybe(cwd: string, args: string[]): Promise<string | null> {
	try {
		return await git(cwd, args);
	} catch {
		return null;
	}
}

async function findGitExecutable(): Promise<string> {
	if (process.platform === "win32") {
		const { stdout } = await execFile("where", ["git"]);
		const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
		assert.ok(first, "where git should return an executable path");
		return first;
	}
	const { stdout } = await execFile("sh", ["-c", "command -v git"]);
	return stdout.trim();
}

function shQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function withGitCommandLog<T>(fn: () => Promise<T>): Promise<{ result: T; commands: string[] }> {
	const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-git-wrapper-"));
	const logFile = path.join(wrapperDir, "git-commands.log");
	const realGit = await findGitExecutable();
	if (process.platform === "win32") {
		fs.writeFileSync(path.join(wrapperDir, "git.cmd"), `@echo off\r\necho %*>>"${logFile}"\r\n"${realGit}" %*\r\n`);
	} else {
		const wrapper = path.join(wrapperDir, "git");
		fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shQuote(logFile)}\nexec ${shQuote(realGit)} "$@"\n`);
		fs.chmodSync(wrapper, 0o755);
	}

	const originalPath = process.env.PATH;
	process.env.PATH = `${wrapperDir}${path.delimiter}${originalPath ?? ""}`;
	try {
		const result = await fn();
		const commands = fs.existsSync(logFile)
			? fs.readFileSync(logFile, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
			: [];
		return { result, commands };
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		fs.rmSync(wrapperDir, { recursive: true, force: true });
	}
}

async function makeRemoteBackedRepo(): Promise<{ root: string; repo: string; origin: string }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-local-push-policy-"));
	const repo = path.join(root, "repo");
	const origin = path.join(root, "origin.git");

	await git(root, ["init", "--bare", "--initial-branch=master", origin]);
	await git(root, ["init", "--initial-branch=master", repo]);
	await git(repo, ["config", "user.email", "test@test"]);
	await git(repo, ["config", "user.name", "Test"]);
	fs.writeFileSync(path.join(repo, "README.md"), "base\n");
	await git(repo, ["add", "README.md"]);
	await git(repo, ["commit", "-m", "initial"]);
	await git(repo, ["remote", "add", "origin", origin]);
	await git(repo, ["push", "-u", "origin", "master"]);
	await git(repo, ["remote", "set-head", "origin", "master"]);
	return { root, repo, origin };
}

async function remoteRef(root: string, origin: string, ref: string): Promise<string | null> {
	return await gitMaybe(root, ["--git-dir", origin, "rev-parse", "--verify", ref]);
}

async function upstream(cwd: string): Promise<string | null> {
	return await gitMaybe(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
}

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function cleanup(root: string): void {
	try {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		return;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
		// Git for Windows can briefly hold worktree files after command exit. The
		// assertions are already complete; avoid failing the test on best-effort
		// temp-dir cleanup when a scanner or lingering git handle races deletion.
		try {
			const deferred = `${root}-cleanup-${Date.now()}`;
			fs.renameSync(root, deferred);
			try { fs.rmSync(deferred, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); } catch { /* best-effort */ }
		} catch { /* best-effort */ }
	}
}

describe("host worktree push policy", () => {
	it("createWorktree local-only skips push, origin branch fetch, and origin branch upstream", async () => {
		const { root, repo, origin } = await makeRemoteBackedRepo();
		const originalNoPush = process.env.BOBBIT_TEST_NO_PUSH;
		delete process.env.BOBBIT_TEST_NO_PUSH;
		try {
			const branch = "session/local-only";
			const { result, commands } = await withGitCommandLog(() => createWorktree(repo, branch, {
				startPoint: "origin/master",
				pushPolicy: "local-only",
			}));

			assert.equal(await remoteRef(root, origin, `refs/heads/${branch}`), null, "local-only branch must not be published");
			if (commands.length > 0) {
				assert.ok(!commands.some((command) => command.startsWith("push ")), `local-only must not run git push; commands:\n${commands.join("\n")}`);
				assert.ok(
					!commands.includes(`fetch origin refs/heads/${branch}:refs/remotes/origin/${branch}`),
					`local-only must not fetch origin tracking ref for its own branch; commands:\n${commands.join("\n")}`,
				);
				assert.ok(
					!commands.includes(`branch --set-upstream-to=origin/${branch} ${branch}`),
					`local-only must not set upstream to origin/${branch}; commands:\n${commands.join("\n")}`,
				);
			}
			assert.notEqual(await upstream(result.worktreePath), `origin/${branch}`);
		} finally {
			restoreEnv("BOBBIT_TEST_NO_PUSH", originalNoPush);
			cleanup(root);
		}
	});

	it("createWorktree defaults to publish with a safe destination refspec", async () => {
		const { root, repo, origin } = await makeRemoteBackedRepo();
		const originalNoPush = process.env.BOBBIT_TEST_NO_PUSH;
		delete process.env.BOBBIT_TEST_NO_PUSH;
		try {
			const branch = "session/publish-default";
			const masterBefore = await remoteRef(root, origin, "refs/heads/master");
			assert.ok(masterBefore, "fixture must publish origin/master");

			const { result, commands } = await withGitCommandLog(() => createWorktree(repo, branch, {
				startPoint: "origin/master",
			}));

			if (commands.length > 0) {
				assert.ok(commands.includes(`push origin ${branch}:refs/heads/${branch}`), `publish must use explicit destination refspec; commands:\n${commands.join("\n")}`);
			}
			assert.ok(await remoteRef(root, origin, `refs/heads/${branch}`), "publish policy must create the remote branch");
			assert.equal(await remoteRef(root, origin, "refs/heads/master"), masterBefore, "publishing a worktree branch must not update origin/master");
			assert.equal(await upstream(result.worktreePath), `origin/${branch}`);
		} finally {
			restoreEnv("BOBBIT_TEST_NO_PUSH", originalNoPush);
			cleanup(root);
		}
	});

	it("BOBBIT_TEST_NO_PUSH suppresses publish even when pushPolicy is publish", async () => {
		const { root, repo, origin } = await makeRemoteBackedRepo();
		const originalNoPush = process.env.BOBBIT_TEST_NO_PUSH;
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		try {
			const branch = "session/no-push-env";
			const { commands } = await withGitCommandLog(() => createWorktree(repo, branch, {
				startPoint: "origin/master",
				pushPolicy: "publish",
			}));

			assert.equal(await remoteRef(root, origin, `refs/heads/${branch}`), null, "test no-push mode must not publish");
			if (commands.length > 0) {
				assert.ok(!commands.some((command) => command.startsWith("push ")), `test no-push mode must not run git push; commands:\n${commands.join("\n")}`);
			}
		} finally {
			restoreEnv("BOBBIT_TEST_NO_PUSH", originalNoPush);
			cleanup(root);
		}
	});

	it("worktree pool claim freshens without publishing the claimed branch", async () => {
		const { root, repo, origin } = await makeRemoteBackedRepo();
		const originalNoPush = process.env.BOBBIT_TEST_NO_PUSH;
		delete process.env.BOBBIT_TEST_NO_PUSH;
		try {
			const poolBranch = "pool/_pool-local-only-policy";
			const targetBranch = "session/pool-local-only";
			const poolWorktree = path.join(root, "repo-wt", "pool-_pool-local-only-policy");
			await git(repo, ["worktree", "add", "-b", poolBranch, poolWorktree, "origin/master"]);

			const pool = new WorktreePool({ repoPath: repo, targetSize: 0 });
			pool.registerExternalEntry(poolBranch, poolWorktree);

			const { result: claim, commands } = await withGitCommandLog(async () => {
				const claimed = await pool.claim(targetBranch);
				await new Promise(resolve => setTimeout(resolve, 700));
				return claimed;
			});

			assert.ok(claim, "pool claim should succeed");
			assert.equal(await remoteRef(root, origin, `refs/heads/${targetBranch}`), null, "pool freshen must not publish claimed branches");
			if (commands.length > 0) {
				assert.ok(!commands.some((command) => command.startsWith("push ")), `pool claim/freshen must not run git push; commands:\n${commands.join("\n")}`);
				assert.ok(
					!commands.includes(`branch --set-upstream-to=origin/${targetBranch} ${targetBranch}`),
					`pool claim/freshen must not set upstream to origin/${targetBranch}; commands:\n${commands.join("\n")}`,
				);
			}
		} finally {
			restoreEnv("BOBBIT_TEST_NO_PUSH", originalNoPush);
			cleanup(root);
		}
	});

	it("createWorktreeSet passes through publish policy and skipPush remains local-only", async () => {
		const { root, repo, origin } = await makeRemoteBackedRepo();
		const originalNoPush = process.env.BOBBIT_TEST_NO_PUSH;
		delete process.env.BOBBIT_TEST_NO_PUSH;
		try {
			const components = [{ name: "app", repo: "." }];
			const publishBranch = "set/publish";
			const skipBranch = "set/skip-push";

			const published = await withGitCommandLog(() => createWorktreeSet(repo, components, publishBranch, "origin/master", {
				pushPolicy: "publish",
			}));
			if (published.commands.length > 0) {
				assert.ok(
					published.commands.includes(`push origin ${publishBranch}:refs/heads/${publishBranch}`),
					`createWorktreeSet publish policy must reach createWorktree; commands:\n${published.commands.join("\n")}`,
				);
			}
			assert.ok(await remoteRef(root, origin, `refs/heads/${publishBranch}`), "publish policy must publish createWorktreeSet branch");

			const skipped = await withGitCommandLog(() => createWorktreeSet(repo, components, skipBranch, "origin/master", {
				pushPolicy: "publish",
				skipPush: true,
			}));
			assert.equal(await remoteRef(root, origin, `refs/heads/${skipBranch}`), null, "skipPush must map to local-only");
			if (skipped.commands.length > 0) {
				assert.ok(!skipped.commands.some((command) => command.startsWith("push ")), `skipPush must suppress git push; commands:\n${skipped.commands.join("\n")}`);
			}
		} finally {
			restoreEnv("BOBBIT_TEST_NO_PUSH", originalNoPush);
			cleanup(root);
		}
	});
});
