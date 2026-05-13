/**
 * Gateway-connected browser E2E for per-model thinking-level dropdown
 * behaviour in the Settings page.
 *
 * Drives `renderModelRow` in `src/app/settings-page.ts` end-to-end:
 *
 *   1. Dropdown options change with the selected model.
 *      - Opus 4.7  → exposes the "Extra high" (xhigh) option.
 *      - Opus 4.5  → "Extra high" is gone.
 *      - gpt-4o (non-reasoning) → picker is disabled.
 *   2. Selecting xhigh on Opus 4.7 persists across reload.
 *   3. When the saved pref ("xhigh") becomes unsupported on a model switch
 *      (Opus 4.7 → Opus 4.5), reloading the settings page reveals the
 *      reactive clamp: the dropdown surfaces the clamped value (high) AND
 *      persists it back via PUT /api/preferences.
 *
 * Strategy: stub /api/models so the registry reliably reports the matrix
 * this test cares about. Preferences flow through the real
 * PreferencesStore so we exercise the end-to-end PUT round-trip.
 *
 * The capability rules are pinned by `tests/thinking-levels.test.ts`.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const STUB_MODELS = [
	{ id: "claude-opus-4-7-20251101", provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000, maxTokens: 8192, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, authenticated: true, name: "Claude Opus 4.7" },
	{ id: "claude-opus-4-5-20250920", provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000, maxTokens: 8192, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, authenticated: true, name: "Claude Opus 4.5" },
	{ id: "gpt-4o", provider: "openai", api: "openai-responses", contextWindow: 128_000, maxTokens: 16_000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, authenticated: true, name: "GPT-4o" },
];

async function stubModelsEndpoint(page: Page): Promise<void> {
	await page.route(/\/api\/models(?:\?.*)?$/, async (route, req) => {
		if (req.method() === "GET") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(STUB_MODELS),
			});
			return;
		}
		await route.continue();
	});
}

async function clearPrefs(): Promise<void> {
	await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({
			"default.sessionModel": null,
			"default.sessionThinkingLevel": null,
		}),
	}).catch(() => {});
}

async function setPrefs(prefs: Record<string, string | null>): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify(prefs),
	});
	expect(resp.ok).toBe(true);
}

/** The Session row of the Models tab. */
function sessionRow(page: Page) {
	return page.locator('[data-testid="model-row"][data-row-label="Session"]');
}

/** The thinking-picker wrapper div inside the Session row (one of two possible titles). */
function thinkingWrapper(page: Page) {
	return sessionRow(page).locator(
		'div[title="Thinking level"], div[title="Selected model does not support thinking"]',
	).first();
}

/** Read the displayed thinking-level label (the visible button text). */
async function readThinkingLabel(page: Page): Promise<string> {
	const txt = await thinkingWrapper(page).locator("button").first().innerText();
	return txt.trim();
}

/** Open the thinking-level dropdown. */
async function openThinkingDropdown(page: Page): Promise<void> {
	await expect(thinkingWrapper(page)).toBeVisible({ timeout: 5_000 });
	await thinkingWrapper(page).locator("button").first().click();
}

/** Best-effort dropdown locator — different Select impls render different roles. */
function dropdownItems(page: Page, hasText: string) {
	return page.locator('[role="listbox"], [role="menu"], .select-options, ul')
		.filter({ hasText })
		.first();
}

async function gotoSettingsModels(page: Page): Promise<void> {
	await navigateToHash(page, "#/settings/system/models");
	await expect(sessionRow(page)).toBeVisible({ timeout: 15_000 });
}

test.describe("Per-model thinking-level dropdown (settings page)", () => {
	test.beforeEach(async ({ page }) => {
		await clearPrefs();
		await stubModelsEndpoint(page);
	});

	test.afterEach(async () => {
		await clearPrefs();
	});

	test("Opus 4.7 exposes Extra high; selection persists across reload", async ({ page }) => {
		await setPrefs({ "default.sessionModel": "anthropic/claude-opus-4-7-20251101" });

		await openApp(page);
		await gotoSettingsModels(page);

		// Open the menu — "Extra high" must be one of the options.
		await openThinkingDropdown(page);
		const menu = dropdownItems(page, "Extra high");
		await expect(menu).toBeVisible({ timeout: 5_000 });
		await expect(menu.getByText("Off", { exact: true })).toBeVisible();
		await expect(menu.getByText("High", { exact: true })).toBeVisible();
		await expect(menu.getByText("Extra high", { exact: true })).toBeVisible();

		// Pick "Extra high"; wait for the PUT to persist.
		const putResp = page.waitForResponse(
			(resp) =>
				resp.url().includes("/api/preferences") &&
				resp.request().method() === "PUT" &&
				resp.status() === 200 &&
				/xhigh/.test(resp.request().postData() ?? ""),
			{ timeout: 10_000 },
		);
		await menu.getByText("Extra high", { exact: true }).click();
		await putResp;

		// Button label flips.
		await expect.poll(() => readThinkingLabel(page), { timeout: 5_000 }).toBe("Extra high");

		// Pref persisted server-side.
		const prefs1 = await (await apiFetch("/api/preferences")).json();
		expect(prefs1["default.sessionThinkingLevel"]).toBe("xhigh");

		// Reload — value survives.
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await gotoSettingsModels(page);
		await expect.poll(() => readThinkingLabel(page), { timeout: 10_000 }).toBe("Extra high");
	});

	test("Switching to Opus 4.5 clamps xhigh down to High and persists", async ({ page }) => {
		// Seed Opus 4.7 + xhigh.
		await setPrefs({
			"default.sessionModel": "anthropic/claude-opus-4-7-20251101",
			"default.sessionThinkingLevel": "xhigh",
		});

		await openApp(page);
		await gotoSettingsModels(page);
		await expect.poll(() => readThinkingLabel(page), { timeout: 10_000 }).toBe("Extra high");

		// Out-of-band: switch the saved model to Opus 4.5. The settings page
		// reads prefs on load, so we reload to pick up the new pref. On that
		// next render `renderModelRow` sees thinkingValue=xhigh against
		// Opus 4.5 (no xhigh) and reactively clamps to "high" — displaying
		// "High" AND persisting the clamped value via the queued
		// onThinkingChange microtask.
		await setPrefs({ "default.sessionModel": "anthropic/claude-opus-4-5-20250920" });

		const clampPut = page.waitForResponse(
			(resp) =>
				resp.url().includes("/api/preferences") &&
				resp.request().method() === "PUT" &&
				resp.status() === 200 &&
				/sessionThinkingLevel/.test(resp.request().postData() ?? "") &&
				/"high"/.test(resp.request().postData() ?? ""),
			{ timeout: 15_000 },
		);
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await gotoSettingsModels(page);

		// Reactive clamp surfaces.
		await expect.poll(() => readThinkingLabel(page), { timeout: 10_000 }).toBe("High");
		await clampPut;

		// Server pref reflects the clamp.
		const prefs = await (await apiFetch("/api/preferences")).json();
		expect(prefs["default.sessionThinkingLevel"]).toBe("high");

		// Open the menu — "Extra high" is gone, "High" is present.
		await openThinkingDropdown(page);
		const menu = dropdownItems(page, "High");
		await expect(menu).toBeVisible({ timeout: 5_000 });
		await expect(menu.getByText("High", { exact: true })).toBeVisible();
		await expect(menu.getByText("Extra high", { exact: true })).toHaveCount(0);
	});

	test("Non-reasoning model disables the thinking picker", async ({ page }) => {
		await setPrefs({
			"default.sessionModel": "openai/gpt-4o",
			"default.sessionThinkingLevel": "medium",
		});

		await openApp(page);
		await gotoSettingsModels(page);

		// The wrapper carries the "does not support thinking" title and
		// the pointer-events-none class.
		const disabledWrapper = sessionRow(page).locator(
			'div[title="Selected model does not support thinking"]',
		).first();
		await expect(disabledWrapper).toBeVisible({ timeout: 5_000 });
		await expect(disabledWrapper).toHaveClass(/pointer-events-none/);
	});
});
