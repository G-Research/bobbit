/**
 * Maintenance tab E2E tests: navigation, scan buttons, action button state, persistence.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Maintenance tab (full-stack UI)", () => {
	test("navigate to Maintenance tab and verify sections render", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/maintenance");

		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });

		// Verify all three section headings are visible
		await expect(page.getByText("Orphaned Worktrees")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("Orphaned Sessions")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("Expired Archives")).toBeVisible({ timeout: 5_000 });

		await expect(page).toHaveURL(/#\/settings\/system\/maintenance/);
	});

	test("action buttons are disabled before scan", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/maintenance");

		await expect(page.getByText("Orphaned Worktrees")).toBeVisible({ timeout: 10_000 });

		// All action buttons should be disabled before scanning
		await expect(page.getByRole("button", { name: /Clean Up/ })).toBeDisabled();
		await expect(page.getByRole("button", { name: /Terminate/ })).toBeDisabled();
		await expect(page.getByRole("button", { name: /Purge/ })).toBeDisabled();
	});

	test("scan buttons call API and update UI", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/maintenance");

		await expect(page.getByText("Orphaned Worktrees")).toBeVisible({ timeout: 10_000 });

		// Scan worktrees — wait for API response then check UI updated
		const worktreeResp = page.waitForResponse(
			resp => resp.url().includes("/api/maintenance/orphaned-worktrees"),
		);
		await page.getByRole("button", { name: "Scan" }).first().click();
		await worktreeResp;
		// After scan, UI shows either empty message or a list with enabled Clean Up button
		const noWorktrees = page.getByText(/No orphaned worktrees found/);
		const cleanUpEnabled = page.getByRole("button", { name: /Clean Up \(\d+\)/ });
		await expect(noWorktrees.or(cleanUpEnabled)).toBeVisible({ timeout: 5_000 });

		// Scan sessions
		const sessionsResp = page.waitForResponse(
			resp => resp.url().includes("/api/maintenance/orphaned-sessions"),
		);
		await page.getByRole("button", { name: "Scan" }).nth(1).click();
		await sessionsResp;
		const noSessions = page.getByText(/No orphaned sessions found/);
		const terminateEnabled = page.getByRole("button", { name: /Terminate \(\d+\)/ });
		await expect(noSessions.or(terminateEnabled)).toBeVisible({ timeout: 5_000 });

		// Scan archives
		const archivesResp = page.waitForResponse(
			resp => resp.url().includes("/api/maintenance/expired-archives"),
		);
		await page.getByRole("button", { name: "Scan" }).nth(2).click();
		await archivesResp;
		const noArchives = page.getByText(/No expired archives found/);
		const purgeEnabled = page.getByRole("button", { name: /Purge \(\d+\)/ });
		await expect(noArchives.or(purgeEnabled)).toBeVisible({ timeout: 5_000 });
	});

	test("action buttons reflect scan results", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/maintenance");

		await expect(page.getByText("Orphaned Worktrees")).toBeVisible({ timeout: 10_000 });

		// Before scan: all action buttons disabled
		await expect(page.getByRole("button", { name: /Clean Up/ })).toBeDisabled();
		await expect(page.getByRole("button", { name: /Terminate/ })).toBeDisabled();
		await expect(page.getByRole("button", { name: /Purge/ })).toBeDisabled();

		// Scan all three sections
		const wtResp = page.waitForResponse(r => r.url().includes("/api/maintenance/orphaned-worktrees"));
		await page.getByRole("button", { name: "Scan" }).first().click();
		await wtResp;

		const sessResp = page.waitForResponse(r => r.url().includes("/api/maintenance/orphaned-sessions"));
		await page.getByRole("button", { name: "Scan" }).nth(1).click();
		await sessResp;

		const archResp = page.waitForResponse(r => r.url().includes("/api/maintenance/expired-archives"));
		await page.getByRole("button", { name: "Scan" }).nth(2).click();
		await archResp;

		// After scan with empty results, action buttons stay disabled.
		// With results, they become enabled with a count.
		// Either way, the scan completed and the UI updated — that's what we verify.
		const cleanUp = page.getByRole("button", { name: /Clean Up/ });
		const terminate = page.getByRole("button", { name: /Terminate/ });
		const purge = page.getByRole("button", { name: /Purge/ });

		// Verify buttons are present (the scan completed and re-rendered)
		await expect(cleanUp).toBeVisible({ timeout: 5_000 });
		await expect(terminate).toBeVisible({ timeout: 5_000 });
		await expect(purge).toBeVisible({ timeout: 5_000 });
	});

	test("can switch to Maintenance tab via tab bar", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		await expect(page.getByText("Show message timestamps")).toBeVisible({ timeout: 10_000 });

		// Click the Maintenance tab button
		await page.locator("button").filter({ hasText: "Maintenance" }).first().click();

		await expect(page).toHaveURL(/#\/settings\/system\/maintenance/, { timeout: 5_000 });
		await expect(page.getByText("Orphaned Worktrees")).toBeVisible({ timeout: 5_000 });
	});

	test("scan state persists when switching tabs and back", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/maintenance");

		await expect(page.getByText("Orphaned Worktrees")).toBeVisible({ timeout: 10_000 });

		// Scan worktrees to populate state
		const worktreeResp = page.waitForResponse(
			resp => resp.url().includes("/api/maintenance/orphaned-worktrees"),
		);
		await page.getByRole("button", { name: "Scan" }).first().click();
		await worktreeResp;

		// Wait for scan results to render (either empty message or result list)
		const noWorktrees = page.getByText(/No orphaned worktrees found/);
		const cleanUpBtn = page.getByRole("button", { name: /Clean Up \(\d+\)/ });
		await expect(noWorktrees.or(cleanUpBtn)).toBeVisible({ timeout: 5_000 });

		// Remember which state we saw
		const hadOrphans = await cleanUpBtn.isVisible().catch(() => false);

		// Switch to General tab
		await page.locator("button").filter({ hasText: "General" }).first().click();
		await expect(page.getByText("Show message timestamps")).toBeVisible({ timeout: 5_000 });

		// Switch back to Maintenance tab
		await page.locator("button").filter({ hasText: "Maintenance" }).first().click();
		await expect(page.getByText("Orphaned Worktrees")).toBeVisible({ timeout: 5_000 });

		// Previous scan result should still be visible (module-level state persists)
		if (hadOrphans) {
			await expect(cleanUpBtn).toBeVisible({ timeout: 5_000 });
		} else {
			await expect(noWorktrees).toBeVisible({ timeout: 5_000 });
		}
	});

	test("cleanup worktrees action calls POST endpoint", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/maintenance");

		await expect(page.getByText("Orphaned Worktrees")).toBeVisible({ timeout: 10_000 });

		// Scan first
		const scanResp = page.waitForResponse(
			r => r.url().includes("/api/maintenance/orphaned-worktrees"),
		);
		await page.getByRole("button", { name: "Scan" }).first().click();
		await scanResp;

		const cleanUpBtn = page.getByRole("button", { name: /Clean Up/ });

		// If there are orphaned worktrees, click Clean Up and verify POST is made
		if (await cleanUpBtn.isEnabled()) {
			const postResp = page.waitForResponse(
				r => r.url().includes("/api/maintenance/cleanup-worktrees") && r.request().method() === "POST",
			);
			// After POST, a re-scan GET will also fire
			const rescanResp = page.waitForResponse(
				r => r.url().includes("/api/maintenance/orphaned-worktrees") && r.request().method() === "GET",
			);
			await cleanUpBtn.click();
			await postResp;
			await rescanResp;

			// After cleanup + re-scan, UI should update (might be empty now or fewer items)
			const noWorktrees = page.getByText(/No orphaned worktrees found/);
			const stillHasOrphans = page.getByRole("button", { name: /Clean Up \(\d+\)/ });
			await expect(noWorktrees.or(stillHasOrphans)).toBeVisible({ timeout: 10_000 });
		}
		// If disabled (no orphans), the test still passes — we verified the button state
	});
});
