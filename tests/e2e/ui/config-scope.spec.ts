/**
 * Config page scope navigation and origin badges — UI E2E tests.
 *
 * Validates that config pages (roles, tools, workflows)
 * show the project scope row and origin badges when multiple projects exist.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Create a temp dir with .bobbit scaffolding for a second project. */
function createProjectDir(): string {
	const dir = mkdtempSync(join(tmpdir(), `bobbit-scope-ui-${process.env.E2E_PORT}-`));
	mkdirSync(join(dir, ".bobbit", "config", "roles"), { recursive: true });
	mkdirSync(join(dir, ".bobbit", "config", "workflows"), { recursive: true });
	mkdirSync(join(dir, ".bobbit", "config", "tools"), { recursive: true });
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	return dir;
}

test.describe("Config page scope navigation", () => {
	let projectId: string;
	let tmpDir: string;

	test.beforeAll(async () => {
		tmpDir = createProjectDir();
		const res = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Scope UI Project", rootPath: tmpDir }),
		});
		expect(res.status).toBe(201);
		const proj = await res.json();
		projectId = proj.id;
	});

	test.afterAll(async () => {
		await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("roles page shows scope row with System and project tabs @smoke", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/roles");

		// Scope row should have "System" button
		await expect(
			page.locator("button").filter({ hasText: "System" }).first()
		).toBeVisible({ timeout: 10_000 });

		// Should also show the project name
		await expect(
			page.locator("button").filter({ hasText: "Scope UI Project" }).first()
		).toBeVisible({ timeout: 5_000 });
	});

	test("origin badges are visible on roles page", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/roles");

		// Wait for roles list to render
		await expect(
			page.locator(".config-origin-badge").first()
		).toBeVisible({ timeout: 10_000 });

		// Verify the badge contains a known origin value
		const badgeText = await page.locator(".config-origin-badge").first().textContent();
		expect(["builtin", "server", "project"]).toContain(badgeText?.trim());
	});

	test("switching to project scope reloads the list", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/roles");

		// Wait for initial load
		await expect(
			page.locator(".config-origin-badge").first()
		).toBeVisible({ timeout: 10_000 });

		// Click the project scope tab
		const projectTab = page.locator("button").filter({ hasText: "Scope UI Project" }).first();
		await projectTab.click();

		// After switching, badges should still be visible (inherited items)
		await expect(
			page.locator(".config-origin-badge").first()
		).toBeVisible({ timeout: 10_000 });

		// Switch back to System
		const systemTab = page.locator("button").filter({ hasText: "System" }).first();
		await systemTab.click();

		await expect(
			page.locator(".config-origin-badge").first()
		).toBeVisible({ timeout: 10_000 });
	});

	test("workflows page hides System tab and shows project tabs only", async ({ page }) => {
		// Workflows are project-scoped only — the workflow-page omits the
		// System tab (see config-scope.ts::renderConfigScopeRow excludeSystem).
		// #/workflows now redirects synchronously to
		// #/settings/<projectId>/workflows, so the workflow-page renders
		// embedded inside the Settings page. The Settings page has its own
		// top-level "System" tab strip — we scope the assertion to the
		// embedded workflows-tab content, not the whole page.
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/workflows"; });
		await page.waitForFunction(
			() => window.location.hash.includes("settings") && window.location.hash.includes("workflows"),
			{ timeout: 10_000 },
		);

		const tab = page.locator("[data-testid='workflows-tab']").first();
		await expect(tab).toBeVisible({ timeout: 10_000 });

		// No "System" button inside the workflows tab itself (embedded mode
		// skips renderConfigScopeRow entirely; this guards against regressions
		// that re-introduce a system scope tab inside the workflow page).
		const systemTabs = await tab.locator("button").filter({ hasText: /^System$/ }).count();
		expect(systemTabs).toBe(0);
	});

	test("tools page shows scope row", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/tools");

		// Verify scope row is visible
		await expect(
			page.locator("button").filter({ hasText: "System" }).first()
		).toBeVisible({ timeout: 10_000 });

		// Verify tool groups loaded (at least one group header visible)
		await expect(
			page.locator(".tool-group-header").first()
		).toBeVisible({ timeout: 10_000 });

		// Click a tool group to expand it and reveal tool rows with badges
		await page.locator(".tool-group-header").first().click();
		await expect(
			page.locator(".tool-row").first()
		).toBeVisible({ timeout: 5_000 });
	});
});
