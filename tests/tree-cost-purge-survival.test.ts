/**
 * Integration test: tree-cost rollup must survive session purge.
 *
 * Before the goalId-stamping fix, `getGoalCost(goalId, sessionIds)`
 * required the caller to resolve sessionIds via `sessionStore`, which is
 * wiped when sessions are purged. Result: archived goals showed $0.
 *
 * After the fix, cost entries are stamped with `goalId` at record time
 * and `computeTreeCost` (via the one-arg `getGoalCost(goalId)`) reads
 * them by goalId — no sessionStore lookup needed.
 *
 * This test simulates the purge by recording cost with a goalId and
 * then NOT providing a sessionIds resolver (or providing one that
 * returns empty, mimicking a wiped sessionStore). The rollup must still
 * return the recorded cost.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tree-cost-purge-"));
process.env.BOBBIT_DIR = tmpDir;
fs.mkdirSync(path.join(tmpDir, "state"), { recursive: true });

const STORE_FILE = path.join(tmpDir, "state", "session-costs.json");
const stateDir = path.join(tmpDir, "state");

const { CostTracker, computeTreeCost, _resetTreeCostCacheForTesting } = await import("../src/server/agent/cost-tracker.ts");

describe("tree-cost survives session purge", () => {
	beforeEach(() => {
		try { fs.unlinkSync(STORE_FILE); } catch { /* ok */ }
	});

	after(() => {
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	it("aggregates by stamped goalId even when sessionIds resolver returns empty (simulating purge)", () => {
		const tracker = new CostTracker(stateDir);
		// Cost is stamped onto cost entry by goalId at record time.
		tracker.recordUsage("s-root", { cost: 0.01, inputTokens: 100, outputTokens: 50 }, "R");
		tracker.recordUsage("s-c1", { cost: 0.02, inputTokens: 200, outputTokens: 100 }, "C1");
		tracker.recordUsage("s-c2", { cost: 0.03, inputTokens: 300, outputTokens: 150 }, "C2");

		const goals = [
			{ id: "R", title: "Root", createdAt: 1 },
			{ id: "C1", title: "Child 1", parentGoalId: "R", rootGoalId: "R", createdAt: 2 },
			{ id: "C2", title: "Child 2", parentGoalId: "R", rootGoalId: "R", createdAt: 3 },
		];

		// Simulate "all sessions have been purged from sessionStore" by
		// passing a resolver that returns no sessionIds. The rollup must
		// still reflect the stamped costs.
		_resetTreeCostCacheForTesting(tracker);
		const result = computeTreeCost("R", goals, tracker, () => []);

		assert.equal(result.totalCostUsd, 0.06);
		assert.equal(result.totalTokensIn, 600);
		assert.equal(result.totalTokensOut, 300);
		assert.equal(result.breakdown.length, 3);
		const byId = Object.fromEntries(result.breakdown.map((e) => [e.goalId, e]));
		assert.equal(byId.R.costUsd, 0.01);
		assert.equal(byId.C1.costUsd, 0.02);
		assert.equal(byId.C2.costUsd, 0.03);
	});

	it("works with no sessionIds resolver at all", () => {
		const tracker = new CostTracker(stateDir);
		tracker.recordUsage("s-root", { cost: 0.01 }, "R");
		tracker.recordUsage("s-c1", { cost: 0.02 }, "C1");

		const goals = [
			{ id: "R", title: "Root", createdAt: 1 },
			{ id: "C1", title: "Child", parentGoalId: "R", rootGoalId: "R", createdAt: 2 },
		];

		_resetTreeCostCacheForTesting(tracker);
		const result = computeTreeCost("R", goals, tracker);

		assert.equal(result.totalCostUsd, 0.03);
	});

	it("backfill restores costs for legacy entries via the resolver, then survives purge", () => {
		// Legacy on-disk data: no goalId field.
		fs.writeFileSync(STORE_FILE, JSON.stringify({
			"s-root": { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.05 },
			"s-c1": { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.07 },
		}), "utf-8");

		const tracker = new CostTracker(stateDir);
		// Simulate "sessionStore still has these sessions at boot time" —
		// resolver returns goalId for each. After backfill, sessions can
		// be purged and the cost still aggregates.
		const map: Record<string, string> = { "s-root": "R", "s-c1": "C1" };
		const n = tracker.backfillGoalIds((sid) => map[sid]);
		assert.equal(n, 2);

		const goals = [
			{ id: "R", title: "Root", createdAt: 1 },
			{ id: "C1", title: "Child", parentGoalId: "R", rootGoalId: "R", createdAt: 2 },
		];
		_resetTreeCostCacheForTesting(tracker);
		// No sessionIds resolver → must work entirely from stamped goalId.
		const result = computeTreeCost("R", goals, tracker, () => []);
		assert.equal(result.totalCostUsd, 0.12);
	});
});
