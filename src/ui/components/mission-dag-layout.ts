// Hand-rolled layered DAG layout.
//
// Algorithm:
//  1. Detect cycles (Tarjan-ish DFS). If a cycle is found, return a fallback
//     layout that arranges all nodes in a single horizontal row so the UI
//     can still render something instead of blowing up.
//  2. Longest-path layering: each node sits in the layer that is one greater
//     than the maximum layer of its incoming neighbours. Roots are layer 0.
//  3. Within each layer, sort nodes by an "average parent layer index"
//     barycenter pass to reduce edge crossings, breaking ties by planId
//     (stable across re-plans because planIds are ULIDs).
//  4. Assign (x, y) coordinates with a fixed cell size.
//
// The output is an absolute coordinate map plus the overall canvas size.
// The renderer (MissionDagSvg.ts) treats this as opaque data so the layout
// engine can be swapped later (e.g. dagre fallback for >30 nodes) without
// touching the SVG code.

export interface DagNode {
	id: string;
}

export interface DagEdge {
	from: string;
	to: string;
}

export interface LayoutOptions {
	nodeWidth?: number;
	nodeHeight?: number;
	colGap?: number;
	rowGap?: number;
	paddingX?: number;
	paddingY?: number;
}

export interface NodePosition {
	x: number;
	y: number;
	layer: number;
	indexInLayer: number;
}

export interface LayoutResult {
	positions: Map<string, NodePosition>;
	size: { w: number; h: number };
	layers: string[][];
	cyclic: boolean;
}

const DEFAULTS: Required<LayoutOptions> = {
	nodeWidth: 160,
	nodeHeight: 56,
	colGap: 60,
	rowGap: 28,
	paddingX: 24,
	paddingY: 24,
};

/** Detect a cycle by Kahn's algorithm — returns true if there's a cycle. */
export function hasCycle(nodes: DagNode[], edges: DagEdge[]): boolean {
	const indeg = new Map<string, number>();
	for (const n of nodes) indeg.set(n.id, 0);
	for (const e of edges) {
		if (indeg.has(e.to)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
	}
	const queue: string[] = [];
	for (const [id, d] of indeg) if (d === 0) queue.push(id);
	const adj = new Map<string, string[]>();
	for (const n of nodes) adj.set(n.id, []);
	for (const e of edges) {
		if (adj.has(e.from)) adj.get(e.from)!.push(e.to);
	}
	let visited = 0;
	while (queue.length) {
		const v = queue.shift()!;
		visited++;
		for (const w of adj.get(v) ?? []) {
			const d = (indeg.get(w) ?? 0) - 1;
			indeg.set(w, d);
			if (d === 0) queue.push(w);
		}
	}
	return visited !== nodes.length;
}

export function layoutDag(
	nodes: DagNode[],
	edges: DagEdge[],
	opts: LayoutOptions = {},
): LayoutResult {
	const o = { ...DEFAULTS, ...opts };
	const positions = new Map<string, NodePosition>();

	if (nodes.length === 0) {
		return { positions, size: { w: o.paddingX * 2, h: o.paddingY * 2 }, layers: [], cyclic: false };
	}

	if (hasCycle(nodes, edges)) {
		// Fallback: lay out in one row.
		nodes.forEach((n, i) => {
			positions.set(n.id, {
				x: o.paddingX + i * (o.nodeWidth + o.colGap),
				y: o.paddingY,
				layer: 0,
				indexInLayer: i,
			});
		});
		return {
			positions,
			size: {
				w: o.paddingX * 2 + nodes.length * (o.nodeWidth + o.colGap) - o.colGap,
				h: o.paddingY * 2 + o.nodeHeight,
			},
			layers: [nodes.map(n => n.id)],
			cyclic: true,
		};
	}

	// Longest-path layering via topological order.
	const indeg = new Map<string, number>();
	const adj = new Map<string, string[]>();
	const radj = new Map<string, string[]>();
	for (const n of nodes) {
		indeg.set(n.id, 0);
		adj.set(n.id, []);
		radj.set(n.id, []);
	}
	for (const e of edges) {
		if (!indeg.has(e.to) || !adj.has(e.from)) continue;
		indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
		adj.get(e.from)!.push(e.to);
		radj.get(e.to)!.push(e.from);
	}
	const topo: string[] = [];
	const queue: string[] = [];
	const indegWork = new Map(indeg);
	for (const [id, d] of indegWork) if (d === 0) queue.push(id);
	while (queue.length) {
		const v = queue.shift()!;
		topo.push(v);
		for (const w of adj.get(v) ?? []) {
			const d = (indegWork.get(w) ?? 0) - 1;
			indegWork.set(w, d);
			if (d === 0) queue.push(w);
		}
	}

	const layer = new Map<string, number>();
	for (const id of topo) {
		let max = -1;
		for (const p of radj.get(id) ?? []) {
			max = Math.max(max, layer.get(p) ?? 0);
		}
		layer.set(id, max + 1);
	}

	// Group by layer.
	const maxLayer = Math.max(...layer.values(), 0);
	const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
	for (const n of nodes) {
		const l = layer.get(n.id) ?? 0;
		layers[l].push(n.id);
	}

	// Initial ordering: stable by id (lexicographic). Then a single
	// barycenter sweep to reduce crossings.
	for (const lay of layers) lay.sort();
	const indexInLayer = new Map<string, number>();
	for (let l = 0; l < layers.length; l++) {
		layers[l].forEach((id, i) => indexInLayer.set(id, i));
	}
	for (let l = 1; l < layers.length; l++) {
		const arr = layers[l];
		arr.sort((a, b) => {
			const aParents = radj.get(a) ?? [];
			const bParents = radj.get(b) ?? [];
			const ba = aParents.length
				? aParents.reduce((s, p) => s + (indexInLayer.get(p) ?? 0), 0) / aParents.length
				: 0;
			const bb = bParents.length
				? bParents.reduce((s, p) => s + (indexInLayer.get(p) ?? 0), 0) / bParents.length
				: 0;
			if (ba !== bb) return ba - bb;
			return a < b ? -1 : a > b ? 1 : 0;
		});
		arr.forEach((id, i) => indexInLayer.set(id, i));
	}

	// Compute coordinates. Each layer gets nodeWidth + colGap horizontally;
	// vertical position centres each layer about the tallest layer count.
	const maxRows = Math.max(...layers.map(l => l.length));
	const layerHeight = (n: number) => n * o.nodeHeight + (n - 1) * o.rowGap;
	const tallH = layerHeight(maxRows);

	for (let l = 0; l < layers.length; l++) {
		const arr = layers[l];
		const h = layerHeight(arr.length);
		const yStart = o.paddingY + (tallH - h) / 2;
		arr.forEach((id, i) => {
			positions.set(id, {
				x: o.paddingX + l * (o.nodeWidth + o.colGap),
				y: yStart + i * (o.nodeHeight + o.rowGap),
				layer: l,
				indexInLayer: i,
			});
		});
	}

	return {
		positions,
		size: {
			w: o.paddingX * 2 + layers.length * (o.nodeWidth + o.colGap) - o.colGap,
			h: o.paddingY * 2 + tallH,
		},
		layers,
		cyclic: false,
	};
}
