// Pure, dependency-light helpers for the artifacts PACK viewer (Extension Host
// Phase 2, Slice D1 — D1 parity hardening). This module is the SINGLE SOURCE OF
// TRUTH for type detection, MIME mapping, download hrefs, markdown rendering, and
// the per-type DOM body construction (`buildArtifactBody`). It is bundled into the
// served `ArtifactViewerPanel.js` by `scripts/build-market-packs.mjs`.
//
// IMPORTANT — node-safe: this module imports ONLY `highlight.js/lib/core`
// (pure JS, no DOM at import time) so `tests/artifacts-pack-viewer.test.ts` can
// import it directly under tsx/node:test and assert REAL hljs highlighting. The
// DOM-heavy npm libs (pdfjs-dist, docx-preview) live in `binary-render.ts` and
// are invoked by the panel AFTER `buildArtifactBody` returns a render-root — they
// are never imported here, so this module stays importable outside a browser.
//
// `buildArtifactBody` mutates a `document`-like object (real `document` in the
// browser; a fake recorder in unit tests) and returns a live node — exactly how
// the built-in artifact components inline content.

import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import ruby from "highlight.js/lib/languages/ruby";
import php from "highlight.js/lib/languages/php";
import shell from "highlight.js/lib/languages/shell";
import ini from "highlight.js/lib/languages/ini";
import dockerfile from "highlight.js/lib/languages/dockerfile";

// Eagerly register the ~95% set the built-in `highlight-core.ts` covers. A
// bundled pack ESM cannot lazy-import grammar chunks (a Blob-URL module has no
// resolvable base for `import("./chunk.js")`), so the parity set is registered
// up front; anything outside it falls back to HTML-escaped plain text (still
// faithful, just unhighlighted) — never a crash.
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("java", java);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("php", php);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerAliases(["html"], { languageName: "xml" });

export type ArtifactType = "html" | "svg" | "markdown" | "pdf" | "docx" | "image" | "text" | "generic";

// ── Type detection — byte-for-byte the built-in's getFileType() (artifacts.ts) ──
export function detectArtifactType(filename: string): ArtifactType {
	const ext = String(filename || "").split(".").pop()?.toLowerCase();
	if (ext === "html") return "html";
	if (ext === "svg") return "svg";
	if (ext === "md" || ext === "markdown") return "markdown";
	if (ext === "pdf") return "pdf";
	if (ext === "docx") return "docx";
	if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"].includes(ext || "")) return "image";
	if ([
		"txt", "json", "xml", "yaml", "yml", "csv", "js", "ts", "jsx", "tsx",
		"py", "java", "c", "cpp", "h", "css", "scss", "sass", "less", "sh",
	].includes(ext || "")) return "text";
	return "generic";
}

/** MIME type for download affordances (mirrors the per-type components). */
export function mimeForFilename(filename: string): string {
	const ext = String(filename || "").split(".").pop()?.toLowerCase() || "";
	const map: Record<string, string> = {
		html: "text/html", svg: "image/svg+xml", md: "text/markdown", markdown: "text/markdown",
		txt: "text/plain", json: "application/json", xml: "application/xml", csv: "text/csv",
		png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
		webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
		pdf: "application/pdf",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	};
	return map[ext] || "text/plain";
}

const BASE64_TYPES = new Set<ArtifactType>(["image", "pdf", "docx", "generic"]);

/** A download href the browser can save without any privileged component
 *  (parity for the built-in DownloadButton): a data URL — base64 payload for
 *  binary types, percent-encoded text otherwise. */
export function downloadHref(type: ArtifactType, filename: string, content: string): string {
	const mime = mimeForFilename(filename);
	const c = String(content || "");
	if (BASE64_TYPES.has(type)) {
		if (c.startsWith("data:")) return c;
		return `data:${mime};base64,${c}`;
	}
	return `data:${mime};charset=utf-8,${encodeURIComponent(c)}`;
}

function imageUrl(filename: string, content: string): string {
	const c = String(content || "");
	if (c.startsWith("data:")) return c;
	return `data:${mimeForFilename(filename)};base64,${c}`;
}

// ── hljs syntax highlighting — REAL parity with the built-in TextArtifact (was a
// DOCUMENTED GAP). Code file extensions are highlighted with the bundled
// highlight.js; everything else is shown verbatim. ──
const CODE_EXTENSIONS = new Set([
	"js", "javascript", "ts", "typescript", "jsx", "tsx", "py", "python", "java",
	"c", "cpp", "h", "cs", "php", "rb", "ruby", "go", "rust", "rs", "swift",
	"kotlin", "scala", "dart", "html", "css", "scss", "sass", "less", "json",
	"xml", "yaml", "yml", "toml", "sql", "sh", "bash", "ps1", "bat", "r",
	"lua", "perl", "ini", "dockerfile",
]);

const LANGUAGE_MAP: Record<string, string> = {
	js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
	py: "python", rb: "ruby", rs: "rust", yml: "yaml", sh: "bash",
	h: "cpp", cs: "csharp",
};

export function isCodeFile(filename: string): boolean {
	const ext = String(filename || "").split(".").pop()?.toLowerCase() || "";
	return CODE_EXTENSIONS.has(ext);
}

export function languageForFilename(filename: string): string {
	const ext = String(filename || "").split(".").pop()?.toLowerCase() || "";
	return LANGUAGE_MAP[ext] || ext;
}

/** Escape HTML for the unhighlighted plain-text fallback. */
export function escapeHtml(s: string): string {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Synchronously highlight `content` for `lang` if the grammar is registered,
 *  else return HTML-escaped plain text. Mirrors TextArtifact.highlightOrEscape
 *  but with no lazy grammar fetch (the bundled eager set is all there is). */
export function highlightCode(content: string, lang: string): string {
	if (lang && hljs.getLanguage(lang)) {
		return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
	}
	return escapeHtml(content);
}

// ── Minimal, dependency-free Markdown → HTML (parity stand-in for the built-in's
// markdown-block). HTML is escaped first so artifact content can never inject
// markup. (Markdown rendering was NOT a flagged gap; kept as the existing
// faithful renderer.) ──
function renderInline(s: string): string {
	let out = escapeHtml(s);
	out = out.replace(/`([^`]+)`/g, (_m, code) => `<code class="px-1 rounded bg-muted text-foreground">${code}</code>`);
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
		const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : "#";
		return `<a class="text-primary underline" href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
	});
	return out;
}

export function renderMarkdownToHtml(src: string): string {
	const lines = String(src || "").split(/\r?\n/);
	const out: string[] = [];
	let i = 0;
	let listType: "ul" | "ol" | null = null;
	const closeList = () => {
		if (listType) {
			out.push(`</${listType}>`);
			listType = null;
		}
	};
	while (i < lines.length) {
		const line = lines[i];
		const fence = line.match(/^```(.*)$/);
		if (fence) {
			closeList();
			const body: string[] = [];
			i++;
			while (i < lines.length && !/^```/.test(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			i++;
			out.push(`<pre class="m-0 p-3 text-xs rounded bg-muted overflow-auto"><code>${escapeHtml(body.join("\n"))}</code></pre>`);
			continue;
		}
		const h = line.match(/^(#{1,6})\s+(.*)$/);
		if (h) {
			closeList();
			const level = h[1].length;
			out.push(`<h${level} class="font-semibold text-foreground mt-3 mb-1">${renderInline(h[2])}</h${level}>`);
			i++;
			continue;
		}
		if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			closeList();
			out.push(`<hr class="my-3 border-border" />`);
			i++;
			continue;
		}
		const bq = line.match(/^>\s?(.*)$/);
		if (bq) {
			closeList();
			out.push(`<blockquote class="border-l-2 border-border pl-3 text-muted-foreground">${renderInline(bq[1])}</blockquote>`);
			i++;
			continue;
		}
		const ul = line.match(/^\s*[-*+]\s+(.*)$/);
		if (ul) {
			if (listType !== "ul") {
				closeList();
				out.push(`<ul class="list-disc pl-6 space-y-0.5">`);
				listType = "ul";
			}
			out.push(`<li>${renderInline(ul[1])}</li>`);
			i++;
			continue;
		}
		const ol = line.match(/^\s*\d+\.\s+(.*)$/);
		if (ol) {
			if (listType !== "ol") {
				closeList();
				out.push(`<ol class="list-decimal pl-6 space-y-0.5">`);
				listType = "ol";
			}
			out.push(`<li>${renderInline(ol[1])}</li>`);
			i++;
			continue;
		}
		if (/^\s*$/.test(line)) {
			closeList();
			i++;
			continue;
		}
		closeList();
		out.push(`<p class="my-1">${renderInline(line)}</p>`);
		i++;
	}
	closeList();
	return out.join("\n");
}

/** Console-capture marker posted by the shim injected into HTML artifact iframes
 *  (so the panel can distinguish artifact console messages from other postMessage
 *  traffic). Exported so the panel + tests reference one constant. */
export const CONSOLE_MESSAGE_MARKER = "__bobbitArtifactConsole";

/** A `<script>` injected at the TOP of an HTML artifact's srcdoc that mirrors the
 *  built-in's console capture (was a DOCUMENTED GAP): it tees `console.*` and
 *  uncaught errors to `parent.postMessage` tagged with this artifact's id. The
 *  iframe stays `sandbox="allow-scripts"` (NO same-origin) — postMessage works
 *  cross-origin, so capture needs no privileged host bridge. `id` is embedded so
 *  the panel routes logs to the right artifact when several viewers exist. */
export function consoleCaptureScript(artifactId: string): string {
	const id = JSON.stringify(String(artifactId || ""));
	const marker = JSON.stringify(CONSOLE_MESSAGE_MARKER);
	return `<script>(function(){try{` +
		`var post=function(method,args){try{var parts=[];for(var i=0;i<args.length;i++){var a=args[i];try{parts.push(typeof a==="object"?JSON.stringify(a):String(a));}catch(e){parts.push(String(a));}}` +
		`var m={};m[${marker}]=true;m.id=${id};m.method=method;m.text=parts.join(" ");parent.postMessage(m,"*");}catch(e){}};` +
		`["log","error","warn","info"].forEach(function(method){var orig=console[method];console[method]=function(){post(method,arguments);if(orig)try{orig.apply(console,arguments);}catch(e){}};});` +
		`window.addEventListener("error",function(e){post("error",[e&&e.message?e.message:"Error"]);});` +
		`window.addEventListener("unhandledrejection",function(e){post("error",[(e&&e.reason&&e.reason.message)||String(e&&e.reason)]);});` +
		`}catch(e){}})();</script>`;
}

/** Wrap untrusted SVG markup in a minimal HTML document for a no-script
 *  sandboxed iframe so it fills the frame. The SVG is the iframe's document body
 *  (unique opaque origin, scripts disabled) — it is NEVER inlined into the main
 *  DOM. Sizing is inline CSS (Tailwind classes don't reach inside the frame);
 *  background is transparent so the panel's theme shows through (theme tokens
 *  only — no hardcoded colours). */
function svgSrcdoc(svg: string): string {
	return (
		`<!doctype html><meta charset="utf-8">` +
		`<style>html,body{margin:0;height:100%;}` +
		`body{display:flex;align-items:center;justify-content:center;background:transparent;}` +
		`svg{max-width:100%;max-height:100%;width:100%;height:100%;}</style>` +
		String(svg || "")
	);
}

interface DocLike {
	createElement(tag: string): any;
}

/**
 * Build the body element for an artifact type. Returns a live DOM node. For
 * `pdf`/`docx` it returns a container with a `data-*-render-root` child the panel
 * fills asynchronously via `binary-render.ts` (the heavy npm libs are not imported
 * here so this stays node-safe). `viewMode` toggles preview/code for the togglable
 * types (html/svg/markdown).
 */
export function buildArtifactBody(
	type: ArtifactType,
	filename: string,
	content: string,
	doc?: DocLike | null,
	viewMode?: "preview" | "code",
	artifactId?: string,
): any {
	doc = doc || (typeof document !== "undefined" ? (document as unknown as DocLike) : null);
	const c = String(content || "");
	const mk = (tag: string) => (doc as DocLike).createElement(tag);

	if (type === "html") {
		if (viewMode === "code") {
			const pre = mk("pre");
			pre.className = "m-0 p-4 text-xs whitespace-pre-wrap break-words text-foreground";
			pre.setAttribute("data-testid", "artifact-viewer-source");
			pre.textContent = c;
			return pre;
		}
		// PRESERVE the iframe sandbox exactly as HtmlArtifact/SandboxedIframe:
		// scripts may run, but the frame is otherwise fully isolated (no
		// same-origin, no top navigation, no forms, no popups). The console-capture
		// shim is PREPENDED to the srcdoc (content-origin trust boundary unchanged).
		const iframe = mk("iframe");
		iframe.setAttribute("sandbox", "allow-scripts");
		iframe.setAttribute("data-testid", "artifact-viewer-iframe");
		iframe.className = "w-full h-full border-0 bg-background";
		iframe.style.minHeight = "240px";
		iframe.srcdoc = consoleCaptureScript(artifactId || "") + c;
		return iframe;
	}

	if (type === "svg") {
		if (viewMode === "code") {
			const pre = mk("pre");
			pre.className = "m-0 p-4 text-xs whitespace-pre-wrap break-words text-foreground";
			pre.setAttribute("data-testid", "artifact-viewer-source");
			pre.textContent = c;
			return pre;
		}
		// SECURITY (was a HIGH finding): SVG is untrusted, LLM/user-controlled
		// content. A crafted SVG can carry `<script>`, `on*` event-handler
		// attributes, or `<foreignObject>` HTML that, if inlined into the MAIN DOM
		// via innerHTML, executes in Bobbit's main UI origin — exposing session
		// state + the Host APIs in that realm. So SVG renders in a sandboxed iframe
		// — the SAME content-origin trust boundary HTML artifacts use (HtmlArtifact /
		// SandboxedIframe) — but with NO `allow-scripts` (display needs no script),
		// which is strictly STRONGER than the HTML case: scripts, inline event
		// handlers, and foreignObject JS can never run, and the frame's unique opaque
		// origin keeps it unable to reach the parent realm or the Host API. Untrusted
		// markup never touches the main DOM.
		const iframe = mk("iframe");
		iframe.setAttribute("sandbox", "");
		iframe.setAttribute("data-testid", "artifact-viewer-svg");
		iframe.className = "w-full h-full border-0 bg-background";
		iframe.style.minHeight = "240px";
		iframe.srcdoc = svgSrcdoc(c);
		return iframe;
	}

	if (type === "markdown") {
		if (viewMode === "code") {
			const pre = mk("pre");
			pre.className = "m-0 p-4 text-xs whitespace-pre-wrap break-words text-foreground";
			pre.setAttribute("data-testid", "artifact-viewer-source");
			pre.textContent = c;
			return pre;
		}
		const wrap = mk("div");
		wrap.className = "p-4 text-sm text-foreground space-y-1";
		wrap.setAttribute("data-testid", "artifact-viewer-markdown");
		wrap.innerHTML = renderMarkdownToHtml(c);
		return wrap;
	}

	if (type === "image") {
		const wrap = mk("div");
		wrap.className = "h-full flex items-center justify-center p-4 bg-background overflow-auto";
		const img = mk("img");
		img.src = imageUrl(filename, c);
		img.alt = String(filename || "");
		img.className = "max-w-full max-h-full object-contain";
		img.setAttribute("data-testid", "artifact-viewer-image");
		wrap.appendChild(img);
		return wrap;
	}

	if (type === "pdf") {
		// REAL parity (was a DOCUMENTED GAP): a render-root the panel fills with
		// pdfjs-rendered canvases via binary-render.renderPdfInto(). No native-embed
		// fallback — the pages are rasterised exactly like the built-in PdfArtifact.
		const wrap = mk("div");
		wrap.className = "h-full flex flex-col bg-background overflow-auto";
		wrap.setAttribute("data-testid", "artifact-viewer-pdf");
		const root = mk("div");
		root.className = "flex-1 overflow-auto";
		root.setAttribute("data-pdf-render-root", "");
		wrap.appendChild(root);
		return wrap;
	}

	if (type === "docx") {
		// REAL parity (was a DOCUMENTED GAP): a render-root the panel fills with the
		// docx-preview-rendered document via binary-render.renderDocxInto().
		const wrap = mk("div");
		wrap.className = "h-full flex flex-col bg-background overflow-auto";
		wrap.setAttribute("data-testid", "artifact-viewer-docx");
		const root = mk("div");
		root.className = "flex-1 overflow-auto p-4";
		root.setAttribute("data-docx-render-root", "");
		wrap.appendChild(root);
		return wrap;
	}

	if (type === "generic") {
		const wrap = mk("div");
		wrap.className = "h-full flex items-center justify-center bg-background p-8";
		wrap.setAttribute("data-testid", "artifact-viewer-generic");
		const inner = mk("div");
		inner.className = "text-center max-w-md text-muted-foreground";
		const name = mk("div");
		name.className = "font-medium text-foreground mb-2";
		name.textContent = String(filename || "");
		const note = mk("p");
		note.className = "text-sm";
		note.textContent = "Preview not available for this file type. Use the download button above to view it on your computer.";
		inner.appendChild(name);
		inner.appendChild(note);
		wrap.appendChild(inner);
		return wrap;
	}

	// text / code: REAL hljs highlighting for code files (was a DOCUMENTED GAP),
	// faithful monospace for plain text.
	const pre = mk("pre");
	pre.setAttribute("data-testid", "artifact-viewer-source");
	if (isCodeFile(filename)) {
		const lang = languageForFilename(filename);
		pre.className = "m-0 p-4 text-xs";
		const code = mk("code");
		code.className = `hljs language-${lang}`;
		code.innerHTML = highlightCode(c, lang);
		pre.appendChild(code);
	} else {
		pre.className = "m-0 p-4 text-xs whitespace-pre-wrap break-words font-mono text-foreground";
		pre.textContent = c;
	}
	return pre;
}
