/**
 * Unit tests for goal-dashboard tab-visibility predicates (Phase 5a).
 * Plan-tab visibility rule anchor: the Plan tab is visible when EITHER a formal
 * `goal-plan` gate exists OR live children synthesise a living plan.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
	shouldShowChildrenTab,
	shouldShowPlanTab,
	shouldShowTasksTab,
	type TabVisibilityGoal,
} from "../src/app/goal-dashboard-tab-visibility.ts";
import { _setSubgoalsEnabledForTesting } from "../src/app/subgoals-flag.ts";

// Pre-existing tests assert the post-flag-flip ON behaviour. The flag
// itself is gated by an explicit unit test in tests/subgoals-flag.test.ts.
before(() => _setSubgoalsEnabledForTesting(true));
after(() => _setSubgoalsEnabledForTesting(undefined));

describe("goal-dashboard-tab-visibility — shouldShowPlanTab", () => {
	it("true when workflow has a goal-plan gate", () => {
		const g: TabVisibilityGoal = {
			id: "x",
			workflow: { gates: [{ id: "charter" }, { id: "goal-plan" }, { id: "execution" }] },
		};
		assert.equal(shouldShowPlanTab(g, []), true);
	});

	it("true when allGoals contains a child of this goal", () => {
		const g: TabVisibilityGoal = { id: "x" };
		const all: TabVisibilityGoal[] = [
			{ id: "x" },
			{ id: "child", parentGoalId: "x" },
		];
		assert.equal(shouldShowPlanTab(g, all), true);
	});

	it("false when no goal-plan gate and no children", () => {
		const g: TabVisibilityGoal = {
			id: "x",
			workflow: { gates: [{ id: "charter" }, { id: "implementation" }] },
		};
		const all: TabVisibilityGoal[] = [{ id: "x" }, { id: "other" }];
		assert.equal(shouldShowPlanTab(g, all), false);
	});

	it("false when allGoals omitted and no formal gate", () => {
		assert.equal(shouldShowPlanTab({ id: "x" }), false);
	});
});

describe("goal-dashboard-tab-visibility — shouldShowTasksTab", () => {
	it("true when taskCount > 0", () => {
		assert.equal(shouldShowTasksTab({ id: "x" }, 1), true);
		assert.equal(shouldShowTasksTab({ id: "x" }, 99), true);
	});

	it("false when taskCount is 0", () => {
		assert.equal(shouldShowTasksTab({ id: "x" }, 0), false);
	});
});

describe("goal-dashboard-tab-visibility — shouldShowChildrenTab", () => {
	it("true when hasAnyChildGoals is true", () => {
		assert.equal(shouldShowChildrenTab({ id: "x" }, true), true);
	});

	it("false when hasAnyChildGoals is false", () => {
		assert.equal(shouldShowChildrenTab({ id: "x" }, false), false);
	});
});
