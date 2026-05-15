/**
 * Project assistant UX E2E tests — consolidated.
 * 4 essential tests covering critical paths:
 * 1. Happy path: create provisional → accept proposal → project promoted with config
 * 2. Dismiss/cleanup: dismiss proposal + provisional cleanup on delete
 * 3. Provisional project persistence across page refresh
 * 4. API basics: session types + provisional flag
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, nonGitCwd, waitForSessionStatus, deleteSession } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse } from "./ui-helpers.js";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
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

/** Create a unique temp dir for each test.
 *
 * Canonicalized via realpathSync because macOS tmpdir() lives under
 * /var/folders/... which is a symlink to /private/var/folders/...; the
 * server stores project rootPath canonically (via realpathSync inside
 * registerProject), so test-side lookups by `p.rootPath === dir` only
 * match when `dir` is already canonical. Tests that specifically exercise
 * the symlinked-rootPath flow build their own symlink pair instead.
 */
function uniqueDir(label: string): string {
	const dir = join(tmpdir(), `bobbit-e2e-projast-${label}-${process.env.E2E_PORT}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return realpathSync(dir);
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

test.describe("Project assistant UX (consolidated) @quarantine", () => {
	test("happy path — create provisional, accept proposal, project promoted with config", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "happy-path");

		// Verify auto-prompt was sent and provisional project created
		const userMsg = page.locator("user-message").first();
		await expect(userMsg).toContainText("project registration", { timeout: 10_000 });
		await expect(userMsg).toContainText(dir);
		await waitForAgentResponse(page);

		// Verify provisional project exists in sidebar with "(setting up)" indicator
		const sidebar = page.locator(".sidebar-edge");
		const dirBasename = dir.split(/[\\/]/).filter(Boolean).pop()!;
		await expect(sidebar.getByText(dirBasename).first()).toBeVisible({ timeout: 15_000 });
		await expect(sidebar.getByText("(setting up)").first()).toBeVisible();

		// Get the provisional project ID
		const prov = await findProvisionalProject(dir);
		expect(prov).toBeTruthy();
		expect(prov.provisional).toBe(true);
		const projectId = prov.id;

		// Trigger proposal and accept it
		await sendMessage(page, "PROJECT_PROPOSAL");
		await expect(page.getByText("Accept Project").first()).toBeVisible({ timeout: 15_000 });

		// Verify form fields are present — Project Name + Root Path live in the
		// Settings tab of the proposal panel (Components is the default tab).
		const panel = page.locator('[data-panel="project-proposal"]').first();
		await panel.locator('[data-testid="view-tab-settings"]').click();
		await expect(panel.getByText("Project Name").first()).toBeVisible();
		await expect(panel.getByText("Root Path").first()).toBeVisible();

		// Click Accept
		await page.getByText("Accept Project").first().click();

		// Wait for promotion
		await expect(async () => {
			const prjs = await getProjects();
			const promoted = prjs.find((p: any) => p.id === projectId);
			expect(promoted).toBeTruthy();
			expect(promoted.provisional).toBeFalsy();
		}).toPass({ timeout: 15_000 });

		// Verify the project name was updated
		const projects = await getProjects();
		const promoted = projects.find((p: any) => p.id === projectId);
		expect(promoted.name).toBe("Test Project");

		// Verify config was written
		await expect(async () => {
			const configResp = await apiFetch(`/api/projects/${projectId}/config`);
			expect(configResp.ok).toBe(true);
			const config = await configResp.json();
			expect(config.build_command).toBe("npm run build");
			expect(config.test_command).toBe("npm test");
			expect(config.typecheck_command).toBe("npm run check");
			expect(config.worktree_setup_command).toBe("npm ci");
		}).toPass({ timeout: 20_000 });

		// Sidebar should no longer show "(setting up)"
		await expect(sidebar.getByText("Test Project").first()).toBeVisible({ timeout: 15_000 });

		// Project assistant session should be removed from the sidebar immediately
		await expect(sidebar.getByText("Project Assistant")).toHaveCount(0, { timeout: 10_000 });

		// Cleanup
		await deleteSession(sessionId);
		await cleanupProject(projectId);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	test("dismiss proposal hides form and cleanup removes provisional project", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "dismiss-cleanup");

		// Trigger proposal
		await sendMessage(page, "PROJECT_PROPOSAL");
		await expect(page.getByText("Accept Project").first()).toBeVisible({ timeout: 15_000 });

		// Click Dismiss
		await page.locator("button").filter({ hasText: "Dismiss" }).first().click();

		// The "Accept Project" should disappear, replaced by placeholder
		await expect(page.getByText("Accept Project").first()).not.toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("Waiting for project analysis").first()).toBeVisible({ timeout: 15_000 });

		// Get the provisional project and verify it exists
		const prov = await findProvisionalProject(dir);
		expect(prov).toBeTruthy();

		// Delete session and cleanup provisional project
		await deleteSession(sessionId);
		await cleanupProject(prov.id);

		// Verify project is gone
		const projects = await getProjects();
		expect(projects.find((p: any) => p.id === prov.id)).toBeFalsy();

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

	test("panel updates live across two propose_project calls", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "live-update");

		// Wait for the auto-prompt round trip so the panel is mounted.
		await waitForAgentResponse(page);

		// Drive the mock agent to emit two consecutive propose_project tool calls
		// in the same turn — first with components only, then with components +
		// workflows. This proves Bug C: the second call's workflows must land.
		await sendMessage(page, "LIVE_UPDATE_PROPOSAL");

		const panel = page.locator('[data-panel="project-proposal"]').first();
		await expect(panel).toBeVisible({ timeout: 15_000 });

		// Components view is the default — both components should render.
		await expect(panel.locator('[data-testid="component-card-api"]')).toBeVisible({ timeout: 15_000 });
		await expect(panel.locator('[data-testid="component-card-web"]')).toBeVisible();

		// Switch to Workflows tab — workflow cards from the SECOND proposal must
		// be present. If the merge dropped them, this fails.
		await panel.locator('[data-testid="view-tab-workflows"]').click();
		await expect(panel.locator('[data-testid="workflow-card-feature-api"]')).toBeVisible({ timeout: 10_000 });
		await expect(panel.locator('[data-testid="workflow-card-feature-web"]')).toBeVisible();

		// Cleanup
		const prov = await findProvisionalProject(dir);
		await deleteSession(sessionId);
		if (prov) await cleanupProject(prov.id);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	test("multi-component proposal shows per-component + all-components workflow cards", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "multi-comp");
		await waitForAgentResponse(page);

		await sendMessage(page, "MULTI_COMPONENT_PROPOSAL");

		const panel = page.locator('[data-panel="project-proposal"]').first();
		await expect(panel).toBeVisible({ timeout: 15_000 });

		// Both components render in the default Components view.
		await expect(panel.locator('[data-testid="component-card-api"]')).toBeVisible({ timeout: 15_000 });
		await expect(panel.locator('[data-testid="component-card-web"]')).toBeVisible();

		// Switch to Workflows tab.
		await panel.locator('[data-testid="view-tab-workflows"]').click();

		// Per-component + all-components cards must be visible.
		await expect(panel.locator('[data-testid="workflow-card-feature-api"]')).toBeVisible({ timeout: 10_000 });
		await expect(panel.locator('[data-testid="workflow-card-feature-web"]')).toBeVisible();
		await expect(panel.locator('[data-testid="workflow-card-all-components"]')).toBeVisible();

		// Cleanup
		const prov = await findProvisionalProject(dir);
		await deleteSession(sessionId);
		if (prov) await cleanupProject(prov.id);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	test("API basics — session types and provisional flag", async () => {
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

		// Verify provisional flag via projects API
		if (pp1) {
			const projects = await getProjects();
			const provisional = projects.find((p: any) => p.id === pp1);
			expect(provisional).toBeTruthy();
			expect(provisional.provisional).toBe(true);
		}

		// Session terminate removes from active list
		await deleteSession(detectionId);
		const resp = await apiFetch("/api/sessions");
		const data = await resp.json();
		const sessions = data.sessions || [];
		expect(sessions.find((s: { id: string }) => s.id === detectionId)).toBeFalsy();

		await deleteSession(scaffoldId);
		if (pp1) await cleanupProject(pp1);
		if (pp2) await cleanupProject(pp2);
	});
});
