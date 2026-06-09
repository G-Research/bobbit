/**
 * Unit (node:test) — the artifacts PACK viewer module's per-type rendering is at
 * behavioral parity with the built-in artifact components (Extension Host Phase 2,
 * Slice D1). The pack viewer is the migration target for Acceptance #1
 * ("behavioral parity"); this pins the per-type DISPATCH + rendering the built-in's
 * getFileType()/HtmlArtifact/MarkdownArtifact/SvgArtifact/ImageArtifact/TextArtifact
 * assert, exercised directly against the dependency-free pack module.
 *
 * The viewer module is plain ESM (the host lit toolkit is injected only into the
 * default factory), so we import its named helpers directly. `buildArtifactBody`
 * is the only DOM-touching helper; we drive it with a minimal fake `document`
 * that records tag/attributes/innerHTML/children — enough to assert the structural
 * contract (sandboxed iframe, inlined svg, rendered markdown, <img> data URL, …)
 * without a browser. ESM imports across `file://` are CORS-blocked in Chromium, so
 * a browser fixture cannot import the pack module; node:test is the right phase.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	detectArtifactType,
	buildArtifactBody,
	renderMarkdownToHtml,
	mimeForFilename,
	downloadHref,
} from "../market-packs/artifacts/tools/artifact_demo/ArtifactViewerPanel.js";

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
	it("html preview → sandboxed iframe whose srcdoc IS the content (sandbox preserved)", () => {
		const content = "<h1>Hello Artifact</h1>";
		const el = buildArtifactBody("html", "hello.html", content, makeFakeDoc(), "preview") as any;
		assert.equal(el.tagName, "IFRAME");
		assert.equal(el.getAttribute("sandbox"), "allow-scripts");
		assert.equal(el.srcdoc, content);
		assert.equal(el.getAttribute("data-testid"), "artifact-viewer-iframe");
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

	it("svg preview → inlined <svg> markup", () => {
		const content = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
		const el = buildArtifactBody("svg", "shape.svg", content, makeFakeDoc(), "preview") as any;
		assert.equal(el.tagName, "DIV");
		assert.match(el.innerHTML, /<svg/);
		assert.match(el.innerHTML, /<circle/);
	});

	it("image → <img> with a base64 data URL", () => {
		const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		const el = buildArtifactBody("image", "pixel.png", b64, makeFakeDoc(), "preview") as any;
		const img = el.find("IMG");
		assert.ok(img, "expected an <img> child");
		assert.equal(img.src, `data:image/png;base64,${b64}`);
		assert.equal(img.getAttribute("data-testid"), "artifact-viewer-image");
	});

	it("text → faithful monospace <pre> shown verbatim (no privileged hljs highlighting)", () => {
		const content = "const x = 1;\nconsole.log(x);";
		const el = buildArtifactBody("text", "code.ts", content, makeFakeDoc(), "preview") as any;
		assert.equal(el.tagName, "PRE");
		assert.equal(el.textContent, content);
	});

	it("pdf → native browser embed via a data URL (documented gap: no pdfjs)", () => {
		const el = buildArtifactBody("pdf", "doc.pdf", "QQ==", makeFakeDoc(), "preview") as any;
		const frame = el.find("IFRAME");
		assert.ok(frame, "expected an <iframe> embed");
		assert.equal(frame.src, "data:application/pdf;base64,QQ==");
	});

	it("docx/generic → download-affordance fallback (documented gap)", () => {
		const docx = buildArtifactBody("docx", "doc.docx", "QQ==", makeFakeDoc(), "preview") as any;
		assert.equal(docx.getAttribute("data-testid"), "artifact-viewer-docx");
		const generic = buildArtifactBody("generic", "blob.bin", "QQ==", makeFakeDoc(), "preview") as any;
		assert.equal(generic.getAttribute("data-testid"), "artifact-viewer-generic");
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
