/**
 * E2E tests for per-project Config Directories.
 *
 * Verifies that:
 * 1. Registering a project and navigating to its Config Directories tab
 *    shows the full directory editor (not a placeholder).
 * 2. Adding a custom directory via the UI persists to the project-scoped API.
 * 3. Project-scoped custom dirs do NOT leak into system-level config dirs.
 */
import { test, expect } from "./gateway-harness.js";
import { apiFetch, readE2EToken, nonGitCwd } from "./e2e-setup.js";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/** Register a project via the REST API and return its id + rootPath.
 *
 * Uses `upsert: true` so Playwright test retries (which re-run beforeAll on
 * the same worker) don't collide with the project already registered at the
 * memoized nonGitCwd() path from the first attempt — the server would
 * otherwise return 400 "already registered" and fail the retry too.
 */
async function registerProject(name: string): Promise<{ id: string; rootPath: string }> {
	const rootPath = nonGitCwd(); // temp dir outside any git repo
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath, upsert: true }),
	});
	expect([200, 201]).toContain(resp.status);
	const project = await resp.json();
	expect(project.id).toBeTruthy();
	return { id: project.id, rootPath };
}

/** Open the app authenticated via token query param. */
async function openApp(page: Page, hash?: string): Promise<void> {
	const token = readE2EToken();
	const base = `http://127.0.0.1:${process.env.E2E_PORT}`;
	// First load the app root and wait for it to be fully interactive
	// (projects list must be loaded before navigating to project-scoped settings)
	await page.goto(`${base}/?token=${encodeURIComponent(token)}`);
	await expect(
		page.getByRole("button", { name: "Settings", exact: true }),
	).toBeVisible({ timeout: 15_000 });
	// Now navigate to the desired hash route
	if (hash) {
		await page.evaluate((h) => { window.location.hash = h; }, hash);
	}
}

test.describe("Per-project Config Directories", () => {
	let projectId: string;

	test.beforeAll(async () => {
		const project = await registerProject(`e2e-config-dirs-${Date.now()}`);
		projectId = project.id;
	});

	// Project cleanup is REQUIRED. Without this, the registered project leaks
	// across the worker for the rest of the run, polluting downstream tests
	// that assume a single-project state (e.g. the goal-form-tooltips spec
	// reads `projects[0]` and the `startNewGoalFlow` button switches from
	// auto-open to picker-popover when there's >1 project, breaking tests
	// that don't handle the picker). Use `?force=1` because the test gateway
	// runs with BOBBIT_E2E=1 which permits removing the last project.
	test.afterAll(async () => {
		if (projectId) {
			await apiFetch(`/api/projects/${projectId}?force=1`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("project settings shows directory editor, not placeholder", async ({ page }) => {
		await openApp(page, `/settings/${projectId}/directories`);

		// The directory editor shows "Add Custom Path" heading and category headings.
		// A placeholder would show "inherits from System" text instead.
		await expect(
			page.getByText("Add Custom Path"),
		).toBeVisible({ timeout: 15_000 });

		// Also verify category headings from the real editor
		await expect(page.getByText("Skills").first()).toBeVisible();
		await expect(page.getByText("MCP").first()).toBeVisible();

		// The placeholder text should NOT be present
		await expect(
			page.getByText("inherits from System"),
		).not.toBeVisible();
	});

	test("add custom directory via UI and verify via API", async ({ page }) => {
		await openApp(page, `/settings/${projectId}/directories`);

		// Wait for the editor to load
		await expect(
			page.getByText("Add Custom Path"),
		).toBeVisible({ timeout: 15_000 });

		const customPath = `e2e-custom-dir-${Date.now()}`;
		// Server resolves relative paths via path.resolve()
		const resolvedCustomPath = resolve(customPath);

		// Type the custom directory path
		const pathInput = page.locator("input[type='text'][placeholder*='my-config-dir'], input[type='text'][placeholder*='path']");
		await pathInput.fill(customPath);

		// Check the "Skills" checkbox
		const skillsCheckbox = page.locator("label").filter({ hasText: "Skills" }).locator("input[type='checkbox']");
		await skillsCheckbox.check();

		// Click Add (exact match to avoid "Add Project" button)
		const addButton = page.getByRole("button", { name: "Add", exact: true });
		await addButton.click();

		// Wait for "Saved successfully" confirmation
		await expect(
			page.getByText("Saved successfully"),
		).toBeVisible({ timeout: 10_000 });

		// Verify via API: project-scoped config dirs should include the custom path
		const projectDirsResp = await apiFetch(`/api/config-directories?projectId=${projectId}`);
		expect(projectDirsResp.status).toBe(200);
		const projectDirs = await projectDirsResp.json();
		const customEntry = projectDirs.find((d: any) => d.path === resolvedCustomPath);
		expect(customEntry, `Expected custom dir '${resolvedCustomPath}' in project config dirs`).toBeTruthy();
		expect(customEntry.types).toContain("skills");

		// Verify system-level config dirs do NOT contain the custom path
		const systemDirsResp = await apiFetch("/api/config-directories");
		expect(systemDirsResp.status).toBe(200);
		const systemDirs = await systemDirsResp.json();
		const leaked = systemDirs.find((d: any) => d.path === resolvedCustomPath);
		expect(leaked, `Custom dir '${resolvedCustomPath}' should NOT appear in system config dirs`).toBeFalsy();
	});

	test("add custom directory persists across page reload and writes native YAML on disk", async ({ page }) => {
		// Reviewer-required: spec says config_directories must have reload-persistence
		// and on-disk native-YAML coverage.
		await openApp(page, `/settings/${projectId}/directories`);
		await expect(page.getByText("Add Custom Path")).toBeVisible({ timeout: 15_000 });

		const customPath = `e2e-reload-${Date.now()}`;
		const resolvedCustomPath = resolve(customPath);

		const pathInput = page.locator("input[type='text'][placeholder*='my-config-dir'], input[type='text'][placeholder*='path']");
		await pathInput.fill(customPath);
		const skillsCheckbox = page.locator("label").filter({ hasText: "Skills" }).locator("input[type='checkbox']");
		await skillsCheckbox.check();
		await page.getByRole("button", { name: "Add", exact: true }).click();
		await expect(page.getByText("Saved successfully")).toBeVisible({ timeout: 10_000 });

		// Reload — change must still be visible in the UI after a hard refresh.
		await page.reload();
		await expect(page.getByText("Add Custom Path")).toBeVisible({ timeout: 15_000 });
		await expect(page.locator("code", { hasText: resolvedCustomPath })).toBeVisible({ timeout: 10_000 });

		// Disk assertion: project.yaml uses native YAML (no escaped JSON).
		const rootPath = nonGitCwd();
		const yamlPath = join(rootPath, ".bobbit", "config", "project.yaml");
		const yamlText = readFileSync(yamlPath, "utf-8");
		expect(yamlText, "config_directories must be a real YAML list, not an escaped JSON string")
			.toMatch(/config_directories:\s*(\n|$)/);
		// No JSON.stringify-style payload like: config_directories: '[{"path":...
		expect(yamlText).not.toMatch(/config_directories:\s*['"]\[/);
		// No backslash-escaped JSON quotes.
		expect(yamlText).not.toMatch(/\\"path\\"/);
		// The path appears under it as a native YAML scalar (server stores
		// the relative path as-typed; the API layer resolves on read).
		expect(yamlText).toMatch(new RegExp(`path:\\s+${customPath}\\b`));

		// Cleanup: remove the entry via the UI. Walk up to the closest row
		// container (a flex row containing both the path code element and its
		// Remove button) and click that row's Remove button.
		const pathCode = page.locator("code", { hasText: resolvedCustomPath }).first();
		const removeBtn = pathCode.locator("xpath=ancestor::div[contains(@class,'flex')][1]").locator("button[title='Remove directory']");
		await removeBtn.click();
		await expect(page.getByText("Saved successfully")).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("code", { hasText: resolvedCustomPath })).not.toBeVisible({ timeout: 5_000 });
	});

	test("project config dirs API endpoint stores data correctly", async () => {
		// Direct API test: PUT config_directories to the project endpoint and verify
		const skillsPath = `api-test-skills-${Date.now()}`;
		const mcpPath = `api-test-mcp-${Date.now()}`;
		const customDirs = [
			{ path: skillsPath, types: ["skills"] },
			{ path: mcpPath, types: ["mcp", "tools"] },
		];

		// Native-YAML migration: server now rejects JSON-string payloads for
		// `config_directories`; send the structured array directly.
		const putResp = await apiFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({
				config_directories: customDirs,
				skill_directories: null,
			}),
		});
		expect(putResp.status).toBe(200);

		// The server resolves relative paths via path.resolve(), so match on the resolved value
		const resolvedSkills = resolve(skillsPath);
		const resolvedMcp = resolve(mcpPath);

		// Verify via GET config-directories with projectId
		const getDirsResp = await apiFetch(`/api/config-directories?projectId=${projectId}`);
		expect(getDirsResp.status).toBe(200);
		const dirs = await getDirsResp.json();

		const skillsDir = dirs.find((d: any) => d.path === resolvedSkills);
		expect(skillsDir, `Expected '${resolvedSkills}' in project dirs`).toBeTruthy();
		expect(skillsDir.types).toContain("skills");

		const mcpToolsDir = dirs.find((d: any) => d.path === resolvedMcp);
		expect(mcpToolsDir, `Expected '${resolvedMcp}' in project dirs`).toBeTruthy();
		expect(mcpToolsDir.types).toContain("mcp");
		expect(mcpToolsDir.types).toContain("tools");

		// Verify system is unaffected
		const sysResp = await apiFetch("/api/config-directories");
		const sysDirs = await sysResp.json();
		expect(sysDirs.find((d: any) => d.path === resolvedSkills)).toBeFalsy();
		expect(sysDirs.find((d: any) => d.path === resolvedMcp)).toBeFalsy();
	});
});
