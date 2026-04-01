/**
 * E2E tests: Project Management (Journey 1)
 *
 * Tests adding a project via API and verifying it appears in the sidebar,
 * switching between projects, and opening project settings via the gear icon.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, nonGitCwd } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let _projCounter = 0;

/** Create a unique temp dir for a project (each needs its own rootPath). */
function uniqueProjectDir(): string {
	const dir = join(tmpdir(), `bobbit-e2e-proj-${process.env.E2E_PORT}-${Date.now()}-${++_projCounter}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Create a project via REST and return its ID. */
async function createProject(name: string): Promise<string> {
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath: uniqueProjectDir() }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return data.id;
}

/** Delete a project (best-effort cleanup). */
async function deleteProject(id: string): Promise<void> {
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
}

test.describe("Project management (UI)", () => {
	const projectIds: string[] = [];

	test.afterAll(async () => {
		for (const id of projectIds) {
			await deleteProject(id);
		}
	});

	test("add project via API and verify in sidebar", async ({ page }) => {
		const projectId = await createProject("Test Proj");
		projectIds.push(projectId);

		await openApp(page);

		// The sidebar should show the project name
		await expect(
			page.getByText("Test Proj").first(),
		).toBeVisible({ timeout: 10_000 });
	});

	test("switch between projects", async ({ page }) => {
		const idAlpha = await createProject("Project Alpha");
		const idBeta = await createProject("Project Beta");
		projectIds.push(idAlpha, idBeta);

		await openApp(page);

		// Both projects should be visible in the sidebar
		await expect(page.getByText("Project Alpha").first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("Project Beta").first()).toBeVisible({ timeout: 10_000 });

		// Click Project Alpha — it should be present and interactable
		await page.getByText("Project Alpha").first().click();

		// Click Project Beta
		await page.getByText("Project Beta").first().click();

		// Both project sections should still be visible (multi-project mode shows all)
		await expect(page.getByText("Project Alpha").first()).toBeVisible();
		await expect(page.getByText("Project Beta").first()).toBeVisible();
	});

	test("open project settings via gear icon", async ({ page }) => {
		const projectId = await createProject("Gear Test Proj");
		projectIds.push(projectId);

		await openApp(page);

		// Wait for the project to appear in the sidebar
		await expect(page.getByText("Gear Test Proj").first()).toBeVisible({ timeout: 10_000 });

		// The gear icon is a button with title="Project settings" near the project name
		// It uses opacity-0 group-hover:opacity-100, so we hover the parent group first
		const projectText = page.getByText("Gear Test Proj").first();
		// Hover the group container (parent of the text and button)
		const groupContainer = projectText.locator("xpath=ancestor::div[contains(@class,'group')]").first();
		await groupContainer.hover();

		// Click the settings button — it has title="Project settings"
		const gearBtn = groupContainer.locator("button[title='Project settings']");
		await expect(gearBtn).toBeVisible({ timeout: 5_000 });
		await gearBtn.click();

		// Verify the URL navigated to settings with the project ID
		// The sidebar sets route to `settings/${projectId}/project`
		await page.waitForFunction(
			(id) => window.location.hash.includes(id) && window.location.hash.includes("settings"),
			projectId,
			{ timeout: 5_000 },
		);
	});
});
