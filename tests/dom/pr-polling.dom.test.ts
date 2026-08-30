import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests2/dom/_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/pr-polling.spec.ts (v2-dom tier).
// The legacy fixture REPRODUCED refreshPrStatusCache + the polling constants in
// plain JS. This port raises fidelity:
//   - the dedup behavior is exercised against the REAL exported
//     `refreshPrStatusCache` (its `_prRefreshInFlight` in-flight guard) with the
//     global fetch stubbed;
//   - the shared active PR interval is asserted directly, while lifecycle,
//     visibility, and independent Git/sidebar cadence wiring are pinned against
//     the real source so shipping call paths cannot silently drift.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { state } from "../../src/app/state.js";
import { ACTIVE_PR_POLL_INTERVAL_MS, fetchGitStatus, parseRemoteStateSnapshot, refreshPrStatusCache } from "../../src/app/api.js";

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

	it("cold coordinator envelopes stay data-less while flat legacy PR responses remain compatible", () => {
		const cold = parseRemoteStateSnapshot<{ state: string }>({
			observedAt: 123,
			stale: true,
			source: "pr",
		});
		expect(cold).toMatchObject({ observedAt: 123, stale: true, source: "pr" });
		expect(Object.prototype.hasOwnProperty.call(cold, "data")).toBe(false);

		const legacy = parseRemoteStateSnapshot<{ state: string }>({ state: "OPEN" });
		expect(legacy.data).toEqual({ state: "OPEN" });
	});

	it("does not install or clear PR badges from a cold metadata-only envelope", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
			observedAt: Date.now(),
			stale: true,
			source: "pr",
		}), { status: 200, headers: { "Content-Type": "application/json" } }));

		await refreshPrStatusCache(true);

		expect(state.prStatusCache.get("goal-1")).toEqual({ state: "OPEN" });
		expect(state.prStatusCache.get("goal-2")).toEqual({ state: "OPEN" });
	});

	it("classifies a cold Git envelope as pending instead of empty success", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
			observedAt: 456,
			stale: true,
			source: "repository",
		}), { status: 200, headers: { "Content-Type": "application/json" } }));

		const result = await fetchGitStatus("cold-session");

		expect(result).toEqual({
			kind: "pending",
			metadata: { observedAt: 456, stale: true, source: "repository" },
		});
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

	it("active PR demand is independently visibility-gated at 20 seconds", () => {
		expect(ACTIVE_PR_POLL_INTERVAL_MS).toBe(20_000);

		const sessionSrc = readFileSync(resolve("src/app/session-manager.ts"), "utf8");
		const sessionStart = sessionSrc.indexOf("function startActiveRemoteStatePolling");
		const sessionBody = sessionSrc.slice(sessionStart, sessionStart + 1000);
		expect(sessionStart).toBeGreaterThanOrEqual(0);
		expect(sessionBody).toContain('document.visibilityState !== "visible"');
		expect(sessionBody).toContain('refreshPrStatusForSession(sessionId, "automatic")');
		expect(sessionBody).toContain("ACTIVE_PR_POLL_INTERVAL_MS");

		const sessionStop = sessionSrc.slice(sessionSrc.indexOf("function stopActiveRemoteStatePolling"), sessionSrc.indexOf("function startActiveRemoteStatePolling"));
		expect(sessionStop).toContain("stopGitStatusPoll()");
		expect(sessionStop).toContain("clearInterval(prStatusPollTimer)");

		const dashboardSrc = readFileSync(resolve("src/app/goal-dashboard.ts"), "utf8");
		const dashboardStart = dashboardSrc.indexOf("function startGitStatusPolling");
		const dashboardBody = dashboardSrc.slice(dashboardStart, dashboardStart + 1800);
		expect(dashboardStart).toBeGreaterThanOrEqual(0);
		expect(dashboardBody).toContain('document.visibilityState !== "visible"');
		expect(dashboardBody).toContain('refreshGoalPrStatus(goalId, "automatic")');
		expect(dashboardBody).toContain("ACTIVE_PR_POLL_INTERVAL_MS");
	});

	it("dashboard keeps Git at 60 seconds and clears both active timers on teardown", () => {
		const src = readFileSync(resolve("src/app/goal-dashboard.ts"), "utf8");
		const fnStart = src.indexOf("function startGitStatusPolling");
		const fnBody = src.slice(fnStart, fnStart + 1800);
		expect(fnBody).toContain("}, 60_000);");

		const stopStart = src.indexOf("function stopGitStatusPolling");
		const stopBody = src.slice(stopStart, stopStart + 700);
		expect(stopBody).toContain("clearInterval(gitStatusPollTimer)");
		expect(stopBody).toContain("clearInterval(prStatusPollTimer)");
		expect(stopBody).toContain('removeEventListener("visibilitychange"');
	});
});
