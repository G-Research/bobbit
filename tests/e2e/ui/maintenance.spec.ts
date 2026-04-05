/**
 * Maintenance tab E2E tests: navigation, scan buttons, action button state.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Maintenance tab (full-stack UI)", () => {
	test("navigate to Maintenance tab and verify sections render", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/maintenance");

		// Verify settings view renders
		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });

		// Verify all three section headings are visible
		await expect(page.getByText("Orphaned Worktrees")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("Orphaned Sessions")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("Expired Archives")).toBeVisible({ timeout: 5_000 });

		// Verify the URL is correct
		await expect(page).toHaveURL(/#\/settings\/system\/maintenance/);
	});

	test("action buttons are disabled before scan", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/maintenance");

		await expect(page.getByText("Orphaned Worktrees")).toBeVisible({ timeout: 10_000 });

		// All action buttons should be disabled before scanning
		const cleanUpBtn = page.getByRole("button", { name: /Clean Up/ });
		const terminateBtn = page.getByRole("button", { name: /Terminate/ });
		const purgeBtn = page.getByRole("button", { name: /Purge/ });

		await expect(cleanUpBtn).toBeDisabled();
		await expect(terminateBtn).toBeDisabled();
		await expect(purgeBtn).toBeDisabled();
	});

	test("scan buttons call API and update UI", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/maintenance");

		await expect(page.getByText("Orphaned Worktrees")).toBeVisible({ timeout: 10_000 });

		// Click each Scan button — the sections should update (empty results in clean env)
		const scanButtons = page.getByRole("button", { name: "Scan" });

		// Scan worktrees
		await scanButtons.first().click();
		await expect(page.getByText(/No orphaned worktrees found/)).toBeVisible({ timeout: 10_000 });

		// Scan sessions
		await scanButtons.nth(1).click();
		await expect(page.getByText(/No orphaned sessions found/)).toBeVisible({ timeout: 10_000 });

		// Scan archives
		await scanButtons.nth(2).click();
		await expect(page.getByText(/No expired archives found/)).toBeVisible({ timeout: 10_000 });
	});

	test("can switch to Maintenance tab via tab bar", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		// Verify General tab loaded
		await expect(page.getByText("Show message timestamps")).toBeVisible({ timeout: 10_000 });

		// Click the Maintenance tab button
		const maintenanceTab = page.locator("button").filter({ hasText: "Maintenance" }).first();
		await maintenanceTab.click();

		// Verify URL updated and content rendered
		await expect(page).toHaveURL(/#\/settings\/system\/maintenance/, { timeout: 5_000 });
		await expect(page.getByText("Orphaned Worktrees")).toBeVisible({ timeout: 5_000 });
	});
});
