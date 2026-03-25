import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/goal-dashboard-setup-poll.html")}`;

test.describe("Goal dashboard setup status polling", () => {
	test("banner auto-updates when server status changes from preparing to ready", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Verify the "Setting up worktree…" banner is visible
		await expect(page.locator("#setup-banner")).toBeVisible();
		await expect(page.locator("#setup-banner")).toContainText("Setting up worktree");

		// Load dashboard data with the fix enabled — simulates the real
		// goal-dashboard.ts starting a poll when setupStatus is "preparing"
		await page.evaluate(() => {
			(window as any).__enableFix();
			(window as any).__loadDashboardData();
		});

		// Verify polling started
		const polling = await page.evaluate(() => (window as any).__getState().isPolling);
		expect(polling).toBe(true);

		// Simulate server-side status change to "ready"
		await page.evaluate(() => (window as any).__setServerStatus("ready"));

		// With polling active, the UI should update within a few seconds
		await expect(page.locator("#ready-state")).toBeVisible({ timeout: 5000 });
		await expect(page.locator("#setup-banner")).not.toBeVisible();

		// Verify polling stopped after status changed
		const state = await page.evaluate(() => (window as any).__getState());
		expect(state.uiStatus).toBe("ready");
		expect(state.isPolling).toBe(false);
		expect(state.refreshCount).toBeGreaterThan(0);
	});

	test("banner auto-updates to error state when polling detects failure", async ({ page }) => {
		await page.goto(TEST_PAGE);

		await expect(page.locator("#setup-banner")).toContainText("Setting up worktree");

		// Enable fix and reload
		await page.evaluate(() => {
			(window as any).__enableFix();
			(window as any).__loadDashboardData();
		});

		// Change server status to error
		await page.evaluate(() => (window as any).__setServerStatus("error", "git worktree add failed"));

		// Error banner should appear
		await expect(page.locator("#setup-banner-error")).toBeVisible({ timeout: 5000 });
		await expect(page.locator("#setup-banner-error")).toContainText("Worktree setup failed");

		const state = await page.evaluate(() => (window as any).__getState());
		expect(state.uiStatus).toBe("error");
		expect(state.isPolling).toBe(false);
	});

	test("no polling starts for goals already in ready state", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Set server to ready before loading
		await page.evaluate(() => {
			(window as any).__setServerStatus("ready");
			(window as any).__enableFix();
			(window as any).__loadDashboardData();
		});

		await expect(page.locator("#ready-state")).toBeVisible();

		// Polling should NOT have started
		const state = await page.evaluate(() => (window as any).__getState());
		expect(state.isPolling).toBe(false);

		// Wait a bit and confirm no extra refreshes
		const countBefore = state.refreshCount;
		await page.waitForTimeout(2000);
		const countAfter = await page.evaluate(() => (window as any).__getState().refreshCount);
		expect(countAfter).toBe(countBefore);
	});

	test("cleanup stops polling when leaving dashboard", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Enable fix and load — polling should start
		await page.evaluate(() => {
			(window as any).__enableFix();
			(window as any).__loadDashboardData();
		});

		const polling = await page.evaluate(() => (window as any).__getState().isPolling);
		expect(polling).toBe(true);

		// Simulate leaving dashboard
		await page.evaluate(() => (window as any).__stopAllPolling());

		const stoppedPolling = await page.evaluate(() => (window as any).__getState().isPolling);
		expect(stoppedPolling).toBe(false);
	});
});
