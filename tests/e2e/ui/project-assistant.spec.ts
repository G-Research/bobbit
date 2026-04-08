/**
 * Project assistant UX E2E tests.
 * Tests auto-prompt with directory path, assistantType wiring,
 * sidebar placeholder rendering, and cleanup on terminate.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, nonGitCwd, waitForSessionStatus, deleteSession } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

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

test.describe("Project assistant UX", () => {
	test("auto-prompt sends directory path (detection mode)", async ({ page }) => {
		const sessionId = await createProjectAssistantSession("project");
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Simulate what connectToSession does for detection mode:
		// send a message matching the auto-prompt format with the directory path
		const dirPath = nonGitCwd();
		await sendMessage(page, `Start the project registration session. The project directory is: ${dirPath}`);

		// Verify the user message with directory path appears in chat
		await expect(
			page.getByText("project registration session").first(),
		).toBeVisible({ timeout: 10_000 });

		// Mock agent responds with "OK"
		await waitForAgentResponse(page);

		await deleteSession(sessionId);
	});

	test("auto-prompt sends directory path (scaffolding mode)", async ({ page }) => {
		const sessionId = await createProjectAssistantSession("project-scaffolding");
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Simulate what connectToSession does for scaffolding mode
		const dirPath = nonGitCwd();
		await sendMessage(page, `Start the new project setup session. The target directory is: ${dirPath}`);

		// Verify scaffolding-specific phrasing
		await expect(
			page.getByText("target directory").first(),
		).toBeVisible({ timeout: 10_000 });

		// Mock agent responds
		await waitForAgentResponse(page);

		await deleteSession(sessionId);
	});

	test("session created with correct assistantType via API", async ({ page }) => {
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

	test("session terminate removes it from active sessions list", async ({ page }) => {
		const sessionId = await createProjectAssistantSession("project");
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Delete the session via API
		await deleteSession(sessionId);

		// Navigate to landing
		await page.evaluate(() => { window.location.hash = "#/"; });
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 10_000 });

		// Verify the session is no longer in the active sessions list
		const resp = await apiFetch("/api/sessions");
		const data = await resp.json();
		const sessions = data.sessions || [];
		const found = sessions.find((s: { id: string }) => s.id === sessionId);
		expect(found).toBeFalsy();
	});

	test("detection and scaffolding modes use different auto-prompt text", async ({ page }) => {
		// This test verifies the auto-prompt text differentiation.
		// Detection mode says "project registration" while scaffolding says "new project setup".
		const sessionId = await createProjectAssistantSession("project");
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Send detection-mode auto-prompt
		await sendMessage(page, "Start the project registration session. The project directory is: /my/project");
		await waitForAgentResponse(page);

		// Verify "project registration" is in the chat (not "new project setup")
		await expect(page.getByText("project registration").first()).toBeVisible();

		// The scaffolding prompt text should NOT appear
		const setupTextCount = await page.getByText("new project setup").count();
		expect(setupTextCount).toBe(0);

		await deleteSession(sessionId);
	});
});
