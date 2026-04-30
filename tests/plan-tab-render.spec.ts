/**
 * Unit tests for the Plan tab's hand-rolled SVG layout + node-card and the
 * edit-button visibility rule (nested-goals task 4.2).
 *
 * See docs/design/nested-goals.md §10.2.
 *
 *   PT-1  5 plan nodes across 3 phases → 3 columns, 5 nodes
 *   PT-2  Edit visible when goal-plan gate is pending
 *   PT-3  Edit visible when goal.paused === true (even after freeze)
 *   PT-4  Edit hidden when goal-plan gate has passed and goal is not paused
 *   PT-5  Empty plan (no subgoal verify steps) → no columns
 *   PT-6  Phase grouping handles sparse phase numbers and stable title sort
 *   PT-7  extractPlanSteps ignores non-subgoal verify steps and malformed entries
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/plan-tab-render.html")}`;

declare global {
	interface Window {
		extractPlanSteps: (goal: any) => any[];
		computePlanColumns: (steps: any[]) => Array<{ phase: number; nodes: any[] }>;
		isPlanEditable: (
			goal: any,
			gateStates: Array<{ gateId: string; status: "pending" | "passed" | "failed" }>,
		) => boolean;
		buildPlan: (nodesPerPhase: Record<number, number>) => any;
	}
}

test.describe("PT-1: 5 plan nodes across 3 phases → 3 columns, 5 nodes", () => {
	test("computePlanColumns groups by phase and reports correct counts", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const goal = window.buildPlan({ 1: 2, 2: 2, 3: 1 });
			const steps = window.extractPlanSteps(goal);
			const cols = window.computePlanColumns(steps);
			return {
				stepCount: steps.length,
				columnCount: cols.length,
				phasesInOrder: cols.map(c => c.phase),
				nodesPerColumn: cols.map(c => c.nodes.length),
				totalNodes: cols.reduce((acc, c) => acc + c.nodes.length, 0),
			};
		});
		expect(r.stepCount).toBe(5);
		expect(r.columnCount).toBe(3);
		expect(r.phasesInOrder).toEqual([1, 2, 3]);
		expect(r.nodesPerColumn).toEqual([2, 2, 1]);
		expect(r.totalNodes).toBe(5);
	});
});

test.describe("PT-2: Edit visible when goal-plan gate is pending", () => {
	test("isPlanEditable returns true when goal-plan status is pending", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const goal = window.buildPlan({ 1: 1 });
			return window.isPlanEditable(goal, [{ gateId: "goal-plan", status: "pending" }]);
		});
		expect(r).toBe(true);
	});

	test("isPlanEditable returns true when no gate-state entry for goal-plan exists", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const goal = window.buildPlan({ 1: 1 });
			return window.isPlanEditable(goal, []);
		});
		// Absence == pending == editable
		expect(r).toBe(true);
	});
});

test.describe("PT-3: Edit visible when goal.paused", () => {
	test("isPlanEditable returns true if paused even though goal-plan has passed", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const goal = { ...window.buildPlan({ 1: 1 }), paused: true };
			return window.isPlanEditable(goal, [{ gateId: "goal-plan", status: "passed" }]);
		});
		expect(r).toBe(true);
	});
});

test.describe("PT-4: Edit hidden when frozen and not paused", () => {
	test("isPlanEditable returns false when goal-plan passed and goal not paused", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const goal = window.buildPlan({ 1: 1 });
			return window.isPlanEditable(goal, [{ gateId: "goal-plan", status: "passed" }]);
		});
		expect(r).toBe(false);
	});

	test("isPlanEditable returns false when null goal", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => window.isPlanEditable(null, []));
		expect(r).toBe(false);
	});
});

test.describe("PT-5: Empty plan", () => {
	test("a goal whose execution gate has no verify[] yields zero columns", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const goal = window.buildPlan({});
			const steps = window.extractPlanSteps(goal);
			const cols = window.computePlanColumns(steps);
			return { stepCount: steps.length, columnCount: cols.length };
		});
		expect(r.stepCount).toBe(0);
		expect(r.columnCount).toBe(0);
	});

	test("a goal with no workflow at all yields zero plan steps", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => window.extractPlanSteps({ id: "g", title: "x" }));
		expect(r.length).toBe(0);
	});
});

test.describe("PT-6: Sparse phase numbers + stable title sort", () => {
	test("phase numbers are not normalised to a contiguous range", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			// Build verify steps with phases 1, 4, 7 — sparse.
			const verify = [
				{ name: "a", type: "subgoal", phase: 7, subgoal: { title: "Zulu", spec: "", planId: "p3" } },
				{ name: "b", type: "subgoal", phase: 1, subgoal: { title: "Bravo", spec: "", planId: "p1" } },
				{ name: "c", type: "subgoal", phase: 4, subgoal: { title: "Mike", spec: "", planId: "p2" } },
			];
			const goal = {
				id: "g", title: "x", state: "in-progress",
				workflow: { id: "p", name: "p", description: "", gates: [
					{ id: "execution", name: "Exec", dependsOn: [], verify },
				] },
			};
			const cols = window.computePlanColumns(window.extractPlanSteps(goal));
			return { phases: cols.map(c => c.phase), titles: cols.map(c => c.nodes.map((n: any) => n.subgoal.title)) };
		});
		expect(r.phases).toEqual([1, 4, 7]);
	});

	test("nodes within a phase are sorted by title (case-insensitive)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const verify = [
				{ name: "a", type: "subgoal", phase: 1, subgoal: { title: "charlie", spec: "", planId: "p1" } },
				{ name: "b", type: "subgoal", phase: 1, subgoal: { title: "Alpha", spec: "", planId: "p2" } },
				{ name: "c", type: "subgoal", phase: 1, subgoal: { title: "bravo", spec: "", planId: "p3" } },
			];
			const goal = {
				id: "g", title: "x", state: "in-progress",
				workflow: { id: "p", name: "p", description: "", gates: [
					{ id: "execution", name: "Exec", dependsOn: [], verify },
				] },
			};
			const cols = window.computePlanColumns(window.extractPlanSteps(goal));
			return cols[0].nodes.map((n: any) => n.subgoal.title);
		});
		expect(r).toEqual(["Alpha", "bravo", "charlie"]);
	});
});

test.describe("PT-7: extractPlanSteps ignores non-subgoal entries", () => {
	test("command and llm-review verify steps are filtered out", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => {
			const verify = [
				{ name: "tsc", type: "command", run: "tsc" },
				{ name: "review", type: "llm-review", prompt: "..." },
				{ name: "subA", type: "subgoal", phase: 1, subgoal: { title: "A", spec: "", planId: "p1" } },
				// Malformed: subgoal type but missing planId
				{ name: "broken", type: "subgoal", phase: 2, subgoal: { title: "no-id", spec: "" } },
			];
			const goal = {
				id: "g", title: "x", state: "in-progress",
				workflow: { id: "p", name: "p", description: "", gates: [
					{ id: "execution", name: "Exec", dependsOn: [], verify },
				] },
			};
			return window.extractPlanSteps(goal);
		});
		expect(r.length).toBe(1);
		expect(r[0].subgoal.planId).toBe("p1");
	});
});
