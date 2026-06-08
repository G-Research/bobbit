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
import { registerLazyToolRenderer, unregisterPackRenderer, renderHeader } from "../ui/tools/renderer-registry.js";
import { gatewayFetch } from "./gateway-fetch.js";
import { fetchTools } from "./api.js";

/** Host toolkit handed to a pack renderer's factory. Keeps the pack on the
 *  app's single `lit` instance and standard `renderHeader()` shape. */
const HOST_TOOLKIT = { html, nothing, renderHeader };

/** Tool metadata subset needed to decide pack-renderer registration. */
export interface PackRendererToolInfo {
	name: string;
	rendererKind?: string;
}

/** Names currently registered as pack renderers by {@link registerPackRenderers}.
 *  Tracked so a later call can RECONCILE: any previously pack-owned name that is
 *  no longer `rendererKind:"pack"` in the fresh metadata (uninstall, or a
 *  precedence change) is unregistered, restoring the displaced built-in. */
let packRegistered = new Set<string>();

/**
 * Idempotent: register a lazy loader for every pack tool that ships a renderer.
 * Re-driven on every cold load AND after a marketplace install/uninstall (which
 * re-fetches /api/tools). `{ override: true }` makes the pack loader the
 * EFFECTIVE renderer even when an eager built-in of the same name is already
 * registered — because `rendererKind === "pack"` means the pack is the resolved
 * WINNING provider for that tool name (it shadowed the built-in tool), so its
 * renderer must win too.
 */
export function registerPackRenderers(
	tools: ReadonlyArray<PackRendererToolInfo>,
	/** The active project id, threaded so the renderer Blob-fetch resolves the
	 *  SAME winning provider the metadata fetch saw (design §4b — no split-brain:
	 *  a project-scope pack, or a project pack shadowing a global tool, must serve
	 *  its own renderer). Omitted for server/global scope. */
	projectId?: string,
): void {
	const next = new Set<string>();
	for (const t of tools) {
		if (t.rendererKind !== "pack") continue;
		next.add(t.name);
		const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
		registerLazyToolRenderer(
			t.name,
			async () => {
				const url = `/api/tools/${encodeURIComponent(t.name)}/renderer${qs}`;
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
	// RECONCILE: any name we previously registered as a pack renderer but that is
	// no longer pack-owned in the fresh metadata (uninstall / precedence change)
	// must be torn down so the running UI stops using the stale pack renderer and
	// restores any displaced built-in — without a page reload (design §4a).
	for (const name of packRegistered) {
		if (!next.has(name)) unregisterPackRenderer(name);
	}
	packRegistered = next;
}

/** Sentinel: no reconcile has run yet. Distinct from `undefined` (reconciled
 *  for the global/no-project scope) so the first global-scope reconcile still
 *  fires rather than being swallowed by the dedupe guard. */
const UNRECONCILED = Symbol("unreconciled");
/** The project id of the LAST reconcile (or {@link UNRECONCILED} before any).
 *  Used only as a cheap dedupe guard — re-driving on a REAL project change
 *  always wins. */
let lastReconciledProject: string | undefined | typeof UNRECONCILED = UNRECONCILED;

/**
 * Re-drive pack-renderer registration for `projectId`: fetch the tool metadata
 * scoped to that project and (re-)register every pack renderer with the CURRENT
 * project id. Because the lazy loader closes over `projectId` (it serves the
 * project-scoped renderer Blob), a project CHANGE must replace the loaders —
 * `registerPackRenderers` re-registers (override) each pack tool with the new
 * project id (the Wave 6 generation guard drops any stale in-flight/loaded
 * module on re-register) and unregisters names absent for the new project.
 *
 * Called BOTH at boot AND whenever the ACTIVE session's project is
 * established/changes (session-manager, alongside `applyProjectPalette`). Cheap
 * dedupe guard skips a redundant re-drive when the project hasn't changed;
 * correctness (re-drive on real change) takes priority. Fire-and-forget +
 * try/catch — never blocks session switch; built-in renderers are unaffected on
 * failure. (design §4a/§4c — pack-renderer registration follows the active
 * session's project.)
 */
export async function reconcilePackRenderersForProject(projectId: string | undefined): Promise<void> {
	// Skip a redundant re-drive when the project is unchanged from the last one.
	if (lastReconciledProject !== UNRECONCILED && lastReconciledProject === projectId) return;
	lastReconciledProject = projectId;
	try {
		registerPackRenderers(await fetchTools(projectId), projectId);
	} catch {
		// Non-fatal — built-in renderers are unaffected. Reset the guard so a later
		// call for the same project retries instead of being deduped away.
		lastReconciledProject = UNRECONCILED;
	}
}
