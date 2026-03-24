/**
 * Unit tests for CostTracker — per-session token/cost accounting with disk persistence.
 * Uses a temp directory via BOBBIT_DIR env var to isolate from real state.
 *
 * Because CostTracker uses module-level constants (STORE_DIR/STORE_FILE) that read
 * BOBBIT_DIR at import time, we must set the env var BEFORE the module is loaded.
 * ESM hoists static imports, so we use dynamic import() instead.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// Set BOBBIT_DIR before dynamically importing CostTracker
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-tracker-test-"));
process.env.BOBBIT_DIR = tmpDir;
fs.mkdirSync(path.join(tmpDir, "state"), { recursive: true });

const STORE_FILE = path.join(tmpDir, "state", "session-costs.json");

// Dynamic import so BOBBIT_DIR is set before module-level constants are evaluated
const { CostTracker } = await import("../src/server/agent/cost-tracker.ts");

describe("CostTracker", () => {
	beforeEach(() => {
		try { fs.unlinkSync(STORE_FILE); } catch { /* ok */ }
	});

	after(() => {
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	describe("construction", () => {
		it("creates with empty costs when no store file exists", () => {
			const tracker = new CostTracker();
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

			const tracker = new CostTracker();
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
			const tracker = new CostTracker();
			assert.equal(tracker.getAllCosts().size, 0);
		});

		it("handles non-object JSON gracefully", () => {
			fs.writeFileSync(STORE_FILE, JSON.stringify([1, 2, 3]), "utf-8");
			const tracker = new CostTracker();
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

			const tracker = new CostTracker();
			const cost = tracker.getSessionCost("session-1");
			assert.ok(cost);
			assert.equal(cost.inputTokens, 0);
			assert.equal(cost.outputTokens, 0);
			assert.equal(cost.totalCost, 0.5);
		});
	});

	describe("recordUsage", () => {
		it("records usage for a new session", () => {
			const tracker = new CostTracker();
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
			const tracker = new CostTracker();
			tracker.recordUsage("s1", { inputTokens: 100, outputTokens: 50, cost: 0.005 });
			const result = tracker.recordUsage("s1", { inputTokens: 200, outputTokens: 100, cost: 0.01 });
			assert.equal(result.inputTokens, 300);
			assert.equal(result.outputTokens, 150);
			assert.equal(result.totalCost, 0.015);
		});

		it("handles partial usage data (undefined fields treated as 0)", () => {
			const tracker = new CostTracker();
			const result = tracker.recordUsage("s1", { inputTokens: 100 });
			assert.equal(result.inputTokens, 100);
			assert.equal(result.outputTokens, 0);
			assert.equal(result.cacheReadTokens, 0);
			assert.equal(result.cacheWriteTokens, 0);
			assert.equal(result.totalCost, 0);
		});

		it("handles empty usage object", () => {
			const tracker = new CostTracker();
			const result = tracker.recordUsage("s1", {});
			assert.equal(result.inputTokens, 0);
			assert.equal(result.totalCost, 0);
		});

		it("records all token types including cache tokens", () => {
			const tracker = new CostTracker();
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
			const tracker = new CostTracker();
			tracker.recordUsage("s1", { cost: 0.1 });
			const result = tracker.recordUsage("s1", { cost: 0.2 });
			assert.equal(result.totalCost, 0.3);
		});

		it("persists to disk after recording", () => {
			const tracker = new CostTracker();
			tracker.recordUsage("s1", { inputTokens: 42, cost: 0.001 });

			const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.ok(raw["s1"]);
			assert.equal(raw["s1"].inputTokens, 42);
		});

		it("returns a copy (modifying return value doesn't affect tracker)", () => {
			const tracker = new CostTracker();
			const result = tracker.recordUsage("s1", { inputTokens: 100 });
			result.inputTokens = 999;
			assert.equal(tracker.getSessionCost("s1")!.inputTokens, 100);
		});
	});

	describe("getSessionCost", () => {
		it("returns undefined for unknown session", () => {
			const tracker = new CostTracker();
			assert.equal(tracker.getSessionCost("nonexistent"), undefined);
		});

		it("returns a copy of the session cost", () => {
			const tracker = new CostTracker();
			tracker.recordUsage("s1", { inputTokens: 100 });
			const cost = tracker.getSessionCost("s1")!;
			cost.inputTokens = 999;
			assert.equal(tracker.getSessionCost("s1")!.inputTokens, 100);
		});
	});

	describe("getGoalCost", () => {
		it("aggregates costs across multiple sessions", () => {
			const tracker = new CostTracker();
			tracker.recordUsage("s1", { inputTokens: 100, outputTokens: 50, cost: 0.01 });
			tracker.recordUsage("s2", { inputTokens: 200, outputTokens: 100, cost: 0.02 });

			const total = tracker.getGoalCost("goal-1", ["s1", "s2"]);
			assert.equal(total.inputTokens, 300);
			assert.equal(total.outputTokens, 150);
			assert.equal(total.totalCost, 0.03);
		});

		it("skips sessions without cost data", () => {
			const tracker = new CostTracker();
			tracker.recordUsage("s1", { inputTokens: 100, cost: 0.01 });

			const total = tracker.getGoalCost("goal-1", ["s1", "s-nonexistent"]);
			assert.equal(total.inputTokens, 100);
			assert.equal(total.totalCost, 0.01);
		});

		it("returns zero costs for empty session list", () => {
			const tracker = new CostTracker();
			const total = tracker.getGoalCost("goal-1", []);
			assert.equal(total.inputTokens, 0);
			assert.equal(total.totalCost, 0);
		});

		it("returns zero costs when no sessions have data", () => {
			const tracker = new CostTracker();
			const total = tracker.getGoalCost("goal-1", ["x", "y"]);
			assert.equal(total.inputTokens, 0);
		});
	});

	describe("getAllCosts", () => {
		it("returns all tracked sessions", () => {
			const tracker = new CostTracker();
			tracker.recordUsage("s1", { inputTokens: 10 });
			tracker.recordUsage("s2", { inputTokens: 20 });

			const all = tracker.getAllCosts();
			assert.equal(all.size, 2);
			assert.ok(all.has("s1"));
			assert.ok(all.has("s2"));
		});

		it("returns an independent copy", () => {
			const tracker = new CostTracker();
			tracker.recordUsage("s1", { inputTokens: 10 });
			const all = tracker.getAllCosts();
			all.delete("s1");
			assert.equal(tracker.getAllCosts().size, 1);
		});
	});

	describe("removeSession", () => {
		it("removes a session's cost data", () => {
			const tracker = new CostTracker();
			tracker.recordUsage("s1", { inputTokens: 100 });
			tracker.removeSession("s1");
			assert.equal(tracker.getSessionCost("s1"), undefined);
		});

		it("persists removal to disk", () => {
			const tracker = new CostTracker();
			tracker.recordUsage("s1", { inputTokens: 100 });
			tracker.removeSession("s1");

			const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
			assert.equal(raw["s1"], undefined);
		});

		it("is a no-op for nonexistent session (no crash)", () => {
			const tracker = new CostTracker();
			tracker.removeSession("nonexistent");
		});
	});

	describe("persistence round-trip", () => {
		it("survives save and reload", () => {
			const tracker1 = new CostTracker();
			tracker1.recordUsage("s1", {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 200,
				cacheWriteTokens: 30,
				cost: 0.015,
			});
			tracker1.recordUsage("s2", { inputTokens: 500, cost: 0.05 });

			const tracker2 = new CostTracker();
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
});
