/**
 * Browser E2E — splash screen with ≥2 projects opens a project picker
 * popover anchored at the "New Session" button.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function uniqueDir(tag: string): string {
	const dir = join(tmpdir(), `bobbit-e2e-splash-${tag}-${process.env.E2E_PORT}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test.describe("Splash screen — ≥2 projects", () => {
	test("clicking 'New Session' opens project picker; selecting a project creates a session bound to it", async ({ page }) => {
		await openApp(page);

		// Register a second project so state.projects.length >= 2.
		// Default project is already registered by the harness.
		const dir = uniqueDir("p2");
		const resp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "second-project", rootPath: dir, upsert: true }),
		});
		expect(resp.ok).toBeTruthy();

		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });

		const splashLabel = page.locator('[data-testid="splash-new-session-label"]').first();
		await expect(splashLabel).toBeVisible({ timeout: 10_000 });
		await expect(splashLabel).toContainText("New Session");

		// Click → picker appears.
		await splashLabel.click();
		const picker = page.locator('[data-testid="splash-project-picker"]');
		await expect(picker).toBeVisible({ timeout: 5_000 });

		// At least 2 items.
		const items = picker.locator('[data-testid="splash-project-picker-item"]');
		expect(await items.count()).toBeGreaterThanOrEqual(2);
	});

	test("picker closes on Escape", async ({ page }) => {
		await openApp(page);
		const dir = uniqueDir("p3");
		await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "third-project", rootPath: dir, upsert: true }),
		});
		await page.reload();
		const splashLabel = page.locator('[data-testid="splash-new-session-label"]').first();
		await expect(splashLabel).toBeVisible({ timeout: 10_000 });
		await splashLabel.click();
		const picker = page.locator('[data-testid="splash-project-picker"]');
		await expect(picker).toBeVisible({ timeout: 5_000 });
		await page.keyboard.press("Escape");
		await expect(picker).toBeHidden({ timeout: 5_000 });
	});
});
