/**
 * Retry-with-backoff core for git-status refreshes.
 *
 * Pure logic, decoupled from DOM / module singletons so it can be unit-tested.
 * Used by `session-manager.ts` (session widget) and `goal-dashboard.ts`
 * (dashboard widget).
 */

import type { GitStatusResult } from "./api.js";

/** Backoff schedule: attempt 1 immediate, then sleep 500/2000/5000 ms before
 *  attempts 2/3/4. Stops after 4 total attempts. */
export const GIT_STATUS_BACKOFF_MS = [0, 500, 2000, 5000] as const;

export type GitRepoKnown = "yes" | "no" | "unknown";

export interface RefreshCallbacks<T> {
	/** Fetcher — typically `() => fetchGitStatus(id, { ..., signal })`. */
	fetch(signal: AbortSignal): Promise<GitStatusResult>;
	/** Abortable sleep. Rejects with AbortError when the signal fires. */
	sleep(ms: number, signal: AbortSignal): Promise<void>;
	/** Return true to bail out before a retry (e.g. session switched away). */
	isStale(): boolean;
	/** Called on `ok` with the data. Ok response may include `partial` / `untrackedIncluded`. */
	onOk(data: T): void;
	/** Called on confirmed `not-a-repo` (terminal). */
	onNotARepo(): void;
	/** Called exactly once in the outer `finally` after all attempts/abort. */
	onFinally(): void;
}

/**
 * Run the retry loop. Caller owns the AbortController (to abort from outside).
 * - Retries only on `kind: 'error'`.
 * - Immediately returns on `kind: 'not-a-repo'` without retrying.
 * - On success, calls `onOk` once and returns.
 * - On abort (signal fires) or `isStale()`, returns silently.
 */
export async function runGitStatusRefresh<T>(
	signal: AbortSignal,
	cb: RefreshCallbacks<T>,
): Promise<void> {
	try {
		for (let attempt = 0; attempt < GIT_STATUS_BACKOFF_MS.length; attempt++) {
			if (signal.aborted || cb.isStale()) return;
			const delay = GIT_STATUS_BACKOFF_MS[attempt];
			if (delay > 0) {
				try {
					await cb.sleep(delay, signal);
				} catch {
					return; // aborted mid-sleep
				}
				if (signal.aborted || cb.isStale()) return;
			}
			let result: GitStatusResult;
			try {
				result = await cb.fetch(signal);
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") return;
				result = { kind: "error", message: (err as Error).message };
			}
			if (signal.aborted || cb.isStale()) return;
			if (result.kind === "ok") {
				cb.onOk(result.data as T);
				return;
			}
			if (result.kind === "not-a-repo") {
				cb.onNotARepo();
				return;
			}
			// result.kind === 'error' — loop and retry (unless this was last attempt)
		}
	} finally {
		cb.onFinally();
	}
}

/** Default abortable sleep based on `setTimeout`. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException("aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reject(new DOMException("aborted", "AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
