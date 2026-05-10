/**
 * Git status caching, batching, and test hooks.
 * Extracted from server.ts (commit: split server.ts).
 */
import { runBatchGitStatusNative } from "../skills/git-status-native.js";

/** Git status result shape (+ optional partial/untrackedIncluded flags). */
export interface GitStatusResult {
	branch: string; primaryBranch: string; isOnPrimary: boolean;
	status: { file: string; status: string }[];
	hasUpstream: boolean; ahead: number; behind: number;
	aheadOfPrimary: number; behindPrimary: number; mergedIntoPrimary: boolean;
	insertionsVsPrimary: number; deletionsVsPrimary: number;
	clean: boolean; summary: string; unpushed: boolean;
	/** true if porcelain (Phase B) was skipped or timed-out */
	partial?: boolean;
	/** true only when ?untracked=1 was passed (-uall); false on default -uno */
	untrackedIncluded?: boolean;
}

// ── Git status cache + single-flight ──
// Short TTL (2000ms) to coalesce the storm of event-driven refreshes (reconnect,
// agent-idle, session-switch, goal-dashboard fan-out across N sessions sharing
// a cwd) into one underlying git invocation. Native parallel execFile typically
// returns in 50-150 ms on Windows / 10-30 ms on Linux, so 2 s of staleness is
// imperceptible to the widget (which polls every 10 s) and high-value for
// coalescing. Errors are NOT cached (so a transient failure doesn't stick).
// Key includes the untracked flag so dropdown (full) and pill-strip (summary)
// responses never cross-contaminate each other.
const GIT_STATUS_TTL_MS = 2000;
interface GitStatusCacheEntry {
	promise: Promise<GitStatusResult | null>;
	resolvedAt: number; // 0 while in flight
	result: GitStatusResult | null | undefined; // undefined while in flight
}
const gitStatusCache = new Map<string, GitStatusCacheEntry>();

/** Test-only invocation counter (underlying git script runs). */
let _runBatchGitStatusCount = 0;
export function __getGitStatusInvocationCount(): number { return _runBatchGitStatusCount; }
export function __resetGitStatusInvocationCount(): void { _runBatchGitStatusCount = 0; }

/** Test-only hook: if set, replaces the real `runBatchGitStatus` git-spawn
 *  path with a fake. Used by `tests/e2e/git-status-caching.spec.ts` to
 *  exercise the TTL/single-flight/coalesce logic deterministically without
 *  spawning Git Bash under CI load (which fails unpredictably). Production
 *  code never sets this. */
let _gitStatusFake: ((cwd: string, containerId?: string, opts?: { untracked?: boolean }) => Promise<GitStatusResult | null>) | undefined;
export function __setGitStatusFake(fn: typeof _gitStatusFake): void { _gitStatusFake = fn; }
export function __clearGitStatusFake(): void { _gitStatusFake = undefined; }

export function gitStatusCacheKey(cwd: string, containerId?: string, untracked?: boolean): string {
	return `${containerId ?? 'host'}::${cwd}::${untracked ? 'u' : 's'}`;
}

/** Invalidate both summary and untracked cache entries for a cwd (optionally
 *  scoped to a container). Call after any local git mutation (commit, pull,
 *  push, rebase, merge). */
export function invalidateGitStatusCache(cwd: string, containerId?: string): void {
	gitStatusCache.delete(gitStatusCacheKey(cwd, containerId, true));
	gitStatusCache.delete(gitStatusCacheKey(cwd, containerId, false));
}

/** Test-only: mark all cache entries for a cwd as TTL-expired without
 *  sleeping. Used by `tests/e2e/git-status-caching.spec.ts` to deterministically
 *  exercise the TTL re-run path without inflating wall-clock time. Sets
 *  `resolvedAt` to a timestamp older than `GIT_STATUS_TTL_MS` so the next
 *  call falls through to a fresh invocation. */
export function __forceGitStatusCacheExpiry(cwd: string, containerId?: string): void {
	const staleAt = Date.now() - GIT_STATUS_TTL_MS - 1000;
	for (const untracked of [true, false]) {
		const entry = gitStatusCache.get(gitStatusCacheKey(cwd, containerId, untracked));
		if (entry && entry.result !== undefined) entry.resolvedAt = staleAt;
	}
}

function evictExpired(now: number): void {
	if (gitStatusCache.size <= 200) return;
	for (const [k, v] of gitStatusCache) {
		if (v.resolvedAt !== 0 && now - v.resolvedAt > 5000) gitStatusCache.delete(k);
	}
}

/** Cached wrapper over runBatchGitStatus with TTL + single-flight. */
export async function batchGitStatus(
	cwd: string,
	containerId?: string,
	opts?: { untracked?: boolean },
): Promise<GitStatusResult | null> {
	const key = gitStatusCacheKey(cwd, containerId, opts?.untracked);
	const now = Date.now();
	evictExpired(now);
	const existing = gitStatusCache.get(key);
	if (existing) {
		if (existing.result === undefined) return existing.promise; // in flight
		if (now - existing.resolvedAt < GIT_STATUS_TTL_MS) return existing.result; // fresh
		// stale — fall through and re-run
	}

	const promise = runBatchGitStatus(cwd, containerId, opts).then(
		(result) => {
			const entry = gitStatusCache.get(key);
			if (entry && entry.promise === promise) {
				entry.result = result;
				entry.resolvedAt = Date.now();
			}
			return result;
		},
		(err) => {
			// Do NOT cache errors — next caller will retry fresh.
			const entry = gitStatusCache.get(key);
			if (entry && entry.promise === promise) gitStatusCache.delete(key);
			throw err;
		},
	);
	gitStatusCache.set(key, { promise, resolvedAt: 0, result: undefined });
	return promise;
}

/** Batched git status — host path uses native parallel execFile (no shell);
 *  container path keeps the legacy `docker exec sh -c <batch>` round-trip.
 *  Implementation lives in `../skills/git-status-native.ts`. Returns null if
 *  not a git repository. `partial` is reserved for a future degraded-mode
 *  flag and is currently always `false` on success. */
async function runBatchGitStatus(
	cwd: string,
	containerId?: string,
	opts?: { untracked?: boolean },
): Promise<GitStatusResult | null> {
	_runBatchGitStatusCount++;
	if (_gitStatusFake) return _gitStatusFake(cwd, containerId, opts);
	return runBatchGitStatusNative(cwd, { ...opts, containerId });
}
