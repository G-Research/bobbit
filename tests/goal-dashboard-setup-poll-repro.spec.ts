import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/goal-dashboard-setup-poll.html")}`;

/**
 * Reproducing test for the stale worktree status bug.
 *
 * This test demonstrates the bug: when loadDashboardData() runs WITHOUT
 * the fix (fixEnabled=false), the dashboard does NOT poll for setup status
 * changes. The "Setting up worktree…" banner stays stale even after the
 * server-side status changes to "ready".
 *
 * This test FAILS while the bug exists (no auto-polling in the default path).
 * After the fix is applied to goal-dashboard.ts, the fixture will be updated
 * so loadDashboardData() starts polling by default, and this test will PASS.
 */
test("dashboard auto-updates setup banner without manual intervention", async ({ page }) => {
	await page.goto(TEST_PAGE);

	// Banner should be visible initially (goal is in "preparing" state)
	await expect(page.locator("#setup-banner")).toBeVisible();

	// Simulate server completing worktree setup
	await page.evaluate(() => (window as any).__setServerStatus("ready"));

	// The dashboard SHOULD auto-detect this change within 5 seconds.
	// BUG: Without setup-status polling, it doesn't. This assertion fails.
	await expect(page.locator("#ready-state")).toBeVisible({ timeout: 5000 });
});
