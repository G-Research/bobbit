/**
 * Phase 5b — sidebar nested-tree render integration tests.
 *
 * Phase 5a covered the pure helper. This file tests the *render-glue*
 * invariants that connect the helper output to the sidebar's per-depth
 * indent rule + descendant badge logic in `renderNestedNode`
 * (`src/app/sidebar.ts`).
 *
 * Specifically:
 *  1. Each NestedGoalNode emits one row at `depth * 16px` left-padding.
 *  2. The descendant-count badge is shown iff `descendantCount > 0`.
 *  3. `truncatedChildrenCount > 0` produces a "Show N more" affordance
 *     at depth + 1 (= one level under the truncated parent).
 *  4. The default depth cap is 5 (matches helper default).
 *
 * We re-implement the small render-glue helper (`flattenForRender`) here
 * — Lit + a real DOM aren't available in node:test. The dual implementation
 * is unavoidable: the production code lives inside Lit templates, which
 * can't be invoked headlessly without a browser. The E2E test
 * `tests/e2e/ui/sidebar-nesting.spec.ts` covers the full DOM path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildNestedGoalForest, type NestedGoalNode, type NestableGoal } from "../src/app/sidebar-nesting.ts";

const INDENT_PX_PER_DEPTH = 16;

interface RenderRow {
	goalId: string;
	depth: number;
	descendantCount: number;
	truncatedChildrenCount: number;
	indentPx: number;
	showsBadge: boolean;
	truncationRow?: { count: number; depth: number; indentPx: number };
}

/** Mirror of the Phase 5b render-glue in `src/app/sidebar.ts::renderNestedNode`. */
function flattenForRender(forest: NestedGoalNode[]): RenderRow[] {
	const out: RenderRow[] = [];
	function walk(node: NestedGoalNode): void {
		const showsBadge = node.descendantCount > 0;
		const row: RenderRow = {
			goalId: node.goal.id,
			depth: node.depth,
			descendantCount: node.descendantCount,
			truncatedChildrenCount: node.truncatedChildrenCount ?? 0,
			indentPx: node.depth * INDENT_PX_PER_DEPTH,
			showsBadge,
		};
		if (node.truncatedChildrenCount && node.truncatedChildrenCount > 0) {
			row.truncationRow = {
				count: node.truncatedChildrenCount,
				depth: node.depth + 1,
				indentPx: (node.depth + 1) * INDENT_PX_PER_DEPTH,
			};
		}
		out.push(row);
		for (const c of node.children) walk(c);
	}
	for (const n of forest) walk(n);
	return out;
}

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

describe("sidebar render-glue: flattenForRender", () => {
	it("emits depth=0 row for a single root with no children", () => {
		const forest = buildNestedGoalForest([g({ id: "a", createdAt: 1 })]);
		const rows = flattenForRender(forest);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].depth, 0);
		assert.equal(rows[0].indentPx, 0);
		assert.equal(rows[0].showsBadge, false);
	});

	it("indents each level by 16px", () => {
		const forest = buildNestedGoalForest([
			g({ id: "root", createdAt: 1 }),
			g({ id: "child", parentGoalId: "root", createdAt: 2 }),
			g({ id: "grandchild", parentGoalId: "child", createdAt: 3 }),
		]);
		const rows = flattenForRender(forest);
		assert.equal(rows.length, 3);
		const byId = new Map(rows.map(r => [r.goalId, r]));
		assert.equal(byId.get("root")!.indentPx, 0);
		assert.equal(byId.get("child")!.indentPx, 16);
		assert.equal(byId.get("grandchild")!.indentPx, 32);
	});

	it("descendant-count badge shows iff descendantCount > 0", () => {
		const forest = buildNestedGoalForest([
			g({ id: "root", createdAt: 1 }),
			g({ id: "c1", parentGoalId: "root", createdAt: 2 }),
			g({ id: "c2", parentGoalId: "root", createdAt: 3 }),
		]);
		const rows = flattenForRender(forest);
		const root = rows.find(r => r.goalId === "root")!;
		const c1 = rows.find(r => r.goalId === "c1")!;
		assert.equal(root.showsBadge, true);
		assert.equal(root.descendantCount, 2);
		assert.equal(c1.showsBadge, false);
		assert.equal(c1.descendantCount, 0);
	});

	it("renders 'Show N more' affordance one level under the truncated parent", () => {
		// Build a chain a→b→c→d. Cap depth at 1 → c+d become 'truncatedChildrenCount: 1' on b.
		const goals: NestableGoal[] = [
			g({ id: "a", createdAt: 1 }),
			g({ id: "b", parentGoalId: "a", createdAt: 2 }),
			g({ id: "c", parentGoalId: "b", createdAt: 3 }),
			g({ id: "d", parentGoalId: "c", createdAt: 4 }),
		];
		const forest = buildNestedGoalForest(goals, { maxDepth: 1 });
		const rows = flattenForRender(forest);
		// We get rows for a + b; b carries truncatedChildrenCount: 1 (c is the truncated child).
		const b = rows.find(r => r.goalId === "b");
		assert.ok(b, "b should be in render output");
		assert.equal(b!.truncatedChildrenCount, 1);
		assert.ok(b!.truncationRow, "truncation row should be produced for b");
		assert.equal(b!.truncationRow!.count, 1);
		assert.equal(b!.truncationRow!.depth, 2);
		assert.equal(b!.truncationRow!.indentPx, 32);
	});

	it("hides archived goals by default", () => {
		const forest = buildNestedGoalForest([
			g({ id: "root", createdAt: 1 }),
			g({ id: "live", parentGoalId: "root", createdAt: 2 }),
			g({ id: "old", parentGoalId: "root", createdAt: 3, archived: true }),
		]);
		const rows = flattenForRender(forest);
		assert.ok(rows.some(r => r.goalId === "live"));
		assert.ok(!rows.some(r => r.goalId === "old"));
	});

	it("respects the documented default depth cap of 5", () => {
		// Build a deep chain a0→a1→…→a7. With default maxDepth=5,
		// a0..a5 render; the deeper ones are truncated.
		const goals: NestableGoal[] = [];
		for (let i = 0; i < 8; i++) {
			goals.push(g({ id: `a${i}`, parentGoalId: i === 0 ? undefined : `a${i - 1}`, createdAt: i + 1 }));
		}
		const forest = buildNestedGoalForest(goals);
		const rows = flattenForRender(forest);
		const rendered = rows.filter(r => !r.goalId.startsWith("__")).map(r => r.goalId);
		// a0..a5 inclusive → 6 rows; a6/a7 should not appear.
		assert.deepEqual(rendered, ["a0", "a1", "a2", "a3", "a4", "a5"]);
		// And a "Show N more" affordance was emitted under a5.
		const a5 = rows.find(r => r.goalId === "a5")!;
		assert.ok(a5.truncationRow);
		assert.equal(a5.truncationRow!.count, 1);
	});
});
