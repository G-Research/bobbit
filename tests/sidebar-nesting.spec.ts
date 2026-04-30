/**
 * Unit tests for sidebar nested-goal rendering (docs/design/nested-goals.md §10.1):
 *
 *   SB-NEST-1  Direct-child enumeration filters archived + sorts by createdAt
 *   SB-NEST-2  Descendant count is transitive and cycle-safe
 *   SB-NEST-3  n/m count badge counts only immediate children
 *   SB-NEST-4  No children → leaf render (no "show more" link)
 *   SB-NEST-5  Children within depth cap → recurse on each
 *   SB-NEST-6  Children at MAX_GOAL_DEPTH → "show more" link with descendant count
 *   SB-NEST-7  Cycle in parentGoalId chain does not infinite-loop the counter
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/sidebar-nesting.html")}`;

declare global {
	interface Window {
		MAX_GOAL_DEPTH: number;
		getChildGoalsFrom: (parentId: string, goals: any[]) => any[];
		countDescendantsFrom: (goalId: string, goals: any[]) => number;
		computeChildCountBadge: (parentId: string, goals: any[]) => { complete: number; total: number; label: string } | null;
		decideRender: (goal: any, depth: number, goals: any[]) => { kind: "leaf" } | { kind: "show-more"; count: number } | { kind: "recurse"; childIds: string[] };
		buildLinearChain: (depth: number) => any[];
	}
}

test.describe("SB-NEST-1: getChildGoalsFrom — filtering and ordering", () => {
	test("returns immediate children only, not grandchildren", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: false },
				{ id: "a1", parentGoalId: "a", createdAt: 4, archived: false },
			];
			return window.getChildGoalsFrom("root", goals).map(g => g.id);
		});
		expect(ids).toEqual(["a", "b"]);
	});

	test("excludes archived children", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: true },
				{ id: "c", parentGoalId: "root", createdAt: 4, archived: false },
			];
			return window.getChildGoalsFrom("root", goals).map(g => g.id);
		});
		expect(ids).toEqual(["a", "c"]);
	});

	test("sorts by createdAt ascending regardless of input order", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(() => {
			const goals = [
				{ id: "later", parentGoalId: "root", createdAt: 99, archived: false },
				{ id: "early", parentGoalId: "root", createdAt: 1, archived: false },
				{ id: "mid", parentGoalId: "root", createdAt: 50, archived: false },
			];
			return window.getChildGoalsFrom("root", goals).map(g => g.id);
		});
		expect(ids).toEqual(["early", "mid", "later"]);
	});

	test("returns empty array when no children", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(() => {
			const goals = [{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false }];
			return window.getChildGoalsFrom("root", goals);
		});
		expect(ids).toEqual([]);
	});
});

test.describe("SB-NEST-2: countDescendantsFrom — transitive count", () => {
	test("returns 0 for a leaf", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const n = await page.evaluate(() => {
			const goals = [{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false }];
			return window.countDescendantsFrom("root", goals);
		});
		expect(n).toBe(0);
	});

	test("counts a 3-level subtree (1 child + 2 grandchildren = 3)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const n = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false },
				{ id: "a1", parentGoalId: "a", createdAt: 3, archived: false },
				{ id: "a2", parentGoalId: "a", createdAt: 4, archived: false },
			];
			return window.countDescendantsFrom("root", goals);
		});
		expect(n).toBe(3);
	});

	test("excludes archived descendants", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const n = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: true },
				{ id: "a1", parentGoalId: "a", createdAt: 4, archived: false },
			];
			return window.countDescendantsFrom("root", goals);
		});
		expect(n).toBe(2);
	});

	test("does not count the goal itself", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const n = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false },
			];
			return window.countDescendantsFrom("root", goals);
		});
		expect(n).toBe(1);
	});
});

test.describe("SB-NEST-3: computeChildCountBadge — n/m label", () => {
	test("returns null when no children", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const badge = await page.evaluate(() => {
			const goals = [{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" }];
			return window.computeChildCountBadge("root", goals);
		});
		expect(badge).toBeNull();
	});

	test("counts only immediate children (not grandchildren)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const badge = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "complete" },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: false, state: "in-progress" },
				{ id: "c", parentGoalId: "root", createdAt: 4, archived: false, state: "in-progress" },
				// grandchildren must NOT count
				{ id: "a1", parentGoalId: "a", createdAt: 5, archived: false, state: "complete" },
				{ id: "a2", parentGoalId: "a", createdAt: 6, archived: false, state: "complete" },
			];
			return window.computeChildCountBadge("root", goals);
		});
		expect(badge).toEqual({ complete: 1, total: 3, label: "1/3" });
	});

	test("3/3 when all children are complete", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const badge = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "complete" },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "complete" },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: false, state: "complete" },
				{ id: "c", parentGoalId: "root", createdAt: 4, archived: false, state: "complete" },
			];
			return window.computeChildCountBadge("root", goals);
		});
		expect(badge?.label).toBe("3/3");
		expect(badge?.complete).toBe(3);
	});

	test("excludes archived children from total", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const badge = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "complete" },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: true, state: "complete" },
			];
			return window.computeChildCountBadge("root", goals);
		});
		expect(badge?.label).toBe("1/1");
	});
});

test.describe("SB-NEST-4 / SB-NEST-5 / SB-NEST-6: depth-cap render decisions", () => {
	test("leaf goal at any depth renders as leaf", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const goals = [{ id: "leaf", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" }];
			return window.decideRender(goals[0], 0, goals);
		});
		expect(result).toEqual({ kind: "leaf" });
	});

	test("goal with children at depth 0 recurses", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "in-progress" },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: false, state: "in-progress" },
			];
			return window.decideRender(goals[0], 0, goals);
		});
		expect(result.kind).toBe("recurse");
		expect((result as any).childIds).toEqual(["a", "b"]);
	});

	test("goal with children at depth 4 (one below cap) still recurses", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const root = { id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" };
			const a = { id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "in-progress" };
			return window.decideRender(root, 4, [root, a]);
		});
		expect(result.kind).toBe("recurse");
	});

	test("goal with children at depth MAX_GOAL_DEPTH yields show-more with descendant count", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			// 3-level subtree under "root": 1 child + 2 grandchildren = 3 descendants
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "in-progress" },
				{ id: "a1", parentGoalId: "a", createdAt: 3, archived: false, state: "in-progress" },
				{ id: "a2", parentGoalId: "a", createdAt: 4, archived: false, state: "in-progress" },
			];
			return window.decideRender(goals[0], window.MAX_GOAL_DEPTH, goals);
		});
		expect(result.kind).toBe("show-more");
		expect((result as any).count).toBe(3);
	});

	test("3-level tree rendered from depth 0 traverses fully (no show-more)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const visits = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "in-progress" },
				{ id: "a1", parentGoalId: "a", createdAt: 3, archived: false, state: "in-progress" },
				{ id: "a2", parentGoalId: "a", createdAt: 4, archived: false, state: "in-progress" },
				{ id: "b", parentGoalId: "root", createdAt: 5, archived: false, state: "complete" },
			];
			const log: Array<{ id: string; depth: number; kind: string }> = [];
			const walk = (g: any, depth: number) => {
				const r = window.decideRender(g, depth, goals);
				log.push({ id: g.id, depth, kind: r.kind });
				if (r.kind === "recurse") {
					for (const cid of r.childIds) {
						const child = goals.find(x => x.id === cid)!;
						walk(child, depth + 1);
					}
				}
			};
			walk(goals[0], 0);
			return log;
		});
		expect(visits.find(v => v.kind === "show-more")).toBeUndefined();
		expect(visits.map(v => v.id)).toEqual(["root", "a", "a1", "a2", "b"]);
		expect(visits.find(v => v.id === "a")?.depth).toBe(1);
		expect(visits.find(v => v.id === "a1")?.depth).toBe(2);
	});

	test("a 7-deep linear chain renders depth 0..4 inline, then show-more at depth 5", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const visits = await page.evaluate(() => {
			// Chain: goal-0 -> goal-1 -> ... -> goal-6  (depth 7)
			const goals = window.buildLinearChain(7);
			goals.forEach(g => g.state = "in-progress");
			const log: Array<{ id: string; depth: number; kind: string; count?: number }> = [];
			const walk = (g: any, depth: number) => {
				const r = window.decideRender(g, depth, goals);
				log.push({ id: g.id, depth, kind: r.kind, count: (r as any).count });
				if (r.kind === "recurse") {
					for (const cid of r.childIds) {
						const child = goals.find(x => x.id === cid)!;
						walk(child, depth + 1);
					}
				}
			};
			walk(goals[0], 0);
			return log;
		});
		// goal-0 at depth 0 recurses, goal-1..goal-4 recurse (depths 1..4),
		// goal-5 at depth 5 hits the cap → show-more (descendants = 1, just goal-6).
		// goal-6 must NOT appear (we stopped at the cap).
		expect(visits.map(v => v.id)).toEqual(["goal-0", "goal-1", "goal-2", "goal-3", "goal-4", "goal-5"]);
		expect(visits[5]).toEqual({ id: "goal-5", depth: 5, kind: "show-more", count: 1 });
	});
});

test.describe("SB-NEST-7: cycle safety", () => {
	test("a cycle in parentGoalId does not infinite-loop countDescendantsFrom", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const n = await page.evaluate(() => {
			// Pathological: goal-a's parent is goal-b, goal-b's parent is goal-a.
			// Server-side cycle prevention should make this impossible, but the
			// renderer must not melt down if a malformed snapshot ever sneaks in.
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "in-progress" },
				{ id: "b", parentGoalId: "a", createdAt: 3, archived: false, state: "in-progress" },
				// inject cycle: pretend the snapshot also lists "a" with parent="b"
				{ id: "a", parentGoalId: "b", createdAt: 2, archived: false, state: "in-progress" },
			];
			return window.countDescendantsFrom("root", goals);
		});
		// Even with a duplicate id forming a back-edge, the visited set bounds
		// the walk and the counter terminates.
		expect(n).toBeGreaterThanOrEqual(2);
		expect(n).toBeLessThanOrEqual(3);
	});
});
