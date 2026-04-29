/**
 * Unit tests for the hand-rolled DAG layout used by the mission dashboard.
 *
 * Verifies:
 *  - Empty graph returns empty positions and minimum size.
 *  - Acyclic DAGs produce stable layered coordinates with no two nodes
 *    sharing the same (layer, indexInLayer).
 *  - Cycles are detected and the layout falls back to a single-row layout
 *    rather than throwing.
 *  - Diamond-shaped graph places parallel nodes at the same layer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { layoutDag, hasCycle } from "../src/ui/components/mission-dag-layout.js";

describe("layoutDag", () => {
	it("returns empty layout for empty input", () => {
		const r = layoutDag([], []);
		assert.equal(r.positions.size, 0);
		assert.equal(r.layers.length, 0);
		assert.equal(r.cyclic, false);
		assert.ok(r.size.w > 0 && r.size.h > 0);
	});

	it("places a single node at layer 0", () => {
		const r = layoutDag([{ id: "a" }], []);
		assert.equal(r.cyclic, false);
		assert.equal(r.layers.length, 1);
		assert.deepEqual(r.layers[0], ["a"]);
		const p = r.positions.get("a")!;
		assert.equal(p.layer, 0);
		assert.equal(p.indexInLayer, 0);
	});

	it("layers a linear chain a -> b -> c", () => {
		const r = layoutDag(
			[{ id: "a" }, { id: "b" }, { id: "c" }],
			[{ from: "a", to: "b" }, { from: "b", to: "c" }],
		);
		assert.equal(r.cyclic, false);
		assert.equal(r.positions.get("a")!.layer, 0);
		assert.equal(r.positions.get("b")!.layer, 1);
		assert.equal(r.positions.get("c")!.layer, 2);
	});

	it("layers a diamond — both middle nodes share a layer", () => {
		const r = layoutDag(
			[{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
			[
				{ from: "a", to: "b" }, { from: "a", to: "c" },
				{ from: "b", to: "d" }, { from: "c", to: "d" },
			],
		);
		assert.equal(r.cyclic, false);
		assert.equal(r.positions.get("a")!.layer, 0);
		assert.equal(r.positions.get("b")!.layer, 1);
		assert.equal(r.positions.get("c")!.layer, 1);
		assert.equal(r.positions.get("d")!.layer, 2);
		// Parallel layer must contain both b and c (order is impl-defined).
		assert.equal(r.layers[1].length, 2);
		assert.deepEqual(new Set(r.layers[1]), new Set(["b", "c"]));
	});

	it("detects cycles and uses linear fallback", () => {
		assert.equal(hasCycle(
			[{ id: "a" }, { id: "b" }],
			[{ from: "a", to: "b" }, { from: "b", to: "a" }],
		), true);
		const r = layoutDag(
			[{ id: "a" }, { id: "b" }],
			[{ from: "a", to: "b" }, { from: "b", to: "a" }],
		);
		assert.equal(r.cyclic, true);
		assert.equal(r.positions.size, 2);
		assert.equal(r.layers.length, 1);
	});

	it("assigns unique indexInLayer within each layer", () => {
		const r = layoutDag(
			[
				{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" },
			],
			[
				{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "a", to: "d" },
				{ from: "b", to: "e" }, { from: "c", to: "e" }, { from: "d", to: "e" },
			],
		);
		const seen = new Map<string, Set<number>>();
		for (const [_id, pos] of r.positions) {
			const key = String(pos.layer);
			if (!seen.has(key)) seen.set(key, new Set());
			const s = seen.get(key)!;
			assert.equal(s.has(pos.indexInLayer), false, `duplicate index ${pos.indexInLayer} in layer ${key}`);
			s.add(pos.indexInLayer);
		}
	});
});
