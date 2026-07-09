// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
//
// Reproducing test for the "Cache empty git-widget state" goal (44e3b434).
// Pins the HQ/GOAL_GIT_UNAVAILABLE terminal path documented in the issue
// analysis: `/git-status` returns 409, `fetchGitStatus` maps it to
// `{ kind: 'error' }`, the retry loop exhausts with no branch/status data, and
// the widget renders nothing after briefly showing the "Checking git…" skeleton.
// The fix should persist a hidden/empty repo hint so later connects start
// hidden, run one quiet recheck, never flip `gitStatusLoading=true`, and reveal
// if the quiet recheck later returns showable git content.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWidgetGitRefresh, type GitWidgetLike } from "../../src/app/git-status-refresh.ts";
import type { GitStatusResult } from "../../src/app/api.ts";
import {
	computeConnectGitState,
	getCachedRepoState,
	setCachedRepoState,
} from "../../src/app/git-repo-cache.ts";

function makeLocalStorage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() {
			return map.size;
		},
		clear() {
			map.clear();
		},
		getItem(key: string) {
			return map.has(key) ? (map.get(key) as string) : null;
		},
		key(index: number) {
			return Array.from(map.keys())[index] ?? null;
		},
		removeItem(key: string) {
			map.delete(key);
		},
		setItem(key: string, value: string) {
			map.set(key, String(value));
		},
	} as Storage;
}

function stubSleep(_ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
	return Promise.resolve();
}

function hqUnavailable(): GitStatusResult {
	return { kind: "error", status: 409, message: "HTTP 409" };
}

function okResult(branch = "feature/visible"): GitStatusResult {
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

function applyOk(widget: GitWidgetLike, data: unknown): void {
	const d = data as { partial?: boolean; branch?: string };
	widget.gitStatus = data;
	widget.partial = !!d.partial;
	if (d.branch) widget.branch = d.branch;
}

beforeEach(() => {
	vi.stubGlobal("localStorage", makeLocalStorage());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("empty/hidden git-widget cache hint", () => {
	it("persists a hidden hint and computes a quiet hidden reconnect state", () => {
		setCachedRepoState("hq-session", "hidden" as never);

		expect(getCachedRepoState("hq-session")).toBe("hidden");
		expect(computeConnectGitState("hq-session")).toEqual({
			gitRepoKnown: "hidden",
			quietRecheck: true,
		});
	});

	it("caches hidden when HQ 409-style errors exhaust with no showable git data", async () => {
		const { ai, loadingWrites } = makeWidget({ gitRepoKnown: "unknown" });
		const cacheWrites: string[] = [];
		let fetches = 0;

		await runWidgetGitRefresh(ai, {
			signal: new AbortController().signal,
			quiet: false,
			fetch: async () => {
				fetches++;
				return hqUnavailable();
			},
			sleep: stubSleep,
			isStale: () => false,
			applyOk,
			onCache: (state) => cacheWrites.push(state),
		});

		expect(fetches).toBe(4);
		expect(loadingWrites[0]).toBe(true);
		expect(ai.gitStatusLoading).toBe(false);
		expect(ai.gitStatus).toBeUndefined();
		expect(ai.branch).toBeUndefined();
		expect(ai.gitRepoKnown).toBe("hidden");
		expect(cacheWrites).toEqual(["hidden"]);
	});

	it("quiet hidden reconnect never shows a skeleton and reveals when content appears", async () => {
		const { ai, loadingWrites } = makeWidget({ gitRepoKnown: "hidden" as never });
		const cacheWrites: string[] = [];
		let fetches = 0;

		await runWidgetGitRefresh(ai, {
			signal: new AbortController().signal,
			quiet: true,
			fetch: async () => {
				fetches++;
				return okResult("feature/visible");
			},
			sleep: stubSleep,
			isStale: () => false,
			applyOk,
			onCache: (state) => cacheWrites.push(state),
		});

		expect(fetches).toBe(1);
		expect(loadingWrites).not.toContain(true);
		expect(ai.gitRepoKnown).toBe("yes");
		expect(ai.branch).toBe("feature/visible");
		expect(ai.gitStatusLoading).toBe(false);
		expect(cacheWrites).toEqual(["yes"]);
	});
});
