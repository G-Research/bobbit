// Pre-built ESM tool renderer for the `artifact_demo` litmus tool (Extension Host
// Phase 2, Slice D1). SOURCE — bundled into the served
// `tools/artifact_demo/ArtifactRenderer.js` by scripts/build-market-packs.mjs.
//
// REAL parity migration of the artifacts built-in's inline pill
// (src/ui/tools/artifacts/ArtifactPill.ts + artifacts-tool-renderer.ts) as a PACK
// renderer. The gateway serves the BUILT bundle from GET /api/tools/
// artifact_demo/renderer; the client imports it via a Blob URL and calls this
// default-exported FACTORY with the host toolkit (`{ html, nothing, renderHeader }`
// — the app's own lit instance, so the pack never bare-imports `lit`).
//
// This renderer has NO npm deps (the pill is pure markup), but it is built through
// the same pack-bundling pipeline so authors have ONE convention. Persist/restore
// parity: the payload is persisted to the PACK-SCOPED store on a USER GESTURE, and
// rehydrated by id in the viewer panel — never on mount (design §5 control v).

const COMMAND_LABELS: Record<string, string> = {
	create: "Created artifact",
	update: "Updated artifact",
	rewrite: "Rewrote artifact",
	get: "Got artifact",
	delete: "Deleted artifact",
	logs: "Got logs",
};

export default function createRenderer({ html, nothing, renderHeader }: any) {
	void renderHeader;
	void nothing;

	return {
		render(params: any, _result: any, _isStreaming: any, ctx: any) {
			const p = params || {};
			const command = typeof p.command === "string" ? p.command : "create";
			const artifactId = typeof p.artifactId === "string" ? p.artifactId : "art-demo-1";
			const filename = typeof p.filename === "string" ? p.filename : "artifact.html";
			const content = typeof p.content === "string" ? p.content : "";
			const payload = { filename, content };
			const label = COMMAND_LABELS[command] || "Artifact";

			// USER GESTURE: persist (idempotent) then open the viewer panel by id.
			const onOpen = async (e: Event) => {
				e?.preventDefault?.();
				e?.stopPropagation?.();
				await ctx?.host?.store?.put(artifactId, payload);
				ctx?.host?.ui?.openPanel({ panelId: "artifacts.viewer", params: { artifactId } });
			};

			// USER GESTURE: persist then deep-link-navigate to the viewer route. The
			// pack NEVER builds a URL — `navigate` resolves the structured target
			// through the client route registry (design §7 C1.2).
			const onDeepLink = async (e: Event) => {
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
