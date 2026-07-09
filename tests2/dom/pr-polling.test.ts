import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/pr-polling.spec.ts (v2-dom tier).
// The legacy fixture REPRODUCED refreshPrStatusCache + the polling constants in
// plain JS. This port raises fidelity:
//   - the dedup behavior is exercised against the REAL exported
//     `refreshPrStatusCache` (its `_prRefreshInFlight` in-flight guard) with the
//     global fetch stubbed;
//   - the poll-interval constants and the visibility gate are module-private in
//     src (not exported), so they are pinned by reading the REAL source files —
//     higher fidelity than asserting a value re-typed into a fixture, and it
//     cannot silently drift from the shipping code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { state } from "../../src/app/state.js";
import { refreshPrStatusCache } from "../../src/app/api.js";

let fetchLog: string[];

beforeEach(() => {
	fetchLog = [];
	vi.stubGlobal("fetch", async (input: any) => {
		const url = typeof input === "string" ? input : (input && input.url) || String(input);
		fetchLog.push(String(url));
		return new Response(JSON.stringify({ state: "OPEN", url: "https://github.com/pr/1", number: 1 }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	state.goals = [
		{ id: "goal-1", branch: "feature/one" } as any,
		{ id: "goal-2", branch: "feature/two" } as any,
		{ id: "goal-3", branch: null } as any, // no branch — skipped
	];
	state.prStatusCache.clear();
	state.prStatusCache.set("goal-1", { state: "OPEN" });
	state.prStatusCache.set("goal-2", { state: "OPEN" });
});

afterEach(() => {
	vi.unstubAllGlobals();
	state.goals = [];
	state.prStatusCache.clear();
});

describe("PR polling deduplication and rate limiting", () => {
	it("refreshPrStatusCache in-flight guard blocks duplicate concurrent batches", async () => {
		const p1 = refreshPrStatusCache(true);
		const p2 = refreshPrStatusCache(true);
		await Promise.all([p1, p2]);

		const prFetches = fetchLog.filter((u) => u.includes("/pr-status"));
		// 2 goals with branches → one batch = 2 fetches. Without the guard the
		// second concurrent call would fan out a second batch (4 total).
		expect(prFetches.length).toBe(2);
	});

	it("PR_POLL_INTERVAL_MS (api.ts) is at least 60 seconds", () => {
		const src = readFileSync(resolve("src/app/api.ts"), "utf8");
		const m = /PR_POLL_INTERVAL_MS\s*=\s*([\d_]+)/.exec(src);
		expect(m).toBeTruthy();
		const interval = Number(m![1].replace(/_/g, ""));
		expect(interval).toBeGreaterThanOrEqual(60_000);
	});

	it("session PR polling is gated behind document.visibilityState === 'visible'", () => {
		const src = readFileSync(resolve("src/app/api.ts"), "utf8");
		expect(src).toContain('document.visibilityState === "visible"');
	});

	it("goal dashboard git+PR polling interval is at least 60 seconds and visibility-gated", () => {
		const src = readFileSync(resolve("src/app/goal-dashboard.ts"), "utf8");
		const fnStart = src.indexOf("function startGitStatusPolling");
		expect(fnStart).toBeGreaterThanOrEqual(0);
		const fnBody = src.slice(fnStart, fnStart + 2000);
		// Visibility gate present in the poll tick.
		expect(fnBody).toContain('document.visibilityState !== "visible"');
		// The setInterval period at the tail of the poller.
		const m = /\}\s*,\s*([\d_]+)\s*\)\s*;/.exec(fnBody);
		expect(m).toBeTruthy();
		const interval = Number(m![1].replace(/_/g, ""));
		expect(interval).toBeGreaterThanOrEqual(60_000);
	});
});
