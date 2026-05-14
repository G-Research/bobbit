/**
 * Phase 5b — tree cost rollup E2E.
 *
 * The Phase 6 server endpoint `GET /api/goals/:id/tree-cost` returns a
 * `breakdown[]` shaped sum across the descendant tree. This test verifies
 * that the dashboard:
 *  1. Calls the endpoint when a parent goal is loaded.
 *  2. Renders the "Tree cost" row (testid `tree-cost-row`).
 *  3. Click expands the per-child breakdown table (testid `tree-cost-breakdown`).
 *
 * The cost values themselves are zero in this fixture (no LLM ran), but the
 * row STILL renders for parent goals with children — the breakdown table
 * surfaces the structure even when totals are $0.00.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Phase 5b — tree cost rollup", () => {
	test("parent dashboard renders Tree cost row + per-child breakdown", async ({ page }) => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Tree-cost parent", projectId, team: false });
		const r1 = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p1", title: "Tree-cost child 1", spec: "tree-cost UI test child 1: padded to meet spec validator minimum length." }),
		});
		const c1 = (await r1.json()).id as string;
		const r2 = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p2", title: "Tree-cost child 2", spec: "tree-cost UI test child 2: padded to meet spec validator minimum length." }),
		});
		const c2 = (await r2.json()).id as string;

		// Sanity: REST endpoint returns the structured rollup.
		const treeRes = await apiFetch(`/api/goals/${parent.id}/tree-cost`);
		expect(treeRes.status).toBe(200);
		const tree = await treeRes.json();
		expect(tree.rootGoalId).toBe(parent.id);
		expect(Array.isArray(tree.breakdown)).toBe(true);
		// Three goals in the tree: parent + 2 children.
		expect(tree.breakdown.length).toBeGreaterThanOrEqual(1);

		await openApp(page);
		await navigateToHash(page, `#/goal/${parent.id as string}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });

		// The tree-cost row should appear once the fetch completes (zero or non-zero
		// total). The render guard requires `breakdown.length > 1` OR `total > 0`;
		// our 3-goal tree exceeds the threshold.
		const treeCostRow = page.locator('[data-testid="tree-cost-row"]').first();
		await expect(treeCostRow).toBeVisible({ timeout: 10_000 });

		// Click toggle → breakdown table appears.
		const toggle = page.locator('[data-testid="tree-cost-toggle"]').first();
		await toggle.click();
		const breakdown = page.locator('[data-testid="tree-cost-breakdown"]').first();
		await expect(breakdown).toBeVisible({ timeout: 5_000 });

		// Expanded breakdown is wrapped in a scroll container with bounded
		// height + overflow:auto so long lists are reachable. Without this
		// the panel just grows indefinitely and rows below the fold are
		// inaccessible — the user-reported scroll bug.
		const scroll = page.locator('[data-testid="tree-cost-breakdown-scroll"]').first();
		await expect(scroll).toBeVisible();
		const overflowY = await scroll.evaluate((el) => getComputedStyle(el as HTMLElement).overflowY);
		expect(overflowY).toBe("auto");
		const maxHeightPx = await scroll.evaluate((el) => parseFloat(getComputedStyle(el as HTMLElement).maxHeight) || Infinity);
		expect(maxHeightPx).toBeLessThan(Infinity);

		// Cleanup.
		await apiFetch(`/api/goals/${parent.id}?cascade=true`, { method: "DELETE" }).catch(() => {});
		// Avoid unused-var lint
		void c1; void c2;
	});

	test("Tree cost row stays visible when all children are archived", async ({ page }) => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Tree-cost archived-children parent", projectId, team: false });
		const r1 = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p1", title: "Tree-cost child 1", spec: "tree-cost archived-children UI test child 1: padded to meet validator length." }),
		});
		const c1 = (await r1.json()).id as string;
		const r2 = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p2", title: "Tree-cost child 2", spec: "tree-cost archived-children UI test child 2: padded to meet validator length." }),
		});
		const c2 = (await r2.json()).id as string;

		// Archive both children (they're leaves, so cascade=false is fine).
		const d1 = await apiFetch(`/api/goals/${c1}?cascade=false`, { method: "DELETE" });
		expect(d1.status).toBeLessThan(400);
		const d2 = await apiFetch(`/api/goals/${c2}?cascade=false`, { method: "DELETE" });
		expect(d2.status).toBeLessThan(400);

		// The server-side tree-cost rollup still walks archived descendants.
		const treeRes = await apiFetch(`/api/goals/${parent.id}/tree-cost`);
		expect(treeRes.status).toBe(200);
		const tree = await treeRes.json();
		expect(tree.breakdown.length).toBeGreaterThan(1);

		await openApp(page);
		await navigateToHash(page, `#/goal/${parent.id as string}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });

		// Row should still be visible despite all children being archived
		// and "See Archived" being OFF (default state).
		const treeCostRow = page.locator('[data-testid="tree-cost-row"]').first();
		await expect(treeCostRow).toBeVisible({ timeout: 10_000 });

		// Cleanup.
		await apiFetch(`/api/goals/${parent.id}?cascade=true`, { method: "DELETE" }).catch(() => {});
	});
});
