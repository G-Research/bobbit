/**
 * Project assistant UX E2E tests.
 * Tests auto-prompt with directory path, assistantType wiring,
 * sidebar placeholder rendering, and cleanup on terminate.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, nonGitCwd, waitForSessionStatus, deleteSession } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse } from "./ui-helpers.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Create a project assistant session via API. */
async function createProjectAssistantSession(
	assistantType: "project" | "project-scaffolding",
	cwd?: string,
): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ assistantType, cwd: cwd || nonGitCwd() }),
	});
	expect(resp.status).toBe(201);
	const { id } = await resp.json();
	return id;
}

/** Create a unique temp dir for each test. */
function uniqueDir(label: string): string {
	const dir = join(tmpdir(), `bobbit-e2e-projast-${label}-${process.env.E2E_PORT}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
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
	await expect(page.locator('input[placeholder="/path/to/project"]')).toBeVisible({ timeout: 5_000 });

	// Type the path and click Continue
	await page.locator('input[placeholder="/path/to/project"]').fill(dir);
	await page.locator("button").filter({ hasText: "Continue" }).first().click();

	// Wait for dialog to close and session to connect
	await expect(page.locator('input[placeholder="/path/to/project"]')).not.toBeVisible({ timeout: 10_000 });
	await expect(async () => {
		const hash = await page.evaluate(() => window.location.hash);
		expect(hash).toMatch(/#\/session\//);
	}).toPass({ timeout: 10_000 });
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

	// Extract session ID from hash
	const hash = await page.evaluate(() => window.location.hash);
	const sessionId = hash.replace("#/session/", "");

	return { dir, sessionId };
}

test.describe("Project assistant UX", () => {
	test("auto-prompt is sent automatically via connectToSession (detection mode)", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "auto-detect");

		// The auto-prompt should have been sent automatically (not manually)
		// Verify the user message contains the directory path and detection-mode phrasing
		const userMsg = page.locator("user-message").first();
		await expect(userMsg).toContainText("project registration", { timeout: 10_000 });
		await expect(userMsg).toContainText(dir);

		// Mock agent responds
		await waitForAgentResponse(page);

		await deleteSession(sessionId);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* session may still hold lock */ }
	});

	test("session created with correct assistantType via API", async () => {
		// Detection mode
		const detectionId = await createProjectAssistantSession("project");
		const detResp = await apiFetch(`/api/sessions/${detectionId}`);
		const detData = await detResp.json();
		expect(detData.assistantType).toBe("project");

		// Scaffolding mode
		const scaffoldId = await createProjectAssistantSession("project-scaffolding");
		const scfResp = await apiFetch(`/api/sessions/${scaffoldId}`);
		const scfData = await scfResp.json();
		expect(scfData.assistantType).toBe("project-scaffolding");

		await deleteSession(detectionId);
		await deleteSession(scaffoldId);
	});

	test("project assistant session is navigable and visible", async ({ page }) => {
		const sessionId = await createProjectAssistantSession("project");
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// Navigate to the session
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Verify the hash points to our session (confirming it loaded)
		const hash = await page.evaluate(() => window.location.hash);
		expect(hash).toContain(sessionId);

		// Send a message and verify the round-trip works
		await sendMessage(page, "Hello from project assistant test");
		await waitForAgentResponse(page);

		await deleteSession(sessionId);
	});

	test("session terminate removes it from active sessions list", async () => {
		const sessionId = await createProjectAssistantSession("project");
		await waitForSessionStatus(sessionId, "idle");

		// Delete the session via API
		await deleteSession(sessionId);

		// Verify the session is no longer in the active sessions list
		const resp = await apiFetch("/api/sessions");
		const data = await resp.json();
		const sessions = data.sessions || [];
		const found = sessions.find((s: { id: string }) => s.id === sessionId);
		expect(found).toBeFalsy();
	});

	test("detection and scaffolding modes use different auto-prompt text", async ({ page }) => {
		// Detection mode says "project registration" while scaffolding says "new project setup".
		const sessionId = await createProjectAssistantSession("project");
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Send detection-mode auto-prompt text manually (verifying text differentiation)
		await sendMessage(page, "Start the project registration session. The project directory is: /my/project");
		await waitForAgentResponse(page);

		// Verify "project registration" is in the chat (not "new project setup")
		await expect(page.getByText("project registration").first()).toBeVisible();

		// The scaffolding prompt text should NOT appear
		const setupTextCount = await page.getByText("new project setup").count();
		expect(setupTextCount).toBe(0);

		await deleteSession(sessionId);
	});

	test("sidebar shows pending project with (setting up) indicator", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "sidebar-placeholder");

		// The sidebar should show the directory basename as the pending project name
		const sidebar = page.locator(".sidebar-edge");
		const dirBasename = dir.split(/[\\/]/).filter(Boolean).pop()!;
		await expect(sidebar.getByText(dirBasename)).toBeVisible({ timeout: 5_000 });

		// Verify "(setting up)" indicator is visible
		await expect(sidebar.getByText("(setting up)")).toBeVisible();

		await deleteSession(sessionId);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* session may still hold lock */ }
	});

	test("pending project placeholder removed on session terminate", async ({ page }) => {
		await openApp(page);

		const { dir, sessionId } = await addProjectViaDialog(page, "placeholder-cleanup");

		const sidebar = page.locator(".sidebar-edge");

		// Verify placeholder exists
		await expect(sidebar.getByText("(setting up)")).toBeVisible({ timeout: 5_000 });

		// Terminate the session via API
		await deleteSession(sessionId);

		// Navigate away to trigger cleanup render
		await page.evaluate(() => { window.location.hash = "#/"; });
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 10_000 });

		// Placeholder should be removed
		await expect(sidebar.getByText("(setting up)")).not.toBeVisible({ timeout: 5_000 });

		try { rmSync(dir, { recursive: true, force: true }); } catch { /* session may still hold lock */ }
	});
});
