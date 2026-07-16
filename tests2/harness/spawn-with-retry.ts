import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_ATTEMPTS = 3;

export interface FixtureCommandOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	attempts?: number;
	retryDelayMs?: number;
	maxRetryDelayMs?: number;
	maxOutputBytes?: number;
	/** Literal values removed from diagnostics. Environment secrets are detected too. */
	redact?: readonly string[];
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
	cause?: unknown;
}

export class FixtureCommandError extends Error {
	readonly attempts: number;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly timedOut: boolean;
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

function sleep(ms: number): Promise<void> {
	return ms === 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms));
}

async function runAttempt(
	file: string,
	args: readonly string[],
	options: FixtureCommandOptions,
	timeoutMs: number,
	maxOutputBytes: number,
): Promise<{ stdout: string; stderr: string } | AttemptFailure> {
	return await new Promise(resolve => {
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let timedOut = false;
		let outputExceeded = false;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		let forcedFinish: NodeJS.Timeout | undefined;

		const finish = (result: { stdout: string; stderr: string } | AttemptFailure): void => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (forcedFinish) clearTimeout(forcedFinish);
			resolve(result);
		};

		let child;
		try {
			child = spawn(file, [...args], {
				cwd: options.cwd,
				env: options.env,
				shell: false,
				windowsHide: true,
				windowsVerbatimArguments: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (cause) {
			finish({ exitCode: null, signal: null, stderr: "", timedOut: false, cause });
			return;
		}

		const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike> | string): Buffer<ArrayBufferLike> => {
			const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
			if (next.length <= maxOutputBytes) return next;
			outputExceeded = true;
			child.kill("SIGKILL");
			return next.subarray(0, maxOutputBytes);
		};
		child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
		child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
		child.once("error", cause => {
			finish({ exitCode: null, signal: null, stderr: stderr.toString("utf8"), timedOut, cause });
		});
		child.once("close", (exitCode, signal) => {
			const stderrText = stderr.toString("utf8");
			if (exitCode === 0 && !timedOut && !outputExceeded) {
				finish({ stdout: stdout.toString("utf8"), stderr: stderrText });
				return;
			}
			const suffix = outputExceeded ? `\nfixture command output exceeded ${maxOutputBytes} bytes` : "";
			finish({ exitCode, signal, stderr: `${stderrText}${suffix}`.trim(), timedOut });
		});
		timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
			// A platform adapter can fail to deliver even SIGKILL. Bound the caller's
			// wait regardless; commands are direct children because shell is false.
			forcedFinish = setTimeout(() => finish({
				exitCode: null,
				signal: "SIGKILL",
				stderr: stderr.toString("utf8"),
				timedOut: true,
			}), 1_000);
			forcedFinish.unref();
		}, timeoutMs);
		timeout.unref();
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

	for (let attempt = 1; attempt <= attempts; attempt++) {
		const result = await runAttempt(file, args, options, timeoutMs, maxOutputBytes);
		if ("stdout" in result) return { ...result, attempts: attempt, exitCode: 0 };
		lastFailure = result;
		if (attempt < attempts) {
			const delay = Math.min(maxRetryDelayMs, retryDelayMs * (2 ** (attempt - 1)));
			await sleep(delay);
		}
	}

	const failure = lastFailure!;
	const stderr = redact(failure.stderr, secrets);
	const reason = failure.timedOut
		? `timed out after ${timeoutMs}ms`
		: failure.exitCode === null
			? `failed to start${failure.cause instanceof Error ? `: ${redact(failure.cause.message, secrets)}` : ""}`
			: `exited with code ${failure.exitCode}${failure.signal ? ` (${failure.signal})` : ""}`;
	const detail = stderr ? `\nstderr:\n${stderr}` : "";
	throw new FixtureCommandError(
		`[tests2/fixture-command] ${command} ${reason} after ${attempts} attempt${attempts === 1 ? "" : "s"}${detail}`,
		attempts,
		{ ...failure, stderr },
	);
}
