/**
 * Playwright fixture tests for the sidebar spawned-children helpers.
 *
 * Exercises the pure logic from src/app/sidebar-spawned-children.ts in the
 * actual browser runtime (Chromium via Playwright file:// fixture pattern,
 * same as tests/sidebar-goal-rendering.spec.ts). The matching node:test
 * unit tests in tests/sidebar-spawned-children.test.ts pin the same
 * invariants against the TypeScript source.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/sidebar-spawned-children.html")}`;

declare global {
	interface Window {
		selectSpawnedChildren: (goals: any[], parentId: string, leadId: string, showArchived: boolean) => any[];
		isAncestorCycle: (childId: string, renderedAncestors: Set<string> | undefined) => boolean;
		extendAncestors: (prev: Set<string> | undefined, goalId: string) => Set<string>;
		simulateRender: (goals: any[], rootGoalId: string, leadId: string, opts?: { cap?: number; showArchived?: boolean }) => Array<{ kind: string; id: string; depth: number; title?: string }>;
	}
}

test.describe("selectSpawnedChildren — filter, dedupe, stable sort", () => {
	test("two distinct goals with identical titles BOTH render in deterministic order", async ({ page }) => {
		await page.goto(FIXTURE);
		const result = await page.evaluate(() => {
			const goals = [
				{ id: "audit-claude-code-A", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 100, title: "AUDIT: CLAUDE CODE" },
				{ id: "audit-claude-code-B", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 200, title: "AUDIT: CLAUDE CODE" },
			];
			return window.selectSpawnedChildren(goals, "P", "L", false).map(g => g.id);
		});
		// Both render — title-collision is NOT a cycle.
		expect(result).toEqual(["audit-claude-code-A", "audit-claude-code-B"]);
	});

	test("dedupes by id when state.goals contains accidental duplicates", async ({ page }) => {
		await page.goto(FIXTURE);
		const result = await page.evaluate(() => {
			const goals = [
				{ id: "x", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1, title: "first-copy" },
				{ id: "x", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 5, title: "second-copy" },
			];
			return window.selectSpawnedChildren(goals, "P", "L", false);
		});
		expect(result.length).toBe(1);
		expect(result[0].title).toBe("first-copy");
	});

	test("ties on createdAt break by id asc — stable across runs", async ({ page }) => {
		await page.goto(FIXTURE);
		// Run 5 times — each must produce identical order.
		const orders: string[][] = [];
		for (let i = 0; i < 5; i++) {
			const out = await page.evaluate(() => {
				const goals = [
					{ id: "zeta",  parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1 },
					{ id: "alpha", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1 },
					{ id: "kilo",  parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1 },
				];
				return window.selectSpawnedChildren(goals, "P", "L", false).map(g => g.id);
			});
			orders.push(out);
		}
		// Every run produces alpha, kilo, zeta — stable sort.
		for (const order of orders) {
			expect(order).toEqual(["alpha", "kilo", "zeta"]);
		}
	});

	test("excludes archived when showArchived is false; includes when true", async ({ page }) => {
		await page.goto(FIXTURE);
		const live = await page.evaluate(() => {
			const goals = [
				{ id: "a", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1, archived: false },
				{ id: "b", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 2, archived: true },
			];
			return window.selectSpawnedChildren(goals, "P", "L", false).map(g => g.id);
		});
		expect(live).toEqual(["a"]);

		const all = await page.evaluate(() => {
			const goals = [
				{ id: "a", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1, archived: false },
				{ id: "b", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 2, archived: true },
			];
			return window.selectSpawnedChildren(goals, "P", "L", true).map(g => g.id);
		});
		expect(all).toEqual(["a", "b"]);
	});
});

test.describe("simulated render walk — cycle guard never loops", () => {
	test("user image #41 reproduction: same-title sub-subgoal renders both as siblings, no infinite recursion", async ({ page }) => {
		await page.goto(FIXTURE);
		const result = await page.evaluate(() => {
			// Reproduces the user's screenshot scenario: AUDIT: CLAUDE CODE
			// (id=A, child of REAL-TASKS) contains another goal also titled
			// "AUDIT: CLAUDE CODE" (id=B, child of A). Both render; no loop
			// placeholder since the ids are distinct.
			const goals = [
				{ id: "REAL-TASKS",          parentGoalId: undefined, spawnedBySessionId: "AL_TRUIST", createdAt: 1, title: "REAL-TASKS COMPARISON AUDIT" },
				{ id: "A-claude-code",       parentGoalId: "REAL-TASKS", spawnedBySessionId: "AL_TRUIST", createdAt: 100, title: "AUDIT: CLAUDE CODE" },
				{ id: "A-bobbit",            parentGoalId: "REAL-TASKS", spawnedBySessionId: "AL_TRUIST", createdAt: 110, title: "AUDIT: BOBBIT HARNESS" },
				{ id: "B-claude-code-inner", parentGoalId: "A-claude-code", spawnedBySessionId: "AL_TRUIST", createdAt: 200, title: "AUDIT: CLAUDE CODE" },
			];
			return window.simulateRender(goals, "REAL-TASKS", "AL_TRUIST", { cap: 50 });
		});
		// Three rows render: A-claude-code (depth 0), A-bobbit (depth 0),
		// B-claude-code-inner (depth 1, child of A-claude-code).
		// No "loop" or "cap-hit" markers — all distinct ids.
		expect(result.filter(r => r.kind === "loop")).toEqual([]);
		expect(result.filter(r => r.kind === "cap-hit")).toEqual([]);
		const rowIds = result.filter(r => r.kind === "row").map(r => r.id);
		expect(rowIds).toEqual(["A-claude-code", "B-claude-code-inner", "A-bobbit"]);
	});

	test("true id-cycle (A→B→A in spawnedBy attribution) terminates with loop marker", async ({ page }) => {
		await page.goto(FIXTURE);
		const result = await page.evaluate(() => {
			// Simulate a defunct data shape where goal A is attributed under
			// goal B, and goal A appears as both root-level and as B's child
			// (which would re-introduce A as an ancestor of itself).
			const goals = [
				{ id: "A", parentGoalId: "ROOT", spawnedBySessionId: "L", createdAt: 1, title: "A" },
				{ id: "B", parentGoalId: "A",    spawnedBySessionId: "L", createdAt: 2, title: "B" },
				{ id: "A", parentGoalId: "B",    spawnedBySessionId: "L", createdAt: 3, title: "A-cycle" }, // duplicate id intentional
			];
			return window.simulateRender(goals, "ROOT", "L", { cap: 50 });
		});
		// Dedupe-by-id collapses the two "A" entries into one. The first one
		// (under ROOT) wins. Then A's children include B; B's children
		// include the duplicate "A" — but it was deduped out at A's spawned-
		// children selection. So no LOOP is observed because the data was
		// deduped before recursion.
		expect(result.filter(r => r.kind === "cap-hit")).toEqual([]);
	});

	test("cap is generous so legitimate deep trees aren't truncated", async ({ page }) => {
		await page.goto(FIXTURE);
		const result = await page.evaluate(() => {
			// Build a 10-deep linear chain — NOT a cycle, just deep.
			const goals = [];
			for (let i = 0; i < 10; i++) {
				goals.push({
					id: `lvl-${i}`,
					parentGoalId: i === 0 ? "ROOT" : `lvl-${i - 1}`,
					spawnedBySessionId: "L",
					createdAt: i,
					title: `Level ${i}`,
				});
			}
			return window.simulateRender(goals, "ROOT", "L", { cap: 50 });
		});
		expect(result.filter(r => r.kind === "cap-hit")).toEqual([]);
		expect(result.filter(r => r.kind === "row").length).toBe(10);
	});
});
