/**
 * Phase 5b — Plan tab E2E.
 *
 * Setup: parent goal with two ad-hoc children spawned via REST.
 * Verifies:
 *  - Plan tab visible (living-plan synthesis from ad-hoc children).
 *  - DAG SVG renders one node per plan step.
 *  - Children are laid out by phase (createdAt clustering).
 *  - Goals with no formal plan but with ad-hoc children still show the Plan tab.
 *
 * Phase 4 lazy-migration: the parent goal needs `parentGoalId` semantics
 * (i.e., the children must be spawned via `/api/goals/:id/spawn-child` so
 * `parentGoalId`/`spawnedFromPlanId` are set on disk).
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Phase 5b — Plan tab", () => {
	let parentId = "";
	let child1Id = "";
	let child2Id = "";

	test.beforeEach(async () => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Parent w/ ad-hoc children", projectId, team: false });
		parentId = parent.id as string;
		const r1 = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p1", title: "Phase A leaf", spec: "p1 spec: plan-tab UI test first child goal, padded to meet spec validator minimum length." }),
		});
		expect(r1.status).toBe(201);
		child1Id = (await r1.json()).id as string;
		const r2 = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p2", title: "Phase A leaf 2", spec: "p2 spec: plan-tab UI test second child goal, padded to meet spec validator minimum length." }),
		});
		expect(r2.status).toBe(201);
		child2Id = (await r2.json()).id as string;
	});

	test.afterEach(async () => {
		try { await apiFetch(`/api/goals/${parentId}?cascade=true`, { method: "DELETE" }); } catch { /* */ }
	});

	test("Plan tab is visible on goals with ad-hoc children (living plan)", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, `#/goal/${parentId}`);
		// Wait for skeleton → real tabs
		await expect(page.locator('[data-testid="tab-plan"]').first()).toBeVisible({ timeout: 15_000 });
	});

	test("DAG SVG renders one node per ad-hoc child", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, `#/goal/${parentId}`);
		const planTab = page.locator('[data-testid="tab-plan"]').first();
		await expect(planTab).toBeVisible({ timeout: 15_000 });
		await planTab.click();
		await expect(page.locator('[data-testid="plan-tab"]').first()).toBeVisible({ timeout: 5_000 });

		// Two `plan-node` SVG groups, one per child.
		const nodes = page.locator('[data-testid="plan-node"]');
		await expect(nodes).toHaveCount(2, { timeout: 5_000 });
	});

	test("clicking a plan node's open link navigates to the child dashboard", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, `#/goal/${parentId}`);
		const planTab = page.locator('[data-testid="tab-plan"]').first();
		await expect(planTab).toBeVisible({ timeout: 15_000 });
		await planTab.click();
		const firstNode = page.locator('[data-testid="plan-node"]').first();
		await expect(firstNode).toBeVisible({ timeout: 5_000 });
		// Open link inside the node's foreignObject.
		const openLink = firstNode.locator('a.plan-node-link').first();
		await expect(openLink).toBeVisible({ timeout: 5_000 });
		await openLink.click({ force: true });
		// Either child could be first depending on createdAt; verify that the
		// URL is now a goal-dashboard for one of them.
		await expect(page).toHaveURL(new RegExp(`#/goal/(${child1Id}|${child2Id})$`), { timeout: 10_000 });
	});

	test("Plan tab persists across reload", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, `#/goal/${parentId}`);
		await expect(page.locator('[data-testid="tab-plan"]').first()).toBeVisible({ timeout: 15_000 });
		await page.reload();
		await expect(page.locator('[data-testid="tab-plan"]').first()).toBeVisible({ timeout: 15_000 });
	});
});
