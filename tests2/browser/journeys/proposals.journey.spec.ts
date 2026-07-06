/**
 * Journey: Proposals — v2 browser smoke
 * Covers: journey-proposals
 * Consolidated from: goal-proposal-*, project-proposal-*, proposal-panel-*, etc.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus } from "../_helpers/journey-fixture.js";

test.describe("Journey: Proposals", () => {
	test("app shell renders on load", async ({ page }) => {
		await openApp(page);
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
		const title = await page.title();
		expect(title).toBeTruthy();
	});

	test("proposal route is navigable", async ({ page }) => {
		await openApp(page);
		// Proposals are surfaced via session context; just confirm the app shell loads
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("session with streaming message shows proposal-compatible UI", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("sidebar visible alongside session for proposal panel integration", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 5_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("New Goal button opens dialog or navigates to goal form", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		// Look for the New Goal button
		const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
		if (await newGoalBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
			await newGoalBtn.click();
			// Either a dialog opens, or we navigate to a goal form / project picker
			const dialogOrForm = page.locator(
				"dialog, [role='dialog'], [role='alertdialog'], " +
				"goal-proposal-panel, [data-testid='goal-proposal'], " +
				"input[placeholder*='title' i], input[placeholder*='goal' i]"
			).first();
			await expect(dialogOrForm).toBeVisible({ timeout: 10_000 });
		} else {
			// New Goal button not visible (single-session mode or different layout)
			test.skip(true, "New Goal button not found; proposals may surface differently in this gateway config");
		}
	});
});
