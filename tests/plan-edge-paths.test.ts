/**
 * Pinned regression: plan-DAG edge paths between phase columns.
 *
 * Live test (PR #409): the v0.1-foundation Plan tab showed Phase 1
 * (1 node) \u2192 Phase 2 (3 nodes) but the connectors for the second and
 * third Phase 2 nodes were broken \u2014 lines floated to the right of
 * those nodes with no visible origin in Phase 1. Cause: the original
 * `renderEdgeColumn` drew a horizontal line for each destination row
 * pinned to the destination row's y-coordinate, starting at the
 * source column's right edge. That start-point was at a y-position
 * where the source column was empty (no source node existed there),
 * so the visible portion of the path lay in empty space.
 *
 * Fix: each edge is a full bipartite source\u2192destination orthogonal
 * path with a shared vertical mid-line in the column gap. The result
 * is that, in a 1\u21923 phase, all 3 destination nodes have an edge that
 * traces back to the single source node.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planEdgePath, planEdgePaths, planRowY, planSourceRightX, planDestLeftX, planEdgeMidX, type PlanEdgeLayout } from "../src/app/plan-edge-paths.js";

const layout: PlanEdgeLayout = {
	planPad: 24,
	planColW: 240,
	planNodeW: 200,
	planNodeH: 72,
	planHeaderH: 28,
	planRowH: 96,
};

describe("plan-edge-paths layout primitives", () => {
	it("computes per-row y-center deterministically", () => {
		// row 0 = pad + header + 0*rowH + nodeH/2 = 24 + 28 + 36 = 88
		assert.equal(planRowY(layout, 0), 88);
		// row 1 = 24 + 28 + 96 + 36 = 184
		assert.equal(planRowY(layout, 1), 184);
		// row 2 = 24 + 28 + 192 + 36 = 280
		assert.equal(planRowY(layout, 2), 280);
	});

	it("source-right-x for col 0 = pad + 0 + colW/2 + nodeW/2 = 24 + 120 + 100 = 244", () => {
		assert.equal(planSourceRightX(layout, 0), 244);
	});

	it("dest-left-x for col 0 = pad + colW + (colW-nodeW)/2 = 24 + 240 + 20 = 284", () => {
		assert.equal(planDestLeftX(layout, 0), 284);
	});

	it("mid-x is the midpoint between source-right and dest-left", () => {
		// (244 + 284) / 2 = 264
		assert.equal(planEdgeMidX(layout, 0), 264);
	});
});

describe("planEdgePath single edge", () => {
	it("produces an orthogonal 4-point path", () => {
		const d = planEdgePath(layout, 0, 0, 0);
		// M 244 88 L 264 88 L 264 88 L 284 88
		assert.equal(d, "M 244 88 L 264 88 L 264 88 L 284 88");
	});

	it("when source row != dest row, includes a vertical segment via mid-x", () => {
		// source row 0 (y=88), dest row 2 (y=280)
		const d = planEdgePath(layout, 0, 0, 2);
		assert.equal(d, "M 244 88 L 264 88 L 264 280 L 284 280");
	});

	it("works for higher column indices (col 1)", () => {
		// source-right-x for col 1: 24 + 240 + 120 + 100 = 484
		// dest-left-x for col 1: 24 + 480 + 20 = 524
		// mid: 504
		const d = planEdgePath(layout, 1, 0, 1);
		assert.equal(d, "M 484 88 L 504 88 L 504 184 L 524 184");
	});
});

describe("planEdgePaths bipartite emission \u2014 the bug regression", () => {
	it("1\u21923 phase emits 3 paths, all originating at source row 0", () => {
		// This is the v0.1-foundation Phase 1 (1 node, domain-and-ports)
		// \u2192 Phase 2 (3 nodes: idempotency, policy-engine, storage) case
		// from the screenshot. ALL three destination nodes must trace
		// back to the same source node, so all 3 paths share the same
		// "M 244 88 L 264 88" prefix (originating at source row 0).
		const paths = planEdgePaths(layout, 0, 1, 3);
		assert.equal(paths.length, 3, "exactly one edge per destination node");
		for (const d of paths) {
			assert.match(d, /^M 244 88 L 264 88 /, "every edge originates at source row 0");
		}
		// And the three paths terminate at three distinct rows.
		const targets = paths.map(d => d.match(/L \d+ (\d+)$/)?.[1]).sort();
		assert.deepEqual(targets, ["184", "280", "88"].sort());
	});

	it("3\u21931 phase emits 3 paths, all terminating at destination row 0", () => {
		// Symmetric: when phase N has 3 nodes funnelling into phase N+1's
		// 1 node, every source node sends an edge.
		const paths = planEdgePaths(layout, 0, 3, 1);
		assert.equal(paths.length, 3);
		for (const d of paths) {
			assert.match(d, / L 284 88$/, "every edge terminates at destination row 0");
		}
	});

	it("2\u21922 phase emits 4 paths (full bipartite)", () => {
		// Every source connects to every destination.
		const paths = planEdgePaths(layout, 0, 2, 2);
		assert.equal(paths.length, 4);
	});

	it("0\u2192N phase emits N paths from a synthesised single source row (defensive)", () => {
		// An empty source phase shouldn't really exist (validation should
		// prevent it), but if it does we treat it as 1 source row at
		// index 0 so the destination column still has incoming edges
		// rather than the whole column being orphaned.
		const paths = planEdgePaths(layout, 0, 0, 2);
		assert.equal(paths.length, 2, "synthesised source row");
		for (const d of paths) {
			assert.match(d, /^M 244 88 /, "synthesised source originates at row 0");
		}
	});
});
