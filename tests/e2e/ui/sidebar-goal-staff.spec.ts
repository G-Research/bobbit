/**
 * Sidebar goal actions E2E tests — SB-16, SB-22, SB-23.
 *
 * Covers:
 *   SB-16: "New Goal" button on project header → goal assistant opens
 *   SB-22: Re-attempt archived/fresh goal → goal assistant opens
 *   SB-23: Archive goal lifecycle (live → archive → appears in archived section)
 */
import { test, expect } from "../gateway-harness.js";
import { createGoal, deleteGoal, apiFetch, nonGitCwd } from "../e2e-setup.js";
import { openApp, createGoalAssistantViaUI } from "./ui-helpers.js";
import { filtersButton, clickShowArchivedToggle } from "./utils/sidebar-filters.js";

test.describe("Sidebar goal actions & staff", () => {
	const goalIds: string[] = [];

	test.afterAll(async () => {
		for (const id of goalIds) {
			await deleteGoal(id).catch(() => {});
		}
	});

	test("SB-16: New Goal button visible and opens goal assistant", async ({ page }) => {
		await openApp(page);

		// The toolbar New Goal entry opens a project picker when both Headquarters
		// and the harness default project are visible. Use the shared helper so
		// this test follows the current multi-project UX before asserting the
		// assistant textarea.
		await createGoalAssistantViaUI(page);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

		// Verify the URL changed to a session route (goal assistant session)
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toMatch(/#\/session\/[a-f0-9-]+/i);
		}).toPass({ timeout: 10_000 });

		// Clean up the created goal assistant session
		const hash = await page.evaluate(() => window.location.hash);
		const sessionIdMatch = hash.match(/#\/session\/([a-f0-9-]+)/i);
		if (sessionIdMatch) {
			await apiFetch(`/api/sessions/${sessionIdMatch[1]}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("SB-22: Re-attempt button on archived goal opens goal assistant", async ({ page }) => {
		// Create a goal, then archive it via DELETE API
		const goal = await createGoal({ title: "SB22 Reattempt Test", cwd: nonGitCwd() });
		goalIds.push(goal.id);

		// Archive the goal
		await apiFetch(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" });

		// Desktop viewport so the sidebar-actions hamburger trigger renders
		await page.setViewportSize({ width: 1280, height: 900 });
		await openApp(page);

		// Open the Filters popover and toggle Show Archived ON
		const archivedToggle = filtersButton(page);
		await expect(archivedToggle).toBeVisible({ timeout: 10_000 });
		await clickShowArchivedToggle(page);

		// Wait for archived goals to load asynchronously — title is rendered uppercase via CSS
		const goalTitle = page.getByText("SB22 Reattempt Test", { exact: false }).first();
		await expect(goalTitle).toBeVisible({ timeout: 15_000 });

		// Hover over the goal row's parent container (has class "group") to reveal
		// the sidebar-actions div which is "hidden group-hover:flex"
		const goalRow = goalTitle.locator("xpath=ancestor::div[contains(@class,'group')]").first();
		await goalRow.hover();

		// Re-attempt is now popover-only (quick:false). Open the sidebar actions
		// popover via the hamburger trigger, then click the Re-attempt menu item.
		const trigger = page.locator(
			`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="goal"][data-sidebar-actions-id="${goal.id}"]`,
		);
		await expect(trigger).toBeVisible({ timeout: 5_000 });
		await trigger.click();

		// openSidebarActionsPopover cold-imports SidebarActionsPopover.js on first
		// use (src/app/render-helpers.ts) — it is not eagerly bundled/preloaded.
		// Under heavy full-suite load (many concurrent gateway processes serving
		// static chunks, not raw CPU spin) that fetch+parse+upgrade chain can
		// exceed a tight 5s window well before the popover itself is slow to
		// react. Widened to match the other generous, real-signal waits in this
		// spec (e.g. the 20s textarea wait below).
		await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 15_000 });
		await page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="reattempt"]').click();

		// Should open a goal assistant session with a textarea
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

		// Verify it navigated to a session
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toMatch(/#\/session\/[a-f0-9-]+/i);
		}).toPass({ timeout: 10_000 });

		// Clean up the created re-attempt session
		const hash = await page.evaluate(() => window.location.hash);
		const sessionIdMatch = hash.match(/#\/session\/([a-f0-9-]+)/i);
		if (sessionIdMatch) {
			await apiFetch(`/api/sessions/${sessionIdMatch[1]}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("SB-22b: Re-attempt button visible on a fresh goal with no sessions", async ({ page }) => {
		const goal = await createGoal({ title: "SB22b Fresh Reattempt", cwd: nonGitCwd() });
		goalIds.push(goal.id);

		// Desktop viewport so the sidebar-actions hamburger trigger renders
		await page.setViewportSize({ width: 1280, height: 900 });
		await openApp(page);

		const goalTitle = page.getByText("SB22b Fresh Reattempt", { exact: false }).first();
		await expect(goalTitle).toBeVisible({ timeout: 15_000 });

		const goalRow = goalTitle.locator("xpath=ancestor::div[contains(@class,'group')]").first();
		await goalRow.hover();

		// Re-attempt is now popover-only (quick:false). Drive it through the popover.
		const trigger = page.locator(
			`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="goal"][data-sidebar-actions-id="${goal.id}"]`,
		);
		await expect(trigger).toBeVisible({ timeout: 5_000 });
		await trigger.click();

		// See the matching comment in SB-22 above — same cold dynamic-import path.
		await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 15_000 });
		await page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="reattempt"]').click();

		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toMatch(/#\/session\/[a-f0-9-]+/i);
		}).toPass({ timeout: 10_000 });

		const hash = await page.evaluate(() => window.location.hash);
		const m = hash.match(/#\/session\/([a-f0-9-]+)/i);
		if (m) await apiFetch(`/api/sessions/${m[1]}`, { method: "DELETE" }).catch(() => {});
	});

	test("SB-23: Archive goal — disappears from live, appears in archived", async ({ page }) => {
		// Create a live goal
		const goal = await createGoal({ title: "SB23 Archive Test", cwd: nonGitCwd() });
		goalIds.push(goal.id);

		await openApp(page);

		// Verify the goal appears in the live section
		await expect(page.getByText("SB23 Archive Test").first()).toBeVisible({ timeout: 10_000 });

		// Archive via API
		await apiFetch(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" });

		// Reload to get fresh state
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Goal should NOT be visible in live section
		await expect(page.getByText("SB23 Archive Test")).toHaveCount(0, { timeout: 5_000 });

		// Toggle "Show Archived" on via the Filters popover
		const archivedToggle = filtersButton(page);
		await expect(archivedToggle).toBeVisible({ timeout: 10_000 });
		await clickShowArchivedToggle(page);

		// Now the archived goal should be visible (title rendered uppercase via CSS)
		await expect(page.getByText("SB23 Archive Test", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
	});

});
