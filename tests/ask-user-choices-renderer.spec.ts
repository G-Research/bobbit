/**
 * Renderer-level unit test for AskUserChoicesRenderer.
 *
 * Pins the gating between the three completed-result shapes:
 *   1. `isError: true`              → minimal `.ask-error` chip, no interactive widget chrome.
 *   2. `{error:"..."}` w/o isError  → also minimal chip (defense-in-depth from
 *                                     the renderer's `errored` derivation).
 *   3. `{status:"posted"}` stub     → interactive widget renders (tabs + submit).
 *
 * Pattern mirrors tests/bash-renderer-description.spec.ts (file:// fixture +
 * esbuild-on-demand bundle).
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/ask-user-choices-renderer.html");
const BUNDLE = path.resolve("tests/fixtures/ask-user-choices-renderer-bundle.js");
const ENTRY = path.resolve("tests/fixtures/ask-user-choices-renderer-entry.ts");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/AskUserChoicesRenderer.ts");
const WIDGET_SRC = path.resolve("src/ui/components/AskUserChoicesWidget.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(RENDERER_SRC).mtimeMs,
		fs.statSync(WIDGET_SRC).mtimeMs,
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
				"--alias:pdfjs-dist=./tests/fixtures/empty-shim",
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;

const PARAMS = {
	questions: [
		{ question: "Q1", options: ["a", "b"], tab_label: "First" },
		{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
	],
};

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

test.describe("AskUserChoicesRenderer error-vs-interactive gating", () => {
	test("isError:true result renders minimal error chip, not interactive widget", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((params) => {
			const el = document.getElementById("container")!;
			const result = {
				isError: true,
				content: [{
					type: "text",
					text: JSON.stringify({
						error: "ask_user_choices: questions[1].tab_label is required when there are multiple questions.",
					}),
				}],
			};
			(window as any).__renderAsk(el, params, result, false);
		}, PARAMS);

		await expect(page.locator("#container .ask-error")).toHaveCount(1);
		await expect(page.locator("#container [role=\"tab\"]")).toHaveCount(0);
		await expect(page.locator("#container .ask-submit")).toHaveCount(0);
	});

	test("{error:'...'} content without isError flag also renders minimal error chip (defense-in-depth)", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((params) => {
			const el = document.getElementById("container")!;
			const result = {
				// NO isError field — guards renderer's broadened `errored` derivation:
				//   errored = state !== "inprogress" && result && !posted && !legacy
				content: [{ type: "text", text: JSON.stringify({ error: "some failure" }) }],
			};
			(window as any).__renderAsk(el, params, result, false);
		}, PARAMS);

		await expect(page.locator("#container .ask-error")).toHaveCount(1);
		await expect(page.locator("#container [role=\"tab\"]")).toHaveCount(0);
		await expect(page.locator("#container .ask-submit")).toHaveCount(0);
	});

	test("{status:'posted'} stub renders interactive widget (tabs + submit)", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((params) => {
			const el = document.getElementById("container")!;
			const result = {
				content: [{
					type: "text",
					text: JSON.stringify({ status: "posted", tool_use_id: "abc" }),
				}],
			};
			(window as any).__renderAsk(el, params, result, false);
		}, PARAMS);

		// Two tabs (one per question) and one submit button.
		await expect(page.locator("#container [role=\"tab\"]")).toHaveCount(2);
		await expect(page.locator("#container .ask-submit")).toHaveCount(1);
		await expect(page.locator("#container .ask-error")).toHaveCount(0);
	});
});
