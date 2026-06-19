import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { resolveWorktreeSupport } from "../src/server/agent/worktree-support.js";
import { WorktreePool } from "../src/server/agent/worktree-pool.js";
import { createWorktree } from "../src/server/skills/git.js";
import { makeTmpDir } from "./helpers/tmp.js";

const execFile = promisify(execFileCb);

async function initRepo(repo: string): Promise<void> {
	fs.mkdirSync(repo, { recursive: true });
	await execFile("git", ["init", "--initial-branch=master"], { cwd: repo });
	await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repo });
	await execFile("git", ["config", "user.name", "Test User"], { cwd: repo });
}

async function makeUnbornRepo(): Promise<{ root: string; repo: string }> {
	const root = makeTmpDir("bobbit-unborn-head-");
	const repo = path.join(root, "repo");
	await initRepo(repo);
	return { root, repo };
}

async function makeCommittedRepo(): Promise<{ root: string; repo: string }> {
	const out = await makeUnbornRepo();
	fs.writeFileSync(path.join(out.repo, "README.md"), "initial\n");
	await execFile("git", ["add", "README.md"], { cwd: out.repo });
	await execFile("git", ["commit", "-m", "initial"], { cwd: out.repo });
	return out;
}

async function makeUnbornRepoWithFetchedOriginMain(): Promise<{ root: string; repo: string; mainSha: string }> {
	const root = makeTmpDir("bobbit-unborn-head-base-ref-");
	const seed = path.join(root, "seed");
	const origin = path.join(root, "origin.git");
	const repo = path.join(root, "repo");

	await initRepo(seed);
	await execFile("git", ["checkout", "-b", "main"], { cwd: seed });
	fs.writeFileSync(path.join(seed, "README.md"), "origin main\n");
	await execFile("git", ["add", "README.md"], { cwd: seed });
	await execFile("git", ["commit", "-m", "origin main"], { cwd: seed });
	const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: seed });
	const mainSha = stdout.trim();

	await execFile("git", ["init", "--bare", origin], { cwd: root });
	await execFile("git", ["remote", "add", "origin", origin], { cwd: seed });
	await execFile("git", ["push", "origin", "main"], { cwd: seed });

	await initRepo(repo);
	await execFile("git", ["remote", "add", "origin", origin], { cwd: repo });
	await execFile("git", ["fetch", "origin", "main"], { cwd: repo });
	return { root, repo, mainSha };
}

function rmRoot(root: string): void {
	try {
		fs.rmSync(root, { recursive: true, force: true });
	} catch {
		// best effort cleanup only
	}
}

function stringifyConsoleArg(arg: unknown): string {
	if (arg instanceof Error) return arg.message;
	return typeof arg === "string" ? arg : JSON.stringify(arg);
}

async function fillPoolOnce(pool: WorktreePool): Promise<void> {
	await (pool as unknown as { _fill(): Promise<void> })._fill();
}

describe("unborn HEAD worktree fallback regressions", () => {
	const originalNoPush = process.env.BOBBIT_TEST_NO_PUSH;
	const originalSkipNpm = process.env.BOBBIT_SKIP_NPM_CI;

	before(() => {
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		process.env.BOBBIT_SKIP_NPM_CI = "1";
	});

	after(() => {
		if (originalNoPush === undefined) delete process.env.BOBBIT_TEST_NO_PUSH;
		else process.env.BOBBIT_TEST_NO_PUSH = originalNoPush;
		if (originalSkipNpm === undefined) delete process.env.BOBBIT_SKIP_NPM_CI;
		else process.env.BOBBIT_SKIP_NPM_CI = originalSkipNpm;
	});

	it("classifies a fresh git init repo with unresolved HEAD as unsupported for worktrees", async () => {
		const { root, repo } = await makeUnbornRepo();
		try {
			const support = await resolveWorktreeSupport([{ name: "root", repo: "." }], repo, repo);
			assert.deepEqual(
				support,
				{ supported: false, multiRepo: false },
				"unborn local-only repositories should fall back to no-worktree until an initial commit exists",
			);
		} finally {
			rmRoot(root);
		}
	});

	it("does not expose raw git invalid-reference stderr when createWorktree is called for an unborn repo", async () => {
		const { root, repo } = await makeUnbornRepo();
		try {
			await assert.rejects(
				() => createWorktree(repo, "session/unborn-head", { skipPush: true }),
				(err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					assert.match(
						message,
						/(initial commit|unborn|unresolved HEAD|enable worktrees)/i,
						`unborn HEAD worktree errors must be actionable; got:\n${message}`,
					);
					assert.doesNotMatch(
						message,
						/fatal:\s*invalid reference:?\s*HEAD/i,
						`raw git invalid-reference stderr must not be the primary worktree error; got:\n${message}`,
					);
					return true;
				},
			);
		} finally {
			rmRoot(root);
		}
	});

	it("allows an unborn repo to use a valid configured base_ref instead of requiring local HEAD", async () => {
		const { root, repo, mainSha } = await makeUnbornRepoWithFetchedOriginMain();
		try {
			const support = await resolveWorktreeSupport([{ name: "root", repo: "." }], repo, repo, undefined, { configuredBaseRef: "origin/main" });
			assert.equal(support.supported, true);
			assert.equal(path.normalize(support.repoPath ?? ""), path.normalize(repo));

			const result = await createWorktree(repo, "session/configured-base", { skipPush: true, configuredBaseRef: "origin/main" });
			const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: result.worktreePath });
			assert.equal(stdout.trim(), mainSha, "configured base_ref should drive the worktree start point");
		} finally {
			rmRoot(root);
		}
	});

	it("surfaces stale configured base_ref errors for unborn repos instead of falling back to no-worktree", async () => {
		const { root, repo } = await makeUnbornRepo();
		try {
			const support = await resolveWorktreeSupport([{ name: "root", repo: "." }], repo, repo, undefined, { configuredBaseRef: "origin/missing" });
			assert.equal(support.supported, true, "support checks must let createWorktree surface the configured-base error");

			await assert.rejects(
				() => createWorktree(repo, "session/stale-configured-base", { skipPush: true, configuredBaseRef: "origin/missing" }),
				(err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					assert.match(message, /base_ref 'origin\/missing' no longer exists/i);
					assert.doesNotMatch(message, /(initial commit|unborn|unresolved HEAD|invalid reference:?\s*HEAD)/i);
					return true;
				},
			);
		} finally {
			rmRoot(root);
		}
	});

	it("skips unborn repos during worktree pool prefill without logging raw invalid-reference failures", async () => {
		const { root, repo } = await makeUnbornRepo();
		const originalError = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map(stringifyConsoleArg).join(" "));
		};
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 1 });
			await fillPoolOnce(pool);
			assert.equal(pool.size, 0, "unborn repo pool should remain empty instead of creating a broken worktree");
			assert.equal(
				errors.some(line => /fatal:\s*invalid reference:?\s*HEAD/i.test(line)),
				false,
				`pool prefill must not log raw invalid-reference stderr for unborn repos; errors:\n${errors.join("\n")}`,
			);
		} finally {
			console.error = originalError;
			rmRoot(root);
		}
	});

	it("still creates worktrees for local-only repos after an initial commit", async () => {
		const { root, repo } = await makeCommittedRepo();
		try {
			const support = await resolveWorktreeSupport([{ name: "root", repo: "." }], repo, repo);
			assert.equal(support.supported, true);
			assert.equal(path.normalize(support.repoPath ?? ""), path.normalize(repo));
			assert.equal(support.multiRepo, false);

			const result = await createWorktree(repo, "session/committed-head", { skipPush: true });
			assert.equal(result.branchName, "session/committed-head");
			assert.ok(fs.existsSync(path.join(result.worktreePath, ".git")), "worktree should exist for committed local-only repo");
		} finally {
			rmRoot(root);
		}
	});
});
