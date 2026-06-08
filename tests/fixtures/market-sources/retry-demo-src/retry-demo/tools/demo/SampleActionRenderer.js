// Pre-built ESM tool renderer for the `sample_action` demo tool (Extension Host
// Phase 1, design docs/design/extension-host.md §2.4 / §4a).
//
// Shipped as a pre-built ES module: the gateway serves it from
// GET /api/tools/sample_action/renderer and the client lazily imports it via a
// Blob URL, then calls this default-exported FACTORY with a host toolkit
// (`{ html, nothing, renderHeader }` — the app's OWN lit instance, so the pack
// never bare-imports `lit` and the lit singleton is never duplicated).
//
// Action-result propagation contract (design §4a, mirrors children-mutation-
// approval): the handler result is stored in RENDERER-LOCAL state — a
// module-level Map keyed by toolUseId — and the renderer re-renders its OWN DOM.
// It NEVER mutates the transcript/persisted tool result.
//
// Security (design §5 control v): the renderer MUST NOT auto-invoke the action
// on render — `invokeAction` is only ever called from the user's Retry click.
export default function createRenderer({ html, nothing, renderHeader }) {
	// Keep `renderHeader` referenced so the toolkit contract is explicit even
	// though this renderer draws its own header (renderHeader's icon slot needs a
	// lucide icon node, which a toolkit-only pack renderer has no safe value for).
	void renderHeader;

	// toolUseId → latest handler JSON. Module-level so it survives re-mounts /
	// transcript re-renders without touching the transcript (design §4a).
	const lastResult = new Map();

	return {
		render(_params, result, _isStreaming, ctx) {
			const toolUseId = ctx && ctx.toolUseId;
			const shown = toolUseId ? lastResult.get(toolUseId) : undefined;

			const onRetry = async () => {
				// sessionId + toolUseId are bound into ctx.host by the app
				// (getHostApi(sessionId, toolUseId)); args carries NO identity.
				const data = await ctx?.host?.invokeAction("sample_action", "retry", {});
				if (toolUseId) lastResult.set(toolUseId, data);
				// Ask the host to repaint so this block's render() runs again and
				// paints the stored result (renderer-local state, no transcript write).
				ctx?.host?.requestRender?.();
			};

			return {
				isCustom: false,
				content: html`
					<div
						class="flex items-center justify-between gap-2"
						data-testid="pack-renderer-root"
					>
						<span class="text-sm text-muted-foreground" data-testid="pack-header"
							>Sample action</span
						>
						${shown
							? html`<span data-testid="pack-result">${shown.message}</span>`
							: nothing}
						<button
							class="text-xs px-2 py-0.5 rounded border border-border bg-transparent text-foreground"
							data-testid="pack-retry"
							@click=${onRetry}
						>
							Retry
						</button>
					</div>
				`,
			};
		},
	};
}
