/**
 * Pure helper for computing SVG edge paths in the Plan-tab DAG (Phase 5a).
 *
 * Given a list of nodes (already-laid-out plan steps) and a list of edges
 * (`fromNodeId → toNodeId`), produce one SVG path per edge. Each edge is a
 * 3-segment connector that exits the RIGHT edge of the source and enters
 * the LEFT edge of the destination, routing through the empty horizontal
 * gap between adjacent phase columns:
 *
 *      from-right-center ───┐
 *                           │   (jog through inter-phase gap)
 *                           └─── to-left-center
 *
 * SVG `d`-string shape: `M x1 y1 L xmid y1 L xmid y2 L x2 y2`.
 *
 * Why right-edge / left-edge (was bottom-center / top-center): with the
 * old shape, when a source node sat below its destination in adjacent
 * phases, the source's upward vertical segment would pass through any
 * sibling nodes above it in the source phase. Right-edge routing keeps
 * the entire path inside the empty band between phases.
 *
 * `midLineX` is the caller's choice for where to put the inter-phase
 * vertical segment. Typical implementations return the mid-x between
 * the source's right and the destination's left, but a caller that
 * wants the segment biased can override.
 *
 * No DOM, no Lit. Phase 5b consumers render the d-strings into `<path>`
 * elements; this module is a pure layout calculation.
 */

export interface PlanEdgeNode {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PlanEdge {
	fromNodeId: string;
	toNodeId: string;
}

export interface ComputedEdgePath {
	fromNodeId: string;
	toNodeId: string;
	d: string;
}

export interface ComputeEdgePathsOpts {
	/**
	 * Optional override for the x-coordinate of the inter-phase vertical
	 * segment. Default: midpoint between the source's right edge and the
	 * destination's left edge. Receives the source.right and dest.left
	 * x-coords for callers that want to bias closer to one side.
	 */
	midLineX?: (fromRightX: number, toLeftX: number) => number;
	/**
	 * @deprecated Legacy bottom/top routing produced edges that crossed
	 * nodes when sources were stacked below destinations in the source
	 * column. Retained only so existing tests can opt into the old shape
	 * for back-compat assertions while they migrate.
	 *
	 * TODO (R-026): remove after PR-merged. Dependent tests in
	 * `tests/plan-edge-paths.test.ts` need to be migrated to the
	 * right/left routing default before this branch can be deleted.
	 */
	midLineY?: (fromY: number, toY: number) => number;
}

function fmt(n: number): string {
	// Trim trivial trailing zeros so test-string compare is stable across
	// integer vs float inputs. Anchor: `1` not `1.0`, `1.5` not `1.500000`.
	return Number.isInteger(n) ? String(n) : String(+n.toFixed(3));
}

export function computeEdgePaths(
	nodes: PlanEdgeNode[],
	edges: PlanEdge[],
	opts: ComputeEdgePathsOpts = {},
): ComputedEdgePath[] {
	const byId = new Map<string, PlanEdgeNode>();
	for (const n of nodes) byId.set(n.id, n);
	const out: ComputedEdgePath[] = [];
	for (const e of edges) {
		const from = byId.get(e.fromNodeId);
		const to = byId.get(e.toNodeId);
		if (!from || !to) continue;
		// Legacy bottom/top routing — kept for tests that still assert the old
		// shape. New consumers should not pass midLineY; the right/left
		// routing below is the default and avoids node-crossing.
		if (opts.midLineY && !opts.midLineX) {
			const x1 = from.x + from.width / 2;
			const y1 = from.y + from.height;
			const x2 = to.x + to.width / 2;
			const y2 = to.y;
			const ymid = opts.midLineY(y1, y2);
			out.push({
				fromNodeId: e.fromNodeId,
				toNodeId: e.toNodeId,
				d: `M ${fmt(x1)} ${fmt(y1)} L ${fmt(x1)} ${fmt(ymid)} L ${fmt(x2)} ${fmt(ymid)} L ${fmt(x2)} ${fmt(y2)}`,
			});
			continue;
		}
		// Right-edge → left-edge routing through the inter-phase gap.
		// The vertical segment lives in the empty band between phase
		// columns, so it never crosses a node regardless of source/dest
		// row offsets.
		const x1 = from.x + from.width;
		const y1 = from.y + from.height / 2;
		const x2 = to.x;
		const y2 = to.y + to.height / 2;
		const xmid = opts.midLineX ? opts.midLineX(x1, x2) : (x1 + x2) / 2;
		out.push({
			fromNodeId: e.fromNodeId,
			toNodeId: e.toNodeId,
			d: `M ${fmt(x1)} ${fmt(y1)} L ${fmt(xmid)} ${fmt(y1)} L ${fmt(xmid)} ${fmt(y2)} L ${fmt(x2)} ${fmt(y2)}`,
		});
	}
	return out;
}
