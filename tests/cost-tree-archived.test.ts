/**
 * Tree-cost rollup — archived descendant cost attribution.
 *
 * Pins the contract that `computeTreeCost` walks the subtree with
 * `includeArchived:true` AND that archived descendants whose cost was
 * stamped with `goalId` at record time appear in BOTH:
 *  - the parent's `totalCostUsd` / token totals, AND
 *  - the per-child `breakdown[]` rows (with non-zero cost/tokens).
 *
 * Historical regression: when subtree walks defaulted to live-only,
 * archived children's spend silently dropped from the rollup. Every
 * case name contains `archived` so future agents can grep the contract.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-tree-archived-test-"));
process.env.BOBBIT_DIR = tmpDir;
const stateDir = path.join(tmpDir, "state");
fs.mkdirSync(stateDir, { recursive: true });

const { CostTracker, computeTreeCost, _resetTreeCostCacheForTesting } = await import("../src/server/agent/cost-tracker.ts");

interface G {
	id: string;
	title?: string;
	createdAt?: number;
	parentGoalId?: string;
	rootGoalId?: string;
	archived?: boolean;
}

function freshTracker(): InstanceType<typeof CostTracker> {
	const file = path.join(stateDir, "session-costs.json");
	try { fs.unlinkSync(file); } catch { /* ok */ }
	return new CostTracker(stateDir);
}

describe("computeTreeCost — archived child cost attribution", () => {
	after(() => {
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	it("parent total INCLUDES archived child cost (stamped by goalId)", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);

		// Stamp goalId at record time — the primary path that survives
		// session purge and that archived-children rollups depend on.
		tracker.recordUsage("s-parent", { cost: 0.01, inputTokens: 100, outputTokens: 50 }, "P");
		tracker.recordUsage("s-live",   { cost: 0.02, inputTokens: 200, outputTokens: 100 }, "C-live");
		tracker.recordUsage("s-arch",   { cost: 0.04, inputTokens: 400, outputTokens: 200 }, "C-archived");

		const goals: G[] = [
			{ id: "P",          title: "Parent",          createdAt: 1 },
			{ id: "C-live",     title: "Live child",      createdAt: 2, parentGoalId: "P", rootGoalId: "P" },
			{ id: "C-archived", title: "Archived child",  createdAt: 3, parentGoalId: "P", rootGoalId: "P", archived: true },
		];

		const result = computeTreeCost("P", goals, tracker);

		assert.equal(result.totalCostUsd, 0.07,
			"parent totalCostUsd must include archived child's $0.04");
		assert.equal(result.totalTokensIn, 700, "input tokens must include archived child");
		assert.equal(result.totalTokensOut, 350, "output tokens must include archived child");
	});

	it("breakdown contains the archived child row with non-zero cost and tokens", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);

		tracker.recordUsage("s-parent", { cost: 0.01, inputTokens: 10, outputTokens: 5  }, "P2");
		tracker.recordUsage("s-live",   { cost: 0.02, inputTokens: 20, outputTokens: 10 }, "P2-live");
		tracker.recordUsage("s-arch",   { cost: 0.05, inputTokens: 50, outputTokens: 25 }, "P2-archived");

		const goals: G[] = [
			{ id: "P2",           title: "Parent",         createdAt: 1 },
			{ id: "P2-live",      title: "Live child",     createdAt: 2, parentGoalId: "P2", rootGoalId: "P2" },
			{ id: "P2-archived",  title: "Archived child", createdAt: 3, parentGoalId: "P2", rootGoalId: "P2", archived: true },
		];

		const result = computeTreeCost("P2", goals, tracker);

		assert.equal(result.breakdown.length, 3,
			"breakdown must include parent + live child + archived child");

		const archivedRow = result.breakdown.find(e => e.goalId === "P2-archived");
		assert.ok(archivedRow, "archived child must have a per-child breakdown row");
		assert.equal(archivedRow!.costUsd, 0.05,
			"archived child's row must carry the recorded $0.05, not $0");
		assert.equal(archivedRow!.tokensIn, 50, "archived child's tokensIn must be non-zero");
		assert.equal(archivedRow!.tokensOut, 25, "archived child's tokensOut must be non-zero");
	});

	it("cache invalidates when allGoals tree shape changes even if cost generation is unchanged", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);

		tracker.recordUsage("s-p", { cost: 0.01 }, "TS");
		tracker.recordUsage("s-a", { cost: 0.02 }, "TS-archived");

		const before: G[] = [
			{ id: "TS", title: "Parent", createdAt: 1 },
		];
		const first = computeTreeCost("TS", before, tracker);
		assert.equal(first.breakdown.length, 1,
			"baseline: only the root before the archived child is registered");

		// Add an archived descendant WITHOUT mutating any cost entry.
		// Cost generation is unchanged — but the tree shape changed, so the
		// cached breakdown must NOT be returned. The archived row must
		// appear with its previously-stamped cost.
		const after: G[] = [
			{ id: "TS", title: "Parent", createdAt: 1 },
			{ id: "TS-archived", title: "Archived child", createdAt: 2, parentGoalId: "TS", rootGoalId: "TS", archived: true },
		];
		const second = computeTreeCost("TS", after, tracker);
		assert.equal(second.breakdown.length, 2,
			"tree-shape change must bust the cache and surface the archived descendant");
		const archivedRow = second.breakdown.find(e => e.goalId === "TS-archived");
		assert.ok(archivedRow, "archived row must appear after tree-shape change");
		assert.equal(archivedRow!.costUsd, 0.02);
	});

	it("cache bypassed when sessionIdsForGoal fallback is supplied (avoids stale breakdown)", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);

		// No goalId-stamped entries — forces the fallback path via sessionIds.
		tracker.recordUsage("sess-A", { cost: 0.10 });
		tracker.recordUsage("sess-B", { cost: 0.20 });

		const goals: G[] = [
			{ id: "FB", title: "Parent", createdAt: 1 },
		];

		const first = computeTreeCost("FB", goals, tracker, (gid) => gid === "FB" ? ["sess-A"] : []);
		assert.equal(first.breakdown[0].costUsd, 0.10,
			"first call uses fallback resolver returning sess-A");

		// Different closure (different sessionIds for same goal) — with the
		// old cache (keyed only on generation), this would return $0.10
		// stale. Fixed impl bypasses cache when a resolver is supplied.
		const second = computeTreeCost("FB", goals, tracker, (gid) => gid === "FB" ? ["sess-B"] : []);
		assert.equal(second.breakdown[0].costUsd, 0.20,
			"resolver-presence must bypass cache so the new sessionIds mapping is honoured");
	});

	it("deeply-nested archived descendants also contribute to the rollup", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);

		tracker.recordUsage("s-r",  { cost: 0.001 }, "R");
		tracker.recordUsage("s-c",  { cost: 0.010 }, "C");
		tracker.recordUsage("s-gc", { cost: 0.100 }, "GC-archived");

		const goals: G[] = [
			{ id: "R",            title: "Root",                  createdAt: 1 },
			{ id: "C",            title: "Child",                 createdAt: 2, parentGoalId: "R", rootGoalId: "R" },
			{ id: "GC-archived",  title: "Archived grandchild",   createdAt: 3, parentGoalId: "C", rootGoalId: "R", archived: true },
		];

		const result = computeTreeCost("R", goals, tracker);

		assert.equal(result.totalCostUsd, 0.111,
			"archived grandchild $0.100 must roll up into root total");
		const gcRow = result.breakdown.find(e => e.goalId === "GC-archived");
		assert.ok(gcRow, "archived grandchild must appear in breakdown");
		assert.equal(gcRow!.costUsd, 0.1);
	});
});
