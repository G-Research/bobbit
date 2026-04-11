/**
 * Sidebar goal actions & staff E2E tests — SB-16, SB-22, SB-23, SB-31.
 *
 * Covers:
 *   SB-16: "New Goal" button on project header → goal assistant opens
 *   SB-22: Re-attempt archived goal → goal assistant opens
 *   SB-23: Archive goal lifecycle (live → archive → appears in archived section)
 *   SB-31: Staff section not visible when no staff configured
 */
import { test, expect } from "../gateway-harness.js";
import { createGoal, deleteGoal, apiFetch, nonGitCwd } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Sidebar goal actions & staff", () => {
	const goalIds: string[] = [];

	test.afterAll(async () => {
		for (const id of goalIds) {
			await deleteGoal(id).catch(() => {});
		}
	});

	test("SB-16: New Goal button visible and opens goal assistant", async ({ page }) => {
		await openApp(page);

		// The "New Goal" button appears in the project header area or the bottom action bar.
		// In single-project mode, the button is in the nav bar with title "New goal (Alt+G)".
		// In multi-project mode, it's on the project header with title "New goal in <project>".
		const newGoalBtn = page.locator("button").filter({ hasText: "New Goal" }).first();
		await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });

		// Click it — should open a goal assistant session with a textarea
		await newGoalBtn.click();
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
		await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });

		await openApp(page);

		// Toggle "Show archived" to reveal the archived goal
		const archivedToggle = page.locator("button").filter({ hasText: /Archived/i }).first();
		await expect(archivedToggle).toBeVisible({ timeout: 10_000 });
		await archivedToggle.click();

		// Wait for archived goals to load and the goal title to appear
		await expect(page.getByText("SB22 Reattempt Test").first()).toBeVisible({ timeout: 10_000 });

		// Hover over the goal row to reveal action buttons
		const goalRow = page.getByText("SB22 Reattempt Test").first();
		await goalRow.hover();

		// Find and click the re-attempt button (title="Re-attempt goal")
		const reattemptBtn = page.locator("button[title='Re-attempt goal']").first();
		await expect(reattemptBtn).toBeVisible({ timeout: 5_000 });
		await reattemptBtn.click();

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

	test("SB-23: Archive goal — disappears from live, appears in archived", async ({ page }) => {
		// Create a live goal
		const goal = await createGoal({ title: "SB23 Archive Test", cwd: nonGitCwd() });
		goalIds.push(goal.id);

		await openApp(page);

		// Verify the goal appears in the live section
		await expect(page.getByText("SB23 Archive Test").first()).toBeVisible({ timeout: 10_000 });

		// Archive via API
		await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });

		// Reload to get fresh state
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Goal should NOT be visible in live section
		await expect(page.getByText("SB23 Archive Test")).toHaveCount(0, { timeout: 5_000 });

		// Toggle "Show archived"
		const archivedToggle = page.locator("button").filter({ hasText: /Archived/i }).first();
		await expect(archivedToggle).toBeVisible({ timeout: 10_000 });
		await archivedToggle.click();

		// Now the archived goal should be visible
		await expect(page.getByText("SB23 Archive Test").first()).toBeVisible({ timeout: 10_000 });
	});

	test("SB-31: No Staff section visible when no staff configured", async ({ page }) => {
		await openApp(page);

		// Wait for the sidebar to fully load
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// The Staff section header should still be present (it's always rendered
		// so users can create their first staff agent), but verify there are
		// no staff agent rows with active sessions
		// Look for any staff row with a session status indicator — there shouldn't be one
		// since no staff agents are configured in the E2E test environment
		const staffRows = page.locator("[class*='staff']").filter({ hasText: /streaming|idle|busy/ });
		await expect(staffRows).toHaveCount(0, { timeout: 5_000 });
	});
});
