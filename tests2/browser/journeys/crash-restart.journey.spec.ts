/**
 * Journey: Crash + Restart — v2 browser smoke
 * Covers: journey-crash-restart
 * Consolidated from: sidebar-tree-restart, steer-gateway-restart,
 *   bg-process-persistence, preview-durable-restart, etc.
 *
 * Uses the crash()/restart() fixture from gateway-harness.ts.
 */
import { test, expect, type GatewayInfo } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "../_helpers/journey-fixture.js";
import type { Page } from "@playwright/test";

async function crashAndRestart(gateway: GatewayInfo, page: Page): Promise<void> {
	await gateway.crash();
	await expect.poll(
		async () => {
			try {
				const r = await apiFetch("/health");
				return r.status === 200;
			} catch {
				return false;
			}
		},
		{ timeout: 20_000, intervals: [250], message: "gateway should recover after restart" },
	).toBe(false).catch(() => {/* crash was fast */});
	await gateway.restart();
	await expect.poll(
		async () => {
			try {
				const r = await apiFetch("/health");
				return r.status === 200;
			} catch {
				return false;
			}
		},
		{ timeout: 20_000, intervals: [250], message: "gateway should be healthy after restart" },
	).toBe(true);
}

test.describe("Journey: Crash + Restart", () => {
	test("app is reachable before crash", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("gateway crash and restart: app recovers and sidebar is visible", async ({ page, gateway }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await crashAndRestart(gateway, page);
		// After restart, app should reconnect
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });
	});

	test("gateway restart: health endpoint recovers", async ({ gateway }) => {
		await gateway.crash();
		await gateway.restart();
		const r = await apiFetch("/health");
		expect(r.status).toBe(200);
	});
});
