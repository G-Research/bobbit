/**
 * Unit tests for plan-edge-paths (Phase 5a).
 *
 * Covers:
 *  - Single edge → 1 path with valid SVG d
 *  - Bipartite 2x2 → 4 paths sharing mid-line y
 *  - Empty edges → []
 *  - midLineY callback consulted with correct args
 *  - Path d-string is well-formed
 *  - Edges with unknown node ids are skipped
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	computeEdgePaths,
	type PlanEdgeNode,
} from "../src/app/plan-edge-paths.ts";

const D_REGEX = /^M (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) L (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) L (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) L (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)$/;

const node = (id: string, x: number, y: number, w = 100, h = 40): PlanEdgeNode => ({
	id, x, y, width: w, height: h,
});

describe("plan-edge-paths — computeEdgePaths", () => {
	it("single edge → 1 path with valid SVG d", () => {
		const nodes: PlanEdgeNode[] = [node("a", 0, 0), node("b", 0, 100)];
		const paths = computeEdgePaths(
			nodes,
			[{ fromNodeId: "a", toNodeId: "b" }],
			{ midLineY: (y1, y2) => (y1 + y2) / 2 },
		);
		assert.equal(paths.length, 1);
		assert.match(paths[0].d, D_REGEX);
		// from-bottom-center = (50, 40); to-top-center = (50, 100); mid = 70
		assert.equal(paths[0].d, "M 50 40 L 50 70 L 50 70 L 50 100");
	});

	it("bipartite 2x2 → 4 paths sharing the same mid-line y", () => {
		const nodes: PlanEdgeNode[] = [
			node("a", 0, 0),
			node("b", 200, 0),
			node("c", 0, 100),
			node("d", 200, 100),
		];
		// caller wants a single shared horizontal mid-line at y=70
		const paths = computeEdgePaths(
			nodes,
			[
				{ fromNodeId: "a", toNodeId: "c" },
				{ fromNodeId: "a", toNodeId: "d" },
				{ fromNodeId: "b", toNodeId: "c" },
				{ fromNodeId: "b", toNodeId: "d" },
			],
			{ midLineY: () => 70 },
		);
		assert.equal(paths.length, 4);
		for (const p of paths) {
			assert.match(p.d, D_REGEX);
			// the two L-commands' y values must both equal 70
			const m = p.d.match(D_REGEX)!;
			const ymid1 = m[4];
			const ymid2 = m[6];
			assert.equal(ymid1, "70");
			assert.equal(ymid2, "70");
		}
	});

	it("empty edges → empty array", () => {
		const paths = computeEdgePaths(
			[node("a", 0, 0)],
			[],
			{ midLineY: () => 50 },
		);
		assert.deepEqual(paths, []);
	});

	it("midLineY callback called with (fromY, toY)", () => {
		const nodes: PlanEdgeNode[] = [node("a", 0, 0, 100, 40), node("b", 0, 200)];
		let observedFromY = -1;
		let observedToY = -1;
		computeEdgePaths(
			nodes,
			[{ fromNodeId: "a", toNodeId: "b" }],
			{
				midLineY: (y1, y2) => {
					observedFromY = y1;
					observedToY = y2;
					return 0;
				},
			},
		);
		// from-bottom = 0 + 40 = 40; to-top = 200
		assert.equal(observedFromY, 40);
		assert.equal(observedToY, 200);
	});

	it("edges referencing unknown node ids are skipped silently", () => {
		const paths = computeEdgePaths(
			[node("a", 0, 0)],
			[
				{ fromNodeId: "a", toNodeId: "missing" },
				{ fromNodeId: "missing", toNodeId: "a" },
			],
			{ midLineY: () => 50 },
		);
		assert.equal(paths.length, 0);
	});

	it("preserves edge endpoint ids in output", () => {
		const nodes: PlanEdgeNode[] = [node("a", 0, 0), node("b", 0, 100)];
		const paths = computeEdgePaths(
			nodes,
			[{ fromNodeId: "a", toNodeId: "b" }],
			{ midLineY: (y1, y2) => (y1 + y2) / 2 },
		);
		assert.equal(paths[0].fromNodeId, "a");
		assert.equal(paths[0].toNodeId, "b");
	});

	it("default (no opts) routes right→left through the inter-phase gap (no node crossings)", () => {
		// Source below destination in adjacent phases — the case that
		// produced visible node-crossings on the user's screenshot. New
		// default routing keeps the vertical segment in the empty band
		// between phases regardless of source/dest row offsets.
		const lower: PlanEdgeNode = { id: "lower", x: 0, y: 200, width: 100, height: 60 };
		const upper: PlanEdgeNode = { id: "upper", x: 200, y: 0, width: 100, height: 60 };
		const paths = computeEdgePaths([lower, upper], [{ fromNodeId: "lower", toNodeId: "upper" }], {});
		assert.equal(paths.length, 1);
		// Right (x=100, y=230) → midX=150 → (midX, y=30) → left (x=200, y=30)
		assert.equal(paths[0].d, "M 100 230 L 150 230 L 150 30 L 200 30");
	});

	it("default routing: vertical segment never overlaps source-phase nodes", () => {
		// 3 sources stacked + 1 destination — assert every edge's midX
		// sits in the empty inter-phase band (source.right < midX < dest.left).
		const sources = [
			{ id: "s0", x: 0, y: 0,   width: 200, height: 60 },
			{ id: "s1", x: 0, y: 80,  width: 200, height: 60 },
			{ id: "s2", x: 0, y: 160, width: 200, height: 60 },
		];
		const dest = { id: "d0", x: 280, y: 0, width: 200, height: 60 };
		const paths = computeEdgePaths(
			[...sources, dest],
			sources.map(s => ({ fromNodeId: s.id, toNodeId: "d0" })),
			{},
		);
		for (const p of paths) {
			const m = p.d.match(/^M ([\d.]+) ([\d.]+) L ([\d.]+)/);
			assert.ok(m, `path d should match right/left routing shape: ${p.d}`);
			const exitX = Number(m![1]);
			const midX = Number(m![3]);
			assert.equal(exitX, 200, "edge should exit source's right edge");
			assert.ok(midX > 200 && midX < 280, `midX (${midX}) must lie strictly inside the inter-phase gap (200..280)`);
		}
	});
});
