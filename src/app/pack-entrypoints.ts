// src/app/pack-entrypoints.ts
//
// CLIENT registry of pack-contributed ENTRYPOINTS — launcher surfaces
// (composer slash-command / git-widget button / command-palette launcher) AND
// deep-linkable client ROUTES (pack schema V1 §8.2; design
// docs/design/pack-schema-v1-rationalisation.md). Entrypoints are now
// PACK-scoped — each registered launcher/route carries the owning `packId`
// (used to mint the pack-bound surface token + address panel bytes), not a
// carrier tool.
//
// This MIRRORS `pack-renderers.ts` / `pack-panels.ts` + the
// `renderer-registry.ts` generation-guarded chokepoint — it does NOT fork it.
// It copies the `applyRegistration` contract (capture generation before any
// await, drop superseded applies, reconcile-on-uninstall, project-scoped,
// reload-safe) into TWO of its own maps: a launcher map (keyed by entrypoint id)
// and a deep-link route map (keyed by `routeId`). The route map is the
// reload-safe surface `getRouteFromHash` (routing.ts) restores `#/ext/<routeId>`
// against; `navigateToTarget` serializes a structured `RouteTarget` onto it so
// packs NEVER build URLs (v1 §3 structured addressing).
//
// On cold load (and after a marketplace install/uninstall re-fetches
// /api/ext/contributions) the UI calls `reconcilePackEntrypointsForProject(projectId)`.
// For every pack contribution row it (re-)registers each launcher + route; an
// uninstall (or precedence change) that drops an entrypoint removes it here so a
// later launch / deep-link no-ops (reconcile-on-uninstall — a deep-link to an
// uninstalled pack's route no longer resolves, mirroring panel/renderer
// uninstall reconcile).
//
// Duplicate `routeId` across packs is REJECTED at registry-build time
// (the rare real-conflict failure — at most ONE pack owns a `routeId`, so
// `lookupPackRoute` is unambiguous).

import { fetchContributions, type PackContributionsWire } from "./api.js";
import { setExtRoute } from "./routing.js";
import { openPackPanel } from "./pack-panels.js";
import type { PanelTarget, RouteTarget } from "../shared/extension-host/host-api.js";

/** Launcher kinds (a clickable surface) PLUS the routable `route` kind (a
 *  deep-linkable client route with NO clickable surface). */
export type EntrypointKind = "composer-slash" | "git-widget-button" | "command-palette" | "route";

/** The launcher kinds — those that render a clickable surface. */
export type LauncherKind = "composer-slash" | "git-widget-button" | "command-palette";

/** A launcher entrypoint: click → openPanel/navigate. NO auto-invoke on mount —
 *  invocation is the user gesture (design §7 C1.3, v1 §5 v). */
export interface LauncherEntrypoint {
	id: string;
	packId: string;
	kind: LauncherKind;
	label: string;
	target: PanelTarget | RouteTarget;
}

/** A deep-linkable client route: maps a `routeId` → the panel it opens + the
 *  param names carried in the URL. No clickable surface; consumed by
 *  `navigateToTarget` + reload restoration (design §7 C1.1a). */
export interface RouteEntrypoint {
	id: string;
	packId: string;
	kind: "route";
	routeId: string;
	target: PanelTarget;
	paramKeys: string[];
}

export type EntrypointInfo = LauncherEntrypoint | RouteEntrypoint;

/** A resolved deep-link route entry (the value `lookupPackRoute` returns). The
 *  target panel is resolved within the SAME pack, so `packId` threads into
 *  `openPackPanel` on restore. */
export interface PackRouteEntry {
	routeId: string;
	targetPanelId: string;
	paramKeys: string[];
	packId: string;
	projectId?: string;
}

/** A registered launcher (the owning pack + project, so reconcile can drop a
 *  pack's launchers precisely). */
interface RegisteredLauncher {
	id: string;
	packId: string;
	kind: LauncherKind;
	label: string;
	target: PanelTarget | RouteTarget;
	projectId?: string;
}

/** entrypoint id → launcher. Reconciled from /api/ext/contributions metadata. */
const launchers = new Map<string, RegisteredLauncher>();
/** routeId → deep-link route entry (at most ONE pack owns a routeId). */
const routes = new Map<string, PackRouteEntry>();

function isRouteEntrypoint(ep: EntrypointInfo): ep is RouteEntrypoint {
	return ep.kind === "route";
}

/** A target is a PanelTarget IFF it carries a `panelId`; otherwise a RouteTarget. */
function isPanelTarget(t: PanelTarget | RouteTarget | undefined): t is PanelTarget {
	return !!t && typeof (t as PanelTarget).panelId === "string";
}

/**
 * Idempotent + reconciling registration, re-driven from /api/ext/contributions
 * metadata — byte-for-byte the {@link reconcilePackEntrypointsForProject} →
 * registerPackEntrypoints shape of `pack-renderers.ts` / `pack-panels.ts`.
 * Replaces both registries with the fresh set; an entrypoint that disappeared
 * (uninstall / precedence change) is dropped so a later launch / deep-link no-ops.
 *
 * Duplicate `routeId` (two packs claiming the same id) is REJECTED here — the
 * conflicting routeId is registered by NEITHER (so `lookupPackRoute` stays
 * unambiguous) and a clear error names the conflict.
 */
export function registerPackEntrypoints(eps: ReadonlyArray<EntrypointInfo>, projectId?: string): void {
	const nextLaunchers = new Map<string, RegisteredLauncher>();
	const nextRoutes = new Map<string, PackRouteEntry>();
	// Track routeIds seen so a duplicate (even across packs) is rejected.
	const routeOwners = new Map<string, string>(); // routeId → "packId" first claimant
	const conflictedRouteIds = new Set<string>();

	for (const ep of eps) {
		if (!ep || typeof ep.id !== "string" || !ep.id || typeof ep.packId !== "string" || !ep.packId) continue;
		if (isRouteEntrypoint(ep)) {
			const routeId = ep.routeId;
			const panelId = ep.target?.panelId;
			if (typeof routeId !== "string" || !routeId || typeof panelId !== "string" || !panelId) continue;
			const prevOwner = routeOwners.get(routeId);
			if (prevOwner !== undefined && prevOwner !== ep.packId) {
				// Duplicate routeId across DIFFERENT packs — hard conflict.
				// eslint-disable-next-line no-console
				console.error(
					`[pack-entrypoints] duplicate routeId "${routeId}" declared by both "${prevOwner}" and "${ep.packId}" — registering NEITHER`,
				);
				conflictedRouteIds.add(routeId);
				nextRoutes.delete(routeId);
				continue;
			}
			routeOwners.set(routeId, ep.packId);
			if (conflictedRouteIds.has(routeId)) continue;
			const paramKeys = Array.isArray(ep.paramKeys) ? ep.paramKeys.filter((k): k is string => typeof k === "string") : [];
			nextRoutes.set(routeId, { routeId, targetPanelId: panelId, paramKeys, packId: ep.packId, projectId });
		} else {
			if (ep.kind !== "composer-slash" && ep.kind !== "git-widget-button" && ep.kind !== "command-palette") continue;
			if (typeof ep.label !== "string" || !ep.label) continue;
			if (!isPanelTarget(ep.target) && !(ep.target && typeof (ep.target as RouteTarget).route === "string")) continue;
			nextLaunchers.set(ep.id, {
				id: ep.id,
				packId: ep.packId,
				kind: ep.kind,
				label: ep.label,
				target: ep.target,
				projectId,
			});
		}
	}

	launchers.clear();
	for (const [k, v] of nextLaunchers) launchers.set(k, v);
	routes.clear();
	for (const [k, v] of nextRoutes) routes.set(k, v);
}

/** Resolve a deep-link `routeId` → its registered route entry, or undefined when
 *  no (installed) pack owns it (mirrors `pack-panels` openPackPanel no-op on an
 *  uninstalled panel). The reload-restoration + `navigate` resolution chokepoint. */
export function lookupPackRoute(routeId: string): PackRouteEntry | undefined {
	return routes.get(routeId);
}

/** Enumerate the registered LAUNCHER entrypoints (optionally filtered by kind),
 *  for the host surfaces (composer slash list, git-widget, command palette) to
 *  render. Routes are NOT launchers and are never returned here. */
export function listLauncherEntrypoints(kind?: LauncherKind): RegisteredLauncher[] {
	const out: RegisteredLauncher[] = [];
	for (const l of launchers.values()) {
		if (kind && l.kind !== kind) continue;
		out.push(l);
	}
	return out;
}

/**
 * Run a launcher entrypoint's target (design §7 C1.3). This is the SINGLE
 * dispatch chokepoint a surface calls on a genuine user click — a PanelTarget
 * opens its panel (PACK-RELATIVE, resolved against the launcher's own packId); a
 * RouteTarget navigates (deep-link). NEVER call this on mount; invocation is the
 * user gesture (v1 §5 v). A no-op for an unknown id.
 */
export function runLauncherEntrypoint(id: string): void {
	const l = launchers.get(id);
	if (!l) {
		// eslint-disable-next-line no-console
		console.warn(`[pack-entrypoints] runLauncherEntrypoint: no launcher "${id}"`);
		return;
	}
	if (isPanelTarget(l.target)) {
		openPackPanel(l.target, l.packId);
	} else {
		navigateToTarget(l.target as RouteTarget);
	}
}

/**
 * Map a structured `RouteTarget` → the SPA router's `#/ext/<routeId>?<params>`
 * hash scheme (design §7 C1.2). The pack passes ONLY a structured target; this
 * looks the `route` up in the registry, filters `params` to the registered
 * `paramKeys`, and hands the encoding to `routing.ts::setExtRoute` — the pack
 * never constructs a URL. An unknown `route` (e.g. owning pack uninstalled) is a
 * no-op (no crash, no raw URL).
 */
export function navigateToTarget(target: RouteTarget): void {
	const routeId = target?.route;
	if (typeof routeId !== "string" || !routeId) return;
	const entry = routes.get(routeId);
	if (!entry) {
		// eslint-disable-next-line no-console
		console.warn(`[pack-entrypoints] navigate: no registered route "${routeId}"`);
		return;
	}
	const filtered: Record<string, unknown> = {};
	if (target.params) {
		for (const key of entry.paramKeys) {
			if (key in target.params) filtered[key] = target.params[key];
		}
	}
	setExtRoute(routeId, filtered);
}

/** Flatten the `entrypoints[]` of each pack contribution row into EntrypointInfo[]
 *  (the owning packId scopes ownership for reconcile + identity). Exported so the
 *  marketplace mutation path can force a re-register from freshly fetched metadata
 *  (bypassing the dedupe guard), mirroring `pack-panels`. */
export function entrypointInfosFromContributions(packs: ReadonlyArray<PackContributionsWire>): EntrypointInfo[] {
	const out: EntrypointInfo[] = [];
	for (const p of packs) {
		const packId = typeof p?.packId === "string" ? p.packId : undefined;
		if (!packId || !Array.isArray(p.entrypoints)) continue;
		for (const e of p.entrypoints) {
			if (!e || typeof e !== "object") continue;
			const id = typeof e.id === "string" ? e.id : undefined;
			const kind = typeof e.kind === "string" ? e.kind : undefined;
			if (!id || !kind) continue;
			if (kind === "route") {
				const routeId = typeof e.routeId === "string" ? e.routeId : undefined;
				const target = e.target as PanelTarget | undefined;
				const panelId = target && typeof target.panelId === "string" ? target.panelId : undefined;
				if (!routeId || !panelId) continue;
				const paramKeys = Array.isArray(e.paramKeys)
					? (e.paramKeys.filter((k): k is string => typeof k === "string"))
					: [];
				out.push({ id, packId, kind: "route", routeId, target: { panelId, params: target?.params }, paramKeys });
			} else if (kind === "composer-slash" || kind === "git-widget-button" || kind === "command-palette") {
				const label = typeof e.label === "string" ? e.label : undefined;
				const target = e.target as PanelTarget | RouteTarget | undefined;
				if (!label || !target) continue;
				out.push({ id, packId, kind, label, target });
			}
		}
	}
	return out;
}

/** Sentinel: no reconcile has run yet (distinct from `undefined` = reconciled for
 *  the global/no-project scope) so the first global-scope reconcile still fires. */
const UNRECONCILED = Symbol("unreconciled");
/** The project id of the last SUCCESSFULLY-APPLIED, non-superseded reconcile (or
 *  {@link UNRECONCILED} before any). Cheap dedupe guard, set AFTER a successful
 *  apply so a failed/superseded attempt does not poison it. */
let lastReconciledProject: string | undefined | typeof UNRECONCILED = UNRECONCILED;
/** Monotonic generation token: a newer reconcile supersedes an older one whose
 *  `await fetchContributions` is still in flight, so an out-of-order late response
 *  cannot clobber the registry. Mirrors `pack-panels.ts` / `pack-renderers.ts`. */
let reconcileGeneration = 0;

/**
 * Re-drive pack-entrypoint registration for `projectId`: fetch the pack-contribution
 * metadata scoped to that project and (re-)register every declared entrypoint +
 * route with the CURRENT project id. Mirrors `reconcilePackPanelsForProject`
 * exactly — same dedupe guard, generation guard, and fire-and-forget try/catch
 * (never blocks a session switch; built-in surfaces are unaffected on failure).
 */
export async function reconcilePackEntrypointsForProject(projectId: string | undefined): Promise<void> {
	if (lastReconciledProject !== UNRECONCILED && lastReconciledProject === projectId) return;
	const gen = ++reconcileGeneration;
	try {
		const packs = await fetchContributions(projectId);
		// A newer reconcile started while our fetch was in flight — it owns the
		// registry + dedupe now. Drop this stale response.
		if (gen !== reconcileGeneration) return;
		registerPackEntrypoints(entrypointInfosFromContributions(packs), projectId);
		lastReconciledProject = projectId;
	} catch {
		// Non-fatal — leave lastReconciledProject untouched so a later call retries.
	}
}
