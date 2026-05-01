/**
 * Unit tests for the Children-tab visibility predicate on the goal dashboard.
 *
 * Pinned regression: a parent goal on a non-`parent` workflow (e.g. `general`,
 * `feature`, `bug-fix`) that spawned children via `goal_spawn_child` used to
 * have no Children tab — the visibility predicate was effectively keyed off
 * the same `goal-plan` gate as the Plan tab. The fix decouples them: Plan =
 * "did we approve a DAG?", Children = "what children exist?". The two are
 * orthogonal.
 *
 * The pure predicate lives in `src/app/goal-dashboard-tab-visibility.ts` so
 * Node-style tests (no DOM / lit / state imports) can exercise it.
 *
 * See:
 *   - docs/design/nested-goals.md §10.2 (Plan tab visibility)
 *   - docs/design/nested-goals.md §10.3 (Children tab visibility)
 *
 * Note: `tests/goal-dashboard-tabs.spec.ts` covers the same predicates via
 * a `file://` Playwright fixture. This Node-style spec is the canonical
 * regression for the orthogonality invariant — Children must not depend on
 * the workflow having a `goal-plan` gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	shouldShowChildrenTab,
	shouldShowPlanTab,
	hasChildGoals,
	countDescendantsFrom,
	type GoalLike,
} from "../src/app/goal-dashboard-tab-visibility.ts";

const PARENT_WF: GoalLike["workflow"] = {
	gates: [
		{ id: "charter" },
		{ id: "plan-review" },
		{ id: "goal-plan" },
		{ id: "execution" },
		{ id: "ready-to-merge" },
	],
};

const FEATURE_WF: GoalLike["workflow"] = {
	gates: [
		{ id: "design-doc" },
		{ id: "implementation" },
		{ id: "ready-to-merge" },
	],
};

function goal(over: Partial<GoalLike> & { id: string }): GoalLike {
	return { archived: false, ...over };
}

describe("shouldShowChildrenTab — visibility independent of goal-plan gate", () => {
	it("CT-1: goal with no children + workflow has no goal-plan gate → no Children tab", () => {
		// Reproduces the user-reported state: a feature-workflow goal with no
		// children should not get the Children tab.
		const g = goal({ id: "g1", workflow: FEATURE_WF });
		assert.equal(shouldShowChildrenTab(g, [g]), false);
		// Sanity: Plan tab also absent — feature workflow has no goal-plan gate.
		assert.equal(shouldShowPlanTab(g), false);
	});

	it("CT-2: goal with children + workflow has no goal-plan gate (general/feature/bug-fix) → Children tab visible", () => {
		// THE pinned regression. Pre-fix, this returned false because the
		// Children tab visibility was effectively gated on goal-plan.
		const parent = goal({ id: "g-root", workflow: FEATURE_WF });
		const c1 = goal({ id: "c1", parentGoalId: "g-root" });
		const c2 = goal({ id: "c2", parentGoalId: "g-root" });
		const goals = [parent, c1, c2];
		assert.equal(shouldShowChildrenTab(parent, goals), true);
		// Plan tab still hidden — workflow has no goal-plan gate.
		assert.equal(shouldShowPlanTab(parent), false);
		// And the Children rule is independent of the workflow shape entirely:
		const noWf = goal({ id: "g-bare" });
		const cBare = goal({ id: "c-bare", parentGoalId: "g-bare" });
		assert.equal(shouldShowChildrenTab(noWf, [noWf, cBare]), true);
	});

	it("CT-3: goal with children + workflow has goal-plan gate → both Plan AND Children tabs visible", () => {
		// The two predicates are orthogonal — both should fire here.
		const parent = goal({ id: "g-root", workflow: PARENT_WF });
		const c1 = goal({ id: "c1", parentGoalId: "g-root" });
		const goals = [parent, c1];
		assert.equal(shouldShowPlanTab(parent), true);
		assert.equal(shouldShowChildrenTab(parent, goals), true);
	});

	it("CT-4: a workflow gate named `plan` (not `goal-plan`) does NOT enable Plan tab — strict id match", () => {
		// Defence against a future workflow author choosing `plan` as the gate
		// id; the Plan tab is keyed on the literal `goal-plan` id.
		const g = goal({
			id: "g1",
			workflow: { gates: [{ id: "plan" }, { id: "execution" }] },
		});
		assert.equal(shouldShowPlanTab(g), false);
	});

	it("CT-5: archived descendants do not trigger the Children tab", () => {
		const parent = goal({ id: "g-root", workflow: PARENT_WF });
		const archived = goal({ id: "c-old", parentGoalId: "g-root", archived: true });
		assert.equal(shouldShowChildrenTab(parent, [parent, archived]), false);
		assert.equal(countDescendantsFrom("g-root", [parent, archived]), 0);
	});

	it("CT-6: transitive grandchildren count toward Children visibility", () => {
		// Mirrors the hierarchical case from `tests/goal-dashboard-tabs.spec.ts`
		// in Node form so the invariant has a fast (no-Playwright) regression
		// path.
		const root = goal({ id: "root", workflow: FEATURE_WF });
		const mid = goal({ id: "mid", parentGoalId: "root" });
		const grand = goal({ id: "grand", parentGoalId: "mid" });
		const goals = [root, mid, grand];
		assert.equal(shouldShowChildrenTab(root, goals), true);
		assert.equal(countDescendantsFrom("root", goals), 2);
	});

	it("CT-7: null / undefined goal returns false — no crash", () => {
		assert.equal(shouldShowChildrenTab(null, []), false);
		assert.equal(shouldShowChildrenTab(undefined, []), false);
		assert.equal(shouldShowPlanTab(null), false);
		assert.equal(shouldShowPlanTab(undefined), false);
	});
});

describe("hasChildGoals — immediate-children helper", () => {
	it("returns true for at least one immediate non-archived child", () => {
		const goals: GoalLike[] = [
			goal({ id: "p" }),
			goal({ id: "c", parentGoalId: "p" }),
		];
		assert.equal(hasChildGoals("p", goals), true);
	});

	it("returns false when only descendants are grandchildren", () => {
		// Important: this is the immediate-children variant. The Children tab
		// uses the transitive predicate (`shouldShowChildrenTab`); this helper
		// is the strict immediate-only check the task spec calls out.
		const goals: GoalLike[] = [
			goal({ id: "p" }),
			goal({ id: "m", parentGoalId: "p" }),
			goal({ id: "g", parentGoalId: "m" }),
		];
		assert.equal(hasChildGoals("p", goals), true); // direct child m
		// remove the direct child — only the grandchild remains
		const grandOnly = goals.filter(g => g.id !== "m");
		assert.equal(hasChildGoals("p", grandOnly), false);
	});

	it("ignores archived children", () => {
		const goals: GoalLike[] = [
			goal({ id: "p" }),
			goal({ id: "c", parentGoalId: "p", archived: true }),
		];
		assert.equal(hasChildGoals("p", goals), false);
	});

	it("returns false on an empty array", () => {
		assert.equal(hasChildGoals("anything", []), false);
	});
});
