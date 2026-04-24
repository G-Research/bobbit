/**
 * Mid-session project proposal — browser E2E.
 *
 * A regular (non-assistant) session in a registered project emits a
 * <project_proposal> tool call via the mock agent. The Project tab should
 * appear in the unified preview panel with a diff rendered against the
 * current config. Accept writes the diffed fields to project.yaml
 * (via PUT /api/projects/:id/config) without terminating the session.
 * Dismiss clears the proposal and the tab disappears.
 *
 * Coverage:
 *   1. navigation — Project tab appears after proposal
 *   2. happy path — diff rendered, Accept persists config
 *   3. persistence across reload — accepted config survives, proposal gone
 *   4. dismiss/undo — Dismiss clears the tab without writing config
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

async function getDefaultProjectId(): Promise<string> {
	const resp = await apiFetch("/api/projects");
	const data = await resp.json();
	const projects = Array.isArray(data) ? data : (data.projects || []);
	expect(projects.length).toBeGreaterThan(0);
	return projects[0].id;
}

test.describe("Mid-session project proposal (non-assistant session)", () => {
	test("propose \u2192 diff rendered \u2192 Accept writes config \u2192 reload persists", async ({ page }) => {
		const projectId = await getDefaultProjectId();

		// Seed baseline config so the mock proposal has a clear diff.
		await apiFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({ build_command: "baseline-build", test_command: "baseline-test" }),
		});

		await openApp(page);
		await createSessionViaUI(page);

		// Mock agent recognizes the "project_proposal" trigger phrase and emits
		// a propose_project tool call with canned fields (see
		// tests/e2e/mock-agent-core.mjs respondToPrompt).
		await sendMessage(page, "Please emit a project_proposal for testing");

		// The Project tab should appear in the unified preview panel.
		const projectTab = page.locator("button.goal-tab-pill").filter({ hasText: /^Project/ }).first();
		await expect(projectTab).toBeVisible({ timeout: 15_000 });

		// The panel renders with data-panel="project-proposal" in registered mode.
		const panel = page.locator('[data-panel="project-proposal"]').first();
		await expect(panel).toBeVisible({ timeout: 10_000 });
		// Wait until registered-mode current-config lookup has completed
		// (mode attribute is "registered" and loading placeholder cleared).
		await expect(panel).toHaveAttribute("data-mode", "registered", { timeout: 10_000 });
		await expect(panel.locator('[data-testid="loading-current-config"]')).toHaveCount(0, { timeout: 10_000 });

		// At least one Changed badge should be visible (build_command changes
		// from baseline-build -> npm run build, test_command changes too).
		await expect(panel.locator('[data-testid="changed-badge"]').first()).toBeVisible({ timeout: 5_000 });

		// The accept button should be labeled "Apply Changes" (with count).
		const acceptLabel = panel.locator('[data-testid="accept-label"]').first();
		await expect(acceptLabel).toContainText("Apply Changes", { timeout: 5_000 });

		// Click the accept (Apply Changes) button.
		const applyBtn = panel.locator("button", { has: page.locator('[data-testid="accept-label"]') }).first();
		await applyBtn.click();

		// Panel should disappear (proposal cleared, session still active).
		await expect(projectTab).toHaveCount(0, { timeout: 10_000 });

		// The session should still be connected (no navigation away).
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 5_000 });

		// Config persisted on the server.
		const cfg = await (await apiFetch(`/api/projects/${projectId}/config`)).json();
		expect(cfg.build_command).toBe("npm run build");
		expect(cfg.test_command).toBe("npm test");

		// Reload — proposal should stay gone, config stays.
		await page.reload();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator("button.goal-tab-pill").filter({ hasText: /^Project/ })).toHaveCount(0);

		const cfgAfter = await (await apiFetch(`/api/projects/${projectId}/config`)).json();
		expect(cfgAfter.build_command).toBe("npm run build");
	});

	test("Dismiss clears the proposal without writing config", async ({ page }) => {
		const projectId = await getDefaultProjectId();

		// Seed baseline — distinct from previous test.
		await apiFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({ build_command: "dismiss-baseline" }),
		});

		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "Please emit a project_proposal for testing");

		const projectTab = page.locator("button.goal-tab-pill").filter({ hasText: /^Project/ }).first();
		await expect(projectTab).toBeVisible({ timeout: 15_000 });

		const panel = page.locator('[data-panel="project-proposal"]').first();
		await expect(panel).toBeVisible({ timeout: 10_000 });

		// Click the Dismiss button (ghost variant, text "Dismiss").
		const dismissBtn = panel.getByRole("button", { name: "Dismiss" }).first();
		await expect(dismissBtn).toBeVisible({ timeout: 10_000 });
		await dismissBtn.click();

		// Tab disappears.
		await expect(projectTab).toHaveCount(0, { timeout: 5_000 });

		// Config untouched.
		const cfg = await (await apiFetch(`/api/projects/${projectId}/config`)).json();
		expect(cfg.build_command).toBe("dismiss-baseline");
	});
});
