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

// ── Polish Roles list model rows — agreed list-control contract ─────────────
// Inherited/default sources render inline inside the shared model/thinking
// controls. Override rows rely on the filled value + in-box reset/Test buttons,
// with no redundant source captions below the control.
const LIST_MODEL_PICKER = "[data-testid='model-picker-btn']";
const LIST_THINKING_CLEAR = "[data-testid='model-thinking-clear-btn']";
const LIST_THINKING_PICKER = "[data-testid='model-row'] button[role='combobox']";

const USES_SESSION_DEFAULT = /\(Uses session default:/i;
const USES_REVIEWER_DEFAULT = /\(Uses reviewer default:/i;
const USES_AUTO_DEFAULT = /\(Uses auto default:/i;
const USES_ROLE_OVERRIDE = /\(Uses .*role override:/i;

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

	test("list view inherited rows show resolved default model + thinking inline", async ({ page }) => {
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

		// The effective model is always shown (never an icon-only / "…"-only row):
		// coder (normal) → session default; reviewer (review allowlist) → review default.
		await expect(coderControl).toContainText(SESSION_DEFAULT_LABEL);
		await expect(reviewerControl).toContainText(REVIEW_DEFAULT_LABEL);

		// Source is communicated inline inside each inherited control.
		await expect(coderControl.locator(LIST_MODEL_PICKER)).toContainText(USES_SESSION_DEFAULT);
		await expect(coderControl.locator(LIST_THINKING_PICKER)).toContainText(USES_SESSION_DEFAULT);
		await expect(reviewerControl.locator(LIST_MODEL_PICKER)).toContainText(USES_REVIEWER_DEFAULT);
		await expect(reviewerControl.locator(LIST_THINKING_PICKER)).toContainText(USES_REVIEWER_DEFAULT);

		// Inherited rows expose neither clear nor Test (modelValue is empty).
		await expect(coderControl.locator("[data-testid='model-clear-btn']")).toHaveCount(0);
		await expect(coderControl.locator("[data-testid='model-test-btn']")).toHaveCount(0);
		await expect(reviewerControl.locator("[data-testid='model-clear-btn']")).toHaveCount(0);
	});

	test("list view thinking picker has room and wraps cleanly on narrow screens", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await resetFixture(page, {
			prefs: {
				"default.sessionModel": SESSION_DEFAULT_MODEL,
				"default.reviewModel": REVIEW_DEFAULT_MODEL,
			},
		});
		await loadRoles(page, "#/roles");

		const reviewerControl = roleRow(page, "reviewer").locator(LIST_MODEL_CONTROL);
		const thinking = reviewerControl.locator(LIST_THINKING_PICKER);
		await expect(thinking).toContainText(USES_REVIEWER_DEFAULT);
		const desktopWidth = await thinking.evaluate((el) => el.getBoundingClientRect().width);
		expect(desktopWidth).toBeGreaterThanOrEqual(220);
		expect(desktopWidth).toBeLessThanOrEqual(362);
		expect(await thinking.evaluate((el) => {
			const rect = el.getBoundingClientRect();
			const svgs = Array.from(el.querySelectorAll("svg"));
			const chevron = svgs[svgs.length - 1];
			if (!chevron) return false;
			const iconRect = chevron.getBoundingClientRect();
			return iconRect.left >= rect.left && iconRect.right <= rect.right;
		})).toBe(true);

		await page.setViewportSize({ width: 390, height: 740 });
		await reloadFixture(page);
		await loadRoles(page, "#/roles");
		const row = roleRow(page, "reviewer");
		const mobileControl = row.locator(LIST_MODEL_CONTROL);
		const actions = row.locator(".role-row-actions");
		await expect(mobileControl).toBeVisible();
		await expect(actions).toBeVisible();
		const mobile = await row.evaluate((el) => {
			const rowRect = el.getBoundingClientRect();
			const control = el.querySelector("[data-testid='role-row-model-control']")?.getBoundingClientRect();
			const actions = el.querySelector(".role-row-actions")?.getBoundingClientRect();
			return control && actions ? {
				controlFitsRow: control.left >= rowRect.left && control.right <= rowRect.right,
				actionsFitRow: actions.left >= rowRect.left && actions.right <= rowRect.right,
			} : null;
		});
		expect(mobile).toEqual({ controlFitsRow: true, actionsFitRow: true });
	});

	test("list view inherited rows fall back to an Auto default label when prefs unset", async ({ page }) => {
		// No session/review default prefs configured → effective model is Auto, but
		// the row still shows a meaningful default source inline (never blank).
		await resetFixture(page, { prefs: {} });
		await loadRoles(page, "#/roles");
		const coderControl = roleRow(page, "coder").locator(LIST_MODEL_CONTROL);
		await expect(coderControl).toHaveAttribute("data-model-state", "inherited");
		await expect(coderControl).toContainText(/Auto/);
		await expect(coderControl.locator(LIST_MODEL_PICKER)).toContainText(USES_AUTO_DEFAULT);
		await expect(coderControl.locator("[data-testid='model-clear-btn']")).toHaveCount(0);
	});

	test("role-definition origin badge does not read like a model override", async ({ page }) => {
		await resetFixture(page, {
			prefs: { "default.sessionModel": SESSION_DEFAULT_MODEL },
			roles: [
				{
					name: "coder", label: "Coder", promptTemplate: "You write code.",
					accessory: "none", toolPolicies: {},
					createdAt: 1, updatedAt: 1, origin: "server", overrides: "builtin",
					modelResolution: {
						model: { value: "", source: "default", editable: true },
						thinkingLevel: { value: "", source: "default", editable: true },
					},
				} as any,
			],
		});
		await loadRoles(page, "#/roles");

		const row = roleRow(page, "coder");
		const control = row.locator(LIST_MODEL_CONTROL);
		await expect(control).toHaveAttribute("data-model-state", "inherited");
		await expect(row.locator(".role-meta")).toContainText("role definition overrides builtin");
		await expect(control.locator("[data-testid='model-clear-btn']")).toHaveCount(0);
		await expect(control.locator("[data-testid='model-test-btn']")).toHaveCount(0);
	});

	test("list view inherited role override surfaces source inline", async ({ page }) => {
		// The current scope does NOT override, but a lower (server) role layer
		// supplies the model. The server reports this via modelResolution so the
		// list can label it distinctly from a current-scope override or a default.
		await resetFixture(page, {
			prefs: { "default.sessionModel": SESSION_DEFAULT_MODEL },
			roles: [
				{
					name: "coder", label: "Coder", promptTemplate: "You write code.",
					accessory: "none", toolPolicies: {}, model: TEST_MODEL,
					createdAt: 1, updatedAt: 1, origin: "project",
					modelResolution: {
						model: { value: TEST_MODEL, source: "inherited-role", origin: "server", editable: true },
						thinkingLevel: { value: "", source: "default", editable: true },
					},
				} as any,
			],
		});
		await loadRoles(page, "#/roles");
		const control = roleRow(page, "coder").locator(LIST_MODEL_CONTROL);
		await expect(control).toBeVisible();
		// Effective model is shown.
		await expect(control).toContainText("claude-opus-4-1");
		// Distinct inherited-role source naming is shown inline.
		await expect(control.locator(LIST_MODEL_PICKER)).toContainText(USES_ROLE_OVERRIDE);
		await expect(control.locator(LIST_MODEL_PICKER)).toContainText(/Server/i);
	});

	test("list view shows inherited-role effective model + thinking inline with no clear/reset (findings #1, #2)", async ({ page }) => {
		// The role carries NO top-level model/thinkingLevel; the effective values
		// live only in modelResolution (inherited from the server role layer).
		//  - finding #1: inherited values must NOT be fed into the picker as selected
		//    local overrides (that lets renderModelRow clamp + auto-persist them as a
		//    spurious local override on render). They display as fallback text.
		//  - finding #2: inherited-role fields expose NO model-clear / thinking-reset
		//    affordances (clearing an empty local field would be a confusing no-op).
		await resetFixture(page, {
			prefs: { "default.sessionModel": SESSION_DEFAULT_MODEL },
			roles: [
				{
					name: "coder", label: "Coder", promptTemplate: "You write code.",
					accessory: "none", toolPolicies: {},
					createdAt: 1, updatedAt: 1, origin: "project",
					modelResolution: {
						model: { value: TEST_MODEL, source: "inherited-role", origin: "server", editable: true },
						thinkingLevel: { value: TEST_THINKING, source: "inherited-role", origin: "server", editable: true },
					},
				} as any,
			],
		});
		await loadRoles(page, "#/roles");

		const control = roleRow(page, "coder").locator(LIST_MODEL_CONTROL);
		await expect(control).toBeVisible();
		// Current scope did not override → the row reads as inherited, NOT override.
		await expect(control).toHaveAttribute("data-model-state", "inherited");
		// finding #1: picker displays inherited effective values as fallback text,
		// not as local overrides (so no clear/reset affordances appear).
		const modelPicker = control.locator("[data-testid='model-row'] [data-testid='model-picker-btn']");
		await expect(modelPicker).toContainText(USES_ROLE_OVERRIDE);
		await expect(modelPicker).toContainText("claude-opus-4-1");
		await expect(control.locator(LIST_THINKING_PICKER)).toContainText(USES_ROLE_OVERRIDE);
		await expect(control.locator(LIST_THINKING_PICKER)).toContainText("High");
		// finding #2: no clear/reset affordances for inherited-role fields.
		await expect(control.locator("[data-testid='model-clear-btn']")).toHaveCount(0);
		await expect(control.locator(LIST_THINKING_CLEAR)).toHaveCount(0);
	});

	test("list view rendering an inherited unsupported thinking value never auto-persists a clamped local override (finding #1)", async ({ page }) => {
		// The inherited thinking value (xhigh) is unsupported by the inherited model
		// in the registry. The old code fed it through the shared picker, whose
		// render-time clamp fired onThinkingChange and auto-saved a spurious
		// current-scope thinking override just from VIEWING the list. Now inherited
		// values bypass the editable picker, so merely rendering must persist nothing.
		await resetFixture(page, {
			prefs: { "default.sessionModel": SESSION_DEFAULT_MODEL },
			roles: [
				{
					name: "coder", label: "Coder", promptTemplate: "You write code.",
					accessory: "none", toolPolicies: {},
					createdAt: 1, updatedAt: 1, origin: "project",
					modelResolution: {
						model: { value: TEST_MODEL, source: "inherited-role", origin: "server", editable: true },
						thinkingLevel: { value: "xhigh", source: "inherited-role", origin: "server", editable: true },
					},
				} as any,
			],
		});
		await loadRoles(page, "#/roles");

		const control = roleRow(page, "coder").locator(LIST_MODEL_CONTROL);
		await expect(control).toBeVisible();
		await expect(control).toHaveAttribute("data-model-state", "inherited");

		// Give any render-time clamp microtask a chance to (wrongly) fire a save.
		await page.waitForTimeout(300);

		// Nothing was written: the role keeps no local model/thinking override.
		await expect.poll(async () => {
			const c = await storedRole(page, "coder");
			return [c?.model ?? "", c?.thinkingLevel ?? ""];
		}).toEqual(["", ""]);
	});

	test("list view thinking-only change does not promote an inherited model into an override (finding #3)", async ({ page }) => {
		// Model is inherited (no current-scope override). Changing only the thinking
		// level must persist ONLY the thinking change — it must never bake the
		// inherited model into a fresh current-scope model override.
		await resetFixture(page, {
			prefs: { "default.sessionModel": SESSION_DEFAULT_MODEL },
			roles: [
				{
					name: "coder", label: "Coder", promptTemplate: "You write code.",
					accessory: "none", toolPolicies: {},
					createdAt: 1, updatedAt: 1, origin: "project",
					modelResolution: {
						model: { value: TEST_MODEL, source: "inherited-role", origin: "server", editable: true },
						thinkingLevel: { value: "", source: "default", editable: true },
					},
				} as any,
			],
		});
		await loadRoles(page, "#/roles");

		const control = roleRow(page, "coder").locator(LIST_MODEL_CONTROL);
		await expect(control).toHaveAttribute("data-model-state", "inherited");

		// Change ONLY thinking via the inline thinking selector.
		await control.locator("[data-testid='model-row'] button[role='combobox']").click();
		await page.getByRole("option", { name: "High", exact: true }).click();

		// Only thinkingLevel is persisted; the inherited model is NOT written as an
		// override. (The persisted store is the source of truth here — the fixture's
		// GET does not recompute modelResolution the way the real server does, so we
		// assert on the stored role, which pins the finding-#3 fix precisely.)
		await expect.poll(async () => {
			const c = await storedRole(page, "coder");
			return [c?.model ?? "", c?.thinkingLevel ?? ""];
		}).toEqual(["", TEST_THINKING]);
	});

	test("list view inline model pick + thinking auto-saves and persists across reload", async ({ page }) => {
		await resetFixture(page, { prefs: { "default.sessionModel": SESSION_DEFAULT_MODEL } });
		await loadRoles(page, "#/roles");

		const control = roleRow(page, "coder").locator(LIST_MODEL_CONTROL);
		await expect(control).toHaveAttribute("data-model-state", "inherited");

		// Pick a model inline. Interacting with the control must NOT navigate to the
		// editor (design requires stopPropagation on the inline container).
		await control.locator("[data-testid='model-row'] [data-testid='model-picker-btn']").click();
		await page.locator(`agent-model-selector [data-model-id="claude-opus-4-1"]`).dispatchEvent("click");

		// Auto-saved: stored role gains the model, no Save button needed.
		await expect.poll(async () => (await storedRole(page, "coder"))?.model ?? "").toBe(TEST_MODEL);
		// Stayed on the list (no navigation to #/roles/coder).
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/roles");

		// Override hooks now present: state flips and clear/Test appear.
		await expect(control).toHaveAttribute("data-model-state", "override");
		await expect(control.locator("[data-testid='model-clear-btn']")).toBeVisible();
		await expect(control.locator("[data-testid='model-test-btn']")).toBeVisible();
		// No redundant source caption under override rows.
		await expect(control.locator("[data-testid='role-row-model-source']")).toHaveCount(0);
		await expect(control.locator("[data-testid='role-row-thinking-source']")).toHaveCount(0);

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

	test("list view rapid model-then-thinking edit does not clobber the just-picked model (save race, finding #2)", async ({ page }) => {
		// Repro for the inline save race: a user picks a model and then changes
		// thinking BEFORE the model save round-trips (customize + PUT + refetch). The
		// old fire-and-forget handler built the second PUT from the stale row object
		// (model still empty), clearing the model just selected. The pending-draft
		// merge + serialized save loop must preserve the model.
		await resetFixture(page, { prefs: { "default.sessionModel": SESSION_DEFAULT_MODEL } });
		await loadRoles(page, "#/roles");

		// Slow the role PUTs so the thinking change is dispatched while the model
		// save is still in flight (the refetch that refreshes the row has NOT run).
		// Wrapping window.fetch keeps the fixture's mock intact and avoids the
		// network layer (the app calls window.fetch directly, not page.route).
		await page.evaluate(() => {
			const orig = window.fetch;
			window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const method = (init?.method || "GET").toUpperCase();
				const url = typeof input === "string" ? input : (input as any).url ?? String(input);
				if (method === "PUT" && /\/api\/roles\//.test(url)) {
					await new Promise((r) => setTimeout(r, 400));
				}
				return orig(input, init);
			}) as typeof window.fetch;
		});

		const control = roleRow(page, "coder").locator(LIST_MODEL_CONTROL);
		await expect(control).toHaveAttribute("data-model-state", "inherited");

		// Pick a model inline — this kicks off the (now slow) save.
		await control.locator("[data-testid='model-row'] [data-testid='model-picker-btn']").click();
		await page.locator(`agent-model-selector [data-model-id="claude-opus-4-1"]`).dispatchEvent("click");

		// Immediately change thinking, WITHOUT waiting for the model save to settle.
		await control.locator("[data-testid='model-row'] button[role='combobox']").click();
		await page.getByRole("option", { name: "High", exact: true }).click();

		// Both edits must land: the model is preserved (not clobbered with "") and
		// the thinking override is applied. On the pre-fix code the model ends "".
		await expect.poll(async () => {
			const c = await storedRole(page, "coder");
			return [c?.model ?? "", c?.thinkingLevel ?? ""];
		}).toEqual([TEST_MODEL, TEST_THINKING]);

		// And the row reflects the override end-state.
		await expect(control).toHaveAttribute("data-model-state", "override");
		await expect(control.locator("[data-testid='role-row-model-source']")).toHaveCount(0);
		await expect(control.locator("[data-testid='role-row-thinking-source']")).toHaveCount(0);
	});

	test("list view clearing the model preserves an existing thinking override (finding #1)", async ({ page }) => {
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

		// Clearing the model must NOT write thinkingLevel:"" — the thinking
		// override is preserved (it is reset only by its own control).
		await expect.poll(async () => {
			const c = await storedRole(page, "coder");
			return [c?.model ?? "", c?.thinkingLevel ?? ""];
		}).toEqual(["", TEST_THINKING]);

		// Row drops to a first-class thinking-only override: model now inherits the
		// session default, thinking is still a Role override with its own reset.
		await expect(control).toHaveAttribute("data-model-state", /thinking-override|partial-override/);
		await expect(control).toContainText(SESSION_DEFAULT_LABEL);
		await expect(control.locator(LIST_MODEL_PICKER)).toContainText(USES_SESSION_DEFAULT);
		await expect(control.locator(LIST_THINKING_PICKER)).toContainText("High");
		await expect(control.locator("[data-testid='model-clear-btn']")).toHaveCount(0);

		// The dedicated thinking reset then clears the remaining override → fully inherited.
		await control.locator(LIST_THINKING_CLEAR).click();
		await expect.poll(async () => {
			const c = await storedRole(page, "coder");
			return [c?.model ?? "", c?.thinkingLevel ?? ""];
		}).toEqual(["", ""]);
		await expect(control).toHaveAttribute("data-model-state", "inherited");
	});

	test("list view thinking-only override is visible, editable, and clearable without a model override", async ({ page }) => {
		// A role with a thinking override but NO model override. The old behavior
		// hid this (rendered as a plain inherited row); the polished list must show
		// it as a first-class state with the inherited/default model still visible.
		await resetFixture(page, {
			prefs: { "default.sessionModel": SESSION_DEFAULT_MODEL },
			roles: [
				{
					name: "coder", label: "Coder", promptTemplate: "You write code.",
					accessory: "none", toolPolicies: {}, thinkingLevel: TEST_THINKING,
					createdAt: 1, updatedAt: 1, origin: "builtin",
				} as any,
			],
		});
		await loadRoles(page, "#/roles");

		const control = roleRow(page, "coder").locator(LIST_MODEL_CONTROL);
		await expect(control).toBeVisible();
		// First-class thinking-only state (accept either agreed spelling).
		await expect(control).toHaveAttribute("data-model-state", /thinking-override|partial-override/);
		// Model still resolves to the inherited default — never an icon-only row.
		await expect(control).toContainText(SESSION_DEFAULT_LABEL);
		await expect(control.locator(LIST_MODEL_PICKER)).toContainText(USES_SESSION_DEFAULT);
		// Thinking is clearly an override and exposes an independent reset.
		await expect(control.locator(LIST_THINKING_PICKER)).toContainText("High");
		const thinkingClear = control.locator(LIST_THINKING_CLEAR);
		await expect(thinkingClear).toBeVisible();

		await thinkingClear.click();

		// Clearing thinking only resets thinking; model was never overridden.
		await expect.poll(async () => {
			const c = await storedRole(page, "coder");
			return [c?.model ?? "", c?.thinkingLevel ?? ""];
		}).toEqual(["", ""]);
		// Row reverts to a fully inherited display.
		await expect(control).toHaveAttribute("data-model-state", "inherited");
		await expect(control.locator(LIST_THINKING_PICKER)).toContainText(USES_SESSION_DEFAULT);
	});

	test("list view read-only pack role shows its source + effective values and no edit affordances", async ({ page }) => {
		// A role installed from a market pack is read-only: it must still show the
		// effective model + thinking and explain WHY it cannot be edited inline.
		await resetFixture(page, {
			prefs: { "default.sessionModel": SESSION_DEFAULT_MODEL },
			roles: [
				{
					name: "researcher", label: "Researcher", promptTemplate: "You research.",
					accessory: "none", toolPolicies: {}, model: TEST_MODEL, thinkingLevel: TEST_THINKING,
					createdAt: 1, updatedAt: 1, origin: "server", originPackName: "research-pack",
					modelResolution: {
						model: { value: TEST_MODEL, source: "inherited-role", originPackName: "research-pack", editable: false },
						thinkingLevel: { value: TEST_THINKING, source: "inherited-role", originPackName: "research-pack", editable: false },
					},
				} as any,
			],
		});
		await loadRoles(page, "#/roles");

		const control = roleRow(page, "researcher").locator(LIST_MODEL_CONTROL);
		await expect(control).toBeVisible();
		await expect(control).toHaveAttribute("data-model-state", "readonly");
		// Effective model + thinking remain visible.
		await expect(control).toContainText("claude-opus-4-1");
		// The reason names the managing pack.
		await expect(control).toContainText(/Managed by pack research-pack/);
		// No inline mutation affordances on a read-only pack row.
		await expect(control.locator("[data-testid='model-clear-btn']")).toHaveCount(0);
		await expect(control.locator(LIST_THINKING_CLEAR)).toHaveCount(0);
		await expect(control.locator("[data-testid='model-row'] [data-testid='model-picker-btn']")).toHaveCount(0);
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
		await section.locator("[data-testid='model-row'] [data-testid='model-picker-btn']").click();
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
