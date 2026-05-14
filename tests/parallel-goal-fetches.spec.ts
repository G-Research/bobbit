// ============================================================================
// Unit tests for `src/app/goal-dashboard-fetches.ts` — the Opt-D parallel
// fetch bundle used by the goal dashboard load path.
//
// Bundled with esbuild and run in a real browser so the timing assertions
// can use the same `performance.now()` clock the production code uses. Same
// pattern as `tests/perf-trace.spec.ts`.
// ============================================================================

import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/parallel-goal-fetches.html");
const BUNDLE = path.resolve("tests/fixtures/parallel-goal-fetches-bundle.js");
const ENTRY = path.resolve("tests/fixtures/parallel-goal-fetches-entry.ts");
const SOURCE = path.resolve("src/app/goal-dashboard-fetches.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(SOURCE).mtimeMs);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const TEST_PAGE = `file://${FIXTURE}`;

test.describe("runDashboardFetchBundle (Opt-D)", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);
	});

	test("flag-on: all eight fetches fire concurrently (start window <10ms)", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const run = (window as any).__runDashboardFetchBundle;
			const starts: Record<string, number> = {};
			const ends: Record<string, number> = {};
			const mk = (name: string, delay: number) => async () => {
				starts[name] = performance.now();
				await new Promise((r) => setTimeout(r, delay));
				ends[name] = performance.now();
				return name;
			};
			const t0 = performance.now();
			const bundle = await run({
				fetchGoal: mk("goal", 30),
				fetchTasks: mk("tasks", 30),
				fetchCommits: mk("commits", 30),
				fetchGates: mk("gates", 30),
				fetchGitStatus: mk("gitStatus", 30),
				fetchCost: mk("cost", 30),
				fetchPrStatus: mk("prStatus", 30),
				fetchTeam: mk("team", 30),
			}, true);
			const totalDur = performance.now() - t0;
			const startTimes = Object.values(starts);
			const startWindow = Math.max(...startTimes) - Math.min(...startTimes);
			return { startWindow, totalDur, bundle, starts, ends };
		});
		// All eight start within a tight window (well under one fetch's duration).
		expect(result.startWindow).toBeLessThan(10);
		// Total wall time is bounded by a single fetch + scheduling jitter.
		// 8 sequential 30ms fetches would take 240ms+; parallel = ~30-60ms.
		expect(result.totalDur).toBeLessThan(120);
		expect(result.bundle).toMatchObject({
			goal: "goal", tasks: "tasks", commits: "commits", gates: "gates",
			gitStatus: "gitStatus", cost: "cost", prStatus: "prStatus", team: "team",
		});
	});

	test("flag-off: team fetch starts only after the other seven complete", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const run = (window as any).__runDashboardFetchBundle;
			const starts: Record<string, number> = {};
			const ends: Record<string, number> = {};
			const mk = (name: string, delay: number) => async () => {
				starts[name] = performance.now();
				await new Promise((r) => setTimeout(r, delay));
				ends[name] = performance.now();
				return name;
			};
			const t0 = performance.now();
			const bundle = await run({
				fetchGoal: mk("goal", 30),
				fetchTasks: mk("tasks", 30),
				fetchCommits: mk("commits", 30),
				fetchGates: mk("gates", 30),
				fetchGitStatus: mk("gitStatus", 30),
				fetchCost: mk("cost", 30),
				fetchPrStatus: mk("prStatus", 30),
				fetchTeam: mk("team", 30),
			}, false);
			const totalDur = performance.now() - t0;
			return { totalDur, starts, ends, bundle };
		});
		// Team fetch must start after the slowest of the other seven ends.
		const slowestEnd = Math.max(
			result.ends.goal, result.ends.tasks, result.ends.commits, result.ends.gates,
			result.ends.gitStatus, result.ends.cost, result.ends.prStatus,
		);
		expect(result.starts.team).toBeGreaterThanOrEqual(slowestEnd - 1);
		// Sequential team adds a full extra fetch delay.
		expect(result.totalDur).toBeGreaterThanOrEqual(55);
		expect(result.bundle.team).toBe("team");
	});

	test("flag-on: an optional fetch failing does not abort the bundle", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const run = (window as any).__runDashboardFetchBundle;
			const ok = (v: string) => async () => v;
			const fail = () => async () => { throw new Error("boom"); };
			return run({
				fetchGoal: ok("goal"),
				fetchTasks: ok("tasks"),
				fetchCommits: fail(),
				fetchGates: ok("gates"),
				fetchGitStatus: fail(),
				fetchCost: fail(),
				fetchPrStatus: fail(),
				fetchTeam: fail(),
			}, true);
		});
		expect(result.goal).toBe("goal");
		expect(result.tasks).toBe("tasks");
		expect(result.gates).toBe("gates");
		// Optional fetchers that rejected surface as null.
		expect(result.commits).toBeNull();
		expect(result.gitStatus).toBeNull();
		expect(result.cost).toBeNull();
		expect(result.prStatus).toBeNull();
		expect(result.team).toBeNull();
	});

	test("flag-off: same null-on-error guarantees for optional fetches", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const run = (window as any).__runDashboardFetchBundle;
			const ok = (v: string) => async () => v;
			const fail = () => async () => { throw new Error("boom"); };
			return run({
				fetchGoal: ok("goal"),
				fetchTasks: ok("tasks"),
				fetchCommits: fail(),
				fetchGates: ok("gates"),
				fetchGitStatus: fail(),
				fetchCost: fail(),
				fetchPrStatus: fail(),
				fetchTeam: fail(),
			}, false);
		});
		expect(result.commits).toBeNull();
		expect(result.gitStatus).toBeNull();
		expect(result.cost).toBeNull();
		expect(result.prStatus).toBeNull();
		expect(result.team).toBeNull();
	});

	test("required fetch rejection propagates (caller wraps in try/catch)", async ({ page }) => {
		const errMsg = await page.evaluate(async () => {
			const run = (window as any).__runDashboardFetchBundle;
			const ok = (v: string) => async () => v;
			try {
				await run({
					fetchGoal: async () => { throw new Error("404"); },
					fetchTasks: ok("tasks"),
					fetchCommits: ok("commits"),
					fetchGates: ok("gates"),
					fetchGitStatus: ok("gs"),
					fetchCost: ok("cost"),
					fetchPrStatus: ok("pr"),
					fetchTeam: ok("team"),
				}, true);
				return "no-throw";
			} catch (e: any) {
				return e?.message ?? String(e);
			}
		});
		expect(errMsg).toBe("404");
	});
});
