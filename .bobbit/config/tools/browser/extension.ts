/**
 * Playwright browser extension for pi-coding-agent.
 *
 * Provides tools for browser automation: navigating, screenshotting,
 * clicking, typing, and evaluating JavaScript.
 *
 * The browser launches lazily on first tool use and is reused across calls.
 * It is closed when the session shuts down.
 *
 * All tools respect the AbortSignal so they can be cancelled via the abort button.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { chromium, type Browser, type Page } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

let browser: Browser | null = null;
let page: Page | null = null;

async function ensurePage(): Promise<Page> {
	if (page && !page.isClosed()) return page;

	if (!browser || !browser.isConnected()) {
		browser = await chromium.launch({ headless: true });
	}
	const context = await browser.newContext({
		viewport: { width: 1280, height: 720 },
	});
	page = await context.newPage();
	return page;
}

async function cleanup() {
	if (browser?.isConnected()) {
		await browser.close().catch(() => {});
	}
	browser = null;
	page = null;
}

/** Race a promise against an AbortSignal. Throws if aborted. */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new Error("Aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("Aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(val) => { signal.removeEventListener("abort", onAbort); resolve(val); },
			(err) => { signal.removeEventListener("abort", onAbort); reject(err); },
		);
	});
}

export default function (pi: ExtensionAPI) {
	// Clean up browser on session shutdown
	pi.on("session_shutdown", async () => {
		await cleanup();
	});

	// ── browser_navigate ─────────────────────────────────────────────
	pi.registerTool({
		name: "browser_navigate",
		label: "Browser Navigate",
		description: "Navigate the browser to a URL. Launches a headless browser if needed.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to navigate to" }),
		}),
		async execute(_toolCallId, params, signal) {
			const p = await withAbort(ensurePage(), signal);
			await withAbort(p.goto(params.url, { waitUntil: "domcontentloaded", timeout: 30_000 }), signal);
			const title = await p.title();
			return {
				content: [{ type: "text", text: `Navigated to ${params.url}\nTitle: ${title}` }],
				details: {},
			};
		},
	});

	// ── browser_screenshot ───────────────────────────────────────────
	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description:
			"Take a screenshot of the current browser page (or a specific element). " +
			"Returns the image so you can see it. Optionally saves to a file.",
		parameters: Type.Object({
			selector: Type.Optional(Type.String({ description: "CSS selector to screenshot a specific element. Omit for full page." })),
			savePath: Type.Optional(Type.String({ description: "File path to save the screenshot to (png). Optional." })),
			fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page. Default false." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = await withAbort(ensurePage(), signal);

			let buffer: Buffer;
			if (params.selector) {
				const el = p.locator(params.selector).first();
				buffer = await withAbort(el.screenshot({ type: "png" }), signal) as Buffer;
			} else {
				buffer = await withAbort(p.screenshot({ type: "png", fullPage: params.fullPage ?? false }), signal) as Buffer;
			}

			if (params.savePath) {
				const abs = path.resolve(params.savePath);
				fs.mkdirSync(path.dirname(abs), { recursive: true });
				fs.writeFileSync(abs, buffer);
			}

			const base64 = buffer.toString("base64");
			const url = await p.url();
			const title = await p.title();

			return {
				content: [
					{
						type: "image" as const,
						mimeType: "image/png" as const,
						data: base64,
					},
					{ type: "text", text: `Screenshot of ${url} (${title})${params.savePath ? ` — saved to ${params.savePath}` : ""}` },
				],
				details: {},
			};
		},
	});

	// ── browser_click ────────────────────────────────────────────────
	pi.registerTool({
		name: "browser_click",
		label: "Browser Click",
		description: "Click an element on the page by CSS selector.",
		parameters: Type.Object({
			selector: Type.String({ description: "CSS selector of the element to click" }),
		}),
		async execute(_toolCallId, params, signal) {
			const p = await withAbort(ensurePage(), signal);
			await withAbort(p.locator(params.selector).first().click({ timeout: 10_000 }), signal);
			return {
				content: [{ type: "text", text: `Clicked: ${params.selector}` }],
				details: {},
			};
		},
	});

	// ── browser_type ─────────────────────────────────────────────────
	pi.registerTool({
		name: "browser_type",
		label: "Browser Type",
		description: "Type text into an input element identified by CSS selector.",
		parameters: Type.Object({
			selector: Type.String({ description: "CSS selector of the input element" }),
			text: Type.String({ description: "Text to type" }),
			clear: Type.Optional(Type.Boolean({ description: "Clear the field before typing. Default true." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = await withAbort(ensurePage(), signal);
			const el = p.locator(params.selector).first();
			if (params.clear !== false) {
				await withAbort(el.fill(params.text, { timeout: 10_000 }), signal);
			} else {
				await withAbort(el.pressSequentially(params.text, { timeout: 10_000 }), signal);
			}
			return {
				content: [{ type: "text", text: `Typed into ${params.selector}: "${params.text}"` }],
				details: {},
			};
		},
	});

	// ── browser_eval ─────────────────────────────────────────────────
	pi.registerTool({
		name: "browser_eval",
		label: "Browser Evaluate",
		description: "Execute JavaScript in the browser page and return the result.",
		parameters: Type.Object({
			expression: Type.String({ description: "JavaScript expression to evaluate in the page context" }),
		}),
		async execute(_toolCallId, params, signal) {
			const p = await withAbort(ensurePage(), signal);
			const result = await withAbort(p.evaluate(params.expression), signal);
			const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
			return {
				content: [{ type: "text", text: text ?? "(undefined)" }],
				details: {},
			};
		},
	});

	// ── browser_wait ─────────────────────────────────────────────────
	pi.registerTool({
		name: "browser_wait",
		label: "Browser Wait",
		description: "Wait for an element matching the selector to appear on the page.",
		parameters: Type.Object({
			selector: Type.String({ description: "CSS selector to wait for" }),
			timeout: Type.Optional(Type.Number({ description: "Max wait time in milliseconds. Default 10000." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = await withAbort(ensurePage(), signal);
			await withAbort(
				p.locator(params.selector).first().waitFor({
					state: "visible",
					timeout: params.timeout ?? 10_000,
				}),
				signal,
			);
			return {
				content: [{ type: "text", text: `Element visible: ${params.selector}` }],
				details: {},
			};
		},
	});
}
