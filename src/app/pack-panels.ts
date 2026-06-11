// src/app/pack-panels.ts
//
// CLIENT registry of pack-contributed SIDE-PANEL modules (pack schema V1 §8.1;
// design docs/design/pack-schema-v1-rationalisation.md). Panels are now
// PACK-scoped, not anchored to a carrier tool: panel ids are unique only WITHIN
// a pack, so the registry is keyed by the COMPOUND `{packId, panelId}` and the
// lazy loader fetches the pack-addressed endpoint
// GET /api/ext/packs/:packId/panels/:panelId.
//
// This MIRRORS `pack-renderers.ts` + the `renderer-registry.ts`
// generation-guarded chokepoint, but panels are a DISTINCT registry. It copies
// the `applyRegistration` contract (capture generation before any await, drop
// superseded applies, reconcile-on-uninstall) into its OWN map so the registry
// always ends matching the LAST REQUESTED project, never whichever async fetch
// happened to resolve last.
//
// On cold load (and after a marketplace install/uninstall re-fetches
// /api/ext/contributions) the UI calls `reconcilePackPanelsForProject(projectId)`.
// For every pack contribution row it registers each panel keyed by
// `{packId, panelId}`. `openPackPanel(target, callerPackId)` stays PACK-RELATIVE:
// the caller surface's bound packId resolves `panelId` → `{packId, panelId}`,
// lazily imports the panel module through a Blob URL (authed via gatewayFetch —
// the bare module URL would not carry the bearer), invokes its default factory
// handing it the host's own lit toolkit, caches the resulting panel, and
// mounts/focuses a side-panel tab whose content the render layer pulls by
// `{packId, panelId}`.

import { html, nothing, type TemplateResult } from "lit";
import { renderHeader } from "../ui/tools/renderer-registry.js";
import { gatewayFetch } from "./gateway-fetch.js";
import { fetchContributions, type PackContributionsWire } from "./api.js";
import { state, renderApp } from "./state.js";
import {
	packPanelTabId,
	panelTabsForSession,
	setPanelTabsForSession,
	setActivePanelTabIdForSession,
	type PanelWorkspaceTab,
} from "./panel-workspace.js";
import type { HostApi, PanelTarget } from "../shared/extension-host/host-api.js";

/** Host toolkit handed to a pack panel's factory — keeps the pack on the app's
 *  single `lit` instance and standard `renderHeader()` shape (same toolkit
 *  `pack-renderers.ts` hands a renderer factory). */
const HOST_TOOLKIT = { html, nothing, renderHeader };

/** Compound registry key — panel ids are only pack-unique, so a registration is
 *  addressed by `{packId, panelId}`. The NUL separator can never appear in either
 *  segment. */
function panelKey(packId: string, panelId: string): string {
	return `${packId}\u0000${panelId}`;
}

/** A pack panel instance returned by the module factory. `render(params)` is a
 *  PURE projection of the typed `PanelTarget.params` (e.g. `{ artifactId }`) onto
 *  a lit value — it MUST NOT auto-invoke actions / navigate on mount (design §6,
 *  v1 §5 v). Conventions enforced by review: theme tokens only, iframe `sandbox`
 *  preserved. */
export interface PackPanel {
	/** PURE projection of the typed `PanelTarget.params` onto a lit value. The second
	 *  arg is the per-session Host API (scoped capabilities — callRoute / store / session)
	 *  bound to the active session + the panel's pack-bound surface. It is `undefined`
	 *  in a non-DOM/unit context or when no session is active; a panel MUST tolerate
	 *  that and MUST NOT auto-invoke on mount. */
	render(params?: Record<string, unknown>, host?: HostApi): TemplateResult | unknown;
}

/** A host-API factory the app wires once (host-api.ts self-registers it), so a
 *  pack panel's `render(params, host)` can reach the scoped Phase-2 capabilities
 *  (`store`/`callRoute`/`session`) bound to the ACTIVE session + the panel's
 *  PACK-BOUND surface (pack schema V1 §8.4 — the panel mints via
 *  `{kind:"pack", packId, contributionKind:"panel", contributionId:panelId}`).
 *  Kept as an injected factory rather than a direct `getHostApi` import so
 *  `pack-panels.ts` stays free of a `host-api.ts` import cycle (host-api already
 *  imports `openPackPanel`). When the factory is unset (e.g. unit fixtures that
 *  never load host-api) panels render with `host === undefined` exactly as before. */
let panelHostFactory: ((sessionId: string | undefined, packId: string, panelId: string) => HostApi) | undefined;
export function setPanelHostFactory(
	fn: (sessionId: string | undefined, packId: string, panelId: string) => HostApi,
): void {
	panelHostFactory = fn;
}

/** The session a freshly-built panel host should bind to (the active session —
 *  the store guard authorizes against the header-bound session, design §2a). */
function currentSessionIdForPanel(): string | undefined {
	const s = state as unknown as { selectedSessionId?: string; remoteAgent?: { gatewaySessionId?: string } };
	return s.selectedSessionId || s.remoteAgent?.gatewaySessionId || undefined;
}

/** Module factory shape — invoked with {@link HOST_TOOLKIT}, returns a PackPanel
 *  (or a `{ default }` wrapper). */
export type PackPanelFactory = (toolkit: typeof HOST_TOOLKIT) => PackPanel | { default: PackPanel };

/** Metadata subset describing one pack-contributed panel. `entry` is unused
 *  client-side (the server resolves it from the winning contribution); it is
 *  retained for symmetry with the design's PackPanelInfo. */
export interface PackPanelInfo {
	packId: string;
	panelId: string;
	entry?: string;
	title?: string;
}

/** A registered panel: the owning `packId` (used to build the pack-addressed
 *  serving URL + mint the pack-bound surface token) plus the `projectId` the
 *  registration was driven for (so the lazy loader fetches the SAME winning
 *  provider the metadata fetch saw — no split-brain, design §4b). */
interface RegisteredPanel {
	packId: string;
	panelId: string;
	title?: string;
	projectId?: string;
}

/** `{packId, panelId}` key → registration. Reconciled from /api/ext/contributions
 *  metadata; an uninstall (or precedence change) that drops a key removes it here
 *  so a later `openPackPanel` for it no-ops. */
const panels = new Map<string, RegisteredPanel>();

/** key → loaded panel instance (cached after first successful load). */
const loadedPanels = new Map<string, PackPanel>();

/** key → in-flight load promise (so concurrent opens share one fetch). */
const inFlight = new Map<string, Promise<PackPanel | undefined>>();

/** Per-panel load-generation token. Bumped by {@link invalidatePanel} whenever a
 *  registration supersedes prior intent for the key (uninstall, or a project
 *  change that must re-fetch under the new scope). A load captures the generation
 *  BEFORE awaiting and only writes `loadedPanels` if it is still current on
 *  resolve — so a superseded in-flight load cannot resurrect a stale
 *  (wrong-project) module. Mirrors renderer-registry.ts `loadGeneration`. */
const loadGeneration = new Map<string, number>();

/** Invalidate any cached/in-flight load for `key`: bump its generation (so a
 *  superseded load becomes a no-op on resolve) and drop the cached instance +
 *  shared in-flight promise so the next open re-fetches under the new scope. */
function invalidatePanel(key: string): void {
	loadGeneration.set(key, (loadGeneration.get(key) ?? 0) + 1);
	loadedPanels.delete(key);
	inFlight.delete(key);
}

/**
 * Idempotent + reconciling registration, re-driven from /api/ext/contributions
 * metadata — byte-for-byte the {@link reconcilePackPanelsForProject} →
 * registerPackPanels shape of `pack-renderers.ts`. Replaces the registry with
 * `next` and:
 *  - INVALIDATES any panel whose project changed (so the next open re-fetches the
 *    new project's module) or that disappeared (uninstall);
 *  - removes the side-panel TAB of a panel that disappeared, so a running UI
 *    stops showing an uninstalled pack's panel without a reload (design §6).
 *
 * `opts.invalidateLoaded` FORCES invalidation of every SURVIVING panel's cached
 * module + in-flight load even when its `{packId, panelId, projectId}` are
 * unchanged. A marketplace UPDATE/reinstall re-registers the SAME key but with
 * fresh bytes behind the same serving URL, so without this the stale module keeps
 * serving until a full reload. Pass it ONLY from a real pack MUTATION
 * (install/update/reorder via `reconcileRenderersForActiveSession`) — NEVER from a
 * benign session-switch reconcile (`reconcilePackPanelsForProject`), which must
 * keep the cached module to avoid a needless re-import + "Loading…" flash.
 */
export function registerPackPanels(
	list: ReadonlyArray<PackPanelInfo>,
	projectId?: string,
	opts?: { invalidateLoaded?: boolean },
): void {
	const next = new Map<string, RegisteredPanel>();
	for (const info of list) {
		if (!info?.packId || !info.panelId) continue;
		next.set(panelKey(info.packId, info.panelId), { packId: info.packId, panelId: info.panelId, title: info.title, projectId });
	}
	// RECONCILE: compare prior registry to the fresh one.
	for (const [key, prev] of panels) {
		const incoming = next.get(key);
		if (!incoming) {
			// Uninstall / precedence change → invalidate + drop its tab.
			invalidatePanel(key);
			removePackPanelTab(prev.packId, prev.panelId);
		} else if (incoming.projectId !== prev.projectId || opts?.invalidateLoaded) {
			// Project change OR a forced pack-mutation re-register (update/reinstall):
			// drop the cached/in-flight module so the next open/render re-imports the
			// fresh bytes from the (same) serving URL.
			invalidatePanel(key);
		}
	}
	panels.clear();
	for (const [k, v] of next) panels.set(k, v);
}

/** Sentinel: no reconcile has run yet (distinct from `undefined` = reconciled for
 *  the global/no-project scope) so the first global-scope reconcile still fires. */
const UNRECONCILED = Symbol("unreconciled");
/** The project id of the last SUCCESSFULLY-APPLIED, non-superseded reconcile (or
 *  {@link UNRECONCILED} before any). Cheap dedupe guard, set AFTER a successful
 *  apply so a failed/superseded attempt does not poison it. */
let lastReconciledProject: string | undefined | typeof UNRECONCILED = UNRECONCILED;
/** Monotonic generation token for {@link reconcilePackPanelsForProject}: a newer
 *  reconcile supersedes an older one whose `await fetchContributions` is still in
 *  flight, so an out-of-order late response cannot clobber the registry. */
let reconcileGeneration = 0;

/**
 * Re-drive pack-panel registration for `projectId`: fetch the pack-contribution
 * metadata scoped to that project and (re-)register every declared panel with the
 * CURRENT project id. Mirrors `reconcilePackRenderersForProject` exactly — same
 * dedupe guard, generation guard, and fire-and-forget try/catch (never blocks a
 * session switch; built-in panels are unaffected on failure).
 */
export async function reconcilePackPanelsForProject(projectId: string | undefined): Promise<void> {
	if (lastReconciledProject !== UNRECONCILED && lastReconciledProject === projectId) return;
	const gen = ++reconcileGeneration;
	try {
		const packs = await fetchContributions(projectId);
		// A newer reconcile started while our fetch was in flight — it owns the
		// registry + dedupe now. Drop this stale response.
		if (gen !== reconcileGeneration) return;
		registerPackPanels(panelInfosFromContributions(packs), projectId);
		lastReconciledProject = projectId;
	} catch {
		// Non-fatal — leave lastReconciledProject untouched so a later call retries.
	}
}

/** Flatten the `panels[]` of each pack contribution row into PackPanelInfo[]
 *  (the owning packId is what addresses the pack-scoped serving endpoint).
 *  Exported so the marketplace mutation path can force a re-register from freshly
 *  fetched metadata (bypassing the dedupe guard). */
export function panelInfosFromContributions(packs: ReadonlyArray<PackContributionsWire>): PackPanelInfo[] {
	const out: PackPanelInfo[] = [];
	for (const p of packs) {
		const packId = typeof p?.packId === "string" ? p.packId : undefined;
		if (!packId || !Array.isArray(p.panels)) continue;
		for (const panel of p.panels) {
			const panelId = typeof panel?.id === "string" ? panel.id : undefined;
			if (!panelId) continue;
			out.push({ packId, panelId, title: typeof panel?.title === "string" ? panel.title : undefined });
		}
	}
	return out;
}

/**
 * Lazy-load a panel module by `{packId, panelId}`: fetch the pre-built ESM bytes
 * from the pack-addressed bearer-only serving endpoint, import them via a Blob URL
 * (`/* @vite-ignore *​/` so Vite does not pre-bundle a runtime URL), invoke the
 * default factory with the host toolkit, and cache the resulting panel.
 * Generation-guarded: a load superseded by a re-register/uninstall while in flight
 * does not write the cache.
 */
function loadPanelModule(key: string, reg: RegisteredPanel): Promise<PackPanel | undefined> {
	const existing = inFlight.get(key);
	if (existing) return existing;
	if (loadedPanels.has(key)) return Promise.resolve(loadedPanels.get(key));
	const gen = loadGeneration.get(key) ?? 0;
	const qs = reg.projectId ? `?projectId=${encodeURIComponent(reg.projectId)}` : "";
	const p: Promise<PackPanel | undefined> = (async () => {
		const url = `/api/ext/packs/${encodeURIComponent(reg.packId)}/panels/${encodeURIComponent(reg.panelId)}${qs}`;
		const resp = await gatewayFetch(url); // authed (admin bearer); static-asset-equivalent
		if (!resp.ok) throw new Error(`panel ${reg.packId}/${reg.panelId} HTTP ${resp.status}`);
		const blob = await resp.blob();
		const objUrl = URL.createObjectURL(blob.slice(0, blob.size, "text/javascript"));
		try {
			const mod = await import(/* @vite-ignore */ objUrl);
			const factory = (mod as { default?: unknown; createPanel?: unknown }).default
				?? (mod as { createPanel?: unknown }).createPanel;
			if (typeof factory !== "function") throw new Error("panel module has no factory export");
			const out = (factory as PackPanelFactory)(HOST_TOOLKIT);
			const panel = (out && typeof out === "object" && "default" in out ? out.default : out) as PackPanel;
			// Generation guard: only cache if not superseded while in flight.
			if ((loadGeneration.get(key) ?? 0) === gen) {
				loadedPanels.set(key, panel);
				// Repaint so a mounted pack-panel tab swaps the placeholder for content.
				try { renderApp(); } catch { /* non-DOM (unit fixtures) */ }
			}
			return panel;
		} finally {
			URL.revokeObjectURL(objUrl);
		}
	})()
		.catch((err) => {
			// eslint-disable-next-line no-console
			console.error(`[pack-panels] failed to load panel "${reg.packId}/${reg.panelId}":`, err);
			return undefined;
		})
		.finally(() => {
			// Drop only OUR own in-flight entry (identity-checked — a fresh load
			// started under a bumped generation may have installed a newer promise).
			if (inFlight.get(key) === p) inFlight.delete(key);
		});
	inFlight.set(key, p);
	return p;
}

/**
 * Resolve a `{callerPackId?, panelId}` open request to a registered panel.
 *  - PACK-BOUND callers (panel / entrypoint / launcher surfaces) pass their
 *    authoritative `callerPackId`: an exact `{packId, panelId}` lookup, no
 *    fallback (pack-relative — never reach into another pack's panel).
 *  - TOOL renderer callers now ALSO pass their owning structural `packId`
 *    (threaded from `/api/tools` via `packIdForTool` into the renderer's host
 *    surface), so an exact `{packId, panelId}` lookup opens the renderer's OWN
 *    pack's panel even when another installed pack shares the pack-local panel id.
 *  - The bare-`panelId` (no `callerPackId`) branch is a NARROW defensive fallback
 *    for a caller with a genuinely-unknown packId (e.g. a built-in renderer or a
 *    unit fixture): it resolves ONLY when the panel id is globally unique, and is
 *    a no-op when ambiguous (so a shared panel id never silently cross-resolves).
 */
function resolveOpenPanel(callerPackId: string | undefined, panelId: string): RegisteredPanel | undefined {
	if (callerPackId) return panels.get(panelKey(callerPackId, panelId));
	const matches = [...panels.values()].filter((r) => r.panelId === panelId);
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Load + mount a pack panel by id (design §6.3). PACK-RELATIVE: the caller's bound
 * `callerPackId` (threaded from the host factory / launcher registration) resolves
 * `target.panelId` → `{packId, panelId}`. Resolves the registered panel, kicks off
 * (or reuses) its lazy module load, and adds/focuses a side-panel tab carrying the
 * typed `PanelTarget.params`. No-op (with a warn) if no panel resolves (e.g. the
 * owning pack was uninstalled, or an ambiguous panel id with no caller packId).
 */
export function openPackPanel(target: PanelTarget, callerPackId?: string): void {
	const panelId = target?.panelId;
	if (!panelId) return;
	const reg = resolveOpenPanel(callerPackId, panelId);
	if (!reg) {
		// eslint-disable-next-line no-console
		console.warn(`[pack-panels] openPanel: no registered panel "${callerPackId ?? "?"}/${panelId}"`);
		return;
	}
	void loadPanelModule(panelKey(reg.packId, reg.panelId), reg);
	mountPackPanelTab(reg, target.params, target.sessionId);
}

/** Add or focus the side-panel tab for `{packId, panelId}`, carrying `params`.
 *  Best-effort: guarded so a non-DOM/unit context (no app state) never throws.
 *
 *  CONTRACT v2 (`PanelTarget.sessionId`): when `sessionId` is given, SELECT that
 *  session — set `state.selectedSessionId` (the same field the session-select path
 *  drives) so the sidebar highlight + main view follow the pane on the next
 *  `renderApp()` — and mount/focus the tab under THAT session instead of the
 *  currently-active one. Omitted ⇒ the active session (v1 behaviour, unchanged).
 *  The selection touches no platform navigation code, keeping the pack pure. */
function mountPackPanelTab(reg: RegisteredPanel, params?: Record<string, unknown>, sessionId?: string): void {
	try {
		const s = state as unknown as { selectedSessionId?: string; remoteAgent?: { gatewaySessionId?: string } };
		// v2: an explicit target session is selected (so the sidebar + main view
		// follow) and used as the tab's mount key; otherwise fall back to the active
		// session exactly as before.
		if (sessionId && sessionId !== s.selectedSessionId) s.selectedSessionId = sessionId;
		const sid = sessionId || s.selectedSessionId || s.remoteAgent?.gatewaySessionId || undefined;
		const id = packPanelTabId(reg.packId, reg.panelId);
		const title = reg.title || reg.panelId;
		const tab: PanelWorkspaceTab = {
			id,
			kind: "pack",
			title,
			label: title,
			legacyTab: "pack",
			source: { type: "pack", packId: reg.packId, panelId: reg.panelId, params, sessionId: sid },
			state: { packId: reg.packId, panelId: reg.panelId, params },
		};
		const tabs = panelTabsForSession(state, sid);
		const idx = tabs.findIndex((t) => t?.id === id);
		const nextTabs = idx >= 0
			? tabs.map((t) => (t.id === id ? { ...t, ...tab } : t))
			: [...tabs, tab];
		setPanelTabsForSession(state, sid, nextTabs);
		setActivePanelTabIdForSession(state, sid, id);
		try { renderApp(); } catch { /* non-DOM */ }
	} catch {
		/* no app state (unit fixtures) — the registry/load path still ran */
	}
}

/** Remove the side-panel tab of an uninstalled panel from every session that has
 *  it open (reconcile-on-uninstall). Best-effort + guarded. */
function removePackPanelTab(packId: string, panelId: string): void {
	try {
		const id = packPanelTabId(packId, panelId);
		const bySession = (state as unknown as { panelTabsBySession?: Record<string, PanelWorkspaceTab[]> }).panelTabsBySession;
		if (!bySession || typeof bySession !== "object") return;
		for (const [sid, tabs] of Object.entries(bySession)) {
			if (!Array.isArray(tabs) || !tabs.some((t) => t?.id === id)) continue;
			const key = sid === "__no-session__" ? undefined : sid;
			setPanelTabsForSession(state, key, tabs.filter((t) => t?.id !== id));
		}
		try { renderApp(); } catch { /* non-DOM */ }
	} catch {
		/* best-effort */
	}
}

/**
 * Render the content of a mounted pack-panel tab (called from the panel render
 * layer with the tab's `{packId, panelId}`). Returns the loaded panel's
 * `render(params)` projection, or a standard loading placeholder until the lazy
 * module resolves. A panel that is no longer registered (uninstalled) renders
 * nothing.
 *
 * RELOAD-SAFETY: a persisted side-panel tab is restored by panel-workspace
 * WITHOUT going through `openPackPanel`, so on a fresh page load `loadedPanels`
 * is empty even though the panel is registered (after reconcile). To keep the
 * persistent panel behavior working, a registered-but-not-yet-loaded panel
 * kicks off its module load HERE at render time (render-time lazy load). This
 * reuses the same generation-guarded `loadPanelModule` chokepoint — `inFlight`
 * de-dupes concurrent/repeat renders so at most one fetch runs, and the loader
 * repaints via `renderApp()` on resolve to swap in the real content. This loads
 * only the panel module the user already had open — no auto-invoke beyond that.
 */
export function renderPackPanelContent(packId: string, panelId: string, params?: Record<string, unknown>): TemplateResult | unknown {
	const key = panelKey(packId, panelId);
	const panel = loadedPanels.get(key);
	if (panel) {
		try {
			// Build a session-bound host for this pack's panel surface (pack schema V1
			// §8.4) so the panel can rehydrate from `host.store.*` etc. `getHostApi` is
			// supplied via the injected factory (host-api self-registers) to avoid an
			// import cycle; when unset (unit fixtures) the panel renders with
			// host === undefined.
			const sessionId = currentSessionIdForPanel();
			const host = panelHostFactory
				? panelHostFactory(sessionId, packId, panelId)
				: undefined;
			// Thread the BOUND session id into the render params under a reserved key so
			// a panel can scope its module-level state PER SESSION (the panel module is a
			// single page-lived instance shared across sessions). Injected fresh each
			// render — NOT persisted to the panel-workspace tab — so it always reflects
			// the CURRENT session. Panels that ignore it are unaffected.
			const renderParams = sessionId ? { ...(params ?? {}), __sessionId: sessionId } : params;
			return panel.render(renderParams, host);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error(`[pack-panels] render failed for "${packId}/${panelId}":`, err);
			return renderHeader("error", null, html`<span class="font-mono">${panelId}</span> — panel failed to render`);
		}
	}
	const reg = panels.get(key);
	if (!reg) return nothing;
	// Restored (or otherwise not-yet-loaded) registered panel: kick off its lazy
	// module load. `loadPanelModule` is generation-guarded and `inFlight`-deduped,
	// so repeated render-time calls share one fetch and repaint on resolve.
	void loadPanelModule(key, reg);
	return html`
		<div class="p-4 text-sm text-muted-foreground" data-pack-panel-loading=${panelId}>
			Loading ${panelId}…
		</div>
	`;
}
