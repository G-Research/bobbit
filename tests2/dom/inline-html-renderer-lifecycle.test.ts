import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { PREVIEW_SWIPE_SCRIPT, PREVIEW_THEME_BRIDGE } from "../../src/shared/preview-bridge-scripts.js";
import { EditRenderer } from "../../src/ui/tools/renderers/EditRenderer.js";
import { HtmlRenderer } from "../../src/ui/tools/renderers/HtmlRenderer.js";
import {
	INLINE_HTML_PREPARATION_CACHE_LIMITS,
	INLINE_HTML_THEME_BRIDGE_ATTRIBUTE,
	prepareInlineHtml,
	resetInlineHtmlPreparationCacheForTests,
} from "../../src/ui/tools/renderers/prepare-inline-html.js";
import { WriteRenderer } from "../../src/ui/tools/renderers/WriteRenderer.js";

const okResult = {
	isError: false,
	toolCallId: "tool-call-theme-preview",
	content: [{ type: "text", text: "ok" }],
} as any;

const AUTHORED_HTML = `<!DOCTYPE html><!--leading-document-comment-->
<html><head><!--original-head-comment-->
<script id="authored-init">
window.__themeAtParse = {
  background: getComputedStyle(document.documentElement).getPropertyValue('--background'),
  foreground: getComputedStyle(document.documentElement).getPropertyValue('--foreground'),
  card: getComputedStyle(document.documentElement).getPropertyValue('--card'),
  positive: getComputedStyle(document.documentElement).getPropertyValue('--positive'),
  chart: getComputedStyle(document.documentElement).getPropertyValue('--chart-1'),
  font: document.documentElement.style.fontFamily,
  dark: document.documentElement.classList.contains('dark'),
  palette: document.documentElement.getAttribute('data-palette')
};
window.__scriptLiteral = "</body>";
window.__templateLiteral = \`template:</body>\`;
</script>
<style id="hostile-style">.probe::after { content: "</body>"; }</style>
</head><body>
<!--hostile-comment:</body>-->
<textarea id="hostile-textarea"></body></textarea>
<div id="authored-body" style="background:var(--card);color:var(--foreground)">themed</div>
<script id="authored-tail">window.__authoredTail = (window.__authoredTail || 0) + 1;</script>
</body></html>`;

function canonicalBridgeBody(): string {
	const doc = new DOMParser().parseFromString(PREVIEW_THEME_BRIDGE, "text/html");
	const script = doc.querySelector("script");
	if (!script) throw new Error("canonical theme bridge is not a script");
	return script.textContent?.trim() ?? "";
}

function bridgeScripts(doc: Document): HTMLScriptElement[] {
	const canonical = canonicalBridgeBody();
	return Array.from(doc.querySelectorAll("script")).filter(script => script.textContent?.trim() === canonical);
}

function mountHtml(renderer: HtmlRenderer, content: string, result: any = okResult, streaming = false) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	render(renderer.render({ path: "theme-card.html", content }, result, streaming).content, container);
	const iframe = container.querySelector("iframe");
	if (!iframe) throw new Error("HtmlRenderer did not render an iframe");
	return { container, iframe };
}

function parsedSrcdoc(iframe: HTMLIFrameElement): Document {
	expect(iframe.srcdoc, "inline iframe should receive a prepared srcdoc payload").not.toBe("");
	return new DOMParser().parseFromString(iframe.srcdoc, "text/html");
}

function originalSource(container: HTMLElement): string {
	const codeBlock = container.querySelector("code-block") as any;
	if (!codeBlock) throw new Error("inline source disclosure is missing");
	expect(codeBlock.parentElement?.classList.contains("max-h-0"), "inline source should start collapsed").toBe(true);
	return codeBlock.code;
}

function declaration(...names: string[]): Record<string | number, unknown> {
	const style: Record<string | number, unknown> = { length: names.length };
	for (let index = 0; index < names.length; index++) style[index] = names[index];
	return style;
}

function executePreparedScripts(doc: Document): Record<string, unknown> {
	const hostRoot = {
		classList: { contains: (name: string) => name === "dark" },
		getAttribute: (name: string) => name === "data-palette" ? "violet" : null,
	};
	const values: Record<string, string> = {
		"--background": "surface-value",
		"--foreground": "foreground-value",
		"--card": "card-value",
		"--positive": "positive-value",
		"--chart-1": "chart-value",
	};
	const hostDocument = {
		documentElement: hostRoot,
		styleSheets: [{ cssRules: [{ style: declaration(...Object.keys(values)) }] }],
	};
	class MutationObserverStub {
		observe(): void {}
	}
	const sandbox: Record<string, any> = {
		document: doc,
		parent: {
			document: hostDocument,
			getComputedStyle: () => ({
				fontFamily: "Inter, ui-sans-serif, system-ui",
				getPropertyValue: (name: string) => values[name] ?? "",
			}),
		},
		MutationObserver: MutationObserverStub,
		getComputedStyle: (element: HTMLElement) => ({
			getPropertyValue: (name: string) => element.style.getPropertyValue(name),
		}),
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	const context = vm.createContext(sandbox);
	for (const script of Array.from(doc.querySelectorAll("script"))) {
		vm.runInContext(script.textContent ?? "", context);
	}
	return sandbox;
}

function expectPreparedInlineFrame(iframe: HTMLIFrameElement): Document {
	expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
	const doc = parsedSrcdoc(iframe);
	expect(bridgeScripts(doc)).toHaveLength(1);
	expect(iframe.srcdoc).not.toContain("preview-swipe-start");
	expect(iframe.srcdoc).not.toContain(PREVIEW_SWIPE_SCRIPT);
	return doc;
}

beforeEach(() => {
	resetInlineHtmlPreparationCacheForTests();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
	localStorage.clear();
	window.location.hash = "";
});

describe("inline HTML preparation memoization", () => {
	function fixture(id: string, body = id): string {
		return `<!doctype html><html><head><title>${id}</title></head><body>${body}</body></html>`;
	}

	it("reuses several prepared documents while parsing the canonical bridge only once", () => {
		const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
		const first = fixture("first");
		const changed = fixture("changed");

		const preparedFirst = prepareInlineHtml(first);
		expect(preparedFirst).toContain(INLINE_HTML_THEME_BRIDGE_ATTRIBUTE);
		expect(parse).toHaveBeenCalledTimes(2); // canonical bridge + authored document

		expect(prepareInlineHtml(first)).toBe(preparedFirst);
		expect(parse).toHaveBeenCalledTimes(2);

		const preparedChanged = prepareInlineHtml(changed);
		expect(preparedChanged).toContain("changed");
		expect(parse).toHaveBeenCalledTimes(3); // changed authored document only

		// This is a bounded multi-entry cache, not a single last-value shortcut.
		expect(prepareInlineHtml(first)).toBe(preparedFirst);
		expect(parse).toHaveBeenCalledTimes(3);
	});

	it("evicts the least-recently-used document at the entry bound", () => {
		const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
		const documents = Array.from(
			{ length: INLINE_HTML_PREPARATION_CACHE_LIMITS.maxEntries + 1 },
			(_, index) => fixture(`entry-${index}`),
		);

		for (const content of documents.slice(0, INLINE_HTML_PREPARATION_CACHE_LIMITS.maxEntries)) {
			prepareInlineHtml(content);
		}
		expect(parse).toHaveBeenCalledTimes(INLINE_HTML_PREPARATION_CACHE_LIMITS.maxEntries + 1);

		prepareInlineHtml(documents[0]); // promote the oldest entry
		expect(parse).toHaveBeenCalledTimes(INLINE_HTML_PREPARATION_CACHE_LIMITS.maxEntries + 1);

		prepareInlineHtml(documents.at(-1)!); // evicts entry 1, not promoted entry 0
		expect(parse).toHaveBeenCalledTimes(INLINE_HTML_PREPARATION_CACHE_LIMITS.maxEntries + 2);
		prepareInlineHtml(documents[1]);
		expect(parse).toHaveBeenCalledTimes(INLINE_HTML_PREPARATION_CACHE_LIMITS.maxEntries + 3);
	});

	it("evicts by retained input-plus-output size below the entry bound", () => {
		const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
		const payloadCharacters = Math.floor(INLINE_HTML_PREPARATION_CACHE_LIMITS.maxRetainedBytes / 10);
		const documents = Array.from(
			{ length: 3 },
			(_, index) => fixture(`sized-${index}`, `${index}${"x".repeat(payloadCharacters)}`),
		);
		expect(documents).toHaveLength(3);
		expect(documents.length).toBeLessThan(INLINE_HTML_PREPARATION_CACHE_LIMITS.maxEntries);
		expect(documents.every(content => content.length * 2 < INLINE_HTML_PREPARATION_CACHE_LIMITS.maxCacheableContentBytes)).toBe(true);

		for (const content of documents) prepareInlineHtml(content);
		expect(parse).toHaveBeenCalledTimes(4); // canonical bridge + three documents

		// Three input/output pairs exceed the byte budget, so the first is gone.
		prepareInlineHtml(documents[0]);
		expect(parse).toHaveBeenCalledTimes(5);
	});

	it("does not retain oversized authored documents", () => {
		const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
		const oversized = fixture(
			"oversized",
			"x".repeat(Math.floor(INLINE_HTML_PREPARATION_CACHE_LIMITS.maxCacheableContentBytes / 2) + 1),
		);
		expect(oversized.length * 2).toBeGreaterThan(INLINE_HTML_PREPARATION_CACHE_LIMITS.maxCacheableContentBytes);

		const prepared = prepareInlineHtml(oversized);
		expect(prepared).toContain(INLINE_HTML_THEME_BRIDGE_ATTRIBUTE);
		expect(parse).toHaveBeenCalledTimes(2);
		expect(prepareInlineHtml(oversized)).toBe(prepared);
		expect(parse).toHaveBeenCalledTimes(3); // canonical descriptor is warm; authored HTML is not
	});

	it("does not cache a fail-open raw return and recovers when browser APIs return", () => {
		const NativeXMLSerializer = XMLSerializer;
		const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
		const content = fixture("api-recovery");

		vi.stubGlobal("XMLSerializer", undefined);
		expect(prepareInlineHtml(content)).toBe(content);
		expect(parse).not.toHaveBeenCalled();

		vi.stubGlobal("XMLSerializer", NativeXMLSerializer);
		const recovered = prepareInlineHtml(content);
		expect(recovered).toContain(INLINE_HTML_THEME_BRIDGE_ATTRIBUTE);
		expect(parse).toHaveBeenCalledTimes(2);
		expect(prepareInlineHtml(content)).toBe(recovered);
		expect(parse).toHaveBeenCalledTimes(2);
	});
});

describe("inline HtmlRenderer preparation", () => {
	it("preserves hostile authored syntax and makes the canonical bridge first for parse-time theme reads", () => {
		const renderer = new HtmlRenderer();
		const { container, iframe } = mountHtml(renderer, AUTHORED_HTML);
		const doc = expectPreparedInlineFrame(iframe);

		// happy-dom does not expose Document.compatMode; preserving an HTML doctype
		// at byte zero is the standards-mode contract exercised by real browsers.
		expect(iframe.srcdoc).toMatch(/^<!DOCTYPE html>/i);
		expect(doc.doctype?.name.toLowerCase()).toBe("html");
		const documentNodes = Array.from(doc.childNodes);
		const leadingComment = documentNodes.find(node => node.nodeType === Node.COMMENT_NODE && node.textContent === "leading-document-comment");
		expect(leadingComment).toBeTruthy();
		expect(iframe.srcdoc.match(/<!--leading-document-comment-->/g)).toHaveLength(1);

		const scripts = Array.from(doc.querySelectorAll("script"));
		expect(scripts[0].textContent?.trim()).toBe(canonicalBridgeBody());
		expect(scripts.slice(1).map(script => script.id)).toEqual(["authored-init", "authored-tail"]);
		expect(doc.querySelector<HTMLScriptElement>("#authored-init")?.textContent).toContain('"</body>"');
		expect(doc.querySelector<HTMLStyleElement>("#hostile-style")?.textContent).toContain('"</body>"');
		const textarea = doc.querySelector<HTMLTextAreaElement>("#hostile-textarea");
		const textareaProbe = new DOMParser().parseFromString("<textarea></body></textarea>", "text/html").querySelector("textarea");
		if (textareaProbe?.textContent === "</body>") {
			expect(textarea?.textContent).toBe("</body>");
		} else {
			// happy-dom 20 incorrectly drops this RCDATA literal. Keep the raw fixture
			// and source-disclosure assertion active while browser coverage owns parsing.
			expect(textarea).toBeTruthy();
			expect(AUTHORED_HTML).toContain('<textarea id="hostile-textarea"></body></textarea>');
		}
		expect(Array.from(doc.body.childNodes).some(node =>
			node.nodeType === Node.COMMENT_NODE && node.textContent === "hostile-comment:</body>",
		)).toBe(true);
		expect(doc.querySelector("#authored-body")?.textContent).toBe("themed");

		const executed = executePreparedScripts(doc);
		expect(executed.__themeAtParse).toEqual({
			background: "surface-value",
			foreground: "foreground-value",
			card: "card-value",
			positive: "positive-value",
			chart: "chart-value",
			font: "Inter, ui-sans-serif, system-ui",
			dark: true,
			palette: "violet",
		});
		expect(executed.__scriptLiteral).toBe("</body>");
		expect(executed.__templateLiteral).toBe("template:</body>");
		expect(executed.__authoredTail).toBe(1);
		expect(originalSource(container)).toBe(AUTHORED_HTML);

		const frameStyle = iframe.getAttribute("style") ?? "";
		expect(frameStyle).toMatch(/background(?:-color)?\s*:\s*var\(--(?:background|card)/);
		expect(frameStyle).not.toContain("#0c0c1a");
	});

	it("is preparation-idempotent and retains fragments and SVG-in-HTML inputs", () => {
		const first = mountHtml(new HtmlRenderer(), AUTHORED_HTML);
		const preparedOnce = first.iframe.srcdoc;
		first.container.remove();

		const second = mountHtml(new HtmlRenderer(), preparedOnce);
		const preparedTwice = parsedSrcdoc(second.iframe);
		expect(bridgeScripts(preparedTwice)).toHaveLength(1);
		expect(preparedTwice.querySelectorAll("#authored-init")).toHaveLength(1);

		for (const fragment of [
			'<div id="fragment">fragment body</div>',
			'<svg id="inline-svg" viewBox="0 0 10 10"><text>svg body</text></svg>',
		]) {
			const mounted = mountHtml(new HtmlRenderer(), fragment);
			const parsed = expectPreparedInlineFrame(mounted.iframe);
			expect(parsed.querySelector(fragment.startsWith("<svg") ? "#inline-svg" : "#fragment")?.textContent).toContain("body");
			expect(originalSource(mounted.container)).toBe(fragment);
			mounted.container.remove();
		}
	});

	it("injects beside an authored marker collision and stays idempotent on repeated preparation", () => {
		const collision = `<!doctype html><html><head>
<script ${INLINE_HTML_THEME_BRIDGE_ATTRIBUTE}></script>
<script id="authored-after-marker">window.__authoredAfterMarker = true;</script>
</head><body>marker collision</body></html>`;

		const preparedOnce = prepareInlineHtml(collision);
		const preparedDocument = new DOMParser().parseFromString(preparedOnce, "text/html");
		const markedScripts = preparedDocument.querySelectorAll<HTMLScriptElement>(
			`script[${INLINE_HTML_THEME_BRIDGE_ATTRIBUTE}]`,
		);
		expect(markedScripts).toHaveLength(2);
		expect(bridgeScripts(preparedDocument)).toHaveLength(1);
		expect(preparedDocument.querySelector("head > script")?.textContent?.trim()).toBe(canonicalBridgeBody());
		expect(Array.from(markedScripts).some(script => script.textContent === "")).toBe(true);
		expect(preparedDocument.querySelector("#authored-after-marker")?.textContent).toContain("__authoredAfterMarker");

		const preparedTwice = prepareInlineHtml(preparedOnce);
		expect(preparedTwice).toBe(preparedOnce);
		const repeatedDocument = new DOMParser().parseFromString(preparedTwice, "text/html");
		expect(bridgeScripts(repeatedDocument)).toHaveLength(1);
		expect(repeatedDocument.querySelectorAll(`script[${INLINE_HTML_THEME_BRIDGE_ATTRIBUTE}]`)).toHaveLength(2);
	});

	it("keeps a historical completed iframe stable across equivalent parent renders", () => {
		const renderer = new HtmlRenderer();
		const { container, iframe } = mountHtml(renderer, AUTHORED_HTML);
		const prepared = iframe.srcdoc;

		render(renderer.render({ path: "theme-card.html", content: AUTHORED_HTML }, okResult, false).content, container);

		const rerendered = container.querySelector("iframe")!;
		expect(rerendered).toBe(iframe);
		expect(rerendered.srcdoc).toBe(prepared);
		expectPreparedInlineFrame(rerendered);
		expect(originalSource(container)).toBe(AUTHORED_HTML);
	});
});

describe("inline HtmlRenderer streaming lifecycle", () => {
	it("writes prepared content on load, preserves debounce and resize, then completes declaratively", () => {
		vi.useFakeTimers();
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		const renderer = new HtmlRenderer();
		const firstContent = '<!doctype html><html><body><div id="first">first</div></body></html>';
		const secondContent = '<!doctype html><html><body><div id="second">second</div></body></html>';
		const { container, iframe } = mountHtml(renderer, firstContent, null, true);
		const written: string[] = [];
		const fakeDocument = {
			open: vi.fn(),
			write: vi.fn((payload: string) => written.push(payload)),
			close: vi.fn(),
			body: { scrollHeight: 420 },
		};
		Object.defineProperty(iframe, "contentDocument", { configurable: true, value: fakeDocument });

		iframe.dispatchEvent(new Event("load"));
		expect(fakeDocument.open).toHaveBeenCalledTimes(1);
		expect(fakeDocument.close).toHaveBeenCalledTimes(1);
		expect(written).toHaveLength(1);
		expect(bridgeScripts(new DOMParser().parseFromString(written[0], "text/html"))).toHaveLength(1);
		expect(written[0]).not.toContain("preview-swipe-start");
		expect(iframe.style.height).toBe("436px");
		expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
		expect(originalSource(container)).toBe(firstContent);

		render(renderer.render({ path: "theme-card.html", content: secondContent }, undefined, true).content, container);
		expect(written).toHaveLength(1);
		vi.advanceTimersByTime(1499);
		expect(written).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(written).toHaveLength(2);
		const streamed = new DOMParser().parseFromString(written[1], "text/html");
		expect(bridgeScripts(streamed)).toHaveLength(1);
		expect(streamed.querySelector("#second")?.textContent).toBe("second");

		render(renderer.render({ path: "theme-card.html", content: secondContent }, okResult, false).content, container);
		const completedIframe = container.querySelector("iframe")!;
		expectPreparedInlineFrame(completedIframe);
		expect(parsedSrcdoc(completedIframe).querySelector("#second")?.textContent).toBe("second");
		expect(originalSource(container)).toBe(secondContent);
		expect(container.querySelector("iframe + div")).toBeNull();
	});

	it("keeps streaming chrome theme-backed and ignores a stale about:blank load after completion", () => {
		const renderer = new HtmlRenderer();
		const streaming = mountHtml(renderer, '<div id="partial">partial</div>', null, true);
		const staleIframe = streaming.iframe;
		const staleWrite = vi.fn();
		Object.defineProperty(staleIframe, "contentDocument", {
			configurable: true,
			value: { open: vi.fn(), write: staleWrite, close: vi.fn(), body: { scrollHeight: 100 } },
		});
		const overlay = streaming.container.querySelector("iframe + div") as HTMLElement;
		expect(overlay).toBeTruthy();
		const chromeStyles = [
			staleIframe.getAttribute("style") ?? "",
			overlay.getAttribute("style") ?? "",
			...Array.from(overlay.querySelectorAll<HTMLElement>("[style]")).map(element => element.getAttribute("style") ?? ""),
		].join(" ");
		expect(chromeStyles).toContain("var(--");
		expect(chromeStyles).toMatch(/var\(--(?:background|card)/);
		expect(chromeStyles).toMatch(/var\(--(?:foreground|primary|border)/);
		expect(chromeStyles).not.toContain("#0c0c1a");
		expect(chromeStyles).not.toContain("rgba(10, 10, 20, 0.2)");
		expect(chromeStyles).not.toContain("rgba(255,255,255,0.15)");
		expect(chromeStyles).not.toContain("rgba(255,255,255,0.6)");

		render(renderer.render({ path: "theme-card.html", content: AUTHORED_HTML }, okResult, false).content, streaming.container);
		staleIframe.dispatchEvent(new Event("load"));
		expect(staleWrite).not.toHaveBeenCalled();
		expectPreparedInlineFrame(streaming.container.querySelector("iframe")!);
	});
});

describe("HTML renderer delegation", () => {
	it.each(["card.html", "CARD.HTM"])("WriteRenderer routes %s through the themed inline renderer", path => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		render(new WriteRenderer().render({ path, content: AUTHORED_HTML }, okResult, false).content, container);
		const iframe = container.querySelector("iframe");
		expect(iframe, `${path} should use HtmlRenderer`).toBeTruthy();
		expectPreparedInlineFrame(iframe!);
		expect(originalSource(container)).toBe(AUTHORED_HTML);
	});

	it("EditRenderer fetches completed HTML and delegates the cached bytes through the same preparation", async () => {
		window.location.hash = "#/session/11111111-1111-4111-8111-111111111111";
		localStorage.setItem("gateway.url", "https://gateway.test");
		localStorage.setItem("gateway.token", "test-token");
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ content: AUTHORED_HTML }),
		});
		vi.stubGlobal("fetch", fetchMock);
		const renderer = new EditRenderer();
		const params = { path: "edited-theme.html", oldText: "old", newText: "new" };
		const result = { ...okResult, toolCallId: "edit-call-theme" } as any;
		const ready = new Promise<void>(resolve => {
			document.addEventListener("bobbit-tool-preview-ready", () => resolve(), { once: true });
		});

		renderer.render(params, result, false);
		await ready;
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toContain("/api/sessions/11111111-1111-4111-8111-111111111111/file-content");
		expect(fetchMock.mock.calls[0][0]).toContain("snapshotId=edit-call-theme");
		expect(fetchMock.mock.calls[0][1]).toEqual({ headers: { Authorization: "Bearer test-token" } });

		const container = document.createElement("div");
		document.body.appendChild(container);
		render(renderer.render(params, result, false).content, container);
		const iframe = container.querySelector("iframe");
		expect(iframe).toBeTruthy();
		expectPreparedInlineFrame(iframe!);
		expect(originalSource(container)).toBe(AUTHORED_HTML);
	});
});
