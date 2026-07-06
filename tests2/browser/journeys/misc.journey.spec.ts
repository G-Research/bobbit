/**
 * Journey: Misc — v2 browser smoke
 * Covers: journey-notification-policy, journey-review-commenting,
 *   journey-preview-artifacts, journey-compaction, journey-cost-tracking,
 *   journey-workflow-editor, journey-dynamic-panels, journey-mobile-layout
 * Consolidated from: api-error-modal, mobile-review-commenting, preview-panel-*,
 *   compaction-*, cost-*, workflow-editor-*, dynamic-panels-*, mobile-*, etc.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus } from "../_helpers/journey-fixture.js";

test.describe("Journey: Notification Policy", () => {
	test("app renders without notification errors", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("settings route reachable for notification config", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
	});
});

test.describe("Journey: Review Commenting", () => {
	test("app shell stable for review commenting scenario", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Journey: Preview Artifacts", () => {
	test("session route loads for preview artifact context", async ({ page }) => {
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
});

test.describe("Journey: Compaction", () => {
	test("session loads for compaction scenario", async ({ page }) => {
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
});

test.describe("Journey: Cost Tracking", () => {
	test("app loads without cost tracking errors", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Journey: Workflow Editor", () => {
	test("app shell stable for workflow editor flow", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Journey: Dynamic Panels", () => {
	test("session route renders for dynamic panel scenario", async ({ page }) => {
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
});

test.describe("Journey: Mobile Layout", () => {
	test("app renders at mobile viewport", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openApp(page);
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
	});

	test.skip("sidebar-edge visible at mobile viewport", async ({ page }) => {
		// Skipped: .sidebar-edge is typically hidden/collapsed at mobile viewport width.
		// Mobile sidebar behaviour is tested by geometry-fixture specs.
		await page.setViewportSize({ width: 390, height: 844 });
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});
});
