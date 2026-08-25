import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	apiFetch,
	expect,
	navigateToHash,
	openApp,
	registerProject,
	test,
} from "../_helpers/journey-fixture.js";

/**
 * Ported from the UI portion of the retired per-project config-directories E2E
 * spec. API persistence and native-YAML serialization remain covered by the
 * gateway lane; this journey owns only the real settings UI and reload path.
 */
test.describe("Journey: Per-project config directories", () => {
	test("adds a project-scoped directory and shows it after a hard reload", async ({ page }) => {
		const runRoot = process.env.BOBBIT_E2E_TMP_ROOT;
		if (!runRoot) throw new Error("BOBBIT_E2E_TMP_ROOT must identify the browser run root");
		const fixtureRoot = realpathSync(mkdtempSync(join(runRoot, "project-config-directories-")));
		let projectId = "";

		try {
			const project = await registerProject({
				name: `browser-config-directories-${Date.now()}`,
				rootPath: fixtureRoot,
				seedWorkflows: false,
			});
			projectId = project.id;
			const customSkillsDir = join(project.rootPath, "custom-skills");
			mkdirSync(customSkillsDir, { recursive: true });

			await openApp(page);
			await navigateToHash(page, `#/settings/${projectId}/directories`);

			await expect(page.getByText("Add Custom Path", { exact: true })).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText("Skills", { exact: true }).first()).toBeVisible();
			await expect(page.getByText("MCP", { exact: true }).first()).toBeVisible();
			await expect(page.getByText("inherits from System", { exact: true })).toHaveCount(0);

			const pathInput = page.locator("input[type='text'][placeholder*='my-config-dir'], input[type='text'][placeholder*='path']").first();
			await pathInput.fill(customSkillsDir);
			await page.locator("label").filter({ hasText: "Skills" }).locator("input[type='checkbox']").check();
			await page.getByRole("button", { name: "Add", exact: true }).click();
			await expect(page.getByText("Saved successfully.", { exact: true })).toBeVisible({ timeout: 15_000 });

			await page.reload();
			await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText("Add Custom Path", { exact: true })).toBeVisible({ timeout: 15_000 });
			const persistedPath = page.locator("code").filter({ hasText: customSkillsDir }).first();
			await expect(persistedPath).toBeVisible({ timeout: 15_000 });

			const row = persistedPath.locator("xpath=ancestor::div[contains(@class,'flex')][1]");
			await row.locator("button[title='Remove directory']").click();
			await expect(page.getByText("Saved successfully.", { exact: true })).toBeVisible({ timeout: 15_000 });
			await expect(page.locator("code").filter({ hasText: customSkillsDir })).toHaveCount(0, { timeout: 15_000 });
		} finally {
			if (projectId) {
				await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
			}
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});
