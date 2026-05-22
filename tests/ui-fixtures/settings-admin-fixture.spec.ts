import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/settings-admin-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "settings-admin-fixture-bundle.js");

const SETTINGS_SRC = path.resolve("src/app/settings-page.ts");
const ROLE_MANAGER_SRC = path.resolve("src/app/role-manager-page.ts");
const TOOL_MANAGER_SRC = path.resolve("src/app/tool-manager-page.ts");
const WORKFLOW_SRC = path.resolve("src/app/workflow-page.ts");
const CONFIG_SCOPE_SRC = path.resolve("src/app/config-scope.ts");
const COMPONENTS_EDITOR_SRC = path.resolve("src/app/components-editor.ts");
const IMAGE_SELECTOR_SRC = path.resolve("src/ui/dialogs/ImageModelSelector.ts");

const TEST_MODEL = "anthropic/claude-opus-4-1";
const TEST_THINKING = "high";

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [
			ENTRY,
			SETTINGS_SRC,
			ROLE_MANAGER_SRC,
			TOOL_MANAGER_SRC,
			WORKFLOW_SRC,
			CONFIG_SCOPE_SRC,
			COMPONENTS_EDITOR_SRC,
			IMAGE_SELECTOR_SRC,
		],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__settingsAdminReady === true, null, { timeout: 10_000 });
}

async function reloadFixture(page: Page): Promise<void> {
	await page.reload();
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__settingsAdminReady === true, null, { timeout: 10_000 });
}

async function resetFixture(page: Page, opts: Record<string, unknown> = {}): Promise<void> {
	await page.evaluate((o) => (window as any).__resetSettingsAdminFixture(o), opts);
}

async function renderSettings(page: Page, hash: string): Promise<void> {
	await page.evaluate((h) => (window as any).__renderSettingsAdminSettings(h), hash);
}

async function loadRoles(page: Page, hash = "#/roles"): Promise<void> {
	await page.evaluate((h) => (window as any).__loadSettingsAdminRoles(h), hash);
}

async function loadTools(page: Page, hash = "#/tools"): Promise<void> {
	await page.evaluate((h) => (window as any).__loadSettingsAdminTools(h), hash);
}

async function prefs(page: Page): Promise<Record<string, any>> {
	return await page.evaluate(() => (window as any).__getSettingsAdminPrefs());
}

test.describe("Settings/admin UI fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
		await resetFixture(page);
	});

	test("settings tabs, account providers, and project scope render without a gateway", async ({ page }) => {
		await renderSettings(page, "#/settings/system/general");
		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible();
		await expect(page.getByText("Show message timestamps")).toBeVisible();

		await page.locator("button").filter({ hasText: "Models" }).first().click();
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/settings/system/models");
		await expect(page.locator("[data-testid='models-tab']")).toBeVisible();

		await page.locator("button").filter({ hasText: "Shortcuts" }).first().click();
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/settings/system/shortcuts");

		await page.locator("button").filter({ hasText: "Color Palette" }).first().click();
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/settings/system/palette");

		await renderSettings(page, "#/settings/system/account");
		await expect(page.getByText("Anthropic OAuth")).toBeVisible();
		await expect(page.getByText("OpenAI OAuth")).toBeVisible();
		await expect(page.getByText("ChatGPT subscription GPT models")).toBeVisible();
		await expect(page.getByText("Authenticated", { exact: true })).toBeVisible();
		await expect(page.getByText("Not authenticated", { exact: true })).toBeVisible();

		await renderSettings(page, "#/settings/proj-1/appearance");
		await expect(page.locator("button").filter({ hasText: "Scope UI Project" })).toBeVisible();
		await expect(page.locator("button").filter({ hasText: "Appearance" })).toBeVisible();
		await expect(page.getByText("Palette").first()).toBeVisible();
	});

	test("general preferences persist across reload and reset clears the skills budget", async ({ page }) => {
		await renderSettings(page, "#/settings/system/general");
		const timestamps = page.locator("label").filter({ hasText: "Show message timestamps" }).locator("input");
		const playFinish = page.locator("[data-testid='general-play-finish-sound']");
		const budget = page.locator("[data-testid='general-skills-catalog-budget']");
		const reset = page.locator("[data-testid='general-skills-catalog-budget-reset']");

		await expect(timestamps).not.toBeChecked();
		await expect(playFinish).toBeChecked();
		await expect(budget).toHaveValue("16");
		await expect(reset).toBeDisabled();

		await timestamps.click();
		await expect(timestamps).toBeChecked();
		await expect.poll(async () => (await prefs(page)).showTimestamps).toBe(true);

		await playFinish.click();
		await expect(playFinish).not.toBeChecked();
		await expect.poll(() => page.evaluate(() => document.documentElement.dataset.playAgentFinishSound)).toBe("false");
		await expect.poll(async () => (await prefs(page)).playAgentFinishSound).toBe(false);

		await budget.fill("32");
		await budget.blur();
		await expect(reset).toBeEnabled();
		await expect.poll(async () => (await prefs(page)).skillsCatalogBudget).toBe(32 * 1024);

		await reloadFixture(page);
		await renderSettings(page, "#/settings/system/general");
		const timestampsAfter = page.locator("label").filter({ hasText: "Show message timestamps" }).locator("input");
		const playAfter = page.locator("[data-testid='general-play-finish-sound']");
		const budgetAfter = page.locator("[data-testid='general-skills-catalog-budget']");
		const resetAfter = page.locator("[data-testid='general-skills-catalog-budget-reset']");

		await expect(timestampsAfter).toBeChecked();
		await expect(playAfter).not.toBeChecked();
		await expect(budgetAfter).toHaveValue("32");

		await resetAfter.click();
		await expect(budgetAfter).toHaveValue("16");
		await expect(resetAfter).toBeDisabled();
		await expect.poll(async () => (await prefs(page)).skillsCatalogBudget).toBeUndefined();
	});

	test("account login buttons all disable while any OAuth flow is in flight", async ({ page }) => {
		await renderSettings(page, "#/settings/system/account");
		const loginButtons = page.locator("button").filter({ hasText: /Log in|Re-authenticate|Authenticating/ });
		await expect(loginButtons.first()).toBeVisible();
		await expect(loginButtons).toHaveCount(2);
		for (let i = 0; i < await loginButtons.count(); i++) {
			await expect(loginButtons.nth(i)).toBeEnabled();
		}

		await loginButtons.first().click();
		const disabledButtons = page.locator("button").filter({ hasText: /Log in|Re-authenticate|Authenticating/ });
		await expect(disabledButtons).toHaveCount(2);
		for (let i = 0; i < await disabledButtons.count(); i++) {
			await expect(disabledButtons.nth(i)).toBeDisabled();
		}
	});

	test("components tab edits and persists per-component config rows", async ({ page }) => {
		await renderSettings(page, "#/settings/proj-1/components");
		await expect(page.locator("[data-testid='components-tab']")).toBeVisible();

		const componentCard = page.locator("[data-testid='component-card']").first();
		await expect(componentCard).toBeVisible();
		await componentCard.locator(".wf-gate-header").click();

		const configTable = page.locator("[data-testid='component-config-app']");
		await expect(configTable).toBeVisible();
		await expect(configTable.locator("[data-testid='config-row']")).toHaveCount(0);

		await configTable.locator("[data-testid='add-config']").click();
		const row = configTable.locator("[data-testid='config-row']").first();
		await row.locator("[data-testid='config-key']").fill("qa_start_command");
		await row.locator("[data-testid='config-value']").fill("PORT=$PORT npm start");
		await page.locator("[data-testid='save-components']").click();
		await expect(page.locator("[data-testid='save-status']").filter({ hasText: "Saved." })).toBeVisible();
		await expect.poll(async () => page.evaluate(() => (window as any).__getSettingsAdminStructured("proj-1").components[0].config.qa_start_command))
			.toBe("PORT=$PORT npm start");

		await reloadFixture(page);
		await renderSettings(page, "#/settings/proj-1/components");
		const cardAfter = page.locator("[data-testid='component-card']").first();
		await cardAfter.locator(".wf-gate-header").click();
		const tableAfter = page.locator("[data-testid='component-config-app']");
		await expect(tableAfter.locator("[data-testid='config-row']")).toHaveCount(1);
		await expect(tableAfter.locator("[data-testid='config-key']")).toHaveValue("qa_start_command");
		await expect(tableAfter.locator("[data-testid='config-value']")).toHaveValue("PORT=$PORT npm start");

		await tableAfter.locator("[data-testid='delete-config']").click();
		await page.locator("[data-testid='save-components']").click();
		await expect.poll(async () => page.evaluate(() => (window as any).__getSettingsAdminStructured("proj-1").components[0].config?.qa_start_command))
			.toBeUndefined();
	});

	test("image model picker navigates, selects, persists, flags stale prefs, and clears", async ({ page }) => {
		await renderSettings(page, "#/settings/system/models");
		const row = page.locator("[data-testid='image-model-row']").first();
		await expect(row).toBeVisible();
		await expect(row).toContainText("Auto");

		await row.locator("button").first().click();
		const target = page.locator("image-model-selector [data-image-model-item]", {
			hasText: "imagen-4.0-fast-generate-001",
		}).first();
		await expect(target).toBeVisible();
		await target.click();
		await expect(row).toContainText("imagen-4.0-fast-generate-001");
		await expect.poll(async () => (await prefs(page))["default.imageModel"]).toBe("google/imagen-4.0-fast-generate-001");

		await reloadFixture(page);
		await renderSettings(page, "#/settings/system/models");
		const rowAfter = page.locator("[data-testid='image-model-row']").first();
		await expect(rowAfter).toContainText("imagen-4.0-fast-generate-001");

		await resetFixture(page, { prefs: { "default.imageModel": "openai/this-model-does-not-exist" } });
		await reloadFixture(page);
		await renderSettings(page, "#/settings/system/models");
		const staleRow = page.locator("[data-testid='image-model-row']").first();
		await expect(staleRow.locator("[data-testid='image-model-unavailable-badge']")).toBeVisible();
		await expect(staleRow).toContainText("this-model-does-not-exist");

		await staleRow.locator("[data-testid='image-model-clear-btn']").click();
		await expect(staleRow).toContainText("Auto");
		await expect.poll(async () => (await prefs(page))["default.imageModel"]).toBeUndefined();
	});

	test("config scope rows, origin badges, tools, and embedded workflows render from fixtures", async ({ page }) => {
		await loadRoles(page);
		await expect(page.locator("button").filter({ hasText: "System" }).first()).toBeVisible();
		await expect(page.locator("button").filter({ hasText: "Scope UI Project" }).first()).toBeVisible();
		await expect(page.locator(".config-origin-badge").first()).toBeVisible();
		await expect(page.locator(".config-origin-badge").first()).toHaveText(/builtin|server|project/);

		await page.locator("button").filter({ hasText: "Scope UI Project" }).first().click();
		await expect(page.locator(".config-origin-badge").first()).toBeVisible();
		await expect.poll(async () => {
			const log = await page.evaluate(() => (window as any).__getSettingsAdminFetchLog());
			return log.some((e: any) => e.url.includes("/api/roles?projectId=proj-1"));
		}).toBe(true);

		await loadTools(page);
		await expect(page.locator("button").filter({ hasText: "System" }).first()).toBeVisible();
		await expect(page.locator(".tool-group-header").first()).toBeVisible();
		await page.locator(".tool-group-header").first().click();
		await expect(page.locator(".tool-row").first()).toBeVisible();

		await renderSettings(page, "#/settings/proj-1/workflows");
		const tab = page.locator("[data-testid='workflows-tab']").first();
		await expect(tab).toBeVisible();
		expect(await tab.locator("button").filter({ hasText: /^System$/ }).count()).toBe(0);
	});

	test("role manager model tab renders persisted overrides and saves clear", async ({ page }) => {
		await loadRoles(page, "#/roles/coder");
		await expect(page.locator(".roles-tab").filter({ hasText: "Prompt" })).toBeVisible();
		await page.locator("[data-testid='roles-tab-model']").click();
		await expect(page.locator("[data-testid='roles-model-tab']")).toBeVisible();
		await expect(page.locator("[data-testid='model-row']")).toBeVisible();

		await page.evaluate(({ model, thinking }) => {
			(window as any).__putSettingsAdminRole("coder", { model, thinkingLevel: thinking });
		}, { model: TEST_MODEL, thinking: TEST_THINKING });

		await reloadFixture(page);
		await loadRoles(page, "#/roles/coder");
		await page.locator("[data-testid='roles-tab-model']").click();
		const modelRow = page.locator("[data-testid='model-row']");
		await expect(modelRow.locator("button").filter({ hasText: "claude-opus-4-1" })).toBeVisible();
		await expect.poll(async () => {
			const roles = await page.evaluate(() => (window as any).__getSettingsAdminRoles());
			return roles.find((r: any) => r.name === "coder")?.thinkingLevel;
		}).toBe(TEST_THINKING);

		const clearBtn = modelRow.locator("[data-testid='model-clear-btn']");
		await clearBtn.click();
		await expect(clearBtn).toHaveCount(0);
		const saveBtn = page.locator("[data-testid='role-save-btn'] button").first();
		await expect(saveBtn).toBeEnabled();
		await saveBtn.click();
		await expect.poll(async () => {
			const roles = await page.evaluate(() => (window as any).__getSettingsAdminRoles());
			return roles.find((r: any) => r.name === "coder")?.model ?? "";
		}).toBe("");

		await page.evaluate(() => (window as any).__putSettingsAdminRole("coder", { thinkingLevel: "" }));
		await expect.poll(async () => {
			const roles = await page.evaluate(() => (window as any).__getSettingsAdminRoles());
			const coder = roles.find((r: any) => r.name === "coder");
			return [coder?.model ?? "", coder?.thinkingLevel ?? ""];
		}).toEqual(["", ""]);
	});
});
