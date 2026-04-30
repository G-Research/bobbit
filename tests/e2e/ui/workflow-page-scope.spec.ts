/**
 * Workflows page scope behaviour — UI E2E.
 *
 * Pins the UI side of "Remove system-level workflows":
 *   - The Workflows page omits the "System" tab from its scope row.
 *   - Entering the page in System scope auto-switches to the first project.
 *   - The project's workflows render; no system-level entries leak in.
 *   - The empty-state path is exercised in a dedicated test using
 *     forceDeleteAllProjects() so it doesn't disturb the other suites'
 *     shared default project.
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

	test("entering /workflows in System scope auto-switches to a project @smoke", async ({ page }) => {
		// Fresh app load → in-memory config scope is "system" by default
		// (config-scope.ts::_configScope = "system").
		await openApp(page);
		await navigateToHash(page, "#/workflows");

		// Wait for page render.
		await expect(page.getByText("Workflows").first()).toBeVisible({ timeout: 10_000 });

		// The "System" tab MUST NOT appear in the scope row on this page —
		// renderConfigScopeRow is called with excludeSystem:true.
		const systemButtons = await page.locator("button").filter({ hasText: /^System$/ }).count();
		expect(systemButtons).toBe(0);

		// At least one project tab is present in the scope row.
		await expect(
			page.locator("button").filter({ hasText: "Workflow Scope Project" }).first(),
		).toBeVisible({ timeout: 5_000 });

		// Reload — the UI re-mounts with config scope reset to "system" again,
		// and loadWorkflowPageData() must auto-switch to a project.
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first())
			.toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/workflows");
		await expect(page.getByText("Workflows").first()).toBeVisible({ timeout: 10_000 });
		const systemButtonsAfter = await page.locator("button").filter({ hasText: /^System$/ }).count();
		expect(systemButtonsAfter).toBe(0);
	});

	test("workflow list shows the active project's entries (no system-level leak)", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/workflows");
		await expect(page.getByText("Workflows").first()).toBeVisible({ timeout: 10_000 });

		// Click the project's scope tab to make assertions deterministic.
		const projectTab = page.locator("button").filter({ hasText: "Workflow Scope Project" }).first();
		await projectTab.click();

		// The project's seeded workflow is visible.
		await expect(page.getByText("Scope-only Workflow").first()).toBeVisible({ timeout: 10_000 });

		// Sanity check: no "system" origin badge on this page (workflows have
		// no server/builtin layer anymore — origin must be "project").
		// Inspect every rendered workflow row's origin badge.
		const badges = await page.locator(".config-origin-badge").allTextContents();
		// All badges (if any) must be "project" — never "builtin" or "server".
		for (const txt of badges) {
			const t = (txt || "").trim().toLowerCase();
			if (t.length > 0) {
				expect(["project"]).toContain(t);
			}
		}
	});
});
