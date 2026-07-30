import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	FixtureCommandError,
	runFixtureCommand,
	runFixtureCommandWithBackend,
	type FixtureCommandBackend,
	type FixtureCommandProcess,
} from "../harness/spawn-with-retry.js";

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

	it("accepts an exit-zero close that races the timeout without cleanup or retry", async () => {
		let fireTimeout: (() => void) | undefined;
		let close: ((exitCode: number | null, signal: NodeJS.Signals | null) => void) | undefined;
		let cleanupCalls = 0;
		let spawnCalls = 0;
		const backend: FixtureCommandBackend = {
			spawn() {
				spawnCalls += 1;
				return {
					onStdout() {},
					onStderr() {},
					onError() {},
					onClose(listener) { close = listener; },
					kill() {},
				};
			},
			schedule(callback) {
				fireTimeout = callback;
				return { cancel() {}, unref() {} };
			},
			async sleep() {},
		};

		const command = runFixtureCommandWithBackend("git", ["commit"], {
			attempts: 2,
			timeoutMs: 100,
			onTimedOutAttemptClosed: () => { cleanupCalls += 1; },
		}, backend);
		await Promise.resolve();
		fireTimeout!();
		close!(0, null);

		await expect(command).resolves.toMatchObject({ attempts: 1, exitCode: 0 });
		expect(spawnCalls).toBe(1);
		expect(cleanupCalls).toBe(0);
	});

	it("waits for close and wraps cleanup-hook errors with secret redaction", async () => {
		const secret = "cleanup-hook-secret";
		let fireTimeout: (() => void) | undefined;
		let close: ((exitCode: number | null, signal: NodeJS.Signals | null) => void) | undefined;
		let cleanupCalls = 0;
		let settled = false;
		const process: FixtureCommandProcess = {
			onStdout() {},
			onStderr(listener) { listener(secret); },
			onError() {},
			onClose(listener) { close = listener; },
			kill() {},
		};
		const backend: FixtureCommandBackend = {
			spawn: () => process,
			schedule(callback) {
				fireTimeout = callback;
				return { cancel() {}, unref() {} };
			},
			async sleep() { throw new Error("cleanup failure must suppress retry sleep"); },
		};

		const command = runFixtureCommandWithBackend("git", ["commit", secret], {
			attempts: 2,
			timeoutMs: 100,
			redact: [secret],
			onTimedOutAttemptClosed: () => {
				cleanupCalls += 1;
				throw new Error(`cleanup rejected ${secret}`);
			},
		}, backend);
		void command.then(() => { settled = true; }, () => { settled = true; });
		await Promise.resolve();
		fireTimeout!();
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(cleanupCalls).toBe(0);

		close!(null, "SIGKILL");
		const error = await fixtureError(command);
		expect(error.attempts).toBe(1);
		expect(error.timedOut).toBe(true);
		expect(error.message).toContain("timed-out attempt cleanup failed");
		expect(error.message).toContain("[REDACTED]");
		expect(error.message).not.toContain(secret);
		expect(error.stderr).toBe("[REDACTED]");
		expect(cleanupCalls).toBe(1);
	});
});
