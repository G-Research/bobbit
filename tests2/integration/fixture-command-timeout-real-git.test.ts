import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FixtureCommandError, runFixtureCommand } from "../harness/spawn-with-retry.js";

const roots: string[] = [];
const gitEnv: NodeJS.ProcessEnv = {
	...process.env,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
	GIT_EDITOR: "true",
	GIT_AUTHOR_NAME: "Bobbit Timeout Test",
	GIT_AUTHOR_EMAIL: "bobbit-timeout@example.invalid",
	GIT_COMMITTER_NAME: "Bobbit Timeout Test",
	GIT_COMMITTER_EMAIL: "bobbit-timeout@example.invalid",
};

const commitThenHangOnce = String.raw`
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const repository = process.argv[1];
const attemptLog = process.argv[2];
const priorAttempts = existsSync(attemptLog)
  ? readFileSync(attemptLog, "utf8").trim().split(/\s+/).filter(Boolean).length
  : 0;
const commit = spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initial fixture"], {
  cwd: repository,
  env: process.env,
  stdio: "ignore",
});
appendFileSync(attemptLog, String(commit.status) + "\n", "utf8");
if (priorAttempts === 0) setInterval(() => {}, 1_000);
else process.exit(commit.status == null ? 1 : commit.status);
`;

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
	}
});

async function populate(repository: string): Promise<void> {
	mkdirSync(repository);
	await runFixtureCommand("git", ["-c", "init.defaultBranch=master", "init", "--quiet", repository], {
		cwd: repository,
		env: gitEnv,
		attempts: 1,
	});
	writeFileSync(join(repository, "README.md"), "fixture\n", "utf8");
	await runFixtureCommand("git", ["add", "--", "README.md"], { cwd: repository, env: gitEnv, attempts: 1 });
}

async function fixtureError(command: Promise<unknown>): Promise<FixtureCommandError> {
	try {
		await command;
		throw new Error("expected fixture command to fail");
	} catch (error) {
		expect(error).toBeInstanceOf(FixtureCommandError);
		return error as FixtureCommandError;
	}
}

describe("fixture command timeout races on real Git", () => {
	it("observes the code-1 blind-retry race, then recreates the private attempt before retrying", async () => {
		const root = mkdtempSync(join(tmpdir(), "bb-fixture-timeout-race-"));
		roots.push(root);
		const repository = join(root, "repo");
		const attemptLog = join(root, "attempts.log");
		await populate(repository);

		let blindRetryExitCode: number | null | undefined;
		const result = await runFixtureCommand(process.execPath, ["-e", commitThenHangOnce, repository, attemptLog], {
			env: gitEnv,
			timeoutMs: 5_000,
			attempts: 2,
			retryDelayMs: 0,
			onTimedOutAttemptClosed: async () => {
				const blindRetry = await fixtureError(runFixtureCommand(
					"git",
					["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initial fixture"],
					{ cwd: repository, env: gitEnv, attempts: 1 },
				));
				blindRetryExitCode = blindRetry.exitCode;

				// This is the safe policy used by git-template.ts: discard all state from
				// the closed, uncertain attempt and rebuild at the same private path.
				rmSync(repository, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
				await populate(repository);
			},
		});

		expect(blindRetryExitCode).toBe(1);
		expect(result).toMatchObject({ attempts: 2, exitCode: 0 });
		expect(readFileSync(attemptLog, "utf8").trim().split(/\s+/)).toEqual(["0", "0"]);
	});
});
