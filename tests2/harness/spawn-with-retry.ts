import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_ATTEMPTS = 3;

export interface FixtureCommandOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Optional literal stdin payload; omitted commands retain stdin-ignore isolation. */
	stdin?: string;
	timeoutMs?: number;
	attempts?: number;
	retryDelayMs?: number;
	maxRetryDelayMs?: number;
	maxOutputBytes?: number;
	/** Literal values removed from diagnostics. Environment secrets are detected too. */
	redact?: readonly string[];
	/**
	 * Restore private transactional state after a timed-out process closes
	 * unsuccessfully and before a remaining retry. A thrown cleanup error is
	 * sanitized as FixtureCommandError.
	 */
	onTimedOutAttemptClosed?: (attempt: number) => void | Promise<void>;
}

export interface FixtureCommandResult {
	stdout: string;
	stderr: string;
	attempts: number;
	exitCode: 0;
}

interface AttemptFailure {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
	timedOut: boolean;
	terminationUnconfirmed?: boolean;
	cause?: unknown;
}

export interface FixtureCommandProcess {
	onStdout(listener: (chunk: Buffer<ArrayBufferLike> | string) => void): void;
	onStderr(listener: (chunk: Buffer<ArrayBufferLike> | string) => void): void;
	onError(listener: (cause: unknown) => void): void;
	onClose(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): void;
	endStdin?(input: string): void;
	kill(signal: NodeJS.Signals): boolean;
}

interface FixtureCommandTimer {
	cancel(): void;
	unref(): void;
}

/** Injectable only so tier-1 tests can exercise command policy without spawning. */
export interface FixtureCommandBackend {
	spawn(file: string, args: readonly string[], options: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		shell: false;
		windowsHide: true;
		windowsVerbatimArguments: false;
		stdio: ["ignore" | "pipe", "pipe", "pipe"];
	}): FixtureCommandProcess;
	schedule(callback: () => void, delayMs: number): FixtureCommandTimer;
	sleep(delayMs: number): Promise<void>;
}

function schedule(callback: () => void, delayMs: number): FixtureCommandTimer {
	const timer = setTimeout(callback, delayMs);
	return {
		cancel: () => clearTimeout(timer),
		unref: () => timer.unref(),
	};
}

const productionBackend: FixtureCommandBackend = {
	spawn(file, args, options) {
		const child = spawn(file, [...args], options);
		child.stdin?.on("error", () => {
			// Close/timeout remains authoritative if a command exits before consuming
			// its complete bootstrap payload.
		});
		return {
			onStdout: listener => { child.stdout!.on("data", listener); },
			onStderr: listener => { child.stderr!.on("data", listener); },
			onError: listener => { child.once("error", listener); },
			onClose: listener => { child.once("close", listener); },
			endStdin: input => { child.stdin?.end(input); },
			kill: signal => child.kill(signal),
		};
	},
	schedule,
	sleep: delayMs => delayMs === 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, delayMs)),
};

export class FixtureCommandError extends Error {
	readonly attempts: number;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly timedOut: boolean;
	readonly terminationUnconfirmed: boolean;
	readonly stderr: string;

	constructor(message: string, attempts: number, failure: AttemptFailure) {
		// Do not retain the raw spawn error as `cause`: platform errors may echo an
		// unredacted argv value. The message and exposed stderr are sanitized.
		super(message);
		this.name = "FixtureCommandError";
		this.attempts = attempts;
		this.exitCode = failure.exitCode;
		this.signal = failure.signal;
		this.timedOut = failure.timedOut;
		this.terminationUnconfirmed = failure.terminationUnconfirmed === true;
		this.stderr = failure.stderr;
	}
}

function positiveInteger(value: number, label: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new RangeError(`${label} must be an integer between 1 and ${maximum}`);
	}
	return value;
}

function nonNegativeInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer`);
	return value;
}

function secretValues(options: FixtureCommandOptions): string[] {
	const values = [...(options.redact ?? [])];
	for (const [name, value] of Object.entries(options.env ?? {})) {
		if (typeof value === "string" && value.length >= 4 && /(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY)$/i.test(name)) {
			values.push(value);
		}
	}
	return [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
}

function redact(value: string, secrets: readonly string[]): string {
	let result = value;
	for (const secret of secrets) result = result.split(secret).join("[REDACTED]");
	return result;
}

function quoteArg(arg: string): string {
	return /^[A-Za-z0-9_./:\\=@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function renderCommand(file: string, args: readonly string[], secrets: readonly string[]): string {
	return redact([file, ...args].map(quoteArg).join(" "), secrets);
}

async function runAttempt(
	file: string,
	args: readonly string[],
	options: FixtureCommandOptions,
	timeoutMs: number,
	maxOutputBytes: number,
	backend: FixtureCommandBackend,
): Promise<{ stdout: string; stderr: string } | AttemptFailure> {
	return await new Promise(resolve => {
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let timedOut = false;
		let outputExceeded = false;
		let settled = false;
		let processCause: unknown;
		let killCause: unknown;
		let terminationRequested = false;
		let timeout: FixtureCommandTimer | undefined;
		let terminationGrace: FixtureCommandTimer | undefined;

		const finish = (result: { stdout: string; stderr: string } | AttemptFailure): void => {
			if (settled) return;
			settled = true;
			timeout?.cancel();
			terminationGrace?.cancel();
			resolve(result);
		};

		let child: FixtureCommandProcess;
		try {
			child = backend.spawn(file, args, {
				cwd: options.cwd,
				env: options.env,
				shell: false,
				windowsHide: true,
				windowsVerbatimArguments: false,
				stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			});
		} catch (cause) {
			finish({ exitCode: null, signal: null, stderr: "", timedOut: false, cause });
			return;
		}

		const requestTermination = (): void => {
			if (terminationRequested) return;
			terminationRequested = true;
			try {
				if (!child.kill("SIGKILL")) killCause = new Error("SIGKILL request returned false");
			} catch (cause) {
				// A kill error is diagnostic only while close still has a chance to win.
				// Retrying without close would overlap a potentially live child.
				killCause = cause;
			}
		};

		const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike> | string): Buffer<ArrayBufferLike> => {
			const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
			if (next.length <= maxOutputBytes) return next;
			outputExceeded = true;
			requestTermination();
			return next.subarray(0, maxOutputBytes);
		};
		child.onStdout(chunk => { stdout = append(stdout, chunk); });
		child.onStderr(chunk => { stderr = append(stderr, chunk); });
		// Node emits `close` after `error`. Retain process errors for the final
		// diagnostic, but never let a retry overlap a child whose close is unknown.
		child.onError(cause => { processCause ??= cause; });
		const failureStderr = (): string => {
			const suffix = outputExceeded ? `\nfixture command output exceeded ${maxOutputBytes} bytes` : "";
			return `${stderr.toString("utf8")}${suffix}`.trim();
		};
		child.onClose((exitCode, signal) => {
			const stderrText = stderr.toString("utf8");
			// Timeout and post-spawn errors can race delivery of an already-successful
			// close. Exit zero is authoritative unless captured output exceeded its bound.
			if (exitCode === 0 && !outputExceeded) {
				finish({ stdout: stdout.toString("utf8"), stderr: stderrText });
				return;
			}
			finish({
				exitCode,
				signal,
				stderr: failureStderr(),
				timedOut,
				cause: processCause ?? killCause,
			});
		});
		timeout = backend.schedule(() => {
			if (settled) return;
			timedOut = true;
			requestTermination();
			if (settled) return;
			// Close remains authoritative during this grace period. If it never arrives,
			// fail terminally rather than hang forever or overlap a potentially live child.
			terminationGrace = backend.schedule(() => finish({
				exitCode: null,
				signal: null,
				stderr: failureStderr(),
				timedOut: true,
				terminationUnconfirmed: true,
				cause: killCause ?? processCause,
			}), TERMINATION_GRACE_MS);
			terminationGrace.unref();
		}, timeoutMs);
		timeout.unref();
		if (options.stdin !== undefined) {
			try {
				if (!child.endStdin) throw new Error("fixture command backend does not support stdin");
				child.endStdin(options.stdin);
			} catch (cause) {
				processCause ??= cause;
				requestTermination();
			}
		}
	});
}

/**
 * Run a fixture/bootstrap command without a shell. Commands always receive an
 * argv array, capture stderr, hide Windows console windows, time out, and retry
 * with bounded exponential backoff. Call this before the tier-1 spawn guard is
 * installed; ordinary tier-1 test logic must use DI or copied templates instead.
 */
export async function runFixtureCommand(
	file: string,
	args: readonly string[],
	options: FixtureCommandOptions = {},
): Promise<FixtureCommandResult> {
	return runFixtureCommandWithBackend(file, args, options, productionBackend);
}

/** Test seam for policy coverage; production callers use runFixtureCommand(). */
export async function runFixtureCommandWithBackend(
	file: string,
	args: readonly string[],
	options: FixtureCommandOptions,
	backend: FixtureCommandBackend,
): Promise<FixtureCommandResult> {
	if (typeof file !== "string" || file.trim() === "") throw new TypeError("fixture command file must be a non-empty string");
	if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new TypeError("fixture command args must be an array of strings");
	const attempts = positiveInteger(options.attempts ?? MAX_ATTEMPTS, "attempts", MAX_ATTEMPTS);
	const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", MAX_TIMEOUT_MS);
	const retryDelayMs = nonNegativeInteger(options.retryDelayMs ?? 50, "retryDelayMs");
	const maxRetryDelayMs = nonNegativeInteger(options.maxRetryDelayMs ?? 500, "maxRetryDelayMs");
	const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes", 16 * 1024 * 1024);
	const secrets = secretValues(options);
	const command = renderCommand(file, args, secrets);
	let lastFailure: AttemptFailure | undefined;
	let attemptsMade = 0;

	const commandError = (failure: AttemptFailure, cleanupCause?: unknown): FixtureCommandError => {
		const stderr = redact(failure.stderr, secrets);
		const cleanupMessage = cleanupCause instanceof Error
			? `: ${redact(cleanupCause.message, secrets)}`
			: typeof cleanupCause === "string"
				? `: ${redact(cleanupCause, secrets)}`
				: "";
		const failureCause = failure.cause instanceof Error
			? `: ${redact(failure.cause.message, secrets)}`
			: "";
		const reason = cleanupCause !== undefined
			? `timed-out attempt cleanup failed${cleanupMessage}`
			: failure.terminationUnconfirmed
				? `timed out after ${timeoutMs}ms; child close was not observed within ${TERMINATION_GRACE_MS}ms, so retry was suppressed${failureCause}`
				: failure.timedOut
					? `timed out after ${timeoutMs}ms`
					: failure.exitCode === null
						? `failed to start${failureCause}`
						: `exited with code ${failure.exitCode}${failure.signal ? ` (${failure.signal})` : ""}`;
		const detail = stderr ? `\nstderr:\n${stderr}` : "";
		return new FixtureCommandError(
			`[tests2/fixture-command] ${command} ${reason} after ${attemptsMade} attempt${attemptsMade === 1 ? "" : "s"}${detail}`,
			attemptsMade,
			{ ...failure, stderr },
		);
	};

	for (let attempt = 1; attempt <= attempts; attempt++) {
		attemptsMade = attempt;
		const result = await runAttempt(file, args, options, timeoutMs, maxOutputBytes, backend);
		if ("stdout" in result) return { ...result, attempts: attempt, exitCode: 0 };
		lastFailure = result;
		if (result.terminationUnconfirmed) throw commandError(result);
		if (attempt < attempts) {
			if (result.timedOut && options.onTimedOutAttemptClosed) {
				try {
					await options.onTimedOutAttemptClosed(attempt);
				} catch (cause) {
					throw commandError(result, cause);
				}
			}
			const delay = Math.min(maxRetryDelayMs, retryDelayMs * (2 ** (attempt - 1)));
			await backend.sleep(delay);
		}
	}

	throw commandError(lastFailure!);
}
