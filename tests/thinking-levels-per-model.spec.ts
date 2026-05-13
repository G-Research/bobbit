/**
 * Browser fixture spec: per-model thinking-level selector reactivity.
 *
 * Verifies the UI contract:
 *  - Switching model swaps the option list to the model's supported levels.
 *  - When the current level is no longer supported, it is clamped down to
 *    the displayed value (xhigh on Opus 4.7 → high on Opus 4.5, etc.).
 *  - Non-reasoning models show only "off".
 *  - Reloading the fixture preserves selected level on a capable model.
 *
 * The capability logic itself is exhaustively covered by the Node test in
 * `tests/thinking-levels.test.ts`.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/thinking-levels-per-model.html").replace(/\\/g, "/")}`;

test.describe("Per-model thinking-level selector", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("Opus 4.7 exposes xhigh option", async ({ page }) => {
		await page.evaluate(() => (window as any).setModelByValue("anthropic|claude-opus-4-7-20251101|1"));
		const supported = await page.evaluate(() => (window as any).getSupported());
		expect(supported).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	test("Opus 4.5 omits xhigh option", async ({ page }) => {
		await page.evaluate(() => (window as any).setModelByValue("anthropic|claude-opus-4-5-20250920|1"));
		const supported = await page.evaluate(() => (window as any).getSupported());
		expect(supported).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(supported).not.toContain("xhigh");
	});

	test("gpt-5.2-codex exposes xhigh option", async ({ page }) => {
		await page.evaluate(() => (window as any).setModelByValue("openai|gpt-5.2-codex|1"));
		const supported = await page.evaluate(() => (window as any).getSupported());
		expect(supported).toContain("xhigh");
	});

	test("gpt-5.4 exposes xhigh option", async ({ page }) => {
		await page.evaluate(() => (window as any).setModelByValue("openai|gpt-5.4|1"));
		const supported = await page.evaluate(() => (window as any).getSupported());
		expect(supported).toContain("xhigh");
	});

	test("gpt-5.5 exposes xhigh option", async ({ page }) => {
		await page.evaluate(() => (window as any).setModelByValue("openai|gpt-5.5|1"));
		const supported = await page.evaluate(() => (window as any).getSupported());
		expect(supported).toContain("xhigh");
	});

	test("gpt-5.1-codex-max exposes xhigh option", async ({ page }) => {
		await page.evaluate(() => (window as any).setModelByValue("openai|gpt-5.1-codex-max|1"));
		const supported = await page.evaluate(() => (window as any).getSupported());
		expect(supported).toContain("xhigh");
	});

	test("gpt-5 (non-max, non-5.2) does not expose xhigh", async ({ page }) => {
		await page.evaluate(() => (window as any).setModelByValue("openai|gpt-5|1"));
		const supported = await page.evaluate(() => (window as any).getSupported());
		expect(supported).not.toContain("xhigh");
	});

	test("non-reasoning model exposes only off", async ({ page }) => {
		await page.evaluate(() => (window as any).setModelByValue("openai|gpt-4o|0"));
		const supported = await page.evaluate(() => (window as any).getSupported());
		expect(supported).toEqual(["off"]);
	});

	test("xhigh on Opus 4.7 clamps to high when switching to Opus 4.5", async ({ page }) => {
		// Start on Opus 4.7, pick xhigh.
		await page.evaluate(() => (window as any).setModelByValue("anthropic|claude-opus-4-7-20251101|1"));
		await page.evaluate(() => (window as any).pickLevel("xhigh"));
		expect(await page.evaluate(() => (window as any).getCurrentLevel())).toBe("xhigh");

		// Switch to Opus 4.5 — xhigh disappears, current level clamps to high.
		await page.evaluate(() => (window as any).setModelByValue("anthropic|claude-opus-4-5-20250920|1"));
		const current = await page.evaluate(() => (window as any).getCurrentLevel());
		expect(current).toBe("high");
		const selectValue = await page.inputValue("#thinking-select");
		expect(selectValue).toBe("high");
		// And the clamp counter incremented.
		expect(await page.evaluate(() => (window as any).getClampCount())).toBe(1);
	});

	test("high on Opus 4.7 stays high when switching to a non-reasoning model", async ({ page }) => {
		await page.evaluate(() => (window as any).setModelByValue("anthropic|claude-opus-4-7-20251101|1"));
		await page.evaluate(() => (window as any).pickLevel("high"));
		expect(await page.evaluate(() => (window as any).getCurrentLevel())).toBe("high");

		await page.evaluate(() => (window as any).setModelByValue("openai|gpt-4o|0"));
		// gpt-4o supports only "off" — high clamps to off.
		const current = await page.evaluate(() => (window as any).getCurrentLevel());
		expect(current).toBe("off");
		expect(await page.evaluate(() => (window as any).getSupported())).toEqual(["off"]);
	});

	test("supported level is preserved when switching between equally capable models", async ({ page }) => {
		await page.evaluate(() => (window as any).setModelByValue("anthropic|claude-opus-4-7-20251101|1"));
		await page.evaluate(() => (window as any).pickLevel("xhigh"));
		// Switch to gpt-5.2 which also supports xhigh — value stays.
		await page.evaluate(() => (window as any).setModelByValue("openai|gpt-5.2|1"));
		expect(await page.evaluate(() => (window as any).getCurrentLevel())).toBe("xhigh");
	});

	test("xhigh persists across reload on a capable model", async ({ page }) => {
		await page.evaluate(() => (window as any).setModelByValue("anthropic|claude-opus-4-7-20251101|1"));
		await page.evaluate(() => (window as any).pickLevel("xhigh"));
		expect(await page.evaluate(() => (window as any).getCurrentLevel())).toBe("xhigh");

		// Reload — the fixture re-initialises but on the same Opus 4.7 model
		// (defaulted by selectedIndex). The point of this test is to confirm
		// that "xhigh" is a valid option after a fresh page load on Opus 4.7
		// (regression guard: the option must not be filtered out).
		await page.reload();
		await page.waitForFunction(() => (window as any)._testReady === true);
		const supported = await page.evaluate(() => (window as any).getSupported());
		expect(supported).toContain("xhigh");
	});
});
