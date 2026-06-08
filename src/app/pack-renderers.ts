// src/app/pack-renderers.ts
//
// CLIENT bootstrap for pack-contributed tool renderers (design
// docs/design/extension-host.md §4a). On cold load (and after a marketplace
// install/uninstall re-fetches /api/tools) the UI calls `registerPackRenderers`
// with the tool metadata. For every tool with `rendererKind === "pack"` it
// registers a lazy loader (with `{ override: true }` so the pack renderer wins
// over any eager built-in of the same name) that:
//   1. fetches the pre-built ESM renderer bytes from GET /api/tools/:tool/renderer
//      (authed via gatewayFetch — the bare module URL would not carry the bearer);
//   2. imports it through a Blob URL with /* @vite-ignore */ so Vite does not try
//      to pre-bundle a runtime URL (works identically in dev + static dist);
//   3. invokes the module's default factory, handing it the host's own lit
//      toolkit (`html`/`nothing` + `renderHeader`) so the pack renderer shares the
//      app's single lit instance and standard header shape.
//
// The registry supplies the placeholder (first getToolRenderer) and the
// load-failure fallback (loader rejection) automatically — both reused unchanged.
// Registration is idempotent and re-driven from metadata, so it survives reload
// with no install-time client state.

import { html, nothing } from "lit";
import { registerLazyToolRenderer, renderHeader } from "../ui/tools/renderer-registry.js";
import { gatewayFetch } from "./gateway-fetch.js";

/** Host toolkit handed to a pack renderer's factory. Keeps the pack on the
 *  app's single `lit` instance and standard `renderHeader()` shape. */
const HOST_TOOLKIT = { html, nothing, renderHeader };

/** Tool metadata subset needed to decide pack-renderer registration. */
export interface PackRendererToolInfo {
	name: string;
	rendererKind?: string;
}

/**
 * Idempotent: register a lazy loader for every pack tool that ships a renderer.
 * Re-driven on every cold load AND after a marketplace install/uninstall (which
 * re-fetches /api/tools). `{ override: true }` makes the pack loader the
 * EFFECTIVE renderer even when an eager built-in of the same name is already
 * registered — because `rendererKind === "pack"` means the pack is the resolved
 * WINNING provider for that tool name (it shadowed the built-in tool), so its
 * renderer must win too.
 */
export function registerPackRenderers(tools: ReadonlyArray<PackRendererToolInfo>): void {
	for (const t of tools) {
		if (t.rendererKind !== "pack") continue;
		registerLazyToolRenderer(
			t.name,
			async () => {
				const url = `/api/tools/${encodeURIComponent(t.name)}/renderer`;
				const resp = await gatewayFetch(url); // authed (admin bearer); no session binding needed
				if (!resp.ok) throw new Error(`renderer ${t.name} HTTP ${resp.status}`);
				const blob = await resp.blob();
				const objUrl = URL.createObjectURL(blob.slice(0, blob.size, "text/javascript"));
				try {
					const mod = await import(/* @vite-ignore */ objUrl);
					const factory = (mod as any).default ?? (mod as any).createRenderer;
					if (typeof factory !== "function") throw new Error("renderer module has no factory export");
					return factory(HOST_TOOLKIT); // → ToolRenderer
				} finally {
					URL.revokeObjectURL(objUrl);
				}
			},
			{ override: true },
		);
	}
}
