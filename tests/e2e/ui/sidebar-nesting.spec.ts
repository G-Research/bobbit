/**
 * Phase 5b — sidebar nesting E2E.
 *
 * Setup: project + parent goal + 2 children + 1 grandchild via REST.
 * Verifies:
 *  - Sidebar shows nested rows with correct per-depth indentation.
 *  - Descendant-count badge `(N)` is shown next to the parent.
 *  - Clicking a child navigates to its dashboard.
 *  - Reload preserves the nested view.
 *
 * The nested goals have `parentGoalId` / `rootGoalId` set directly via the
 * lazy-migration tolerant Goal record — Phase 1's `createGoal` accepts them.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

async function deleteGoalQuiet(id: string): Promise<void> {
	try {
		await apiFetch(`/api/goals/${id}?cascade=true`, { method: "DELETE" });
	} catch { /* best-effort */ }
}

/**
 * Pre-populate the `bobbit-expanded-goals` localStorage key with the given
 * goal IDs and reload — required because the sidebar nested-row renderer
 * hides child rows when the ancestor's chevron is collapsed (default).
 * Mirrors the production toggle written by `saveExpandedGoals()`.
 */
async function expandGoalsAndReload(page: Page, goalIds: string[]): Promise<void> {
	await page.evaluate((ids: string[]) => {
		try {
			localStorage.setItem("bobbit-expanded-goals", JSON.stringify(ids));
		} catch {}
	}, goalIds);
	await page.reload();
	await expect(
		page.locator("button").filter({ hasText: "Settings" }).first(),
	).toBeVisible({ timeout: 20_000 });
}

test.describe("Phase 5b — sidebar nested goals", () => {
	let parentId = "";
	let child1Id = "";
	let child2Id = "";
	let grandchildId = "";

	test.beforeEach(async () => {
		const projectId = await defaultProjectId();
		// Parent — top-level
		const parent = await createGoal({ title: "Parent goal v1", projectId, team: false });
		parentId = parent.id as string;
		// Two children spawned via the Phase 4 endpoint (parentGoalId + rootGoalId
		// are set server-side from the spawn-child path).
		const r1 = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "plan-A", title: "Child A", spec: "Child A spec" }),
		});
		expect(r1.status).toBe(201);
		child1Id = (await r1.json()).id as string;
		const r2 = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "plan-B", title: "Child B", spec: "Child B spec" }),
		});
		expect(r2.status).toBe(201);
		child2Id = (await r2.json()).id as string;
		// Grandchild — child1 → grandchild
		const r3 = await apiFetch(`/api/goals/${child1Id}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "plan-A1", title: "Grandchild A1", spec: "Grandchild spec" }),
		});
		expect(r3.status).toBe(201);
		grandchildId = (await r3.json()).id as string;
	});

	test.afterEach(async () => {
		// Single cascade=true call archives the whole tree (parent + descendants).
		await deleteGoalQuiet(parentId);
	});

	test("renders nested rows with correct indentation and descendant badge", async ({ page }) => {
		await openApp(page);
		// Parent goals are collapsed by default — expand the parent and child1
		// (the grandchild's ancestor) before asserting nested-row visibility.
		await expandGoalsAndReload(page, [parentId, child1Id]);

		// All four goals should be in the sidebar after refresh.
		const parentRow = page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${parentId}"]`).first();
		const child1Row = page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${child1Id}"]`).first();
		const child2Row = page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${child2Id}"]`).first();
		const grandchildRow = page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${grandchildId}"]`).first();

		await expect(parentRow).toBeVisible({ timeout: 15_000 });
		await expect(child1Row).toBeVisible({ timeout: 15_000 });
		await expect(child2Row).toBeVisible({ timeout: 15_000 });
		await expect(grandchildRow).toBeVisible({ timeout: 15_000 });

		// Indentation: parent at depth 0, children at depth 1, grandchild at depth 2.
		await expect(parentRow).toHaveAttribute("data-depth", "0");
		await expect(child1Row).toHaveAttribute("data-depth", "1");
		await expect(child2Row).toHaveAttribute("data-depth", "1");
		await expect(grandchildRow).toHaveAttribute("data-depth", "2");

		// Parent shows the descendant-count badge — pill-style, just "3".
		const badge = parentRow.locator(`[data-testid="sidebar-descendant-badge"]`).first();
		await expect(badge).toBeVisible();
		await expect(badge).toContainText("3");
	});

	test("child row dashboard button is reachable + navigates", async ({ page }) => {
		await openApp(page);
		await expandGoalsAndReload(page, [parentId]);
		const child1Row = page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${child1Id}"]`).first();
		await expect(child1Row).toBeVisible({ timeout: 15_000 });

		// Hover to surface the hidden-on-hover dashboard affordance, then click.
		await child1Row.hover();
		const dashboardBtn = child1Row.locator('button[title="Goal dashboard"]').first();
		await expect(dashboardBtn).toBeVisible({ timeout: 5_000 });
		await dashboardBtn.click();

		// URL should reflect the child's dashboard.
		await expect(page).toHaveURL(new RegExp(`#/goal/${child1Id}$`), { timeout: 10_000 });
	});

	test("nested view persists across reload", async ({ page }) => {
		await openApp(page);
		// Seed the parent + child1 as expanded so the grandchild row renders.
		// Persistence is the property under test: reload should preserve the
		// localStorage-backed expansion state.
		await expandGoalsAndReload(page, [parentId, child1Id]);
		const grandchildRow = page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${grandchildId}"]`).first();
		await expect(grandchildRow).toBeVisible({ timeout: 15_000 });
		await expect(grandchildRow).toHaveAttribute("data-depth", "2");

		await page.reload();
		const grandchildRow2 = page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${grandchildId}"]`).first();
		await expect(grandchildRow2).toBeVisible({ timeout: 15_000 });
		await expect(grandchildRow2).toHaveAttribute("data-depth", "2");
	});
});
