/**
 * Project Management browser coverage.
 * API-only registry add/remove checks live in tests/e2e/project-ui-api.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, registerProject } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

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
	const project = await registerProject({
		name,
		rootPath: uniqueProjectDir(),
		seedWorkflows: false,
	});
	return project.id;
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

	test("renders API-created projects, switches rows, and opens project settings", async ({ page }) => {
		const idAlpha = await createProject("Project Alpha");
		projectIds.push(idAlpha);
		const idBeta = await createProject("Project Beta");
		projectIds.push(idBeta);

		await openApp(page);

		const alpha = page.getByText("Project Alpha").first();
		const beta = page.getByText("Project Beta").first();
		await expect(alpha).toBeVisible({ timeout: 10_000 });
		await expect(beta).toBeVisible({ timeout: 10_000 });

		// Project rows stay interactable in multi-project mode.
		await alpha.click();
		await beta.click();
		await expect(alpha).toBeVisible();
		await expect(beta).toBeVisible();

		// The gear icon is a button with title="Project settings" near the project name.
		const groupContainer = beta.locator("xpath=ancestor::div[contains(@class,'group')]").first();
		await groupContainer.hover();
		const gearBtn = groupContainer.locator("button[title='Project settings']");
		await expect(gearBtn).toBeVisible({ timeout: 5_000 });
		await gearBtn.click();

		await page.waitForFunction(
			(id) => window.location.hash.includes(id) && window.location.hash.includes("settings"),
			idBeta,
			{ timeout: 5_000 },
		);
	});
});
