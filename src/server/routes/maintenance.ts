/**
 * Maintenance + search admin routes.
 * Extracted from server.ts (commit: split server.ts).
 */
import { isGitRepo } from "../skills/git.js";
import type { Route } from "./types.js";
import type { RouteDeps } from "./route-deps.js";

function resolveSearchProject(deps: RouteDeps, pid: string | undefined | null) {
	if (!pid) return null;
	return deps.projectContextManager.getOrCreate(pid);
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

export const maintenanceRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/maintenance/orphaned-worktrees",
		handler: async ({ deps, json }) => {
			const allOrphans: Array<{ path: string; branch: string; repoPath: string }> = [];
			for (const ctx of deps.projectContextManager.all()) {
				try {
					const repoPath = ctx.project.rootPath;
					if (await isGitRepo(repoPath)) {
						const orphans = await deps.sessionManager.listOrphanedSessionWorktrees(repoPath);
						for (const o of orphans) {
							allOrphans.push({ ...o, repoPath });
						}
					}
				} catch { /* best-effort */ }
			}
			json({ worktrees: allOrphans });
		},
	},
	{
		method: "POST",
		pattern: "/api/maintenance/cleanup-worktrees",
		handler: async ({ deps, readBody, json }) => {
			const body = await readBody();
			let cleaned = 0;
			if (body?.worktrees && Array.isArray(body.worktrees)) {
				const validRepoPaths = new Set([...deps.projectContextManager.all()].map(ctx => ctx.project.rootPath));
				for (const wt of body.worktrees) {
					if (wt.path && wt.branch && wt.repoPath) {
						if (!validRepoPaths.has(wt.repoPath)) continue;
						try {
							const orphans = await deps.sessionManager.listOrphanedSessionWorktrees(wt.repoPath);
							const isOrphan = orphans.some(o => o.path === wt.path && o.branch === wt.branch);
							if (!isOrphan) continue;
						} catch { continue; }
						try {
							const { cleanupWorktree } = await import("../skills/git.js");
							await cleanupWorktree(wt.repoPath, wt.path, wt.branch, true);
							cleaned++;
						} catch { /* best-effort */ }
					}
				}
			} else {
				for (const ctx of deps.projectContextManager.all()) {
					try {
						const repoPath = ctx.project.rootPath;
						if (await isGitRepo(repoPath)) {
							await deps.sessionManager.cleanupOrphanedSessionWorktrees(repoPath);
							cleaned++;
						}
					} catch { /* best-effort */ }
				}
			}
			json({ cleaned });
		},
	},
	{
		method: "GET",
		pattern: "/api/maintenance/orphaned-sessions",
		handler: async ({ deps, json }) => {
			const sessions = await deps.sessionManager.listOrphanedNonInteractiveSessions();
			json({ sessions });
		},
	},
	{
		method: "POST",
		pattern: "/api/maintenance/cleanup-sessions",
		handler: async ({ deps, readBody, json }) => {
			const body = await readBody();
			const orphans = await deps.sessionManager.listOrphanedNonInteractiveSessions();
			const orphanIds = new Set(orphans.map(o => o.id));
			const idsToTerminate = (body?.sessionIds && Array.isArray(body.sessionIds))
				? (body.sessionIds as string[]).filter(id => orphanIds.has(id))
				: orphans.map(o => o.id);
			const terminated = await deps.sessionManager.terminateOrphanedSessions(idsToTerminate);
			json({ terminated });
		},
	},
	{
		method: "GET",
		pattern: "/api/maintenance/expired-archives",
		handler: async ({ deps, json }) => {
			const stats = await deps.sessionManager.getExpiredArchiveStats();
			json(stats);
		},
	},
	{
		method: "POST",
		pattern: "/api/maintenance/purge-archives",
		handler: async ({ deps, json }) => {
			await deps.sessionManager.purgeExpiredArchives();
			const stats = await deps.sessionManager.getExpiredArchiveStats();
			json({ purged: true, remaining: stats });
		},
	},
	{
		method: "POST",
		pattern: "/api/search/rebuild",
		handler: async ({ deps, readBody, json }) => {
			const body = await readBody();
			const projectId = body && typeof body === "object" ? (body as any).projectId : undefined;
			if (!projectId || typeof projectId !== "string") {
				json({ error: "Missing projectId" }, 400);
				return;
			}
			const ctx = resolveSearchProject(deps, projectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			await ctx.searchIndex.whenReady();
			const state = ctx.searchIndex.getState();
			if (state !== "ready") {
				json(searchUnavailableResponse(state), 503);
				return;
			}
			ctx.searchIndex
				.rebuildFromStores(ctx.goalStore, ctx.sessionStore, undefined, ctx.staffStore)
				.catch((err) => console.error("[search] rebuild failed:", err));
			json({ ok: true }, 202);
		},
	},
	{
		method: "GET",
		pattern: "/api/search/stats",
		handler: async ({ deps, url, json }) => {
			const projectId = url.searchParams.get("projectId") || undefined;
			if (!projectId) { json({ error: "Missing projectId" }, 400); return; }
			const ctx = resolveSearchProject(deps, projectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			await ctx.searchIndex.whenReady();
			const stats = await ctx.searchIndex.getStats();
			json(stats);
		},
	},
	{
		method: "POST",
		pattern: "/api/search/compact",
		handler: async ({ deps, readBody, json }) => {
			const body = await readBody();
			const projectId = body && typeof body === "object" ? (body as any).projectId : undefined;
			if (!projectId || typeof projectId !== "string") {
				json({ error: "Missing projectId" }, 400);
				return;
			}
			const ctx = resolveSearchProject(deps, projectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			await ctx.searchIndex.whenReady();
			const state = ctx.searchIndex.getState();
			if (state !== "ready") {
				json(searchUnavailableResponse(state), 503);
				return;
			}
			try {
				await ctx.searchIndex.compact();
				json({ ok: true });
			} catch (err) {
				json({ error: `Compact failed: ${(err as Error).message}` }, 500);
			}
		},
	},
	{
		method: "GET",
		pattern: "/api/maintenance/orphaned-index-rows",
		handler: async ({ deps, url, json }) => {
			const projectId = url.searchParams.get("projectId") || undefined;
			if (!projectId) { json({ error: "Missing projectId" }, 400); return; }
			const ctx = resolveSearchProject(deps, projectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			await ctx.searchIndex.whenReady();
			const store = ctx.searchIndex.getStore();
			if (!store) {
				json(searchUnavailableResponse(ctx.searchIndex.getState()), 503);
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
						isOrphan = !ctx.goalStore.get(goalId);
					} else if (sourceId === "sessions") {
						const sessionId = id.replace(/^session:/, "");
						isOrphan = !ctx.sessionStore.get(sessionId);
					} else if (sourceId === "messages") {
						const sessionId = String(row.session_id ?? "");
						isOrphan = !sessionId || !ctx.sessionStore.get(sessionId);
					} else if (sourceId === "staff") {
						const staffId = id.replace(/^staff:/, "");
						isOrphan = !ctx.staffStore.get(staffId);
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
		},
	},
	{
		method: "POST",
		pattern: "/api/maintenance/cleanup-index-rows",
		handler: async ({ deps, readBody, json }) => {
			const body = await readBody();
			const projectId = body && typeof body === "object" ? (body as any).projectId : undefined;
			if (!projectId || typeof projectId !== "string") {
				json({ error: "Missing projectId" }, 400);
				return;
			}
			const ctx = resolveSearchProject(deps, projectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			await ctx.searchIndex.whenReady();
			const store = ctx.searchIndex.getStore();
			if (!store) {
				json(searchUnavailableResponse(ctx.searchIndex.getState()), 503);
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
						isOrphan = !ctx.goalStore.get(id.replace(/^goal:/, ""));
					} else if (sourceId === "sessions") {
						isOrphan = !ctx.sessionStore.get(id.replace(/^session:/, ""));
					} else if (sourceId === "messages") {
						const sessionId = String(row.session_id ?? "");
						isOrphan = !sessionId || !ctx.sessionStore.get(sessionId);
					} else if (sourceId === "staff") {
						isOrphan = !ctx.staffStore.get(id.replace(/^staff:/, ""));
					}
					if (isOrphan) toDelete.push(id);
				}
				if (toDelete.length) await store.deleteByIds(toDelete);
				json({ deleted: toDelete.length });
			} catch (err) {
				json({ error: `Cleanup failed: ${(err as Error).message}` }, 500);
			}
		},
	},
];
