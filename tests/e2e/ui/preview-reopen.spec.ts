/**
 * Browser E2E for reopenable preview widgets.
 *
 * Uses the same file:// fixture as tests/preview-renderer.spec.ts — no
 * gateway spawned. The renderer owns 100% of the reopen behaviour (mock
 * fetch, no server dependency), so fixture-level fidelity is sufficient
 * to validate the user-visible workflow end-to-end: two completed
 * preview_open widgets, click Open on each in turn, observe the POST body
 * carry the corresponding HTML payload; plus the archived fallback
 * (legacy single-block result renders a disabled button with tooltip).
 */
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
const MARKER = "__preview_snapshot_v1__\n";

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

function makeResultWithSnapshot(html: string, toolCallId: string) {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "preview_open",
		isError: false,
		content: [
			{ type: "text", text: "Preview panel is open and will auto-update." },
			{ type: "text", text: MARKER + html },
		],
		timestamp: Date.now(),
	};
}

test.describe("Reopenable preview widgets (browser E2E)", () => {
	test("two-preview-swap: click Open on each widget sends correct HTML", async ({ page }) => {
		await gotoAndWait(page);

		// Render TWO preview_open widgets side-by-side into separate slots.
		await page.evaluate(
			([marker]) => {
				const container = document.getElementById("container")!;
				container.innerHTML = '<div id="slot-a"></div><div id="slot-b"></div>';
			},
			[MARKER],
		);

		const htmlA = "<!DOCTYPE html><body><h1>Preview A</h1></body>";
		const htmlB = "<!DOCTYPE html><body><h1>Preview B</h1></body>";

		await page.evaluate(
			([a, b]) => {
				const w = window as any;
				w.__renderPreview(document.getElementById("slot-a")!, { html: a.html }, a.result, false, { sessionId: "11111111-1111-1111-1111-111111111111", toolUseId: "tool-A" });
				w.__renderPreview(document.getElementById("slot-b")!, { html: b.html }, b.result, false, { sessionId: "11111111-1111-1111-1111-111111111111", toolUseId: "tool-B" });
				w.__resetFetchCalls();
			},
			[
				{ html: htmlA, result: makeResultWithSnapshot(htmlA, "tool-A") },
				{ html: htmlB, result: makeResultWithSnapshot(htmlB, "tool-B") },
			],
		);

		// Two Open buttons — one per slot
		await expect(page.locator("#slot-a [data-preview-open-btn]")).toHaveCount(1);
		await expect(page.locator("#slot-b [data-preview-open-btn]")).toHaveCount(1);

		// Click Open on slot A
		await page.locator("#slot-a [data-preview-open-btn]").click();
		await expect(page.locator("#slot-a [data-preview-open-btn]")).toHaveText(/Opened/, { timeout: 3000 });

		let calls = await page.evaluate(() => (window as any).__getFetchCalls());
		// Last POST should carry htmlA
		const postsA = calls.filter((c: any) => c.method === "POST" && c.url.includes("/api/preview"));
		expect(postsA.length).toBe(1);
		expect(JSON.parse(postsA[0].body).html).toBe(htmlA);

		// Click Open on slot B — preview should flip to B
		await page.evaluate(() => (window as any).__resetFetchCalls());
		await page.locator("#slot-b [data-preview-open-btn]").click();
		await expect(page.locator("#slot-b [data-preview-open-btn]")).toHaveText(/Opened/, { timeout: 3000 });

		calls = await page.evaluate(() => (window as any).__getFetchCalls());
		const postsB = calls.filter((c: any) => c.method === "POST" && c.url.includes("/api/preview"));
		expect(postsB.length).toBe(1);
		expect(JSON.parse(postsB[0].body).html).toBe(htmlB);

		// Click Open on A again — preview flips back to A
		await page.evaluate(() => (window as any).__resetFetchCalls());
		await page.locator("#slot-a [data-preview-open-btn]").click();
		await expect(page.locator("#slot-a [data-preview-open-btn]")).toHaveText(/Opened/, { timeout: 3000 });

		calls = await page.evaluate(() => (window as any).__getFetchCalls());
		const postsA2 = calls.filter((c: any) => c.method === "POST" && c.url.includes("/api/preview"));
		expect(postsA2.length).toBe(1);
		expect(JSON.parse(postsA2[0].body).html).toBe(htmlA);
	});

	test("two-preview-swap: state persists across page reload", async ({ page }) => {
		await gotoAndWait(page);

		const htmlA = "<!DOCTYPE html><body>A-after-reload</body>";
		await page.evaluate(
			([htmlA]) => {
				const w = window as any;
				w.__renderPreview(
					document.getElementById("container")!,
					{ html: htmlA },
					{
						role: "toolResult",
						toolCallId: "tool-A",
						toolName: "preview_open",
						isError: false,
						content: [
							{ type: "text", text: "Preview panel is open and will auto-update." },
							{ type: "text", text: "__preview_snapshot_v1__\n" + htmlA },
						],
						timestamp: Date.now(),
					},
					false,
					{ sessionId: "11111111-1111-1111-1111-111111111111", toolUseId: "tool-A" },
				);
			},
			[htmlA],
		);

		await expect(page.locator("[data-preview-open-btn]")).toBeEnabled();

		// Reload and re-render the same snapshot — simulates history replay after reconnect.
		await page.reload();
		await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });

		await page.evaluate(
			([htmlA]) => {
				const w = window as any;
				w.__renderPreview(
					document.getElementById("container")!,
					{ html: htmlA },
					{
						role: "toolResult",
						toolCallId: "tool-A",
						toolName: "preview_open",
						isError: false,
						content: [
							{ type: "text", text: "Preview panel is open and will auto-update." },
							{ type: "text", text: "__preview_snapshot_v1__\n" + htmlA },
						],
						timestamp: Date.now(),
					},
					false,
					{ sessionId: "11111111-1111-1111-1111-111111111111", toolUseId: "tool-A" },
				);
				w.__resetFetchCalls();
			},
			[htmlA],
		);

		await page.locator("[data-preview-open-btn]").click();
		await expect(page.locator("[data-preview-open-btn]")).toHaveText(/Opened/, { timeout: 3000 });
		const calls = await page.evaluate(() => (window as any).__getFetchCalls());
		const post = calls.find((c: any) => c.method === "POST" && c.url.includes("/api/preview"));
		expect(post).toBeTruthy();
		expect(JSON.parse(post.body).html).toBe(htmlA);
	});

	test("archived fallback: legacy single-block preview_open renders disabled button", async ({ page }) => {
		await gotoAndWait(page);

		// Pre-feature tool_result shape — no snapshot block
		const legacyResult = {
			role: "toolResult",
			toolCallId: "tool-legacy",
			toolName: "preview_open",
			isError: false,
			content: [{ type: "text", text: "Preview panel is open and will auto-update." }],
			timestamp: Date.now(),
		};

		await page.evaluate(
			([result]) => {
				const w = window as any;
				w.__renderPreview(
					document.getElementById("container")!,
					{ html: "<p>legacy</p>" },
					result,
					false,
					{ sessionId: "11111111-1111-1111-1111-111111111111", toolUseId: "tool-legacy" },
				);
			},
			[legacyResult],
		);

		const btn = page.locator("[data-preview-open-btn]");
		await expect(btn).toBeDisabled();
		await expect(btn).toHaveAttribute("title", /Snapshot not captured/);

		// Clicking does nothing — no fetch calls
		await page.evaluate(() => (window as any).__resetFetchCalls());
		await btn.click({ force: true }).catch(() => {});
		const calls = await page.evaluate(() => (window as any).__getFetchCalls());
		expect(calls.length).toBe(0);
	});
});
