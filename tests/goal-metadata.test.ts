/**
 * Unit tests for the hierarchical goal-metadata resolver.
 *
 * Pins the contract in `src/server/agent/goal-metadata.ts`:
 *  - `deepMergeMetadata`: object recursion, array/scalar wholesale replace,
 *    scalar/object mismatch replace, input immutability.
 *  - `resolveGoalMetadata`: ancestry deep-merge (descendant wins), missing
 *    parent, unknown goal id, cycle guard, depth cap, fresh-object return.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	deepMergeMetadata,
	resolveGoalMetadata,
	GOAL_METADATA_WALK_DEPTH_CAP,
	type GoalMetadata,
	type GoalMetadataLookup,
} from "../src/server/agent/goal-metadata.ts";

/** In-memory lookup over a flat node map. */
function lookupOf(nodes: Record<string, { parentGoalId?: string; metadata?: GoalMetadata }>): GoalMetadataLookup {
	return { get: (id: string) => nodes[id] };
}

describe("deepMergeMetadata", () => {
	it("recurses into nested plain objects", () => {
		const base = { a: { x: 1, y: 2 } };
		const override = { a: { y: 3, z: 4 } };
		assert.deepEqual(deepMergeMetadata(base, override), { a: { x: 1, y: 3, z: 4 } });
	});

	it("replaces arrays wholesale (no element merge)", () => {
		assert.deepEqual(
			deepMergeMetadata({ tools: ["a", "b"] }, { tools: ["c"] }),
			{ tools: ["c"] },
		);
	});

	it("replaces scalars wholesale", () => {
		assert.deepEqual(deepMergeMetadata({ n: 1, s: "x" }, { n: 2 }), { n: 2, s: "x" });
	});

	it("descendant object replaces ancestor scalar (mismatch)", () => {
		assert.deepEqual(deepMergeMetadata({ a: 1 }, { a: { b: 2 } }), { a: { b: 2 } });
	});

	it("descendant scalar replaces ancestor object (mismatch)", () => {
		assert.deepEqual(deepMergeMetadata({ a: { b: 2 } }, { a: 5 }), { a: 5 });
	});

	it("does not mutate either input", () => {
		const base = { a: { x: 1 } };
		const override = { a: { y: 2 } };
		const out = deepMergeMetadata(base, override);
		out.a = { mutated: true };
		(out as Record<string, unknown>).added = 9;
		assert.deepEqual(base, { a: { x: 1 } });
		assert.deepEqual(override, { a: { y: 2 } });
	});

	it("nested result object is independent of override input", () => {
		const override = { a: { x: 1 } };
		const out = deepMergeMetadata({}, override) as { a: { x: number } };
		out.a.x = 99;
		assert.equal((override.a as { x: number }).x, 1);
	});
});

describe("resolveGoalMetadata", () => {
	it("returns {} for undefined goal id", () => {
		assert.deepEqual(resolveGoalMetadata(lookupOf({}), undefined), {});
	});

	it("returns {} for unknown goal id", () => {
		assert.deepEqual(resolveGoalMetadata(lookupOf({}), "nope"), {});
	});

	it("returns {} for a goal with no metadata", () => {
		assert.deepEqual(resolveGoalMetadata(lookupOf({ a: {} }), "a"), {});
	});

	it("deep-merges a chain root -> ... -> self, descendant wins", () => {
		const nodes = {
			root: { metadata: { "bobbit.disabledTools": ["x"], shared: { a: 1, b: 1 } } },
			mid: { parentGoalId: "root", metadata: { shared: { b: 2, c: 2 } } },
			leaf: { parentGoalId: "mid", metadata: { "bobbit.disabledTools": ["y"] } },
		};
		assert.deepEqual(resolveGoalMetadata(lookupOf(nodes), "leaf"), {
			// leaf overrides root's array wholesale
			"bobbit.disabledTools": ["y"],
			// deep-merged across all three levels; deepest wins per key
			shared: { a: 1, b: 2, c: 2 },
		});
	});

	it("inherits ancestor metadata when descendant omits the key", () => {
		const nodes = {
			root: { metadata: { "hindsight.memory.enabled": false } },
			child: { parentGoalId: "root", metadata: { other: 1 } },
		};
		assert.deepEqual(resolveGoalMetadata(lookupOf(nodes), "child"), {
			"hindsight.memory.enabled": false,
			other: 1,
		});
	});

	it("stops at a missing parent (broken chain) without throwing", () => {
		const nodes = {
			child: { parentGoalId: "ghost", metadata: { a: 1 } },
		};
		assert.deepEqual(resolveGoalMetadata(lookupOf(nodes), "child"), { a: 1 });
	});

	it("guards against cycles", () => {
		const nodes = {
			a: { parentGoalId: "b", metadata: { fromA: 1 } },
			b: { parentGoalId: "a", metadata: { fromB: 2 } },
		};
		// Both visited once; no infinite loop. Merge order is well-defined
		// (root-first of the truncated chain), both keys present.
		const out = resolveGoalMetadata(lookupOf(nodes), "a");
		assert.deepEqual(out, { fromA: 1, fromB: 2 });
	});

	it("honours the depth cap on a very deep chain", () => {
		const nodes: Record<string, { parentGoalId?: string; metadata?: GoalMetadata }> = {};
		const total = GOAL_METADATA_WALK_DEPTH_CAP + 50;
		for (let i = 0; i < total; i++) {
			nodes[`g${i}`] = {
				parentGoalId: i === 0 ? undefined : `g${i - 1}`,
				metadata: { [`k${i}`]: i },
			};
		}
		const out = resolveGoalMetadata(lookupOf(nodes), `g${total - 1}`);
		// Only the nearest GOAL_METADATA_WALK_DEPTH_CAP ancestors are merged.
		assert.equal(Object.keys(out).length, GOAL_METADATA_WALK_DEPTH_CAP);
		assert.ok(Object.prototype.hasOwnProperty.call(out, `k${total - 1}`));
		assert.ok(!Object.prototype.hasOwnProperty.call(out, "k0"));
	});

	it("returns a fresh object decoupled from stored metadata", () => {
		const stored = { a: { x: 1 } };
		const nodes = { g: { metadata: stored } };
		const out = resolveGoalMetadata(lookupOf(nodes), "g") as { a: { x: number } };
		out.a.x = 42;
		assert.equal((stored.a as { x: number }).x, 1);
	});
});
