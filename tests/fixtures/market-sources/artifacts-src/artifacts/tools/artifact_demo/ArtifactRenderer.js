// Pre-built ESM tool renderer for the `artifact_demo` litmus tool (Extension
// Host Phase 2, Slice D1; design docs/design/extension-host-phase2.md §10).
//
// Re-expresses the artifacts built-in's inline pill (src/ui/tools/artifacts/
// ArtifactPill.ts + artifacts-tool-renderer.ts) as a pack renderer. Shipped as a
// pre-built ES module: the gateway serves it from GET /api/tools/artifact_demo/
// renderer and the client lazily imports it via a Blob URL, then calls this
// default-exported FACTORY with the host toolkit (`{ html, nothing, renderHeader }`
// — the app's OWN lit instance, so the pack never bare-imports `lit`).
//
// Persist/restore parity (replaces persistPreviewArtifact/restorePreviewArtifact,
// src/server/preview/artifacts.ts): the artifact payload is persisted to the
// PACK-SCOPED store (host.store.put(artifactId, payload)) on a USER GESTURE, and
// rehydrated by id (host.store.get) — never on mount.
//
// Security (design §5 control v): the renderer MUST NOT auto-invoke any
// capability on render. `host.store.put` / `host.ui.openPanel` / `host.ui.navigate`
// fire ONLY from the user's pill click / link click — there is no auto-open or
// auto-persist on mount. Theme tokens only; no hardcoded colours.
export default function createRenderer({ html, nothing, renderHeader }) {
	// renderHeader/nothing are part of the toolkit contract; this pill draws its
	// own minimal surface, so keep them referenced without forcing their use.
	void renderHeader;
	void nothing;

	return {
		render(params, _result, _isStreaming, ctx) {
			const p = params || {};
			const artifactId = typeof p.artifactId === "string" ? p.artifactId : "art-demo-1";
			const filename = typeof p.filename === "string" ? p.filename : "artifact.html";
			const content = typeof p.content === "string" ? p.content : "";
			const payload = { filename, content };

			// USER GESTURE: persist (idempotent) then open the viewer panel by id.
			const onOpen = async (e) => {
				e?.preventDefault?.();
				e?.stopPropagation?.();
				await ctx?.host?.store?.put(artifactId, payload);
				ctx?.host?.ui?.openPanel({ panelId: "artifacts.viewer", params: { artifactId } });
			};

			// USER GESTURE: persist then deep-link-navigate to the viewer route.
			// `navigate` resolves the structured target through the client route
			// registry and serializes `#/ext/artifacts?artifactId=…` — the pack
			// NEVER builds a URL (design §7 C1.2).
			const onDeepLink = async (e) => {
				e?.preventDefault?.();
				e?.stopPropagation?.();
				await ctx?.host?.store?.put(artifactId, payload);
				ctx?.host?.ui?.navigate({ route: "artifacts", params: { artifactId } });
			};

			return {
				isCustom: false,
				content: html`
					<div class="flex items-center gap-2" data-testid="artifact-pill-root">
						<span
							class="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-muted/50 border border-border rounded cursor-pointer hover:bg-muted transition-colors"
							data-testid="artifact-pill"
							data-artifact-id=${artifactId}
							@click=${onOpen}
						>
							<span class="text-foreground">${filename}</span>
						</span>
						<button
							class="text-xs px-2 py-0.5 rounded border border-border bg-transparent text-foreground"
							data-testid="artifact-deeplink"
							@click=${onDeepLink}
						>
							Open via link
						</button>
					</div>
				`,
			};
		},
	};
}
