/**
 * Acceptance criterion #8: archived sessions stamped with v1 / v2 markers
 * still render an Open button via the read-only legacy compatibility path.
 *
 * Uses the same file:// fixture as tests/preview-renderer.spec.ts — no
 * gateway needed. Each test renders a synthesized archived-shape tool
 * result, clicks Open, and asserts the renderer routes through the new
 * /api/preview/mount endpoint (NOT the deleted legacy /api/preview).
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/preview-renderer.html");
const BUNDLE = path.resolve("tests/fixtures/preview-renderer-bundle.js");
const ENTRY = path.resolve("tests/fixtures/preview-renderer-entry.ts");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/PreviewRenderer.ts");

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const MARKER_V1 = "__preview_snapshot_v1__\n";
const MARKER_V2 = "__preview_snapshot_v2__\n";

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

async function gotoAndWait(page: import("@playwright/test").Page) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

function v1Result(html: string) {
	return {
		role: "toolResult",
		toolCallId: "tool-v1",
		toolName: "preview_open",
		isError: false,
		content: [
			{ type: "text", text: "Preview panel is open and will auto-update." },
			{ type: "text", text: MARKER_V1 + html },
		],
		timestamp: Date.now(),
	};
}

function v2Result(filePath: string) {
	return {
		role: "toolResult",
		toolCallId: "tool-v2",
		toolName: "preview_open",
		isError: false,
		content: [
			{ type: "text", text: "Preview panel is open and will auto-update." },
			{ type: "text", text: MARKER_V2 + JSON.stringify({ kind: "file", path: filePath }) + "\n" },
		],
		timestamp: Date.now(),
	};
}

test.describe("Archived-session snapshot compatibility (criterion 8)", () => {
	test("v1 marker: Open button enabled; click POSTs /api/preview/mount with {html}", async ({ page }) => {
		await gotoAndWait(page);
		const html = "<!DOCTYPE html><body><h1>archived-v1</h1></body>";
		await page.evaluate(
			([params, result]) => {
				(window as any).__renderPreview(document.getElementById("container")!, params, result, false);
				(window as any).__resetFetchCalls();
			},
			[{ html }, v1Result(html)],
		);

		const btn = page.locator("[data-preview-open-btn]");
		await expect(btn).toBeEnabled();
		await expect(btn).toHaveText("Open");

		await btn.click();
		await expect(btn).toHaveText(/Opened/, { timeout: 3000 });

		const calls = await page.evaluate(() => (window as any).__getFetchCalls());
		const post = calls.find(
			(c: any) => c.method === "POST" && String(c.url).includes("/api/preview/mount"),
		);
		expect(post, `expected POST /api/preview/mount, got: ${JSON.stringify(calls)}`).toBeTruthy();
		expect(String(post.url)).toContain(`sessionId=${SESSION_ID}`);
		const body = JSON.parse(post.body);
		expect(body.html).toBe(html);
		expect(body.html).not.toContain("__preview_snapshot_v1__");
		expect(body.file).toBeUndefined();
	});

	test("v2 marker: Open button enabled; click POSTs /api/preview/mount with {file}", async ({ page }) => {
		await gotoAndWait(page);
		const filePath = "/abs/path/to/report.html";
		await page.evaluate(
			([params, result]) => {
				(window as any).__renderPreview(document.getElementById("container")!, params, result, false);
				(window as any).__resetFetchCalls();
			},
			[{ file: filePath }, v2Result(filePath)],
		);

		const btn = page.locator("[data-preview-open-btn]");
		await expect(btn).toBeEnabled();

		await btn.click();
		await expect(btn).toHaveText(/Opened/, { timeout: 3000 });

		const calls = await page.evaluate(() => (window as any).__getFetchCalls());
		const post = calls.find(
			(c: any) => c.method === "POST" && String(c.url).includes("/api/preview/mount"),
		);
		expect(post).toBeTruthy();
		const body = JSON.parse(post.body);
		expect(body.file).toBe(filePath);
		expect(body.html).toBeUndefined();
		expect(body.kind).toBeUndefined(); // Not the legacy /api/preview shape.
	});

	test("v2 marker: server 404 → button disabled with 'File no longer available'", async ({ page }) => {
		await gotoAndWait(page);
		const filePath = "/abs/path/to/missing.html";
		await page.evaluate(
			([params, result]) => {
				(window as any).__renderPreview(document.getElementById("container")!, params, result, false);
				(window as any).__setFetchResponse((url: string, init: any) => {
					if (init?.method === "POST" && String(url).includes("/api/preview/mount")) {
						return { status: 404, body: { error: "file no longer available" } };
					}
					return { status: 200, body: { ok: true } };
				});
				(window as any).__resetFetchCalls();
			},
			[{ file: filePath }, v2Result(filePath)],
		);

		const btn = page.locator("[data-preview-open-btn]");
		await btn.click();
		await expect(btn).toHaveText(/File no longer available/, { timeout: 3000 });
		await expect(btn).toBeDisabled();
	});
});
