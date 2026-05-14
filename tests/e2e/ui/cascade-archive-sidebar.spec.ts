/**
 * Sidebar cascade-archive E2E.
 *
 * Bug repro: archiving a top-level goal from the sidebar (not the goal
 * dashboard) failed to cascade-archive its children — the parent's
 * `archived` flipped to true but descendants stayed live. This test
 * verifies the end-to-end behaviour once the server cascade is fixed:
 * clicking the sidebar archive icon on a parent with a child opens the
 * cascade dialog, confirming archives parent + child.
 *
 * Companion to:
 *  - tests/e2e/ui/cascade-archive.spec.ts (dashboard archive button)
 *  - tests/e2e/ui/goal-archive-always-on.spec.ts (sidebar icon visibility)
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId, deleteGoal } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Sidebar cascade archive", () => {
	test("archiving parent from sidebar cascade-archives child goal", async ({ page }) => {
		test.setTimeout(60_000);

		const projectId = await defaultProjectId();
		const parentTitle = `SidebarCascadeParent-${Date.now()}`;
		const parent = await createGoal({ title: parentTitle, projectId, team: false, worktree: false });
		const parentId = parent.id as string;

		const childResp = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({
				planId: "p1",
				title: "SidebarCascadeChild",
				spec: "sidebar cascade-archive UI test: child goal padded to satisfy the spec validator minimum length.",
			}),
		});
		expect(childResp.status).toBe(201);
		const childId = (await childResp.json()).id as string;

		try {
			await openApp(page);

			// Find the parent goal row in the sidebar by its data-goal-id attribute
			// (sidebar-nested-row > sidebar-goal-row structure). Using data-goal-id
			// is more precise than text matching which can hit broad ancestor divs.
			const goalRow = page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${parentId}"]`);
			await expect(goalRow).toBeVisible({ timeout: 15_000 });
			await goalRow.hover();

			// The sidebar archive icon is hover-revealed (`hidden group-hover:flex`)
			// — the button exists in the DOM regardless. We dispatch the click
			// programmatically to bypass the CSS hide, scoped to the goal row so
			// we don't accidentally click an archive button on a different goal.
			const archiveBtn = goalRow.locator('button[title="Archive goal"]').first();
			await expect.poll(async () => archiveBtn.count(), { timeout: 5_000 }).toBeGreaterThan(0);
			await archiveBtn.evaluate((el: HTMLElement) => el.click());

			// Because the parent has 1 descendant, the cascade dialog must
			// open (NOT the single-goal confirm modal).
			const summary = page.locator('[data-testid="cascade-archive-summary"]').first();
			await expect(summary).toBeVisible({ timeout: 5_000 });
			await expect(summary).toContainText("1 descendant");

			// Confirm — button label includes the descendant count.
			const confirmBtn = page.locator("button").filter({ hasText: /Archive parent \+ 1 descendant/ }).first();
			await expect(confirmBtn).toBeVisible({ timeout: 5_000 });

			const deleteResp = page.waitForResponse(
				(r) =>
					r.url().match(/\/api\/goals\/[a-f0-9-]+\?cascade=true$/) != null
					&& r.request().method() === "DELETE"
					&& r.ok(),
				{ timeout: 10_000 },
			);
			await confirmBtn.click();
			await deleteResp;

			// Both parent AND child must be archived server-side. This is the
			// crux of the bug — pre-fix, only the parent flipped.
			await expect.poll(async () => {
				const pr = await apiFetch(`/api/goals/${parentId}`);
				const cr = await apiFetch(`/api/goals/${childId}`);
				if (!pr.ok || !cr.ok) return "missing";
				const p = await pr.json();
				const c = await cr.json();
				if (p.archived === true && c.archived === true) return "both-archived";
				if (p.archived === true && c.archived !== true) return "parent-only";
				return "neither";
			}, { timeout: 10_000 }).toBe("both-archived");
		} finally {
			await deleteGoal(childId).catch(() => {});
			await deleteGoal(parentId).catch(() => {});
		}
	});
});
