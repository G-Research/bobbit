/**
 * Add Project flow E2E tests — smart path-first dialog.
 * Tests the new path-only dialog, directory detection/auto-import,
 * browse UI, and project assistant session creation.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { ADD_PROJECT } from "./add-project-helpers.js";
import { existsSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Create a unique temp dir for each test to avoid conflicts. */
function uniqueDir(label: string): string {
	const dir = join(tmpdir(), `bobbit-e2e-addproj-${label}-${process.env.E2E_PORT}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	// Canonicalize: tmpdir() is a /var/folders symlink on macOS. Returning the
	// canonical path keeps test comparisons (p.rootPath === dir) consistent
	// with what the registry stores after the UI's acceptCanonical resubmit.
	return realpathSync(dir);
}

const createDirectoryButton = (page: Page) => page.locator("button").filter({ has: page.locator(ADD_PROJECT.createDirectory) }).first();

test.describe("Add Project flow (UI)", () => {
	// Tests in this spec create projects (provisional + promoted) that persist
	// in the worker's project registry. Without cleanup they leak into
	// downstream specs — the goal-form-tooltips spec, in particular, expects
	// exactly one registered project so its New-Goal button opens the goal
	// form directly rather than a project-picker dialog (PR #380 already hit
	// this once via per-project-config-dirs leaking; this spec leaked too).
	test.afterEach(async () => {
		const res = await apiFetch("/api/projects");
		const data = await res.json();
		const projects = data.projects || data || [];
		for (const p of projects) {
			if (p.name === "default") continue;
			// Some leaked projects are provisional (assistant sessions); some
			// are promoted. Plain DELETE works for any project, including the
			// last visible one.
			await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("path-only dialog and directory browser render without legacy fields", async ({ page }) => {
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

		// Directory browser opens, Select current closes it, and the chosen path is copied back.
		await page.locator('[data-testid="directory-picker-browse"]').click();
		await expect(page.locator('[data-testid="add-project-browse-dialog"]')).toBeVisible({ timeout: 5_000 });
		const selectBtn = page.locator("button").filter({ hasText: "Select current" }).first();
		await expect(selectBtn).toBeVisible();
		// Wait for the initial browse to populate so `current` is non-empty (Select current is
		// disabled while the modal is still showing "Loading…").
		await expect(selectBtn).toBeEnabled({ timeout: 5_000 });
		await selectBtn.click();
		await expect(page.locator('[data-testid="add-project-browse-dialog"]')).not.toBeVisible({ timeout: 5_000 });
		await expect(pathInput).toBeVisible();
		expect((await pathInput.inputValue()).length).toBeGreaterThan(0);
	});

	test("auto-import project with existing .bobbit directory", async ({ page }) => {
		// Create a temp dir with .bobbit/config/project.yaml — required for
		// hasBobbit=true since commit 54d5b710 (project.yaml is now the source
		// of truth, not the bare .bobbit/ directory).
		const dir = uniqueDir("bobbit-import");
		mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
		mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
		writeFileSync(join(dir, ".bobbit", "config", "project.yaml"), "name: test\n");
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


	test("creates a typed nonexistent directory and continues to scaffolding assistant", async ({ page }) => {
		const parent = uniqueDir("create-parent");
		const target = join(parent, "new-project");

		try {
			await openApp(page);
			await page.locator("button").filter({ hasText: "Add Project" }).first().click();
			const pathInput = page.locator('input[placeholder="/path/to/project"]');
			await expect(pathInput).toBeVisible({ timeout: 5_000 });
			await pathInput.fill(target);

			const createButton = createDirectoryButton(page);
			await expect(createButton).toBeVisible({ timeout: 10_000 });
			await expect(createButton).toBeEnabled();
			await createButton.click();

			await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible();
			await expect(pathInput).toHaveValue(target);
			expect(existsSync(target)).toBe(true);
			await expect(createButton).not.toBeVisible({ timeout: 10_000 });
			const continueButton = page.locator("button").filter({ has: page.locator(ADD_PROJECT.continue) }).first();
			await expect(continueButton).toBeEnabled({ timeout: 10_000 });

			const sessionPost = page.waitForResponse((resp) => {
				if (!resp.url().includes("/api/sessions") || resp.request().method() !== "POST") return false;
				try {
					const body = resp.request().postDataJSON?.() ?? JSON.parse(resp.request().postData() || "{}");
					return body?.assistantType === "project-scaffolding" && body?.cwd === target;
				} catch {
					return false;
				}
			});
			await continueButton.click();
			await sessionPost;
			await expect(pathInput).not.toBeVisible({ timeout: 10_000 });

			await page.reload();
			await expect(page.locator(ADD_PROJECT.dialog)).not.toBeVisible({ timeout: 5_000 });
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("already-existing create response refreshes detection so continue can be used", async ({ page }) => {
		const parent = uniqueDir("create-already-exists");
		const target = join(parent, "existing-project");
		const createRoute = "**/api/create-directory";

		try {
			await openApp(page);
			await page.locator("button").filter({ hasText: "Add Project" }).first().click();
			const pathInput = page.locator('input[placeholder="/path/to/project"]');
			await expect(pathInput).toBeVisible({ timeout: 5_000 });
			await pathInput.fill(target);

			const createButton = createDirectoryButton(page);
			await expect(createButton).toBeVisible({ timeout: 10_000 });
			await page.route(createRoute, async (route) => {
				if (route.request().method() !== "POST") return route.fallback();
				mkdirSync(target, { recursive: true });
				await route.fulfill({
					status: 409,
					contentType: "application/json",
					body: JSON.stringify({ error: "Already exists", code: "already_exists" }),
				});
			});
			await createButton.click();

			await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible();
			expect(existsSync(target)).toBe(true);
			await expect(createButton).not.toBeVisible({ timeout: 10_000 });
			await expect(page.locator(ADD_PROJECT.createError)).toHaveCount(0);
			await expect(page.locator("button").filter({ has: page.locator(ADD_PROJECT.continue) }).first()).toBeEnabled({ timeout: 10_000 });
		} finally {
			await page.unroute(createRoute).catch(() => {});
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("create directory surfaces routed server errors without closing the dialog", async ({ page }) => {
		const parent = uniqueDir("create-routed-errors");
		const deniedTarget = join(parent, "permission-denied");
		const failedTarget = join(parent, "create-failed");
		const routePath = "**/api/create-directory";
		const responses = new Map([
			[deniedTarget, { status: 403, error: "Permission denied", code: "permission_denied", message: "Permission denied creating this directory." }],
			[failedTarget, { status: 500, error: "Disk exploded", code: "create_failed", message: "Could not create directory: Disk exploded" }],
		]);

		try {
			await page.route(routePath, async (route) => {
				if (route.request().method() !== "POST") return route.fallback();
				let requestedPath = "";
				try {
					requestedPath = JSON.parse(route.request().postData() || "{}").path || "";
				} catch {
					requestedPath = "";
				}
				const response = responses.get(requestedPath);
				if (!response) return route.fallback();
				await route.fulfill({
					status: response.status,
					contentType: "application/json",
					body: JSON.stringify({ error: response.error, code: response.code }),
				});
			});

			await openApp(page);
			await page.locator("button").filter({ hasText: "Add Project" }).first().click();
			const pathInput = page.locator('input[placeholder="/path/to/project"]');
			await expect(pathInput).toBeVisible({ timeout: 5_000 });
			const createButton = createDirectoryButton(page);

			for (const [value, { message }] of responses) {
				await pathInput.fill(value);
				await expect(createButton).toBeVisible({ timeout: 10_000 });
				await expect(createButton).toBeEnabled();
				await createButton.click();
				await expect(page.locator(ADD_PROJECT.createError)).toHaveText(message, { timeout: 5_000 });
				await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible();
			}
		} finally {
			await page.unroute(routePath).catch(() => {});
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("create directory surfaces structured errors without closing the dialog", async ({ page }) => {
		const parent = uniqueDir("create-errors");
		const fileTarget = join(parent, "file-target");
		writeFileSync(fileTarget, "not a directory");
		const missingParentTarget = join(parent, "missing-parent", "child");

		try {
			await openApp(page);
			await page.locator("button").filter({ hasText: "Add Project" }).first().click();
			const pathInput = page.locator('input[placeholder="/path/to/project"]');
			await expect(pathInput).toBeVisible({ timeout: 5_000 });
			const createButton = createDirectoryButton(page);

			for (const { value, message } of [
				{ value: "relative-project", message: "Enter an absolute directory path." },
				{ value: missingParentTarget, message: "The parent directory does not exist." },
				{ value: fileTarget, message: "A file already exists at that path." },
			]) {
				await pathInput.fill(value);
				await expect(createButton).toBeVisible({ timeout: 10_000 });
				await expect(createButton).toBeEnabled();
				await createButton.click();
				await expect(page.locator(ADD_PROJECT.createError)).toHaveText(message, { timeout: 5_000 });
				await expect(page.locator(ADD_PROJECT.dialog)).toBeVisible();
			}
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
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
