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
