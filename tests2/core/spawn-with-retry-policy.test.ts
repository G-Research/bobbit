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
}

function fakeBackend(outcomes: FakeOutcome[], fireTimers = false): {
	backend: FixtureCommandBackend;
	calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }>;
	sleeps: number[];
} {
	const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
	const sleeps: number[] = [];
	let attempt = 0;
	const backend: FixtureCommandBackend = {
		spawn(file, args, options) {
			const outcome = outcomes[attempt++] ?? outcomes.at(-1) ?? {};
			calls.push({ file, args: [...args], options });
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
				kill(signal) {
					if (killed) return;
					killed = true;
					close?.(null, signal);
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
	return { backend, calls, sleeps };
}

function controlledBackend(options: { stderr?: string; killError?: Error } = {}): {
	backend: FixtureCommandBackend;
	fireTimeout(): void;
	close(exitCode: number | null, signal: NodeJS.Signals | null): void;
	readonly spawnCalls: number;
	readonly killCalls: number;
	readonly sleeps: readonly number[];
} {
	let timeoutCallback: (() => void) | undefined;
	let closeListener: ((exitCode: number | null, signal: NodeJS.Signals | null) => void) | undefined;
	let errorListener: ((cause: unknown) => void) | undefined;
	let spawnCalls = 0;
	let killCalls = 0;
	const sleeps: number[] = [];
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
					if (options.killError) queueMicrotask(() => errorListener?.(options.killError));
				},
			};
		},
		schedule(callback) {
			timeoutCallback = callback;
			return { cancel() {}, unref() {} };
		},
		async sleep(delayMs) { sleeps.push(delayMs); },
	};
	return {
		backend,
		fireTimeout() {
			if (!timeoutCallback) throw new Error("timeout callback was not registered");
			timeoutCallback();
		},
		close(exitCode, signal) {
			if (!closeListener) throw new Error("close listener was not registered");
			closeListener(exitCode, signal);
		},
		get spawnCalls() { return spawnCalls; },
		get killCalls() { return killCalls; },
		get sleeps() { return sleeps; },
	};
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
			options: expect.objectContaining({ shell: false, windowsHide: true, windowsVerbatimArguments: false }),
		}]);
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
