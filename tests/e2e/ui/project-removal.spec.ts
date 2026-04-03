/**
 * E2E tests: Remove Project button in per-project settings.
 *
 * Tests that a non-default project can be removed via the settings page,
 * and that the default project does NOT show a remove button.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let _counter = 0;

/** Create a unique temp dir so each project gets its own rootPath. */
function uniqueProjectDir(): string {
	const dir = join(tmpdir(), `bobbit-e2e-removal-${process.env.E2E_PORT}-${Date.now()}-${++_counter}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Create a project via REST and return its id + name. */
async function createProject(name: string): Promise<{ id: string; name: string }> {
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath: uniqueProjectDir() }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return { id: data.id, name };
}

test.describe("Remove Project button", () => {

	test("can remove a non-default project from settings", async ({ page }) => {
		const project = await createProject("Removable Project");

		await openApp(page);
		await navigateToHash(page, `#/settings/${project.id}/general`);

		// Verify the Remove Project button is visible
		const removeBtn = page.getByRole("button", { name: "Remove Project" });
		await expect(removeBtn).toBeVisible({ timeout: 5_000 });

		// Set up dialog handler BEFORE clicking
		page.on("dialog", (dialog) => dialog.accept());

		// Click the remove button
		await removeBtn.click();

		// Should navigate to system settings
		await expect(page).toHaveURL(/#.*settings.*system/, { timeout: 5_000 });

		// Project should be gone from the API
		const projectsRes = await apiFetch("/api/projects");
		const projects = await projectsRes.json();
		expect(projects.find((p: any) => p.id === project.id)).toBeUndefined();

		// Project name should not appear in the sidebar
		await expect(page.getByText("Removable Project")).not.toBeVisible({ timeout: 3_000 });
	});

	test("default project does not show Remove Project button", async ({ page }) => {
		// Get the default project (first in the list)
		const res = await apiFetch("/api/projects");
		const projects = await res.json();
		const defaultProject = projects[0];
		expect(defaultProject).toBeDefined();

		await openApp(page);
		await navigateToHash(page, `#/settings/${defaultProject.id}/general`);

		// Wait for settings content to load
		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });

		// Remove button should NOT be present for the default project
		const removeBtn = page.getByRole("button", { name: "Remove Project" });
		await expect(removeBtn).not.toBeVisible();
	});
});
