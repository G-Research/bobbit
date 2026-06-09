// Pre-built ESM tool renderer for the `artifact_demo` litmus tool (Extension
// Host Phase 2, Slice D1; design docs/design/extension-host-phase2.md §10).
//
// REAL parity migration of the artifacts built-in's inline pill
// (src/ui/tools/artifacts/ArtifactPill.ts + artifacts-tool-renderer.ts) as a
// PACK renderer. Shipped as a pre-built ES module: the gateway serves it from
// GET /api/tools/artifact_demo/renderer and the client lazily imports it via a
// Blob URL, then calls this default-exported FACTORY with the host toolkit
// (`{ html, nothing, renderHeader }` — the app's OWN lit instance, so the pack
// never bare-imports `lit`).
//
// Parity notes (vs. artifacts-tool-renderer.ts):
//   - Emits a per-COMMAND status label ("Created artifact" / "Updated artifact"
//     / …) followed by the inline filename pill, exactly like the built-in's
//     `renderHeaderWithPill`. `isCustom: false` so it wraps in the standard card.
//   - The pill click OPENS the viewer (built-in: ArtifactPill → panel.openArtifact).
//
// Persist/restore parity (replaces persistPreviewArtifact/restorePreviewArtifact,
// src/server/preview/artifacts.ts): the artifact payload is persisted to the
// PACK-SCOPED store (host.store.put(artifactId, payload)) on a USER GESTURE, and
// rehydrated by id (host.store.get) in the viewer panel — never on mount.
//
// Security (design §5 control v): the renderer MUST NOT auto-invoke any
// capability on render. `host.store.put` / `host.ui.openPanel` / `host.ui.navigate`
// fire ONLY from the user's pill click / link click — there is no auto-open or
// auto-persist on mount. Theme tokens only; no hardcoded colours.

const COMMAND_LABELS = {
	create: "Created artifact",
	update: "Updated artifact",
	rewrite: "Rewrote artifact",
	get: "Got artifact",
	delete: "Deleted artifact",
	logs: "Got logs",
};

export default function createRenderer({ html, nothing, renderHeader }) {
	// renderHeader/nothing are part of the toolkit contract; this pill draws its
	// own minimal surface, so keep them referenced without forcing their use.
	void renderHeader;
	void nothing;

	return {
		render(params, _result, _isStreaming, ctx) {
			const p = params || {};
			const command = typeof p.command === "string" ? p.command : "create";
			const artifactId = typeof p.artifactId === "string" ? p.artifactId : "art-demo-1";
			const filename = typeof p.filename === "string" ? p.filename : "artifact.html";
			const content = typeof p.content === "string" ? p.content : "";
			const payload = { filename, content };
			const label = COMMAND_LABELS[command] || "Artifact";

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
					<div class="flex items-center gap-2 text-sm" data-testid="artifact-pill-root">
						<span class="text-muted-foreground" data-testid="artifact-pill-label">${label}</span>
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
							data-artifact-id=${artifactId}
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
