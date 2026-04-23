import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/preview-renderer.html");
const BUNDLE = path.resolve("tests/fixtures/preview-renderer-bundle.js");
const ENTRY = path.resolve("tests/fixtures/preview-renderer-entry.ts");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/PreviewRenderer.ts");

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

const MARKER = "__preview_snapshot_v1__\n";
const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const TOOL_USE_ID = "tool-1";

function makeResultWithSnapshot(html: string) {
	return {
		role: "toolResult",
		toolCallId: TOOL_USE_ID,
		toolName: "preview_open",
		isError: false,
		content: [
			{ type: "text", text: "Preview panel is open and will auto-update." },
			{ type: "text", text: MARKER + html },
		],
		timestamp: Date.now(),
	};
}

function makeLegacyResult() {
	return {
		role: "toolResult",
		toolCallId: TOOL_USE_ID,
		toolName: "preview_open",
		isError: false,
		content: [
			{ type: "text", text: "Preview panel is open and will auto-update." },
		],
		timestamp: Date.now(),
	};
}

function makeErrorResult() {
	return {
		role: "toolResult",
		toolCallId: TOOL_USE_ID,
		toolName: "preview_open",
		isError: true,
		content: [{ type: "text", text: "Error reading file." }],
		timestamp: Date.now(),
	};
}

function makeTruncatedResult(originalLength: number) {
	return {
		role: "toolResult",
		toolCallId: TOOL_USE_ID,
		toolName: "preview_open",
		isError: false,
		content: [
			{ type: "text", text: "Preview panel is open and will auto-update." },
			{
				type: "text",
				text: MARKER,
				_truncated: true,
				_originalLength: originalLength,
				preview: "<p>truncated preview</p>",
			},
		],
		timestamp: Date.now(),
	};
}

test.describe("PreviewOpenRenderer", () => {
	test("renders enabled Open button for completed preview with inline snapshot", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(
			([params, result]) => {
				(window as any).__renderPreview(document.getElementById("container")!, params, result, false);
			},
			[{ html: "<p>hi</p>" }, makeResultWithSnapshot("<p>hi</p>")],
		);
		const btn = page.locator("[data-preview-open-btn]");
		await expect(btn).toHaveCount(1);
		await expect(btn).toBeEnabled();
		await expect(btn).toHaveText("Open");
	});

	test("renders disabled Open button for legacy single-block result", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(
			([params, result]) => {
				(window as any).__renderPreview(document.getElementById("container")!, params, result, false);
			},
			[{ html: "<p>legacy</p>" }, makeLegacyResult()],
		);
		const btn = page.locator("[data-preview-open-btn]");
		await expect(btn).toBeDisabled();
		await expect(btn).toHaveAttribute("title", /Snapshot not captured/);
	});

	test("renders disabled Open button while streaming", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(
			([params]) => {
				(window as any).__renderPreview(document.getElementById("container")!, params, undefined, true);
			},
			[{ html: "<p>streaming</p>" }],
		);
		const btn = page.locator("[data-preview-open-btn]");
		await expect(btn).toBeDisabled();
		await expect(btn).toHaveAttribute("title", /Waiting/);
	});

	test("renders disabled Open button for error result", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(
			([params, result]) => {
				(window as any).__renderPreview(document.getElementById("container")!, params, result, false);
			},
			[{ html: "<p>x</p>" }, makeErrorResult()],
		);
		const btn = page.locator("[data-preview-open-btn]");
		await expect(btn).toBeDisabled();
	});

	test("click with inline snapshot: PATCH then POST /api/preview with marker-stripped HTML", async ({ page }) => {
		await gotoAndWait(page);
		const html = "<p>hello-world</p>";
		await page.evaluate(
			([params, result]) => {
				(window as any).__renderPreview(document.getElementById("container")!, params, result, false);
				(window as any).__resetFetchCalls();
			},
			[{ html }, makeResultWithSnapshot(html)],
		);

		await page.locator("[data-preview-open-btn]").click();
		// Wait for the button to transition to "Opened ✓"
		await expect(page.locator("[data-preview-open-btn]")).toHaveText(/Opened/, { timeout: 3000 });

		const calls = await page.evaluate(() => (window as any).__getFetchCalls());
		// Expect 2 calls: PATCH session, POST preview. No GET /tool-content/.
		expect(calls.length).toBe(2);
		expect(calls[0].method).toBe("PATCH");
		expect(calls[0].url).toContain(`/api/sessions/${SESSION_ID}`);
		expect(JSON.parse(calls[0].body)).toEqual({ preview: true });

		expect(calls[1].method).toBe("POST");
		expect(calls[1].url).toContain(`/api/preview?sessionId=${SESSION_ID}`);
		const postBody = JSON.parse(calls[1].body);
		expect(postBody.html).toBe(html);
		expect(postBody.html).not.toContain("__preview_snapshot_v1__");
	});

	test("click with truncated snapshot: GET tool-content then PATCH then POST", async ({ page }) => {
		await gotoAndWait(page);
		const fullHtml = "<p>" + "x".repeat(40000) + "</p>";
		const result = makeTruncatedResult(MARKER.length + fullHtml.length);

		await page.evaluate(
			([result, messages, fullHtml, marker]) => {
				(window as any).__setMessages(messages);
				(window as any).__setFetchResponse((url: string, init: any) => {
					if (url.includes("/tool-content/") && (!init || init.method === "GET" || !init.method)) {
						return { status: 200, body: { content: marker + fullHtml } };
					}
					return { status: 200, body: { ok: true } };
				});
				(window as any).__renderPreview(
					document.getElementById("container")!,
					{ html: "<p>x</p>" },
					result,
					false,
				);
				(window as any).__resetFetchCalls();
			},
			[result, [result], fullHtml, MARKER] as any,
		);

		await page.locator("[data-preview-open-btn]").click();
		await expect(page.locator("[data-preview-open-btn]")).toHaveText(/Opened/, { timeout: 3000 });

		const calls = await page.evaluate(() => (window as any).__getFetchCalls());
		// GET tool-content, PATCH, POST
		expect(calls.length).toBe(3);
		expect(calls[0].method).toBe("GET");
		expect(calls[0].url).toContain("/tool-content/0/1");
		expect(calls[1].method).toBe("PATCH");
		expect(calls[2].method).toBe("POST");
		const postBody = JSON.parse(calls[2].body);
		expect(postBody.html).toBe(fullHtml);
		expect(postBody.html).not.toContain("__preview_snapshot_v1__");
	});

	test("click error: shows 'Failed — retry' and re-enables button", async ({ page }) => {
		await gotoAndWait(page);
		const html = "<p>boom</p>";
		await page.evaluate(
			([params, result]) => {
				(window as any).__renderPreview(document.getElementById("container")!, params, result, false);
				(window as any).__setFetchResponse(() => ({ status: 500, body: { error: "nope" } }));
				(window as any).__resetFetchCalls();
			},
			[{ html }, makeResultWithSnapshot(html)],
		);

		await page.locator("[data-preview-open-btn]").click();
		const btn = page.locator("[data-preview-open-btn]");
		await expect(btn).toHaveText(/Failed/, { timeout: 3000 });
		await expect(btn).toBeEnabled();
	});
});
