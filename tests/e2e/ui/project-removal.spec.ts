/**
 * E2E tests: Remove Project button in per-project settings.
 *
 * Every project (including the first/"default" one) shows a Remove Project
 * button. Verified more directly by `remove-first-project.spec.ts`; this
 * spec covers the happy-path removal flow.
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
		await expect(removeBtn).toBeVisible({ timeout: 15_000 });

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
		const sidebar = page.locator(".sidebar-edge").first();
		await expect(sidebar.getByText("Removable Project")).not.toBeVisible({ timeout: 3_000 });
	});

});
