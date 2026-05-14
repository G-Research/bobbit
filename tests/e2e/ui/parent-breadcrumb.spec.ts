/**
 * Phase 5b — parent breadcrumb E2E.
 *
 * On a child goal's dashboard, render `← root.title / parent.title` (or just
 * `← parent.title` when root and parent are the same). Click navigates to
 * the parent.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Phase 5b — parent breadcrumb", () => {
	test("child dashboard shows breadcrumb; click navigates to parent", async ({ page }) => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Breadcrumb root", projectId, team: false });
		const r1 = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p1", title: "Breadcrumb child", spec: "parent-breadcrumb UI test: child goal whose breadcrumb should link back to the parent goal." }),
		});
		expect(r1.status).toBe(201);
		const childId = (await r1.json()).id as string;

		await openApp(page);
		await navigateToHash(page, `#/goal/${childId}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });

		const breadcrumb = page.locator('[data-testid="parent-breadcrumb"]').first();
		await expect(breadcrumb).toBeVisible({ timeout: 5_000 });
		await expect(breadcrumb).toContainText("Breadcrumb root");

		const parentLink = page.locator('[data-testid="breadcrumb-parent"]').first();
		await expect(parentLink).toBeVisible({ timeout: 2_000 });
		await parentLink.click({ force: true });
		await expect(page).toHaveURL(new RegExp(`#/goal/${parent.id}$`), { timeout: 10_000 });

		// Cleanup.
		await apiFetch(`/api/goals/${parent.id}?cascade=true`, { method: "DELETE" }).catch(() => {});
	});

	test("top-level goal dashboard does NOT show breadcrumb", async ({ page }) => {
		const projectId = await defaultProjectId();
		const top = await createGoal({ title: "Top-level only", projectId, team: false });
		await openApp(page);
		await navigateToHash(page, `#/goal/${top.id as string}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });
		const breadcrumb = page.locator('[data-testid="parent-breadcrumb"]');
		await expect(breadcrumb).toHaveCount(0);

		await apiFetch(`/api/goals/${top.id}?cascade=false`, { method: "DELETE" }).catch(() => {});
	});
});
