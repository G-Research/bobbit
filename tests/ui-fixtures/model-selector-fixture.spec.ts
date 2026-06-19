import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/model-selector-fixture-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "model-selector-fixture-bundle.js");

const MODEL_SELECTOR_SRC = path.resolve("src/ui/dialogs/ModelSelector.ts");
const MODEL_RANKS_SRC = path.resolve("src/shared/model-ranks.ts");

function fileUrl(file: string): string {
	return `file://${file.replace(/\\/g, "/")}`;
}

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, MODEL_SELECTOR_SRC, MODEL_RANKS_SRC],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(fileUrl(SHELL));
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__modelSelectorFixtureReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__resetModelSelectorFixture());
}

test.describe("ModelSelector Opus ordering", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("displays parsed Opus 4 minors in newest-first order and selects Opus 4.8", async ({ page }) => {
		await page.evaluate(() => (window as any).__openModelSelectorFixture());
		const items = page.locator("agent-model-selector [data-model-item]");
		await expect(items.first()).toBeVisible({ timeout: 10_000 });

		const orderedIds = await items.evaluateAll((nodes) =>
			nodes.map((node) => (node as HTMLElement).dataset.modelId),
		);
		expect(orderedIds.slice(0, 4)).toEqual([
			"claude-opus-4-10",
			"claude-opus-4-8",
			"claude-opus-4-7",
			"claude-sonnet-4-6",
		]);

		await page.locator('agent-model-selector [data-model-id="claude-opus-4-8"]').dispatchEvent("click");
		await expect.poll(() => page.evaluate(() => (window as any).__getSelectedModel()?.id)).toBe("claude-opus-4-8");
		await expect.poll(() => page.evaluate(() => `${(window as any).__getSelectedModel()?.provider}/${(window as any).__getSelectedModel()?.id}`))
			.toBe("anthropic/claude-opus-4-8");
	});
});

test.describe("ModelSelector unauthenticated tooltip (Settings-drift regression)", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	// Pins the acceptance criterion: an unauthenticated model must NOT point users
	// at the dead "Settings > Providers" path. It must reference the real current
	// Settings locations (Account / Models).
	test("locked model row tooltip avoids the dead 'Settings > Providers' path", async ({ page }) => {
		await page.evaluate(() => (window as any).__setModelSelectorModels([
			{
				id: "gemini-2.5-pro",
				name: "Gemini 2.5 Pro",
				provider: "google",
				api: "google-generative-ai",
				contextWindow: 1_000_000,
				maxTokens: 64_000,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				authenticated: false,
			},
		]));
		await page.evaluate(() => (window as any).__openModelSelectorFixture());

		const row = page.locator('agent-model-selector [data-model-id="gemini-2.5-pro"]');
		await expect(row).toBeVisible({ timeout: 10_000 });

		const title = (await row.getAttribute("title")) ?? "";
		expect(title).not.toContain("Settings > Providers");
		expect(title).toContain("Settings → Account");
		expect(title).toContain("Settings → Models");

		// The KeyRound icon's tooltip is the generic "Authentication required".
		const keyTitles = await row.locator("span[title]").evaluateAll((nodes) =>
			nodes.map((n) => (n as HTMLElement).getAttribute("title")),
		);
		expect(keyTitles).toContain("Authentication required");
		expect(keyTitles).not.toContain("API key required");
	});
});

test.describe("ModelSelector session-unavailable gating (Google Code Assist)", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	// Pins the gap mitigation: an authenticated-but-unrunnable account model
	// (google-gemini-cli Code Assist) must render visibly unavailable-for-sessions
	// and must NOT be selectable when clicked.
	test("renders google-gemini-cli model disabled and refuses to select it", async ({ page }) => {
		await page.evaluate(() => (window as any).__setModelSelectorModels([
			{
				id: "gemini-2.5-pro",
				name: "Gemini 2.5 Pro (Google account)",
				provider: "google-gemini-cli",
				api: "google-code-assist",
				contextWindow: 1_000_000,
				maxTokens: 64_000,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				authenticated: true,
				sessionSelectable: false,
				sessionUnavailableReason: "Signed in, but Google account (Code Assist) models can't run in agent sessions yet.",
			},
		]));
		await page.evaluate(() => (window as any).__openModelSelectorFixture());

		const row = page.locator('agent-model-selector [data-model-id="gemini-2.5-pro"]');
		await expect(row).toBeVisible({ timeout: 10_000 });

		// Marked unavailable-for-sessions and visibly disabled.
		expect(await row.getAttribute("data-session-unavailable")).toBe("true");
		expect(await row.getAttribute("class")).toContain("cursor-not-allowed");
		expect((await row.getAttribute("title")) ?? "").toContain("can't run in agent sessions");

		// Clicking it must NOT select the model.
		await row.dispatchEvent("click");
		await page.waitForTimeout(100);
		expect(await page.evaluate(() => (window as any).__getSelectedModel())).toBeNull();
	});
});
