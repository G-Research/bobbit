/**
 * Unit tests for the conditional Plan + Children dashboard tabs added in
 * nested-goals task 4.1 (docs/design/nested-goals.md §10.2 + §10.3).
 *
 *   GD-TABS-1  Parent-workflow goal + no children → Plan visible, Children hidden
 *   GD-TABS-2  Parent-workflow goal + 2 children   → Plan + Children both visible
 *   GD-TABS-3  Non-parent-workflow goal + no children → neither tab
 *   GD-TABS-4  Non-parent-workflow goal + descendants → Children visible, Plan hidden
 *   GD-TABS-5  Plan tab is gated on `goal-plan` gate ID specifically
 *   GD-TABS-6  Archived descendants don't trigger the Children tab
 *   GD-TABS-7  Transitive grandchildren count toward Children visibility
 *   GD-TABS-8  Tab ordering is stable: spec, gates, [plan], tasks, agents, [children], commits
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/goal-dashboard-tabs.html")}`;

declare global {
	interface Window {
		shouldShowPlanTab: (goal: any) => boolean;
		shouldShowChildrenTab: (goal: any, goals: any[]) => boolean;
		countDescendantsFrom: (goalId: string, goals: any[]) => number;
		computeVisibleTabs: (goal: any, goals: any[]) => string[];
	}
}

const PARENT_WF = {
	id: "parent",
	name: "Parent Goal",
	description: "",
	gates: [
		{ id: "charter", name: "Charter", dependsOn: [] },
		{ id: "plan-review", name: "Plan Review", dependsOn: ["charter"] },
		{ id: "goal-plan", name: "Approve Plan", dependsOn: ["plan-review"] },
		{ id: "execution", name: "Execution", dependsOn: ["goal-plan"] },
		{ id: "ready-to-merge", name: "Ready", dependsOn: ["execution"] },
	],
};

const FEATURE_WF = {
	id: "feature",
	name: "Feature",
	description: "",
	gates: [
		{ id: "design-doc", name: "Design Doc", dependsOn: [] },
		{ id: "implementation", name: "Implementation", dependsOn: ["design-doc"] },
		{ id: "ready-to-merge", name: "Ready", dependsOn: ["implementation"] },
	],
};

test.describe("GD-TABS-1: parent workflow + no children", () => {
	test("Plan visible, Children hidden", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(({ wf }) => {
			const goal = { id: "g1", title: "Parent", parentGoalId: undefined, archived: false, state: "in-progress", workflow: wf };
			const goals = [goal];
			return {
				plan: window.shouldShowPlanTab(goal),
				children: window.shouldShowChildrenTab(goal, goals),
				tabs: window.computeVisibleTabs(goal, goals),
			};
		}, { wf: PARENT_WF });
		expect(r.plan).toBe(true);
		expect(r.children).toBe(false);
		expect(r.tabs).toEqual(["spec", "gates", "plan", "tasks", "agents", "commits"]);
	});
});

test.describe("GD-TABS-2: parent workflow + 2 children", () => {
	test("Plan and Children both visible", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(({ wf }) => {
			const parent = { id: "g1", title: "Parent", parentGoalId: undefined, archived: false, state: "in-progress", workflow: wf };
			const child1 = { id: "c1", title: "Child 1", parentGoalId: "g1", archived: false, state: "in-progress" };
			const child2 = { id: "c2", title: "Child 2", parentGoalId: "g1", archived: false, state: "complete" };
			const goals = [parent, child1, child2];
			return {
				plan: window.shouldShowPlanTab(parent),
				children: window.shouldShowChildrenTab(parent, goals),
				descCount: window.countDescendantsFrom("g1", goals),
				tabs: window.computeVisibleTabs(parent, goals),
			};
		}, { wf: PARENT_WF });
		expect(r.plan).toBe(true);
		expect(r.children).toBe(true);
		expect(r.descCount).toBe(2);
		expect(r.tabs).toEqual(["spec", "gates", "plan", "tasks", "agents", "children", "commits"]);
	});
});

test.describe("GD-TABS-3: non-parent workflow + no children", () => {
	test("neither Plan nor Children tab is shown", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(({ wf }) => {
			const goal = { id: "g1", title: "Feature goal", parentGoalId: undefined, archived: false, state: "in-progress", workflow: wf };
			const goals = [goal];
			return {
				plan: window.shouldShowPlanTab(goal),
				children: window.shouldShowChildrenTab(goal, goals),
				tabs: window.computeVisibleTabs(goal, goals),
			};
		}, { wf: FEATURE_WF });
		expect(r.plan).toBe(false);
		expect(r.children).toBe(false);
		expect(r.tabs).toEqual(["spec", "gates", "tasks", "agents", "commits"]);
	});

	test("a goal with no workflow at all has neither tab", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const goal = { id: "g1", title: "Bare goal", parentGoalId: undefined, archived: false, state: "in-progress" };
			const goals = [goal];
			return window.computeVisibleTabs(goal, goals);
		});
		expect(r).toEqual(["spec", "gates", "tasks", "agents", "commits"]);
	});
});

test.describe("GD-TABS-4: non-parent workflow + descendants", () => {
	test("Children visible, Plan hidden — children can exist on any workflow", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(({ wf }) => {
			const parent = { id: "g1", title: "Feature parent", parentGoalId: undefined, archived: false, state: "in-progress", workflow: wf };
			const child = { id: "c1", title: "Child", parentGoalId: "g1", archived: false, state: "in-progress" };
			const goals = [parent, child];
			return {
				plan: window.shouldShowPlanTab(parent),
				children: window.shouldShowChildrenTab(parent, goals),
				tabs: window.computeVisibleTabs(parent, goals),
			};
		}, { wf: FEATURE_WF });
		expect(r.plan).toBe(false);
		expect(r.children).toBe(true);
		expect(r.tabs).toEqual(["spec", "gates", "tasks", "agents", "children", "commits"]);
	});
});

test.describe("GD-TABS-5: Plan tab is gated on `goal-plan` gate id specifically", () => {
	test("an unrelated gate id named 'plan' does NOT enable the Plan tab", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const visible = await page.evaluate(() => {
			const goal = {
				id: "g1", title: "Custom workflow goal", parentGoalId: undefined, archived: false, state: "in-progress",
				workflow: {
					id: "custom", name: "Custom", description: "",
					gates: [
						{ id: "plan", name: "Some Plan", dependsOn: [] },
						{ id: "execution", name: "Execution", dependsOn: ["plan"] },
					],
				},
			};
			return window.shouldShowPlanTab(goal);
		});
		expect(visible).toBe(false);
	});

	test("any workflow that contains a `goal-plan` gate enables the Plan tab", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const visible = await page.evaluate(() => {
			const goal = {
				id: "g1", title: "Hybrid", parentGoalId: undefined, archived: false, state: "in-progress",
				workflow: {
					id: "hybrid", name: "Hybrid", description: "",
					gates: [
						{ id: "design-doc", name: "Design", dependsOn: [] },
						{ id: "goal-plan", name: "Approve Plan", dependsOn: ["design-doc"] },
						{ id: "implementation", name: "Implementation", dependsOn: ["goal-plan"] },
					],
				},
			};
			return window.shouldShowPlanTab(goal);
		});
		expect(visible).toBe(true);
	});
});

test.describe("GD-TABS-6: archived descendants don't trigger the Children tab", () => {
	test("a parent whose only child is archived shows no Children tab", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(({ wf }) => {
			const parent = { id: "g1", title: "Parent", parentGoalId: undefined, archived: false, state: "in-progress", workflow: wf };
			const archivedChild = { id: "c1", title: "Old child", parentGoalId: "g1", archived: true, state: "complete" };
			const goals = [parent, archivedChild];
			return {
				children: window.shouldShowChildrenTab(parent, goals),
				descCount: window.countDescendantsFrom("g1", goals),
			};
		}, { wf: PARENT_WF });
		expect(r.children).toBe(false);
		expect(r.descCount).toBe(0);
	});
});

test.describe("GD-TABS-7: grandchildren count toward Children visibility", () => {
	test("a goal with only a grandchild still gets the Children tab", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(({ wf }) => {
			const root = { id: "g1", title: "Root", parentGoalId: undefined, archived: false, state: "in-progress", workflow: wf };
			const mid = { id: "m1", title: "Mid", parentGoalId: "g1", archived: false, state: "in-progress" };
			const grand = { id: "gc1", title: "Grand", parentGoalId: "m1", archived: false, state: "in-progress" };
			const goals = [root, mid, grand];
			return {
				children: window.shouldShowChildrenTab(root, goals),
				descCount: window.countDescendantsFrom("g1", goals),
			};
		}, { wf: FEATURE_WF });
		expect(r.children).toBe(true);
		// 2 = mid + grand
		expect(r.descCount).toBe(2);
	});
});

test.describe("GD-TABS-8: tab ordering invariant", () => {
	test("Plan slots between Gates and Tasks; Children slots between Agents and Commits", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const tabs = await page.evaluate(({ wf }) => {
			const parent = { id: "g1", title: "Parent", parentGoalId: undefined, archived: false, state: "in-progress", workflow: wf };
			const child = { id: "c1", title: "Child", parentGoalId: "g1", archived: false, state: "in-progress" };
			return window.computeVisibleTabs(parent, [parent, child]);
		}, { wf: PARENT_WF });
		// Strict ordering: assert exact array.
		expect(tabs).toEqual(["spec", "gates", "plan", "tasks", "agents", "children", "commits"]);
	});
});
