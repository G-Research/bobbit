// src/server/routes/tools-routes.ts
//
// STR-01 cohort 29: tools metadata/customization routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx and registry params
// replacing regex captures.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. The legacy
// /api/tools/:name block branched by method and returned only for GET/PUT;
// customize/override gated on path and method in the same `if` condition.
// RouteTable's method-scoped matching preserves that by leaving other methods
// unregistered.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bobbitConfigDir } from "../bobbit-dir.js";
import { normalizeConfigProjectId } from "../agent/config-cascade.js";
import { HEADQUARTERS_PROJECT_ID } from "../agent/project-registry.js";
import { copyDirRecursive, ToolManager, type ScopedToolContext } from "../agent/tool-manager.js";
import type { PiExtensionDiagnostic, ResolvedPiExtensionContribution } from "../agent/session-setup.js";
import { resolveActionToolManager } from "../extension-host/action-dispatcher.js";
import { resolvePackIdentityForTool } from "../extension-host/pack-identity.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

function withOrigin(r: { item: Record<string, unknown>; origin: unknown; overrides?: unknown; originPackId?: string | null; originPackName?: string | null }): Record<string, unknown> {
	return {
		...r.item,
		origin: r.origin,
		...(r.overrides ? { overrides: r.overrides } : {}),
		// Always emit originPackId/originPackName (null for builtin/user entities)
		// so roles/tools match the skills wire shape (finding #3).
		originPackId: r.originPackId ?? null,
		originPackName: r.originPackName ?? null,
	};
}

function piExtensionDiagnostic(status: PiExtensionDiagnostic["status"], code: string, message: string): PiExtensionDiagnostic {
	return { status, code, message, updatedAt: new Date().toISOString() };
}

function annotatePiExtensionToolNameCollisions(contributions: readonly ResolvedPiExtensionContribution[]): void {
	const byName = new Map<string, ResolvedPiExtensionContribution[]>();
	for (const contribution of contributions) {
		if (contribution.diagnostic.status === "disabled" || contribution.diagnostic.status === "unresolved") continue;
		for (const tool of contribution.discovery?.tools ?? []) {
			if (!tool.name) continue;
			const providers = byName.get(tool.name) ?? [];
			providers.push(contribution);
			byName.set(tool.name, providers);
		}
	}
	for (const [name, providers] of byName) {
		const unique = new Set(providers.map((provider) => `${provider.origin.scope}:${provider.origin.packId}:${provider.listName}`));
		if (unique.size < 2) continue;
		for (const contribution of providers) {
			if (contribution.diagnostic.status !== "ok") continue;
			contribution.diagnostic = piExtensionDiagnostic("ok", "tool_name_collision", `Multiple pi extensions expose runtime tool name "${name}" in this scope; one name-based policy applies to all providers.`);
		}
	}
}

function buildPiExtensionToolRows(contributions: readonly ResolvedPiExtensionContribution[]): Array<Record<string, unknown>> {
	annotatePiExtensionToolNameCollisions(contributions);
	const byName = new Map<string, Record<string, unknown>>();
	for (const contribution of contributions) {
		if (contribution.diagnostic.status === "disabled" || contribution.diagnostic.status === "unresolved") continue;
		for (const tool of contribution.discovery?.tools ?? []) {
			if (!tool.name) continue;
			const provider = {
				providerKey: `pi-ext:${contribution.origin.scope}:${contribution.origin.packId}:${contribution.listName}:${tool.name}`,
				packName: contribution.origin.packName,
				listName: contribution.listName,
				scope: contribution.origin.scope,
				...(contribution.entryPath ? { sourcePath: contribution.entryPath } : {}),
			};
			const existing = byName.get(tool.name);
			if (existing) {
				(existing.providers as Array<Record<string, unknown>>).push(provider);
				continue;
			}
			byName.set(tool.name, {
				name: tool.name,
				description: tool.description ?? "Pi extension tool",
				inputSchema: tool.inputSchema,
				providerType: "pi-extension",
				origin: "marketplace-pi-extension",
				originPackName: contribution.origin.packName,
				originPackId: contribution.origin.packId,
				group: "Pi Extension",
				readOnly: true,
				...(contribution.entryPath ? { sourcePath: contribution.entryPath } : {}),
				providers: [provider],
			});
		}
	}
	return [...byName.values()];
}

function appendPiExtensionToolRows(tools: Array<Record<string, unknown>>, piRows: readonly Record<string, unknown>[]): void {
	const byName = new Map(tools.map((tool) => [String(tool.name), tool]));
	for (const row of piRows) {
		const name = String(row.name ?? "");
		if (!name) continue;
		const existing = byName.get(name);
		if (!existing) {
			tools.push({ ...row });
			byName.set(name, tools[tools.length - 1]);
			continue;
		}
		const providers = Array.isArray(existing.providers) ? existing.providers : [];
		existing.providers = [...providers, ...((row.providers as Array<Record<string, unknown>> | undefined) ?? [])];
		existing.piExtensionCollision = true;
		existing.piExtensionPolicyScope = "name";
	}
}

function piExtensionToolScopeContext(scope: { projectId?: string; cwd?: string }): ScopedToolContext {
	const projectId = normalizeConfigProjectId(scope.projectId);
	const cwd = scope.projectId === HEADQUARTERS_PROJECT_ID ? undefined : scope.cwd;
	const scopeKey = projectId ? `project:${projectId}` : cwd ? `cwd:${path.resolve(cwd)}` : "default";
	return { ...(projectId ? { projectId } : {}), ...(cwd ? { cwd } : {}), scopeKey };
}

function toolDiagnosticsForProject(ctx: CoreRouteCtx, projectId?: string): Array<Record<string, unknown>> {
	const diagnostics: Array<Record<string, unknown>> = [];
	const seen = new Set<string>();
	const add = (rows: Array<Record<string, unknown>> | undefined): void => {
		for (const row of rows ?? []) {
			const key = `${row.toolName ?? row.tool ?? ""}\0${row.extensionPath ?? row.path ?? ""}\0${row.message ?? ""}`;
			if (seen.has(key)) continue;
			seen.add(key);
			diagnostics.push(row);
		}
	};
	if (ctx.toolManager) add(ctx.toolManager.getToolDiagnostics() as unknown as Array<Record<string, unknown>>);
	if (projectId) add(ctx.projectContextManager.getOrCreate(projectId)?.toolManager.getToolDiagnostics() as unknown as Array<Record<string, unknown>> | undefined);
	return diagnostics;
}

function attachToolDiagnostics(tools: Array<Record<string, unknown>>, diagnostics: Array<Record<string, unknown>>): void {
	if (diagnostics.length === 0) return;
	for (const tool of tools) {
		const name = typeof tool.name === "string" ? tool.name : undefined;
		if (!name) continue;
		const related = diagnostics.filter((diagnostic) => diagnostic.toolName === name || diagnostic.tool === name || diagnostic.name === name);
		if (related.length > 0) tool.diagnostics = related;
	}
}

function runtimeBuiltinToolsDir(): string {
	const moduleDefaults = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "defaults", "tools");
	if (fs.existsSync(moduleDefaults)) return moduleDefaults;
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "defaults", "tools");
}

function fallbackToolManagerForConfig(configDirForScope: string): ToolManager | null {
	const builtinToolsDir = runtimeBuiltinToolsDir();
	if (!fs.existsSync(builtinToolsDir)) return null;
	return new ToolManager(configDirForScope, builtinToolsDir);
}

// Shared helper: find which group subdirectory contains a tool by scanning YAML files.
function findToolGroupDir(toolName: string, toolsDir: string): string | null {
	try {
		const entries = fs.readdirSync(toolsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const groupPath = path.join(toolsDir, entry.name);
			try {
				const files = fs.readdirSync(groupPath);
				for (const file of files) {
					if (!file.endsWith(".yaml")) continue;
					try {
						const raw = fs.readFileSync(path.join(groupPath, file), "utf-8");
						// Quick check without full YAML parse
						if (raw.includes(`name: ${toolName}`) || raw.includes(`name: "${toolName}"`)) {
							// Verify with proper field check
							const lines = raw.split("\n");
							for (const line of lines) {
								const m = line.match(/^name:\s*"?([^"\n]+)"?\s*$/);
								if (m && m[1].trim() === toolName) return entry.name;
							}
						}
					} catch { /* skip unreadable */ }
				}
			} catch { /* skip */ }
		}
	} catch { /* dir doesn't exist */ }
	return null;
}

// GET /api/tools — list available agent tools (with cascade origin)
async function handleToolsGet(ctx: CoreRouteCtx): Promise<void> {
	const { configCascade, json, resolveRequiredConfigProjectScope, sessionManager, toolManager, url, writeConfigProjectScopeError } = ctx;
	// Require an explicit projectId. First-party UI/test helpers pass
	// `headquarters` for the server scope; normalize it before any downstream
	// config/toolManager/marketplace lookup so the synthetic HQ id never leaks
	// into project-context calls.
	const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
	if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
	const effectiveConfigProjectId = projectScope.effectiveProjectId;
	const resolved = configCascade.resolveTools(effectiveConfigProjectId);
	// pack-schema-v1: expose each market-pack tool's STRUCTURAL packId (the
	// `market-packs/<name>` dir segment via the same `resolvePackIdentityForTool`
	// the renderer/action endpoints + /api/ext/contributions use) so a tool
	// renderer's `host.ui.openPanel({panelId})` resolves the panel WITHIN its own
	// pack (panel ids are pack-local) via /api/ext/packs/:packId/panels/:panelId.
	// Empty/absent for builtins. Tool-scoped origin identity only — NOT a
	// pack-scoped contribution field.
	const toolPackTm = resolveActionToolManager(
		toolManager,
		projectScope.context?.toolManager,
	);
	const tools: Array<Record<string, unknown>> = resolved.map(r => {
		const out = withOrigin(r as any);
		if (r.originPackId && toolPackTm) {
			const packId = resolvePackIdentityForTool(toolPackTm, r.item.name).packId;
			if (packId) out.packId = packId;
		}
		return out;
	});
	// Include MCP/external tools not covered by the config cascade
	if (toolManager) {
		const resolvedNames = new Set(resolved.map(r => r.item.name));
		for (const t of toolManager.getAvailableTools(piExtensionToolScopeContext({ projectId: effectiveConfigProjectId }))) {
			if (!resolvedNames.has(t.name)) {
				tools.push({ ...t, origin: t.origin ?? "mcp" });
			}
		}
	}
	appendPiExtensionToolRows(tools, buildPiExtensionToolRows(sessionManager.resolveMarketplacePiExtensionContributions(effectiveConfigProjectId)));
	const toolDiagnostics = toolDiagnosticsForProject(ctx, effectiveConfigProjectId);
	attachToolDiagnostics(tools, toolDiagnostics);
	json({ tools, diagnostics: toolDiagnostics, toolDiagnostics });
	return;
}

// Routes with tool :name parameter
// GET /api/tools/:name
async function handleToolGet(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { configCascade, json, resolveRequiredConfigProjectScope, sessionManager, toolManager, url, writeConfigProjectScopeError } = ctx;
	const name = decodeURIComponent(params.name);
	// Resolve via the selected project's toolManager so project-scope
	// market-pack tools are visible. Headquarters normalizes to the
	// server/global scope; missing or unknown projectId never falls back.
	const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
	if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
	const effectiveConfigProjectId = projectScope.effectiveProjectId;
	const tm = resolveActionToolManager(toolManager, projectScope.context?.toolManager);
	const fallbackTm = fallbackToolManagerForConfig(projectScope.context?.configDir ?? bobbitConfigDir());
	const piRows = buildPiExtensionToolRows(sessionManager.resolveMarketplacePiExtensionContributions(effectiveConfigProjectId));
	const piTool = piRows.find((row) => row.name === name);
	const tool = tm.getToolByName(name) ?? fallbackTm?.getToolByName(name);
	if (!tool && !piTool) { json({ error: "Tool not found" }, 404); return; }
	// Merge in cascade origin metadata so the detail payload carries the same
	// origin/originPackId/originPackName the LIST endpoint emits (finding #1).
	// Without this, the tools edit page replaces the cascade list item with the
	// raw detail and a market-pack tool loses its origin badge + read-only state.
	const cascadeEntry = configCascade.resolveTools(effectiveConfigProjectId).find(r => r.item.name === name);
	const toolDiagnostics = toolDiagnosticsForProject(ctx, effectiveConfigProjectId);
	if (cascadeEntry && tool) {
		const withMeta = withOrigin(cascadeEntry as any);
		// pack-schema-v1: mirror the LIST endpoint's structural packId so the
		// tools edit page keeps the same own-pack identity for a market-pack tool.
		const packId = cascadeEntry.originPackId ? resolvePackIdentityForTool(tm, name).packId : "";
		const detail: Record<string, unknown> = { ...tool, origin: withMeta.origin, ...(withMeta.overrides ? { overrides: withMeta.overrides } : {}), originPackId: withMeta.originPackId, originPackName: withMeta.originPackName, ...(packId ? { packId } : {}) };
		if (piTool) appendPiExtensionToolRows([detail], [piTool]);
		attachToolDiagnostics([detail], toolDiagnostics);
		json(detail);
	} else if (tool) {
		const detail: Record<string, unknown> = { ...tool };
		if (piTool) appendPiExtensionToolRows([detail], [piTool]);
		attachToolDiagnostics([detail], toolDiagnostics);
		json(detail);
	} else {
		const detail: Record<string, unknown> = { ...(piTool as Record<string, unknown>) };
		attachToolDiagnostics([detail], toolDiagnostics);
		json(detail);
	}
	return;
}

// PUT /api/tools/:name
async function handleToolPut(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, readBody, req, resolveRequiredConfigProjectScope, toolManager, url, writeConfigProjectScopeError } = ctx;
	const name = decodeURIComponent(params.name);
	const body = await readBody(req);
	if (!body) { json({ error: "Missing body" }, 400); return; }
	const projectScope = resolveRequiredConfigProjectScope(body.projectId ?? url.searchParams.get("projectId"));
	if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
	const targetToolManager = projectScope.context?.toolManager ?? toolManager;
	const targetConfigDir = projectScope.context?.configDir ?? bobbitConfigDir();
	const updates = {
		description: body.description,
		group: body.group,
		docs: body.docs,
		detail_docs: body.detail_docs,
		grantPolicy: body.grantPolicy,
	};
	const ok = targetToolManager.updateToolMetadata(name, updates)
		|| (fallbackToolManagerForConfig(targetConfigDir)?.updateToolMetadata(name, updates) ?? false);
	if (!ok) { json({ error: "Tool not found" }, 404); return; }
	json({ ok: true });
	return;
}

// POST /api/tools/:name/customize — copy tool group to a target scope
async function handleToolCustomizePost(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { configCascade, json, projectContextManager, resolveRequiredConfigProjectScope, url, writeConfigProjectScopeError } = ctx;
	const name = decodeURIComponent(params.name);
	const scope = url.searchParams.get("scope") || "server";
	const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"), { aliasSystem: true });
	if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
	const projectId = projectScope.effectiveProjectId;

	// Find the tool in the cascade to get its origin
	const resolved = configCascade.resolveTools(projectId);
	const source = resolved.find(r => r.item.name === name);
	if (!source) { json({ error: "Tool not found" }, 404); return; }

	// Find the groupDir by scanning tool directories to locate this tool's YAML
	const builtinToolsDir = runtimeBuiltinToolsDir();
	const serverToolsDir = path.join(bobbitConfigDir(), "tools");

	// Find groupDir from the source layer
	let groupDir: string | null = null;
	let sourceToolsDir: string;
	if (source.origin === "builtin") {
		sourceToolsDir = builtinToolsDir;
		groupDir = findToolGroupDir(name, builtinToolsDir);
	} else if (source.origin === "project" && projectId) {
		const ctx = projectContextManager.getOrCreate(projectId);
		sourceToolsDir = ctx ? path.join(ctx.configDir, "tools") : serverToolsDir;
		groupDir = findToolGroupDir(name, sourceToolsDir);
	} else {
		sourceToolsDir = serverToolsDir;
		groupDir = findToolGroupDir(name, serverToolsDir);
	}
	// Fallback: try all layers
	if (!groupDir) groupDir = findToolGroupDir(name, builtinToolsDir) || findToolGroupDir(name, serverToolsDir);
	if (!groupDir) { json({ error: "Could not determine tool group directory" }, 400); return; }

	// Determine target directory
	let targetToolsDir: string;
	if (scope === "project" && projectId) {
		const ctx = projectContextManager.getOrCreate(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		targetToolsDir = path.join(ctx.configDir, "tools");
	} else {
		targetToolsDir = serverToolsDir;
	}

	// Determine the actual source dir for copying
	let actualSourceDir = sourceToolsDir;
	// If the source layer doesn't have this group, try builtins then server
	if (!fs.existsSync(path.join(actualSourceDir, groupDir))) {
		if (fs.existsSync(path.join(builtinToolsDir, groupDir))) actualSourceDir = builtinToolsDir;
		else if (fs.existsSync(path.join(serverToolsDir, groupDir))) actualSourceDir = serverToolsDir;
	}

	const srcDir = path.join(actualSourceDir, groupDir);
	const destDir = path.join(targetToolsDir, groupDir);

	if (!fs.existsSync(srcDir)) { json({ error: "Source tool group not found" }, 404); return; }

	// Copy entire group directory (recursively handles nested files)
	copyDirRecursive(srcDir, destDir);

	json({ ok: true, groupDir }, 201);
	return;
}

// DELETE /api/tools/:name/override — remove tool group override at a scope
async function handleToolOverrideDelete(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, projectContextManager, resolveRequiredConfigProjectScope, url, writeConfigProjectScopeError } = ctx;
	const name = decodeURIComponent(params.name);
	const scope = url.searchParams.get("scope") || "server";
	const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"), { aliasSystem: true });
	if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
	const projectId = projectScope.effectiveProjectId;

	// Determine the tools directory for the target scope
	let targetToolsDir: string;
	if (scope === "project" && projectId) {
		const ctx = projectContextManager.getOrCreate(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		targetToolsDir = path.join(ctx.configDir, "tools");
	} else {
		targetToolsDir = path.join(bobbitConfigDir(), "tools");
	}

	// Find which group directory contains this tool
	const builtinToolsDir = runtimeBuiltinToolsDir();

	// Find groupDir in the target scope (the override we're deleting)
	let groupDir = findToolGroupDir(name, targetToolsDir);
	// If not found in target, try builtins to at least know the group name
	if (!groupDir) groupDir = findToolGroupDir(name, builtinToolsDir);
	if (!groupDir) { json({ error: "Could not determine tool group directory" }, 400); return; }

	const dirToRemove = path.join(targetToolsDir, groupDir);
	if (fs.existsSync(dirToRemove)) {
		fs.rmSync(dirToRemove, { recursive: true, force: true });
	}

	json({ ok: true });
	return;
}

export function registerToolsRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/tools", handleToolsGet);
	table.register("GET", "/api/tools/:name", handleToolGet);
	table.register("PUT", "/api/tools/:name", handleToolPut);
	table.register("POST", "/api/tools/:name/customize", handleToolCustomizePost);
	table.register("DELETE", "/api/tools/:name/override", handleToolOverrideDelete);
}
