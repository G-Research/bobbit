/**
 * Unit tests for goalId stamping in CostTracker.
 *
 * Verifies:
 *  - `recordUsage(sid, usage, goalId)` stamps the goalId onto the entry.
 *  - Write-once semantics: a subsequent call with a different goalId does
 *    NOT overwrite; a call with omitted goalId does NOT clear it.
 *  - One-arg `getGoalCost(goalId)` aggregates across entries stamped with
 *    that goalId — no sessionIds needed (survives session purge).
 *  - The goalId is persisted to disk and rehydrated on load.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-tracker-goal-stamp-"));
process.env.BOBBIT_DIR = tmpDir;
fs.mkdirSync(path.join(tmpDir, "state"), { recursive: true });

const STORE_FILE = path.join(tmpDir, "state", "session-costs.json");
const stateDir = path.join(tmpDir, "state");

const { CostTracker } = await import("../src/server/agent/cost-tracker.ts");

describe("CostTracker goalId stamping", () => {
	beforeEach(() => {
		try { fs.unlinkSync(STORE_FILE); } catch { /* ok */ }
	});

	after(() => {
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	it("stamps goalId at record time", () => {
		const tracker = new CostTracker(stateDir);
		const result = tracker.recordUsage("s1", { inputTokens: 10, cost: 0.001 }, "goal-1");
		assert.equal(result.goalId, "goal-1");
		assert.equal(tracker.getSessionCost("s1")?.goalId, "goal-1");
	});

	it("does not stamp when goalId is omitted", () => {
		const tracker = new CostTracker(stateDir);
		tracker.recordUsage("s1", { cost: 0.001 });
		assert.equal(tracker.getSessionCost("s1")?.goalId, undefined);
	});

	it("write-once: a second call with a different goalId does not overwrite", () => {
		const tracker = new CostTracker(stateDir);
		tracker.recordUsage("s1", { cost: 0.001 }, "goal-1");
		tracker.recordUsage("s1", { cost: 0.001 }, "goal-2");
		assert.equal(tracker.getSessionCost("s1")?.goalId, "goal-1");
	});

	it("omitting goalId on a subsequent call does not clear the stamp", () => {
		const tracker = new CostTracker(stateDir);
		tracker.recordUsage("s1", { cost: 0.001 }, "goal-1");
		tracker.recordUsage("s1", { cost: 0.001 });
		assert.equal(tracker.getSessionCost("s1")?.goalId, "goal-1");
	});

	it("stamping can happen later: first record without goalId, second with goalId stamps it", () => {
		const tracker = new CostTracker(stateDir);
		tracker.recordUsage("s1", { cost: 0.001 });
		assert.equal(tracker.getSessionCost("s1")?.goalId, undefined);
		tracker.recordUsage("s1", { cost: 0.001 }, "goal-1");
		assert.equal(tracker.getSessionCost("s1")?.goalId, "goal-1");
	});

	it("one-arg getGoalCost(goalId) aggregates by stamped goalId across all entries", () => {
		const tracker = new CostTracker(stateDir);
		tracker.recordUsage("s1", { inputTokens: 100, outputTokens: 50, cost: 0.01 }, "goal-1");
		tracker.recordUsage("s2", { inputTokens: 200, outputTokens: 100, cost: 0.02 }, "goal-1");
		tracker.recordUsage("s3", { inputTokens: 999, cost: 999 }, "goal-2");
		tracker.recordUsage("s4", { inputTokens: 1, cost: 0.5 }); // no goalId — must NOT be aggregated under any goal

		const total = tracker.getGoalCost("goal-1");
		assert.equal(total.inputTokens, 300);
		assert.equal(total.outputTokens, 150);
		assert.equal(total.totalCost, 0.03);
	});

	it("one-arg getGoalCost returns zero entry for a goal with no stamped entries", () => {
		const tracker = new CostTracker(stateDir);
		tracker.recordUsage("s1", { cost: 0.05 }, "goal-1");
		const total = tracker.getGoalCost("goal-X");
		assert.equal(total.inputTokens, 0);
		assert.equal(total.totalCost, 0);
	});

	it("two-arg getGoalCost(goalId, sessionIds) legacy form still aggregates explicitly", () => {
		const tracker = new CostTracker(stateDir);
		tracker.recordUsage("s1", { inputTokens: 100, cost: 0.01 }); // no goalId
		tracker.recordUsage("s2", { inputTokens: 200, cost: 0.02 }); // no goalId
		const total = tracker.getGoalCost("goal-1", ["s1", "s2"]);
		assert.equal(total.inputTokens, 300);
		assert.equal(total.totalCost, 0.03);
	});

	it("goalId round-trips through save/load", () => {
		const t1 = new CostTracker(stateDir);
		t1.recordUsage("s1", { cost: 0.01 }, "goal-1");
		const t2 = new CostTracker(stateDir);
		assert.equal(t2.getSessionCost("s1")?.goalId, "goal-1");
		assert.equal(t2.getGoalCost("goal-1").totalCost, 0.01);
	});
});
