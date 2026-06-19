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
