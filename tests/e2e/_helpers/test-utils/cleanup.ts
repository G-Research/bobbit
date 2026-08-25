/**
 * Bounded-retry filesystem cleanup for E2E harness teardown.
 *
 * Why: rmSync(..., { recursive: true, force: true }) on Windows under heavy
 * parallel load deadlocks against Windows Defender, which holds file handles
 * for ~50–500ms after the last write. The previous fire-and-forget
 * `void rmAsync(...)` strategy hid the failures behind a global teardown
 * sweep; this helper bounds the work, retries with backoff, and surfaces
 * the leak count if cleanup never completes.
 *
 * Used by gateway-harness.ts, in-process-harness.ts,
 * in-process-harness-realpush.ts and the global teardown.
 */
import { rm } from "node:fs/promises";

export interface AwaitableRmOptions {
	maxAttempts?: number;
	backoffMs?: number;
	onFinalFailure?: (err: unknown) => void;
}

/**
 * Recursively remove a directory tree, retrying transient FS errors.
 *
 * Resolves when removal succeeds or the budget is exhausted (does NOT throw).
 * On final failure, calls `onFinalFailure` if provided so the global teardown
 * can track leaks. Safe to await from worker teardown — bounded by
 * `maxAttempts * backoffMs * 2^maxAttempts` worst-case.
 */
export async function awaitableRm(
	path: string,
	opts: AwaitableRmOptions = {},
): Promise<{ removed: boolean; attempts: number; lastError?: unknown }> {
	const max = opts.maxAttempts ?? 5;
	const base = opts.backoffMs ?? 200;
	let lastErr: unknown;
	for (let attempt = 1; attempt <= max; attempt++) {
		try {
			await rm(path, { recursive: true, force: true });
			return { removed: true, attempts: attempt };
		} catch (err) {
			lastErr = err;
			if (attempt === max) break;
			// Exponential backoff: 200ms, 400ms, 800ms, 1600ms
			await new Promise(r => setTimeout(r, base * Math.pow(2, attempt - 1)));
		}
	}
	if (opts.onFinalFailure) opts.onFinalFailure(lastErr);
	return { removed: false, attempts: max, lastError: lastErr };
}

/**
 * Poll a predicate until it returns truthy, with a fixed deadline.
 *
 * The canonical replacement for `await new Promise(r => setTimeout(r, N))`
 * followed by an assertion. Tests should use this (or one of the dedicated
 * `waitForX` helpers in e2e-setup.ts) instead of inline sleeps.
 *
 * @example
 *   await pollUntil(async () => {
 *     const resp = await apiFetch(`/api/sessions/${id}`);
 *     return (await resp.json()).status === "idle";
 *   }, { timeoutMs: 5000, label: "session idle" });
 */
export async function pollUntil<T>(
	predicate: () => T | Promise<T>,
	opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const intervalMs = opts.intervalMs ?? 50;
	const label = opts.label ?? "predicate";
	const start = Date.now();
	let lastErr: unknown;
	while (Date.now() - start < timeoutMs) {
		try {
			const v = await predicate();
			if (v) return v;
		} catch (err) {
			lastErr = err;
		}
		await new Promise(r => setTimeout(r, intervalMs));
	}
	const elapsed = Date.now() - start;
	const errSuffix = lastErr ? ` (last error: ${(lastErr as Error)?.message ?? lastErr})` : "";
	throw new Error(`pollUntil("${label}") timed out after ${elapsed}ms${errSuffix}`);
}
