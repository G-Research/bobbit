// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
//
// Reproducing test (TDD red) for the "Git widget 'Checking git…' flash" goal
// (32cd6b4f). Targets the NEW pure module `src/app/git-repo-cache.ts` that the
// fix will introduce. Until that module exists this file fails to resolve its
// import (vitest exits non-zero) — that is the intended RED state proving the
// caching behaviour is unimplemented.
//
// Contract under test (see goal spec + issue-analysis gate):
//   export type RepoState = 'yes' | 'no';
//   getCachedRepoState(sessionId): RepoState | undefined
//   setCachedRepoState(sessionId, state): void
//   pruneGitRepoCache(liveSessionIds: Iterable<string>): void
//   computeConnectGitState(sessionId): { gitRepoKnown: 'yes'|'no'|'unknown'; quietRecheck: boolean }
//
// Semantics:
//   - cache is sessionId -> 'yes'|'no' persisted in globalThis.localStorage under
//     a single key; absent/broken localStorage is tolerated (treated as empty).
//   - computeConnectGitState:
//       cached 'no'          -> { gitRepoKnown: 'no',      quietRecheck: true }
//       cached 'yes'|no entry-> { gitRepoKnown: 'unknown', quietRecheck: false }
//   - cache is capped and pruneGitRepoCache drops ids not in the live set.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	computeConnectGitState,
	getCachedRepoState,
	pruneGitRepoCache,
	setCachedRepoState,
} from "../../src/app/git-repo-cache.ts";

/** In-memory Map-backed localStorage stub — deterministic, isolated per test. */
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

beforeEach(() => {
	vi.stubGlobal("localStorage", makeLocalStorage());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("git-repo-cache: computeConnectGitState", () => {
	it("first-ever check (no cache entry) → unknown, no quiet recheck (skeleton still allowed)", () => {
		expect(getCachedRepoState("s1")).toBeUndefined();
		expect(computeConnectGitState("s1")).toEqual({ gitRepoKnown: "unknown", quietRecheck: false });
	});

	it("after not-a-repo resolves → cached 'no', starts 'no' with a quiet recheck (no skeleton/loading)", () => {
		setCachedRepoState("s1", "no");
		expect(getCachedRepoState("s1")).toBe("no");
		expect(computeConnectGitState("s1")).toEqual({ gitRepoKnown: "no", quietRecheck: true });
	});

	it("after git repo resolves → cached 'yes', behaves as before (unknown, no quiet recheck)", () => {
		setCachedRepoState("s2", "yes");
		expect(getCachedRepoState("s2")).toBe("yes");
		expect(computeConnectGitState("s2")).toEqual({ gitRepoKnown: "unknown", quietRecheck: false });
	});
});

describe("git-repo-cache: pruneGitRepoCache", () => {
	it("drops entries whose session id is not in the live set, keeps live ones", () => {
		setCachedRepoState("s1", "no");
		setCachedRepoState("s2", "yes");
		setCachedRepoState("s3", "no");
		setCachedRepoState("s4", "yes");

		pruneGitRepoCache(["s1"]);

		expect(getCachedRepoState("s1")).toBe("no");
		expect(getCachedRepoState("s2")).toBeUndefined();
		expect(getCachedRepoState("s3")).toBeUndefined();
		expect(getCachedRepoState("s4")).toBeUndefined();
	});
});

describe("git-repo-cache: persistence + resilience", () => {
	it("round-trips through localStorage (a fresh re-parse returns the written value)", () => {
		setCachedRepoState("s1", "no");
		setCachedRepoState("s2", "yes");

		// Simulate a fresh page load: same backing localStorage, but the module
		// must re-read from storage rather than rely on in-memory state.
		const raw = globalThis.localStorage.getItem("bobbit.gitRepoCache");
		expect(raw, "cache is persisted under a single localStorage key").toBeTruthy();
		const parsed = JSON.parse(raw as string);
		expect(parsed).toMatchObject({ s1: "no", s2: "yes" });

		expect(getCachedRepoState("s1")).toBe("no");
		expect(getCachedRepoState("s2")).toBe("yes");
	});

	it("tolerates a broken localStorage payload (no throw, returns undefined)", () => {
		globalThis.localStorage.setItem("bobbit.gitRepoCache", "{not valid json");
		expect(() => getCachedRepoState("s1")).not.toThrow();
		expect(getCachedRepoState("s1")).toBeUndefined();
		expect(computeConnectGitState("s1")).toEqual({ gitRepoKnown: "unknown", quietRecheck: false });
	});

	it("tolerates absent localStorage (no throw, returns undefined)", () => {
		vi.stubGlobal("localStorage", undefined);
		expect(() => getCachedRepoState("s1")).not.toThrow();
		expect(getCachedRepoState("s1")).toBeUndefined();
		expect(() => setCachedRepoState("s1", "no")).not.toThrow();
		expect(computeConnectGitState("s1")).toEqual({ gitRepoKnown: "unknown", quietRecheck: false });
	});

	it("caps the cache so it cannot grow unbounded", () => {
		for (let i = 0; i < 260; i++) setCachedRepoState(`sess-${i}`, i % 2 === 0 ? "no" : "yes");
		const raw = globalThis.localStorage.getItem("bobbit.gitRepoCache");
		const parsed = JSON.parse(raw as string) as Record<string, string>;
		expect(Object.keys(parsed).length).toBeLessThanOrEqual(200);
		// The most recently written entry must survive the cap.
		expect(getCachedRepoState("sess-259")).toBe("yes");
	});
});
