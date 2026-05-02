/**
 * Phase 5b — cascade archive E2E.
 *
 * Verifies the archive-with-descendants UX:
 *  - Goal with descendants → Archive button shows the cascade dialog with the
 *    correct count.
 *  - Confirming archives the parent + all descendants.
 *  - Goal with NO descendants → no dialog (legacy single-confirm flow).
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Phase 5b — cascade archive", () => {
	test("parent with descendants opens cascade dialog showing the count", async ({ page }) => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Cascade parent", projectId, team: false });
		const r1 = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p1", title: "Child 1", spec: "spec" }),
		});
		expect(r1.status).toBe(201);
		const c1 = (await r1.json()).id as string;
		const r2 = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p2", title: "Child 2", spec: "spec" }),
		});
		expect(r2.status).toBe(201);
		const r3 = await apiFetch(`/api/goals/${c1}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p1g", title: "Grandchild", spec: "spec" }),
		});
		expect(r3.status).toBe(201);

		await openApp(page);
		await navigateToHash(page, `#/goal/${parent.id as string}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });

		// Click Archive — modal should appear.
		const archiveBtn = page.locator('button.btn-icon').filter({ hasText: "Archive" }).first();
		await expect(archiveBtn).toBeVisible({ timeout: 10_000 });
		await archiveBtn.click();

		const summary = page.locator('[data-testid="cascade-archive-summary"]').first();
		await expect(summary).toBeVisible({ timeout: 5_000 });
		await expect(summary).toContainText("3 descendant goals");

		// The cascade checkbox is read-only/checked.
		const cascadeCheckbox = page.locator('[data-testid="cascade-archive-checkbox-cascade"]').first();
		await expect(cascadeCheckbox).toBeChecked();
		await expect(cascadeCheckbox).toBeDisabled();

		// Confirm — button label includes the count.
		const confirmBtn = page.locator('button').filter({ hasText: /Archive parent \+ 3 descendants/ }).first();
		await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
		const deleteResp = page.waitForResponse(
			r => r.url().match(/\/api\/goals\/[a-f0-9-]+\?cascade=true$/) != null
				&& r.request().method() === "DELETE"
				&& r.ok(),
			{ timeout: 10_000 },
		);
		await confirmBtn.click();
		await deleteResp;

		// Goal archived (server side-effect already confirmed via deleteResp).
		const after = await apiFetch(`/api/goals/${parent.id}`);
		const goal = await after.json();
		expect(goal.archived).toBe(true);
	});

	test("parent with NO descendants archives without showing the cascade dialog", async ({ page }) => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Solo parent", projectId, team: false });

		await openApp(page);
		await navigateToHash(page, `#/goal/${parent.id as string}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });

		const archiveBtn = page.locator('button.btn-icon').filter({ hasText: "Archive" }).first();
		await expect(archiveBtn).toBeVisible({ timeout: 10_000 });
		await archiveBtn.click();

		// Legacy `confirmAction` modal — has "Archive Goal" header. Wait for the
		// dialog to render, then click its Archive submit button. The dialog's
		// button lives inside the modal-overlay container; we scope by finding
		// the heading and walking up to the dialog root.
		const heading = page.getByRole("heading", { name: "Archive Goal", level: 2 });
		await expect(heading).toBeVisible({ timeout: 5_000 });
		// Listen for the DELETE response so we can settle on the side-effect
		// rather than the route change (which is asynchronous and racing the
		// window-close).
		const deleteResp = page.waitForResponse(
			r => r.url().match(/\/api\/goals\/[a-f0-9-]+\?cascade=false$/) != null
				&& r.request().method() === "DELETE"
				&& r.ok(),
			{ timeout: 10_000 },
		);
		// The dialog confirms "Archive {title}? It will move to the archived section."
		// — find that paragraph, then locate the Archive button as a sibling.
		const dialogBody = page.locator(':text("It will move to the archived section.")').first();
		await expect(dialogBody).toBeVisible({ timeout: 5_000 });
		// Click the Archive button inside the same overlay (use evaluate for reliability).
		await page.evaluate(() => {
			const buttons = Array.from(document.querySelectorAll("button"));
			// The dialog's confirm button is "Archive" — pick the LAST visible Archive
			// button, which lives inside the overlay (navbar Archive is below the overlay).
			const archives = buttons.filter(b => b.textContent?.trim() === "Archive" && (b.offsetParent !== null));
			const target = archives[archives.length - 1];
			if (target) target.click();
		});
		await deleteResp;

		// The cascade-archive summary testid should NOT have appeared.
		const cascadeSummary = page.locator('[data-testid="cascade-archive-summary"]');
		await expect(cascadeSummary).toHaveCount(0);

		// Goal archived (server side-effect already confirmed via deleteResp).
		const after = await apiFetch(`/api/goals/${parent.id}`);
		const goal = await after.json();
		expect(goal.archived).toBe(true);
	});
});
