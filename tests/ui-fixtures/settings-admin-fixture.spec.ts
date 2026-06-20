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

// Distinct session/review default model prefs so the Roles list inherited-display
// heuristic (REVIEW_DEFAULT_ROLE_NAMES → default.reviewModel; others →
// default.sessionModel) is observable per-row. `coder` is a normal role (session
// default); `reviewer` is in the review-default allowlist (review default).
const SESSION_DEFAULT_MODEL = "openai/gpt-4o";
const SESSION_DEFAULT_LABEL = "gpt-4o";
const REVIEW_DEFAULT_MODEL = "anthropic/claude-sonnet";
const REVIEW_DEFAULT_LABEL = "claude-sonnet";

// Shared selectors for the relocated model controls (agreed design hooks).
const LIST_MODEL_CONTROL = "[data-testid='role-row-model-control']";
const DETAIL_MODEL_SECTION = "[data-testid='roles-model-section']";

function roleRow(page: Page, name: string) {
	return page.locator(`.role-row[data-role-name='${name}']`);
}

async function storedRole(page: Page, name: string): Promise<any> {
	return await page.evaluate((n) => (window as any).__getSettingsAdminRoles().find((r: any) => r.name === n), name);
}

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
		await expect(page.getByText("Google OAuth")).toBeVisible();
		await expect(page.getByText("ChatGPT subscription GPT models")).toBeVisible();
		await expect(page.getByTestId("account-status-anthropic")).toHaveText("Authenticated");
		await expect(page.getByTestId("account-status-openai-codex")).toHaveText("Not authenticated");
		await expect(page.getByTestId("account-status-google-gemini-cli")).toHaveText("Not authenticated");

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

		// Show message timestamps defaults ON (only an explicit `false` opts out).
		await expect(timestamps).toBeChecked();
		await expect(playFinish).toBeChecked();
		await expect(budget).toHaveValue("16");
		await expect(reset).toBeDisabled();

		await timestamps.click();
		await expect(timestamps).not.toBeChecked();
		await expect.poll(async () => (await prefs(page)).showTimestamps).toBe(false);

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

		await expect(timestampsAfter).not.toBeChecked();
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
		await expect(loginButtons).toHaveCount(3);
		for (let i = 0; i < await loginButtons.count(); i++) {
			await expect(loginButtons.nth(i)).toBeEnabled();
		}

		await loginButtons.first().click();
		const disabledButtons = page.locator("button").filter({ hasText: /Log in|Re-authenticate|Authenticating/ });
		await expect(disabledButtons).toHaveCount(3);
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

	test("role manager Model section renders persisted overrides and saves clear", async ({ page }) => {
		await loadRoles(page, "#/roles/coder");
		// Tab bar is now Prompt + Tool Access only — Model is its own section.
		await expect(page.locator(".roles-tab").filter({ hasText: "Prompt" })).toBeVisible();
		await expect(page.locator("[data-testid='roles-tab-model']")).toHaveCount(0);
		const section = page.locator(DETAIL_MODEL_SECTION);
		await expect(section).toBeVisible();
		// The explanatory note text is preserved inside the section.
		await expect(section.locator("[data-testid='roles-model-tab']")).toBeVisible();
		await expect(section.locator("[data-testid='model-row']")).toBeVisible();

		await page.evaluate(({ model, thinking }) => {
			(window as any).__putSettingsAdminRole("coder", { model, thinkingLevel: thinking });
		}, { model: TEST_MODEL, thinking: TEST_THINKING });

		await reloadFixture(page);
		await loadRoles(page, "#/roles/coder");
		const modelRow = page.locator(`${DETAIL_MODEL_SECTION} [data-testid='model-row']`);
		await expect(modelRow.locator("button").filter({ hasText: "claude-opus-4-1" })).toBeVisible();
		await expect.poll(async () => (await storedRole(page, "coder"))?.thinkingLevel).toBe(TEST_THINKING);

		const clearBtn = modelRow.locator("[data-testid='model-clear-btn']");
		await clearBtn.click();
		await expect(clearBtn).toHaveCount(0);
		const saveBtn = page.locator("[data-testid='role-save-btn'] button").first();
		await expect(saveBtn).toBeEnabled();
		await saveBtn.click();
		await expect.poll(async () => (await storedRole(page, "coder"))?.model ?? "").toBe("");

		await page.evaluate(() => (window as any).__putSettingsAdminRole("coder", { thinkingLevel: "" }));
		await expect.poll(async () => {
			const coder = await storedRole(page, "coder");
			return [coder?.model ?? "", coder?.thinkingLevel ?? ""];
		}).toEqual(["", ""]);
	});

	// ────────────────────────────────────────────────────────────────────────
	// Roles model reshuffle — list view inline model + thinking control
	// (agreed hooks: role-row-model-control, data-model-state). These run the
	// real `renderRoleManagerPage()` against the fixture's role + preference
	// store, so they pin the production render path, not a mock.
	// ────────────────────────────────────────────────────────────────────────

	test("list view inherited rows show resolved default model + thinking heuristic", async ({ page }) => {
		// Open Roles directly (no Settings visit first) with distinct defaults.
		await resetFixture(page, {
			prefs: {
				"default.sessionModel": SESSION_DEFAULT_MODEL,
				"default.reviewModel": REVIEW_DEFAULT_MODEL,
			},
		});
		await loadRoles(page, "#/roles");

		const coderControl = roleRow(page, "coder").locator(LIST_MODEL_CONTROL);
		const reviewerControl = roleRow(page, "reviewer").locator(LIST_MODEL_CONTROL);
		await expect(coderControl).toBeVisible();
		await expect(reviewerControl).toBeVisible();

		// Both rows are inherited (no per-role override).
		await expect(coderControl).toHaveAttribute("data-model-state", "inherited");
		await expect(reviewerControl).toHaveAttribute("data-model-state", "inherited");

		// Heuristic: coder (normal) → session default; reviewer (review allowlist) →
		// review default. Each shown as "<model> · default".
		await expect(coderControl).toContainText(SESSION_DEFAULT_LABEL);
		await expect(coderControl).toContainText(/·\s*default/);
		await expect(reviewerControl).toContainText(REVIEW_DEFAULT_LABEL);
		await expect(reviewerControl).toContainText(/·\s*default/);

		// Inherited rows expose neither clear nor Test (modelValue is empty).
		await expect(coderControl.locator("[data-testid='model-clear-btn']")).toHaveCount(0);
		await expect(coderControl.locator("[data-testid='model-test-btn']")).toHaveCount(0);
		await expect(reviewerControl.locator("[data-testid='model-clear-btn']")).toHaveCount(0);
	});

	test("list view inherited rows fall back to default label when prefs unset", async ({ page }) => {
		// No session/review default prefs configured → still suffixed as a default.
		await resetFixture(page, { prefs: {} });
		await loadRoles(page, "#/roles");
		const coderControl = roleRow(page, "coder").locator(LIST_MODEL_CONTROL);
		await expect(coderControl).toHaveAttribute("data-model-state", "inherited");
		await expect(coderControl).toContainText(/·\s*default/);
		await expect(coderControl.locator("[data-testid='model-clear-btn']")).toHaveCount(0);
	});

	test("list view inline model pick + thinking auto-saves and persists across reload", async ({ page }) => {
		await resetFixture(page, { prefs: { "default.sessionModel": SESSION_DEFAULT_MODEL } });
		await loadRoles(page, "#/roles");

		const control = roleRow(page, "coder").locator(LIST_MODEL_CONTROL);
		await expect(control).toHaveAttribute("data-model-state", "inherited");

		// Pick a model inline. Interacting with the control must NOT navigate to the
		// editor (design requires stopPropagation on the inline container).
		await control.locator("[data-testid='model-row'] button[title='Choose model']").click();
		await page.locator(`agent-model-selector [data-model-id="claude-opus-4-1"]`).dispatchEvent("click");

		// Auto-saved: stored role gains the model, no Save button needed.
		await expect.poll(async () => (await storedRole(page, "coder"))?.model ?? "").toBe(TEST_MODEL);
		// Stayed on the list (no navigation to #/roles/coder).
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/roles");

		// Override hooks now present: state flips and clear/Test appear.
		await expect(control).toHaveAttribute("data-model-state", "override");
		await expect(control.locator("[data-testid='model-clear-btn']")).toBeVisible();
		await expect(control.locator("[data-testid='model-test-btn']")).toBeVisible();

		// Change thinking now that an override is active → auto-saves.
		await control.locator("[data-testid='model-row'] button[role='combobox']").click();
		await page.getByRole("option", { name: "High", exact: true }).click();
		await expect.poll(async () => (await storedRole(page, "coder"))?.thinkingLevel ?? "").toBe(TEST_THINKING);

		// Persist across reload.
		await reloadFixture(page);
		await loadRoles(page, "#/roles");
		const control2 = roleRow(page, "coder").locator(LIST_MODEL_CONTROL);
		await expect(control2).toHaveAttribute("data-model-state", "override");
		await expect(control2.locator("[data-testid='model-row']")).toContainText("claude-opus-4-1");
		const after = await storedRole(page, "coder");
		expect([after?.model ?? "", after?.thinkingLevel ?? ""]).toEqual([TEST_MODEL, TEST_THINKING]);
	});

	test("list view clearing an override reverts model + thinking to inherited", async ({ page }) => {
		await resetFixture(page, {
			prefs: { "default.sessionModel": SESSION_DEFAULT_MODEL },
			roles: [
				{
					name: "coder", label: "Coder", promptTemplate: "You write code.",
					accessory: "none", toolPolicies: {}, model: TEST_MODEL, thinkingLevel: TEST_THINKING,
					createdAt: 1, updatedAt: 1, origin: "builtin",
				} as any,
			],
		});
		await loadRoles(page, "#/roles");

		const control = roleRow(page, "coder").locator(LIST_MODEL_CONTROL);
		await expect(control).toHaveAttribute("data-model-state", "override");
		const clearBtn = control.locator("[data-testid='model-clear-btn']");
		await expect(clearBtn).toBeVisible();

		await clearBtn.click();

		// Both model and thinking revert to empty so the row inherits/defaults.
		await expect.poll(async () => {
			const c = await storedRole(page, "coder");
			return [c?.model ?? "", c?.thinkingLevel ?? ""];
		}).toEqual(["", ""]);

		// Row flips back to inherited display.
		await expect(control).toHaveAttribute("data-model-state", "inherited");
		await expect(control).toContainText(SESSION_DEFAULT_LABEL);
		await expect(control).toContainText(/·\s*default/);
		await expect(control.locator("[data-testid='model-clear-btn']")).toHaveCount(0);
	});

	// ────────────────────────────────────────────────────────────────────────
	// Roles model reshuffle — detail editor layout
	// ────────────────────────────────────────────────────────────────────────

	test("detail editor renders Model as a section between Accessory and the tabs", async ({ page }) => {
		await loadRoles(page, "#/roles/coder");

		const section = page.locator(DETAIL_MODEL_SECTION);
		await expect(section).toBeVisible();
		// No Model tab; tab bar is exactly Prompt + Tool Access.
		await expect(page.locator("[data-testid='roles-tab-model']")).toHaveCount(0);
		const tabs = page.locator(".roles-tab-bar .roles-tab");
		await expect(tabs).toHaveCount(2);
		await expect(tabs.nth(0)).toHaveText("Prompt");
		await expect(tabs.nth(1)).toHaveText("Tool Access");

		// Vertical order: Accessory section → Model section → tab bar.
		const order = await page.evaluate(() => {
			const top = (el: Element | null | undefined) => (el ? el.getBoundingClientRect().top : null);
			const accessory = Array.from(document.querySelectorAll(".roles-section-title"))
				.find((e) => e.textContent?.trim() === "Accessory");
			return {
				accessory: top(accessory),
				model: top(document.querySelector("[data-testid='roles-model-section']")),
				tabBar: top(document.querySelector(".roles-tab-bar")),
			};
		});
		expect(order.accessory).not.toBeNull();
		expect(order.model).not.toBeNull();
		expect(order.tabBar).not.toBeNull();
		expect(order.accessory!).toBeLessThan(order.model!);
		expect(order.model!).toBeLessThan(order.tabBar!);
	});

	test("detail editor model edit is draft-based and persists via Save", async ({ page }) => {
		await loadRoles(page, "#/roles/coder");
		const section = page.locator(DETAIL_MODEL_SECTION);
		await expect(section).toBeVisible();

		// Pick a model in the section.
		await section.locator("[data-testid='model-row'] button[title='Choose model']").click();
		await page.locator(`agent-model-selector [data-model-id="claude-opus-4-1"]`).dispatchEvent("click");

		// Detail = Save button, NOT auto-save: the stored role is unchanged until Save.
		await expect(section.locator("[data-testid='model-row']")).toContainText("claude-opus-4-1");
		expect((await storedRole(page, "coder"))?.model ?? "").toBe("");

		const saveBtn = page.locator("[data-testid='role-save-btn'] button").first();
		await expect(saveBtn).toBeEnabled();
		await saveBtn.click();
		await expect.poll(async () => (await storedRole(page, "coder"))?.model ?? "").toBe(TEST_MODEL);

		// Persists across reload, still shown in the Model section.
		await reloadFixture(page);
		await loadRoles(page, "#/roles/coder");
		await expect(page.locator(`${DETAIL_MODEL_SECTION} [data-testid='model-row']`)).toContainText("claude-opus-4-1");
	});

	// ────────────────────────────────────────────────────────────────────────
	// Roles model reshuffle — Save hang regression
	//
	// Reproduces the race where handleSave's success path calls setHashRoute to a
	// hash that is already current (no-op → no hashchange → no rerender), leaving
	// the Save button stuck on "Saving…". Fails against the pre-fix code; passes
	// once handleSave calls renderApp() in the success path.
	// ────────────────────────────────────────────────────────────────────────

	test("Save button returns from Saving… to idle after a successful save without navigating", async ({ page }) => {
		await loadRoles(page, "#/roles/coder");
		const hashBefore = await page.evaluate(() => window.location.hash);

		// Edit the Label field (first text input in the editor) to enable Save.
		const labelInput = page.locator("[data-testid='role-editor'] input").first();
		await labelInput.fill("Coder Edited");

		const saveBtn = page.locator("[data-testid='role-save-btn'] button").first();
		await expect(saveBtn).toBeEnabled();
		await expect(saveBtn).toHaveText("Save");

		await saveBtn.click();

		// Gate on the success path running fully: the PUT, then the post-save role
		// refetch (GET /api/roles). Both happen in the buggy and fixed builds, so by
		// this point `saving` has been left true (buggy) or reset to false (fixed).
		// `renderApp` coalesces through requestAnimationFrame, so the PUT logs before
		// the "Saving…" paint — gating on the PUT alone would race the pre-render
		// idle "Save" and falsely pass.
		await expect.poll(async () => {
			const log = await page.evaluate(() => (window as any).__getSettingsAdminFetchLog());
			const putIdx = log.findIndex((e: any) => e.method === "PUT" && e.url.includes("/api/roles/coder"));
			return putIdx >= 0 && log.slice(putIdx + 1).some((e: any) => e.method === "GET" && e.url.split("?")[0] === "/api/roles");
		}).toBe(true);

		// Deterministically flush any pending rAF render (no wall-clock sleep).
		await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

		// Stable end state: fixed build re-renders to a disabled "Save"; the pre-fix
		// build leaves the button stuck on "Saving…" (no renderApp() in the
		// hash-unchanged success path), so this assertion times out → red.
		await expect(saveBtn).toHaveText("Save", { timeout: 3_000 });
		await expect(saveBtn).toBeDisabled();

		// No navigation away from the edit page.
		await expect(page.locator("[data-testid='role-editor']")).toBeVisible();
		expect(await page.evaluate(() => window.location.hash)).toBe(hashBefore);
		// The edit actually persisted.
		expect((await storedRole(page, "coder"))?.label).toBe("Coder Edited");
	});
});
