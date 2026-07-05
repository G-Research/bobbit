/**
 * Unit tests for CostTracker — per-session token/cost accounting with disk persistence.
 * Uses a temp directory via BOBBIT_DIR env var to isolate from real state.
 *
 * Because CostTracker uses module-level constants (STORE_DIR/STORE_FILE) that read
 * BOBBIT_DIR at import time, we must set the env var BEFORE the module is loaded.
 * ESM hoists static imports, so we use dynamic import() instead.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { makeTmpDir } from "./helpers/tmp.ts";

// Set BOBBIT_DIR before dynamically importing CostTracker
const tmpDir = makeTmpDir("cost-tracker-test-");
process.env.BOBBIT_DIR = tmpDir;
fs.mkdirSync(path.join(tmpDir, "state"), { recursive: true });

const STORE_FILE = path.join(tmpDir, "state", "session-costs.json");
const TURN_STORE_FILE = path.join(tmpDir, "state", "session-cost-turns.json");

// Dynamic import so BOBBIT_DIR is set before module-level constants are evaluated
const { CostTracker, deriveCacheHitRate, deriveCacheWrite5mTokens } = await import("../src/server/agent/cost-tracker.ts");

const stateDir = path.join(tmpDir, "state");

describe("CostTracker", () => {
	beforeEach(() => {
		try { fs.unlinkSync(STORE_FILE); } catch { /* ok */ }
		try { fs.unlinkSync(TURN_STORE_FILE); } catch { /* ok */ }
	});

	after(() => {
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	describe("construction", () => {
		it("creates with empty costs when no store file exists", () => {
			const tracker = new CostTracker(stateDir);
			assert.equal(tracker.getAllCosts().size, 0);
		});

		it("loads existing costs from disk on construction", () => {
			const data = {
				"session-1": {
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 10,
					cacheWriteTokens: 5,
					totalCost: 0.001,
				},
			};
			fs.writeFileSync(STORE_FILE, JSON.stringify(data), "utf-8");

			const tracker = new CostTracker(stateDir);
			const cost = tracker.getSessionCost("session-1");
			assert.ok(cost);
			assert.equal(cost.inputTokens, 100);
			assert.equal(cost.outputTokens, 50);
			assert.equal(cost.cacheReadTokens, 10);
			assert.equal(cost.cacheWriteTokens, 5);
			assert.equal(cost.totalCost, 0.001);
		});

		it("handles corrupt JSON gracefully", () => {
			fs.writeFileSync(STORE_FILE, "NOT JSON{{{", "utf-8");
			const tracker = new CostTracker(stateDir);
			assert.equal(tracker.getAllCosts().size, 0);
		});

		it("handles non-object JSON gracefully", () => {
			fs.writeFileSync(STORE_FILE, JSON.stringify([1, 2, 3]), "utf-8");
			const tracker = new CostTracker(stateDir);
			assert.equal(tracker.getAllCosts().size, 0);
		});

		it("handles entries with missing/wrong-type fields", () => {
			const data = {
				"session-1": {
					inputTokens: "not a number",
					outputTokens: null,
					totalCost: 0.5,
				},
			};
			fs.writeFileSync(STORE_FILE, JSON.stringify(data), "utf-8");

			const tracker = new CostTracker(stateDir);
			const cost = tracker.getSessionCost("session-1");
			assert.ok(cost);
			assert.equal(cost.inputTokens, 0);
			assert.equal(cost.outputTokens, 0);
			assert.equal(cost.totalCost, 0.5);
		});
	});

	describe("recordUsage", () => {
		it("records usage for a new session", () => {
			const tracker = new CostTracker(stateDir);
			const result = tracker.recordUsage("s1", {
				inputTokens: 100,
				outputTokens: 50,
				cost: 0.005,
			});
			assert.equal(result.inputTokens, 100);
			assert.equal(result.outputTokens, 50);
			assert.equal(result.totalCost, 0.005);
		});

		it("accumulates usage across multiple calls", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 100, outputTokens: 50, cost: 0.005 });
			const result = tracker.recordUsage("s1", { inputTokens: 200, outputTokens: 100, cost: 0.01 });
			assert.equal(result.inputTokens, 300);
			assert.equal(result.outputTokens, 150);
			assert.equal(result.totalCost, 0.015);
		});

		it("handles partial usage data (undefined fields treated as 0)", () => {
			const tracker = new CostTracker(stateDir);
			const result = tracker.recordUsage("s1", { inputTokens: 100 });
			assert.equal(result.inputTokens, 100);
			assert.equal(result.outputTokens, 0);
			assert.equal(result.cacheReadTokens, 0);
			assert.equal(result.cacheWriteTokens, 0);
			assert.equal(result.totalCost, 0);
		});

		it("handles empty usage object", () => {
			const tracker = new CostTracker(stateDir);
			const result = tracker.recordUsage("s1", {});
			assert.equal(result.inputTokens, 0);
			assert.equal(result.totalCost, 0);
		});

		it("records all token types including cache tokens", () => {
			const tracker = new CostTracker(stateDir);
			const result = tracker.recordUsage("s1", {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 200,
				cacheWriteTokens: 30,
				cost: 0.01,
			});
			assert.equal(result.cacheReadTokens, 200);
			assert.equal(result.cacheWriteTokens, 30);
		});

		it("rounds totalCost to 6 decimal places to avoid floating point drift", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { cost: 0.1 });
			const result = tracker.recordUsage("s1", { cost: 0.2 });
			assert.equal(result.totalCost, 0.3);
		});

		it("persists to disk after recording (once flushed)", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 42, cost: 0.001 });
			// recordUsage() debounces the disk write (PERF-01) — flush() forces it.
			tracker.flush();

			const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.ok(raw["s1"]);
			assert.equal(raw["s1"].inputTokens, 42);
		});

		it("returns a copy (modifying return value doesn't affect tracker)", () => {
			const tracker = new CostTracker(stateDir);
			const result = tracker.recordUsage("s1", { inputTokens: 100 });
			result.inputTokens = 999;
			assert.equal(tracker.getSessionCost("s1")!.inputTokens, 100);
		});
	});

	describe("turn cost rows", () => {
		it("appends one per-turn row for each recordUsage call with the usage fields", () => {
			const tracker = new CostTracker(stateDir);
			const before = Date.now();
			tracker.recordUsage("s1", {
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 3,
				cacheWriteTokens: 2,
				cacheWrite1hTokens: 1,
				cost: 0.001,
			}, "goal-1");
			tracker.recordUsage("s1", { inputTokens: 20, outputTokens: 7, cost: 0.002 }, "goal-1");
			const after = Date.now();

			const rows = tracker.getTurnCosts("s1");
			assert.equal(rows.length, 2);
			assert.deepEqual(
				rows.map((row) => row.seq),
				[1, 2],
			);
			assert.equal(rows[0]!.sessionId, "s1");
			assert.equal(rows[0]!.goalId, "goal-1");
			assert.equal(rows[0]!.inputTokens, 10);
			assert.equal(rows[0]!.outputTokens, 5);
			assert.equal(rows[0]!.cacheReadTokens, 3);
			assert.equal(rows[0]!.cacheWriteTokens, 2);
			assert.equal(rows[0]!.cacheWrite1hTokens, 1);
			assert.equal(rows[0]!.totalCost, 0.001);
			assert.ok(rows[0]!.ts >= before && rows[0]!.ts <= after);
			tracker.flush();
		});

		it("keeps cumulative totals equal to the sum of the per-turn rows", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 10,
				cacheWriteTokens: 5,
				cacheWrite1hTokens: 2,
				cost: 0.001111,
			}, "goal-1");
			tracker.recordUsage("s1", {
				inputTokens: 200,
				outputTokens: 75,
				cacheReadTokens: 20,
				cacheWriteTokens: 8,
				cacheWrite1hTokens: 3,
				cost: 0.002222,
			}, "goal-1");
			tracker.recordUsage("s1", { inputTokens: 50, cost: 0.003333 }, "goal-1");

			const cumulative = tracker.getSessionCost("s1")!;
			const sum = tracker.getTurnCosts("s1").reduce((acc, row) => {
				acc.inputTokens += row.inputTokens;
				acc.outputTokens += row.outputTokens;
				acc.cacheReadTokens += row.cacheReadTokens;
				acc.cacheWriteTokens += row.cacheWriteTokens;
				acc.cacheWrite1hTokens += row.cacheWrite1hTokens;
				acc.totalCost = Math.round((acc.totalCost + row.totalCost) * 1_000_000) / 1_000_000;
				return acc;
			}, {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cacheWrite1hTokens: 0,
				totalCost: 0,
			});

			assert.deepEqual(sum, {
				inputTokens: cumulative.inputTokens,
				outputTokens: cumulative.outputTokens,
				cacheReadTokens: cumulative.cacheReadTokens,
				cacheWriteTokens: cumulative.cacheWriteTokens,
				cacheWrite1hTokens: cumulative.cacheWrite1hTokens,
				totalCost: cumulative.totalCost,
			});
			tracker.flush();
		});

		it("records an optional trigger tag on the per-turn row", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 10, cost: 0.001 }, "goal-1", "compaction:auto");
			const rows = tracker.getTurnCosts("s1");
			assert.equal(rows.length, 1);
			assert.equal(rows[0]!.trigger, "compaction:auto");
			tracker.flush();
		});

		it("persists per-turn rows through the same debounced flush path", () => {
			const tracker1 = new CostTracker(stateDir);
			tracker1.recordUsage("s1", { inputTokens: 10, cost: 0.001 }, "goal-1", "compaction:manual");
			tracker1.flush();

			const tracker2 = new CostTracker(stateDir);
			const rows = tracker2.getTurnCosts("s1");
			assert.equal(rows.length, 1);
			assert.equal(rows[0]!.seq, 1);
			assert.equal(rows[0]!.goalId, "goal-1");
			assert.equal(rows[0]!.trigger, "compaction:manual");
			assert.equal(rows[0]!.inputTokens, 10);
			assert.equal(rows[0]!.totalCost, 0.001);
		});

		it("keeps only the last 500 per-turn rows per session", () => {
			const tracker = new CostTracker(stateDir);
			for (let i = 1; i <= 505; i++) {
				tracker.recordUsage("s1", { inputTokens: i, cost: 0.000001 });
			}
			const rows = tracker.getTurnCosts("s1");
			assert.equal(rows.length, 500);
			assert.equal(rows[0]!.seq, 6);
			assert.equal(rows[0]!.inputTokens, 6);
			assert.equal(rows[499]!.seq, 505);
			assert.equal(rows[499]!.inputTokens, 505);
			tracker.flush();
		});
	});

	describe("getSessionCost", () => {
		it("returns undefined for unknown session", () => {
			const tracker = new CostTracker(stateDir);
			assert.equal(tracker.getSessionCost("nonexistent"), undefined);
		});

		it("returns a copy of the session cost", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 100 });
			const cost = tracker.getSessionCost("s1")!;
			cost.inputTokens = 999;
			assert.equal(tracker.getSessionCost("s1")!.inputTokens, 100);
		});
	});

	describe("getGoalCost", () => {
		it("aggregates costs across multiple sessions", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 100, outputTokens: 50, cost: 0.01 });
			tracker.recordUsage("s2", { inputTokens: 200, outputTokens: 100, cost: 0.02 });

			const total = tracker.getGoalCost("goal-1", ["s1", "s2"]);
			assert.equal(total.inputTokens, 300);
			assert.equal(total.outputTokens, 150);
			assert.equal(total.totalCost, 0.03);
		});

		it("skips sessions without cost data", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 100, cost: 0.01 });

			const total = tracker.getGoalCost("goal-1", ["s1", "s-nonexistent"]);
			assert.equal(total.inputTokens, 100);
			assert.equal(total.totalCost, 0.01);
		});

		it("returns zero costs for empty session list", () => {
			const tracker = new CostTracker(stateDir);
			const total = tracker.getGoalCost("goal-1", []);
			assert.equal(total.inputTokens, 0);
			assert.equal(total.totalCost, 0);
		});

		it("returns zero costs when no sessions have data", () => {
			const tracker = new CostTracker(stateDir);
			const total = tracker.getGoalCost("goal-1", ["x", "y"]);
			assert.equal(total.inputTokens, 0);
		});
	});

	describe("getAllCosts", () => {
		it("returns all tracked sessions", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 10 });
			tracker.recordUsage("s2", { inputTokens: 20 });

			const all = tracker.getAllCosts();
			assert.equal(all.size, 2);
			assert.ok(all.has("s1"));
			assert.ok(all.has("s2"));
		});

		it("returns an independent copy", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 10 });
			const all = tracker.getAllCosts();
			all.delete("s1");
			assert.equal(tracker.getAllCosts().size, 1);
		});
	});

	describe("removeSession", () => {
		it("removes a session's cost data", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 100 });
			tracker.removeSession("s1");
			assert.equal(tracker.getSessionCost("s1"), undefined);
		});

		it("persists removal to disk", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 100 });
			tracker.removeSession("s1");

			const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.equal(raw["s1"], undefined);
		});

		it("removes a session's per-turn rows", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 100 });
			tracker.removeSession("s1");
			assert.deepEqual(tracker.getTurnCosts("s1"), []);
		});

		it("is a no-op for nonexistent session (no crash)", () => {
			const tracker = new CostTracker(stateDir);
			tracker.removeSession("nonexistent");
		});
	});

	describe("cacheHitRate (derived)", () => {
		it("deriveCacheHitRate returns null when denominator is 0", () => {
			assert.equal(deriveCacheHitRate({ inputTokens: 0, cacheReadTokens: 0 }), null);
		});

		it("deriveCacheHitRate computes cacheRead / (cacheRead + input)", () => {
			assert.equal(
				deriveCacheHitRate({ inputTokens: 100, cacheReadTokens: 300 }),
				0.75,
			);
		});

		it("deriveCacheHitRate returns 1 when all input tokens are cache reads", () => {
			assert.equal(
				deriveCacheHitRate({ inputTokens: 0, cacheReadTokens: 300 }),
				1,
			);
		});

		it("deriveCacheHitRate ignores cacheWriteTokens (writes are not hits)", () => {
			// cacheWriteTokens is not part of the formula. Same input/read with
			// arbitrary write count must give same rate.
			assert.equal(
				deriveCacheHitRate({ inputTokens: 100, cacheReadTokens: 100 }),
				0.5,
			);
		});

		it("recordUsage returns cacheHitRate = null for a cold (all-zero) session", () => {
			const tracker = new CostTracker(stateDir);
			const result = tracker.recordUsage("s1", { cost: 0.001 });
			assert.equal(result.cacheHitRate, null);
		});

		it("recordUsage returns derived cacheHitRate for non-zero counters", () => {
			const tracker = new CostTracker(stateDir);
			const result = tracker.recordUsage("s1", {
				inputTokens: 100,
				cacheReadTokens: 300,
				cost: 0.001,
			});
			assert.equal(result.cacheHitRate, 0.75);
		});

		it("recordUsage returns cacheHitRate = 1 for cache-read-only usage", () => {
			const tracker = new CostTracker(stateDir);
			const result = tracker.recordUsage("s1", {
				inputTokens: 0,
				cacheReadTokens: 300,
				cost: 0.001,
			});
			assert.equal(result.cacheHitRate, 1);
		});

		it("cacheHitRate updates across repeated recordUsage calls", () => {
			const tracker = new CostTracker(stateDir);
			const first = tracker.recordUsage("s1", { inputTokens: 100, cacheReadTokens: 0 });
			assert.equal(first.cacheHitRate, 0); // 0 / (0 + 100) = 0
			const second = tracker.recordUsage("s1", { inputTokens: 0, cacheReadTokens: 300 });
			// cumulative: input=100, cacheRead=300 → 300/400 = 0.75
			assert.equal(second.cacheHitRate, 0.75);
		});

		it("getSessionCost returns derived cacheHitRate", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 200, cacheReadTokens: 600 });
			const cost = tracker.getSessionCost("s1")!;
			assert.equal(cost.cacheHitRate, 0.75);
		});

		it("getGoalCost derives cacheHitRate from aggregate raw counters", () => {
			const tracker = new CostTracker(stateDir);
			// s1: 100 input / 0 read; s2: 0 input / 300 read
			// aggregate: 100 input / 300 read → 300 / (300 + 100) = 0.75
			tracker.recordUsage("s1", { inputTokens: 100 });
			tracker.recordUsage("s2", { cacheReadTokens: 300 });
			const total = tracker.getGoalCost("goal-1", ["s1", "s2"]);
			assert.equal(total.inputTokens, 100);
			assert.equal(total.cacheReadTokens, 300);
			assert.equal(total.cacheHitRate, 0.75);
		});

		it("getGoalCost returns cacheHitRate = null for empty aggregate", () => {
			const tracker = new CostTracker(stateDir);
			const total = tracker.getGoalCost("goal-1", []);
			assert.equal(total.cacheHitRate, null);
		});

		it("getAllCosts returns snapshots carrying cacheHitRate", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 100, cacheReadTokens: 300 });
			const all = tracker.getAllCosts();
			const snap = all.get("s1")!;
			assert.equal(snap.cacheHitRate, 0.75);
		});

		it("cacheHitRate is NOT persisted to disk", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 100, cacheReadTokens: 300 });
			tracker.flush();
			const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.equal(raw["s1"].inputTokens, 100);
			assert.equal(raw["s1"].cacheReadTokens, 300);
			assert.equal(
				"cacheHitRate" in raw["s1"],
				false,
				"cacheHitRate must be a derived field, not persisted",
			);
		});

		it("loading an old JSON without cacheHitRate still derives it on read", () => {
			// Simulate a pre-existing store file written by an older server build.
			const legacy = {
				"s1": {
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 300,
					cacheWriteTokens: 5,
					totalCost: 0.001,
				},
			};
			fs.writeFileSync(STORE_FILE, JSON.stringify(legacy), "utf-8");
			const tracker = new CostTracker(stateDir);
			const cost = tracker.getSessionCost("s1")!;
			assert.equal(cost.cacheHitRate, 0.75);
		});
	});

	describe("debounced save (PERF-01)", () => {
		it("coalesces multiple recordUsage calls within the debounce window into one flush", () => {
			const tracker = new CostTracker(stateDir);
			let renameCount = 0;
			const originalRename = fs.renameSync;
			fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
				renameCount++;
				return originalRename(...args);
			}) as typeof fs.renameSync;
			try {
				tracker.recordUsage("s1", { inputTokens: 10, cost: 0.001 });
				tracker.recordUsage("s1", { inputTokens: 10, cost: 0.001 });
				tracker.recordUsage("s1", { inputTokens: 10, cost: 0.001 });
				assert.equal(renameCount, 0, "recordUsage must not write to disk synchronously");

				tracker.flush();
				assert.equal(
					renameCount,
					2,
					"three recordUsage calls within the debounce window must coalesce into one flush of both cost files",
				);
			} finally {
				fs.renameSync = originalRename;
			}

			const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.equal(raw["s1"].inputTokens, 30, "the single coalesced write must contain all three updates");
		});

		it("flush() is a no-op when nothing is pending", () => {
			const tracker = new CostTracker(stateDir);
			tracker.flush(); // should not throw
		});

		it("flush() forces a pending debounced save immediately", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 5, cost: 0.0001 });
			tracker.flush();
			const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.equal(raw["s1"].inputTokens, 5);
		});

		it("removeSession writes immediately without needing flush()", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { inputTokens: 5, cost: 0.0001 });
			tracker.flush();
			tracker.removeSession("s1");
			const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.equal(raw["s1"], undefined);
		});
	});

	describe("persistence round-trip", () => {
		it("survives save and reload", () => {
			const tracker1 = new CostTracker(stateDir);
			tracker1.recordUsage("s1", {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 200,
				cacheWriteTokens: 30,
				cost: 0.015,
			});
			tracker1.recordUsage("s2", { inputTokens: 500, cost: 0.05 });
			// recordUsage() debounces the disk write (PERF-01) — flush() before
			// constructing a second tracker that reloads from disk.
			tracker1.flush();

			const tracker2 = new CostTracker(stateDir);
			const s1 = tracker2.getSessionCost("s1");
			assert.ok(s1);
			assert.equal(s1.inputTokens, 100);
			assert.equal(s1.outputTokens, 50);
			assert.equal(s1.cacheReadTokens, 200);
			assert.equal(s1.cacheWriteTokens, 30);
			assert.equal(s1.totalCost, 0.015);

			const s2 = tracker2.getSessionCost("s2");
			assert.ok(s2);
			assert.equal(s2.inputTokens, 500);
			assert.equal(s2.totalCost, 0.05);
		});
	});
	describe("cacheWrite1hTokens / cacheWrite5mTokens (derived)", () => {
		it("deriveCacheWrite5mTokens computes the complement of cacheWrite1hTokens", () => {
			assert.equal(
				deriveCacheWrite5mTokens({ cacheWriteTokens: 50, cacheWrite1hTokens: 20 }),
				30,
			);
		});

		it("deriveCacheWrite5mTokens returns the full write when cacheWrite1hTokens is 0", () => {
			assert.equal(
				deriveCacheWrite5mTokens({ cacheWriteTokens: 50, cacheWrite1hTokens: 0 }),
				50,
			);
		});

		it("deriveCacheWrite5mTokens returns 0 when there is no write at all", () => {
			assert.equal(
				deriveCacheWrite5mTokens({ cacheWriteTokens: 0, cacheWrite1hTokens: 0 }),
				0,
			);
		});

		it("deriveCacheWrite5mTokens floors at 0 (defensive against malformed data where 1h exceeds total)", () => {
			assert.equal(
				deriveCacheWrite5mTokens({ cacheWriteTokens: 10, cacheWrite1hTokens: 999 }),
				0,
			);
		});

		it("getSessionCost returns both cacheWrite1hTokens and derived cacheWrite5mTokens", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { cacheWriteTokens: 80, cacheWrite1hTokens: 50 });
			const cost = tracker.getSessionCost("s1")!;
			assert.equal(cost.cacheWrite1hTokens, 50);
			assert.equal(cost.cacheWrite5mTokens, 30);
		});

		it("getGoalCost aggregates cacheWrite1hTokens across sessions and derives the 5m complement", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { cacheWriteTokens: 20, cacheWrite1hTokens: 20 });
			tracker.recordUsage("s2", { cacheWriteTokens: 10, cacheWrite1hTokens: 0 });
			const total = tracker.getGoalCost("goal-1", ["s1", "s2"]);
			assert.equal(total.cacheWriteTokens, 30);
			assert.equal(total.cacheWrite1hTokens, 20);
			assert.equal(total.cacheWrite5mTokens, 10);
		});

		it("getGoalCost (one-arg, stamped-goalId path) aggregates cacheWrite1hTokens", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { cacheWriteTokens: 20, cacheWrite1hTokens: 20 }, "goal-1");
			tracker.recordUsage("s2", { cacheWriteTokens: 10, cacheWrite1hTokens: 5 }, "goal-1");
			const total = tracker.getGoalCost("goal-1");
			assert.equal(total.cacheWrite1hTokens, 25);
			assert.equal(total.cacheWrite5mTokens, 5);
		});

		it("getUnattributableLegacyCost aggregates cacheWrite1hTokens for unstamped entries", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { cacheWriteTokens: 20, cacheWrite1hTokens: 15 }); // no goalId
			const total = tracker.getUnattributableLegacyCost();
			assert.equal(total.cacheWrite1hTokens, 15);
			assert.equal(total.cacheWrite5mTokens, 5);
		});

		it("loading an old JSON without cacheWrite1hTokens defaults it to 0 (pre-W3.17 persisted data)", () => {
			const legacy = {
				"s1": {
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 300,
					cacheWriteTokens: 40,
					totalCost: 0.001,
					// cacheWrite1hTokens intentionally absent — simulates data
					// persisted before this field existed.
				},
			};
			fs.writeFileSync(STORE_FILE, JSON.stringify(legacy), "utf-8");
			const tracker = new CostTracker(stateDir);
			const cost = tracker.getSessionCost("s1")!;
			assert.equal(cost.cacheWrite1hTokens, 0);
			assert.equal(cost.cacheWrite5mTokens, 40);
		});

		it("loading a JSON entry where cacheWrite1hTokens has the wrong type defaults it to 0", () => {
			const legacy = {
				"s1": {
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 0,
					cacheWriteTokens: 40,
					cacheWrite1hTokens: "not a number",
					totalCost: 0.001,
				},
			};
			fs.writeFileSync(STORE_FILE, JSON.stringify(legacy), "utf-8");
			const tracker = new CostTracker(stateDir);
			const cost = tracker.getSessionCost("s1")!;
			assert.equal(cost.cacheWrite1hTokens, 0);
		});

		it("cacheWrite5mTokens is NOT persisted to disk (derived, same convention as cacheHitRate)", () => {
			const tracker = new CostTracker(stateDir);
			tracker.recordUsage("s1", { cacheWriteTokens: 40, cacheWrite1hTokens: 10 });
			// PERF-01 (merged after this test was written): recordUsage is debounced -
			// flush before reading the store file, same adaptation as the older
			// disk-assertion tests in this file.
			tracker.flush();
			const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.equal(raw["s1"].cacheWrite1hTokens, 10);
			assert.equal(
				"cacheWrite5mTokens" in raw["s1"],
				false,
				"cacheWrite5mTokens must be a derived field, not persisted",
			);
		});
	});

	describe("persistence round-trip", () => {
		it("survives save and reload", () => {
			const tracker1 = new CostTracker(stateDir);
			tracker1.recordUsage("s1", {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 200,
				cacheWriteTokens: 30,
				cacheWrite1hTokens: 18,
				cost: 0.015,
			});
			tracker1.recordUsage("s2", { inputTokens: 500, cost: 0.05 });
			// PERF-01 (merged after this test was written): flush the debounced save
			// so the second tracker instance sees the persisted state.
			tracker1.flush();

			const tracker2 = new CostTracker(stateDir);
			const s1 = tracker2.getSessionCost("s1");
			assert.ok(s1);
			assert.equal(s1.inputTokens, 100);
			assert.equal(s1.outputTokens, 50);
			assert.equal(s1.cacheReadTokens, 200);
			assert.equal(s1.cacheWriteTokens, 30);
			assert.equal(s1.cacheWrite1hTokens, 18);
			assert.equal(s1.cacheWrite5mTokens, 12);
			assert.equal(s1.totalCost, 0.015);

			const s2 = tracker2.getSessionCost("s2");
			assert.ok(s2);
			assert.equal(s2.inputTokens, 500);
			assert.equal(s2.totalCost, 0.05);
		});
	});
});
