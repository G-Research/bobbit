/**
 * Integration tests for the quiet-aware git-status refresh state machine
 * (`runWidgetGitRefresh` in `src/app/git-status-refresh.ts`), extracted from
 * `session-manager.ts::refreshGitStatusForSession` via a DI seam so the
 * loading / visibility / persistence rules can be unit-tested against a fake
 * widget-state object — no DOM, no WebSocket, no `state` singleton.
 *
 * Pins the spec's acceptance criteria for the "Fix git widget flash" goal:
 *   1. Cached-'no' quiet reconnect: `gitStatusLoading` is NEVER written `true`
 *      (no "Checking git…" skeleton), the widget stays hidden (gitRepoKnown
 *      stays 'no'), EXACTLY ONE background recheck fires, and the cache stays
 *      'no' on a not-a-repo result.
 *   2. When the quiet recheck's `onOk` fires (repo now exists), gitRepoKnown
 *      flips to 'yes' (widget revealed), the cache is written 'yes', and
 *      loading is cleared in the finally.
 *   3. Genuine first-ever check (no cache entry → quiet=false /
 *      gitRepoKnown='unknown'): `gitStatusLoading` IS set `true` (skeleton
 *      allowed) and exactly one fetch fires.
 *
 * Uses a `gitStatusLoading` write-tracker (Proxy) plus a stub `fetch`, and a
 * `stubSleep` that resolves synchronously (mirrors git-status-retry.test.ts).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { runWidgetGitRefresh, type GitWidgetLike } from "../../src/app/git-status-refresh.ts";
import type { GitStatusResult } from "../../src/app/api.ts";

function stubSleep(_ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
	return Promise.resolve();
}

function okResult(branch = "main"): GitStatusResult {
	return {
		kind: "ok",
		data: {
			branch,
			primaryBranch: "master",
			primaryRef: "origin/master",
			isOnPrimary: false,
			summary: "",
			clean: true,
			hasUpstream: true,
			ahead: 0,
			behind: 0,
			aheadOfPrimary: 0,
			behindPrimary: 0,
			mergedIntoPrimary: false,
			insertionsVsPrimary: 0,
			deletionsVsPrimary: 0,
			unpushed: false,
			status: [],
		},
	};
}

/**
 * Build a fake widget plus a tracker recording every value assigned to
 * `gitStatusLoading` (so we can assert "no `true` was ever written").
 */
function makeWidget(initial: Partial<GitWidgetLike>): {
	ai: GitWidgetLike;
	loadingWrites: boolean[];
} {
	const loadingWrites: boolean[] = [];
	const target: GitWidgetLike = {
		gitRepoKnown: "unknown",
		gitStatusLoading: false,
		...initial,
	};
	const ai = new Proxy(target, {
		set(obj, prop, value) {
			if (prop === "gitStatusLoading") loadingWrites.push(value as boolean);
			(obj as unknown as Record<string | symbol, unknown>)[prop] = value;
			return true;
		},
	});
	return { ai, loadingWrites };
}

/** Simple applyOk that mirrors the session-manager adapter's shape. */
function applyOk(widget: GitWidgetLike, data: unknown): void {
	const d = data as { partial?: boolean; branch?: string };
	widget.gitStatus = data;
	widget.partial = !!d.partial;
	if (d.branch) widget.branch = d.branch;
}

describe("runWidgetGitRefresh — quiet recheck integration", () => {
	it("case 1: cached-'no' quiet reconnect never sets loading=true, one recheck, stays 'no'", async () => {
		const { ai, loadingWrites } = makeWidget({ gitRepoKnown: "no" });
		let fetches = 0;
		const cacheWrites: Array<"yes" | "no"> = [];
		const ctl = new AbortController();

		await runWidgetGitRefresh(ai, {
			signal: ctl.signal,
			quiet: true,
			fetch: async () => {
				fetches++;
				return { kind: "not-a-repo" };
			},
			sleep: stubSleep,
			isStale: () => false,
			applyOk,
			onCache: (s) => cacheWrites.push(s),
		});

		assert.ok(!loadingWrites.includes(true), "gitStatusLoading must NEVER be written true during a quiet recheck");
		assert.equal(fetches, 1, "exactly one background recheck fires");
		assert.equal(ai.gitRepoKnown, "no", "widget stays hidden (gitRepoKnown stays 'no')");
		assert.deepEqual(cacheWrites, ["no"], "cache stays 'no' on a not-a-repo result");
	});

	it("case 2: quiet recheck onOk (repo now exists) reveals widget, caches 'yes', clears loading", async () => {
		const { ai, loadingWrites } = makeWidget({ gitRepoKnown: "no" });
		let fetches = 0;
		const cacheWrites: Array<"yes" | "no"> = [];
		const ctl = new AbortController();

		await runWidgetGitRefresh(ai, {
			signal: ctl.signal,
			quiet: true,
			fetch: async () => {
				fetches++;
				return okResult("feature/init");
			},
			sleep: stubSleep,
			isStale: () => false,
			applyOk,
			onCache: (s) => cacheWrites.push(s),
		});

		assert.equal(fetches, 1, "exactly one recheck");
		assert.equal(ai.gitRepoKnown, "yes", "repo now exists → widget revealed");
		assert.deepEqual(cacheWrites, ["yes"], "cache written 'yes'");
		assert.equal(ai.branch, "feature/init", "onOk applied the branch");
		// quiet started true but gitRepoKnown flipped to 'yes' (≠ 'no'), so the
		// finally clears loading. It was never set true (started 'no' quiet), so
		// the only write is the final `false`.
		assert.ok(!loadingWrites.includes(true), "loading never set true (started as a quiet 'no' recheck)");
		assert.equal(ai.gitStatusLoading, false, "loading cleared in finally once no longer 'no'");
		assert.deepEqual(loadingWrites, [false], "single clearing write in finally");
	});

	it("case 3: genuine first-ever check (unknown, quiet=false) sets loading=true, one fetch", async () => {
		const { ai, loadingWrites } = makeWidget({ gitRepoKnown: "unknown" });
		let fetches = 0;
		const cacheWrites: Array<"yes" | "no"> = [];
		const ctl = new AbortController();

		await runWidgetGitRefresh(ai, {
			signal: ctl.signal,
			quiet: false,
			fetch: async () => {
				fetches++;
				return { kind: "not-a-repo" };
			},
			sleep: stubSleep,
			isStale: () => false,
			applyOk,
			onCache: (s) => cacheWrites.push(s),
		});

		assert.equal(loadingWrites[0], true, "skeleton allowed: gitStatusLoading set true up front");
		assert.equal(fetches, 1, "one fetch");
		assert.equal(ai.gitRepoKnown, "no", "resolved not-a-repo");
		assert.deepEqual(cacheWrites, ["no"], "cache written 'no'");
		// Not a quiet-'no' recheck (quiet was false), so finally clears loading.
		assert.equal(ai.gitStatusLoading, false, "loading cleared in finally");
	});

	it("quiet=true but gitRepoKnown already 'unknown' is NOT quiet (skeleton allowed)", async () => {
		// Guards the `deps.quiet && ai.gitRepoKnown === 'no'` gate: a quiet flag
		// only suppresses the skeleton for a cached git-less session.
		const { ai, loadingWrites } = makeWidget({ gitRepoKnown: "unknown" });
		const ctl = new AbortController();

		await runWidgetGitRefresh(ai, {
			signal: ctl.signal,
			quiet: true,
			fetch: async () => ({ kind: "not-a-repo" }),
			sleep: stubSleep,
			isStale: () => false,
			applyOk,
			onCache: () => {},
		});

		assert.equal(loadingWrites[0], true, "quiet does not suppress skeleton unless gitRepoKnown was 'no'");
	});
});
