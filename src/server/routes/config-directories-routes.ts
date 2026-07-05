// src/server/routes/config-directories-routes.ts
//
// STR-01 cohort 13: Config-directories routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import { getAllConfigDirectories, removeBuiltinDirectory, resetConfigDirectories } from "../agent/config-directories.js";
import { resolveProjectForRequest } from "../agent/resolve-project.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// GET /api/config-directories — return all scanned config directories
async function handleConfigDirectoriesGet(ctx: CoreRouteCtx): Promise<void> {
	const { json, projectRegistry, resolveProjectConfigStore, url, writeProjectResolutionError } = ctx;
	const projectId = url.searchParams.get("projectId") || undefined;
	const resolved = resolveProjectForRequest(projectRegistry, { projectId });
	if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
	const resolvedStore = resolveProjectConfigStore(resolved.projectId);
	json(getAllConfigDirectories(resolved.project.rootPath, resolvedStore));
	return;
}

// DELETE /api/config-directories — remove a built-in directory from scanning
async function handleConfigDirectoriesDelete(ctx: CoreRouteCtx): Promise<void> {
	const { json, projectRegistry, readBody, req, resolveProjectConfigStore, writeProjectResolutionError } = ctx;
	const body = await readBody(req);
	if (!body || typeof body !== "object" || typeof (body as any).path !== "string") {
		json({ error: "Missing 'path' in body" }, 400);
		return;
	}
	const resolved = resolveProjectForRequest(projectRegistry, { projectId: (body as any).projectId });
	if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
	const resolvedStore = resolveProjectConfigStore(resolved.projectId);
	removeBuiltinDirectory(resolvedStore, (body as any).path);
	json({ ok: true });
	return;
}

// POST /api/config-directories/reset — reset all config dirs to defaults
async function handleConfigDirectoriesReset(ctx: CoreRouteCtx): Promise<void> {
	const { json, projectRegistry, readBody, req, resolveProjectConfigStore, writeProjectResolutionError } = ctx;
	const body = await readBody(req);
	const resolved = resolveProjectForRequest(projectRegistry, { projectId: body && typeof body === "object" ? (body as any).projectId : undefined });
	if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
	const resolvedStore = resolveProjectConfigStore(resolved.projectId);
	resetConfigDirectories(resolvedStore);
	json({ ok: true });
	return;
}

export function registerConfigDirectoriesRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/config-directories", handleConfigDirectoriesGet);
	table.register("DELETE", "/api/config-directories", handleConfigDirectoriesDelete);
	table.register("POST", "/api/config-directories/reset", handleConfigDirectoriesReset);
}
