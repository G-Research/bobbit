// Pre-built ESM side-panel module for the `artifact_demo` litmus tool's
// `artifacts.viewer` panel (Extension Host Phase 2, Slice D1; design
// docs/design/extension-host-phase2.md §10).
//
// REAL behavioral-parity migration of the artifacts built-in's viewer
// (src/ui/tools/artifacts/ArtifactElement.ts + the per-type artifact
// components) as a pack panel. The gateway serves it from
// GET /api/tools/artifact_demo/panel/artifacts.viewer and the client lazily
// imports it via a Blob URL, then calls this default-exported FACTORY with the
// host toolkit (`{ html, nothing, renderHeader }`).
//
// REHYDRATE-BY-ID parity (replaces restorePreviewArtifact): the panel receives
// ONLY `{ artifactId }` in its typed params (the deep-link carries only the id,
// never the payload) and rehydrates its content from the PACK-SCOPED store via
// `host.store.get(artifactId)` — so a fresh open / deep-link reconstructs the
// viewer identically. `render(params, host)` is a PURE projection: the async
// store fetch is kicked off ONCE (cached by id) and `host.requestRender()`
// repaints when it resolves — no auto-invoke of any other capability on mount
// (design §6, v1 §5 v).
//
// Per-type parity: the viewer dispatches by artifact TYPE (extension) to the
// real per-type rendering ported from the built-in components — text, markdown,
// html (PRESERVING the iframe `sandbox` exactly as HtmlArtifact: srcdoc inside a
// `sandbox="allow-scripts"` iframe), svg, image, pdf, docx, generic. Theme
// tokens only; no hardcoded colours.
//
// DOCUMENTED GAPS (privileged host surfaces a pack ESM cannot re-express; see
// the task summary): HTML console capture + read-only attachments/artifacts
// runtime providers (RuntimeMessageRouter, a privileged host bridge); hljs
// syntax highlighting of text/code (the host highlight bundle); pdfjs PDF page
// rendering and docx-preview DOCX rendering (npm libs the host bundles, not
// available to a dependency-free pack module). For those last three the viewer
// renders a faithful fallback (raw source / native browser embed / a download
// affordance) rather than faking the privileged rendering.

// ── Type detection — byte-for-byte the built-in's getFileType() (artifacts.ts) ──
export function detectArtifactType(filename) {
	const ext = String(filename || "").split(".").pop()?.toLowerCase();
	if (ext === "html") return "html";
	if (ext === "svg") return "svg";
	if (ext === "md" || ext === "markdown") return "markdown";
	if (ext === "pdf") return "pdf";
	if (ext === "docx") return "docx";
	if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"].includes(ext)) return "image";
	if ([
		"txt", "json", "xml", "yaml", "yml", "csv", "js", "ts", "jsx", "tsx",
		"py", "java", "c", "cpp", "h", "css", "scss", "sass", "less", "sh",
	].includes(ext)) return "text";
	return "generic";
}

/** MIME type for download affordances (mirrors the per-type components). */
export function mimeForFilename(filename) {
	const ext = String(filename || "").split(".").pop()?.toLowerCase();
	const map = {
		html: "text/html", svg: "image/svg+xml", md: "text/markdown", markdown: "text/markdown",
		txt: "text/plain", json: "application/json", xml: "application/xml", csv: "text/csv",
		png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
		webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
		pdf: "application/pdf",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	};
	return map[ext] || "text/plain";
}

const BASE64_TYPES = new Set(["image", "pdf", "docx", "generic"]);

/** A download href the browser can save without any privileged component
 *  (parity for the built-in DownloadButton): a data URL — base64 payload for
 *  binary types, percent-encoded text otherwise. */
export function downloadHref(type, filename, content) {
	const mime = mimeForFilename(filename);
	const c = String(content || "");
	if (BASE64_TYPES.has(type)) {
		// Binary payloads arrive base64 (optionally a data: URL) — pass through.
		if (c.startsWith("data:")) return c;
		return `data:${mime};base64,${c}`;
	}
	return `data:${mime};charset=utf-8,${encodeURIComponent(c)}`;
}

function imageUrl(filename, content) {
	const c = String(content || "");
	if (c.startsWith("data:")) return c;
	return `data:${mimeForFilename(filename)};base64,${c}`;
}

// ── Minimal, dependency-free Markdown → HTML (parity stand-in for the built-in's
// markdown-block, which uses the host's bundled `marked`). Covers headings,
// emphasis, inline code, fenced code, links, lists, blockquotes, hr, paragraphs.
// HTML is escaped first so artifact content can never inject markup. ──
function escapeHtml(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function renderInline(s) {
	let out = escapeHtml(s);
	// inline code first so its contents are not further transformed
	out = out.replace(/`([^`]+)`/g, (_m, code) => `<code class="px-1 rounded bg-muted text-foreground">${code}</code>`);
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
		const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : "#";
		return `<a class="text-primary underline" href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
	});
	return out;
}

export function renderMarkdownToHtml(src) {
	const lines = String(src || "").split(/\r?\n/);
	const out = [];
	let i = 0;
	let listType = null; // "ul" | "ol"
	const closeList = () => {
		if (listType) {
			out.push(`</${listType}>`);
			listType = null;
		}
	};
	while (i < lines.length) {
		const line = lines[i];
		// fenced code block
		const fence = line.match(/^```(.*)$/);
		if (fence) {
			closeList();
			const body = [];
			i++;
			while (i < lines.length && !/^```/.test(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			i++; // consume closing fence
			out.push(`<pre class="m-0 p-3 text-xs rounded bg-muted overflow-auto"><code>${escapeHtml(body.join("\n"))}</code></pre>`);
			continue;
		}
		// heading
		const h = line.match(/^(#{1,6})\s+(.*)$/);
		if (h) {
			closeList();
			const level = h[1].length;
			out.push(`<h${level} class="font-semibold text-foreground mt-3 mb-1">${renderInline(h[2])}</h${level}>`);
			i++;
			continue;
		}
		// horizontal rule
		if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			closeList();
			out.push(`<hr class="my-3 border-border" />`);
			i++;
			continue;
		}
		// blockquote
		const bq = line.match(/^>\s?(.*)$/);
		if (bq) {
			closeList();
			out.push(`<blockquote class="border-l-2 border-border pl-3 text-muted-foreground">${renderInline(bq[1])}</blockquote>`);
			i++;
			continue;
		}
		// unordered list
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
		// ordered list
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
		// blank line
		if (/^\s*$/.test(line)) {
			closeList();
			i++;
			continue;
		}
		// paragraph
		closeList();
		out.push(`<p class="my-1">${renderInline(line)}</p>`);
		i++;
	}
	closeList();
	return out.join("\n");
}

/**
 * Build the body element for an artifact type. Returns a live DOM node (lit
 * renders interpolated Nodes directly) — this is how the pack re-expresses the
 * built-in's `unsafeHTML`-based inlining without bare-importing lit directives.
 * `viewMode` toggles preview/code for the togglable types (html/svg/markdown).
 */
export function buildArtifactBody(type, filename, content, doc, viewMode) {
	doc = doc || (typeof document !== "undefined" ? document : null);
	const c = String(content || "");
	const mk = (tag) => doc.createElement(tag);

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
		// same-origin, no top navigation, no forms, no popups).
		const iframe = mk("iframe");
		iframe.setAttribute("sandbox", "allow-scripts");
		iframe.setAttribute("data-testid", "artifact-viewer-iframe");
		iframe.className = "w-full h-full border-0 bg-background";
		iframe.style.minHeight = "240px";
		iframe.srcdoc = c;
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
		const wrap = mk("div");
		wrap.className = "h-full flex items-center justify-center p-4";
		wrap.setAttribute("data-testid", "artifact-viewer-svg");
		// Scale the SVG to fill, mirroring SvgArtifact's class injection.
		wrap.innerHTML = c.replace(/<svg(\s|>)/i, (_m, p1) => `<svg class="w-full h-full"${p1}`);
		return wrap;
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
		// DOCUMENTED GAP: the built-in renders pages with pdfjs (a host-bundled
		// npm lib). A dependency-free pack uses the browser's native PDF embed via
		// a data URL — faithful preview without the privileged lib.
		const wrap = mk("div");
		wrap.className = "h-full flex flex-col bg-background";
		wrap.setAttribute("data-testid", "artifact-viewer-pdf");
		const embed = mk("iframe");
		embed.src = downloadHref("pdf", filename, c);
		embed.className = "flex-1 w-full border-0";
		embed.style.minHeight = "320px";
		wrap.appendChild(embed);
		return wrap;
	}

	if (type === "docx" || type === "generic") {
		// DOCUMENTED GAP (docx): docx-preview is a host-bundled npm lib; a pack
		// shows a download affordance instead (parity with GenericArtifact's
		// "preview not available" surface).
		const wrap = mk("div");
		wrap.className = "h-full flex items-center justify-center bg-background p-8";
		wrap.setAttribute("data-testid", type === "docx" ? "artifact-viewer-docx" : "artifact-viewer-generic");
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

	// text / code: DOCUMENTED GAP — no hljs syntax highlighting (host bundle).
	// The content is shown faithfully in a monospace block.
	const pre = mk("pre");
	pre.className = "m-0 p-4 text-xs whitespace-pre-wrap break-words font-mono text-foreground";
	pre.setAttribute("data-testid", "artifact-viewer-source");
	pre.textContent = c;
	return pre;
}

/** Types that offer a preview/code toggle (parity with PreviewCodeToggle). */
const TOGGLABLE = new Set(["html", "svg", "markdown"]);

export default function createPanel({ html, nothing, renderHeader }) {
	void renderHeader;

	// artifactId → { state: "loading" | "loaded", payload }. Module-level so the
	// async store.get result survives repaints without re-fetching.
	const cache = new Map();
	// artifactId → "preview" | "code" view mode (local UI state, like the
	// built-in's per-element viewMode). Defaults to "preview".
	const viewModes = new Map();

	return {
		render(params, host) {
			const artifactId = params && typeof params.artifactId === "string" ? params.artifactId : "";
			if (!artifactId) {
				return html`<div class="p-4 text-sm text-muted-foreground" data-testid="artifact-viewer-empty">No artifact selected.</div>`;
			}

			// Kick off the store rehydration ONCE per id (never on every repaint,
			// never synchronously in render — render stays pure).
			if (!cache.has(artifactId) && host && host.store) {
				cache.set(artifactId, { state: "loading", payload: null });
				host.store
					.get(artifactId)
					.then((payload) => {
						cache.set(artifactId, { state: "loaded", payload: payload || null });
						host.requestRender && host.requestRender();
					})
					.catch(() => {
						cache.set(artifactId, { state: "loaded", payload: null });
						host.requestRender && host.requestRender();
					});
			}

			const entry = cache.get(artifactId);
			if (!entry || entry.state === "loading") {
				return html`<div class="p-4 text-sm text-muted-foreground" data-testid="artifact-viewer-loading" data-artifact-id=${artifactId}>Loading ${artifactId}…</div>`;
			}

			const payload = entry.payload;
			if (!payload || typeof payload !== "object") {
				return html`<div class="p-4 text-sm text-destructive" data-testid="artifact-viewer-missing" data-artifact-id=${artifactId}>Artifact ${artifactId} not found in store.</div>`;
			}

			const filename = typeof payload.filename === "string" ? payload.filename : artifactId;
			const content = typeof payload.content === "string" ? payload.content : "";
			const type = detectArtifactType(filename);
			const viewMode = viewModes.get(artifactId) || "preview";

			const onToggle = (e) => {
				e?.preventDefault?.();
				e?.stopPropagation?.();
				viewModes.set(artifactId, viewMode === "preview" ? "code" : "preview");
				host && host.requestRender && host.requestRender();
			};

			const body = buildArtifactBody(type, filename, content, typeof document !== "undefined" ? document : null, viewMode);

			return html`
				<div class="h-full flex flex-col" data-testid="artifact-viewer-content" data-artifact-id=${artifactId} data-artifact-type=${type}>
					<div class="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-background">
						<span class="font-mono text-xs text-foreground" data-testid="artifact-viewer-filename">${filename}</span>
						<div class="flex items-center gap-2">
							${TOGGLABLE.has(type)
								? html`<button
										class="text-xs px-2 py-0.5 rounded border border-border bg-transparent text-foreground"
										data-testid="artifact-viewer-toggle"
										data-view-mode=${viewMode}
										@click=${onToggle}
									>${viewMode === "preview" ? "Code" : "Preview"}</button>`
								: nothing}
							<a
								class="text-xs px-2 py-0.5 rounded border border-border bg-transparent text-foreground no-underline"
								data-testid="artifact-viewer-download"
								href=${downloadHref(type, filename, content)}
								download=${filename}
							>Download</a>
						</div>
					</div>
					<div class="flex-1 min-h-0 overflow-auto" data-testid="artifact-viewer-body">${body}</div>
				</div>
			`;
		},
	};
}
