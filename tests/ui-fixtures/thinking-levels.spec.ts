import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/thinking-levels-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "thinking-levels-bundle.js");
const SETTINGS_SRC = path.resolve("src/app/settings-page.ts");
const THINKING_SRC = path.resolve("src/shared/thinking-levels.ts");

const OPUS_48 = "anthropic/claude-opus-4-8-20260528";
const OPUS_48_DOTTED = "anthropic/claude-opus-4.8-20260528";
const AIGW_OPUS_48 = "aigw/claude-opus-4-8-20260528";
const AIGW_OPUS_48_DOTTED = "aigw/claude-opus-4.8-20260528";
const OPUS_45 = "anthropic/claude-opus-4-5-20250920";
const GPT_4O = "openai/gpt-4o";

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, SETTINGS_SRC, THINKING_SRC],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__thinkingLevelsReady === true, null, { timeout: 10_000 });
}

async function renderWithPrefs(page: Page, prefs: Record<string, string | null>): Promise<void> {
	await page.evaluate((p) => {
		(window as any).__setThinkingFixture({ prefs: p });
		(window as any).__renderThinkingModels();
	}, prefs);
	await waitForModelsLoaded(page);
}

async function reloadAndRender(page: Page): Promise<void> {
	await page.reload();
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__thinkingLevelsReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__renderThinkingModels());
	await waitForModelsLoaded(page);
}

async function waitForModelsLoaded(page: Page): Promise<void> {
	await expect.poll(async () => {
		const log = await page.evaluate(() => (window as any).__getThinkingFetchLog());
		return log.some((e: any) => e.url === "/api/models" && e.method === "GET");
	}, { timeout: 10_000 }).toBe(true);
	await expect(sessionRow(page)).toBeVisible({ timeout: 10_000 });
}

function sessionRow(page: Page) {
	return page.locator('[data-testid="model-row"][data-row-label="Session"]');
}

function thinkingWrapper(page: Page) {
	return sessionRow(page).locator(
		'div[title="Thinking level"], div[title="Selected model does not support thinking"]',
	).first();
}

async function readThinkingLabel(page: Page): Promise<string> {
	const txt = await thinkingWrapper(page).locator("button").first().innerText();
	return txt.trim();
}

async function openThinkingDropdown(page: Page): Promise<void> {
	await expect(thinkingWrapper(page)).toBeVisible({ timeout: 5_000 });
	await thinkingWrapper(page).locator("button").first().click();
}

function dropdownItems(page: Page, hasText: string) {
	return page.locator('[role="listbox"], [role="menu"], .select-options, ul')
		.filter({ hasText })
		.first();
}

async function setPrefs(page: Page, prefs: Record<string, string | null>): Promise<void> {
	await page.evaluate((p) => (window as any).__setThinkingPrefs(p), prefs);
}

async function getPrefs(page: Page): Promise<Record<string, string>> {
	return await page.evaluate(() => (window as any).__getThinkingPrefs());
}

test.describe("Per-model thinking-level dropdown fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("Opus 4.8 exposes Extra high; selection persists across reload", async ({ page }) => {
		await renderWithPrefs(page, { "default.sessionModel": OPUS_48 });

		await openThinkingDropdown(page);
		const menu = dropdownItems(page, "Extra high");
		await expect(menu).toBeVisible({ timeout: 5_000 });
		await expect(menu.getByText("Off", { exact: true })).toBeVisible();
		await expect(menu.getByText("High", { exact: true })).toBeVisible();
		await expect(menu.getByText("Extra high", { exact: true })).toBeVisible();

		await menu.getByText("Extra high", { exact: true }).click();
		await expect.poll(async () => {
			const prefs = await getPrefs(page);
			return prefs["default.sessionThinkingLevel"];
		}, { timeout: 5_000 }).toBe("xhigh");
		await expect.poll(() => readThinkingLabel(page), { timeout: 5_000 }).toBe("Extra high");

		await reloadAndRender(page);
		await expect.poll(() => readThinkingLabel(page), { timeout: 10_000 }).toBe("Extra high");
	});

	for (const [label, model] of [
		["dotted Opus 4.8", OPUS_48_DOTTED],
		["AIGW-routed Opus 4.8", AIGW_OPUS_48],
		["AIGW-routed dotted Opus 4.8", AIGW_OPUS_48_DOTTED],
	] as const) {
		test(`${label} exposes Extra high`, async ({ page }) => {
			await renderWithPrefs(page, { "default.sessionModel": model });

			await openThinkingDropdown(page);
			const menu = dropdownItems(page, "Extra high");
			await expect(menu).toBeVisible({ timeout: 5_000 });
			await expect(menu.getByText("Extra high", { exact: true })).toBeVisible();
		});
	}

	test("Switching to Opus 4.5 clamps xhigh down to High and persists", async ({ page }) => {
		await renderWithPrefs(page, {
			"default.sessionModel": OPUS_48,
			"default.sessionThinkingLevel": "xhigh",
		});
		await expect.poll(() => readThinkingLabel(page), { timeout: 10_000 }).toBe("Extra high");

		await setPrefs(page, { "default.sessionModel": OPUS_45 });
		await reloadAndRender(page);

		await expect.poll(() => readThinkingLabel(page), { timeout: 10_000 }).toBe("High");
		await expect.poll(async () => {
			const prefs = await getPrefs(page);
			return prefs["default.sessionThinkingLevel"];
		}, { timeout: 10_000 }).toBe("high");

		await openThinkingDropdown(page);
		const menu = dropdownItems(page, "High");
		await expect(menu).toBeVisible({ timeout: 5_000 });
		await expect(menu.getByText("High", { exact: true })).toBeVisible();
		await expect(menu.getByText("Extra high", { exact: true })).toHaveCount(0);
	});

	test("Non-reasoning model disables the thinking picker", async ({ page }) => {
		await renderWithPrefs(page, {
			"default.sessionModel": GPT_4O,
			"default.sessionThinkingLevel": "medium",
		});

		const disabledWrapper = sessionRow(page).locator(
			'div[title="Selected model does not support thinking"]',
		).first();
		await expect(disabledWrapper).toBeVisible({ timeout: 5_000 });
		await expect(disabledWrapper).toHaveClass(/pointer-events-none/);
	});
});
