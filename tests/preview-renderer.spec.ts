import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/preview-renderer.html");
const BUNDLE = path.resolve("tests/fixtures/preview-renderer-bundle.js");
const ENTRY = path.resolve("tests/fixtures/preview-renderer-entry.ts");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/PreviewRenderer.ts");

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, RENDERER_SRC] });
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

const MARKER = "__preview_snapshot_v1__\n";
const MARKER_V2 = "__preview_snapshot_v2__\n";
const MARKER_V3 = "__preview_snapshot_v3__\n";
const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const HASH = "b".repeat(64);
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

function makePreviewResultWithSnapshot(entry = "inline.html", contentHash = HASH) {
	return {
		role: "toolResult",
		toolCallId: TOOL_USE_ID,
		toolName: "preview_open",
		isError: false,
		content: [
			{ type: "text", text: "Preview panel is open and will auto-update." },
			{ type: "text", text: MARKER_V3 + JSON.stringify({ kind: "preview", url: `/preview/${SESSION_ID}/${entry}`, path: `${SESSION_ID}/${entry}`, contentHash }) + "\n" },
		],
		timestamp: Date.now(),
	};
}

function makeFileResultWithSnapshot(filePath: string) {
	return {
		role: "toolResult",
		toolCallId: TOOL_USE_ID,
		toolName: "preview_open",
		isError: false,
		content: [
			{ type: "text", text: "Preview panel is open and will auto-update." },
			{ type: "text", text: MARKER_V2 + JSON.stringify({ kind: "file", path: filePath }) + "\n" },
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
		expect(calls[1].url).toContain(`/api/preview/mount?sessionId=${SESSION_ID}`);
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

	test("v2 marker: click POSTs {kind:file, path} and shows Opened", async ({ page }) => {
		await gotoAndWait(page);
		const filePath = "/abs/path/to/report.html";
		await page.evaluate(
			([params, result]) => {
				(window as any).__renderPreview(document.getElementById("container")!, params, result, false);
				(window as any).__resetFetchCalls();
			},
			[{ file: filePath }, makeFileResultWithSnapshot(filePath)],
		);

		await page.locator("[data-preview-open-btn]").click();
		await expect(page.locator("[data-preview-open-btn]")).toHaveText(/Opened/, { timeout: 3000 });

		const calls = await page.evaluate(() => (window as any).__getFetchCalls());
		expect(calls.length).toBe(2);
		expect(calls[0].method).toBe("PATCH");
		expect(calls[1].method).toBe("POST");
		expect(calls[1].url).toContain(`/api/preview/mount?sessionId=${SESSION_ID}`);
		const postBody = JSON.parse(calls[1].body);
		expect(postBody.file).toBe(filePath);
		expect(postBody.html).toBeUndefined();
		expect(postBody.kind).toBeUndefined();
	});

	test("v3 marker: identical content reuses the live preview tab", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(async ([hash, sessionId, result]) => {
			await (window as any).__resetPreviewState();
			await (window as any).__setPreviewWorkspace(sessionId, hash);
			(window as any).__renderPreview(document.getElementById("container")!, { html: "<p>same</p>" }, result, false);
			(window as any).__resetFetchCalls();
		}, [HASH, SESSION_ID, makePreviewResultWithSnapshot("inline.html", HASH)] as any);

		await page.locator("[data-preview-open-btn]").click();
		await expect(page.locator("[data-preview-open-btn]")).toHaveText(/Opened/, { timeout: 3000 });

		const previewState = await page.evaluate(async () => (window as any).__getPreviewState());
		const tabs = previewState.panelTabsBySession[SESSION_ID];
		expect(tabs.map((tab: any) => tab.id)).toEqual(["preview:live"]);
		expect(previewState.panelWorkspaceActiveBySession[SESSION_ID]).toBe("preview:live");
		expect(previewState.previewPanelContentHash).toBe(HASH);
	});

	test("v3 marker: stale live preview still collapses to the live tab on first open", async ({ page }) => {
		await gotoAndWait(page);
		const oldHash = "c".repeat(64);
		await page.evaluate(async ([oldHash, sessionId, result]) => {
			await (window as any).__resetPreviewState();
			await (window as any).__setPreviewWorkspace(sessionId, oldHash);
			(window as any).__renderPreview(document.getElementById("container")!, { html: "<p>new</p>" }, result, false);
			(window as any).__resetFetchCalls();
		}, [oldHash, SESSION_ID, makePreviewResultWithSnapshot("inline.html", HASH)] as any);

		await page.locator("[data-preview-open-btn]").click();
		await expect(page.locator("[data-preview-open-btn]")).toHaveText(/Opened/, { timeout: 3000 });

		const previewState = await page.evaluate(async () => (window as any).__getPreviewState());
		const tabs = previewState.panelTabsBySession[SESSION_ID];
		expect(tabs.map((tab: any) => tab.id)).toEqual(["preview:live"]);
		expect(tabs[0].state.contentHash).toBe(HASH);
		expect(previewState.panelWorkspaceActiveBySession[SESSION_ID]).toBe("preview:live");
	});

	test("v2 marker: server 404 → button shows 'File no longer available' and stays disabled", async ({ page }) => {
		await gotoAndWait(page);
		const filePath = "/abs/path/to/gone.html";
		await page.evaluate(
			([params, result]) => {
				(window as any).__renderPreview(document.getElementById("container")!, params, result, false);
				(window as any).__setFetchResponse((url: string, init: any) => {
					if (init?.method === "POST" && String(url).includes("/api/preview")) {
						return { status: 404, body: { error: "file no longer available" } };
					}
					return { status: 200, body: { ok: true } };
				});
				(window as any).__resetFetchCalls();
			},
			[{ file: filePath }, makeFileResultWithSnapshot(filePath)],
		);

		await page.locator("[data-preview-open-btn]").click();
		const btn = page.locator("[data-preview-open-btn]");
		await expect(btn).toHaveText(/File no longer available/, { timeout: 3000 });
		await expect(btn).toBeDisabled();
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
