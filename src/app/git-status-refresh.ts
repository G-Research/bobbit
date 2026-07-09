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

export type GitRepoKnown = "yes" | "no" | "hidden" | "unknown";

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
	/** Return false to stop retrying an error result before the next backoff. */
	shouldRetry?(result: Extract<GitStatusResult, { kind: "error" }>, attempt: number): boolean;
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
			if (cb.shouldRetry?.(result, attempt) === false) return;
			// result.kind === 'error' — loop and retry (unless this was last attempt)
		}
	} finally {
		cb.onFinally();
	}
}

/**
 * Minimal widget-state shape the quiet-aware refresh drives. The real
 * `AgentInterface` satisfies this structurally; tests pass a plain object (or a
 * Proxy that records `gitStatusLoading` writes).
 */
export interface GitWidgetLike {
	gitRepoKnown: GitRepoKnown;
	gitStatusLoading: boolean;
	gitStatus?: unknown;
	branch?: string;
	partial?: boolean;
}

/**
 * Dependencies for {@link runWidgetGitRefresh}. Keeps the DOM / WebSocket /
 * module-singleton concerns out of the state machine so it is unit-testable.
 */
export interface QuietRefreshDeps<T = unknown> {
	signal: AbortSignal;
	/** Fetcher — typically `(signal) => fetchGitStatus(id, { …, signal })`. */
	fetch(signal: AbortSignal): Promise<GitStatusResult>;
	/** Abortable sleep. Rejects with AbortError when the signal fires. */
	sleep(ms: number, signal: AbortSignal): Promise<void>;
	/** Return true to bail out (e.g. session switched away). */
	isStale(): boolean;
	/**
	 * Whether the caller *requested* a quiet recheck. The refresh only actually
	 * runs quiet when this is true AND the widget is already cached hidden
	 * (`gitRepoKnown === 'no' || gitRepoKnown === 'hidden'`) — see
	 * {@link runWidgetGitRefresh}.
	 */
	quiet: boolean;
	/**
	 * Apply an `ok` payload to `ai` (set `gitStatus` / `partial` / `branch`).
	 * Kept as a hook so the session-manager can preserve its
	 * `withUntrackedStatusPreserved` merge without leaking that logic here.
	 */
	applyOk(ai: GitWidgetLike, data: T): void;
	/** Persistence hook — `setCachedRepoState(sessionId, state)`. */
	onCache(state: "yes" | "no" | "hidden"): void;
	/**
	 * Unconditional teardown, run first inside the outer `finally` (before the
	 * staleness guard and before loading is cleared) — e.g. abort-map cleanup.
	 */
	onFinally?(): void;
}

function branchFrom(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const branch = (value as { branch?: unknown }).branch;
	return typeof branch === "string" && branch.trim() ? branch : undefined;
}

function hasShowableGitData(data: unknown): boolean {
	return branchFrom(data) !== undefined;
}

function widgetHasShowableGitData(ai: GitWidgetLike): boolean {
	return branchFrom(ai.gitStatus) !== undefined || (typeof ai.branch === "string" && ai.branch.trim().length > 0);
}

function cacheHidden<T>(deps: QuietRefreshDeps<T>): void {
	deps.onCache("hidden");
}

/**
 * Quiet-aware git-status refresh state machine, extracted from
 * `session-manager.ts::refreshGitStatusForSession` so it can be unit-tested
 * against a fake widget-state object.
 *
 * Rules (must stay identical to the session-manager behaviour):
 * - `quiet` is effective only for cached hidden sessions
 *   (`deps.quiet && (ai.gitRepoKnown === 'no' || ai.gitRepoKnown === 'hidden')`).
 *   When quiet, `gitStatusLoading` is NEVER flipped `true` (no "Checking git…"
 *   skeleton, widget stays hidden).
 * - `onOk`: apply status via `deps.applyOk`; showable payloads flip
 *   `gitRepoKnown = 'yes'` and persist `'yes'`, while empty payloads persist
 *   `'hidden'` and keep the widget hidden.
 * - `onNotARepo`: flip `gitRepoKnown = 'no'`, clear `gitStatus`, persist `'no'`.
 * - error give-up with no showable data: flip/cache `'hidden'`.
 * - `onFinally`: run `deps.onFinally` unconditionally, then (when not stale)
 *   clear `gitStatusLoading` unless this was a quiet recheck that stayed hidden.
 */
export async function runWidgetGitRefresh<T = unknown>(
	ai: GitWidgetLike,
	deps: QuietRefreshDeps<T>,
): Promise<void> {
	const quietHidden = deps.quiet && ai.gitRepoKnown === "hidden";
	const quiet = deps.quiet && (ai.gitRepoKnown === "no" || ai.gitRepoKnown === "hidden");
	let terminalResult = false;
	if (!quiet) ai.gitStatusLoading = true;

	await runGitStatusRefresh<T>(deps.signal, {
		fetch: deps.fetch,
		sleep: deps.sleep,
		isStale: deps.isStale,
		shouldRetry: () => !quietHidden,
		onOk: (data) => {
			if (deps.isStale()) return;
			terminalResult = true;
			if (hasShowableGitData(data)) {
				deps.applyOk(ai, data);
				// Repo now has visible content — reveal the widget and resume normal behaviour.
				ai.gitRepoKnown = "yes";
				deps.onCache("yes");
				return;
			}
			ai.gitRepoKnown = "hidden";
			ai.gitStatus = undefined;
			ai.branch = undefined;
			cacheHidden(deps);
		},
		onNotARepo: () => {
			if (deps.isStale()) return;
			terminalResult = true;
			ai.gitRepoKnown = "no";
			ai.gitStatus = undefined;
			ai.branch = undefined;
			deps.onCache("no");
		},
		onFinally: () => {
			// Unconditional teardown (abort-map cleanup) first — must run even
			// when stale so the in-flight marker cannot leak.
			deps.onFinally?.();
			if (deps.isStale() || deps.signal.aborted) return;
			if (!terminalResult && ai.gitRepoKnown !== "no" && !widgetHasShowableGitData(ai)) {
				ai.gitRepoKnown = "hidden";
				ai.gitStatus = undefined;
				ai.branch = undefined;
				cacheHidden(deps);
			}
			// Never surface loading for a quiet recheck that stayed hidden.
			if (!(quiet && (ai.gitRepoKnown === "no" || ai.gitRepoKnown === "hidden"))) ai.gitStatusLoading = false;
		},
	});
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
