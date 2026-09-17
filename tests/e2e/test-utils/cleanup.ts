/**
 * Compatibility entrypoint for ownership-checked E2E filesystem cleanup.
 * Windows transient lock errors use the shared bounded retry/deadline policy;
 * terminal diagnostics preserve the complete attempt and lifecycle history.
 */
import { dirname } from "node:path";
import { removeOwnedPath } from "../../../scripts/testing-v2/owned-path-cleanup.mjs";

export interface AwaitableRmOptions {
	ownerRoot?: string;
	allowOwnerRoot?: boolean;
	owner?: { kind: string; id: string };
	lifecycle?: Record<string, unknown>;
	maxAttempts?: number;
	deadlineMs?: number;
	backoffMs?: number;
	maxDelayMs?: number;
	throwOnFailure?: boolean;
	onFinalFailure?: (err: unknown) => void;
}

/**
 * Compatibility facade for legacy fixtures. New harness cleanup should supply
 * its coordinator run root and opt into fail-loud terminal errors.
 */
export async function awaitableRm(
	path: string,
	opts: AwaitableRmOptions = {},
): Promise<{ removed: boolean; attempts: number; history?: unknown[]; lastError?: unknown }> {
	try {
		return await removeOwnedPath(path, {
			ownerRoot: opts.ownerRoot ?? dirname(path),
			allowOwnerRoot: opts.allowOwnerRoot,
			owner: opts.owner,
			lifecycle: opts.lifecycle,
			maxAttempts: opts.maxAttempts,
			deadlineMs: opts.deadlineMs,
			initialDelayMs: opts.backoffMs,
			maxDelayMs: opts.maxDelayMs,
		});
	} catch (error) {
		opts.onFinalFailure?.(error);
		if (opts.throwOnFailure) throw error;
		const attempts = typeof (error as { attempts?: unknown })?.attempts === "number"
			? (error as { attempts: number }).attempts
			: 1;
		return { removed: false, attempts, lastError: error };
	}
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
