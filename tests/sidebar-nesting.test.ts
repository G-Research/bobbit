/**
 * Unit tests for sidebar-nesting (Phase 5a, pure helper).
 *
 * Covers buildNestedGoalForest + buildNestedSubtree:
 *   - Single root, no children
 *   - Root + multiple children with descendantCount aggregation
 *   - Three generations (recursive descendantCount)
 *   - Orphan promotion when parentGoalId points at a missing goal
 *   - maxDepth cap with truncatedChildrenCount
 *   - Archived filtering (default exclude / includeArchived flag)
 *   - buildNestedSubtree (happy path + missing root)
 *   - Sibling order by createdAt ASC
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildNestedGoalForest,
	buildNestedSubtree,
	type NestableGoal,
} from "../src/app/sidebar-nesting.ts";

function g(over: Partial<NestableGoal> & { id: string; createdAt: number }): NestableGoal {
	return {
		id: over.id,
		parentGoalId: over.parentGoalId,
		rootGoalId: over.rootGoalId,
		archived: over.archived,
		title: over.title ?? `Goal ${over.id}`,
		state: over.state ?? "todo",
		paused: over.paused,
		createdAt: over.createdAt,
	};
}

describe("sidebar-nesting — buildNestedGoalForest", () => {
	it("single root, no children", () => {
		const forest = buildNestedGoalForest([g({ id: "a", createdAt: 1 })]);
		assert.equal(forest.length, 1);
		assert.equal(forest[0].goal.id, "a");
		assert.equal(forest[0].depth, 0);
		assert.equal(forest[0].children.length, 0);
		assert.equal(forest[0].descendantCount, 0);
		assert.equal(forest[0].truncatedChildrenCount, undefined);
	});

	it("root + 2 children → descendantCount 2", () => {
		const forest = buildNestedGoalForest([
			g({ id: "root", createdAt: 1 }),
			g({ id: "c1", parentGoalId: "root", createdAt: 2 }),
			g({ id: "c2", parentGoalId: "root", createdAt: 3 }),
		]);
		assert.equal(forest.length, 1);
		assert.equal(forest[0].children.length, 2);
		assert.equal(forest[0].descendantCount, 2);
		assert.deepEqual(forest[0].children.map(c => c.goal.id), ["c1", "c2"]);
		assert.equal(forest[0].children[0].depth, 1);
	});

	it("three generations → root.descendantCount=2, child.descendantCount=1", () => {
		const forest = buildNestedGoalForest([
			g({ id: "root", createdAt: 1 }),
			g({ id: "child", parentGoalId: "root", createdAt: 2 }),
			g({ id: "grand", parentGoalId: "child", createdAt: 3 }),
		]);
		assert.equal(forest.length, 1);
		assert.equal(forest[0].descendantCount, 2);
		assert.equal(forest[0].children[0].descendantCount, 1);
		assert.equal(forest[0].children[0].children[0].depth, 2);
	});

	it("orphan child (parent missing) → promoted to top-level", () => {
		const forest = buildNestedGoalForest([
			g({ id: "ghost-child", parentGoalId: "missing-parent", createdAt: 10 }),
			g({ id: "regular-root", createdAt: 11 }),
		]);
		assert.equal(forest.length, 2);
		const ids = forest.map(n => n.goal.id).sort();
		assert.deepEqual(ids, ["ghost-child", "regular-root"]);
		// orphan rendered at depth 0
		const orphanNode = forest.find(n => n.goal.id === "ghost-child")!;
		assert.equal(orphanNode.depth, 0);
	});

	it("maxDepth cap → truncates and stamps truncatedChildrenCount", () => {
		const goals: NestableGoal[] = [
			g({ id: "a", createdAt: 1 }),
			g({ id: "b", parentGoalId: "a", createdAt: 2 }),
			g({ id: "c", parentGoalId: "b", createdAt: 3 }),
			g({ id: "d", parentGoalId: "c", createdAt: 4 }),
			g({ id: "e", parentGoalId: "d", createdAt: 5 }),
		];
		const forest = buildNestedGoalForest(goals, { maxDepth: 2 });
		// a (depth 0) → b (depth 1) → c (depth 2, no further recursion)
		const a = forest[0];
		assert.equal(a.children.length, 1);
		const b = a.children[0];
		assert.equal(b.children.length, 1);
		const c = b.children[0];
		// c has 1 direct child (d) but depth+1 (3) > maxDepth (2)
		assert.equal(c.depth, 2);
		assert.equal(c.children.length, 0);
		assert.equal(c.truncatedChildrenCount, 1);
	});

	it("archived children excluded by default", () => {
		const forest = buildNestedGoalForest([
			g({ id: "root", createdAt: 1 }),
			g({ id: "live", parentGoalId: "root", createdAt: 2 }),
			g({ id: "dead", parentGoalId: "root", createdAt: 3, archived: true }),
		]);
		assert.equal(forest[0].children.length, 1);
		assert.equal(forest[0].children[0].goal.id, "live");
		assert.equal(forest[0].descendantCount, 1);
	});

	it("archived children included with includeArchived=true", () => {
		const forest = buildNestedGoalForest([
			g({ id: "root", createdAt: 1 }),
			g({ id: "live", parentGoalId: "root", createdAt: 2 }),
			g({ id: "dead", parentGoalId: "root", createdAt: 3, archived: true }),
		], { includeArchived: true });
		assert.equal(forest[0].children.length, 2);
		assert.equal(forest[0].descendantCount, 2);
	});

	it("children sorted by createdAt ASC even when input order differs", () => {
		const forest = buildNestedGoalForest([
			g({ id: "root", createdAt: 1 }),
			g({ id: "late", parentGoalId: "root", createdAt: 100 }),
			g({ id: "early", parentGoalId: "root", createdAt: 5 }),
			g({ id: "mid", parentGoalId: "root", createdAt: 50 }),
		]);
		assert.deepEqual(
			forest[0].children.map(c => c.goal.id),
			["early", "mid", "late"],
		);
	});
});

describe("sidebar-nesting — buildNestedSubtree", () => {
	it("returns single tree at requested root", () => {
		const goals: NestableGoal[] = [
			g({ id: "root", createdAt: 1 }),
			g({ id: "c", parentGoalId: "root", createdAt: 2 }),
			g({ id: "gc", parentGoalId: "c", createdAt: 3 }),
			g({ id: "unrelated", createdAt: 0 }),
		];
		const sub = buildNestedSubtree("c", goals);
		assert.ok(sub);
		assert.equal(sub!.goal.id, "c");
		assert.equal(sub!.depth, 0);
		assert.equal(sub!.descendantCount, 1);
		assert.equal(sub!.children[0].goal.id, "gc");
	});

	it("returns undefined for nonexistent rootId", () => {
		const sub = buildNestedSubtree("missing", [g({ id: "a", createdAt: 1 })]);
		assert.equal(sub, undefined);
	});

	it("respects archived filter on the requested root", () => {
		const goals: NestableGoal[] = [
			g({ id: "archived-root", createdAt: 1, archived: true }),
		];
		// excluded by default → undefined
		assert.equal(buildNestedSubtree("archived-root", goals), undefined);
		// included via opt → present
		const sub = buildNestedSubtree("archived-root", goals, { includeArchived: true });
		assert.ok(sub);
		assert.equal(sub!.goal.id, "archived-root");
	});
});
