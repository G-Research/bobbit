/**
 * Shared page-object helpers for UI E2E tests.
 *
 * Minimal stub — the canonical version is created by another agent.
 * This provides the subset needed by team-lifecycle-ui and project-management tests.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { readE2EToken } from "../e2e-setup.js";

/** Open the app authenticated via token query param. Wait for sidebar ready. */
export async function openApp(page: Page): Promise<void> {
	const token = readE2EToken();
	const base = `http://127.0.0.1:${process.env.E2E_PORT}`;
	await page.goto(`${base}/?token=${encodeURIComponent(token)}`);
	// Wait for sidebar to be ready — the button title varies:
	// "New session" (no projects) or "New session in <project>" (with projects)
	await expect(
		page.locator("button[title^='New session']").first(),
	).toBeVisible({ timeout: 15_000 });
}

/** Navigate to a hash route and wait briefly for the transition. */
export async function navigateToHash(page: Page, hash: string): Promise<void> {
	await page.evaluate((h) => { window.location.hash = h; }, hash);
	// Give the app time to process the route change
	await page.waitForTimeout(300);
}

/** Navigate to the goal dashboard for a specific goal. */
export async function navigateToGoalDashboard(page: Page, goalId: string): Promise<void> {
	// Route is #/goal/<id> (not #/goal-dashboard/<id>) — see src/app/routing.ts
	await navigateToHash(page, `#/goal/${goalId}`);
	// Wait for the dashboard container to render — the app renders it in the main content area
	// The dashboard uses class "dashboard-container" but may also show loading first
	await expect(
		page.locator(".dashboard-container, .dashboard-loading").first(),
	).toBeVisible({ timeout: 10_000 });
	// If loading, wait for loading to complete
	await page.locator(".dashboard-loading").waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
}

/** Click a sidebar item by its text label. */
export async function clickSidebarItem(page: Page, label: string): Promise<void> {
	await page.getByText(label, { exact: false }).first().click();
}
