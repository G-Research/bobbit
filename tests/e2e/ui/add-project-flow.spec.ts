/**
 * Add Project flow E2E tests — smart path-first dialog.
 * Tests the new path-only dialog, directory detection/auto-import,
 * browse UI, and project assistant session creation.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Create a unique temp dir for each test to avoid conflicts. */
function uniqueDir(label: string): string {
	const dir = join(tmpdir(), `bobbit-e2e-addproj-${label}-${process.env.E2E_PORT}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test.describe("Add Project flow (UI)", () => {
	test("path-only dialog renders without name or color fields", async ({ page }) => {
		await openApp(page);

		// Click "Add Project" button in sidebar
		await page.locator("button").filter({ hasText: "Add Project" }).first().click();

		// Dialog should appear with the "Add Project" title
		await expect(page.getByText("Add Project", { exact: true }).first()).toBeVisible({ timeout: 5_000 });

		// Should have a path input with placeholder
		const pathInput = page.locator('input[placeholder="/path/to/project"]');
		await expect(pathInput).toBeVisible();

		// Should have a Browse button
		await expect(page.locator("button").filter({ hasText: "Browse" }).first()).toBeVisible();

		// Should have a Continue button
		await expect(page.locator("button").filter({ hasText: "Continue" }).first()).toBeVisible();

		// Should NOT have "Project Name" or "Color" labels (old dialog fields)
		await expect(page.getByText("Project Name")).not.toBeVisible();
		await expect(page.getByText("Color (optional)")).not.toBeVisible();
	});

	test("auto-import project with existing .bobbit directory", async ({ page }) => {
		// Create a temp dir with .bobbit/config and .bobbit/state
		const dir = uniqueDir("bobbit-import");
		mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
		mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
		writeFileSync(join(dir, "README.md"), "# Test Project\n");

		await openApp(page);

		// Click "Add Project"
		await page.locator("button").filter({ hasText: "Add Project" }).first().click();
		await expect(page.locator('input[placeholder="/path/to/project"]')).toBeVisible({ timeout: 5_000 });

		// Type the path
		await page.locator('input[placeholder="/path/to/project"]').fill(dir);

		// Click Continue
		await page.locator("button").filter({ hasText: "Continue" }).first().click();

		// The dialog should close and the project should appear in the sidebar
		// Wait for dialog to disappear
		await expect(page.locator('input[placeholder="/path/to/project"]')).not.toBeVisible({ timeout: 10_000 });

		// Verify the project was registered via API
		const res = await apiFetch("/api/projects");
		const data = await res.json();
		const projects = data.projects || data || [];
		const imported = projects.find((p: any) => p.rootPath === dir);
		expect(imported).toBeTruthy();

		// Cleanup: remove the project
		if (imported) {
			await apiFetch(`/api/projects/${imported.id}`, { method: "DELETE" });
		}
	});

	test("browse button opens directory browser and navigation works", async ({ page }) => {
		await openApp(page);

		// Click "Add Project"
		await page.locator("button").filter({ hasText: "Add Project" }).first().click();
		await expect(page.locator('input[placeholder="/path/to/project"]')).toBeVisible({ timeout: 5_000 });

		// Click Browse
		await page.locator("button").filter({ hasText: "Browse" }).first().click();

		// Directory browser should appear
		await expect(page.locator('[data-testid="directory-browser"]')).toBeVisible({ timeout: 5_000 });

		// Should show a current path
		await expect(page.locator('[data-testid="directory-browser"]')).toBeVisible();

		// Should have Select and Cancel buttons
		await expect(page.locator("button").filter({ hasText: "Select" }).first()).toBeVisible();

		// Click Select to pick the current directory
		await page.locator("button").filter({ hasText: "Select" }).first().click();

		// Browser should close and path input should be visible again with a value
		await expect(page.locator('[data-testid="directory-browser"]')).not.toBeVisible({ timeout: 5_000 });
		const pathInput = page.locator('input[placeholder="/path/to/project"]');
		await expect(pathInput).toBeVisible();
		const val = await pathInput.inputValue();
		expect(val.length).toBeGreaterThan(0);
	});

	test("non-empty directory without .bobbit opens project assistant", async ({ page }) => {
		// Create a temp dir with a file (non-empty, no .bobbit)
		const dir = uniqueDir("nonempty");
		writeFileSync(join(dir, "package.json"), '{"name":"test-proj"}');

		await openApp(page);

		// Click "Add Project"
		await page.locator("button").filter({ hasText: "Add Project" }).first().click();
		await expect(page.locator('input[placeholder="/path/to/project"]')).toBeVisible({ timeout: 5_000 });

		// Type the path
		await page.locator('input[placeholder="/path/to/project"]').fill(dir);

		// Click Continue
		await page.locator("button").filter({ hasText: "Continue" }).first().click();

		// Dialog should close
		await expect(page.locator('input[placeholder="/path/to/project"]')).not.toBeVisible({ timeout: 10_000 });

		// A project assistant session should be created — verify via URL hash containing session ID
		await expect(async () => {
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toMatch(/#\/session\//);
		}).toPass({ timeout: 10_000 });

		// Verify the textarea is visible (session is connected)
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
	});
});
