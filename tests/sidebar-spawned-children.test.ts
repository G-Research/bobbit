/**
 * Pure unit tests for src/app/sidebar-spawned-children.ts.
 *
 * These pin the three defensive mechanics applied to the recursive
 * spawned-children sidebar render path:
 *
 *   1. Dedupe by id — a reducer race that leaves two copies of the same
 *      goal in state.goals must NOT render two rows.
 *   2. Deterministic sort — createdAt asc, ties broken by id asc — so two
 *      distinct goals with identical titles don't shuffle order on every
 *      render. (This was visibly the case in the user's image #39: the
 *      "duplicate" set of audits had a different order than the "first"
 *      set.)
 *   3. Id-cycle detection — `isAncestorCycle` returns true only when
 *      child.id is already in the visited set. Title-collision (different
 *      ids, same title) is NOT a cycle and the renderer must show both.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	selectSpawnedChildren,
	isAncestorCycle,
	extendAncestors,
	computeTitleSuffixes,
	type SpawnedChildLike,
} from "../src/app/sidebar-spawned-children.ts";

function g(over: Partial<SpawnedChildLike> & { id: string }): SpawnedChildLike {
	return {
		parentGoalId: undefined,
		spawnedBySessionId: undefined,
		archived: false,
		createdAt: 0,
		...over,
	};
}

describe("selectSpawnedChildren — filter, dedupe, sort", () => {
	it("returns only goals with matching parentId and leadId", () => {
		const goals = [
			g({ id: "a", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1 }),
			g({ id: "b", parentGoalId: "P", spawnedBySessionId: "OTHER", createdAt: 2 }),
			g({ id: "c", parentGoalId: "OTHER", spawnedBySessionId: "L", createdAt: 3 }),
			g({ id: "d", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 4 }),
		];
		const out = selectSpawnedChildren(goals, "P", "L", false);
		assert.deepEqual(out.map(x => x.id), ["a", "d"]);
	});

	it("excludes archived goals when showArchived is false", () => {
		const goals = [
			g({ id: "live", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1, archived: false }),
			g({ id: "arc",  parentGoalId: "P", spawnedBySessionId: "L", createdAt: 2, archived: true }),
		];
		assert.deepEqual(selectSpawnedChildren(goals, "P", "L", false).map(x => x.id), ["live"]);
		assert.deepEqual(selectSpawnedChildren(goals, "P", "L", true).map(x => x.id), ["live", "arc"]);
	});

	it("dedupes by id — reducer race producing two copies of the same goal renders one row", () => {
		// Same id appearing twice (different mutations of the same logical goal —
		// shouldn't happen, but if it does the renderer must not show two rows).
		const goals = [
			g({ id: "x", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1, title: "first-copy" }),
			g({ id: "x", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 5, title: "second-copy" }),
		];
		const out = selectSpawnedChildren(goals, "P", "L", false);
		assert.equal(out.length, 1);
		assert.equal(out[0].id, "x");
		// Whichever wins must be deterministic — first-write-wins by sort order.
		assert.equal(out[0].title, "first-copy",
			"first occurrence wins so render order is stable across renders");
	});

	it("sorts by createdAt asc — same titles, different ids stay in deterministic order", () => {
		const goals = [
			g({ id: "later",   parentGoalId: "P", spawnedBySessionId: "L", createdAt: 200, title: "AUDIT: CLAUDE CODE" }),
			g({ id: "earlier", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 100, title: "AUDIT: CLAUDE CODE" }),
			g({ id: "middle",  parentGoalId: "P", spawnedBySessionId: "L", createdAt: 150, title: "AUDIT: CLAUDE CODE" }),
		];
		const out = selectSpawnedChildren(goals, "P", "L", false);
		assert.deepEqual(out.map(x => x.id), ["earlier", "middle", "later"]);
	});

	it("sort tiebreak on id asc when createdAt is identical", () => {
		const goals = [
			g({ id: "zeta",  parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1 }),
			g({ id: "alpha", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1 }),
			g({ id: "kilo",  parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1 }),
		];
		assert.deepEqual(
			selectSpawnedChildren(goals, "P", "L", false).map(x => x.id),
			["alpha", "kilo", "zeta"],
			"with identical createdAt, ids decide ordering — alpha < kilo < zeta",
		);
	});

	it("returns [] when no goal matches", () => {
		const goals = [g({ id: "a", parentGoalId: "OTHER", spawnedBySessionId: "L" })];
		assert.deepEqual(selectSpawnedChildren(goals, "P", "L", false), []);
	});
});

describe("isAncestorCycle — id-only cycle detection", () => {
	it("returns true when child.id is in renderedAncestors", () => {
		const ancestors = new Set(["root", "child-a"]);
		assert.equal(isAncestorCycle("child-a", ancestors), true);
	});

	it("returns false when child.id is NOT in renderedAncestors", () => {
		const ancestors = new Set(["root", "child-a"]);
		assert.equal(isAncestorCycle("child-b", ancestors), false);
	});

	it("returns false when ancestors is undefined (top-level render)", () => {
		assert.equal(isAncestorCycle("anything", undefined), false);
	});

	it("returns false when ancestors is empty", () => {
		assert.equal(isAncestorCycle("anything", new Set()), false);
	});

	it("DOES NOT detect title-collisions — two distinct ids with same title both render", () => {
		// Critical invariant: the renderer must show BOTH "AUDIT: CLAUDE CODE"
		// goals when the data has two distinct ids with the same title.
		// Detecting title-cycles would risk hiding legitimate sibling patterns
		// where multiple subgoals share a name (e.g. parallel "QA" tasks).
		const ancestors = new Set(["audit-claude-code-A"]);
		assert.equal(isAncestorCycle("audit-claude-code-B", ancestors), false,
			"different id => not a cycle, even when titles collide");
	});
});

describe("extendAncestors — pure, never mutates input", () => {
	it("returns a new set containing the new goal id and the old ancestors", () => {
		const prev = new Set(["root", "a"]);
		const next = extendAncestors(prev, "b");
		assert.deepEqual([...next].sort(), ["a", "b", "root"]);
	});

	it("does not mutate the input set", () => {
		const prev = new Set(["root"]);
		const next = extendAncestors(prev, "child");
		assert.deepEqual([...prev], ["root"], "input should be untouched");
		assert.equal(next.has("child"), true);
		assert.equal(prev.has("child"), false);
	});

	it("returns a single-element set when prev is undefined", () => {
		const next = extendAncestors(undefined, "lonely");
		assert.deepEqual([...next], ["lonely"]);
	});
});

describe("computeTitleSuffixes — sibling disambiguator", () => {
	it("siblings with same title get a 6-char suffix; unique titles get undefined", () => {
		const siblings = [
			{ id: "abc123def", title: "AUDIT: CLAUDE CODE" },
			{ id: "fed987cba", title: "AUDIT: CLAUDE CODE" },
			{ id: "unique-1", title: "AUDIT: BOBBIT HARNESS" },
		];
		const result = computeTitleSuffixes(siblings);
		assert.equal(result.get("abc123def"), "abc123");
		assert.equal(result.get("fed987cba"), "fed987");
		assert.equal(result.get("unique-1"), undefined);
	});

	it("returns empty map for empty siblings", () => {
		assert.equal(computeTitleSuffixes([]).size, 0);
	});

	it("undefined title behaves as empty string for collision detection", () => {
		const siblings = [
			{ id: "111111aaa", title: undefined },
			{ id: "222222bbb", title: undefined },
		];
		const result = computeTitleSuffixes(siblings);
		// Both have empty title — collision triggers, both get suffixes.
		assert.equal(result.get("111111aaa"), "111111");
		assert.equal(result.get("222222bbb"), "222222");
	});
});

describe("integration: simulated recursion never loops on id-cycles", () => {
	// Manually walk a goal tree the same way render-helpers would, using the
	// pure helpers. Confirm: an id-cycle in the data is detected at the
	// child-render layer and recursion stops cleanly.
	function walk(
		goals: SpawnedChildLike[],
		parentId: string,
		leadId: string,
		ancestors: ReadonlySet<string> | undefined,
		visited: string[],
		depth = 0,
		cap = 50,
	): void {
		if (depth > cap) {
			throw new Error(`recursion exceeded cap=${cap} — cycle guard failed`);
		}
		const children = selectSpawnedChildren(goals, parentId, leadId, false);
		for (const child of children) {
			if (isAncestorCycle(child.id, ancestors)) {
				visited.push(`LOOP(${child.id})`);
				continue;
			}
			visited.push(child.id);
			const next = extendAncestors(ancestors, child.id);
			// Each child opens a new "spawn" tree — for the test we just
			// continue treating the same parentId/leadId so cycles are
			// reachable.
			walk(goals, child.id, leadId, next, visited, depth + 1, cap);
		}
	}

	it("id-cycle: A spawns B, B spawns A — recursion terminates with LOOP marker", () => {
		const goals: SpawnedChildLike[] = [
			g({ id: "A", parentGoalId: "ROOT", spawnedBySessionId: "L", createdAt: 1 }),
			g({ id: "B", parentGoalId: "A",    spawnedBySessionId: "L", createdAt: 2 }),
			g({ id: "A", parentGoalId: "B",    spawnedBySessionId: "L", createdAt: 3 }), // cycle: A re-appears as child of B
		];
		const visited: string[] = [];
		walk(goals, "ROOT", "L", new Set(["ROOT"]), visited);
		// First A renders; A → B; B → "A again" but A is in ancestors → LOOP marker.
		assert.deepEqual(visited, ["A", "B", "LOOP(A)"]);
	});

	it("title-collision (different ids): both render, no LOOP marker", () => {
		const goals: SpawnedChildLike[] = [
			g({ id: "A1", parentGoalId: "ROOT", spawnedBySessionId: "L", createdAt: 1, title: "AUDIT" }),
			g({ id: "A2", parentGoalId: "A1",   spawnedBySessionId: "L", createdAt: 2, title: "AUDIT" }),
		];
		const visited: string[] = [];
		walk(goals, "ROOT", "L", new Set(["ROOT"]), visited);
		// Both AUDIT goals render — title collision is not a cycle.
		assert.deepEqual(visited, ["A1", "A2"]);
		assert.ok(!visited.some(v => v.startsWith("LOOP")), "no LOOP marker for distinct ids");
	});
});
