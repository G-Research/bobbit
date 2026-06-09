// Pre-built ESM side-panel module for the `artifact_demo` litmus tool's
// `artifacts.viewer` panel (Extension Host Phase 2, Slice D1; design
// docs/design/extension-host-phase2.md §10).
//
// Re-expresses the artifacts built-in's viewer (src/ui/tools/artifacts/
// ArtifactElement.ts + the per-type artifact components) as a pack panel. The
// gateway serves it from GET /api/tools/artifact_demo/panel/artifacts.viewer and
// the client lazily imports it via a Blob URL, then calls this default-exported
// FACTORY with the host toolkit (`{ html, nothing, renderHeader }`).
//
// REHYDRATE-BY-ID parity (replaces restorePreviewArtifact): the panel receives
// ONLY `{ artifactId }` in its typed params (the deep-link carries only the id,
// never the payload) and rehydrates its content from the PACK-SCOPED store via
// `host.store.get(artifactId)` — so a fresh open / deep-link reconstructs the
// viewer identically. `render(params, host)` is a PURE projection: the async
// store fetch is kicked off ONCE (cached by id) and `host.requestRender()`
// repaints when it resolves — no auto-invoke of any other capability on mount
// (design §6, v1 §5 v). Theme tokens only; content rendered as text (no
// unsandboxed iframe is introduced).
export default function createPanel({ html, nothing, renderHeader }) {
	void renderHeader;
	void nothing;

	// artifactId → { state: "loading" | "loaded", payload }. Module-level so the
	// async store.get result survives repaints without re-fetching.
	const cache = new Map();

	return {
		render(params, host) {
			const artifactId = params && typeof params.artifactId === "string" ? params.artifactId : "";
			if (!artifactId) {
				return html`<div class="p-4 text-sm text-muted-foreground" data-testid="artifact-viewer-empty">No artifact selected.</div>`;
			}

			// Kick off the store rehydration ONCE per id (never on every repaint,
			// never synchronously in render — render stays pure). Requires a host:
			// the panel host API is built host-side and handed to render() bound to
			// the active session + this pack's tool (design §2a.2).
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
			return html`
				<div class="p-4 space-y-2" data-testid="artifact-viewer-content" data-artifact-id=${artifactId}>
					<div class="text-sm font-medium text-foreground" data-testid="artifact-viewer-filename">${filename}</div>
					<pre class="text-xs whitespace-pre-wrap rounded border border-border bg-muted/30 p-2 text-foreground" data-testid="artifact-viewer-body">${content}</pre>
				</div>
			`;
		},
	};
}
