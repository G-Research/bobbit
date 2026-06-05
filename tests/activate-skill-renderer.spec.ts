/**
 * Renderer-level unit test for ActivateSkillRenderer (Defect B).
 *
 * Pins that a FAILED activation (no `details.skillExpansion`, with text
 * content `activate_skill failed: …`) surfaces that text as a visible error
 * state — REGARDLESS of the `isError` flag.
 *
 * This matters because pi's agent-loop hardcodes `isError: false` for any tool
 * whose `execute()` *returns* (rather than throws) — so the skills extension's
 * `{ isError: true }` on a failed activation is dropped before it reaches the
 * renderer. A renderer that gated the error display on `result.isError` would
 * show a benign "Activating…" header and silently discard the failure text
 * (the original bug). These cases lock in the flag-independent behaviour.
 *
 * Pattern mirrors tests/ask-user-choices-renderer.spec.ts (file:// fixture +
 * esbuild-on-demand bundle).
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/activate-skill-renderer.html");
const BUNDLE = path.resolve("tests/fixtures/activate-skill-renderer-bundle.js");
const ENTRY = path.resolve("tests/fixtures/activate-skill-renderer-entry.ts");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/ActivateSkillRenderer.ts");
const CHIP_SRC = path.resolve("src/ui/components/SkillChip.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(RENDERER_SRC).mtimeMs,
		fs.statSync(CHIP_SRC).mtimeMs,
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
const PARAMS = { name: "resolve-pr-conflicts", args: "497" };
const FAIL_TEXT = "activate_skill failed: name is required";

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

test.describe("ActivateSkillRenderer failed-activation surfacing", () => {
	test("no skillExpansion + content text + isError:true → visible error text (not benign header)", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(({ params, failText }) => {
			const el = document.getElementById("container")!;
			const result = {
				isError: true,
				content: [{ type: "text", text: failText }],
			};
			(window as any).__renderActivate(el, params, result, false);
		}, { params: PARAMS, failText: FAIL_TEXT });

		await expect(page.locator("#container div.text-destructive")).toContainText(FAIL_TEXT);
		// The benign "Activating…" header must NOT be the only thing shown.
		await expect(page.locator("#container")).not.toContainText("Activating");
	});

	test("no skillExpansion + content text WITHOUT isError flag → STILL visible error text", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(({ params, failText }) => {
			const el = document.getElementById("container")!;
			// NO isError field — pi drops it for tools that return rather than throw.
			const result = {
				content: [{ type: "text", text: failText }],
			};
			(window as any).__renderActivate(el, params, result, false);
		}, { params: PARAMS, failText: FAIL_TEXT });

		await expect(page.locator("#container div.text-destructive")).toContainText(FAIL_TEXT);
		await expect(page.locator("#container")).not.toContainText("Activating");
	});

	test("happy path with skillExpansion → renders skill chip, no error text", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((params) => {
			const el = document.getElementById("container")!;
			const result = {
				content: [{ type: "text", text: "EXPANDED BODY" }],
				details: {
					skillExpansion: {
						name: "resolve-pr-conflicts",
						args: "497",
						source: "project",
						filePath: "/x/SKILL.md",
						expanded: "EXPANDED BODY",
					},
				},
			};
			(window as any).__renderActivate(el, params, result, false);
		}, PARAMS);

		await expect(page.locator("#container skill-chip")).toHaveCount(1);
		await expect(page.locator("#container div.text-destructive")).toHaveCount(0);
	});
});
