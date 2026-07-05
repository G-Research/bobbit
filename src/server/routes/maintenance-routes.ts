// src/server/routes/maintenance-routes.ts
//
// STR-01 cohort 8: maintenance and search-admin routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — every handler body below preserves the legacy
// behavior, with only these substitutions:
//   - exact path checks -> one registry entry per method/path.
//   - handleApiRoute locals (json, readBody, req, url, sessionManager,
//     projectContextManager) are destructured from ctx.
//   - WorktreeInventoryService is imported directly; helper functions used
//     only by this route family moved into this module.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block in this cohort gated on exact path and method in the same `if`
// condition. A method mismatch skipped the block and fell through to the
// terminal 404; RouteTable's method-scoped matching preserves that behavior
// by leaving unhandled methods unregistered.

import { WorktreeInventoryService } from "../agent/worktree-inventory.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

function worktreeInventory(ctx: CoreRouteCtx): WorktreeInventoryService {
	const { projectContextManager, sessionManager } = ctx;
	return new WorktreeInventoryService({ projectContextManager, sessionManager });
}

function resolveSearchProject(ctx: CoreRouteCtx, pid: string | undefined | null) {
	if (!pid) return null;
	return ctx.projectContextManager.getOrCreate(pid);
}

function searchUnavailableResponse(state: string) {
	const reasonMap: Record<string, string> = {
		"disabled": "disabled",
		"closed": "closed",
		"initializing": "initializing",
	};
	const reason = reasonMap[state] ?? state;
	return { error: "search-unavailable", reason, state };
}

// GET /api/maintenance/worktrees
async function handleMaintenanceWorktrees(ctx: CoreRouteCtx): Promise<void> {
	const { url, json } = ctx;
	const include = url.searchParams.get("include");
	if (include && include !== "all" && include !== "actionable" && include !== "troubleshooting") {
		json({ error: "include must be all, actionable, or troubleshooting" }, 400);
		return;
	}
	json(await worktreeInventory(ctx).scan({ include: (include as any) || "all" }));
}

// GET /api/maintenance/archived-session-worktrees
async function handleArchivedSessionWorktrees(ctx: CoreRouteCtx): Promise<void> {
	const { url, json } = ctx;
	const includeAlreadyCleaned = url.searchParams.get("includeAlreadyCleaned") === "1";
	json(await worktreeInventory(ctx).legacyArchivedSessionWorktrees(includeAlreadyCleaned));
}

// POST /api/maintenance/cleanup-archived-session-worktrees
async function handleCleanupArchivedSessionWorktrees(ctx: CoreRouteCtx): Promise<void> {
	const { json, readBody, req } = ctx;
	const body = await readBody(req);
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		json({ error: "Request body must be an object" }, 400);
		return;
	}
	const rec = body as Record<string, unknown>;
	const mode = rec.mode;
	const hasSessionIds = Object.prototype.hasOwnProperty.call(body, "sessionIds");
	const hasWorktrees = Object.prototype.hasOwnProperty.call(body, "worktrees");
	const hasCategories = Object.prototype.hasOwnProperty.call(body, "categories");
	const hasPresetId = Object.prototype.hasOwnProperty.call(body, "presetId");
	const hasProjectId = Object.prototype.hasOwnProperty.call(body, "projectId");
	const hasRepoPath = Object.prototype.hasOwnProperty.call(body, "repoPath");
	if (mode !== "all" && mode !== "selected" && mode !== "category" && mode !== "preset") { json({ error: "Invalid cleanup mode" }, 400); return; }
	if (mode === "all" && (hasSessionIds || hasWorktrees || hasCategories || hasPresetId || hasProjectId || hasRepoPath)) { json({ error: "mode=all does not accept selectors" }, 400); return; }
	if (mode === "selected") {
		if (hasCategories || hasPresetId) { json({ error: "mode=selected accepts sessionIds or worktrees selectors only" }, 400); return; }
		if (hasSessionIds && hasWorktrees) { json({ error: "mode=selected accepts either sessionIds or worktrees, not both" }, 400); return; }
		if (hasSessionIds && (!Array.isArray(rec.sessionIds) || rec.sessionIds.some((id: unknown) => typeof id !== "string"))) { json({ error: "sessionIds must be an array of strings" }, 400); return; }
		if (hasWorktrees && (!Array.isArray(rec.worktrees) || rec.worktrees.some((wt: unknown) => {
			if (!wt || typeof wt !== "object" || Array.isArray(wt)) return true;
			const selector = wt as Record<string, unknown>;
			return typeof selector.sessionId !== "string" || (selector.repo !== undefined && typeof selector.repo !== "string") || (selector.path !== undefined && typeof selector.path !== "string") || (selector.key !== undefined && typeof selector.key !== "string");
		}))) { json({ error: "worktrees must be an array of selector objects with string fields" }, 400); return; }
	}
	if (mode === "category") {
		const validCategories = new Set(["archived-session", "goal-session", "team-session", "delegate-session", "child-session", "single-repo", "multi-repo"]);
		if (hasSessionIds || hasWorktrees || hasPresetId) { json({ error: "mode=category accepts categories with optional projectId or repoPath only" }, 400); return; }
		if (!Array.isArray(rec.categories) || rec.categories.some((category: unknown) => typeof category !== "string" || !validCategories.has(category as string))) { json({ error: "categories must be an array of supported category strings" }, 400); return; }
		if (rec.projectId !== undefined && typeof rec.projectId !== "string") { json({ error: "projectId must be a string" }, 400); return; }
		if (rec.repoPath !== undefined && typeof rec.repoPath !== "string") { json({ error: "repoPath must be a string" }, 400); return; }
	}
	if (mode === "preset") {
		if (hasSessionIds || hasWorktrees || hasCategories || hasProjectId || hasRepoPath) { json({ error: "mode=preset accepts presetId only" }, 400); return; }
		if (typeof rec.presetId !== "string") { json({ error: "presetId must be a string" }, 400); return; }
	}
	try { json(await worktreeInventory(ctx).cleanupLegacyArchivedSessionWorktrees(body as any)); }
	catch (err) { json({ error: err instanceof Error ? err.message : String(err) }, 400); }
}

// GET /api/maintenance/orphaned-worktrees
async function handleOrphanedWorktrees(ctx: CoreRouteCtx): Promise<void> {
	ctx.json(await worktreeInventory(ctx).legacyOrphanedWorktrees());
}

// POST /api/maintenance/cleanup-worktrees
async function handleCleanupWorktrees(ctx: CoreRouteCtx): Promise<void> {
	const { json, readBody, req } = ctx;
	const body = await readBody(req);
	const contentLengthHeader = Array.isArray(req.headers["content-length"]) ? req.headers["content-length"][0] : req.headers["content-length"];
	const hasRequestBody = contentLengthHeader !== undefined
		? Number(contentLengthHeader) > 0
		: req.headers["transfer-encoding"] !== undefined;
	const isPlainObjectBody = body !== null && typeof body === "object" && !Array.isArray(body);
	if (isPlainObjectBody && Object.prototype.hasOwnProperty.call(body, "mode")) {
		const mode = (body as any).mode;
		if (mode !== "all-safe" && mode !== "selected") {
			json({ error: "mode must be all-safe or selected" }, 400);
			return;
		}
		if (mode === "all-safe") {
			if (Object.prototype.hasOwnProperty.call(body, "itemIds") || Object.prototype.hasOwnProperty.call(body, "worktrees")) {
				json({ error: "mode=all-safe does not accept selectors" }, 400);
				return;
			}
		} else if (!Array.isArray((body as any).itemIds) || (body as any).itemIds.some((id: unknown) => typeof id !== "string")) {
			json({ error: "itemIds must be an array of strings" }, 400);
			return;
		}
		json(await worktreeInventory(ctx).cleanup(body as any));
		return;
	}
	if (isPlainObjectBody && Object.prototype.hasOwnProperty.call(body, "itemIds")) {
		json({ error: "mode is required when itemIds is provided" }, 400);
		return;
	}
	if ((body === null && hasRequestBody) || (body !== null && !isPlainObjectBody)) {
		json({ error: "cleanup-worktrees body must be an object" }, 400);
		return;
	}
	const legacyBodyKeys = isPlainObjectBody ? Object.keys(body as Record<string, unknown>) : [];
	if (legacyBodyKeys.some(key => key !== "worktrees")) {
		json({ error: "legacy cleanup-worktrees body accepts worktrees only" }, 400);
		return;
	}
	if (isPlainObjectBody && Object.prototype.hasOwnProperty.call(body, "worktrees") && (!Array.isArray((body as any).worktrees) || (body as any).worktrees.some((wt: unknown) => !wt || typeof wt !== "object" || Array.isArray(wt) || typeof (wt as any).path !== "string" || typeof (wt as any).branch !== "string" || typeof (wt as any).repoPath !== "string"))) {
		json({ error: "worktrees must be an array of { path, branch, repoPath }" }, 400);
		return;
	}
	const result = await worktreeInventory(ctx).cleanup({ mode: "legacy-orphaned", worktrees: isPlainObjectBody ? (body as any).worktrees : undefined });
	json({ cleaned: result.counts.cleaned });
}

// GET /api/maintenance/orphaned-sessions
async function handleOrphanedSessions(ctx: CoreRouteCtx): Promise<void> {
	const sessions = await ctx.sessionManager.listOrphanedNonInteractiveSessions();
	ctx.json({ sessions });
}

// POST /api/maintenance/cleanup-sessions
async function handleCleanupSessions(ctx: CoreRouteCtx): Promise<void> {
	const { json, readBody, req, sessionManager } = ctx;
	const body = await readBody(req);
	const orphans = await sessionManager.listOrphanedNonInteractiveSessions();
	const orphanIds = new Set(orphans.map(o => o.id));
	const idsToTerminate = (body?.sessionIds && Array.isArray(body.sessionIds))
		? (body.sessionIds as string[]).filter(id => orphanIds.has(id))
		: orphans.map(o => o.id);
	const terminated = await sessionManager.terminateOrphanedSessions(idsToTerminate);
	json({ terminated });
}

// GET /api/maintenance/expired-archives
async function handleExpiredArchives(ctx: CoreRouteCtx): Promise<void> {
	const stats = await ctx.sessionManager.getExpiredArchiveStats();
	ctx.json(stats);
}

// POST /api/maintenance/purge-archives
async function handlePurgeArchives(ctx: CoreRouteCtx): Promise<void> {
	const { json, sessionManager } = ctx;
	await sessionManager.purgeExpiredArchives();
	const stats = await sessionManager.getExpiredArchiveStats();
	json({ purged: true, remaining: stats });
}

// POST /api/search/rebuild
async function handleSearchRebuild(ctx: CoreRouteCtx): Promise<void> {
	const { json, readBody, req } = ctx;
	const body = await readBody(req);
	const projectId = body && typeof body === "object" ? (body as any).projectId : undefined;
	if (!projectId || typeof projectId !== "string") {
		json({ error: "Missing projectId" }, 400);
		return;
	}
	const projectCtx = resolveSearchProject(ctx, projectId);
	if (!projectCtx) { json({ error: "Project not found" }, 404); return; }
	await projectCtx.searchIndex.whenReady();
	const state = projectCtx.searchIndex.getState();
	if (state !== "ready") {
		json(searchUnavailableResponse(state), 503);
		return;
	}
	// Kick off in background — client observes progress over WS.
	projectCtx.searchIndex
		.rebuildFromStores(projectCtx.goalStore, projectCtx.sessionStore, undefined, projectCtx.staffStore)
		.catch((err) => console.error("[search] rebuild failed:", err));
	json({ ok: true }, 202);
}

// GET /api/search/stats?projectId=...
async function handleSearchStats(ctx: CoreRouteCtx): Promise<void> {
	const { url, json } = ctx;
	const projectId = url.searchParams.get("projectId") || undefined;
	if (!projectId) { json({ error: "Missing projectId" }, 400); return; }
	const projectCtx = resolveSearchProject(ctx, projectId);
	if (!projectCtx) { json({ error: "Project not found" }, 404); return; }
	await projectCtx.searchIndex.whenReady();
	const stats = await projectCtx.searchIndex.getStats();
	json(stats);
}

// POST /api/search/compact
async function handleSearchCompact(ctx: CoreRouteCtx): Promise<void> {
	const { json, readBody, req } = ctx;
	const body = await readBody(req);
	const projectId = body && typeof body === "object" ? (body as any).projectId : undefined;
	if (!projectId || typeof projectId !== "string") {
		json({ error: "Missing projectId" }, 400);
		return;
	}
	const projectCtx = resolveSearchProject(ctx, projectId);
	if (!projectCtx) { json({ error: "Project not found" }, 404); return; }
	await projectCtx.searchIndex.whenReady();
	const state = projectCtx.searchIndex.getState();
	if (state !== "ready") {
		json(searchUnavailableResponse(state), 503);
		return;
	}
	try {
		await projectCtx.searchIndex.compact();
		json({ ok: true });
	} catch (err) {
		json({ error: `Compact failed: ${(err as Error).message}` }, 500);
	}
}

// GET /api/maintenance/orphaned-index-rows?projectId=...
async function handleOrphanedIndexRows(ctx: CoreRouteCtx): Promise<void> {
	const { url, json } = ctx;
	const projectId = url.searchParams.get("projectId") || undefined;
	if (!projectId) { json({ error: "Missing projectId" }, 400); return; }
	const projectCtx = resolveSearchProject(ctx, projectId);
	if (!projectCtx) { json({ error: "Project not found" }, 404); return; }
	await projectCtx.searchIndex.whenReady();
	const store = projectCtx.searchIndex.getStore();
	if (!store) {
		json(searchUnavailableResponse(projectCtx.searchIndex.getState()), 503);
		return;
	}
	try {
		const rows = store.list({ limit: 100000 });
		const orphans: Array<{ id: string; source_id: string; parent_id: string | null }> = [];
		for (const row of rows) {
			const sourceId = String(row.source_id ?? "");
			const id = String(row.id ?? "");
			let isOrphan = false;
			if (sourceId === "goals") {
				const goalId = id.replace(/^goal:/, "");
				isOrphan = !projectCtx.goalStore.get(goalId);
			} else if (sourceId === "sessions") {
				const sessionId = id.replace(/^session:/, "");
				isOrphan = !projectCtx.sessionStore.get(sessionId);
			} else if (sourceId === "messages") {
				const sessionId = String(row.session_id ?? "");
				isOrphan = !sessionId || !projectCtx.sessionStore.get(sessionId);
			} else if (sourceId === "staff") {
				const staffId = id.replace(/^staff:/, "");
				isOrphan = !projectCtx.staffStore.get(staffId);
			}
			if (isOrphan) {
				orphans.push({
					id,
					source_id: sourceId,
					parent_id: row.parent_id != null ? String(row.parent_id) : null,
				});
			}
		}
		json({ count: orphans.length, sample: orphans.slice(0, 100) });
	} catch (err) {
		json({ error: `Orphan scan failed: ${(err as Error).message}` }, 500);
	}
}

// POST /api/maintenance/cleanup-index-rows
async function handleCleanupIndexRows(ctx: CoreRouteCtx): Promise<void> {
	const { json, readBody, req } = ctx;
	const body = await readBody(req);
	const projectId = body && typeof body === "object" ? (body as any).projectId : undefined;
	if (!projectId || typeof projectId !== "string") {
		json({ error: "Missing projectId" }, 400);
		return;
	}
	const projectCtx = resolveSearchProject(ctx, projectId);
	if (!projectCtx) { json({ error: "Project not found" }, 404); return; }
	await projectCtx.searchIndex.whenReady();
	const store = projectCtx.searchIndex.getStore();
	if (!store) {
		json(searchUnavailableResponse(projectCtx.searchIndex.getState()), 503);
		return;
	}
	try {
		const rows = store.list({ limit: 100000 });
		const toDelete: string[] = [];
		for (const row of rows) {
			const sourceId = String(row.source_id ?? "");
			const id = String(row.id ?? "");
			let isOrphan = false;
			if (sourceId === "goals") {
				isOrphan = !projectCtx.goalStore.get(id.replace(/^goal:/, ""));
			} else if (sourceId === "sessions") {
				isOrphan = !projectCtx.sessionStore.get(id.replace(/^session:/, ""));
			} else if (sourceId === "messages") {
				const sessionId = String(row.session_id ?? "");
				isOrphan = !sessionId || !projectCtx.sessionStore.get(sessionId);
			} else if (sourceId === "staff") {
				isOrphan = !projectCtx.staffStore.get(id.replace(/^staff:/, ""));
			}
			if (isOrphan) toDelete.push(id);
		}
		if (toDelete.length) await store.deleteByIds(toDelete);
		json({ deleted: toDelete.length });
	} catch (err) {
		json({ error: `Cleanup failed: ${(err as Error).message}` }, 500);
	}
}

export function registerMaintenanceRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/maintenance/worktrees", handleMaintenanceWorktrees);
	table.register("GET", "/api/maintenance/archived-session-worktrees", handleArchivedSessionWorktrees);
	table.register("POST", "/api/maintenance/cleanup-archived-session-worktrees", handleCleanupArchivedSessionWorktrees);
	table.register("GET", "/api/maintenance/orphaned-worktrees", handleOrphanedWorktrees);
	table.register("POST", "/api/maintenance/cleanup-worktrees", handleCleanupWorktrees);
	table.register("GET", "/api/maintenance/orphaned-sessions", handleOrphanedSessions);
	table.register("POST", "/api/maintenance/cleanup-sessions", handleCleanupSessions);
	table.register("GET", "/api/maintenance/expired-archives", handleExpiredArchives);
	table.register("POST", "/api/maintenance/purge-archives", handlePurgeArchives);
	table.register("POST", "/api/search/rebuild", handleSearchRebuild);
	table.register("GET", "/api/search/stats", handleSearchStats);
	table.register("POST", "/api/search/compact", handleSearchCompact);
	table.register("GET", "/api/maintenance/orphaned-index-rows", handleOrphanedIndexRows);
	table.register("POST", "/api/maintenance/cleanup-index-rows", handleCleanupIndexRows);
}
