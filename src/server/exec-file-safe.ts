/**
 * Resilient execFile wrapper — retries on transient spawn errors.
 *
 * On Windows, `child_process.execFile` can throw synchronous ENOTCONN errors
 * during socket/pipe creation for child process stdio when the system is under
 * file-descriptor pressure. This error bypasses promise rejection chains and
 * surfaces as an uncaught exception, crashing the gateway.
 *
 * This module provides `execFileSafe` which catches these transient errors and
 * retries with a brief delay, converting what would be a server crash into a
 * recoverable hiccup.
 */

import { execFile as execFileCb, type ExecFileOptions } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "./agent/cpu-diagnostics.js";

const execFileAsync = promisify(execFileCb);

/** Error codes that indicate transient spawn/pipe failures worth retrying. */
const TRANSIENT_SPAWN_CODES = new Set(["ENOTCONN", "EMFILE", "ENFILE", "EAGAIN"]);

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 200;

/**
 * Execute a file with retry logic for transient spawn errors.
 * API-compatible with `promisify(execFile)`.
 */
export async function execFileSafe(
	file: string,
	args: readonly string[],
	options?: ExecFileOptions & { maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
	let lastError: unknown;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const diagEnabled = cpuDiagnosticsEnabled();
		const diagStart = diagEnabled ? performance.now() : 0;
		let success = 0;
		let errorCode = "none";
		let retryDelayMs = 0;
		try {
			const result = await execFileAsync(file, args, options);
			success = 1;
			return { stdout: result.stdout as string, stderr: result.stderr as string };
		} catch (err: any) {
			lastError = err;
			errorCode = typeof err?.code === "string" ? err.code : "error";

			// Only retry on transient spawn errors, not on command failures
			if (TRANSIENT_SPAWN_CODES.has(err?.code) && attempt < MAX_RETRIES) {
				retryDelayMs = RETRY_DELAY_MS * (attempt + 1);
				console.warn(
					`[exec-file-safe] ${err.code} spawning "${file}" — retry ${attempt + 1}/${MAX_RETRIES} in ${retryDelayMs}ms`,
				);
			} else {
				throw err;
			}
		} finally {
			if (diagEnabled) {
				getCpuDiagnostics().recordChildProcess(`execFileSafe:${file}`, performance.now() - diagStart, {
					attempt,
					success,
					errorCode,
					timeoutMs: typeof options?.timeout === "number" ? options.timeout : 0,
				});
			}
		}
		if (retryDelayMs > 0) {
			await new Promise(resolve => setTimeout(resolve, retryDelayMs));
			continue;
		}
	}

	throw lastError;
}
