/**
 * Pure helper: compute the SVG `d` attribute for one edge connector
 * between a source node (in column ci) and a destination node (in
 * column ci+1) of the plan DAG.
 *
 * Extracted from `goal-dashboard.ts` so it can be unit-tested under
 * `node:test` without pulling in the Lit / DOM render chain.
 *
 * DAG semantics: in the bobbit plan, phase N+1 starts strictly after
 * EVERY phase N node finishes (full bipartite dependency), so we draw
 * one orthogonal path per `source x destination` pair. All edges share
 * a vertical mid-line in the column gap so they visibly fan out.
 *
 * Live test (PR #409): the original implementation drew straight
 * horizontal lines pinned to the destination row's y-coordinate from
 * the source column's right edge. When the source column had FEWER
 * nodes than the destination column (e.g. 1 \u2192 3 in the v0.1-foundation
 * Phase 1 \u2192 Phase 2 transition), edges for destination rows past the
 * source's last row appeared to float in empty space with no visible
 * origin (the source side of the path lay in vertical whitespace
 * between phantom source-rows that didn't exist).
 */

export interface PlanEdgeLayout {
	planPad: number;
	planColW: number;
	planNodeW: number;
	planNodeH: number;
	planHeaderH: number;
	planRowH: number;
}

/** Compute the y-center of row `r` for plan-DAG node positioning. */
export function planRowY(layout: PlanEdgeLayout, r: number): number {
	return layout.planPad + layout.planHeaderH + r * layout.planRowH + layout.planNodeH / 2;
}

/** Compute the x-coordinate of the source column's right edge (where
 *  edges originate). */
export function planSourceRightX(layout: PlanEdgeLayout, fromColIdx: number): number {
	return layout.planPad + fromColIdx * layout.planColW + layout.planColW / 2 + layout.planNodeW / 2;
}

/** Compute the x-coordinate of the destination column's left edge
 *  (where edges terminate). */
export function planDestLeftX(layout: PlanEdgeLayout, fromColIdx: number): number {
	return layout.planPad + (fromColIdx + 1) * layout.planColW + (layout.planColW - layout.planNodeW) / 2;
}

/** Compute the x-coordinate of the vertical mid-line in the gap
 *  between the source and destination columns. All edges in this
 *  transition share this mid-line so the orthogonal layout looks
 *  organised rather than crossed. */
export function planEdgeMidX(layout: PlanEdgeLayout, fromColIdx: number): number {
	return (planSourceRightX(layout, fromColIdx) + planDestLeftX(layout, fromColIdx)) / 2;
}

/** Build the SVG path `d` attribute for one source\u2192destination edge.
 *  The path is orthogonal: source-right \u2192 mid (horizontal) \u2192
 *  dest-row (vertical) \u2192 dest-left (horizontal).
 *  When source-row === dest-row this degenerates to a straight line
 *  (SVG handles the redundant moves correctly).
 */
export function planEdgePath(
	layout: PlanEdgeLayout,
	fromColIdx: number,
	sourceRow: number,
	destRow: number,
): string {
	const sx = planSourceRightX(layout, fromColIdx);
	const dx = planDestLeftX(layout, fromColIdx);
	const mx = planEdgeMidX(layout, fromColIdx);
	const ys = planRowY(layout, sourceRow);
	const yd = planRowY(layout, destRow);
	return `M ${sx} ${ys} L ${mx} ${ys} L ${mx} ${yd} L ${dx} ${yd}`;
}

/** Build the full set of edge paths between two columns, with the
 *  bipartite DAG semantics: every source node connects to every
 *  destination node. When the source column is empty (defensive: a
 *  phase with no nodes shouldn't really exist post-validation, but it
 *  CAN occur briefly during edits), we synthesise a single source row
 *  at index 0 so the destination column still has incoming edges.
 *  Returns an array of path-d strings, one per (source, dest) pair.
 */
export function planEdgePaths(
	layout: PlanEdgeLayout,
	fromColIdx: number,
	fromRows: number,
	toRows: number,
): string[] {
	const paths: string[] = [];
	const safeFromRows = Math.max(1, fromRows);
	for (let s = 0; s < safeFromRows; s++) {
		for (let d = 0; d < toRows; d++) {
			paths.push(planEdgePath(layout, fromColIdx, s, d));
		}
	}
	return paths;
}
