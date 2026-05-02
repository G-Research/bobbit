/**
 * Pure helper for computing SVG edge paths in the Plan-tab DAG (Phase 5a).
 *
 * Given a list of nodes (already-laid-out plan steps) and a list of edges
 * (`fromNodeId → toNodeId`), produce one SVG path per edge. Each edge is a
 * 3-segment "shared mid-line" connector:
 *
 *      from-bottom-center
 *           |          (vertical drop to mid-line)
 *      ── shared mid-line ──   (horizontal jog to destination column)
 *           |          (vertical rise to to-top-center)
 *      to-top-center
 *
 * SVG `d`-string shape: `M x1 y1 L x1 ymid L x2 ymid L x2 y2`.
 *
 * `midLineY` is supplied by the caller — typical implementations return
 * `(fromY + toY) / 2`, but a caller that wants a single horizontal mid-line
 * shared across an entire phase can return a constant.
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
	/** y-coordinate of the shared mid-line between source and destination. */
	midLineY: (fromY: number, toY: number) => number;
}

function fmt(n: number): string {
	// Trim trivial trailing zeros so test-string compare is stable across
	// integer vs float inputs. Anchor: `1` not `1.0`, `1.5` not `1.500000`.
	return Number.isInteger(n) ? String(n) : String(+n.toFixed(3));
}

export function computeEdgePaths(
	nodes: PlanEdgeNode[],
	edges: PlanEdge[],
	opts: ComputeEdgePathsOpts,
): ComputedEdgePath[] {
	const byId = new Map<string, PlanEdgeNode>();
	for (const n of nodes) byId.set(n.id, n);
	const out: ComputedEdgePath[] = [];
	for (const e of edges) {
		const from = byId.get(e.fromNodeId);
		const to = byId.get(e.toNodeId);
		if (!from || !to) continue;
		const x1 = from.x + from.width / 2;
		const y1 = from.y + from.height; // bottom-center
		const x2 = to.x + to.width / 2;
		const y2 = to.y; // top-center
		const ymid = opts.midLineY(y1, y2);
		out.push({
			fromNodeId: e.fromNodeId,
			toNodeId: e.toNodeId,
			d: `M ${fmt(x1)} ${fmt(y1)} L ${fmt(x1)} ${fmt(ymid)} L ${fmt(x2)} ${fmt(ymid)} L ${fmt(x2)} ${fmt(y2)}`,
		});
	}
	return out;
}
