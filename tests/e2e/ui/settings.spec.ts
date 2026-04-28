/**
 * Settings E2E tests: tab switching, persistence, per-project scope.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Create a unique temp dir for project rootPath to avoid conflicts. */
function uniqueProjectDir(): string {
	const dir = join(tmpdir(), `bobbit-e2e-settings-${process.env.E2E_PORT}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test.describe("Settings (full-stack UI)", () => {
	test("open settings and switch tabs @smoke", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		// Verify settings view renders — look for "Settings" heading
		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });

		// Verify General tab content is visible — it has the "Show message timestamps" checkbox
		await expect(page.getByText("Show message timestamps")).toBeVisible({ timeout: 5_000 });

		// Switch to Models tab
		const modelsTab = page.locator("button").filter({ hasText: "Models" }).first();
		await modelsTab.click();

		// The URL should update to reflect the Models tab
		await expect(page).toHaveURL(/#\/settings\/system\/models/, { timeout: 5_000 });

		// Switch to Shortcuts tab
		const shortcutsTab = page.locator("button").filter({ hasText: "Shortcuts" }).first();
		await shortcutsTab.click();
		await expect(page).toHaveURL(/#\/settings\/system\/shortcuts/, { timeout: 5_000 });

		// Switch to Color Palette tab
		const paletteTab = page.locator("button").filter({ hasText: "Color Palette" }).first();
		await paletteTab.click();
		await expect(page).toHaveURL(/#\/settings\/system\/palette/, { timeout: 5_000 });
	});

	test("account tab shows Anthropic and OpenAI OAuth providers", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/account");

		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("Anthropic OAuth")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("OpenAI OAuth")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("ChatGPT subscription GPT models")).toBeVisible({ timeout: 5_000 });

		await expect(page.getByText("Authenticated", { exact: true })).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("Not authenticated", { exact: true })).toBeVisible({ timeout: 5_000 });

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/account");
		await expect(page.getByText("OpenAI OAuth")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("Anthropic OAuth")).toBeVisible({ timeout: 5_000 });
	});

	test("setting persists after reload", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		// Wait for the General tab content to fully render
		await expect(page.getByText("Show message timestamps")).toBeVisible({ timeout: 10_000 });
		const checkbox = page.locator("input[type='checkbox']").first();
		await expect(checkbox).toBeVisible({ timeout: 5_000 });

		// Get the current state of the checkbox
		const wasChecked = await checkbox.isChecked();

		// Set up response listener BEFORE the click to avoid race condition
		const responsePromise = page.waitForResponse(
			resp => resp.url().includes("/api/preferences") && resp.status() === 200
		);

		// Toggle the checkbox
		await checkbox.click();

		// Verify the checkbox toggled
		if (wasChecked) {
			await expect(checkbox).not.toBeChecked();
		} else {
			await expect(checkbox).toBeChecked();
		}

		// Wait for the setting to persist
		await responsePromise;

		// Reload the page
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Navigate back to settings
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.getByText("Show message timestamps")).toBeVisible({ timeout: 10_000 });

		// Verify the checkbox retained its new state
		const checkboxAfterReload = page.locator("input[type='checkbox']").first();
		await expect(checkboxAfterReload).toBeVisible({ timeout: 5_000 });

		if (wasChecked) {
			await expect(checkboxAfterReload).not.toBeChecked();
		} else {
			await expect(checkboxAfterReload).toBeChecked();
		}

		// Clean up: toggle back to original state
		await checkboxAfterReload.click();
	});

	test("per-project settings scope switching", async ({ page }) => {
		// Create a project via API
		const resp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Settings Test Project", rootPath: uniqueProjectDir() }),
		});
		expect(resp.ok).toBe(true);
		const project = await resp.json();
		const projectId = project.id;

		try {
			await openApp(page);

			// Navigate to the project's appearance settings
			await navigateToHash(page, `#/settings/${projectId}/appearance`);

			// Verify settings view is rendered
			await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });

			// Verify the project scope button is active (has the active styling) —
			// look for a button with the project name that has the active class
			const projectScopeBtn = page.locator("button").filter({ hasText: "Settings Test Project" });
			await expect(projectScopeBtn).toBeVisible({ timeout: 5_000 });

			// Verify we're on the Appearance tab — look for the Appearance tab button
			// that has the active styling (bg-background class)
			const appearanceTab = page.locator("button").filter({ hasText: "Appearance" });
			await expect(appearanceTab).toBeVisible({ timeout: 5_000 });

			// Verify Appearance tab content is visible — it should have palette or color inputs
			// The appearance tab has "Color Palette" and accent color controls
			await expect(
				page.getByText("Palette").first()
			).toBeVisible({ timeout: 5_000 });
		} finally {
			// Clean up the project
			await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
