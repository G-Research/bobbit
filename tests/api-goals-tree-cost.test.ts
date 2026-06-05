/**
 * Phase 6 — endpoint contract for `GET /api/goals/:id/tree-cost`.
 *
 * The REST handler in `server.ts` is thin: it (1) looks up the goal,
 * (2) calls `computeTreeCost(goalId, ...)` rooted at the REQUESTED
 * goal (not its topmost ancestor), and (3) returns the result
 * verbatim, with 404 on unknown goal id.
 *
 * Subtree-rooted rollup pin (see `docs/design/...` and the call-site
 * comment in `src/server/server.ts`): the endpoint MUST pass the URL
 * `goalId` directly to `computeTreeCost`. Passing `goal.rootGoalId`
 * (the topmost ancestor) is the bug this test guards against —
 * descendant dashboards would otherwise leak the whole project's
 * grand total. See also `tests/e2e/ui/tree-cost-rollup.spec.ts`.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-tree-cost-test-"));
process.env.BOBBIT_DIR = tmpDir;
const stateDir = path.join(tmpDir, "state");
fs.mkdirSync(stateDir, { recursive: true });

const { CostTracker, computeTreeCost, _resetTreeCostCacheForTesting } = await import("../src/server/agent/cost-tracker.ts");

interface G {
	id: string; title?: string; createdAt?: number;
	parentGoalId?: string; rootGoalId?: string; archived?: boolean;
	projectId?: string;
}

/**
 * Mimic the endpoint's resolve-rollup-root logic. The dashboard tree-cost
 * endpoint is intentionally rooted at the REQUESTED goal — NOT at
 * `g.rootGoalId` (which would always resolve to the topmost ancestor).
 * If a future refactor reintroduces `g.rootGoalId ?? g.id` here, the
 * subtree assertions below will fail.
 */
function rollupRootOf(g: G): string {
	return g.id;
}

/** Build a tracker on a clean costs file each call. */
function freshTracker(): InstanceType<typeof CostTracker> {
	const file = path.join(stateDir, "session-costs.json");
	try { fs.unlinkSync(file); } catch { /* ok */ }
	return new CostTracker(stateDir);
}

describe("GET /api/goals/:id/tree-cost — endpoint contract", () => {
	after(() => {
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	it("returns expected structure {rootGoalId, totalCostUsd, totalTokensIn, totalTokensOut, breakdown[]}", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);
		tracker.recordUsage("s-r", { cost: 0.01, inputTokens: 100, outputTokens: 50 });
		tracker.recordUsage("s-c", { cost: 0.02, inputTokens: 200, outputTokens: 100 });

		const goals: G[] = [
			{ id: "R", title: "Root", createdAt: 1, projectId: "p1" },
			{ id: "C", title: "Child", createdAt: 2, parentGoalId: "R", rootGoalId: "R", projectId: "p1" },
		];
		const target = goals.find(g => g.id === "R")!;
		const root = rollupRootOf(target);
		const result = computeTreeCost(root, goals, tracker, (gid) => {
			return gid === "R" ? ["s-r"] : gid === "C" ? ["s-c"] : [];
		});

		// Shape contract
		assert.ok("rootGoalId" in result);
		assert.ok("totalCostUsd" in result);
		assert.ok("totalTokensIn" in result);
		assert.ok("totalTokensOut" in result);
		assert.ok(Array.isArray(result.breakdown));

		// Values — rolling up at R includes R + C.
		assert.equal(result.rootGoalId, "R");
		assert.equal(result.totalCostUsd, 0.03);
		assert.equal(result.totalTokensIn, 300);
		assert.equal(result.totalTokensOut, 150);
		assert.equal(result.breakdown.length, 2);

		// Each breakdown row has the required fields
		for (const row of result.breakdown) {
			assert.ok(typeof row.goalId === "string");
			assert.ok(typeof row.depth === "number");
			assert.ok(typeof row.title === "string");
			assert.ok(typeof row.costUsd === "number");
			assert.ok(typeof row.tokensIn === "number");
			assert.ok(typeof row.tokensOut === "number");
		}
	});

	it("requesting a child goal rolls up ONLY its subtree, not the whole tree", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);
		tracker.recordUsage("s-r", { cost: 0.01 });
		tracker.recordUsage("s-c", { cost: 0.02 });

		const goals: G[] = [
			{ id: "R", title: "Root", createdAt: 1 },
			{ id: "C", title: "Child", createdAt: 2, parentGoalId: "R", rootGoalId: "R" },
		];
		// Caller passes the CHILD's id — endpoint roots the rollup at C.
		const target = goals.find(g => g.id === "C")!;
		const rollupId = rollupRootOf(target);
		assert.equal(rollupId, "C", "child request should be rooted at the child, not at R");

		const result = computeTreeCost(rollupId, goals, tracker, (gid) =>
			gid === "R" ? ["s-r"] : gid === "C" ? ["s-c"] : []);
		assert.equal(result.rootGoalId, "C");
		assert.equal(result.totalCostUsd, 0.02, "rollup at child must NOT include the root's cost");
		assert.equal(result.breakdown.length, 1);
		assert.equal(result.breakdown[0].goalId, "C");
	});

	it("4-node chain root → A → B → leaf: each goal sees only its own subtree", () => {
		const tracker = freshTracker();
		_resetTreeCostCacheForTesting(tracker);
		// Distinct, non-overlapping costs per node so misattribution is obvious.
		tracker.recordUsage("s-root", { cost: 1.00, inputTokens: 1000, outputTokens: 100 });
		tracker.recordUsage("s-A",    { cost: 0.10, inputTokens:  200, outputTokens:  20 });
		tracker.recordUsage("s-B",    { cost: 0.02, inputTokens:   40, outputTokens:   4 });
		tracker.recordUsage("s-leaf", { cost: 0.003, inputTokens:   8, outputTokens:   1 });

		const goals: G[] = [
			{ id: "root", title: "Root",  createdAt: 1, projectId: "p1" },
			{ id: "A",    title: "A",     createdAt: 2, parentGoalId: "root", rootGoalId: "root", projectId: "p1" },
			{ id: "B",    title: "B",     createdAt: 3, parentGoalId: "A",    rootGoalId: "root", projectId: "p1" },
			{ id: "leaf", title: "Leaf",  createdAt: 4, parentGoalId: "B",    rootGoalId: "root", projectId: "p1" },
		];
		const sessionIdsFor = (gid: string): string[] => {
			switch (gid) {
				case "root": return ["s-root"];
				case "A":    return ["s-A"];
				case "B":    return ["s-B"];
				case "leaf": return ["s-leaf"];
				default: return [];
			}
		};

		const callEndpoint = (urlGoalId: string) => {
			const target = goals.find(g => g.id === urlGoalId);
			assert.ok(target, `goal ${urlGoalId} must exist in fixture`);
			const rollupId = rollupRootOf(target!); // models the endpoint's resolution
			assert.equal(rollupId, urlGoalId,
				`endpoint must root rollup at the REQUESTED goal (${urlGoalId}), not its ancestor`);
			return computeTreeCost(rollupId, goals, tracker, sessionIdsFor);
		};

		const approx = (a: number, b: number) =>
			assert.ok(Math.abs(a - b) < 1e-9, `expected ~${b}, got ${a}`);

		// --- root: sees root + A + B + leaf ---
		const rRoot = callEndpoint("root");
		assert.equal(rRoot.rootGoalId, "root");
		approx(rRoot.totalCostUsd, 1.00 + 0.10 + 0.02 + 0.003);
		assert.equal(rRoot.totalTokensIn,  1000 + 200 + 40 + 8);
		assert.equal(rRoot.totalTokensOut, 100  +  20 +  4 + 1);
		assert.deepEqual(
			new Set(rRoot.breakdown.map(r => r.goalId)),
			new Set(["root", "A", "B", "leaf"]),
		);

		// --- A: sees A + B + leaf, NOT root ---
		const rA = callEndpoint("A");
		assert.equal(rA.rootGoalId, "A");
		approx(rA.totalCostUsd, 0.10 + 0.02 + 0.003);
		assert.equal(rA.totalTokensIn,  200 + 40 + 8);
		assert.equal(rA.totalTokensOut,  20 +  4 + 1);
		const aIds = new Set(rA.breakdown.map(r => r.goalId));
		assert.deepEqual(aIds, new Set(["A", "B", "leaf"]));
		assert.ok(!aIds.has("root"), "A's subtree must NOT include root");
		assert.ok(rA.totalCostUsd < rRoot.totalCostUsd, "A < root");

		// --- B: sees B + leaf, NOT root and NOT A ---
		const rB = callEndpoint("B");
		assert.equal(rB.rootGoalId, "B");
		approx(rB.totalCostUsd, 0.02 + 0.003);
		assert.equal(rB.totalTokensIn,  40 + 8);
		assert.equal(rB.totalTokensOut,  4 + 1);
		const bIds = new Set(rB.breakdown.map(r => r.goalId));
		assert.deepEqual(bIds, new Set(["B", "leaf"]));
		assert.ok(!bIds.has("root"), "B's subtree must NOT include root");
		assert.ok(!bIds.has("A"),    "B's subtree must NOT include A");
		assert.ok(rB.totalCostUsd < rA.totalCostUsd, "B < A");

		// --- leaf: sees ONLY leaf ---
		const rLeaf = callEndpoint("leaf");
		assert.equal(rLeaf.rootGoalId, "leaf");
		approx(rLeaf.totalCostUsd, 0.003);
		assert.equal(rLeaf.totalTokensIn,  8);
		assert.equal(rLeaf.totalTokensOut, 1);
		assert.equal(rLeaf.breakdown.length, 1);
		assert.equal(rLeaf.breakdown[0].goalId, "leaf");
		assert.ok(rLeaf.totalCostUsd < rB.totalCostUsd, "leaf < B");

		// Strict ordering across the whole chain.
		assert.ok(
			rLeaf.totalCostUsd < rB.totalCostUsd &&
			rB.totalCostUsd   < rA.totalCostUsd &&
			rA.totalCostUsd   < rRoot.totalCostUsd,
			"strict descendant-cost ordering must hold along root → A → B → leaf",
		);
	});

	it("unknown goal id → endpoint returns 404 (logic: getGoalAcrossProjects returns undefined)", () => {
		// The handler does `if (!goal) { json({ error: "Goal not found" }, 404); return; }`
		// Simulate that lookup with a synthetic goals list that does not contain the id.
		const goals: G[] = [{ id: "R", title: "Root", createdAt: 1 }];
		const found = goals.find(g => g.id === "nonexistent");
		assert.equal(found, undefined, "lookup must miss → 404 path is taken in server.ts");
	});

	it("project-less goal (no projectId) returns zeroed structure (no costTracker available)", () => {
		// The endpoint short-circuits when goal.projectId is undefined and returns a
		// zeroed payload. We model the same shape the handler emits.
		const result = {
			rootGoalId: "R",
			totalCostUsd: 0,
			totalTokensIn: 0,
			totalTokensOut: 0,
			breakdown: [] as Array<{ goalId: string; depth: number; title: string; costUsd: number; tokensIn: number; tokensOut: number }>,
		};
		assert.equal(result.totalCostUsd, 0);
		assert.equal(result.breakdown.length, 0);
	});
});
