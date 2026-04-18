/**
 * Regression test for the QA screenshot token-bloat bug.
 *
 * Bug: `defaults/tools/browser/extension.ts` — when `browser_screenshot` is
 * called with `includeBase64=true`, the tool result currently contains TWO
 * copies of the screenshot bytes (an `image` block AND a `[screenshot_base64]`
 * text block). The duplicate text block balloons transcript size and is
 * re-cached every turn, costing millions of tokens.
 *
 * Fix requirement: the SUM of all `text` content blocks in the tool result
 * must stay under 2 KB regardless of screenshot size — while the single
 * `image` block (for the agent's vision pipeline) is preserved unchanged.
 *
 * This test directly drives the extension via a minimal mock `ExtensionAPI`
 * that captures registered tools. No gateway, no session, no LLM required.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";

// The extension uses CommonJS `require("playwright")` at load time. Under tsx
// ESM, `require` is not defined as a global. Provide one scoped to this test
// file so the extension can resolve `playwright` from node_modules.
if (typeof (globalThis as any).require !== "function") {
	(globalThis as any).require = createRequire(import.meta.url);
}

// ───────────────────────── minimal ExtensionAPI stub ─────────────────────────

type Captured = {
	tools: Map<string, any>;
	shutdownHandlers: Array<() => Promise<void> | void>;
};

function makeMockPi(captured: Captured): any {
	return {
		on(event: string, handler: any) {
			if (event === "session_shutdown") {
				captured.shutdownHandlers.push(() => handler({ type: "session_shutdown" }, {}));
			}
		},
		registerTool(tool: any) {
			captured.tools.set(tool.name, tool);
		},
		// unused API surface — stubbed so the extension's factory never crashes
		registerCommand() {},
		registerShortcut() {},
		registerFlag() {},
		getFlag() { return undefined; },
		registerMessageRenderer() {},
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
		setSessionName() {},
		getSessionName() { return undefined; },
		setLabel() {},
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		getActiveTools() { return []; },
		getAllTools() { return []; },
		setActiveTools() {},
		getCommands() { return []; },
		setModel: async () => true,
		getThinkingLevel() { return "off"; },
		setThinkingLevel() {},
		registerProvider() {},
		unregisterProvider() {},
		events: { emit() {}, on() {}, off() {} },
	};
}

// ─────────────────────────────── harness ─────────────────────────────────────

const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "browser-screenshot-test-"));
const captured: Captured = { tools: new Map(), shutdownHandlers: [] };

// Dynamically import the extension (tsx handles the TS-by-URL import).
const extensionUrl = new URL(
	"../defaults/tools/browser/extension.ts",
	import.meta.url,
).href;

// Install the extension once for the whole file.
before(async () => {
	const mod: any = await import(extensionUrl);
	const install = mod.default ?? mod.install;
	assert.equal(typeof install, "function", "browser extension must export a default factory");
	install(makeMockPi(captured));
	assert.ok(
		captured.tools.has("browser_screenshot"),
		"browser_screenshot tool should be registered (is `playwright` installed?)",
	);
});

after(async () => {
	for (const fn of captured.shutdownHandlers) await fn();
	try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* ok */ }
});

async function runScreenshot(params: Record<string, unknown>) {
	const tool = captured.tools.get("browser_screenshot");
	assert.ok(tool, "browser_screenshot tool missing");
	const ctx = {
		cwd: tmpCwd,
		hasUI: false,
		sessionManager: {} as any,
		modelRegistry: {} as any,
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		ui: {} as any,
	} as any;
	return tool.execute("call-1", params, undefined, undefined, ctx);
}

async function navigateTo(url: string) {
	const nav = captured.tools.get("browser_navigate");
	assert.ok(nav, "browser_navigate tool missing");
	const ctx: any = { cwd: tmpCwd };
	await nav.execute("nav-1", { url }, undefined, undefined, ctx);
}

function sumTextLength(content: Array<any>): number {
	return content
		.filter((b) => b && b.type === "text" && typeof b.text === "string")
		.reduce((n, b) => n + (b.text as string).length, 0);
}

function imageBlocks(content: Array<any>): Array<any> {
	return content.filter((b) => b && b.type === "image");
}

// ─────────────────────────────── tests ───────────────────────────────────────

describe("browser_screenshot does not duplicate base64 payload as text", () => {
	it("keeps combined text content under 2 KB at default viewport with includeBase64=true", async () => {
		// Offline, deterministic — a data URL page with a solid color fill so the
		// PNG is non-trivially large after base64-encoding.
		await navigateTo(
			"data:text/html,<html><body style='margin:0;background:#3366cc;width:100vw;height:100vh'></body></html>",
		);

		const result: any = await runScreenshot({ includeBase64: true });
		const content = result?.content ?? [];

		// Must still emit exactly one image block with non-empty base64 data.
		const images = imageBlocks(content);
		assert.equal(images.length, 1, "expected exactly one image content block");
		assert.equal(images[0].mimeType, "image/png", "image block should be image/png");
		assert.ok(
			typeof images[0].data === "string" && images[0].data.length > 100,
			"image block should carry non-empty base64 data for the vision pipeline",
		);

		// Text content must be tiny. Today this fails because the extension
		// appends a `[screenshot_base64]\ndata:image/png;base64,...` text block
		// carrying the whole image a second time.
		const textLen = sumTextLength(content);
		assert.ok(
			textLen < 2048,
			`expected text content < 2048 bytes, got ${textLen} bytes — likely duplicate base64 payload in text block`,
		);
	});

	it("spills screenshot to disk and returns [screenshot_file] path when includeBase64=true", async () => {
		await navigateTo(
			"data:text/html,<html><body style='margin:0;background:#228833;width:100vw;height:100vh'></body></html>",
		);

		const result: any = await runScreenshot({ includeBase64: true });
		const content = result?.content ?? [];

		const fileBlocks = content.filter(
			(b: any) => b && b.type === "text" && typeof b.text === "string" && b.text.startsWith("[screenshot_file]"),
		);
		assert.equal(fileBlocks.length, 1, "expected exactly one [screenshot_file] text block");
		const match = /^\[screenshot_file\](.+?)\[\/screenshot_file\]$/.exec(fileBlocks[0].text);
		assert.ok(match, "expected well-formed [screenshot_file]<path>[/screenshot_file]");
		const filePath = match![1];
		assert.ok(fs.existsSync(filePath), `spilled file should exist on disk: ${filePath}`);
		assert.ok(filePath.includes("/.bobbit-qa/screenshots/"), `path should be under .bobbit-qa/screenshots/: ${filePath}`);
		assert.ok(filePath.endsWith(".png"), `default format should write .png: ${filePath}`);

		// Bytes on disk should equal the base64 payload in the image block.
		const diskBytes = fs.readFileSync(filePath);
		const images = imageBlocks(content);
		assert.equal(images.length, 1);
		const imgBytes = Buffer.from(images[0].data as string, "base64");
		assert.ok(diskBytes.equals(imgBytes), "disk bytes must match image content block base64");
	});

	it("writes .jpg with image/jpeg mimeType when format='jpeg'", async () => {
		await navigateTo(
			"data:text/html,<html><body style='margin:0;background:#cc8833;width:100vw;height:100vh'></body></html>",
		);

		const result: any = await runScreenshot({ includeBase64: true, format: "jpeg", quality: 75 });
		const content = result?.content ?? [];

		const images = imageBlocks(content);
		assert.equal(images.length, 1);
		assert.equal(images[0].mimeType, "image/jpeg", "image block mimeType should be image/jpeg");

		const fileBlock = content.find(
			(b: any) => b && b.type === "text" && typeof b.text === "string" && b.text.startsWith("[screenshot_file]"),
		);
		assert.ok(fileBlock, "expected [screenshot_file] block");
		const match = /^\[screenshot_file\](.+?)\[\/screenshot_file\]$/.exec(fileBlock.text);
		assert.ok(match, "well-formed [screenshot_file] block");
		assert.ok(match![1].endsWith(".jpg"), `jpeg format should write .jpg extension: ${match![1]}`);
		assert.ok(fs.existsSync(match![1]), "jpeg file should exist on disk");
	});

	it("creates no file and returns no [screenshot_file] block when includeBase64 is omitted or false", async () => {
		await navigateTo(
			"data:text/html,<html><body style='margin:0;background:#113355;width:100vw;height:100vh'></body></html>",
		);

		const dir = path.join(tmpCwd, ".bobbit-qa", "screenshots");
		const filesBefore = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;

		for (const params of [{}, { includeBase64: false }]) {
			const result: any = await runScreenshot(params);
			const content = result?.content ?? [];
			const hasFileBlock = content.some(
				(b: any) => b && b.type === "text" && typeof b.text === "string" && b.text.includes("[screenshot_file]"),
			);
			assert.equal(hasFileBlock, false, "no [screenshot_file] block without includeBase64");
		}

		const filesAfter = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
		assert.equal(filesAfter, filesBefore, "no new files should be created when includeBase64 is not set");
	});

	it("keeps combined text content under 2 KB at 1920x1080 with includeBase64=true", async () => {
		const resize = captured.tools.get("browser_resize");
		assert.ok(resize, "browser_resize tool missing");
		await resize.execute("rs-1", { width: 1920, height: 1080 }, undefined, undefined, { cwd: tmpCwd } as any);

		// Larger viewport → larger PNG → tempting but wrong to re-embed.
		await navigateTo(
			"data:text/html,<html><body style='margin:0;background:linear-gradient(45deg,#ff0080,#00e0ff);width:100vw;height:100vh'></body></html>",
		);

		const result: any = await runScreenshot({ includeBase64: true, fullPage: true });
		const content = result?.content ?? [];

		const images = imageBlocks(content);
		assert.equal(images.length, 1, "expected exactly one image content block at 1920x1080");
		assert.ok(
			typeof images[0].data === "string" && images[0].data.length > 1000,
			"image block should still carry the full PNG base64 at 1920x1080",
		);

		const textLen = sumTextLength(content);
		assert.ok(
			textLen < 2048,
			`expected text content < 2048 bytes at 1920x1080, got ${textLen} bytes — regression: large image re-embedded as text`,
		);
	});
});
