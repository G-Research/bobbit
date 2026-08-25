import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/inline-html-theme-renderers-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "inline-html-theme-renderers-bundle.js");
const WRITE_RENDERER_SRC = path.resolve("src/ui/tools/renderers/WriteRenderer.ts");
const EDIT_RENDERER_SRC = path.resolve("src/ui/tools/renderers/EditRenderer.ts");
const HTML_RENDERER_SRC = path.resolve("src/ui/tools/renderers/HtmlRenderer.ts");
const THEME_BRIDGE_SRC = path.resolve("src/shared/preview-bridge-scripts.ts");

const LIGHT_TOKENS = {
	background: "#f8fafc",
	foreground: "#172033",
	card: "#ffffff",
	positive: "#15803d",
	chart: "#2563eb",
};
const LIGHT_RESOLVED = {
	background: "rgb(248, 250, 252)",
	foreground: "rgb(23, 32, 51)",
	card: "rgb(255, 255, 255)",
	cardForeground: "rgb(23, 32, 51)",
	positive: "rgb(21, 128, 61)",
	chart: "rgb(37, 99, 235)",
};
const DARK_ROSE_TOKENS = {
	background: "#111827",
	foreground: "#f8fafc",
	card: "#1f2937",
	positive: "#4ade80",
	chart: "#fb7185",
};
const DARK_ROSE_RESOLVED = {
	background: "rgb(17, 24, 39)",
	foreground: "rgb(248, 250, 252)",
	card: "rgb(31, 41, 55)",
	cardForeground: "rgb(248, 250, 252)",
	positive: "rgb(74, 222, 128)",
	chart: "rgb(251, 113, 133)",
};

function resolveSourceImport(importer: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const unresolved = path.resolve(path.dirname(importer), specifier);
	const withoutJsExtension = unresolved.replace(/\.js$/, "");
	const candidates = [
		unresolved,
		`${unresolved}.ts`,
		`${withoutJsExtension}.ts`,
		path.join(unresolved, "index.ts"),
		path.join(withoutJsExtension, "index.ts"),
	];
	return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

/** Follow source-relative imports so this browser fixture cannot silently fall back to a renderer mirror. */
function collectStaticSourceGraph(entry: string): Set<string> {
	const visited = new Set<string>();
	const pending = [entry];
	const importPattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
	while (pending.length > 0) {
		const file = path.normalize(pending.pop()!);
		if (visited.has(file)) continue;
		visited.add(file);
		const source = fs.readFileSync(file, "utf8");
		for (const match of source.matchAll(importPattern)) {
			const resolved = resolveSourceImport(file, match[1]);
			if (resolved) pending.push(resolved);
		}
	}
	return visited;
}

let sourceGraph = new Set<string>();

test.beforeAll(() => {
	sourceGraph = collectStaticSourceGraph(ENTRY);
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [...sourceGraph] });
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__inlineThemeFixtureReady === true, null, { timeout: 10_000 });
}

async function frameState(page: Page, hostId: "write-host" | "edit-host"): Promise<any> {
	return page.evaluate((id) => (window as any).__inlineThemeFrameState(id), hostId);
}

async function waitForAuthoredMarker(page: Page, hostId: "write-host" | "edit-host", marker: string): Promise<void> {
	await expect(page.locator(`#${hostId} iframe`)).toHaveCount(1);
	await expect.poll(async () => (await frameState(page, hostId)).authored?.marker, {
		timeout: 5_000,
		message: `authored script ${marker} should execute in the inline iframe`,
	}).toBe(marker);
}

async function documents(page: Page): Promise<Record<string, string>> {
	return page.evaluate(() => (window as any).__inlineThemeDocuments);
}

test.describe("inline HTML theme bridge from source renderer modules", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("source import graph and executed browser bundle include the canonical theme bridge without server snapshot code", async () => {
		const normalized = [...sourceGraph];
		expect(normalized, "fixture must import the real WriteRenderer source module").toContain(path.normalize(WRITE_RENDERER_SRC));
		expect(normalized, "fixture must import the real EditRenderer source module").toContain(path.normalize(EDIT_RENDERER_SRC));
		expect(normalized, "WriteRenderer/EditRenderer must statically reach the real HtmlRenderer").toContain(path.normalize(HTML_RENDERER_SRC));
		expect(normalized, "HtmlRenderer's browser import graph must reach the canonical PREVIEW_THEME_BRIDGE module").toContain(path.normalize(THEME_BRIDGE_SRC));

		const bundle = fs.readFileSync(BUNDLE, "utf8");
		expect(bundle, "the executed source fixture bundle must carry the canonical bridge module").toContain("src/shared/preview-bridge-scripts.ts");
		expect(bundle, "the executed source fixture bundle must carry inline bridge preparation").toContain("data-bobbit-inline-theme-bridge");
		expect(bundle, "inline srcdoc theming must not import the server filesystem snapshot path").not.toContain("src/server/preview/theme-snapshot");
	});

	test("completed WriteRenderer resolves light tokens and live-switches dark palette on the same iframe", async ({ page }) => {
		const fixtureDocuments = await documents(page);
		await page.evaluate((content) => {
			(window as any).__setInlineThemeHost(false, "azure");
			(window as any).__renderInlineThemeWrite(content, true);
		}, fixtureDocuments.write);
		await waitForAuthoredMarker(page, "write-host", "write-complete");

		const light = await frameState(page, "write-host");
		expect(light.sandbox).toBe("allow-scripts allow-same-origin");
		expect(light.dark).toBe(false);
		expect(light.palette).toBe("azure");
		expect(light.font).toContain("Fixture Source Sans");
		expect(light.tokens).toEqual(LIGHT_TOKENS);
		expect(light.resolved).toEqual(LIGHT_RESOLVED);
		expect(light.authored).toMatchObject({
			marker: "write-complete",
			runs: 1,
			parse: { dark: false, palette: "azure", tokens: LIGHT_TOKENS },
		});
		expect(light.authored.parse.font).toContain("Fixture Source Sans");
		expect(light.source).toBe(fixtureDocuments.write);
		expect(light.sourceCollapsed).toBe(true);
		expect(light.srcdoc).toContain("write-complete");
		expect(light.srcdoc).not.toContain("preview-swipe-start");

		await page.evaluate(() => {
			(window as any).__tagInlineThemeFrame("write-host", "same-write-iframe");
			(window as any).__setInlineThemeHost(true, "rose");
		});
		await expect.poll(async () => (await frameState(page, "write-host")).tokens, { timeout: 5_000 }).toEqual(DARK_ROSE_TOKENS);

		const dark = await frameState(page, "write-host");
		expect(dark.identity, "live theme changes must not recreate the iframe/tool call").toBe("same-write-iframe");
		expect(dark.srcdoc, "live theme changes must not rewrite authored srcdoc").toBe(light.srcdoc);
		expect(dark.dark).toBe(true);
		expect(dark.palette).toBe("rose");
		expect(dark.font).toContain("Fixture Source Sans");
		expect(dark.resolved).toEqual(DARK_ROSE_RESOLVED);
		expect(dark.authored, "authored initialization must not rerun for a live host theme mutation").toMatchObject({
			marker: "write-complete",
			runs: 1,
			parse: { dark: false, palette: "azure", tokens: LIGHT_TOKENS },
		});

		const swipeMessages = await page.evaluate(() => (window as any).__dispatchInlineThemeSwipe("write-host"));
		expect(swipeMessages, "inline chat iframe gestures must not emit side-panel swipe messages").toEqual([]);

		await page.locator("#write-host button").first().click();
		expect((await frameState(page, "write-host")).sourceCollapsed).toBe(false);
		expect((await frameState(page, "write-host")).source).toBe(fixtureDocuments.write);
	});

	test("WriteRenderer keeps the canonical bridge through debounced streaming and completion", async ({ page }) => {
		const fixtureDocuments = await documents(page);
		await page.evaluate((content) => {
			(window as any).__setInlineThemeHost(true, "rose");
			(window as any).__renderInlineThemeWrite(content, false);
		}, fixtureDocuments.streamInitial);
		await waitForAuthoredMarker(page, "write-host", "stream-initial");

		const initial = await frameState(page, "write-host");
		expect(initial.authored).toMatchObject({
			marker: "stream-initial",
			parse: { dark: true, palette: "rose", tokens: DARK_ROSE_TOKENS },
		});
		expect(initial.tokens).toEqual(DARK_ROSE_TOKENS);
		expect(initial.resolved).toEqual(DARK_ROSE_RESOLVED);
		expect(initial.streamingChrome).toBe(true);

		await page.evaluate((content) => {
			(window as any).__tagInlineThemeFrame("write-host", "streaming-iframe");
			(window as any).__renderInlineThemeWrite(content, false);
		}, fixtureDocuments.streamUpdate);
		await waitForAuthoredMarker(page, "write-host", "stream-updated");
		expect((await frameState(page, "write-host")).identity, "debounced stream writes should reuse the mounted iframe").toBe("streaming-iframe");
		expect((await frameState(page, "write-host")).tokens).toEqual(DARK_ROSE_TOKENS);

		await page.evaluate((content) => (window as any).__renderInlineThemeWrite(content, true), fixtureDocuments.streamComplete);
		await waitForAuthoredMarker(page, "write-host", "stream-complete");
		const complete = await frameState(page, "write-host");
		expect(complete.streamingChrome).toBe(false);
		expect(complete.sandbox).toBe("allow-scripts allow-same-origin");
		expect(complete.dark).toBe(true);
		expect(complete.palette).toBe("rose");
		expect(complete.tokens).toEqual(DARK_ROSE_TOKENS);
		expect(complete.resolved).toEqual(DARK_ROSE_RESOLVED);
		expect(complete.source).toBe(fixtureDocuments.streamComplete);
		expect(complete.sourceCollapsed).toBe(true);
		expect(complete.srcdoc).not.toContain("preview-swipe-start");
	});

	test("EditRenderer fetch delegation uses the same themed iframe and preserves authored source", async ({ page }) => {
		const fixtureDocuments = await documents(page);
		await page.evaluate(async (content) => {
			(window as any).__setInlineThemeHost(false, "azure");
			await (window as any).__renderInlineThemeEdit(content);
		}, fixtureDocuments.edit);
		await waitForAuthoredMarker(page, "edit-host", "edit-complete");

		const edit = await frameState(page, "edit-host");
		expect(edit.sandbox).toBe("allow-scripts allow-same-origin");
		expect(edit.tokens).toEqual(LIGHT_TOKENS);
		expect(edit.resolved).toEqual(LIGHT_RESOLVED);
		expect(edit.authored).toMatchObject({
			marker: "edit-complete",
			runs: 1,
			parse: { dark: false, palette: "azure", tokens: LIGHT_TOKENS },
		});
		expect(edit.source).toBe(fixtureDocuments.edit);
		expect(edit.sourceCollapsed).toBe(true);
		expect(edit.srcdoc).not.toContain("preview-swipe-start");

		const fetchLog = await page.evaluate(() => (window as any).__inlineThemeFetchLog());
		expect(fetchLog).toHaveLength(1);
		expect(fetchLog[0].url).toContain("/api/sessions/11111111-1111-4111-8111-111111111111/file-content?path=edited-theme-card.htm&snapshotId=edit-theme-call");
		expect(fetchLog[0].authorization).toBe("Bearer fixture-token");

		await page.locator("#edit-host button").first().click();
		expect((await frameState(page, "edit-host")).sourceCollapsed).toBe(false);
		expect(await page.evaluate(() => (window as any).__dispatchInlineThemeSwipe("edit-host"))).toEqual([]);
	});
});
