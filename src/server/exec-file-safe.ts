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
import { promisify } from "node:util";

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
		try {
			const result = await execFileAsync(file, args, options);
			return { stdout: result.stdout as string, stderr: result.stderr as string };
		} catch (err: any) {
			lastError = err;

			// Only retry on transient spawn errors, not on command failures
			if (TRANSIENT_SPAWN_CODES.has(err?.code) && attempt < MAX_RETRIES) {
				console.warn(
					`[exec-file-safe] ${err.code} spawning "${file}" — retry ${attempt + 1}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms`,
				);
				await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
				continue;
			}

			throw err;
		}
	}

	throw lastError;
}
