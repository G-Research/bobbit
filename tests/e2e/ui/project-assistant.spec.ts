/**
 * Project assistant UX E2E tests — consolidated.
 *
 * API basics coverage lives in tests/e2e/project-assistant-api.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, deleteSession } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse } from "./ui-helpers.js";
import { realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Create a unique temp dir for each test.
 *  Returns the canonical (realpath) form so the project-assistant flow
 *  isn't blocked by the symlink-confirm dialog on macOS (tmpdir is
 *  /var/folders which symlinks to /private/var/folders). */
function uniqueDir(label: string): string {
	const dir = join(tmpdir(), `bobbit-e2e-projast-${label}-${process.env.E2E_PORT}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return realpathSync(dir);
}

function ensureE2EAgentAuth(): void {
	const agentDir = process.env.BOBBIT_AGENT_DIR;
	if (!agentDir) return;
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
		anthropic: { type: "oauth", expires: Date.now() + 86_400_000 },
	}));
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

/**
 * Wait for the provisional accept cleanup to finish at the source of truth.
 * The final sidebar assertion is intentionally after this API/client-state gate:
 * Playwright's click returns before acceptProjectProposal() finishes its async
 * promote → config write → terminate-session chain, so DOM-only polling can
 * race a still-live assistant session under load.
 */
async function waitForProjectAssistantCleanup(
	page: import("@playwright/test").Page,
	sessionId: string,
	projectId: string,
): Promise<void> {
	await expect(async () => {
		const [sessionsResp, projects] = await Promise.all([
			apiFetch("/api/sessions"),
			getProjects(),
		]);
		expect(sessionsResp.ok).toBe(true);
		const sessionsData = await sessionsResp.json();
		const liveSessions = sessionsData.sessions || [];
		const liveAssistant = liveSessions.find((s: any) =>
			s.id === sessionId
			|| (s.projectId === projectId && (s.assistantType === "project" || s.assistantType === "project-scaffolding")),
		);
		expect(liveAssistant, `project assistant session ${sessionId} should be gone from live sessions`).toBeUndefined();

		const promoted = projects.find((p: any) => p.id === projectId);
		expect(promoted, `project ${projectId} should still be registered`).toBeTruthy();
		expect(promoted.provisional).toBeFalsy();
	}).toPass({ timeout: 20_000 });

	await page.waitForFunction(
		({ sessionId: sid, projectId: pid }) => {
			const state = (window as any).__bobbitState;
			if (!state || !Array.isArray(state.gatewaySessions) || !Array.isArray(state.projects)) return false;
			const liveAssistant = state.gatewaySessions.some((s: any) =>
				s?.id === sid
				|| (s?.projectId === pid && (s?.assistantType === "project" || s?.assistantType === "project-scaffolding")),
			);
			const promoted = state.projects.find((p: any) => p?.id === pid);
			return !liveAssistant && !!promoted && !promoted.provisional;
		},
		{ sessionId, projectId },
		{ timeout: 20_000 },
	);
}

test.describe("Project assistant UX (consolidated)", () => {
	test.beforeEach(() => {
		ensureE2EAgentAuth();
	});

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

		// Wait on server + hydrated client state before checking the rendered row.
		await waitForProjectAssistantCleanup(page, sessionId, projectId);

		// Project assistant session should be removed from this project's sidebar bucket after cleanup.
		// Browser workers share a gateway across multiple spec files, so a broad sidebar
		// text count can see an unrelated leftover Project Assistant from another project.
		const projectSection = sidebar.locator(`.project-reorder-section[data-project-id="${projectId}"]`);
		await expect(projectSection).toHaveCount(1, { timeout: 5_000 });
		await expect(projectSection.locator(`[data-session-id="${sessionId}"]`)).toHaveCount(0, { timeout: 5_000 });
		await expect(projectSection.getByText("Project Assistant")).toHaveCount(0, { timeout: 5_000 });

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

	// API basics — session types and provisional flag — moved to tests/e2e/project-assistant-api.spec.ts.
});
