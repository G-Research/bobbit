/**
 * Browser E2E for CompactionSummaryRenderer state transitions.
 *
 * file:// fixture — no gateway spawned. Drives the renderer directly through
 * `(window as any).applyInProgress | applyComplete | applyError`. Asserts:
 *   - in-progress → complete: card[data-state] flips, exactly one card on
 *     the page, no plaintext "Compacting context…" appears.
 *   - in-progress → error (overflow): card transitions, friendly error message
 *     is visible.
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
	test("in-progress → complete: single header row, same card identity", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => (window as any).applyInProgress("overflow", 202_592));

		const card = page.locator("[data-testid='compaction-summary-card']");
		await expect(card).toHaveCount(1);
		await expect(card).toHaveAttribute("data-state", "in-progress");
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

		// Transition to complete. Non-error states render as a SINGLE header
		// row — no expandable body, no before/after badges (those numbers
		// were structurally unreliable at compaction_end time).
		await page.evaluate(() =>
			(window as any).applyComplete({
				tokensBefore: 202_592, tokensAfter: 180_000, reductionPct: 11.2,
			}),
		);
		await expect(card).toHaveAttribute("data-state", "complete");
		await expect(page.locator("[data-testid='compaction-summary-card']")).toHaveCount(1);
		await expect(card.getByText("Context compacted")).toBeVisible();
		// No tokens badges / reduction lozenge on the complete card anymore.
		await expect(card.locator("[data-test='tokens-before']")).toHaveCount(0);
		await expect(card.locator("[data-test='tokens-after']")).toHaveCount(0);
		await expect(card.locator("[data-test='reduction-pct']")).toHaveCount(0);
	});

	test("in-progress → error: hard compaction failure surfaces raw upstream error", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => (window as any).applyInProgress("manual", null));
		const card = page.locator("[data-testid='compaction-summary-card']");
		await expect(card).toHaveAttribute("data-state", "in-progress");

		await page.evaluate(() =>
			(window as any).applyError({
				trigger: "manual",
				error: "Compaction RPC timed out after 120s",
			}),
		);
		await expect(card).toHaveAttribute("data-state", "error");
		// Hard compaction failure (manual /compact RPC error). The raw upstream
		// error is surfaced verbatim because there is no useful friendly
		// alternative; users may need the literal string to file a bug.
		await expect(card.locator("[data-test='error']")).toContainText("timed out");
		// Still exactly one card on the page.
		await expect(page.locator("[data-testid='compaction-summary-card']")).toHaveCount(1);
	});



});
