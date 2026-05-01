/**
 * Project proposal — per-component `config:` map (Task D).
 *
 * Coverage:
 *   1. happy path  — Components view renders a `component-config-${name}`
 *      table with the proposed key/value rows.
 *   2. shallow-merge — second propose_project call omits `config` on a
 *      component; the previously-proposed `config` must survive (per-component
 *      merge in session-manager.onProjectProposal).
 *   3. empty state — components without any `config` show the "No config
 *      entries" placeholder, not a missing section.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, nonGitCwd, deleteSession } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse } from "./ui-helpers.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function uniqueDir(label: string): string {
	const dir = join(tmpdir(), `bobbit-e2e-comp-cfg-${label}-${process.env.E2E_PORT}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function getProjects(): Promise<any[]> {
	const resp = await apiFetch("/api/projects");
	const data = await resp.json();
	return data.projects || data || [];
}

async function findProvisionalProject(dir: string): Promise<any | undefined> {
	const projects = await getProjects();
	return projects.find((p: any) => p.rootPath === dir && p.provisional);
}

async function cleanupProject(id: string): Promise<void> {
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
}

async function addProjectViaDialog(
	page: import("@playwright/test").Page,
	label: string,
): Promise<{ dir: string; sessionId: string }> {
	const dir = uniqueDir(label);
	writeFileSync(join(dir, "package.json"), `{"name":"${label}"}`);

	await page.locator("button").filter({ hasText: "Add Project" }).first().click();
	await expect(page.locator('input[placeholder="/path/to/project"]')).toBeVisible({ timeout: 15_000 });
	await page.locator('input[placeholder="/path/to/project"]').fill(dir);
	await page.locator("button").filter({ hasText: "Continue" }).first().click();

	await expect(page.locator('input[placeholder="/path/to/project"]')).not.toBeVisible({ timeout: 10_000 });
	await expect(async () => {
		const hash = await page.evaluate(() => window.location.hash);
		expect(hash).toMatch(/#\/session\//);
	}).toPass({ timeout: 15_000 });
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

	const hash = await page.evaluate(() => window.location.hash);
	const sessionId = hash.replace("#/session/", "");
	return { dir, sessionId };
}

test.describe("Project proposal per-component config @quarantine", () => {
	test("Components view renders config rows + per-component shallow-merge preserves config across proposals", async ({ page }) => {
		await openApp(page);
		const { dir, sessionId } = await addProjectViaDialog(page, "comp-cfg");
		await waitForAgentResponse(page);

		// Drive two consecutive propose_project tool calls. First populates
		// `web.config`; second omits config on `web` (only commands). The
		// per-component merge must preserve the previously-proposed config.
		await sendMessage(page, "COMPONENT_CONFIG_PROPOSAL");

		const panel = page.locator('[data-panel="project-proposal"]').first();
		await expect(panel).toBeVisible({ timeout: 15_000 });

		// Components view is the default. Both component cards render.
		const webCard = panel.locator('[data-testid="component-card-web"]');
		const apiCard = panel.locator('[data-testid="component-card-api"]');
		await expect(webCard).toBeVisible({ timeout: 15_000 });
		await expect(apiCard).toBeVisible();

		// Open the web component card so its body (and config table) is visible.
		await webCard.locator("summary").first().click();

		// Config table testid present on web with the three proposed keys.
		const webConfig = panel.locator('[data-testid="component-config-web"]');
		await expect(webConfig).toBeVisible({ timeout: 5_000 });
		await expect(webConfig).toContainText("Config");
		await expect(panel.locator('[data-testid="component-config-row-web-qa_start_command"]'))
			.toContainText("PORT=$PORT NODE_ENV=test npm start", { timeout: 5_000 });
		await expect(panel.locator('[data-testid="component-config-row-web-qa_health_check"]'))
			.toContainText("http://127.0.0.1:$PORT/health");
		await expect(panel.locator('[data-testid="component-config-row-web-qa_max_duration_minutes"]'))
			.toContainText("10");

		// Open the api card and verify the empty state — api has no `config`
		// in either proposal, so the empty placeholder must render (not a
		// missing section, not "undefined").
		await apiCard.locator("summary").first().click();
		await expect(panel.locator('[data-testid="component-config-empty-api"]'))
			.toBeVisible({ timeout: 5_000 });
		await expect(panel.locator('[data-testid="component-config-empty-api"]'))
			.toContainText("No config entries");

		// Cleanup
		const prov = await findProvisionalProject(dir);
		await deleteSession(sessionId);
		if (prov) await cleanupProject(prov.id);
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
	});
});
