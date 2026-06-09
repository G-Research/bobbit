// Pre-built ESM side-panel module for the `artifact_demo` litmus tool's
// `artifacts.viewer` panel (Extension Host Phase 2, Slice D1; design
// docs/design/extension-host-phase2.md §10). SOURCE — bundled into the served
// `tools/artifact_demo/ArtifactViewerPanel.js` by scripts/build-market-packs.mjs.
//
// REAL behavioral-parity migration of the artifacts built-in viewer
// (src/ui/tools/artifacts/ArtifactElement.ts + the per-type components). The
// gateway serves the BUILT bundle from GET /api/tools/artifact_demo/panel/
// artifacts.viewer; the client imports it via a Blob URL and calls this
// default-exported FACTORY with the host toolkit (`{ html, nothing, renderHeader }`
// — the app's own lit instance, so the pack never bare-imports `lit`).
//
// REHYDRATE-BY-ID parity: the panel receives ONLY `{ artifactId }` and rehydrates
// from the PACK-SCOPED store via `host.store.get(artifactId)` — a fresh open /
// deep-link reconstructs the viewer identically. `render` is a PURE projection:
// the async store fetch is kicked off ONCE (cached by id) and `host.requestRender()`
// repaints when it resolves — no auto-invoke of any other capability on mount.
//
// Per-type parity now reaches ALL types the built-in handles, with the formerly-
// DOCUMENTED GAPS closed by VENDORED npm libs (bundled, not host-privileged):
//   - text/code → REAL highlight.js syntax highlighting (helpers.ts).
//   - pdf       → REAL pdfjs-dist page rasterisation (binary-render.ts).
//   - docx      → REAL docx-preview rendering (binary-render.ts).
//   - html      → sandboxed iframe (PRESERVED) + console capture via a postMessage
//                 shim injected into the srcdoc (no privileged host bridge).
// html/markdown/svg/image stay as before; theme tokens only, no hardcoded colours.

import {
	buildArtifactBody,
	detectArtifactType,
	downloadHref,
	CONSOLE_MESSAGE_MARKER,
	type ArtifactType,
} from "./helpers.js";
import { renderPdfInto, renderDocxInto } from "./binary-render.js";

// Re-export the pure helpers so any consumer importing the built panel still
// finds them (back-compat with earlier D1 wiring). The unit suite imports the
// node-safe helpers.ts directly (this bundle pulls in browser-only pdfjs/docx).
export {
	detectArtifactType,
	buildArtifactBody,
	renderMarkdownToHtml,
	mimeForFilename,
	downloadHref,
} from "./helpers.js";

/** Types that offer a preview/code toggle (parity with PreviewCodeToggle). */
const TOGGLABLE = new Set<ArtifactType>(["html", "svg", "markdown"]);

interface ConsoleEntry { type: "log" | "error"; text: string; }

export default function createPanel({ html, nothing, renderHeader }: any) {
	void renderHeader;

	// artifactId → { state, payload } — module-closure cache so the async store.get
	// result survives repaints without re-fetching.
	const cache = new Map<string, { state: "loading" | "loaded"; payload: any }>();
	// artifactId → "preview" | "code" view mode (local UI state).
	const viewModes = new Map<string, "preview" | "code">();
	// cacheKey → live body node. Caching the node keeps the html iframe + the
	// pdf/docx render-roots STABLE across repaints (so a console-log repaint does
	// not reload the iframe or re-rasterise the PDF).
	const bodyCache = new Map<string, any>();
	// artifactId → captured console entries (from the iframe shim).
	const consoleLogs = new Map<string, ConsoleEntry[]>();
	// artifactId → console panel expanded?
	const consoleExpanded = new Map<string, boolean>();

	let repaint: () => void = () => {};
	let listenerAttached = false;

	// Attach ONE window message listener that routes artifact-console postMessages
	// (tagged with CONSOLE_MESSAGE_MARKER + the artifact id) into `consoleLogs`.
	function ensureConsoleListener(): void {
		if (listenerAttached || typeof window === "undefined") return;
		listenerAttached = true;
		window.addEventListener("message", (e: MessageEvent) => {
			const d: any = e?.data;
			if (!d || typeof d !== "object" || d[CONSOLE_MESSAGE_MARKER] !== true) return;
			const id = typeof d.id === "string" ? d.id : "";
			const arr = consoleLogs.get(id) || [];
			arr.push({ type: d.method === "error" ? "error" : "log", text: String(d.text || "") });
			consoleLogs.set(id, arr);
			repaint();
		});
	}

	return {
		render(params: any, host: any) {
			ensureConsoleListener();
			repaint = () => { try { host?.requestRender?.(); } catch { /* non-DOM */ } };

			const artifactId = params && typeof params.artifactId === "string" ? params.artifactId : "";
			if (!artifactId) {
				return html`<div class="p-4 text-sm text-muted-foreground" data-testid="artifact-viewer-empty">No artifact selected.</div>`;
			}

			// Kick off store rehydration ONCE per id (never on every repaint, never
			// synchronously — render stays pure).
			if (!cache.has(artifactId) && host?.store) {
				cache.set(artifactId, { state: "loading", payload: null });
				host.store
					.get(artifactId)
					.then((payload: any) => {
						cache.set(artifactId, { state: "loaded", payload: payload || null });
						repaint();
					})
					.catch(() => {
						cache.set(artifactId, { state: "loaded", payload: null });
						repaint();
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

			const cacheKey = `${artifactId}:${type}:${viewMode}`;
			let body = bodyCache.get(cacheKey);
			if (!body) {
				// A fresh html preview re-runs its scripts; reset its captured logs so
				// the console reflects the current iframe instance (avoid duplicates).
				if (type === "html" && viewMode === "preview") consoleLogs.delete(artifactId);
				body = buildArtifactBody(type, filename, content, document, viewMode, artifactId);
				bodyCache.set(cacheKey, body);
				// Fill the pdf/docx render-roots with the REAL vendored renderers
				// (async; repaints are unaffected — the node is cached/stable).
				if (type === "pdf") {
					const root = body.querySelector?.("[data-pdf-render-root]");
					if (root) void renderPdfInto(root as HTMLElement, content);
				} else if (type === "docx") {
					const root = body.querySelector?.("[data-docx-render-root]");
					if (root) void renderDocxInto(root as HTMLElement, content);
				}
			}

			const logs = consoleLogs.get(artifactId) || [];
			const showConsole = type === "html" && viewMode === "preview" && logs.length > 0;
			const expanded = consoleExpanded.get(artifactId) ?? true;
			const errorCount = logs.filter((l) => l.type === "error").length;

			const onToggle = (e: Event) => {
				e?.preventDefault?.();
				e?.stopPropagation?.();
				viewModes.set(artifactId, viewMode === "preview" ? "code" : "preview");
				repaint();
			};
			const onToggleConsole = (e: Event) => {
				e?.preventDefault?.();
				e?.stopPropagation?.();
				consoleExpanded.set(artifactId, !expanded);
				repaint();
			};

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
					${showConsole
						? html`<div class="border-t border-border" data-testid="artifact-viewer-console">
								<button
									class="flex items-center gap-2 w-full text-left text-xs px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
									data-testid="artifact-viewer-console-toggle"
									@click=${onToggleConsole}
								>${expanded ? "▾" : "▸"} console (${errorCount > 0 ? `${errorCount} ${errorCount === 1 ? "error" : "errors"}` : logs.length})</button>
								${expanded
									? html`<div class="max-h-40 overflow-auto px-3 pb-2 space-y-0.5">
											${logs.map((l) => html`<div
												class="text-xs font-mono ${l.type === "error" ? "text-destructive" : "text-muted-foreground"}"
												data-testid="artifact-viewer-console-entry"
												data-log-type=${l.type}
											>[${l.type}] ${l.text}</div>`)}
										</div>`
									: nothing}
							</div>`
						: nothing}
				</div>
			`;
		},
	};
}
