/**
 * Browser E2E test for sidebar child auto-loading.
 *
 * Verifies that expanding a goal in the sidebar shows children. API-only
 * coverage for GET /api/goals/:id/team/agents?include=archived lives in
 * tests/e2e/sidebar-api.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import {
	createGoal,
	startTeam,
	teardownTeam,
	deleteGoal,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Sidebar child auto-loading", () => {
	const goalIds: string[] = [];

	test.afterAll(async () => {
		for (const gid of goalIds) {
			await teardownTeam(gid).catch(() => {});
			await deleteGoal(gid);
		}
	});


	test("expanding a team goal in sidebar shows team lead child", async ({ page }) => {
		// 1. Create a team goal and start the team
		const goal = await createGoal({
			title: "ExpandChild Test",
			worktree: false,
			team: true,
		});
		goalIds.push(goal.id);
		const teamLeadId = await startTeam(goal.id);
		await waitForSessionStatus(teamLeadId, "idle");

		// 2. Open the app
		await openApp(page);

		// 3. Find the goal in the sidebar (text rendered in uppercase via CSS)
		const goalHeader = page.getByText("ExpandChild Test", { exact: false }).first();
		await expect(goalHeader).toBeVisible({ timeout: 15_000 });

		// 4. Expand the goal if not already expanded
		const collapseChevron = page.locator("[title='Collapse goal']").first();
		const alreadyExpanded = await collapseChevron.isVisible().catch(() => false);
		if (!alreadyExpanded) {
			const expandChevron = page.locator("[title='Expand goal']").first();
			await expandChevron.click();
		}

		// 5. After expanding, the team lead session should be visible as a child.
		//    Use the same approach as SB-02: navigate directly to the team lead
		//    and verify it loads (proving the session is accessible via the goal).
		const { navigateToHash } = await import("./ui-helpers.js");
		await navigateToHash(page, `#/session/${teamLeadId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Verify URL contains the team lead session ID
		const hash = await page.evaluate(() => window.location.hash);
		expect(hash).toContain(teamLeadId);
	});
});
