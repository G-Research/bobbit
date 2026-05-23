/**
 * Reproducing regressions for goal/session branch push safety.
 *
 * These tests intentionally fail on the vulnerable code path:
 * - claiming a pool worktree preserves `origin/master` as the renamed branch upstream
 * - the canonical ready-to-merge push step can update `origin/master` when the
 *   local goal branch tracks `origin/master` and `push.default=upstream`
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { WorktreePool } from "../src/server/agent/worktree-pool.ts";
import {
	buildDefaultWorkflows,
	readyToMergeGate,
	type SeededVerifyStep,
} from "../src/server/state-migration/seed-default-workflows.ts";
import {
	PROJECT_ASSISTANT_PROMPT,
	PROJECT_ASSISTANT_SCAFFOLDING_PROMPT,
} from "../src/server/agent/project-assistant.ts";

const execFile = promisify(execFileCb);
const SAFE_BRANCH_REFSPEC = "{{branch}}:refs/heads/{{branch}}";
const BARE_BRANCH_PUSH = /git push origin \{\{branch\}\}(?!:)/;

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd });
	return stdout.trim();
}

async function gitMaybe(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; output: string }> {
	try {
		return { ok: true, stdout: await git(cwd, args) };
	} catch (err) {
		const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
		return {
			ok: false,
			output: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`,
		};
	}
}

async function makeRemoteBackedRepo(): Promise<{ root: string; repo: string; origin: string }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-goal-push-safety-"));
	const repo = path.join(root, "repo");
	const origin = path.join(root, "origin.git");

	await git(root, ["init", "--bare", "--initial-branch=master", origin]);
	await git(root, ["init", "--initial-branch=master", repo]);
	await git(repo, ["config", "user.email", "test@test"]);
	await git(repo, ["config", "user.name", "Test"]);
	await git(repo, ["config", "core.autocrlf", "false"]);
	fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
	await git(repo, ["add", "file.txt"]);
	await git(repo, ["commit", "-m", "initial"]);
	await git(repo, ["remote", "add", "origin", origin]);
	await git(repo, ["push", "-u", "origin", "master"]);
	await git(repo, ["remote", "set-head", "origin", "master"]);

	return { root, repo, origin };
}

async function remoteRef(root: string, origin: string, ref: string): Promise<string | null> {
	const result = await gitMaybe(root, ["--git-dir", origin, "rev-parse", "--verify", ref]);
	return result.ok ? result.stdout : null;
}

async function upstream(cwd: string): Promise<string | null> {
	const result = await gitMaybe(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	return result.ok ? result.stdout : null;
}

function cleanup(root: string): void {
	try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

async function cleanupAfterPoolFreshen(root: string): Promise<void> {
	// claim() starts a fire-and-forget local fetch/reset. Give it a brief chance
	// to finish before removing the fixture so failure output stays focused on
	// the upstream regression rather than a deleted temporary origin.
	await new Promise(resolve => setTimeout(resolve, 500));
	cleanup(root);
}

function branchPushStep(steps: SeededVerifyStep[] | undefined): string {
	const step = steps?.find((s) => s.type === "command" && typeof s.run === "string" && s.run.includes("git push origin"));
	assert.ok(step?.run, "ready-to-merge gate must include a git push command step");
	return step.run;
}

function pushArgsFromTemplate(template: string, branch: string): string[] {
	const pushCommand = template.replaceAll("{{branch}}", branch).split("&&", 1)[0].trim();
	assert.match(pushCommand, /^git push origin\b/, `expected a git push origin command, got: ${pushCommand}`);
	return pushCommand.split(/\s+/).slice(1);
}

function assertSafeBranchPushTemplate(label: string, template: string): void {
	assert.ok(
		template.includes(SAFE_BRANCH_REFSPEC),
		`${label} must push with explicit destination refspec ${SAFE_BRANCH_REFSPEC}; got: ${template}`,
	);
	assert.doesNotMatch(
		template,
		BARE_BRANCH_PUSH,
		`${label} must not use bare git push origin {{branch}} because upstream config can target origin/master`,
	);
}

describe("goal/session branch push safety regressions", () => {
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

	it("claiming a pool branch must not preserve an inherited origin/master upstream", async () => {
		const { root, repo } = await makeRemoteBackedRepo();
		try {
			const poolBranch = "pool/_pool-upstream";
			const poolWorktree = path.join(root, "repo-wt", "pool-_pool-upstream");
			await git(repo, ["worktree", "add", "-b", poolBranch, poolWorktree, "origin/master"]);
			await git(poolWorktree, ["branch", "--set-upstream-to=origin/master", poolBranch]);
			assert.equal(await upstream(poolWorktree), "origin/master", "fixture must start with an inherited origin/master upstream");

			const pool = new WorktreePool({ repoPath: repo, targetSize: 0 });
			pool.registerExternalEntry(poolBranch, poolWorktree);

			const claim = await pool.claim("goal/foo");
			assert.ok(claim, "pool claim should succeed");

			const claimedUpstream = await upstream(claim!.worktreePath);
			assert.ok(
				claimedUpstream === null || claimedUpstream === "origin/goal/foo",
				`Claimed branch must track origin/goal/foo or have no upstream; actual upstream: ${claimedUpstream ?? "<none>"}`,
			);
		} finally {
			await cleanupAfterPoolFreshen(root);
		}
	});

	it("canonical ready-to-merge push must not update origin/master from a goal branch", async () => {
		const template = branchPushStep(readyToMergeGate().verify);
		const { root, repo, origin } = await makeRemoteBackedRepo();
		try {
			const masterBefore = await remoteRef(root, origin, "refs/heads/master");
			assert.ok(masterBefore, "fixture must create origin/master");

			await git(repo, ["checkout", "-b", "goal/foo"]);
			fs.appendFileSync(path.join(repo, "file.txt"), "goal change\n");
			await git(repo, ["commit", "-am", "goal change"]);
			const goalSha = await git(repo, ["rev-parse", "HEAD"]);
			await git(repo, ["branch", "--set-upstream-to=origin/master", "goal/foo"]);
			await git(repo, ["config", "push.default", "upstream"]);

			await git(repo, pushArgsFromTemplate(template, "goal/foo"));

			const masterAfter = await remoteRef(root, origin, "refs/heads/master");
			assert.equal(
				masterAfter,
				masterBefore,
				`Ready-to-merge branch push must not update origin/master; command template was: ${template}`,
			);
			assert.equal(
				await remoteRef(root, origin, "refs/heads/goal/foo"),
				goalSha,
				"ready-to-merge push must publish the goal branch at refs/heads/goal/foo",
			);
		} finally {
			cleanup(root);
		}
	});

	it("server branch publish helper uses shell-free git argv refspecs", () => {
		const source = fs.readFileSync(new URL("../src/server/server.ts", import.meta.url), "utf-8");
		assert.match(source, /execFileAsync\("git", args, \{ cwd, encoding: "utf-8", timeout \}\)/);
		assert.match(source, /push: \["push", "origin", `HEAD:refs\/heads\/\$\{branch\}`\]/);
		assert.match(source, /fetchRemoteTracking: \["fetch", "origin", `refs\/heads\/\$\{branch\}:refs\/remotes\/origin\/\$\{branch\}`\]/);
		assert.match(source, /setUpstream: \["branch", `--set-upstream-to=origin\/\$\{branch\}`, branch\]/);
		assert.doesNotMatch(source, /function shellQuote|safeBranchPublishCommand/);
	});

	it("canonical seeded ready-to-merge gates use explicit branch refspecs", () => {
		assertSafeBranchPushTemplate("readyToMergeGate()", branchPushStep(readyToMergeGate().verify));

		for (const [workflowId, workflow] of Object.entries(buildDefaultWorkflows("app"))) {
			const gate = workflow.gates.find((g) => g.id === "ready-to-merge");
			assert.ok(gate, `${workflowId} workflow must have ready-to-merge gate`);
			assertSafeBranchPushTemplate(`${workflowId}.ready-to-merge`, branchPushStep(gate!.verify));
		}
	});

	it("project-assistant workflow prompts teach explicit branch refspecs", () => {
		for (const [label, prompt] of [
			["PROJECT_ASSISTANT_PROMPT", PROJECT_ASSISTANT_PROMPT],
			["PROJECT_ASSISTANT_SCAFFOLDING_PROMPT", PROJECT_ASSISTANT_SCAFFOLDING_PROMPT],
		] as const) {
			assert.ok(
				prompt.includes(SAFE_BRANCH_REFSPEC),
				`${label} must teach explicit ready-to-merge branch push refspec ${SAFE_BRANCH_REFSPEC}`,
			);
			assert.doesNotMatch(
				prompt,
				BARE_BRANCH_PUSH,
				`${label} must not recommend bare git push origin {{branch}}`,
			);
		}
	});
});
