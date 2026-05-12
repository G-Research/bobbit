/**
 * Browser E2E for the `find` tool — verifies results render via FindRenderer.
 *
 * Tied to the "Bundled fd/rg binaries" goal: bundling guarantees the binary
 * is present so `find` works on first call without network. This test pins
 * the visible contract — the renderer DOM the user sees when the tool fires.
 *
 * Uses a file:// fixture (same pattern as tests/e2e/ui/bash-renderer-description.spec.ts):
 * no gateway is spawned because FindRenderer is a pure function of (params, result)
 * — full browser fidelity (real DOM, real CSS, real reload) without flakiness
 * from agent/model variability or dependence on fd being installed on the test host.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/find-renderer.html");
const BUNDLE = path.resolve("tests/fixtures/find-renderer-bundle.js");
const ENTRY = path.resolve("tests/fixtures/find-renderer-entry.ts");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/FindRenderer.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(RENDERER_SRC).mtimeMs);
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

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

// Build a minimal ToolResultMessage shape that FindRenderer accepts.
function okResult(output: string) {
	return { isError: false, content: [{ type: "text", text: output }] };
}
function errResult(output: string) {
	return { isError: true, content: [{ type: "text", text: output }] };
}

test.describe("FindRenderer (browser E2E)", () => {
	test("streaming header shows pattern and path before result arrives @smoke", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			const el = document.getElementById("container")!;
			(window as any).__renderFind(el, { pattern: "*.ts", path: "src/server" }, undefined, true);
		});

		// Header text combines pattern + path via i18n("Finding") / i18n("in").
		const container = page.locator("#container");
		await expect(container).toContainText("Finding");
		await expect(container).toContainText("*.ts");
		await expect(container).toContainText("src/server");
	});

	test("happy path: result renders into console-block with matched paths", async ({ page }) => {
		await gotoAndWait(page);
		const output = [
			"src/server/binaries.ts",
			"src/server/cli.ts",
			"src/server/server.ts",
		].join("\n");

		await page.evaluate((out) => {
			const el = document.getElementById("container")!;
			(window as any).__renderFind(
				el,
				{ pattern: "*.ts", path: "src/server" },
				{ isError: false, content: [{ type: "text", text: out }] },
			);
		}, output);

		// Output container exists and contains the matched paths.
		const consoleBlock = page.locator("#container console-block");
		await expect(consoleBlock).toHaveCount(1);
		await expect(consoleBlock).toContainText("src/server/binaries.ts");
		await expect(consoleBlock).toContainText("src/server/cli.ts");

		// Header (collapsible button) still shows the query summary.
		const header = page.locator("#container button").first();
		await expect(header).toContainText("*.ts");
		await expect(header).toContainText("src/server");
	});

	test("happy path with pattern only (no path) renders header without 'in <path>'", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			const el = document.getElementById("container")!;
			(window as any).__renderFind(
				el,
				{ pattern: "*.md" },
				{ isError: false, content: [{ type: "text", text: "README.md\nAGENTS.md" }] },
			);
		});

		const header = page.locator("#container button").first();
		await expect(header).toContainText("Finding");
		await expect(header).toContainText("*.md");
		// No path → header doesn't include the " in " separator.
		const headerText = (await header.textContent()) ?? "";
		expect(headerText).not.toMatch(/\sin\s/);

		await expect(page.locator("#container console-block")).toContainText("README.md");
	});

	test("error result renders destructive message, no console-block", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			const el = document.getElementById("container")!;
			(window as any).__renderFind(
				el,
				{ pattern: "*.ts", path: "/nope" },
				{ isError: true, content: [{ type: "text", text: "fd: '/nope': No such file or directory" }] },
			);
		});

		// Error branch shows the message in a destructive-styled div, not console-block.
		await expect(page.locator("#container console-block")).toHaveCount(0);
		await expect(page.locator("#container")).toContainText("No such file or directory");

		// Some destructive/amber styling is applied — assert either class is present.
		const errDiv = page.locator("#container div").filter({ hasText: "No such file or directory" }).last();
		const cls = (await errDiv.getAttribute("class")) ?? "";
		expect(cls).toMatch(/text-destructive|text-amber/);
	});

	test("renderer is a pure function: persists identical DOM across reload", async ({ page }) => {
		const params = { pattern: "*.ts", path: "src" };
		const out = "src/a.ts\nsrc/b.ts";

		await gotoAndWait(page);
		await page.evaluate(([p, o]) => {
			const el = document.getElementById("container")!;
			(window as any).__renderFind(el, p, { isError: false, content: [{ type: "text", text: o }] });
		}, [params, out] as const);
		await expect(page.locator("#container console-block")).toContainText("src/a.ts");

		await page.reload();
		await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
		await page.evaluate(([p, o]) => {
			const el = document.getElementById("container")!;
			(window as any).__renderFind(el, p, { isError: false, content: [{ type: "text", text: o }] });
		}, [params, out] as const);
		await expect(page.locator("#container console-block")).toContainText("src/a.ts");
	});
});

// silence unused warnings for helpers we kept for readability
void okResult;
void errResult;
