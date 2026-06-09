/**
 * Unit (node:test) — the artifacts PACK viewer's per-type rendering is at
 * behavioral parity with the built-in artifact components (Extension Host Phase 2,
 * Slice D1 + the D1 parity-hardening that VENDORED highlight.js / pdfjs-dist /
 * docx-preview into the pack via the `build:packs` bundling convention). This pins
 * the per-type DISPATCH + rendering the built-in's getFileType()/HtmlArtifact/
 * MarkdownArtifact/SvgArtifact/ImageArtifact/TextArtifact assert, exercised against
 * the pack's node-safe `helpers.ts` SOURCE module.
 *
 * WHY import the SOURCE helpers (not the served bundle): the served
 * `ArtifactViewerPanel.js` bundle now inlines pdfjs-dist + docx-preview, which
 * reference DOM globals (DOMMatrix, …) at module-eval and CANNOT be imported under
 * node. `helpers.ts` deliberately imports only `highlight.js/lib/core` (pure JS),
 * so it is node-safe and is the single source of truth for the pure logic + the
 * `buildArtifactBody` dispatch the bundle re-exports. Real pdfjs/docx page
 * rendering is asserted in the browser E2E (tests/e2e/ui/artifacts-pack.spec.ts);
 * REAL hljs highlighting (pure JS) is asserted HERE.
 *
 * `buildArtifactBody` is the only DOM-touching helper; we drive it with a minimal
 * fake `document` that records tag/attributes/innerHTML/children — enough to assert
 * the structural contract (sandboxed iframe, inlined svg, rendered markdown, <img>
 * data URL, hljs-highlighted code, pdf/docx render-roots) without a browser.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	detectArtifactType,
	buildArtifactBody,
	renderMarkdownToHtml,
	mimeForFilename,
	downloadHref,
	highlightCode,
	consoleCaptureScript,
	CONSOLE_MESSAGE_MARKER,
} from "../market-packs/artifacts/src/helpers.ts";

/** A minimal fake element/document recording the structural mutations
 *  `buildArtifactBody` performs. Property assignments (`.src`, `.srcdoc`) land as
 *  own props (as on a real element); attribute/innerHTML/children are captured. */
function makeFakeDoc() {
	const make = (tag: string) => {
		const el: any = {
			tagName: tag.toUpperCase(),
			children: [] as any[],
			attrs: {} as Record<string, string>,
			style: {},
			className: "",
			_text: "",
			_html: "",
			set textContent(v: string) { this._text = String(v); },
			get textContent() { return this._text; },
			set innerHTML(v: string) { this._html = String(v); },
			get innerHTML() { return this._html; },
			setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); },
			getAttribute(k: string) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
			appendChild(c: any) { this.children.push(c); return c; },
			/** find the first descendant whose tagName matches (depth-first). */
			find(tagName: string): any {
				for (const c of this.children) {
					if (c.tagName === tagName.toUpperCase()) return c;
					const deeper = c.find?.(tagName);
					if (deeper) return deeper;
				}
				return null;
			},
			/** find the first descendant carrying attribute `name` (depth-first). */
			findByAttr(name: string): any {
				for (const c of this.children) {
					if (c.getAttribute?.(name) !== null && c.getAttribute?.(name) !== undefined) return c;
					const deeper = c.findByAttr?.(name);
					if (deeper) return deeper;
				}
				return null;
			},
		};
		return el;
	};
	return { createElement: (t: string) => make(t) };
}

describe("artifacts pack viewer — type detection (parity with getFileType)", () => {
	const cases: Array<[string, string]> = [
		["hello.html", "html"],
		["notes.md", "markdown"],
		["a.markdown", "markdown"],
		["shape.svg", "svg"],
		["pixel.png", "image"],
		["p.jpeg", "image"],
		["doc.pdf", "pdf"],
		["doc.docx", "docx"],
		["code.ts", "text"],
		["data.json", "text"],
		["blob.bin", "generic"],
	];
	for (const [filename, type] of cases) {
		it(`${filename} → ${type}`, () => {
			assert.equal(detectArtifactType(filename), type);
		});
	}
});

describe("artifacts pack viewer — per-type rendering (buildArtifactBody)", () => {
	it("html preview → sandboxed iframe whose srcdoc ENDS WITH the content + a console-capture shim (sandbox preserved)", () => {
		const content = "<h1>Hello Artifact</h1>";
		const el = buildArtifactBody("html", "hello.html", content, makeFakeDoc(), "preview", "art-x") as any;
		assert.equal(el.tagName, "IFRAME");
		assert.equal(el.getAttribute("sandbox"), "allow-scripts");
		assert.equal(el.getAttribute("data-testid"), "artifact-viewer-iframe");
		// The console-capture shim is PREPENDED; the content is preserved verbatim
		// at the end (trust boundary is content-origin, not the injected capture).
		assert.ok(el.srcdoc.endsWith(content), "srcdoc must end with the verbatim content");
		assert.ok(el.srcdoc.includes("parent.postMessage"), "srcdoc must carry the console-capture shim");
		assert.ok(el.srcdoc.includes("art-x"), "the shim must embed the artifact id");
	});

	it("html code view → raw <pre> source", () => {
		const content = "<h1>Hello Artifact</h1>";
		const el = buildArtifactBody("html", "hello.html", content, makeFakeDoc(), "code") as any;
		assert.equal(el.tagName, "PRE");
		assert.equal(el.textContent, content);
		assert.equal(el.getAttribute("data-testid"), "artifact-viewer-source");
	});

	it("markdown preview → rendered HTML (not raw source)", () => {
		const content = "# Hello Markdown\n\nSome **bold** and `code` text.";
		const el = buildArtifactBody("markdown", "notes.md", content, makeFakeDoc(), "preview") as any;
		assert.equal(el.tagName, "DIV");
		assert.match(el.innerHTML, /<h1[^>]*>Hello Markdown<\/h1>/);
		assert.match(el.innerHTML, /<strong>bold<\/strong>/);
		assert.match(el.innerHTML, /<code[^>]*>code<\/code>/);
	});

	it("svg preview → SANDBOXED, no-script iframe (not raw main-DOM innerHTML) — content-origin trust boundary", () => {
		const content = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
		const el = buildArtifactBody("svg", "shape.svg", content, makeFakeDoc(), "preview") as any;
		// SECURITY: untrusted SVG renders in a sandboxed iframe, NOT inlined into the
		// main DOM. The element is an <iframe> (not a <div> with innerHTML) and the
		// svg lives in its srcdoc.
		assert.equal(el.tagName, "IFRAME");
		assert.equal(el.getAttribute("data-testid"), "artifact-viewer-svg");
		// `sandbox=""` (empty) — NO allow-scripts: stricter than the html case. The
		// frame is a unique opaque origin and cannot run scripts at all.
		assert.equal(el.getAttribute("sandbox"), "");
		assert.ok(!/allow-scripts/.test(el.getAttribute("sandbox") || ""), "svg iframe must NOT permit scripts");
		// The svg markup is the iframe srcdoc — never assigned to a main-DOM innerHTML.
		assert.match(el.srcdoc, /<svg/);
		assert.match(el.srcdoc, /<circle/);
		assert.equal(el._html, "", "no innerHTML must be set on the svg host element");
	});

	it("HOSTILE svg (<script>/onload/foreignObject) cannot execute in the parent realm — confined to a no-script sandboxed iframe", () => {
		const hostile =
			'<svg xmlns="http://www.w3.org/2000/svg" onload="window.__pwned=1">' +
			'<script>window.__pwned=1</script>' +
			'<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror="window.__pwned=1"></body></foreignObject>' +
			"</svg>";
		const el = buildArtifactBody("svg", "evil.svg", hostile, makeFakeDoc(), "preview") as any;
		// The hostile markup is NOT inserted into the main DOM via innerHTML — it is
		// confined to the srcdoc of a sandboxed, no-script iframe, so neither the
		// inline onload, the <script>, nor the foreignObject onerror can run in
		// Bobbit's main UI origin (they'd need allow-scripts AND main-realm access).
		assert.equal(el.tagName, "IFRAME");
		assert.equal(el.getAttribute("sandbox"), "");
		assert.equal(el._html, "", "hostile svg must never reach a main-DOM innerHTML sink");
		assert.ok(el.srcdoc.includes("onload"), "the verbatim (inert) markup is preserved inside the sandbox");
	});

	it("image → <img> with a base64 data URL", () => {
		const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		const el = buildArtifactBody("image", "pixel.png", b64, makeFakeDoc(), "preview") as any;
		const img = el.find("IMG");
		assert.ok(img, "expected an <img> child");
		assert.equal(img.src, `data:image/png;base64,${b64}`);
		assert.equal(img.getAttribute("data-testid"), "artifact-viewer-image");
	});

	it("code/text → REAL hljs syntax highlighting (was a documented gap)", () => {
		const content = "const x = 1;\nconsole.log(x);";
		const el = buildArtifactBody("text", "code.ts", content, makeFakeDoc(), "preview") as any;
		assert.equal(el.tagName, "PRE");
		assert.equal(el.getAttribute("data-testid"), "artifact-viewer-source");
		const code = el.find("CODE");
		assert.ok(code, "code files must render a <code> child");
		assert.match(code.className, /hljs language-typescript/);
		// hljs wraps tokens in <span class="hljs-..."> — proves REAL highlighting,
		// not the previous escaped-plain-text fallback.
		assert.match(code.innerHTML, /<span class="hljs-/);
	});

	it("plain text (non-code) → faithful monospace <pre> shown verbatim", () => {
		const content = "just some words\nnot code";
		const el = buildArtifactBody("text", "notes.csv", content, makeFakeDoc(), "preview") as any;
		// .csv is a text type but NOT in CODE_EXTENSIONS → verbatim, no <code> child.
		assert.equal(el.tagName, "PRE");
		assert.equal(el.textContent, content);
		assert.equal(el.find("CODE"), null);
	});

	it("pdf → a pdfjs render-root (REAL rendering wired; NOT a native-embed fallback)", () => {
		const el = buildArtifactBody("pdf", "doc.pdf", "QQ==", makeFakeDoc(), "preview") as any;
		assert.equal(el.getAttribute("data-testid"), "artifact-viewer-pdf");
		const root = el.findByAttr("data-pdf-render-root");
		assert.ok(root, "pdf must expose a [data-pdf-render-root] the panel fills with pdfjs canvases");
		// No native <iframe> embed fallback any more.
		assert.equal(el.find("IFRAME"), null);
	});

	it("docx → a docx-preview render-root (REAL rendering wired; NOT a download fallback)", () => {
		const el = buildArtifactBody("docx", "doc.docx", "QQ==", makeFakeDoc(), "preview") as any;
		assert.equal(el.getAttribute("data-testid"), "artifact-viewer-docx");
		const root = el.findByAttr("data-docx-render-root");
		assert.ok(root, "docx must expose a [data-docx-render-root] the panel fills via docx-preview");
	});

	it("generic → download-affordance fallback (genuinely unpreviewable)", () => {
		const generic = buildArtifactBody("generic", "blob.bin", "QQ==", makeFakeDoc(), "preview") as any;
		assert.equal(generic.getAttribute("data-testid"), "artifact-viewer-generic");
	});
});

describe("artifacts pack viewer — hljs highlightCode helper", () => {
	it("highlights a registered grammar with hljs token spans", () => {
		const out = highlightCode("def f():\n    return 1", "python");
		assert.match(out, /<span class="hljs-/);
	});
	it("falls back to escaped plain text for an unregistered grammar", () => {
		const out = highlightCode("<x> & 'y'", "no-such-lang");
		assert.match(out, /&lt;x&gt;/);
		assert.doesNotMatch(out, /<span class="hljs-/);
	});
});

describe("artifacts pack viewer — html console capture shim", () => {
	it("tees console.* + errors to parent.postMessage tagged with the marker + id", () => {
		const shim = consoleCaptureScript("art-42");
		assert.match(shim, /^<script>/);
		assert.ok(shim.includes(CONSOLE_MESSAGE_MARKER));
		assert.ok(shim.includes("art-42"));
		assert.ok(shim.includes("parent.postMessage"));
		assert.ok(shim.includes('"error"') || shim.includes("error"));
	});
});

describe("artifacts pack viewer — markdown renderer escapes raw HTML", () => {
	it("escapes angle brackets so content cannot inject markup", () => {
		assert.match(renderMarkdownToHtml("<b>x</b>"), /&lt;b&gt;/);
	});
	it("renders bold/inline-code/headings", () => {
		const html = renderMarkdownToHtml("# H\n\n**b** `c`");
		assert.match(html, /<h1[^>]*>H<\/h1>/);
		assert.match(html, /<strong>b<\/strong>/);
		assert.match(html, /<code[^>]*>c<\/code>/);
	});
});

describe("artifacts pack viewer — download href (parity with DownloadButton)", () => {
	it("text payloads → percent-encoded data URL", () => {
		assert.ok(downloadHref("text", "a.txt", "a b").startsWith("data:text/plain;charset=utf-8,"));
	});
	it("binary payloads → base64 data URL", () => {
		assert.equal(downloadHref("image", "p.png", "QQ=="), "data:image/png;base64,QQ==");
	});
	it("mimeForFilename maps known extensions", () => {
		assert.equal(mimeForFilename("a.html"), "text/html");
		assert.equal(mimeForFilename("a.svg"), "image/svg+xml");
		assert.equal(mimeForFilename("a.png"), "image/png");
		assert.equal(mimeForFilename("a.pdf"), "application/pdf");
	});
});
