// src/server/routes/extension-host-ui-routes.ts
//
// STR-01 cohort 28: pack UI/contribution discovery routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx and registry params
// replacing regex captures.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import fs from "node:fs";
import path from "node:path";

import { resolveActionToolManager } from "../extension-host/action-dispatcher.js";
import { isPackPathWithinRoot } from "../extension-host/path-guard.js";
import { mintSettingsSectionToken } from "../extension-host/settings-section-preferences.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// GET /api/tools/:tool/renderer — serve a PACK tool's pre-built ESM renderer
// module bytes (design docs/design/extension-host.md §4a). Admin-bearer ONLY
// (enforced before handleApiRoute): serving the module bytes is a static-asset-
// equivalent, NOT a capability invocation, so there is deliberately NO
// allowedTools check here (that gate is on the ACTION endpoint below). The
// renderer file path is re-validated to stay within the tool's group dir.
async function handleToolRendererGet(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, resolveRequiredConfigProjectScope, res, toolManager, url, writeConfigProjectScopeError } = ctx;
	const tool = decodeURIComponent(params.tool);
	// Require the same explicit config project scope as GET /api/tools. Headquarters
	// aliases the server/global layer; unknown normal projects fail before any
	// server-scope fallback can leak a different pack renderer.
	const rendererScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
	if (!rendererScope.ok) { writeConfigProjectScopeError(rendererScope); return; }
	const rendererTm = resolveActionToolManager(
		toolManager,
		rendererScope.context?.toolManager,
	);
	// Resolve the WINNING tool's on-disk location independent of `provider:`
	// (design §4b — a pack renderer needs no provider). resolveToolLocation
	// honors the same pack precedence as every other tool resolution.
	const loc = rendererTm.resolveToolLocation(tool);
	if (!loc || loc.rendererKind !== "pack" || !loc.rendererFile || !loc.baseDir) {
		json({ error: "no pack renderer for this tool" }, 404);
		return;
	}
	// The renderer resolves RELATIVE to the tool YAML's dir, but containment is
	// against the PACK ROOT (pack-schema-v1 §6.2), so `renderer: ../../lib/X.js`
	// serves while an out-of-pack path is rejected.
	const groupAbs = path.join(loc.baseDir, loc.groupDir || "");
	const packRoot = path.dirname(loc.baseDir);
	const fileAbs = path.resolve(groupAbs, loc.rendererFile);
	if (!isPackPathWithinRoot(packRoot, fileAbs)) {
		json({ error: "invalid renderer path" }, 404);
		return;
	}
	let source: string;
	try {
		source = fs.readFileSync(fileAbs, "utf-8");
	} catch {
		json({ error: "renderer module not found" }, 404);
		return;
	}
	res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
	res.end(source);
	return;
}

// GET /api/ext/packs/:packId/panels/:panelId?projectId= — serve a PACK's
// pre-built ESM side-panel module bytes (pack-schema-v1 §6.3). Panels are
// pack-addressed (panel ids are only pack-unique), NOT tool-keyed. Admin-bearer
// ONLY / static-asset-equivalent — NO allowedTools check (serving bytes is not a
// capability invocation, same as the renderer endpoint). The panel `entry`
// resolves relative to its declaring panels/<file>.yaml and is re-validated to
// stay within the pack root.
async function handleExtPackPanelGet(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, packContributionRegistry, resolveRequiredConfigProjectScope, res, url, writeConfigProjectScopeError } = ctx;
	const packId = decodeURIComponent(params.packId);
	const panelId = decodeURIComponent(params.panelId);
	const panelScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
	if (!panelScope.ok) { writeConfigProjectScopeError(panelScope); return; }
	const panel = packContributionRegistry.getPanel(panelScope.effectiveProjectId, packId, panelId);
	if (!panel) {
		json({ error: "no such panel in this pack" }, 404);
		return;
	}
	const fileAbs = path.resolve(path.dirname(panel.sourceFile), panel.entry);
	if (!isPackPathWithinRoot(panel.packRoot, fileAbs)) {
		json({ error: "invalid panel path" }, 404);
		return;
	}
	let source: string;
	try {
		source = fs.readFileSync(fileAbs, "utf-8");
	} catch {
		json({ error: "panel module not found" }, 404);
		return;
	}
	res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
	res.end(source);
	return;
}

// GET /api/ext/packs/:packId/settings-sections/:sectionId?projectId= — serve a
// PACK's pre-built ESM Settings-section module bytes (docs/design/
// pack-settings-contribution.md §4.2). Mirrors the panel-serving route above
// byte-for-byte: admin-bearer ONLY / static-asset-equivalent, no allowedTools
// check (serving bytes is not a capability invocation), entry re-validated to
// stay within the pack root.
async function handleExtPackSettingsSectionGet(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, packContributionRegistry, resolveRequiredConfigProjectScope, res, url, writeConfigProjectScopeError } = ctx;
	const packId = decodeURIComponent(params.packId);
	const sectionId = decodeURIComponent(params.sectionId);
	const sectionScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
	if (!sectionScope.ok) { writeConfigProjectScopeError(sectionScope); return; }
	const section = packContributionRegistry.getSettingsSection(sectionScope.effectiveProjectId, packId, sectionId);
	if (!section) {
		json({ error: "no such settings section in this pack" }, 404);
		return;
	}
	const fileAbs = path.resolve(path.dirname(section.sourceFile), section.entry);
	if (!isPackPathWithinRoot(section.packRoot, fileAbs)) {
		json({ error: "invalid settings section path" }, 404);
		return;
	}
	let source: string;
	try {
		source = fs.readFileSync(fileAbs, "utf-8");
	} catch {
		json({ error: "settings section module not found" }, 404);
		return;
	}
	res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
	res.end(source);
	return;
}

// POST /api/ext/packs/:packId/settings-sections/:sectionId/surface-token —
// mint a SESSION-LESS pack-bound surface token for a settings section's
// `SettingsHostApi` (docs/design/pack-settings-contribution.md §4.3). No
// session/toolUseId identity exists for this surface (unlike
// `/api/ext/surface-token`); the token binds only `{packId, sectionId}` and is
// re-checked against the LIVE registry on every guarded preference write
// (`guardPackAttributedPreferenceWrite`), never trusted for what it may write.
async function handleExtPackSettingsSectionSurfaceTokenPost(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, packContributionRegistry } = ctx;
	const packId = decodeURIComponent(params.packId);
	const sectionId = decodeURIComponent(params.sectionId);
	const section = packContributionRegistry.getSettingsSection(undefined, packId, sectionId);
	if (!section) {
		json({ error: "no such settings section in this pack" }, 404);
		return;
	}
	json({ token: mintSettingsSectionToken(packId, sectionId) });
	return;
}

// GET /api/ext/contributions?projectId= — project-scoped pack-contribution
// metadata for the client registries (pack-schema-v1 §6.4). Activation filtering
// is already applied by the registry (disabled entrypoints omitted). EVERY
// installed + active pack emits a row (empty arrays allowed) — the frozen
// always-emit contract so the client reconcile is deterministic.
async function handleExtContributionsGet(ctx: CoreRouteCtx): Promise<void> {
	const { json, packContributionRegistry, resolveRequiredConfigProjectScope, url, writeConfigProjectScopeError } = ctx;
	const contribScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
	if (!contribScope.ok) { writeConfigProjectScopeError(contribScope); return; }
	const packs = packContributionRegistry.list(contribScope.effectiveProjectId).map((p) => ({
		packId: p.packId,
		packName: p.packName,
		panels: p.panels.map((panel) => {
			const out: Record<string, unknown> = { id: panel.id };
			if (panel.title !== undefined) out.title = panel.title;
			if (panel.instanceMode !== undefined) out.instanceMode = panel.instanceMode;
			if (panel.instanceParam !== undefined) out.instanceParam = panel.instanceParam;
			return out;
		}),
		// settingsSections: additive per docs/marketplace.md's forward-compat
		// convention (mirrors how panels[] was added to this wire shape).
		// `preferenceKeys` is intentionally OMITTED from the wire payload — the
		// client never needs (and must never trust) the allowlist; the server
		// re-resolves it live from the registry on every guarded write.
		settingsSections: p.settingsSections.map((section) => {
			const out: Record<string, unknown> = { id: section.id, tab: section.tab, order: section.order };
			if (section.title !== undefined) out.title = section.title;
			return out;
		}),
		entrypoints: p.entrypoints.map((e) => {
			const out: Record<string, unknown> = { id: e.id, kind: e.kind, listName: e.listName };
			if (e.label !== undefined) out.label = e.label;
			if (e.icon !== undefined) out.icon = e.icon;
			if (e.routeId !== undefined) out.routeId = e.routeId;
			if (e.target !== undefined) out.target = e.target;
			if (e.paramKeys !== undefined) out.paramKeys = e.paramKeys;
			return out;
		}),
		routeNames: p.routes?.names ?? [],
	}));
	json({ packs });
	return;
}

export function registerExtensionHostUiRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/tools/:tool/renderer", handleToolRendererGet);
	table.register("GET", "/api/ext/packs/:packId/panels/:panelId", handleExtPackPanelGet);
	table.register("GET", "/api/ext/packs/:packId/settings-sections/:sectionId", handleExtPackSettingsSectionGet);
	table.register("POST", "/api/ext/packs/:packId/settings-sections/:sectionId/surface-token", handleExtPackSettingsSectionSurfaceTokenPost);
	table.register("GET", "/api/ext/contributions", handleExtContributionsGet);
}
