/**
 * Browser E2E for CompactionSummaryRenderer state transitions.
 *
 * file:// fixture — no gateway spawned. Drives the renderer directly through
 * `(window as any).applyInProgress | applyComplete | applyError`. Asserts:
 *   - in-progress → complete: card[data-state] flips, exactly one card on
 *     the page, no plaintext "Compacting context…" appears.
 *   - in-progress → error: overflow trigger pill renders "context limit",
 *     error message is visible.
 *   - layout: tokens-before label is adjacent (≤ 24px) to its value.
 *
 * Pin for the single-DOM-identity invariant — see
 * `docs/design/compaction-e2e-rich-summary.md` §7.4 (single-card lifecycle).
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/compaction-widget.html");
const BUNDLE = path.resolve("tests/fixtures/compaction-widget-bundle.js");
const ENTRY = path.resolve("tests/fixtures/compaction-widget-entry.ts");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/CompactionSummaryRenderer.ts");
const TYPES_SRC = path.resolve("src/app/compaction-types.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(RENDERER_SRC).mtimeMs,
		fs.statSync(TYPES_SRC).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				'--alias:pdfjs-dist=./tests/fixtures/empty-shim',
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

test.describe("CompactionSummaryRenderer (browser E2E)", () => {
	test("in-progress → complete: same card, no plaintext placeholder", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => (window as any).applyInProgress("overflow", 202_592));

		const card = page.locator("[data-testid='compaction-summary-card']");
		await expect(card).toHaveCount(1);
		await expect(card).toHaveAttribute("data-state", "in-progress");
		await expect(card.locator("[data-test='trigger']")).toHaveText("context limit");
		// Plaintext placeholder must NEVER appear in the rendered DOM.
		await expect(page.getByText("Compacting context…")).toHaveCount(1); // header text
		// And it must be inside the card (not a separate row).
		const stray = await page.locator("body > :not(script):not(style)").evaluateAll((els) =>
			els
				.filter((el) => !el.querySelector("[data-testid='compaction-summary-card']"))
				.filter((el) => /Compacting context/.test(el.textContent ?? ""))
				.length,
		);
		expect(stray).toBe(0);

		// Transition to complete.
		await page.evaluate(() =>
			(window as any).applyComplete({
				tokensBefore: 202_592, tokensAfter: 180_000, reductionPct: 11.2,
			}),
		);
		await expect(card).toHaveAttribute("data-state", "complete");
		await expect(page.locator("[data-testid='compaction-summary-card']")).toHaveCount(1);
		await expect(card.locator("[data-test='tokens-before']")).toContainText("tok");
		await expect(card.locator("[data-test='tokens-after']")).toContainText("tok");
		await expect(card.locator("[data-test='reduction-pct']")).toContainText("%");
	});

	test("in-progress → error: overflow trigger pill, error message visible", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => (window as any).applyInProgress("overflow", null));
		const card = page.locator("[data-testid='compaction-summary-card']");
		await expect(card).toHaveAttribute("data-state", "in-progress");

		await page.evaluate(() => (window as any).applyError());
		await expect(card).toHaveAttribute("data-state", "error");
		await expect(card.locator("[data-test='trigger']")).toHaveText("context limit");
		await expect(card.locator("[data-test='error']")).toContainText("202592 tokens");
		// Still exactly one card on the page.
		await expect(page.locator("[data-testid='compaction-summary-card']")).toHaveCount(1);
	});

	test("layout: tokens-before label sits adjacent to its value", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() =>
			(window as any).applyComplete({
				tokensBefore: 12_500, tokensAfter: 3_000, reductionPct: 76,
			}),
		);
		const gap = await page.evaluate(() => {
			const value = document.querySelector("[data-test='tokens-before']") as HTMLElement | null;
			if (!value) return -1;
			// The label sits as the previous-sibling span inside the same wrapper.
			const wrapper = value.parentElement!;
			const label = wrapper.querySelector(".uppercase") as HTMLElement | null;
			if (!label) return -1;
			const lr = label.getBoundingClientRect();
			const vr = value.getBoundingClientRect();
			return Math.abs(vr.left - lr.right);
		});
		expect(gap).toBeGreaterThanOrEqual(0);
		expect(gap).toBeLessThanOrEqual(24);
	});

	test("manual trigger pill renders 'manual', auto renders 'auto'", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => (window as any).applyComplete({ trigger: "manual" }));
		await expect(page.locator("[data-test='trigger']")).toHaveText("manual");
		await page.evaluate(() => (window as any).applyComplete({ trigger: "auto" }));
		await expect(page.locator("[data-test='trigger']")).toHaveText("auto");
	});
});
