// src/server/routes/session-discovery-routes.ts
//
// STR-01 cohort 20: session discovery/read routes migrated out of
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

import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";
import { bfsEnrichArchivedIndexed } from "../agent/archived-session-bfs.js";

// GET /api/search
async function handleSearch(ctx: CoreRouteCtx): Promise<void> {
	const { json, projectContextManager, projectRegistry, url } = ctx;
	const q = url.searchParams.get("q");
	if (!q) {
		json({ error: "Missing query parameter 'q'" }, 400);
		return;
	}
	const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20), 100);
	const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
	const typeParam = url.searchParams.get("type") || "all";
	const validTypes = new Set(["all", "goals", "sessions", "messages", "staff", "files"]);
	const type = validTypes.has(typeParam) ? typeParam as "all" | "goals" | "sessions" | "messages" | "staff" | "files" : "all";
	try {
		const projectId = url.searchParams.get("projectId") || undefined;
		const projectNames = new Map(projectRegistry.list().map(p => [p.id, p.name]));
		const results = await projectContextManager.searchAll(q, { type, limit, offset, projectId, projectNames });
		json(results);
	} catch (err) {
		json({ error: `Search failed: ${err}` }, 500);
	}
	return;
}

// GET /api/sessions
function handleListSessions(ctx: CoreRouteCtx): void {
	const {
		archivedSessionMatchesQuery,
		bfsEnrichArchived,
		colorStore,
		json,
		normalizedArchivedQuery,
		projectContextManager,
		projectRegistry,
		sessionManager,
		url,
	} = ctx;
	const currentGen = projectContextManager.getSessionGeneration();
	const sinceParam = url.searchParams.get("since");
	if (sinceParam !== null) {
		const since = parseInt(sinceParam, 10);
		if (!isNaN(since) && since === currentGen) {
			json({ generation: currentGen, changed: false });
			return;
		}
	}
	const filterProjectId = url.searchParams.get("projectId") || undefined;
	const registeredProjectIds = new Set(projectRegistry.list().map(p => p.id));
	let sessions = sessionManager.listSessions().map((s) => ({
		...s,
		colorIndex: colorStore.get(s.id),
	})).filter(s => !s.projectId || registeredProjectIds.has(s.projectId));
	if (filterProjectId) {
		sessions = sessions.filter(s => s.projectId === filterProjectId);
	}
	// Support ?include=archived to return archived sessions too
	if (url.searchParams.get("include") === "archived") {
		const archivedQuery = normalizedArchivedQuery(url.searchParams.get("q"));
		// Collect archived sessions across all project contexts
		const allArchived: typeof sessions = [];
		for (const ctx of projectContextManager.visible()) {
			const store = ctx.sessionStore;
			for (const s of store.getArchived()) {
				allArchived.push({ ...s, colorIndex: colorStore.get(s.id), status: "archived" } as any);
			}
		}
		// Sort by archivedAt descending
		allArchived.sort((a: any, b: any) => ((b as any).archivedAt ?? 0) - ((a as any).archivedAt ?? 0));
		// Apply projectId and query filters before pagination.
		const filteredArchived = (filterProjectId
			? allArchived.filter((s: any) => s.projectId === filterProjectId)
			: allArchived
		).filter((s: any) => archivedSessionMatchesQuery(s, archivedQuery));

		// Collect ALL archived sessions for BFS enrichment (not just delegates)
		const allArchivedForBfs: typeof sessions = [];
		for (const ctx of projectContextManager.visible()) {
			for (const s of ctx.sessionStore.getArchived()) {
				allArchivedForBfs.push({ ...s, colorIndex: colorStore.get(s.id), archived: true } as any);
			}
		}
		// Build live goal IDs for BFS seeding
		const liveGoalIds: string[] = [];
		for (const ctx of projectContextManager.visible()) {
			for (const g of ctx.goalStore.getLive()) {
				if (!g.archived) liveGoalIds.push(g.id);
			}
		}

		const limitParam = url.searchParams.get("limit");
		const afterParam = url.searchParams.get("after");
		if (limitParam) {
			// Paginated archived sessions
			const limit = Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 200);
			const afterCursor = afterParam ? parseInt(afterParam, 10) : undefined;
			let page = filteredArchived;
			if (afterCursor !== undefined) {
				page = page.filter((s: any) => ((s as any).archivedAt ?? 0) < afterCursor);
			}
			const total = filteredArchived.length;
			const hasMore = page.length > limit;
			const sliced = page.slice(0, limit);
			const nextCursor = sliced.length > 0 ? (sliced[sliced.length - 1] as any).archivedAt : undefined;

			// BFS: collect archived children reachable from live sessions and goals
			const liveIdSet = new Set(sessions.map(s => s.id));
			const archivedDelegatesOfLive = bfsEnrichArchived([...liveIdSet, ...liveGoalIds], allArchivedForBfs);

			json({ generation: currentGen, sessions: [...sessions, ...sliced], total, hasMore, nextCursor, archivedDelegates: archivedDelegatesOfLive });
		} else {
			// BFS: collect archived children reachable from live sessions and goals
			const liveIdSet = new Set(sessions.map(s => s.id));
			const archivedDelegatesOfLive = bfsEnrichArchived([...liveIdSet, ...liveGoalIds], allArchivedForBfs);

			// Backward compatible: return all archived sessions
			json({ generation: currentGen, sessions: [...sessions, ...filteredArchived], archivedDelegates: archivedDelegatesOfLive });
		}
	} else {
		// Always include archived children of live sessions/goals so the sidebar
		// can render chevrons/nesting without a separate fetch.
		//
		// PERF-03: this is the hottest REST route (sidebar poll, ~5s) and the
		// ?since generation guard above is frequently defeated during active
		// streaming (generation bumps on every activity update). Avoid
		// materializing (cloning) EVERY archived session across every visible
		// context on each request — index by parent key once, then walk only
		// the subgraph reachable from live seeds, cloning/enriching just the
		// sessions that end up in the response. See archived-session-bfs.ts.
		const liveIdSet = new Set(sessions.map(s => s.id));
		// Build live goal IDs for BFS seeding
		const liveGoalIdsNonPaginated: string[] = [];
		for (const ctx of projectContextManager.visible()) {
			for (const g of ctx.goalStore.getLive()) {
				if (!g.archived) liveGoalIdsNonPaginated.push(g.id);
			}
		}
		function* visibleArchivedRaw() {
			for (const ctx of projectContextManager.visible()) {
				for (const s of ctx.sessionStore.getArchived()) yield s;
			}
		}
		// BFS: live parents/goals → their archived children → children of those, etc.
		const archivedDelegatesOfLive = bfsEnrichArchivedIndexed(
			[...liveIdSet, ...liveGoalIdsNonPaginated],
			visibleArchivedRaw(),
			(s) => ({ ...s, colorIndex: colorStore.get(s.id), archived: true } as any),
		);
		json({ generation: currentGen, sessions, archivedDelegates: archivedDelegatesOfLive });
	}
	return;
}

// GET /api/sessions/:id (exact match — not /api/sessions/:id/output etc.)
function handleGetSession(ctx: CoreRouteCtx, params: Record<string, string>): void {
	const { colorStore, json, res, sessionManager } = ctx;
	const id = params.id;
	const session = sessionManager.getSession(id);
	if (!session) {
		// Check if it's an archived session
		const archived = sessionManager.getArchivedSession(id);
		if (archived) {
			json({
				id: archived.id,
				title: archived.title,
				cwd: archived.cwd,
				projectId: archived.projectId,
				status: "archived",
				createdAt: archived.createdAt,
				lastActivity: archived.lastActivity,
				clientCount: 0,
				isCompacting: false,
				goalId: archived.goalId,
				assistantType: archived.assistantType,
				delegateOf: archived.delegateOf,
				parentSessionId: archived.parentSessionId,
				childKind: archived.childKind,
				readOnly: archived.readOnly,
				role: archived.role,
				accessory: archived.accessory,
				teamGoalId: archived.teamGoalId,
				teamLeadSessionId: archived.teamLeadSessionId,
				worktreePath: archived.worktreePath,
				taskId: archived.taskId,
				staffId: archived.staffId,
				colorIndex: colorStore.get(archived.id),
				preview: archived.preview,
				reattemptGoalId: archived.reattemptGoalId,
				runtime: archived.runtime ?? "pi",
				claudeCodeSessionId: archived.claudeCodeSessionId,
				claudeCodeExecutable: archived.claudeCodeExecutable,
				claudeCodePermissionMode: archived.claudeCodePermissionMode,
				claudeCodeModelAlias: archived.claudeCodeModelAlias,
				archived: true,
				archivedAt: archived.archivedAt,
				imageGenerationModel: sessionManager.getImageModelForSession(archived.id),
			});
			return;
		}
		res.writeHead(404);
		res.end(JSON.stringify({ error: "Session not found" }));
		return;
	}
	const sessionPs = sessionManager.getSessionStore(session.projectId).get(session.id);
	json({
		id: session.id,
		title: session.title,
		cwd: session.cwd,
		status: session.status,
		createdAt: session.createdAt,
		lastActivity: session.lastActivity,
		clientCount: session.clients.size,
		isCompacting: session.isCompacting,
		goalId: session.goalId,
		assistantType: session.assistantType,
		// Legacy boolean fields for backward compat
		goalAssistant: session.assistantType === "goal",
		roleAssistant: session.assistantType === "role",
		toolAssistant: session.assistantType === "tool",
		delegateOf: session.delegateOf,
		parentSessionId: sessionPs?.parentSessionId ?? session.parentSessionId,
		childKind: sessionPs?.childKind ?? session.childKind,
		readOnly: sessionPs?.readOnly ?? session.readOnly,
		role: session.role,
		accessory: session.accessory,
		teamGoalId: session.teamGoalId,
		teamLeadSessionId: session.teamLeadSessionId,
		worktreePath: session.worktreePath,
		branch: session.branch ?? sessionPs?.branch,
		taskId: session.taskId,
		staffId: session.staffId,
		colorIndex: colorStore.get(session.id),
		preview: session.preview,
		reattemptGoalId: sessionPs?.reattemptGoalId,
		projectId: sessionPs?.projectId || session.projectId,
		runtime: sessionPs?.runtime ?? "pi",
		claudeCodeSessionId: sessionPs?.claudeCodeSessionId,
		claudeCodeExecutable: sessionPs?.claudeCodeExecutable,
		claudeCodePermissionMode: sessionPs?.claudeCodePermissionMode,
		claudeCodeModelAlias: sessionPs?.claudeCodeModelAlias,
		// Persisted model selection (provider+id). Surfaces the result of
		// the WS `set_model` handler's `persistSessionModel` call so clients
		// (and tests) can verify the selection round-tripped to disk without
		// reaching into the WS state stream.
		modelProvider: sessionPs?.modelProvider,
		modelId: sessionPs?.modelId,
		spawnPinnedModel: session.spawnPinnedModel,
		spawnPinnedThinkingLevel: session.spawnPinnedThinkingLevel,
		restoreError: session.restoreError,
		lastTurnErrored: session.lastTurnErrored ?? false,
		consecutiveErrorTurns: session.consecutiveErrorTurns ?? 0,
		completedTurnCount: session.completedTurnCount ?? 0,
		imageGenerationModel: sessionManager.getImageModelForSession(session.id),
	});
	return;
}

export function registerSessionDiscoveryRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/search", handleSearch);
	table.register("GET", "/api/sessions", handleListSessions);
	table.register("GET", "/api/sessions/:id", handleGetSession);
}
