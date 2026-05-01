/**
 * Settings → Components tab: per-component `config` editor.
 *
 * Verifies the Component config map UI added by the legacy-QA migration
 * (qa_start_command and friends now live in components[].config[]).
 *
 * Coverage: navigation, happy-path edit, persistence across reload, undo/clear.
 * Pattern: tests/e2e/ui/settings.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function uniqueProjectDir(): string {
	const dir = join(tmpdir(), `bobbit-e2e-comp-cfg-${process.env.E2E_PORT}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test.describe("Settings → Components: per-component config map", () => {
	test("navigate, edit qa_start_command, persist across reload, then clear", async ({ page }) => {
		// Create a project with a single component (default).
		const resp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Comp Cfg Test", rootPath: uniqueProjectDir() }),
		});
		expect(resp.ok).toBe(true);
		const project = await resp.json();
		const projectId = project.id;

		try {
			await openApp(page);
			// (1) Navigate to the per-project Components tab.
			await navigateToHash(page, `#/settings/${projectId}/components`);
			await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });
			await expect(page.locator("[data-testid='components-tab']")).toBeVisible({ timeout: 10_000 });

			// Locate the (single) component card and expand it.
			const componentCard = page.locator("[data-testid='component-card']").first();
			await expect(componentCard).toBeVisible({ timeout: 10_000 });
			await componentCard.locator(".wf-gate-header").click();

			// (2) Happy path: add a `qa_start_command` config row.
			const componentName = await componentCard.getAttribute("data-component-name");
			expect(componentName).toBeTruthy();

			const configTable = page.locator(`[data-testid='component-config-${componentName}']`);
			await expect(configTable).toBeVisible({ timeout: 5_000 });

			// Empty state: no rows yet.
			await expect(configTable.locator("[data-testid='config-row']")).toHaveCount(0);

			// Click "Add Config Entry".
			await configTable.locator("[data-testid='add-config']").click();
			await expect(configTable.locator("[data-testid='config-row']")).toHaveCount(1);

			// Type key + value.
			const row = configTable.locator("[data-testid='config-row']").first();
			await row.locator("[data-testid='config-key']").fill("qa_start_command");
			await row.locator("[data-testid='config-value']").fill("PORT=$PORT npm start");

			// Save.
			await page.locator("[data-testid='save-components']").click();
			await expect(page.locator("[data-testid='save-status']").filter({ hasText: "Saved." })).toBeVisible({ timeout: 10_000 });

			// (3) Persistence: reload, navigate back, confirm row survives.
			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
			await navigateToHash(page, `#/settings/${projectId}/components`);
			await expect(page.locator("[data-testid='components-tab']")).toBeVisible({ timeout: 10_000 });
			const card2 = page.locator("[data-testid='component-card']").first();
			await card2.locator(".wf-gate-header").click();
			const cfgTable2 = page.locator(`[data-testid='component-config-${componentName}']`);
			await expect(cfgTable2.locator("[data-testid='config-row']")).toHaveCount(1);
			const row2 = cfgTable2.locator("[data-testid='config-row']").first();
			await expect(row2.locator("[data-testid='config-key']")).toHaveValue("qa_start_command");
			await expect(row2.locator("[data-testid='config-value']")).toHaveValue("PORT=$PORT npm start");

			// Server-side: GET should round-trip the config.
			const getRes = await apiFetch(`/api/projects/${projectId}/structured`);
			expect(getRes.ok).toBe(true);
			const data = await getRes.json();
			const matched = (data.components || []).find((c: any) => c.name === componentName);
			expect(matched?.config?.qa_start_command).toBe("PORT=$PORT npm start");

			// (4) Cleanup/undo: delete the row, save, confirm gone.
			await row2.locator("[data-testid='delete-config']").click();
			await expect(cfgTable2.locator("[data-testid='config-row']")).toHaveCount(0);
			await page.locator("[data-testid='save-components']").click();
			await expect(page.locator("[data-testid='save-status']").filter({ hasText: "Saved." })).toBeVisible({ timeout: 10_000 });

			const getRes2 = await apiFetch(`/api/projects/${projectId}/structured`);
			const data2 = await getRes2.json();
			const matched2 = (data2.components || []).find((c: any) => c.name === componentName);
			// Empty config map shouldn't be serialized.
			expect(matched2?.config?.qa_start_command).toBeUndefined();
		} finally {
			await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
