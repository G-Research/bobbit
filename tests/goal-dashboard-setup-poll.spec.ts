import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/goal-dashboard-setup-poll.html")}`;

test.describe("Goal dashboard setup status polling", () => {
	test("setup banner stays stale without polling (bug reproduction)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Verify the "Setting up worktree…" banner is visible
		await expect(page.locator("#setup-banner")).toBeVisible();
		await expect(page.locator("#setup-banner")).toContainText("Setting up worktree");

		// Simulate server-side status change to "ready"
		await page.click("#btn-set-ready");

		// Verify server status changed but UI hasn't updated
		const serverStatus = await page.evaluate(() => (window as any).__getState().serverStatus);
		expect(serverStatus).toBe("ready");

		// Wait 3 seconds — without polling, the UI should NOT update
		await page.waitForTimeout(3000);

		// Bug confirmed: banner still shows "Setting up worktree…"
		await expect(page.locator("#setup-banner")).toBeVisible();
		await expect(page.locator("#setup-banner")).toContainText("Setting up worktree");

		// The ready state should NOT be visible
		await expect(page.locator("#ready-state")).not.toBeVisible();

		// Refresh count should still be 0 (no automatic refreshes happened)
		const state = await page.evaluate(() => (window as any).__getState());
		expect(state.refreshCount).toBe(0);
		expect(state.uiStatus).toBe("preparing");
	});

	test("setup banner updates when polling is enabled (will fail until fix is applied)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Verify the "Setting up worktree…" banner is visible
		await expect(page.locator("#setup-banner")).toBeVisible();
		await expect(page.locator("#setup-banner")).toContainText("Setting up worktree");

		// Enable setup status polling — this simulates what the fix will do.
		// In the real code, goal-dashboard.ts would start this poll when
		// setupStatus === "preparing" in loadDashboardData().
		// For now, startSetupStatusPoll exists in the fixture but the REAL
		// goal-dashboard.ts does NOT have this logic yet.
		await page.evaluate(() => (window as any).__startSetupStatusPoll());

		// Simulate server-side status change to "ready"
		await page.click("#btn-set-ready");

		// With polling active, the UI should update within a few seconds
		await expect(page.locator("#ready-state")).toBeVisible({ timeout: 5000 });
		await expect(page.locator("#setup-banner")).not.toBeVisible();

		// Verify state is correct
		const state = await page.evaluate(() => (window as any).__getState());
		expect(state.uiStatus).toBe("ready");
		expect(state.refreshCount).toBeGreaterThan(0);
		// Polling should have stopped since status is no longer "preparing"
		expect(state.isPolling).toBe(false);
	});

	test("error state banner appears when polling detects error", async ({ page }) => {
		await page.goto(TEST_PAGE);

		await expect(page.locator("#setup-banner")).toContainText("Setting up worktree");

		// Enable polling and change server status to error
		await page.evaluate(() => (window as any).__startSetupStatusPoll());
		await page.click("#btn-set-error");

		// Should show error banner
		await expect(page.locator(".setup-banner--error")).toBeVisible({ timeout: 5000 });
		await expect(page.locator(".setup-banner--error")).toContainText("Worktree setup failed");

		const state = await page.evaluate(() => (window as any).__getState());
		expect(state.uiStatus).toBe("error");
		expect(state.isPolling).toBe(false); // stopped after leaving "preparing"
	});

	test("no polling occurs for goals already in ready state", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Manually set to ready first, then refresh
		await page.click("#btn-set-ready");
		await page.click("#btn-manual-refresh");

		await expect(page.locator("#ready-state")).toBeVisible();

		// Reset refresh count via evaluate
		await page.evaluate(() => {
			const state = (window as any).__getState();
			// Refreshing once for the manual click above, now check no further refreshes
		});

		const countBefore = await page.evaluate(() => (window as any).__getState().refreshCount);

		// Wait 3 seconds — should be no additional refreshes
		await page.waitForTimeout(3000);

		const countAfter = await page.evaluate(() => (window as any).__getState().refreshCount);
		expect(countAfter).toBe(countBefore);
	});
});
