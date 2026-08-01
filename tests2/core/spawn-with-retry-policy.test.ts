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
