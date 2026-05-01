/**
 * Workflows page scope behaviour — UI E2E.
 *
 * The Workflows page now lives inside the Settings dialog as a project-scoped
 * tab (commits 0fd63978, 2fd9ad2b). Workflows have no system layer, so the
 * "Workflows" tab only appears when Settings is in a project scope. The
 * standalone `#/workflows` route is preserved as a redirect into the active
 * project's Workflows tab.
 *
 * This file pins the UI side of "Remove system-level workflows":
 *   - The System scope tab list does NOT include "Workflows".
 *   - Project scope tab list DOES include "Workflows".
 *   - The standalone `#/workflows` route redirects to
 *     `#/settings/<projectId>/workflows`.
 *   - The active project's workflows render via the `.wf-row` rows, no
 *     system-level entries leak in (workflows have no `builtin`/`server`
 *     origin badges).
 *
 * Canonical pattern: tests/e2e/ui/settings.spec.ts
 *                    tests/e2e/ui/config-scope.spec.ts
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, rawApiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createProjectDir(): string {
	const dir = mkdtempSync(join(tmpdir(), `bobbit-wf-page-${process.env.E2E_PORT}-`));
	mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	return dir;
}

test.describe("Workflows page (project-scoped)", () => {
	let projectId: string;
	let tmpDir: string;
	const wfId = "ui-scope-only-" + Date.now();

	test.beforeAll(async () => {
		tmpDir = createProjectDir();
		const res = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Workflow Scope Project", rootPath: tmpDir, __e2e_seed_skip__: true }),
		});
		expect(res.status).toBe(201);
		projectId = (await res.json()).id;

		// Seed a workflow in this project so the list view has a deterministic
		// entry to assert against. Use rawApiFetch with explicit projectId so
		// we don't accidentally hit the harness default project.
		const c = await rawApiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify({
				projectId,
				id: wfId,
				name: "Scope-only Workflow",
				description: "ui-scope test",
				gates: [{
					id: "step-a", name: "Step A", depends_on: [],
					verify: [{ name: "Check", type: "command", run: "echo ok" }],
				}],
			}),
		});
		expect(c.status).toBe(201);
	});

	test.afterAll(async () => {
		await apiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
		await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("System scope omits Workflows tab; project scope includes it @smoke", async ({ page }) => {
		// System scope: open a non-workflows tab and check the tab bar.
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });

		// The Settings tab bar is the second `border-b` row (scope row first,
		// tabs second). Looking up by role+name across the page is fragile
		// because the scope row may also contain a "Workflow Scope Project"
		// project pill. Assert exclusively against the Settings tab list:
		// Workflows must not be among System tabs.
		// We treat the tab bar as the set of buttons that are siblings of
		// known system-only tabs ("Models", "Shortcuts", "Color Palette").
		const modelsTab = page.locator("button").filter({ hasText: /^Models$/ }).first();
		await expect(modelsTab).toBeVisible({ timeout: 5_000 });
		const tabBar = modelsTab.locator("..");
		// Workflows is NOT a tab in System scope.
		await expect(tabBar.locator("button").filter({ hasText: /^Workflows$/ })).toHaveCount(0);

		// Switch to the seeded project's scope by clicking its scope-row pill.
		const projectPill = page.locator("button").filter({ hasText: "Workflow Scope Project" }).first();
		await projectPill.click();
		// In project scope, Workflows IS a tab.
		await expect(
			page.locator("button").filter({ hasText: /^Workflows$/ }).first(),
		).toBeVisible({ timeout: 5_000 });
	});

	test("standalone /workflows route redirects to Settings → Workflows tab", async ({ page }) => {
		await openApp(page);
		// Navigate to legacy /workflows. The app should redirect to
		// #/settings/<activeProjectId>/workflows.
		await page.evaluate(() => { window.location.hash = "#/workflows"; });
		// Wait for the redirect to take effect.
		await page.waitForFunction(
			() => window.location.hash.startsWith("#/settings/") && window.location.hash.endsWith("/workflows"),
			null,
			{ timeout: 10_000 },
		);
		// Settings page renders, Workflows tab content is present.
		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 5_000 });
		await expect(page.locator("[data-testid='workflows-tab']")).toBeVisible({ timeout: 5_000 });
	});

	test("workflow list shows the active project's entries (no system-level leak)", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, `#/settings/${projectId}/workflows`);
		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("[data-testid='workflows-tab']")).toBeVisible({ timeout: 10_000 });

		// The project's seeded workflow is visible.
		await expect(page.getByText("Scope-only Workflow").first()).toBeVisible({ timeout: 10_000 });

		// Sanity check: workflows are project-scoped only — no origin badges
		// should advertise a builtin/server layer. The embedded view drops
		// origin badges entirely (commit 0fd63978), but assert defensively
		// in case any leak past — only "project" is acceptable.
		const badges = await page.locator(".config-origin-badge").allTextContents();
		for (const txt of badges) {
			const t = (txt || "").trim().toLowerCase();
			if (t.length > 0) {
				expect(["project"]).toContain(t);
			}
		}
	});
});
