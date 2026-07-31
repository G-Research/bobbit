import { describe, expect, it } from "vitest";
import {
	FixtureCommandError,
	runFixtureCommandWithBackend,
	type FixtureCommandBackend,
	type FixtureCommandProcess,
} from "../harness/spawn-with-retry.js";

interface FakeOutcome {
	stdout?: string;
	stderr?: string;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	hang?: boolean;
	startError?: Error;
	onSpawn?: () => void;
}

function fakeBackend(outcomes: FakeOutcome[], fireTimers = false): {
	backend: FixtureCommandBackend;
	calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }>;
	sleeps: number[];
	stdin: string[];
} {
	const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
	const sleeps: number[] = [];
	const stdin: string[] = [];
	let attempt = 0;
	const backend: FixtureCommandBackend = {
		spawn(file, args, options) {
			const outcome = outcomes[attempt++] ?? outcomes.at(-1) ?? {};
			calls.push({ file, args: [...args], options });
			outcome.onSpawn?.();
			if (outcome.startError) throw outcome.startError;
			let close: ((exitCode: number | null, signal: NodeJS.Signals | null) => void) | undefined;
			let killed = false;
			const process: FixtureCommandProcess = {
				onStdout(listener) { if (outcome.stdout) listener(outcome.stdout); },
				onStderr(listener) { if (outcome.stderr) listener(outcome.stderr); },
				onError() {},
				onClose(listener) {
					close = listener;
					if (!outcome.hang) queueMicrotask(() => listener(outcome.exitCode ?? 0, outcome.signal ?? null));
				},
				endStdin(input) { stdin.push(input); },
				kill(signal) {
					if (killed) return true;
					killed = true;
					close?.(null, signal);
					return true;
				},
			};
			return process;
		},
		schedule(callback) {
			let cancelled = false;
			if (fireTimers) queueMicrotask(() => { if (!cancelled) callback(); });
			return {
				cancel: () => { cancelled = true; },
				unref: () => {},
			};
		},
		async sleep(delayMs) { sleeps.push(delayMs); },
	};
	return { backend, calls, sleeps, stdin };
}

function controlledBackend(options: {
	stderr?: string;
	killError?: Error;
	killThrows?: Error;
	killResult?: boolean;
} = {}): {
	backend: FixtureCommandBackend;
	fireTimeout(): void;
	fireTerminationGrace(): void;
	close(exitCode: number | null, signal: NodeJS.Signals | null): void;
	readonly spawnCalls: number;
	readonly killCalls: number;
	readonly sleeps: readonly number[];
	readonly scheduledDelays: readonly number[];
} {
	const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean; delayMs: number }> = [];
	let closeListener: ((exitCode: number | null, signal: NodeJS.Signals | null) => void) | undefined;
	let errorListener: ((cause: unknown) => void) | undefined;
	let spawnCalls = 0;
	let killCalls = 0;
	const sleeps: number[] = [];
	const fireTimer = (index: number, label: string): void => {
		const timer = timers[index];
		if (!timer) throw new Error(`${label} was not registered`);
		if (timer.cancelled || timer.fired) return;
		timer.fired = true;
		timer.callback();
	};
	const backend: FixtureCommandBackend = {
		spawn() {
			spawnCalls += 1;
			return {
				onStdout() {},
				onStderr(listener) { if (options.stderr) listener(options.stderr); },
				onError(listener) { errorListener = listener; },
				onClose(listener) { closeListener = listener; },
				kill() {
					killCalls += 1;
					if (options.killThrows) throw options.killThrows;
					if (options.killError) queueMicrotask(() => errorListener?.(options.killError));
					return options.killResult ?? true;
				},
			};
		},
		schedule(callback, delayMs) {
			const timer = { callback, cancelled: false, fired: false, delayMs };
			timers.push(timer);
			return { cancel() { timer.cancelled = true; }, unref() {} };
		},
		async sleep(delayMs) { sleeps.push(delayMs); },
	};
	return {
		backend,
		fireTimeout() { fireTimer(0, "timeout callback"); },
		fireTerminationGrace() { fireTimer(1, "termination grace callback"); },
		close(exitCode, signal) {
			if (!closeListener) throw new Error("close listener was not registered");
			closeListener(exitCode, signal);
		},
		get spawnCalls() { return spawnCalls; },
		get killCalls() { return killCalls; },
		get sleeps() { return sleeps; },
		get scheduledDelays() { return timers.map(timer => timer.delayMs); },
	};
}

async function captureFixtureCommandError(command: Promise<unknown>): Promise<FixtureCommandError> {
	try {
		await command;
		throw new Error("expected fixture command to fail");
	} catch (error) {
		expect(error).toBeInstanceOf(FixtureCommandError);
		return error as FixtureCommandError;
	}
}

describe("runFixtureCommand command policy", () => {
	it("passes literal argv with safe process options and captures output", async () => {
		const fake = fakeBackend([{ stdout: "ready", stderr: "notice" }]);
		const args = ["value with spaces & shell characters"];
		const result = await runFixtureCommandWithBackend("fixture-tool", args, { attempts: 1 }, fake.backend);

		expect(result).toEqual({ stdout: "ready", stderr: "notice", attempts: 1, exitCode: 0 });
		expect(fake.calls).toEqual([{
			file: "fixture-tool",
			args,
			options: expect.objectContaining({
				shell: false,
				windowsHide: true,
				windowsVerbatimArguments: false,
				stdio: ["ignore", "pipe", "pipe"],
			}),
		}]);
		expect(fake.stdin).toEqual([]);
	});

	it("pipes an explicit bootstrap payload without rendering it in argv", async () => {
		const fake = fakeBackend([{ stdout: "imported" }]);
		const payload = "blob\\ndata 7\\nsecret!\\n";
		const result = await runFixtureCommandWithBackend("git", ["fast-import", "--quiet"], {
			attempts: 1,
			stdin: payload,
		}, fake.backend);

		expect(result.stdout).toBe("imported");
		expect(fake.stdin).toEqual([payload]);
		expect(fake.calls[0]?.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
		expect(fake.calls[0]?.args).toEqual(["fast-import", "--quiet"]);
	});

	it("retries failures with bounded exponential backoff", async () => {
		const fake = fakeBackend([
			{ stderr: "transient one", exitCode: 23 },
			{ stderr: "transient two", exitCode: 24 },
			{ stdout: "ready" },
		]);
		const result = await runFixtureCommandWithBackend("fixture-tool", [], {
			attempts: 3,
			retryDelayMs: 7,
			maxRetryDelayMs: 10,
		}, fake.backend);

		expect(result).toMatchObject({ stdout: "ready", attempts: 3 });
		expect(fake.sleeps).toEqual([7, 10]);
		expect(fake.calls).toHaveLength(3);
	});

	it("restores transactional state after close and before a legitimate timeout retry", async () => {
		let fixtureGeneration = 0;
		let cleanupCalls = 0;
		const fake = fakeBackend([
			{ stderr: "timed out", hang: true },
			{
				stdout: "ready",
				onSpawn: () => { expect(fixtureGeneration).toBe(1); },
			},
		], true);

		const result = await runFixtureCommandWithBackend("git", ["commit"], {
			attempts: 2,
			timeoutMs: 100,
			retryDelayMs: 7,
			onTimedOutAttemptClosed: attempt => {
				expect(attempt).toBe(1);
				expect(fake.calls).toHaveLength(1);
				expect(fake.sleeps).toEqual([]);
				fixtureGeneration += 1;
				cleanupCalls += 1;
			},
		}, fake.backend);

		expect(result).toMatchObject({ stdout: "ready", attempts: 2, exitCode: 0 });
		expect(cleanupCalls).toBe(1);
		expect(fake.calls).toHaveLength(2);
		expect(fake.sleeps).toEqual([7]);
	});

	it("accepts an exit-zero close that races the timeout without cleanup or retry", async () => {
		const controlled = controlledBackend();
		let cleanupCalls = 0;
		const command = runFixtureCommandWithBackend("git", ["commit"], {
			attempts: 2,
			timeoutMs: 100,
			onTimedOutAttemptClosed: () => { cleanupCalls += 1; },
		}, controlled.backend);

		controlled.fireTimeout();
		controlled.close(0, null);

		await expect(command).resolves.toMatchObject({ attempts: 1, exitCode: 0 });
		expect(controlled.spawnCalls).toBe(1);
		expect(controlled.killCalls).toBe(1);
		expect(controlled.sleeps).toEqual([]);
		expect(cleanupCalls).toBe(0);
	});

	it("keeps exit zero authoritative after a post-spawn kill error", async () => {
		const controlled = controlledBackend({ killError: new Error("kill failed after spawn") });
		let cleanupCalls = 0;
		const command = runFixtureCommandWithBackend("git", ["commit"], {
			attempts: 2,
			timeoutMs: 100,
			onTimedOutAttemptClosed: () => { cleanupCalls += 1; },
		}, controlled.backend);

		controlled.fireTimeout();
		await Promise.resolve();
		controlled.close(0, null);

		await expect(command).resolves.toMatchObject({ attempts: 1, exitCode: 0 });
		expect(controlled.spawnCalls).toBe(1);
		expect(controlled.killCalls).toBe(1);
		expect(controlled.sleeps).toEqual([]);
		expect(cleanupCalls).toBe(0);
	});

	it("fails terminally after the teardown grace when close never arrives", async () => {
		const controlled = controlledBackend({ stderr: "still running" });
		let cleanupCalls = 0;
		let settled = false;
		const command = runFixtureCommandWithBackend("git", ["commit"], {
			attempts: 3,
			timeoutMs: 100,
			onTimedOutAttemptClosed: () => { cleanupCalls += 1; },
		}, controlled.backend);
		void command.then(() => { settled = true; }, () => { settled = true; });

		controlled.fireTimeout();
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(controlled.scheduledDelays).toEqual([100, 1_000]);
		expect(controlled.spawnCalls).toBe(1);
		expect(controlled.killCalls).toBe(1);

		controlled.fireTerminationGrace();
		const error = await captureFixtureCommandError(command);
		expect(error.attempts).toBe(1);
		expect(error.timedOut).toBe(true);
		expect(error.terminationUnconfirmed).toBe(true);
		expect(error.signal).toBeNull();
		expect(error.stderr).toBe("still running");
		expect(error.message).toContain("child close was not observed within 1000ms");
		expect(error.message).toContain("retry was suppressed");
		expect(controlled.sleeps).toEqual([]);
		expect(cleanupCalls).toBe(0);

		controlled.close(0, null);
		await Promise.resolve();
		expect(controlled.spawnCalls).toBe(1);
	});

	it("fails terminally without retry when timeout kill returns false", async () => {
		const controlled = controlledBackend({ killResult: false });
		const command = runFixtureCommandWithBackend("git", ["commit"], {
			attempts: 3,
			timeoutMs: 100,
		}, controlled.backend);

		controlled.fireTimeout();
		controlled.fireTerminationGrace();
		const error = await captureFixtureCommandError(command);
		expect(error.terminationUnconfirmed).toBe(true);
		expect(error.message).toContain("SIGKILL request returned false");
		expect(controlled.spawnCalls).toBe(1);
		expect(controlled.killCalls).toBe(1);
		expect(controlled.sleeps).toEqual([]);
	});

	it("fails terminally and redacts diagnostics when timeout kill throws", async () => {
		const secret = "kill-throw-secret";
		const controlled = controlledBackend({ killThrows: new Error(`cannot kill ${secret}`) });
		const command = runFixtureCommandWithBackend("git", ["commit", secret], {
			attempts: 3,
			timeoutMs: 100,
			redact: [secret],
		}, controlled.backend);

		controlled.fireTimeout();
		controlled.fireTerminationGrace();
		const error = await captureFixtureCommandError(command);
		expect(error.terminationUnconfirmed).toBe(true);
		expect(error.message).toContain("cannot kill [REDACTED]");
		expect(error.message).not.toContain(secret);
		expect(controlled.spawnCalls).toBe(1);
		expect(controlled.killCalls).toBe(1);
		expect(controlled.sleeps).toEqual([]);
	});

	it("waits for close before cleanup and wraps cleanup errors with redaction", async () => {
		const secret = "cleanup-hook-secret";
		const controlled = controlledBackend({ stderr: secret });
		let cleanupCalls = 0;
		let settled = false;
		const command = runFixtureCommandWithBackend("git", ["commit", secret], {
			attempts: 2,
			timeoutMs: 100,
			redact: [secret],
			onTimedOutAttemptClosed: () => {
				cleanupCalls += 1;
				throw new Error(`cleanup rejected ${secret}`);
			},
		}, controlled.backend);
		void command.then(() => { settled = true; }, () => { settled = true; });

		controlled.fireTimeout();
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(cleanupCalls).toBe(0);

		controlled.close(null, "SIGKILL");
		await expect(command).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(FixtureCommandError);
			const commandError = error as FixtureCommandError;
			expect(commandError.attempts).toBe(1);
			expect(commandError.timedOut).toBe(true);
			expect(commandError.message).toContain("timed-out attempt cleanup failed");
			expect(commandError.message).toContain("[REDACTED]");
			expect(commandError.message).not.toContain(secret);
			expect(commandError.stderr).toBe("[REDACTED]");
			return true;
		});
		expect(controlled.sleeps).toEqual([]);
		expect(cleanupCalls).toBe(1);
	});

	it("bounds time and redacts argv, environment secrets, and stderr", async () => {
		const secret = "fixture-super-secret";
		const fake = fakeBackend([{ stderr: secret, hang: true }], true);
		await expect(runFixtureCommandWithBackend("fixture-tool", [secret], {
			attempts: 1,
			timeoutMs: 100,
			env: { TEST_TOKEN: secret },
			redact: [secret],
		}, fake.backend)).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(FixtureCommandError);
			const commandError = error as FixtureCommandError;
			expect(commandError.timedOut).toBe(true);
			expect(commandError.attempts).toBe(1);
			expect(commandError.message).toContain("[REDACTED]");
			expect(commandError.message).not.toContain(secret);
			expect(commandError.stderr).toBe("[REDACTED]");
			return true;
		});
	});

	it("rejects retry counts above the hard maximum without invoking a backend", async () => {
		const fake = fakeBackend([]);
		await expect(runFixtureCommandWithBackend("fixture-tool", [], { attempts: 4 }, fake.backend))
			.rejects.toThrow(/attempts must be an integer between 1 and 3/);
		expect(fake.calls).toHaveLength(0);
	});
});
