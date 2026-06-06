/**
 * Phase 6 — tree-cost rollup for nested-goal trees.
 *
 * Tests `computeTreeCost(rootGoalId, allGoals, costTracker, sessionIdsForGoal)`:
 *  - Single goal (no children) → totalCostUsd === goal's own cost
 *  - Root + 2 children → sum of all 3
 *  - Three generations → sum of all 4
 *  - Cache hit: 2 calls within same generation → second uses cache
 *  - Cache miss: generation tick between calls → recomputes
 *  - Goal not in tree → excluded from rollup
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tree-cost-test-"));
process.env.BOBBIT_DIR = tmpDir;
const stateDir = path.join(tmpDir, "state");
fs.mkdirSync(stateDir, { recursive: true });

const { CostTracker, computeTreeCost, _resetTreeCostCacheForTesting } = await import("../src/server/agent/cost-tracker.ts");

// Minimal goal shape — matches `TreeCostGoal` interface.
interface G {
	id: string; title?: string; createdAt?: number;
	parentGoalId?: string; rootGoalId?: string; archived?: boolean;
}

function freshTracker(): InstanceType<typeof CostTracker> {
	const file = path.join(stateDir, "session-costs.json");
	try { fs.unlinkSync(file); } catch {/*ok*/}
	return new CostTracker(stateDir);
}

describe("computeTreeCost", () => {
	beforeEach(() => {
		// reset
	});

	after(() => {
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	it("single root goal (no children) → totalCostUsd === goal's own cost", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);
		tracker.recordUsage("s1", { inputTokens: 100, outputTokens: 50, cost: 0.01 });

		const goals: G[] = [{ id: "root1", title: "Root", createdAt: 1 }];
		const result = computeTreeCost("root1", goals, tracker, () => ["s1"]);

		assert.equal(result.rootGoalId, "root1");
		assert.equal(result.totalCostUsd, 0.01);
		assert.equal(result.totalTokensIn, 100);
		assert.equal(result.totalTokensOut, 50);
		assert.equal(result.breakdown.length, 1);
		assert.equal(result.breakdown[0].goalId, "root1");
		assert.equal(result.breakdown[0].depth, 0);
	});

	it("root + 2 children → sum of all 3 + breakdown ordered by depth", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);
		tracker.recordUsage("s-root", { cost: 0.01, inputTokens: 100, outputTokens: 50 });
		tracker.recordUsage("s-c1", { cost: 0.02, inputTokens: 200, outputTokens: 100 });
		tracker.recordUsage("s-c2", { cost: 0.03, inputTokens: 300, outputTokens: 150 });

		const goals: G[] = [
			{ id: "R", title: "Root", createdAt: 1 },
			{ id: "C1", title: "Child 1", createdAt: 2, parentGoalId: "R", rootGoalId: "R" },
			{ id: "C2", title: "Child 2", createdAt: 3, parentGoalId: "R", rootGoalId: "R" },
		];
		const sidsByGoal: Record<string, string[]> = { R: ["s-root"], C1: ["s-c1"], C2: ["s-c2"] };
		const result = computeTreeCost("R", goals, tracker, (gid) => sidsByGoal[gid] ?? []);

		assert.equal(result.totalCostUsd, 0.06);
		assert.equal(result.totalTokensIn, 600);
		assert.equal(result.totalTokensOut, 300);
		assert.equal(result.breakdown.length, 3);
		// Root first (depth 0), then children (depth 1) ordered by createdAt
		assert.equal(result.breakdown[0].goalId, "R");
		assert.equal(result.breakdown[0].depth, 0);
		assert.equal(result.breakdown[1].goalId, "C1");
		assert.equal(result.breakdown[1].depth, 1);
		assert.equal(result.breakdown[2].goalId, "C2");
		assert.equal(result.breakdown[2].depth, 1);
	});

	it("three generations → sum of all 4 with monotonic depth", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);
		tracker.recordUsage("s-r", { cost: 0.001 });
		tracker.recordUsage("s-c", { cost: 0.002 });
		tracker.recordUsage("s-gc", { cost: 0.004 });
		tracker.recordUsage("s-ggc", { cost: 0.008 });

		const goals: G[] = [
			{ id: "R", title: "Root", createdAt: 1 },
			{ id: "C", title: "Child", createdAt: 2, parentGoalId: "R", rootGoalId: "R" },
			{ id: "GC", title: "Grandchild", createdAt: 3, parentGoalId: "C", rootGoalId: "R" },
			{ id: "GGC", title: "Great-grandchild", createdAt: 4, parentGoalId: "GC", rootGoalId: "R" },
		];
		const sidsByGoal: Record<string, string[]> = { R: ["s-r"], C: ["s-c"], GC: ["s-gc"], GGC: ["s-ggc"] };
		const result = computeTreeCost("R", goals, tracker, (gid) => sidsByGoal[gid] ?? []);

		assert.equal(result.totalCostUsd, 0.015);
		assert.equal(result.breakdown.length, 4);
		// Depth-ordered: R(0), C(1), GC(2), GGC(3)
		assert.deepEqual(result.breakdown.map(e => e.depth), [0, 1, 2, 3]);
		assert.deepEqual(result.breakdown.map(e => e.goalId), ["R", "C", "GC", "GGC"]);
	});

	it("cache hit: 2 calls within same generation use cached result", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);
		// Stamp the goalId at record time so getGoalCost("R") returns non-zero
		// and the NO-resolver path (the one that actually caches) is exercised.
		// Production intentionally bypasses the tree-cost cache whenever a
		// sessionIds resolver is supplied (its closure state can't be
		// fingerprinted — see cost-tracker.ts header), so a cache hit can only
		// be observed on the no-resolver path.
		tracker.recordUsage("s1", { cost: 0.05, inputTokens: 100 }, "R");
		const goals: G[] = [{ id: "R", title: "R", createdAt: 1 }];

		const r1 = computeTreeCost("R", goals, tracker);
		const r2 = computeTreeCost("R", goals, tracker);
		// Same generation + tree shape + no resolver → cached result is returned
		// (referential equality is the cache-hit signal).
		assert.equal(r1, r2, "second call within same generation returns the cached object");
		assert.equal(r1.totalCostUsd, r2.totalCostUsd);
		assert.equal(r1.totalTokensIn, r2.totalTokensIn);
		assert.equal(r1.totalCostUsd, 0.05);
		assert.equal(r1.totalTokensIn, 100);
	});

	it("cache miss: generation tick between calls → recomputes", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);
		tracker.recordUsage("s1", { cost: 0.05 });
		const goals: G[] = [{ id: "R", title: "R", createdAt: 1 }];

		let calls = 0;
		const sidsFn = (_gid: string) => { calls++; return ["s1"]; };

		computeTreeCost("R", goals, tracker, sidsFn);
		assert.equal(calls, 1);
		// Mutating cost bumps generation
		tracker.recordUsage("s1", { cost: 0.01 });
		computeTreeCost("R", goals, tracker, sidsFn);
		assert.equal(calls, 2, "post-mutation call must recompute (cache invalidated)");

		// And the totals reflect the new cost
		const r3 = computeTreeCost("R", goals, tracker, () => ["s1"]);
		assert.equal(r3.totalCostUsd, 0.06);
	});

	it("goal not in tree (rootGoalId points elsewhere) → excluded from rollup", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);
		tracker.recordUsage("s-r", { cost: 0.01 });
		tracker.recordUsage("s-c", { cost: 0.02 });
		tracker.recordUsage("s-stray", { cost: 999 }); // huge cost, must not leak in

		const goals: G[] = [
			{ id: "R", title: "Root", createdAt: 1 },
			{ id: "C", title: "Child", createdAt: 2, parentGoalId: "R", rootGoalId: "R" },
			// "stray" belongs to a totally different tree
			{ id: "STRAY", title: "Stray", createdAt: 3, parentGoalId: "OTHER", rootGoalId: "OTHER" },
		];
		const sidsByGoal: Record<string, string[]> = { R: ["s-r"], C: ["s-c"], STRAY: ["s-stray"] };
		const result = computeTreeCost("R", goals, tracker, (gid) => sidsByGoal[gid] ?? []);

		assert.equal(result.totalCostUsd, 0.03);
		assert.equal(result.breakdown.length, 2, "only R + C should be in the breakdown");
		assert.ok(!result.breakdown.find(e => e.goalId === "STRAY"), "stray must be excluded");
	});

	it("cache invalidates when a deep subgoal descendant changes (C3: signature walks parentGoalId subtree, not rootGoalId filter)", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);
		// parent → child → grandchild. Descendants keep the TOP-LEVEL root id
		// ("P") in `rootGoalId`, NOT the child's id — exactly the production
		// shape for a subgoal subtree. We request tree-cost for the CHILD.
		// Stamp goalId at record time so the no-resolver path (the one that
		// actually caches) is exercised; record everything up-front so the
		// generation tick stays constant across all three calls and cache
		// invalidation depends SOLELY on the tree signature.
		tracker.recordUsage("s-c", { cost: 0.02, inputTokens: 200 }, "C");
		tracker.recordUsage("s-gc", { cost: 0.04, inputTokens: 400 }, "GC");
		tracker.recordUsage("s-ggc", { cost: 0.08, inputTokens: 800 }, "GGC");

		const goals: G[] = [
			{ id: "P", title: "Parent", createdAt: 1 },
			{ id: "C", title: "Child", createdAt: 2, parentGoalId: "P", rootGoalId: "P" },
			{ id: "GC", title: "Grandchild", createdAt: 3, parentGoalId: "C", rootGoalId: "P" },
		];

		const r1 = computeTreeCost("C", goals, tracker);
		const r2 = computeTreeCost("C", goals, tracker);
		// Same shape + generation + no resolver → cached object returned.
		assert.equal(r1, r2, "second call within same generation returns the cached object");
		assert.equal(r1.totalCostUsd, 0.06, "child subtree sums child + grandchild");
		assert.equal(r1.breakdown.length, 2);

		// Add a NEW great-grandchild under GC. It keeps rootGoalId "P" — the
		// case the old rootGoalId-equality signature missed entirely (it only
		// fingerprinted goals whose id/rootGoalId equalled "C", i.e. just C).
		// No recordUsage between calls ⇒ generation is unchanged, so a stale
		// cache could ONLY be avoided by the signature noticing the new node.
		const goals2: G[] = [
			...goals,
			{ id: "GGC", title: "Great-grandchild", createdAt: 4, parentGoalId: "GC", rootGoalId: "P" },
		];
		const r3 = computeTreeCost("C", goals2, tracker);
		assert.notEqual(r3, r1, "tree-shape change in a deep descendant must invalidate the cache");
		assert.equal(r3.breakdown.length, 3, "new great-grandchild now appears in the breakdown");
		assert.equal(r3.totalCostUsd, 0.14, "new great-grandchild cost is rolled up");
		assert.ok(r3.breakdown.find(e => e.goalId === "GGC"), "GGC present in breakdown");

		// Archiving an existing descendant must ALSO invalidate (archived flag
		// is part of the fingerprint and feeds the plan-tab archived pill).
		const goals3: G[] = goals2.map(g => g.id === "GC" ? { ...g, archived: true } : g);
		const r4 = computeTreeCost("C", goals3, tracker);
		assert.notEqual(r4, r3, "archiving a descendant must invalidate the cache");
		assert.equal(r4.totalCostUsd, 0.14, "archived descendant cost still counted");
	});

	it("unknown root goal → returns empty breakdown without throwing", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);
		const goals: G[] = [];
		const result = computeTreeCost("nonexistent", goals, tracker, () => []);
		assert.equal(result.totalCostUsd, 0);
		assert.equal(result.breakdown.length, 0);
		assert.equal(result.rootGoalId, "nonexistent");
	});
});
