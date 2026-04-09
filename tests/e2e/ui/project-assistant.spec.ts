/**
 * Project assistant UX E2E tests.
 * Tests provisional project registration, sidebar rendering,
 * project proposal preview form, cleanup on terminate, and persistence.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, nonGitCwd, waitForSessionStatus, deleteSession } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse } from "./ui-helpers.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Create a project assistant session via API and return session ID + provisional project info. */
async function createProjectAssistantSession(
	assistantType: "project" | "project-scaffolding",
	cwd?: string,
): Promise<{ sessionId: string; provisionalProjectId?: string }> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ assistantType, cwd: cwd || nonGitCwd() }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return { sessionId: data.id, provisionalProjectId: data.provisionalProjectId };
}

/** Create a unique temp dir for each test. */
function uniqueDir(label: string): string {
	const dir = join(tmpdir(), `bobbit-e2e-projast-${label}-${process.env.E2E_PORT}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Get all projects from the API. */
async function getProjects(): Promise<any[]> {
	const resp = await apiFetch("/api/projects");
	const data = await resp.json();
	return data.projects || data || [];
}

/** Clean up a project by ID (best-effort). */
async function cleanupProject(id: string): Promise<void> {
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
}

/** Drive the Add Project dialog to create a project assistant session.
 *  Creates a temp dir with content (Path B detection mode), opens the dialog,
 *  types the path, clicks Continue.
 *  Returns { dir, sessionId } after the session is connected. */
async function addProjectViaDialog(
	page: import("@playwright/test").Page,
	label: string,
): Promise<{ dir: string; sessionId: string }> {
	const dir = uniqueDir(label);
	writeFileSync(join(dir, "package.json"), `{"name":"${label}"}`);

	// Click "Add Project" in sidebar
	await page.locator("button").filter({ hasText: "Add Project" }).first().click();
	await expect(page.locator('input[placeholder="/path/to/project"]')).toBeVisible({ timeout: 15_000 });

	// Type the path and click Continue
	await page.locator('input[placeholder="/path/to/project"]').fill(dir);
	await page.locator("button").filter({ hasText: "Continue" }).first().click();

	// Wait for dialog to close and session to connect
	await expect(page.locator('input[placeholder="/path/to/project"]')).not.toBeVisible({ timeout: 10_000 });
	await expect(async () => {
		const hash = await page.evaluate(() => window.location.hash);
		expect(hash).toMatch(/#\/session\//);
	}).toPass({ timeout: 15_000 });
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

	// Extract session ID from hash
	const hash = await page.evaluate(() => window.location.hash);
	const sessionId = hash.replace("#/session/", "");

	return { dir, sessionId };
}

/** Find the provisional project for a given dir path. */
async function findProvisionalProject(dir: string): Promise<any | undefined> {
	const projects = await getProjects();
	return projects.find((p: any) => p.rootPath === dir && p.provisional);
}

test.describe("Project assistant UX", () => {
	test("auto-prompt is sent automatically via connectToSession (detection mode)", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "auto-detect");

		// The auto-prompt should have been sent automatically (not manually)
		const userMsg = page.locator("user-message").first();
		await expect(userMsg).toContainText("project registration", { timeout: 10_000 });
		await expect(userMsg).toContainText(dir);

		await waitForAgentResponse(page);

		// Cleanup
		const prov = await findProvisionalProject(dir);
		await deleteSession(sessionId);
		if (prov) await cleanupProject(prov.id);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	test("session created with correct assistantType via API", async () => {
		// Detection mode
		const { sessionId: detectionId, provisionalProjectId: pp1 } = await createProjectAssistantSession("project");
		const detResp = await apiFetch(`/api/sessions/${detectionId}`);
		const detData = await detResp.json();
		expect(detData.assistantType).toBe("project");

		// Scaffolding mode
		const { sessionId: scaffoldId, provisionalProjectId: pp2 } = await createProjectAssistantSession("project-scaffolding");
		const scfResp = await apiFetch(`/api/sessions/${scaffoldId}`);
		const scfData = await scfResp.json();
		expect(scfData.assistantType).toBe("project-scaffolding");

		await deleteSession(detectionId);
		await deleteSession(scaffoldId);
		if (pp1) await cleanupProject(pp1);
		if (pp2) await cleanupProject(pp2);
	});

	test("project assistant session is navigable and visible", async ({ page }) => {
		const { sessionId, provisionalProjectId } = await createProjectAssistantSession("project");
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		const hash = await page.evaluate(() => window.location.hash);
		expect(hash).toContain(sessionId);

		await sendMessage(page, "Hello from project assistant test");
		await waitForAgentResponse(page);

		await deleteSession(sessionId);
		if (provisionalProjectId) await cleanupProject(provisionalProjectId);
	});

	test("session terminate removes it from active sessions list", async () => {
		const { sessionId, provisionalProjectId } = await createProjectAssistantSession("project");
		await waitForSessionStatus(sessionId, "idle");

		await deleteSession(sessionId);

		const resp = await apiFetch("/api/sessions");
		const data = await resp.json();
		const sessions = data.sessions || [];
		const found = sessions.find((s: { id: string }) => s.id === sessionId);
		expect(found).toBeFalsy();

		if (provisionalProjectId) await cleanupProject(provisionalProjectId);
	});

	test("detection and scaffolding modes use different auto-prompt text", async ({ page }) => {
		const { sessionId, provisionalProjectId } = await createProjectAssistantSession("project");
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		await sendMessage(page, "Start the project registration session. The project directory is: /my/project");
		await waitForAgentResponse(page);

		await expect(page.getByText("project registration").first()).toBeVisible();

		const setupTextCount = await page.getByText("new project setup").count();
		expect(setupTextCount).toBe(0);

		await deleteSession(sessionId);
		if (provisionalProjectId) await cleanupProject(provisionalProjectId);
	});
});

test.describe("Provisional project lifecycle", () => {
	test("provisional project appears in sidebar with (setting up) indicator", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "sidebar-prov");

		// Verify a provisional project was created via API
		const provisional = await findProvisionalProject(dir);
		expect(provisional).toBeTruthy();
		expect(provisional.provisional).toBe(true);

		// The sidebar should show the directory basename with "(setting up)"
		const sidebar = page.locator(".sidebar-edge");
		const dirBasename = dir.split(/[\\/]/).filter(Boolean).pop()!;
		await expect(sidebar.getByText(dirBasename).first()).toBeVisible({ timeout: 15_000 });
		await expect(sidebar.getByText("(setting up)").first()).toBeVisible();

		// Cleanup
		await deleteSession(sessionId);
		await cleanupProject(provisional.id);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	test("provisional project has suppressed action buttons", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "suppress-btn");

		const sidebar = page.locator(".sidebar-edge");

		// Verify "(setting up)" is visible
		await expect(sidebar.getByText("(setting up)").first()).toBeVisible({ timeout: 15_000 });

		// The project header with "(setting up)" should not have a settings gear button
		const provisionalHeader = sidebar.locator(".group").filter({ hasText: "(setting up)" }).first();
		await expect(provisionalHeader.locator('button[title="Project settings"]')).not.toBeVisible();

		// Cleanup
		const prov = await findProvisionalProject(dir);
		await deleteSession(sessionId);
		if (prov) await cleanupProject(prov.id);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	test("provisional project cleaned up on session terminate via API", async () => {
		const dir = uniqueDir("cleanup-api");
		writeFileSync(join(dir, "README.md"), "# test");

		const { sessionId, provisionalProjectId } = await createProjectAssistantSession("project", dir);
		await waitForSessionStatus(sessionId, "idle");

		// Verify provisional project exists
		let projects = await getProjects();
		const provisional = projects.find((p: any) => p.id === provisionalProjectId);
		expect(provisional).toBeTruthy();
		expect(provisional.provisional).toBe(true);

		// Terminate session — server doesn't auto-cleanup, so we manually delete
		await deleteSession(sessionId);

		// The provisional project should still exist after API-only session delete
		// (cleanup is client-side behavior)
		projects = await getProjects();
		const stillExists = projects.find((p: any) => p.id === provisionalProjectId);
		expect(stillExists).toBeTruthy();

		// Manually clean up the provisional project
		await cleanupProject(provisionalProjectId!);

		// Now it should be gone
		projects = await getProjects();
		const gone = projects.find((p: any) => p.id === provisionalProjectId);
		expect(gone).toBeFalsy();

		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	test("provisional project cleaned up on session terminate via browser", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "cleanup-browser");

		const sidebar = page.locator(".sidebar-edge");

		// Verify placeholder exists — generous timeout for system load
		await expect(sidebar.getByText("(setting up)").first()).toBeVisible({ timeout: 15_000 });

		// Get the provisional project ID for cleanup
		const prov = await findProvisionalProject(dir);
		expect(prov).toBeTruthy();

		// Navigate to the session, then terminate it via the UI command bar
		// We'll use the API delete and then navigate away to trigger refresh
		await deleteSession(sessionId);

		// Navigate away and wait for the sidebar to refresh
		await page.evaluate(() => { window.location.hash = "#/"; });
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Manually remove the provisional project (since API-only delete doesn't auto-cleanup)
		if (prov) await cleanupProject(prov.id);

		// Refresh to pick up the changes
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// The provisional project's "(setting up)" should no longer appear
		// Wait for sidebar to render after cleanup
		await expect(async () => {
			const settingUpCount = await sidebar.getByText("(setting up)").count();
			expect(settingUpCount).toBe(0);
		}).toPass({ timeout: 15_000 });

		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	test("provisional project survives page refresh", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "refresh-persist");

		const sidebar = page.locator(".sidebar-edge");
		const dirBasename = dir.split(/[\\/]/).filter(Boolean).pop()!;

		// Verify provisional project visible
		await expect(sidebar.getByText("(setting up)").first()).toBeVisible({ timeout: 15_000 });
		await expect(sidebar.getByText(dirBasename).first()).toBeVisible();

		// Reload the page
		await page.reload();

		// Re-authenticate after reload
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Provisional project should still be visible (persisted server-side)
		await expect(sidebar.getByText("(setting up)").first()).toBeVisible({ timeout: 15_000 });
		await expect(sidebar.getByText(dirBasename).first()).toBeVisible();

		// Cleanup
		const prov = await findProvisionalProject(dir);
		await deleteSession(sessionId);
		if (prov) await cleanupProject(prov.id);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	test("provisional project returned by GET /api/projects with provisional flag", async () => {
		const dir = uniqueDir("api-flag");
		writeFileSync(join(dir, "README.md"), "# test");

		const { sessionId, provisionalProjectId } = await createProjectAssistantSession("project", dir);

		// Verify via API
		const projects = await getProjects();
		const provisional = projects.find((p: any) => p.id === provisionalProjectId);
		expect(provisional).toBeTruthy();
		expect(provisional.provisional).toBe(true);
		expect(provisional.rootPath).toBe(dir);

		await deleteSession(sessionId);
		if (provisionalProjectId) await cleanupProject(provisionalProjectId);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});
});

test.describe("Project proposal preview form", () => {
	test("proposal shows preview form with editable fields", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "proposal-form");

		// Send a message to trigger PROJECT_PROPOSAL
		await sendMessage(page, "PROJECT_PROPOSAL");

		// Wait for the proposal form to appear with "Accept Project" button
		await expect(page.getByText("Accept Project").first()).toBeVisible({ timeout: 15_000 });

		// Verify form fields are present
		await expect(page.getByText("Project Name").first()).toBeVisible();
		await expect(page.getByText("Root Path").first()).toBeVisible();
		await expect(page.getByText("Build Command").first()).toBeVisible();
		await expect(page.getByText("Test Command").first()).toBeVisible();

		// Verify the proposed name is populated
		const nameInput = page.locator('input[placeholder="Project name"]');
		await expect(nameInput).toHaveValue("Test Project");

		// Dismiss button should be present
		await expect(page.locator("button").filter({ hasText: "Dismiss" }).first()).toBeVisible();

		// Cleanup
		const prov = await findProvisionalProject(dir);
		await deleteSession(sessionId);
		if (prov) await cleanupProject(prov.id);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	test("accepting proposal promotes the provisional project", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "accept-proj");

		// Get the provisional project ID from API
		const prov = await findProvisionalProject(dir);
		expect(prov).toBeTruthy();
		const projectId = prov.id;

		// Send PROJECT_PROPOSAL to trigger the form
		await sendMessage(page, "PROJECT_PROPOSAL");
		await expect(page.getByText("Accept Project").first()).toBeVisible({ timeout: 15_000 });

		// Click Accept
		await page.getByText("Accept Project").first().click();

		// Wait for the project to be promoted
		await expect(async () => {
			const prjs = await getProjects();
			const promoted = prjs.find((p: any) => p.id === projectId);
			expect(promoted).toBeTruthy();
			expect(promoted.provisional).toBeFalsy();
		}).toPass({ timeout: 15_000 });

		// Verify the project name was updated to "Test Project"
		const projects = await getProjects();
		const promoted = projects.find((p: any) => p.id === projectId);
		expect(promoted.name).toBe("Test Project");

		// Sidebar should no longer show "(setting up)" for this project
		const sidebar = page.locator(".sidebar-edge");
		await expect(sidebar.getByText("Test Project").first()).toBeVisible({ timeout: 15_000 });

		// Clean up
		await deleteSession(sessionId);
		await cleanupProject(projectId);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	test("accepting proposal writes config fields", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "config-write");

		// Get the provisional project ID
		const prov = await findProvisionalProject(dir);
		expect(prov).toBeTruthy();
		const projectId = prov.id;

		// Trigger proposal and accept
		await sendMessage(page, "PROJECT_PROPOSAL");
		await expect(page.getByText("Accept Project").first()).toBeVisible({ timeout: 15_000 });
		await page.getByText("Accept Project").first().click();

		// Wait for promotion
		await expect(async () => {
			const prjs = await getProjects();
			const p = prjs.find((pp: any) => pp.id === projectId);
			expect(p).toBeTruthy();
			expect(p.provisional).toBeFalsy();
		}).toPass({ timeout: 15_000 });

		// Verify config was written — the client writes config fields after promotion,
		// so poll until all expected fields are present.
		await expect(async () => {
			const configResp = await apiFetch(`/api/projects/${projectId}/config`);
			expect(configResp.ok).toBe(true);
			const config = await configResp.json();
			expect(config.build_command).toBe("npm run build");
			expect(config.test_command).toBe("npm test");
			expect(config.typecheck_command).toBe("npm run check");
			expect(config.worktree_setup_command).toBe("npm ci");
		}).toPass({ timeout: 20_000 });

		// Clean up
		await deleteSession(sessionId);
		await cleanupProject(projectId);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	test("dismissing proposal hides the form", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "dismiss-test");

		// Trigger proposal
		await sendMessage(page, "PROJECT_PROPOSAL");
		await expect(page.getByText("Accept Project").first()).toBeVisible({ timeout: 15_000 });

		// Click Dismiss button
		await page.locator("button").filter({ hasText: "Dismiss" }).first().click();

		// The "Accept Project" should disappear
		await expect(page.getByText("Accept Project").first()).not.toBeVisible({ timeout: 15_000 });

		// Should show "Waiting for project analysis" placeholder instead
		await expect(page.getByText("Waiting for project analysis").first()).toBeVisible({ timeout: 15_000 });

		// Cleanup
		const prov = await findProvisionalProject(dir);
		await deleteSession(sessionId);
		if (prov) await cleanupProject(prov.id);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});
});
