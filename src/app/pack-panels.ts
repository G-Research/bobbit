// src/app/pack-panels.ts
//
// CLIENT registry of pack-contributed SIDE-PANEL modules (Slice B4 —
// `panels:` + `host.ui.openPanel`; design docs/design/extension-host-phase2.md §6).
//
// This MIRRORS `pack-renderers.ts` + the `renderer-registry.ts`
// generation-guarded chokepoint, but panels are a DISTINCT registry keyed by
// `panelId` (not tool name). It does NOT fork `renderer-registry.ts`; it copies
// the `applyRegistration` contract (capture generation before any await, drop
// superseded applies, reconcile-on-uninstall) into its OWN map so the registry
// always ends matching the LAST REQUESTED project, never whichever async fetch
// happened to resolve last.
//
// On cold load (and after a marketplace install/uninstall re-fetches /api/tools)
// the UI calls `reconcilePackPanelsForProject(projectId)`. For every tool that
// declares `panels[]` it registers each panel keyed by `panelId` (with the
// declaring `tool`, so the lazy loader can address the bearer-only serving
// endpoint GET /api/tools/:tool/panel/:panelId). `openPackPanel(target)` lazily
// imports the panel module through a Blob URL (authed via gatewayFetch — the bare
// module URL would not carry the bearer), invokes its default factory handing it
// the host's own lit toolkit (so the pack shares the app's single lit instance
// and standard header shape), caches the resulting panel, and mounts/focuses a
// side-panel tab whose content the render layer pulls by `panelId`.

import { html, nothing, type TemplateResult } from "lit";
import { renderHeader } from "../ui/tools/renderer-registry.js";
import { gatewayFetch } from "./gateway-fetch.js";
import { fetchTools, type ToolInfo } from "./api.js";
import { state, renderApp } from "./state.js";
import { getHostApi } from "./host-api.js";
import type { HostApi } from "../shared/extension-host/host-api.js";
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

/** A pack panel instance returned by the module factory. `render(params)` is a
 *  PURE projection of the typed `PanelTarget.params` (e.g. `{ artifactId }`) onto
 *  a lit value — it MUST NOT auto-invoke actions / navigate on mount (design §6,
 *  v1 §5 v). Conventions enforced by review: theme tokens only, iframe `sandbox`
 *  preserved. */
export interface PackPanel {
	/** PURE projection of the typed `PanelTarget.params` onto a lit value. The second
	 *  arg is the per-session Host API (scoped capabilities — callRoute / store / session)
	 *  bound `getHostApi(sessionId, undefined, packTool)` per the panel host-context
	 *  binding (design §2a.2). It is `undefined` in a non-DOM/unit context or when no
	 *  session is active; a panel MUST tolerate that and MUST NOT auto-invoke on mount. */
	render(params?: Record<string, unknown>, host?: HostApi): TemplateResult | unknown;
}

/** A host-API factory the app wires once (host-api.ts self-registers it), so a
 *  pack panel's `render(params, host)` can reach the scoped Phase-2 capabilities
 *  (`store`/`callRoute`/`session`) bound to the ACTIVE session + the panel's own
 *  pack tool — design §2a.2 ("the panel host API is built
 *  `getHostApi(sessionId, undefined, packTool)`"). Kept as an injected factory
 *  rather than a direct `getHostApi` import so `pack-panels.ts` stays free of a
 *  `host-api.ts` import cycle (host-api already imports `openPackPanel`). When the
 *  factory is unset (e.g. unit fixtures that never load host-api) panels render
 *  with `host === undefined` exactly as before. */
let panelHostFactory: ((sessionId: string | undefined, packTool: string | undefined) => HostApi) | undefined;
export function setPanelHostFactory(
	fn: (sessionId: string | undefined, packTool: string | undefined) => HostApi,
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
	panelId: string;
	tool: string;
	entry?: string;
	title?: string;
}

/** A registered panel: the declaring `tool` (used to build the serving URL) plus
 *  the `projectId` the registration was driven for (so the lazy loader fetches
 *  the SAME winning provider the metadata fetch saw — no split-brain, design §4b). */
interface RegisteredPanel {
	tool: string;
	title?: string;
	projectId?: string;
}

/** panelId → registration. Reconciled from /api/tools metadata; an uninstall (or
 *  precedence change) that drops a panelId removes it here so a later
 *  `openPackPanel` for it no-ops. */
const panels = new Map<string, RegisteredPanel>();

/** panelId → loaded panel instance (cached after first successful load). */
const loadedPanels = new Map<string, PackPanel>();

/** panelId → in-flight load promise (so concurrent opens share one fetch). */
const inFlight = new Map<string, Promise<PackPanel | undefined>>();

/** Per-panel load-generation token. Bumped by {@link invalidatePanel} whenever a
 *  registration supersedes prior intent for the panelId (uninstall, or a
 *  project/tool change that must re-fetch under the new scope). A load captures
 *  the generation BEFORE awaiting and only writes `loadedPanels` if it is still
 *  current on resolve — so a superseded in-flight load cannot resurrect a stale
 *  (wrong-project) module. Mirrors renderer-registry.ts `loadGeneration`. */
const loadGeneration = new Map<string, number>();

/** Invalidate any cached/in-flight load for `panelId`: bump its generation (so a
 *  superseded load becomes a no-op on resolve) and drop the cached instance +
 *  shared in-flight promise so the next open re-fetches under the new scope. */
function invalidatePanel(panelId: string): void {
	loadGeneration.set(panelId, (loadGeneration.get(panelId) ?? 0) + 1);
	loadedPanels.delete(panelId);
	inFlight.delete(panelId);
}

/**
 * Idempotent + reconciling registration, re-driven from /api/tools metadata —
 * byte-for-byte the {@link reconcilePackPanelsForProject} → registerPackPanels
 * shape of `pack-renderers.ts`. Replaces the registry with `next` and:
 *  - INVALIDATES any panel whose tool/project changed (so the next open
 *    re-fetches the new project's module) or that disappeared (uninstall);
 *  - removes the side-panel TAB of a panel that disappeared, so a running UI
 *    stops showing an uninstalled pack's panel without a reload (design §6).
 */
export function registerPackPanels(list: ReadonlyArray<PackPanelInfo>, projectId?: string): void {
	const next = new Map<string, RegisteredPanel>();
	for (const info of list) {
		if (!info?.panelId || !info.tool) continue;
		next.set(info.panelId, { tool: info.tool, title: info.title, projectId });
	}
	// RECONCILE: compare prior registry to the fresh one.
	for (const [panelId, prev] of panels) {
		const incoming = next.get(panelId);
		if (!incoming) {
			// Uninstall / precedence change → invalidate + drop its tab.
			invalidatePanel(panelId);
			removePackPanelTab(panelId);
		} else if (incoming.tool !== prev.tool || incoming.projectId !== prev.projectId) {
			// Same panelId now served by a different tool/project → re-fetch on next open.
			invalidatePanel(panelId);
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
 *  reconcile supersedes an older one whose `await fetchTools` is still in flight,
 *  so an out-of-order late response cannot clobber the registry. */
let reconcileGeneration = 0;

/**
 * Re-drive pack-panel registration for `projectId`: fetch the tool metadata
 * scoped to that project and (re-)register every declared panel with the CURRENT
 * project id. Mirrors `reconcilePackRenderersForProject` exactly — same dedupe
 * guard, generation guard, and fire-and-forget try/catch (never blocks a session
 * switch; built-in panels are unaffected on failure).
 */
export async function reconcilePackPanelsForProject(projectId: string | undefined): Promise<void> {
	if (lastReconciledProject !== UNRECONCILED && lastReconciledProject === projectId) return;
	const gen = ++reconcileGeneration;
	try {
		const tools = await fetchTools(projectId);
		// A newer reconcile started while our fetch was in flight — it owns the
		// registry + dedupe now. Drop this stale response.
		if (gen !== reconcileGeneration) return;
		registerPackPanels(panelInfosFromTools(tools), projectId);
		lastReconciledProject = projectId;
	} catch {
		// Non-fatal — leave lastReconciledProject untouched so a later call retries.
	}
}

/** Flatten the `panels[]` contribution of each tool into PackPanelInfo[] (the
 *  declaring tool name is what addresses the serving endpoint). */
function panelInfosFromTools(tools: ReadonlyArray<ToolInfo>): PackPanelInfo[] {
	const out: PackPanelInfo[] = [];
	for (const t of tools) {
		const declared = (t as ToolInfo & { panels?: Array<{ id?: unknown; title?: unknown }> }).panels;
		if (!Array.isArray(declared)) continue;
		for (const p of declared) {
			const panelId = typeof p?.id === "string" ? p.id : undefined;
			if (!panelId) continue;
			out.push({ panelId, tool: t.name, title: typeof p?.title === "string" ? p.title : undefined });
		}
	}
	return out;
}

/**
 * Lazy-load a panel module by id: fetch the pre-built ESM bytes from the
 * bearer-only serving endpoint, import them via a Blob URL (`/* @vite-ignore *​/`
 * so Vite does not pre-bundle a runtime URL), invoke the default factory with the
 * host toolkit, and cache the resulting panel. Generation-guarded: a load
 * superseded by a re-register/uninstall while in flight does not write the cache.
 */
function loadPanelModule(panelId: string, reg: RegisteredPanel): Promise<PackPanel | undefined> {
	const existing = inFlight.get(panelId);
	if (existing) return existing;
	if (loadedPanels.has(panelId)) return Promise.resolve(loadedPanels.get(panelId));
	const gen = loadGeneration.get(panelId) ?? 0;
	const qs = reg.projectId ? `?projectId=${encodeURIComponent(reg.projectId)}` : "";
	const p: Promise<PackPanel | undefined> = (async () => {
		const url = `/api/tools/${encodeURIComponent(reg.tool)}/panel/${encodeURIComponent(panelId)}${qs}`;
		const resp = await gatewayFetch(url); // authed (admin bearer); static-asset-equivalent
		if (!resp.ok) throw new Error(`panel ${panelId} HTTP ${resp.status}`);
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
			if ((loadGeneration.get(panelId) ?? 0) === gen) {
				loadedPanels.set(panelId, panel);
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
			console.error(`[pack-panels] failed to load panel "${panelId}":`, err);
			return undefined;
		})
		.finally(() => {
			// Drop only OUR own in-flight entry (identity-checked — a fresh load
			// started under a bumped generation may have installed a newer promise).
			if (inFlight.get(panelId) === p) inFlight.delete(panelId);
		});
	inFlight.set(panelId, p);
	return p;
}

/**
 * Load + mount a pack panel by id (design §6.3): resolve the registered panel,
 * kick off (or reuse) its lazy module load, and add/focus a side-panel tab
 * carrying the typed `PanelTarget.params`. No-op (with a warn) if no panel is
 * registered for `target.panelId` (e.g. the owning pack was uninstalled).
 */
export function openPackPanel(target: PanelTarget): void {
	const panelId = target?.panelId;
	if (!panelId) return;
	const reg = panels.get(panelId);
	if (!reg) {
		// eslint-disable-next-line no-console
		console.warn(`[pack-panels] openPanel: no registered panel "${panelId}"`);
		return;
	}
	void loadPanelModule(panelId, reg);
	mountPackPanelTab(panelId, reg, target.params);
}

/** Add or focus the side-panel tab for `panelId`, carrying `params`. Best-effort:
 *  guarded so a non-DOM/unit context (no app state) never throws. */
function mountPackPanelTab(panelId: string, reg: RegisteredPanel, params?: Record<string, unknown>): void {
	try {
		const s = state as unknown as { selectedSessionId?: string; remoteAgent?: { gatewaySessionId?: string } };
		const sid = s.selectedSessionId || s.remoteAgent?.gatewaySessionId || undefined;
		const id = packPanelTabId(panelId);
		const title = reg.title || panelId;
		const tab: PanelWorkspaceTab = {
			id,
			kind: "pack",
			title,
			label: title,
			legacyTab: "pack",
			source: { type: "pack", panelId, tool: reg.tool, params, sessionId: sid },
			state: { panelId, params },
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

/** Build the per-session Host API a panel render is handed (design extension-host-
 *  phase2 §2a.2 — panel host-context binding). A panel has no tool call, so it binds
 *  `{ sessionId, toolUseId: undefined, packTool }` from the OPENING context: the active
 *  session supplies `sessionId`; the registered DECLARING tool of the panel is the
 *  `packTool` the server resolves the trusted packId from on each scoped call. Returns
 *  `undefined` when there is no registered panel or no active session (non-DOM/unit) —
 *  the panel must tolerate that (it simply cannot reach scoped capabilities yet). */
function hostForPanel(panelId: string): HostApi | undefined {
	const reg = panels.get(panelId);
	if (!reg) return undefined;
	try {
		const s = state as unknown as { selectedSessionId?: string; remoteAgent?: { gatewaySessionId?: string } };
		const sid = s.selectedSessionId || s.remoteAgent?.gatewaySessionId || undefined;
		if (!sid) return undefined;
		return getHostApi(sid, undefined, reg.tool);
	} catch {
		return undefined;
	}
}

/** Remove the side-panel tab of an uninstalled panel from every session that has
 *  it open (reconcile-on-uninstall). Best-effort + guarded. */
function removePackPanelTab(panelId: string): void {
	try {
		const id = packPanelTabId(panelId);
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
 * layer). Returns the loaded panel's `render(params)` projection, or a standard
 * loading placeholder until the lazy module resolves (the load is kicked off by
 * `openPackPanel`; this never starts one, keeping render pure). A panel that is
 * no longer registered (uninstalled) renders nothing.
 */
export function renderPackPanelContent(panelId: string, params?: Record<string, unknown>): TemplateResult | unknown {
	const panel = loadedPanels.get(panelId);
	if (panel) {
		try {
			// Build a session-bound host for this pack tool (design §2a.2) so the
			// panel can rehydrate from `host.store.*` etc. `getHostApi` is supplied via
			// the injected factory (host-api self-registers) to avoid an import cycle;
			// when unset (unit fixtures) the panel renders with host === undefined.
			const reg = panels.get(panelId);
			const host = panelHostFactory && reg
				? panelHostFactory(currentSessionIdForPanel(), reg.tool)
				: undefined;
			return panel.render(params, host);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error(`[pack-panels] render failed for "${panelId}":`, err);
			return renderHeader("error", null, html`<span class="font-mono">${panelId}</span> — panel failed to render`);
		}
	}
	if (!panels.has(panelId)) return nothing;
	return html`
		<div class="p-4 text-sm text-muted-foreground" data-pack-panel-loading=${panelId}>
			Loading ${panelId}…
		</div>
	`;
}
