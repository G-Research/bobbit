/**
 * Unit tests for the goal-dashboard parent breadcrumb helpers
 * (docs/design/nested-goals.md §10 — task 1.6):
 *
 *   GD-BC-1  Top-level goal yields an empty chain (renderer shows nothing)
 *   GD-BC-2  Single-parent chain returns just the parent
 *   GD-BC-3  Multi-level chain ordered root → … → immediate parent
 *   GD-BC-4  Dangling parentGoalId stops the walk gracefully
 *   GD-BC-5  Cycle in parentGoalId chain does not infinite-loop
 *   GD-BC-6  Chain ≤ MAX yields truncated=false and full visible slice
 *   GD-BC-7  Chain > MAX yields truncated=true and the trailing N entries only
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/goal-dashboard-breadcrumb.html")}`;

declare global {
	interface Window {
		BREADCRUMB_MAX_DEPTH: number;
		buildAncestorChainFrom: (
			goal: { id: string; parentGoalId?: string },
			goals: any[],
		) => any[];
		computeBreadcrumbVisible: (
			chain: any[],
			max?: number,
		) => { truncated: boolean; visible: any[] };
		buildLinearChain: (depth: number) => any[];
	}
}

test.describe("GD-BC-1: top-level goal", () => {
	test("returns an empty ancestor chain for a goal with no parent", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const chain = await page.evaluate(() => {
			const goals = [{ id: "root", title: "Root", parentGoalId: undefined, createdAt: 1, archived: false }];
			return window.buildAncestorChainFrom(goals[0], goals);
		});
		expect(chain).toEqual([]);
	});
});

test.describe("GD-BC-2: single-parent chain", () => {
	test("returns just the parent for a depth-1 child", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const titles = await page.evaluate(() => {
			const goals = [
				{ id: "root", title: "Root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "child", title: "Child", parentGoalId: "root", createdAt: 2, archived: false },
			];
			return window.buildAncestorChainFrom(goals[1], goals).map((g: any) => g.title);
		});
		expect(titles).toEqual(["Root"]);
	});
});

test.describe("GD-BC-3: multi-level chain ordering", () => {
	test("returns ancestors ordered root → … → immediate parent", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const titles = await page.evaluate(() => {
			const goals = [
				{ id: "root", title: "Root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "p1", title: "P1", parentGoalId: "root", createdAt: 2, archived: false },
				{ id: "p2", title: "P2", parentGoalId: "p1", createdAt: 3, archived: false },
				{ id: "leaf", title: "Leaf", parentGoalId: "p2", createdAt: 4, archived: false },
			];
			return window.buildAncestorChainFrom(goals[3], goals).map((g: any) => g.title);
		});
		// root first, immediate parent last
		expect(titles).toEqual(["Root", "P1", "P2"]);
	});
});

test.describe("GD-BC-4: dangling parentGoalId", () => {
	test("stops the walk at the first missing ancestor", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const titles = await page.evaluate(() => {
			// "p1" claims to have parent "ghost" but ghost is not in the snapshot.
			const goals = [
				{ id: "p1", title: "P1", parentGoalId: "ghost", createdAt: 2, archived: false },
				{ id: "child", title: "Child", parentGoalId: "p1", createdAt: 3, archived: false },
			];
			return window.buildAncestorChainFrom(goals[1], goals).map((g: any) => g.title);
		});
		// Walk includes the present ancestor and stops.
		expect(titles).toEqual(["P1"]);
	});

	test("returns empty chain when the immediate parent is itself missing", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const titles = await page.evaluate(() => {
			const goals = [
				{ id: "child", title: "Child", parentGoalId: "ghost", createdAt: 1, archived: false },
			];
			return window.buildAncestorChainFrom(goals[0], goals).map((g: any) => g.title);
		});
		expect(titles).toEqual([]);
	});
});

test.describe("GD-BC-5: cycle safety", () => {
	test("a cycle in parentGoalId terminates without infinite-looping", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(() => {
			// Pathological: a → b → a → … . Server-side cycle prevention should
			// make this impossible, but the renderer must not melt down on a
			// malformed snapshot.
			const goals = [
				{ id: "a", title: "A", parentGoalId: "b", createdAt: 1, archived: false },
				{ id: "b", title: "B", parentGoalId: "a", createdAt: 2, archived: false },
				{ id: "leaf", title: "Leaf", parentGoalId: "a", createdAt: 3, archived: false },
			];
			return window.buildAncestorChainFrom(goals[2], goals).map((g: any) => g.id);
		});
		// The walk follows leaf → a → b → (would-be a, blocked by `seen`).
		// Result is `[b, a]` (root-first) and crucially terminates.
		expect(ids).toEqual(["b", "a"]);
	});
});

test.describe("GD-BC-6: chain ≤ MAX yields full visible slice", () => {
	test("a 3-element chain renders all three with truncated=false", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const goals = [
				{ id: "root", title: "Root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "p1", title: "P1", parentGoalId: "root", createdAt: 2, archived: false },
				{ id: "p2", title: "P2", parentGoalId: "p1", createdAt: 3, archived: false },
				{ id: "leaf", title: "Leaf", parentGoalId: "p2", createdAt: 4, archived: false },
			];
			const chain = window.buildAncestorChainFrom(goals[3], goals);
			return window.computeBreadcrumbVisible(chain);
		});
		expect(result.truncated).toBe(false);
		expect(result.visible.map((g: any) => g.title)).toEqual(["Root", "P1", "P2"]);
	});

	test("a chain exactly equal to MAX yields full visible slice (no truncation)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			// 5 ancestors → exactly at the cap.
			const goals = window.buildLinearChain(6); // goal-0 ... goal-5; chain to goal-5 has 5 ancestors
			const leaf = goals[goals.length - 1];
			const chain = window.buildAncestorChainFrom(leaf, goals);
			return { len: chain.length, ...window.computeBreadcrumbVisible(chain) };
		});
		expect(result.len).toBe(5);
		expect(result.truncated).toBe(false);
		expect(result.visible.length).toBe(5);
	});
});

test.describe("GD-BC-7: chain > MAX truncates with leading ellipsis", () => {
	test("a chain of 7 ancestors is truncated to the trailing 5", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			// 8-deep linear chain → leaf has 7 ancestors.
			const goals = window.buildLinearChain(8);
			const leaf = goals[goals.length - 1];
			const chain = window.buildAncestorChainFrom(leaf, goals);
			return { len: chain.length, ...window.computeBreadcrumbVisible(chain) };
		});
		expect(result.len).toBe(7);
		expect(result.truncated).toBe(true);
		expect(result.visible.length).toBe(5);
		// Visible slice is the trailing 5 — closest ancestors retained.
		expect(result.visible.map((g: any) => g.id)).toEqual([
			"goal-2",
			"goal-3",
			"goal-4",
			"goal-5",
			"goal-6",
		]);
	});

	test("respects an explicit max parameter", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const goals = window.buildLinearChain(5); // leaf has 4 ancestors
			const leaf = goals[goals.length - 1];
			const chain = window.buildAncestorChainFrom(leaf, goals);
			return window.computeBreadcrumbVisible(chain, 2);
		});
		expect(result.truncated).toBe(true);
		expect(result.visible.length).toBe(2);
		// Trailing 2 — closest ancestors retained.
		expect(result.visible.map((g: any) => g.id)).toEqual(["goal-2", "goal-3"]);
	});

	test("MAX_DEPTH constant matches the spec value (5)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const max = await page.evaluate(() => window.BREADCRUMB_MAX_DEPTH);
		expect(max).toBe(5);
	});
});
