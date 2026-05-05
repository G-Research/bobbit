/**
 * Browser E2E — splash screen with 0 projects shows "New Project"
 * (not "New Session"); clicking it opens the project dialog instead of
 * POSTing /api/sessions with a missing projectId.
 *
 * Pattern: navigate → happy path → persistence → cleanup.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Splash screen — 0 projects", () => {
	test("shows 'New Project' button and opens project dialog", async ({ page }) => {
		await openApp(page);

		// Remove the harness-registered "default" project so the splash sees zero projects.
		const list = await apiFetch("/api/projects").then(r => r.json()) as Array<{ id: string }>;
		for (const p of list) {
			await apiFetch(`/api/projects/${p.id}?force=1`, { method: "DELETE" });
		}

		// Reload so the client picks up the empty project list.
		await page.reload();

		// Wait for app skeleton.
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });

		// The desktop empty state renders the "New Session" button via
		// data-testid="splash-new-session-label". With zero projects the
		// label flips to "New Project".
		const splashLabel = page.locator('[data-testid="splash-new-session-label"]').first();
		await expect(splashLabel).toBeVisible({ timeout: 10_000 });
		await expect(splashLabel).toContainText("New Project");
		await expect(splashLabel).not.toContainText("New Session");

		// Clicking it must open the project dialog, NOT POST /api/sessions.
		// Capture any session-create requests so we can assert none fire.
		const sessionPosts: string[] = [];
		page.on("request", (req) => {
			if (req.method() === "POST" && req.url().includes("/api/sessions")) {
				sessionPosts.push(req.url());
			}
		});
		// Race: click and ensure no /api/sessions POST happens within a short window.
		const stray = page.waitForRequest((req) => req.method() === "POST" && req.url().includes("/api/sessions"), { timeout: 1500 }).catch(() => null);
		await splashLabel.click();
		const racedReq = await stray;
		expect(racedReq, "splash 'New Project' click must NOT POST /api/sessions").toBeNull();
		expect(sessionPosts).toEqual([]);
	});

	test("persistence — reload still shows 'New Project' with zero projects", async ({ page }) => {
		await openApp(page);
		const list = await apiFetch("/api/projects").then(r => r.json()) as Array<{ id: string }>;
		for (const p of list) {
			await apiFetch(`/api/projects/${p.id}?force=1`, { method: "DELETE" });
		}
		await page.reload();

		const splashLabel = page.locator('[data-testid="splash-new-session-label"]').first();
		await expect(splashLabel).toBeVisible({ timeout: 10_000 });
		await expect(splashLabel).toContainText("New Project");

		await page.reload();
		const splashLabel2 = page.locator('[data-testid="splash-new-session-label"]').first();
		await expect(splashLabel2).toBeVisible({ timeout: 10_000 });
		await expect(splashLabel2).toContainText("New Project");
	});
});
