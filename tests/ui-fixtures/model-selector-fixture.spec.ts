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

test.describe("ModelSelector Claude Code local runtime", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("renders ready Claude Code rows with local-runtime labeling and searchable copy", async ({ page }) => {
		await page.evaluate(() => (window as any).__setModelSelectorModels([
			{
				id: "sonnet",
				name: "Claude Code Sonnet",
				provider: "claude-code",
				api: "claude-code-runtime",
				contextWindow: 200_000,
				maxTokens: 8_192,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				authenticated: true,
				runtime: "claude-code",
				localRuntime: true,
				runtimeLabel: "Claude Code (local)",
			},
		]));
		await page.evaluate(() => (window as any).__openModelSelectorFixture());

		const row = page.locator('agent-model-selector [data-model-id="sonnet"]');
		await expect(row).toBeVisible({ timeout: 10_000 });
		await expect(row).toContainText("Claude Code Sonnet");
		await expect(row).toContainText("Local runtime");
		await expect(row).toContainText("Claude Code (local)");
		await expect(row).toContainText("Claude Code account");
		await expect(row).not.toContainText("$0");
		expect(await row.getAttribute("title")).toContain("local Claude Code CLI");

		await page.locator("agent-model-selector input").fill("local sonnet");
		await expect(row).toBeVisible();
	});

	test("renders unavailable Claude Code rows with reason-specific badge and refuses selection", async ({ page }) => {
		await page.evaluate(() => (window as any).__setModelSelectorModels([
			{
				id: "sonnet",
				name: "Claude Code Sonnet",
				provider: "claude-code",
				api: "claude-code-runtime",
				contextWindow: 200_000,
				maxTokens: 8_192,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				authenticated: false,
				sessionSelectable: false,
				sessionUnavailableReason: "Claude Code CLI was not found. Set the executable path in Settings → Models → Claude Code.",
				runtime: "claude-code",
				localRuntime: true,
				runtimeLabel: "Claude Code (local)",
			},
		]));
		await page.evaluate(() => (window as any).__openModelSelectorFixture());

		const row = page.locator('agent-model-selector [data-model-id="sonnet"]');
		await expect(row).toBeVisible({ timeout: 10_000 });
		await expect(row).toContainText("CLI missing");
		expect(await row.getAttribute("data-session-unavailable")).toBe("true");
		expect(await row.getAttribute("title")).toContain("Claude Code CLI was not found");

		await row.dispatchEvent("click");
		await page.waitForTimeout(100);
		expect(await page.evaluate(() => (window as any).__getSelectedModel())).toBeNull();
	});
});

test.describe("ModelSelector account model selectability (Google Code Assist)", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	// Pins the post-runtime behavior: an authenticated google-gemini-cli account
	// model (Code Assist) is now runnable in agent sessions, so it must render
	// normally (not disabled) and be selectable when clicked.
	test("renders authenticated google-gemini-cli account model selectable", async ({ page }) => {
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
			},
		]));
		await page.evaluate(() => (window as any).__openModelSelectorFixture());

		const row = page.locator('agent-model-selector [data-model-id="gemini-2.5-pro"]');
		await expect(row).toBeVisible({ timeout: 10_000 });

		// Not marked unavailable-for-sessions and not disabled.
		expect(await row.getAttribute("data-session-unavailable")).toBe("false");
		expect(await row.getAttribute("class")).toContain("cursor-pointer");
		expect(await row.getAttribute("class")).not.toContain("cursor-not-allowed");

		// Clicking it selects the model.
		await row.dispatchEvent("click");
		await expect.poll(() => page.evaluate(() => (window as any).__getSelectedModel()?.id)).toBe("gemini-2.5-pro");
		await expect.poll(() => page.evaluate(() => (window as any).__getSelectedModel()?.provider)).toBe("google-gemini-cli");
	});

	// The generic session-unavailable mechanism still works for any model the server
	// explicitly marks sessionSelectable=false (defense-in-depth for future cases).
	test("still disables and refuses any model explicitly marked sessionSelectable=false", async ({ page }) => {
		await page.evaluate(() => (window as any).__setModelSelectorModels([
			{
				id: "some-unrunnable-model",
				name: "Unrunnable model",
				provider: "some-provider",
				api: "some-api",
				contextWindow: 1_000_000,
				maxTokens: 64_000,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				authenticated: true,
				sessionSelectable: false,
				sessionUnavailableReason: "This model can't run in agent sessions.",
			},
		]));
		await page.evaluate(() => (window as any).__openModelSelectorFixture());

		const row = page.locator('agent-model-selector [data-model-id="some-unrunnable-model"]');
		await expect(row).toBeVisible({ timeout: 10_000 });

		expect(await row.getAttribute("data-session-unavailable")).toBe("true");
		expect(await row.getAttribute("class")).toContain("cursor-not-allowed");
		expect((await row.getAttribute("title")) ?? "").toContain("can't run in agent sessions");

		await row.dispatchEvent("click");
		await page.waitForTimeout(100);
		expect(await page.evaluate(() => (window as any).__getSelectedModel())).toBeNull();
	});
});
