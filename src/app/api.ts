import {
	state,
	renderApp,
	setProjects,
	expandedGoals,
	saveExpandedGoals,
	type GatewaySession,
	type Goal,
	type Project,
} from "./state.js";
// Re-export for back-compat: many call sites import `gatewayFetch` from
// `./api.js`. The implementation now lives in `./gateway-fetch.js` (tiny,
// dependency-free) so utility modules like `fetch-tool-content.ts` can
// import it without pulling the entire app-shell graph.
import { gatewayFetch } from "./gateway-fetch.js";
export { gatewayFetch };
import { setHashRoute } from "./routing.js";
import { sessionHueRotation, sessionColorMap } from "./session-colors.js";
import { RemoteAgent } from "./remote-agent.js";
import { showFaviconBadge } from "./favicon-badge.js";
import { clearGoalChildrenFetchedCache } from "./render-helpers.js";
import { needsHumanAttention } from "./notification-policy.js";
import { errorFromResponse, errorDetails } from "./error-helpers.js";
export { errorFromResponse, errorDetails };

/** Track previous session statuses to detect streaming→idle transitions. */
const _prevSessionStatus = new Map<string, string>();

/** Throttle PR status polling — don't hit GitHub API on every session poll. */
let _lastPrRefresh = 0;
const PR_POLL_INTERVAL_MS = 60_000;

/** Reset PR poll throttle so next session poll triggers an immediate refresh.
 *  Called on visibilitychange (tab becomes visible) to avoid stale badges. */
export function resetPrPollThrottle(): void {
	_lastPrRefresh = 0;
}

// dialogs.ts imports from api.ts, so we use dynamic import to break the cycle
async function showConnectionError(title: string, message: string, opts?: { code?: string; stack?: string }): Promise<void> {
	const { showConnectionError: show } = await import("./dialogs.js");
	show(title, message, opts);
}

/**
 * Thrown by `registerProject()` when the server reports the supplied
 * `rootPath` resolves through a symlink to a different canonical path and
 * the caller did not pass `acceptCanonical: true`. The dialog catches this
 * and prompts the user to confirm registering the canonical path.
 */
export class SymlinkRootError extends Error {
	constructor(public readonly rootPath: string, public readonly canonical: string) {
		super(`rootPath ${rootPath} is a symlink to ${canonical}`);
		this.name = "SymlinkRootError";
	}
}

// ============================================================================
// SESSION HELPERS
// ============================================================================

export function updateLocalSessionTitle(sessionId: string, title: string): void {
	const idx = state.gatewaySessions.findIndex((s) => s.id === sessionId);
	if (idx >= 0) {
		state.gatewaySessions[idx] = { ...state.gatewaySessions[idx], title };
		renderApp();
	}
}

export function updateLocalSessionStatus(sessionId: string, status: string): void {
	const idx = state.gatewaySessions.findIndex((s) => s.id === sessionId);
	if (idx >= 0) {
		// NOTE: do NOT touch lastActivity here. The server is the sole writer of
		// lastActivity (bumped on real activity in src/server/agent/session-setup.ts
		// and friends, surfaced via /api/sessions polling every ~5s). Clobbering
		// lastActivity to Date.now() on every session_status frame caused spurious
		// "now ●" unread indicators in the sidebar on benign heartbeats and
		// busy→idle transitions. See tests/spurious-idle-unread.spec.ts.
		state.gatewaySessions[idx] = { ...state.gatewaySessions[idx], status };
		renderApp();
	}
}

export function startSessionPolling(): void {
	stopSessionPolling();
	state.sessionPollTimer = setInterval(() => {
		if (state.appView === "authenticated" && document.visibilityState === "visible") {
			refreshSessions();
		}
	}, 5_000);
}

export function stopSessionPolling(): void {
	if (state.sessionPollTimer) {
		clearInterval(state.sessionPollTimer);
		state.sessionPollTimer = null;
	}
}

export async function refreshSessions(): Promise<void> {
	const isInitial = state.gatewaySessions.length === 0 && !state.sessionsError;
	if (isInitial) {
		state.sessionsLoading = true;
		state.sessionsError = "";
		renderApp();
	}

	let sessionsChanged = false;
	let goalsChanged = false;

	try {
		// Build URLs with generation params for conditional fetch
		const sessionsUrl = state.sessionsGeneration >= 0
			? `/api/sessions?since=${state.sessionsGeneration}`
			: "/api/sessions";
		const goalsUrl = state.goalsGeneration >= 0
			? `/api/goals?since=${state.goalsGeneration}`
			: "/api/goals";

		const [sessionsRes, goalsRes, projectsResult] = await Promise.all([
			gatewayFetch(sessionsUrl),
			gatewayFetch(goalsUrl),
			// Fetch projects alongside sessions/goals so project grouping is
			// available on the very first render — prevents sessions briefly
			// appearing under the wrong project.
			isInitial ? fetchProjects().catch((): null => null) : Promise.resolve(null),
		]);
		// Apply projects before processing sessions so the first renderApp()
		// already has the correct project list for sidebar grouping.
		if (projectsResult) {
			setProjects(projectsResult);
		}
		// background polling: failures are silent (caller does not show a modal)
		if (!sessionsRes.ok) throw new Error(`Failed to fetch sessions: ${sessionsRes.status}`);
		const sessionsData = await sessionsRes.json();

		// Process sessions — skip if server says unchanged
		if (sessionsData.changed === false) {
			// Generation matches — nothing to do
		} else {
			sessionsChanged = true;
			const newSessions: GatewaySession[] = sessionsData.sessions || [];

			// Beep when a non-active background session finishes streaming
			const activeId = state.remoteAgent?.gatewaySessionId;
			for (const s of newSessions) {
				const prev = _prevSessionStatus.get(s.id);
				if (prev === "streaming" && s.status === "idle" && s.id !== activeId) {
					const goalId = s.teamGoalId || s.goalId;
					const goal = goalId ? state.goals.find(g => g.id === goalId) : undefined;
					if (needsHumanAttention(s, goal, newSessions, state.gateStatusCache)) {
						RemoteAgent.playNotificationBeep();
						showFaviconBadge();
					}
				}
			}
			for (const s of newSessions) {
				_prevSessionStatus.set(s.id, s.status);
			}

			state.gatewaySessions = newSessions;

			// Merge archived delegates of live sessions into state.archivedSessions
			const archivedDelegates: GatewaySession[] = sessionsData.archivedDelegates || [];
			if (archivedDelegates.length > 0) {
				const existingIds = new Set(state.archivedSessions.map(s => s.id));
				for (const d of archivedDelegates) {
					if (!existingIds.has(d.id)) {
						state.archivedSessions.push(d);
						existingIds.add(d.id);
					}
				}
			}

			for (const s of state.gatewaySessions) {
				if (s.colorIndex !== undefined && !sessionColorMap.has(s.id)) {
					sessionColorMap.set(s.id, s.colorIndex);
				}
				sessionHueRotation(s.id);
			}

			if (sessionsData.generation !== undefined) {
				state.sessionsGeneration = sessionsData.generation;
			}

			// Provisional projects are now real projects with a `provisional` flag.
			// No client-side reconstruction needed — they come through GET /api/projects.
		}

		// Process goals — skip if server says unchanged
		if (goalsRes.ok) {
			const goalsData = await goalsRes.json();
			if (goalsData.changed === false) {
				// Generation matches — nothing to do
			} else {
				goalsChanged = true;
				const prevGoalIds = new Set(state.goals.map((g) => g.id));
				const incoming: Goal[] = goalsData.goals || [];
				// Merge instead of overwrite. The /api/goals endpoint returns only
				// live goals by default; archived goals arrive via a separate
				// fetchArchivedGoalsPaginated() call. A naive overwrite here
				// destroys any archived goals that fetch already populated, which
				// caused races where typing in the search box (which kicks off the
				// archived fetch) collided with a concurrent refreshSessions and
				// the search briefly showed an empty Archived section.
				//
				// Rule: the live payload is authoritative for non-archived goals,
				// but never silently drops archived entries the server didn't
				// include. Archived goals are removed only by an explicit archived
				// fetch or unarchive event.
				const incomingIds = new Set(incoming.map((g) => g.id));
				const preservedArchived = state.goals.filter(
					(g) => g.archived && !incomingIds.has(g.id),
				);
				state.goals = [...incoming, ...preservedArchived];
				// Auto-expand only newly discovered goals that have sessions — never
				// re-expand a goal the user has already seen (and may have collapsed).
				for (const g of incoming) {
					if (!prevGoalIds.has(g.id) && state.gatewaySessions.some((s) => s.goalId === g.id)) {
						expandedGoals.add(g.id);
						saveExpandedGoals();
					}
				}

				if (goalsData.generation !== undefined) {
					state.goalsGeneration = goalsData.generation;
				}
			}
		}

		state.sessionsError = "";
	} catch (err) {
		if (isInitial) {
			state.sessionsError = err instanceof Error ? err.message : String(err);
			state.gatewaySessions = [];
		}
	} finally {
		state.sessionsLoading = false;
		if (sessionsChanged || goalsChanged || isInitial) {
			renderApp();
		}
	}

	// Fetch gate + PR status for sidebar badges — batched into a single renderApp().
	const badgePromises: Promise<boolean>[] = [];
	if (goalsChanged || isInitial) {
		badgePromises.push(refreshGateStatusCache(true));
	}
	const now = Date.now();
	if ((now - _lastPrRefresh >= PR_POLL_INTERVAL_MS || goalsChanged) && document.visibilityState === "visible") {
		_lastPrRefresh = now;
		badgePromises.push(refreshPrStatusCache(true));
	}
	if (badgePromises.length > 0) {
		Promise.all(badgePromises).then(results => {
			if (results.some(Boolean)) renderApp();
		});
	}

	// One-time hydration of PR status from disk cache (instant badge rendering)
	if (isInitial) {
		gatewayFetch("/api/pr-status-cache")
			.then(r => r.ok ? r.json() : null)
			.then(data => {
				if (data && typeof data === "object") {
					let changed = false;
					for (const [goalId, entry] of Object.entries(data)) {
						if (!state.prStatusCache.has(goalId)) {
							state.prStatusCache.set(goalId, entry as any);
							changed = true;
						}
					}
					if (changed) renderApp();
				}
			})
			.catch(() => {});
	}

	// Lazy-load archived sessions + goals on initial load only if user had "Show archived" persisted
	if (isInitial && state.showArchived && !_archivedSessionsLoaded) {
		fetchArchivedSessions();
		fetchArchivedGoalsPaginated();
	}
}

/** Whether archived sessions have been fetched at least once. */
let _archivedSessionsLoaded = false;
let _archivedGoalsLoaded = false;

/** Check whether archived sessions have been loaded. */
export function archivedSessionsLoaded(): boolean {
	return _archivedSessionsLoaded;
}

/** Check whether archived goals have been loaded via the dedicated paginated
 *  fetch. NOT the same as `state.goals.some(g => g.archived)` — archived goal
 *  entries can also arrive piggy-backed on `refreshSessions`' `archivedDelegates`
 *  field, which leaves the dedicated archived-goals page unfetched. The search
 *  auto-fetch path uses this flag to decide whether to kick the dedicated
 *  endpoint, so a search inside the sidebar reliably surfaces archived goals
 *  even if some archived sessions were already merged in via the live poll. */
export function archivedGoalsLoaded(): boolean {
	return _archivedGoalsLoaded;
}

/** Reset the archived sessions state (flag + data). Called on toggle-off. */
export function clearArchivedSessionsState(): void {
	_archivedSessionsLoaded = false;
	_archivedGoalsLoaded = false;
	state.archivedSessions = [];
	clearGoalChildrenFetchedCache();
}

/** Fetch archived sessions from the API (paginated). */
export async function fetchArchivedSessions(): Promise<void> {
	_archivedSessionsLoaded = true;
	// Reset pagination state and load first page — but don't clear archivedSessions
	// to preserve BFS-enriched delegates from the live poll
	state.archivedSessionsCursor = null;
	state.archivedSessionsHasMore = false;
	state.archivedSessionsTotal = 0;
	await fetchArchivedSessionsPaginated();
}

// ============================================================================
// SEARCH API
// ============================================================================

export async function searchApi(query: string, type?: string, limit?: number, offset?: number): Promise<{ results: any[]; total: number }> {
	try {
		const params = new URLSearchParams({ q: query });
		if (type && type !== "all") params.set("type", type);
		if (limit !== undefined) params.set("limit", String(limit));
		if (offset !== undefined) params.set("offset", String(offset));
		const res = await gatewayFetch(`/api/search?${params}`);
		if (!res.ok) return { results: [], total: 0 };
		return await res.json();
	} catch {
		return { results: [], total: 0 };
	}
}

// ============================================================================
// SEARCH INDEX MAINTENANCE API
// ============================================================================

export interface SearchStats {
	lastRebuildAt: number | null;
	rowCountsBySource: Record<string, number>;
	datasetBytes: number;
	engine: string;
	engineVersion: string;
	state: "ready" | "rebuilding" | "disabled" | "error" | "initializing" | "closed" | string;
}

export async function searchStats(projectId?: string): Promise<SearchStats | null> {
	try {
		const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
		const res = await gatewayFetch(`/api/search/stats${qs}`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function searchRebuild(projectId?: string): Promise<{ ok: boolean; status: number; error?: string }> {
	try {
		const res = await gatewayFetch("/api/search/rebuild", {
			method: "POST",
			body: JSON.stringify(projectId ? { projectId } : {}),
		});
		if (res.ok) return { ok: true, status: res.status };
		let error: string | undefined;
		try { error = (await res.json()).error; } catch { /* ignore */ }
		return { ok: false, status: res.status, error };
	} catch (err) {
		return { ok: false, status: 0, error: (err as Error).message };
	}
}

export async function searchCompact(projectId?: string): Promise<boolean> {
	try {
		const res = await gatewayFetch("/api/search/compact", {
			method: "POST",
			body: JSON.stringify(projectId ? { projectId } : {}),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export interface OrphanedIndexRows {
	count: number;
	sample: Array<{ id: string; source_id: string; parent_id?: string | null }>;
}

export async function orphanedIndexRows(projectId?: string): Promise<OrphanedIndexRows> {
	try {
		const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
		const res = await gatewayFetch(`/api/maintenance/orphaned-index-rows${qs}`);
		if (!res.ok) return { count: 0, sample: [] };
		return await res.json();
	} catch {
		return { count: 0, sample: [] };
	}
}

export async function cleanupOrphanedIndexRows(projectId?: string): Promise<number> {
	try {
		const res = await gatewayFetch("/api/maintenance/cleanup-index-rows", {
			method: "POST",
			body: JSON.stringify(projectId ? { projectId } : {}),
		});
		if (!res.ok) return 0;
		const data = await res.json();
		return data?.deleted ?? 0;
	} catch {
		return 0;
	}
}

// ============================================================================
// PROJECT API
// ============================================================================

export async function fetchProjects(): Promise<Project[]> {
  try {
    const res = await gatewayFetch("/api/projects");
    if (!res.ok) return [];
    const data = await res.json();
    return data.projects || data || [];
  } catch {
    return [];
  }
}

export async function saveProjectOrder(projectIds: string[]): Promise<Project[] | null> {
  try {
    const res = await gatewayFetch("/api/projects/order", {
      method: "PUT",
      body: JSON.stringify({ projectIds }),
    });
    if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
    const data = await res.json().catch(() => null);
    return data?.projects || data || [];
  } catch (err) {
    const { showConnectionError } = await import("./dialogs.js");
    const { message, code, stack } = errorDetails(err);
    showConnectionError("Failed to save project order", message, { code, stack });
    return null;
  }
}

export async function detectProject(dirPath: string): Promise<{
  exists: boolean;
  hasBobbit: boolean;
  isEmpty: boolean;
  hasPackageJson: boolean;
  name: string;
}> {
  const res = await gatewayFetch('/api/projects/detect', {
    method: 'POST',
    body: JSON.stringify({ path: dirPath }),
  });
  if (!res.ok) throw new Error('Detection failed');
  return res.json();
}

export interface DetectedRepo {
  folder: string;
  hasGit: boolean;
  detectedCommands: Record<string, string>;
}

export async function scanProjectRepos(dirPath: string): Promise<DetectedRepo[]> {
  const res = await gatewayFetch(`/api/projects/scan?path=${encodeURIComponent(dirPath)}`, {
    method: 'POST',
    body: JSON.stringify({ path: dirPath }),
  });
  if (!res.ok) throw new Error(`Scan failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data?.repos) ? data.repos as DetectedRepo[] : [];
}

export async function browseDirectory(dirPath?: string): Promise<{
  current: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}> {
  const params = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
  const res = await gatewayFetch(`/api/browse-directory${params}`);
  if (!res.ok) throw new Error('Browse failed');
  return res.json();
}

export async function registerProject(name: string, rootPath: string, color?: string, upsert?: boolean, acceptCanonical?: boolean): Promise<Project | null> {
  try {
    const body: Record<string, unknown> = { name, rootPath };
    if (color) body.color = color;
    if (upsert) body.upsert = true;
    if (acceptCanonical) body.acceptCanonical = true;
    const res = await gatewayFetch("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // Symlink-root structured response (HTTP 400). Throw a typed error so
      // the dialog can present a confirm-canonical-path UI rather than the
      // generic connection-error modal.
      if (data && data.code === "symlink_root" && typeof data.canonical === "string") {
        throw new SymlinkRootError(data.rootPath || rootPath, data.canonical);
      }
      // Preserve structured error info for downstream display.
      const err = new Error(data.error || `Failed: ${res.status}`);
      (err as any).code = data.code;
      (err as any).stack = data.stack || (err as any).stack;
      throw err;
    }
    return await res.json();
  } catch (err) {
    if (err instanceof SymlinkRootError) throw err;
    const { showConnectionError } = await import("./dialogs.js");
    const msg = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === "object" ? (err as any).code : undefined;
    const stack = err instanceof Error ? err.stack : undefined;
    showConnectionError("Failed to register project", msg, { code, stack });
    return null;
  }
}

export async function updateProject(id: string, updates: { name?: string; color?: string }): Promise<Project | null> {
  try {
    const res = await gatewayFetch(`/api/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify(updates),
    });
    if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
    return await res.json();
  } catch (err) {
    const { showConnectionError } = await import("./dialogs.js");
    const { message, code, stack } = errorDetails(err);
    showConnectionError("Failed to update project", message, { code, stack });
    return null;
  }
}

export async function removeProject(id: string): Promise<boolean> {
  try {
    const res = await gatewayFetch(`/api/projects/${id}`, { method: "DELETE" });
    if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
    return true;
  } catch (err) {
    const { showConnectionError } = await import("./dialogs.js");
    const { message, code, stack } = errorDetails(err);
    showConnectionError("Failed to remove project", message, { code, stack });
    return false;
  }
}

/** Fetch the raw project.yaml config for a project. */
export async function getProjectConfig(id: string): Promise<Record<string, string> | null> {
  try {
    const res = await gatewayFetch(`/api/projects/${id}/config`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** PUT a partial config update to a project. Returns true on success. */
export async function updateProjectConfig(id: string, partial: Record<string, string>): Promise<boolean> {
  try {
    const res = await gatewayFetch(`/api/projects/${id}/config`, {
      method: "PUT",
      body: JSON.stringify(partial),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Promote a provisional project to a full project (clears provisional flag, optionally updates name). */
export async function promoteProject(id: string, name?: string): Promise<Project | null> {
  try {
    const body: Record<string, unknown> = {};
    if (name) body.name = name;
    const res = await gatewayFetch(`/api/projects/${id}/promote`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
    return await res.json();
  } catch (err) {
    const { showConnectionError } = await import("./dialogs.js");
    const { message, code, stack } = errorDetails(err);
    showConnectionError("Failed to promote project", message, { code, stack });
    return null;
  }
}

// ============================================================================
// PAGINATED ARCHIVES
// ============================================================================

export async function fetchArchivedGoalsPaginated(limit = 50, afterCursor?: number): Promise<void> {
	try {
		const params = new URLSearchParams({ archived: "true", limit: String(limit) });
		if (afterCursor !== undefined) params.set("after", String(afterCursor));
		const res = await gatewayFetch(`/api/goals?${params}`);
		if (!res.ok) return;
		// Mark the dedicated archived-goals page as fetched. Used by the sidebar
		// search auto-fetch gate (see archivedGoalsLoaded() above).
		_archivedGoalsLoaded = true;
		const data = await res.json();
		const goals: Goal[] = data.goals || [];
		if (afterCursor !== undefined) {
			// Append to existing
			const existingIds = new Set(state.goals.filter(g => g.archived).map(g => g.id));
			const newGoals = goals.filter(g => !existingIds.has(g.id));
			state.goals = [...state.goals, ...newGoals];
		} else {
			// First page — replace archived goals, keep live goals
			const liveGoals = state.goals.filter(g => !g.archived);
			state.goals = [...liveGoals, ...goals];
		}
		state.archivedGoalsTotal = data.total ?? goals.length;
		state.archivedGoalsHasMore = data.hasMore ?? false;
		state.archivedGoalsCursor = data.nextCursor ?? null;

		// Merge affiliated sessions returned with archived goals
		const affiliatedSessions: GatewaySession[] = data.archivedSessions || [];
		if (affiliatedSessions.length > 0) {
			const existingIds = new Set(state.archivedSessions.map(s => s.id));
			for (const s of affiliatedSessions) {
				if (!existingIds.has(s.id)) {
					state.archivedSessions.push(s);
					existingIds.add(s.id);
				}
			}
		}

		renderApp();
	} catch {
		// Silently fail
	}
}

export async function fetchArchivedSessionsPaginated(limit = 50, afterCursor?: number): Promise<void> {
	try {
		const params = new URLSearchParams({ include: "archived", limit: String(limit) });
		if (afterCursor !== undefined) params.set("after", String(afterCursor));
		const res = await gatewayFetch(`/api/sessions?${params}`);
		if (!res.ok) return;
		const data = await res.json();
		const sessions: GatewaySession[] = (data.sessions || []).filter((s: any) => s.archived === true);
		if (afterCursor !== undefined) {
			// Append
			const existingIds = new Set(state.archivedSessions.map(s => s.id));
			const newSessions = sessions.filter(s => !existingIds.has(s.id));
			state.archivedSessions = [...state.archivedSessions, ...newSessions];
		} else {
			// Merge: preserve BFS-enriched delegates from live poll, update with fresh server data
			const serverIds = new Set(sessions.map(s => s.id));
			state.archivedSessions = [
				...state.archivedSessions.filter(s => !serverIds.has(s.id)),
				...sessions,
			];
		}

		// Merge archived delegates from the response (BFS-enriched by server)
		const archivedDelegates: GatewaySession[] = data.archivedDelegates || [];
		if (archivedDelegates.length > 0) {
			const existingIds = new Set(state.archivedSessions.map(s => s.id));
			for (const d of archivedDelegates) {
				if (!existingIds.has(d.id)) {
					state.archivedSessions.push(d);
					existingIds.add(d.id);
				}
			}
		}
		state.archivedSessionsTotal = data.total ?? sessions.length;
		state.archivedSessionsHasMore = data.hasMore ?? false;
		state.archivedSessionsCursor = data.nextCursor ?? null;
		renderApp();
	} catch {
		// Silently fail
	}
}

/** Fetch gate statuses for all goals with workflows and update the cache.
 *  Returns true if any data changed. When skipRender is true, the caller is responsible for renderApp(). */
async function refreshGateStatusCache(skipRender = false): Promise<boolean> {
	const goalsWithWorkflow = state.goals.filter(g => g.workflow && g.workflow.gates.length > 0);
	if (goalsWithWorkflow.length === 0) return false;

	const results = await Promise.all(
		goalsWithWorkflow.map(async (g) => {
			const gates = await fetchGoalGates(g.id);
			const passed = gates.filter(gs => gs.status === "passed").length;
			const total = g.workflow!.gates.length;
			const verifying = gates.some(gs => gs.signals?.some(s => s.verification?.status === "running"));
			const verifyingCount = gates.filter(gs => gs.status !== "passed" && gs.signals?.some(s => s.verification?.status === "running")).length;
			return { goalId: g.id, passed, total, verifying, verifyingCount };
		})
	);

	let changed = false;
	for (const { goalId, passed, total, verifying, verifyingCount } of results) {
		const prev = state.gateStatusCache.get(goalId);
		if (!prev || prev.passed !== passed || prev.total !== total || prev.verifying !== verifying || prev.verifyingCount !== verifyingCount) {
			state.gateStatusCache.set(goalId, { passed, total, verifying, verifyingCount });
			changed = true;
		}
	}
	if (changed && !skipRender) renderApp();
	return changed;
}

/** Refresh gate status cache for a single goal (called from WS event handlers). */
export async function refreshGateStatusForGoal(goalId: string): Promise<void> {
	const goal = state.goals.find(g => g.id === goalId);
	if (!goal?.workflow?.gates.length) return;
	const gates = await fetchGoalGates(goalId);
	const passed = gates.filter(gs => gs.status === "passed").length;
	const total = goal.workflow.gates.length;
	const verifying = gates.some(gs => gs.signals?.some((s: any) => s.verification?.status === "running"));
	const verifyingCount = gates.filter(gs => gs.status !== "passed" && gs.signals?.some((s: any) => s.verification?.status === "running")).length;
	const prev = state.gateStatusCache.get(goalId);
	if (!prev || prev.passed !== passed || prev.total !== total || prev.verifying !== verifying || prev.verifyingCount !== verifyingCount) {
		state.gateStatusCache.set(goalId, { passed, total, verifying, verifyingCount });
		renderApp();
	}
}

/** Fetch PR status for all goals with branches and update the cache.
 *  Returns true if any data changed. When skipRender is true, the caller is responsible for renderApp(). */
let _prRefreshInFlight = false;
export async function refreshPrStatusCache(skipRender = false): Promise<boolean> {
	if (_prRefreshInFlight) return false;
	_prRefreshInFlight = true;
	try {
	// Only poll active goals — completed/archived goals keep their cached PR status
	const goalsWithBranch = state.goals.filter(g => g.branch && g.state !== 'complete' && !g.archived && state.prStatusCache.get(g.id)?.state !== 'MERGED');
	if (goalsWithBranch.length === 0) return false;

	const results = await Promise.all(
		goalsWithBranch.map(async (g) => {
			try {
				const res = await gatewayFetch(`/api/goals/${g.id}/pr-status`);
				if (res.status === 404) return { goalId: g.id, pr: null, noPr: true };
				if (!res.ok) return { goalId: g.id, pr: null, noPr: false };
				const data = await res.json();
				return { goalId: g.id, pr: data as { state: string; url?: string; number?: number; reviewDecision?: string; mergeable?: string }, noPr: false };
			} catch {
				return { goalId: g.id, pr: null, noPr: false };
			}
		})
	);

	let changed = false;
	for (const { goalId, pr, noPr } of results) {
		const prev = state.prStatusCache.get(goalId);
		if (pr) {
			if (!prev || prev.state !== pr.state || prev.reviewDecision !== pr.reviewDecision || prev.mergeable !== pr.mergeable) {
				state.prStatusCache.set(goalId, pr);
				changed = true;
			}
		} else if (noPr && prev) {
			// Only clear cache on explicit 404 (no PR exists), not on transient errors
			state.prStatusCache.delete(goalId);
			changed = true;
		}
	}
	if (changed && !skipRender) renderApp();
	return changed;
	} finally {
		_prRefreshInFlight = false;
	}
}

// ============================================================================
// GIT STATUS
// ============================================================================

export interface GitStatusData {
	branch: string;
	primaryBranch: string;
	/**
	 * Actual ref used for ahead/behind-primary calculations. Equals
	 * `origin/<primaryBranch>` when the remote ref exists, else the bare
	 * local branch `<primaryBranch>`. Display this verbatim instead of
	 * synthesising `origin/<primaryBranch>` — a configured `base_ref` may
	 * be a local branch with no `origin/` counterpart.
	 */
	primaryRef: string;
	isOnPrimary: boolean;
	summary: string;
	clean: boolean;
	hasUpstream: boolean;
	ahead: number;
	behind: number;
	aheadOfPrimary: number;
	behindPrimary: number;
	mergedIntoPrimary: boolean;
	insertionsVsPrimary: number;
	deletionsVsPrimary: number;
	unpushed: boolean;
	status: Array<{ file: string; status: string }>;
}

/**
 * Discriminated result from a git-status fetch. Distinguishes an explicit
 * "this is not a git repository" (terminal, don't retry) from any kind of
 * transient failure (retry-eligible) and from success.
 */
export type GitStatusResult =
	| { kind: 'ok'; data: GitStatusData & { partial?: boolean; untrackedIncluded?: boolean } }
	| { kind: 'not-a-repo' }
	| { kind: 'error'; status?: number; message: string };

function buildGitStatusQuery(opts?: { fetch?: boolean; untracked?: boolean }): string {
	const parts: string[] = [];
	if (opts?.fetch) parts.push('fetch=true');
	if (opts?.untracked) parts.push('untracked=1');
	return parts.length ? `?${parts.join('&')}` : '';
}

export async function fetchGitStatus(
	sessionId: string,
	opts?: { fetch?: boolean; untracked?: boolean; signal?: AbortSignal },
): Promise<GitStatusResult> {
	const qs = buildGitStatusQuery(opts);
	try {
		const res = await gatewayFetch(`/api/sessions/${sessionId}/git-status${qs}`, { signal: opts?.signal });
		if (res.ok) {
			try {
				const data = await res.json();
				return { kind: 'ok', data };
			} catch (err) {
				return { kind: 'error', status: res.status, message: (err as Error).message };
			}
		}
		if (res.status === 400) {
			try {
				const body = await res.json();
				if (body && body.error === 'Not a git repository') return { kind: 'not-a-repo' };
				return { kind: 'error', status: 400, message: body?.error ?? 'Bad request' };
			} catch {
				return { kind: 'error', status: 400, message: 'Bad request' };
			}
		}
		return { kind: 'error', status: res.status, message: `HTTP ${res.status}` };
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') {
			return { kind: 'error', message: 'aborted' };
		}
		return { kind: 'error', message: (err as Error).message };
	}
}

export async function fetchGoalGitStatus(
	goalId: string,
	opts?: { fetch?: boolean; untracked?: boolean; signal?: AbortSignal },
): Promise<GitStatusResult> {
	const qs = buildGitStatusQuery(opts);
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/git-status${qs}`, { signal: opts?.signal });
		if (res.ok) {
			try {
				const data = await res.json();
				return { kind: 'ok', data };
			} catch (err) {
				return { kind: 'error', status: res.status, message: (err as Error).message };
			}
		}
		if (res.status === 400) {
			try {
				const body = await res.json();
				if (body && body.error === 'Not a git repository') return { kind: 'not-a-repo' };
				return { kind: 'error', status: 400, message: body?.error ?? 'Bad request' };
			} catch {
				return { kind: 'error', status: 400, message: 'Bad request' };
			}
		}
		return { kind: 'error', status: res.status, message: `HTTP ${res.status}` };
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') {
			return { kind: 'error', message: 'aborted' };
		}
		return { kind: 'error', message: (err as Error).message };
	}
}

// ============================================================================
// GOAL API
// ============================================================================

export async function createGoal(title: string, cwd: string, opts?: { spec?: string; workflowId?: string; reattemptOf?: string; sandboxed?: boolean; projectId?: string; enabledOptionalSteps?: string[]; autoStartTeam?: boolean }): Promise<Goal | null> {
	const { spec = "", workflowId, reattemptOf, sandboxed, projectId, enabledOptionalSteps, autoStartTeam } = opts ?? {};
	try {
		const body: Record<string, any> = { title, cwd, spec, team: true, worktree: true };
		if (workflowId) body.workflowId = workflowId;
		if (reattemptOf) body.reattemptOf = reattemptOf;
		if (sandboxed !== undefined) body.sandboxed = !!sandboxed;
		if (projectId) body.projectId = projectId;
		if (enabledOptionalSteps?.length) body.enabledOptionalSteps = enabledOptionalSteps;
		if (autoStartTeam !== undefined) body.autoStartTeam = autoStartTeam;
		const res = await gatewayFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed to create goal: ${res.status}`);
		const goal = await res.json();
		await refreshSessions();
		expandedGoals.add(goal.id);
		saveExpandedGoals();
		return goal;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to create goal", message, { code, stack });
		return null;
	}
}

export async function updateGoal(id: string, updates: Partial<Pick<Goal, "title" | "cwd" | "state" | "spec" | "team">>): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/goals/${id}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed to update goal: ${res.status}`);
		await refreshSessions();
		return true;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to update goal", message, { code, stack });
		return false;
	}
}

export async function deleteGoal(id: string): Promise<void> {
	const { confirmAction } = await import("./dialogs.js");
	const goal = state.goals.find((g) => g.id === id);
	const goalTitle = goal?.title || "this goal";
	const sessionsUnderGoal = state.gatewaySessions.filter((s) => s.goalId === id);

	// Detect active team for this goal (mirror of heuristic in render-helpers.ts).
	const isTeamGoal = !!(goal as any)?.team;
	const teamActive = isTeamGoal && state.gatewaySessions.some(
		(s) => (s.goalId === id || s.teamGoalId === id)
			&& s.role === "team-lead"
			&& s.status !== "terminated",
	);

	const title = teamActive ? "Stop team and archive goal?" : "Archive Goal";
	let body = teamActive
		? `The team will be stopped and "${goalTitle}" will be archived.`
		: `Archive "${goalTitle}"? It will move to the archived section.`;
	if (sessionsUnderGoal.length > 0) {
		body += ` Its ${sessionsUnderGoal.length} session(s) will become ungrouped.`;
	}
	const confirmLabel = teamActive ? "Stop & Archive" : "Archive";

	const confirmed = await confirmAction(title, body, confirmLabel, teamActive);
	if (!confirmed) return;

	if (teamActive) {
		const ok = await teardownTeam(id);
		if (!ok) return; // teardownTeam already surfaced an error toast.
	}

	try {
		const res = await gatewayFetch(`/api/goals/${id}`, { method: "DELETE" });
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		setHashRoute("landing");
		await refreshSessions();
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to archive goal", message, { code, stack });
	}
}

/** Persist a session property update to the server via PATCH */
export function patchSession(sessionId: string, updates: Record<string, unknown>): void {
	gatewayFetch(`/api/sessions/${sessionId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(updates),
	}).catch(() => { /* best-effort */ });
}

// ============================================================================
// TEAM API
// ============================================================================

export async function startTeam(goalId: string): Promise<string | null> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team/start`, {
			method: "POST",
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		const data = await res.json();
		await refreshSessions();
		return data.sessionId;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to start team", message, { code, stack });
		return null;
	}
}

export async function getTeamState(goalId: string): Promise<any | null> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function completeTeam(goalId: string): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team/complete`, {
			method: "POST",
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		await refreshSessions();
		return true;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to complete team", message, { code, stack });
		return false;
	}
}

export async function teardownTeam(goalId: string): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team/teardown`, {
			method: "POST",
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		await refreshSessions();
		return true;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to tear down team", message, { code, stack });
		return false;
	}
}

// ============================================================================
// GOAL ARTIFACT API
// ============================================================================



// ============================================================================
// WORKFLOW API
// ============================================================================

export interface VerifyStep {
	name: string;
	type: "command" | "llm-review" | "agent-qa";
	run?: string;
	prompt?: string;
	expect?: "success" | "failure";
	timeout?: number;
	phase?: number;
	optional?: boolean;
	label?: string;
	description?: string;
}

export interface WorkflowGate {
	id: string;
	name: string;
	dependsOn: string[];
	content?: boolean;
	injectDownstream?: boolean;
	metadata?: Record<string, string>;
	verify?: VerifyStep[];
}

/** @deprecated Use WorkflowGate instead */
export type WorkflowArtifact = WorkflowGate;

export interface Workflow {
	id: string;
	name: string;
	description: string;
	gates: WorkflowGate[];
	createdAt: number;
	updatedAt: number;
}

export async function fetchWorkflows(projectId?: string): Promise<Workflow[]> {
	try {
		const url = projectId
			? `/api/workflows?projectId=${encodeURIComponent(projectId)}`
			: "/api/workflows";
		const res = await gatewayFetch(url);
		if (!res.ok) return [];
		const data = await res.json();
		return data.workflows || [];
	} catch {
		return [];
	}
}

export async function fetchWorkflow(id: string, projectId?: string): Promise<Workflow | null> {
	try {
		const url = projectId
			? `/api/workflows/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`
			: `/api/workflows/${encodeURIComponent(id)}`;
		const res = await gatewayFetch(url);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function createWorkflow(workflow: { id: string; name: string; description: string; gates: WorkflowGate[] }, projectId?: string): Promise<Workflow | null> {
	try {
		const url = projectId
			? `/api/workflows?projectId=${encodeURIComponent(projectId)}`
			: "/api/workflows";
		const body = projectId ? { ...workflow, projectId } : workflow;
		const res = await gatewayFetch(url, {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		return await res.json();
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to create workflow", message, { code, stack });
		return null;
	}
}

export async function updateWorkflow(id: string, updates: Partial<Workflow>, projectId?: string): Promise<boolean> {
	try {
		const url = projectId ? `/api/workflows/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}` : `/api/workflows/${encodeURIComponent(id)}`;
		const res = await gatewayFetch(url, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		return true;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to update workflow", message, { code, stack });
		return false;
	}
}

export async function deleteWorkflow(id: string, projectId?: string): Promise<boolean> {
	try {
		const url = projectId ? `/api/workflows/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}` : `/api/workflows/${encodeURIComponent(id)}`;
		const res = await gatewayFetch(url, {
			method: "DELETE",
		});
		if (!res.ok && res.status !== 204) throw await errorFromResponse(res, `Failed: ${res.status}`);
		return true;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to delete workflow", message, { code, stack });
		return false;
	}
}



// ── Gate API ─────────────────────────────────────────────────────

export interface GateState {
	gateId: string;
	goalId: string;
	status: "pending" | "passed" | "failed";
	currentContent?: string;
	currentContentVersion?: number;
	currentMetadata?: Record<string, string>;
	signals: GateSignal[];
	updatedAt: number;
	// Enriched from workflow definition
	name?: string;
	dependsOn?: string[];
	signalCount?: number;
}

export interface GateSignal {
	id: string;
	gateId: string;
	goalId: string;
	sessionId: string;
	timestamp: number;
	commitSha: string;
	metadata?: Record<string, string>;
	content?: string;
	contentVersion?: number;
	verification: {
		status: "running" | "passed" | "failed";
		steps: Array<{
			name: string;
			type: string;
			passed: boolean;
			output: string;
			duration_ms: number;
			expect?: string;
			artifact?: {
				content: string;
				contentType: string;
				metadata?: Record<string, string>;
			};
			/** Lifecycle status for in-flight rows seeded by beginVerification. */
			status?: "waiting" | "running" | "passed" | "failed" | "skipped";
			/** Optional phase number, mirrored from the workflow VerifyStep. */
			phase?: number;
			/** True when the step was skipped (optional step or phase abort). */
			skipped?: boolean;
		}>;
	};
}

export async function fetchGoalGates(goalId: string): Promise<GateState[]> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/gates`);
		if (!res.ok) return [];
		const data = await res.json();
		return data.gates || [];
	} catch {
		return [];
	}
}

export async function fetchGateDetail(goalId: string, gateId: string): Promise<GateState | null> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/gates/${gateId}`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function fetchGateSignals(goalId: string, gateId: string): Promise<GateSignal[]> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/gates/${gateId}/signals`);
		if (!res.ok) return [];
		const data = await res.json();
		return data.signals || [];
	} catch {
		return [];
	}
}

export async function fetchGateContent(goalId: string, gateId: string): Promise<{ content?: string; version?: number }> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/gates/${gateId}/content`);
		if (!res.ok) return {};
		return await res.json();
	} catch {
		return {};
	}
}

// ============================================================================
// STAFF API
// ============================================================================

export interface StaffAgent {
	id: string;
	name: string;
	description: string;
	systemPrompt: string;
	cwd: string;
	state: "active" | "paused" | "retired";
	triggers: any[];
	memory: string;
	roleId?: string;
	createdAt: number;
	updatedAt: number;
	lastWakeAt?: number;
	currentSessionId?: string;
	projectId?: string;
	sandboxed?: boolean;
	contextPolicy?: "preserve" | "compact";
}

export async function fetchStaff(projectId?: string): Promise<StaffAgent[]> {
	try {
		const url = projectId ? `/api/staff?projectId=${encodeURIComponent(projectId)}` : "/api/staff";
		const res = await gatewayFetch(url);
		if (!res.ok) return [];
		const data = await res.json();
		return data.staff || data || [];
	} catch {
		return [];
	}
}

export async function fetchOrphanedStaff(): Promise<StaffAgent[]> {
	try {
		const res = await gatewayFetch("/api/staff/orphaned");
		if (!res.ok) return [];
		const data = await res.json();
		return data.staff || data || [];
	} catch {
		return [];
	}
}

export async function reassignStaffProject(id: string, projectId: string): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/staff/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ projectId }),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		return true;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to re-assign staff agent", message, { code, stack });
		return false;
	}
}

export async function fetchStaffAgent(id: string): Promise<StaffAgent | null> {
	try {
		const res = await gatewayFetch(`/api/staff/${id}`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function createStaffAgent(data: { name: string; description: string; systemPrompt: string; cwd?: string; worktree?: boolean; triggers?: any[]; projectId?: string; sandboxed?: boolean }): Promise<StaffAgent | null> {
	try {
		const res = await gatewayFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify(data),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		return await res.json();
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to create staff agent", message, { code, stack });
		return null;
	}
}

export async function updateStaffAgent(id: string, updates: Partial<Pick<StaffAgent, "name" | "description" | "systemPrompt" | "cwd" | "state" | "triggers" | "memory" | "contextPolicy">>): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/staff/${id}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		return true;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to update staff agent", message, { code, stack });
		return false;
	}
}

export async function deleteStaffAgent(id: string): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/staff/${id}`, { method: "DELETE" });
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		return true;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to delete staff agent", message, { code, stack });
		return false;
	}
}

/**
 * Manually enqueue an inbox entry against a staff agent. Replaces the
 * legacy `wakeStaffAgent` — the "Wake Now" button and the
 * AddToInboxDialog both target this endpoint. The agent picks up the
 * entry via the InboxNudger once it goes idle.
 *
 * Returns the created entry on success, or null on error (a connection
 * error modal is shown).
 */
export async function enqueueInboxManual(
	staffId: string,
	input: { title: string; prompt: string; context?: string; source?: { type?: "manual_api" | "manual_ui"; actorId?: string } },
): Promise<{ entry: { id: string; staffId: string; title: string; prompt: string; state: string; createdAt: number } } | null> {
	try {
		const body = {
			title: input.title,
			prompt: input.prompt,
			context: input.context,
			source: input.source ?? { type: "manual_ui" as const },
		};
		const res = await gatewayFetch(`/api/staff/${staffId}/inbox`, {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		return await res.json();
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to enqueue inbox entry", message, { code, stack });
		return null;
	}
}



// ============================================================================
// ROLE API
// ============================================================================

export interface RoleData {
	name: string;
	label: string;
	promptTemplate: string;
	toolPolicies?: Record<string, string>;
	accessory: string;
	/** "<provider>/<modelId>" — overrides default.sessionModel / default.reviewModel for sessions running as this role. */
	model?: string;
	/** "off" | "minimal" | "low" | "medium" | "high" | "xhigh" — overrides default.sessionThinkingLevel / default.reviewThinkingLevel. "xhigh" is auto-detected from per-model metadata when available; otherwise Bobbit falls back to known family rules (Claude Opus 4.6+, gpt-5.1-codex-max, gpt-5.2* / gpt-5.4* / gpt-5.5*). */
	thinkingLevel?: string;
	createdAt: number;
	updatedAt: number;
}

// ============================================================================
// ASSISTANT PROMPT API
// ============================================================================

export interface AssistantPromptInfo {
	type: string;
	title: string;
	prompt: string;
}

export async function updateAssistantPrompt(type: string, prompt: string): Promise<boolean> {
	const res = await gatewayFetch(`/api/roles/assistant/prompts/${encodeURIComponent(type)}`, {
		method: 'PUT',
		body: JSON.stringify({ prompt }),
	});
	return res.ok;
}

export async function fetchAssistantPrompts(): Promise<AssistantPromptInfo[]> {
	try {
		const res = await gatewayFetch("/api/roles/assistant/prompts");
		if (!res.ok) return [];
		const data = await res.json();
		return data.prompts || [];
	} catch {
		return [];
	}
}

export async function fetchRoles(): Promise<RoleData[]> {
	try {
		const res = await gatewayFetch("/api/roles");
		if (!res.ok) throw await errorFromResponse(res, `Failed to fetch roles: ${res.status}`);
		const data = await res.json();
		const roles: RoleData[] = data.roles || data || [];
		// Also cache into state for the role picker sidebar
		state.roles = roles.map((r) => ({
			name: r.name,
			label: r.label,
			accessory: r.accessory,
		}));
		return roles;
	} catch (err) {
		console.error("[role-api] fetchRoles failed:", err);
		return [];
	}
}

// ============================================================================
// MCP API
// ============================================================================

export interface McpOperationInfo {
	/** Bobbit-prefixed tool name: mcp__<server>__<op> or mcp__<server>__<sub>__<op>. */
	name: string;
	/** Description shown in the UI. */
	description: string;
	/**
	 * Sub-namespace for gateway-style servers (e.g. "ai-adoption" in
	 * `mcp__gr__ai-adoption__list-articles`). undefined ⇒ flat server.
	 * Server-side single source of truth: `parseMcpToolName()` in
	 * `src/server/mcp/mcp-meta.ts`.
	 */
	subNamespace?: string;
	/** Operation name (everything after the sub, or after the server if no sub). */
	op?: string;
}

export interface McpServerInfo {
	name: string;
	status: "connected" | "disconnected" | "error";
	toolCount: number;
	error?: string;
	tools: McpOperationInfo[];
}

/** GET /api/mcp-servers — returns one entry per registered MCP server with its operations. */
export async function fetchMcpServers(): Promise<McpServerInfo[]> {
	try {
		const res = await gatewayFetch("/api/mcp-servers");
		if (!res.ok) return [];
		const data = await res.json();
		if (!Array.isArray(data)) return [];
		return data as McpServerInfo[];
	} catch {
		return [];
	}
}

export interface ToolInfo {
	name: string;
	description: string;
	group: string;
	docs?: string;
	detail_docs?: string;
	hasRenderer?: boolean;
	rendererFile?: string;
	grantPolicy?: string;
}

export async function fetchTools(): Promise<ToolInfo[]> {
	try {
		const res = await gatewayFetch("/api/tools");
		if (!res.ok) throw await errorFromResponse(res, `Failed to fetch tools: ${res.status}`);
		const data = await res.json();
		const tools = data.tools || data || [];
		// Handle legacy string[] format
		if (tools.length > 0 && typeof tools[0] === "string") {
			return tools.map((name: string) => ({ name, description: "", group: "Other" }));
		}
		return tools;
	} catch (err) {
		console.error("[role-api] fetchTools failed:", err);
		return [];
	}
}

export async function fetchToolDetail(name: string): Promise<ToolInfo | null> {
	try {
		const res = await gatewayFetch(`/api/tools/${encodeURIComponent(name)}`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function updateTool(name: string, updates: { description?: string; group?: string; docs?: string; detail_docs?: string; grantPolicy?: string | null }): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/tools/${encodeURIComponent(name)}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		return true;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to update tool", message, { code, stack });
		return false;
	}
}

// ============================================================================
// TOOL GROUP POLICY API
// ============================================================================

export async function fetchGroupPolicies(): Promise<Record<string, string>> {
	try {
		const res = await gatewayFetch("/api/tool-group-policies");
		if (!res.ok) return {};
		const raw = await res.json();
		// The cascade endpoint returns { group: { policy, origin } } — normalize to flat { group: policy }
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(raw)) {
			if (typeof value === "string") {
				result[key] = value; // backward compat: old format
			} else if (value && typeof value === "object" && "policy" in (value as Record<string, unknown>)) {
				result[key] = (value as Record<string, unknown>).policy as string;
			}
		}
		return result;
	} catch {
		return {};
	}
}

export async function updateGroupPolicy(group: string, policy: string | null): Promise<void> {
	await gatewayFetch(`/api/tool-group-policies/${encodeURIComponent(group)}`, {
		method: "PUT",
		body: JSON.stringify({ policy }),
	});
}

export async function createRole(role: {
	name: string;
	label: string;
	promptTemplate: string;
	toolPolicies?: Record<string, string>;
	accessory: string;
}): Promise<RoleData | null> {
	try {
		const res = await gatewayFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify(role),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		return await res.json();
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to create role", message, { code, stack });
		return null;
	}
}

export async function updateRole(name: string, updates: Partial<Pick<RoleData, "label" | "promptTemplate" | "toolPolicies" | "accessory" | "model" | "thinkingLevel">>, projectId?: string): Promise<boolean> {
	try {
		const url = projectId ? `/api/roles/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}` : `/api/roles/${encodeURIComponent(name)}`;
		const res = await gatewayFetch(url, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		return true;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to update role", message, { code, stack });
		return false;
	}
}

export async function deleteRole(name: string, projectId?: string): Promise<boolean> {
	try {
		const url = projectId ? `/api/roles/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}` : `/api/roles/${encodeURIComponent(name)}`;
		const res = await gatewayFetch(url, {
			method: "DELETE",
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		return true;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to delete role", message, { code, stack });
		return false;
	}
}

// ============================================================================
// SETUP STATUS API
// ============================================================================

export async function fetchSetupStatus(): Promise<boolean> {
	try {
		const res = await gatewayFetch("/api/setup-status");
		if (!res.ok) return true; // assume complete on error
		const data = await res.json();
		return data.complete;
	} catch {
		return true;
	}
}

export async function dismissSetup(): Promise<void> {
	try {
		await gatewayFetch("/api/setup-status/dismiss", { method: "POST" });
	} catch { /* ignore */ }
	state.setupComplete = true;
	renderApp();
}

// ============================================================================
// SANDBOX STATUS API
// ============================================================================

export async function fetchSandboxStatus() {
	const res = await gatewayFetch("/api/sandbox-status");
	if (!res.ok) return null;
	return res.json();
}

// ============================================================================
// DRAFT API
// ============================================================================

/** Save a draft to the server. Fire-and-forget — errors are logged, not thrown. */
export async function saveDraftToServer(sessionId: string, type: string, data: unknown, signal?: AbortSignal): Promise<void> {
	try {
		await gatewayFetch(`/api/sessions/${sessionId}/draft`, {
			method: "PUT",
			body: JSON.stringify({ type, data }),
			signal,
		});
	} catch (err) {
		// Ignore aborted requests � they're intentionally cancelled on send
		if (err instanceof DOMException && err.name === "AbortError") return;
		console.error("[draft-api] Failed to save draft:", err);
	}
}

/** Load a draft from the server. Returns null if not found or on error. */
export async function loadDraftFromServer(sessionId: string, type: string): Promise<unknown | null> {
	try {
		const res = await gatewayFetch(`/api/sessions/${sessionId}/draft?type=${encodeURIComponent(type)}`);
		if (!res.ok) return null;
		const body = await res.json();
		return body.data ?? null;
	} catch (err) {
		console.error("[draft-api] Failed to load draft:", err);
		return null;
	}
}

/** Read a proposal snapshot without mutating the live draft. Returns server JSON or null on error. */
export async function readProposalSnapshot(
	sessionId: string,
	type: string,
	rev: number,
): Promise<{ ok: true; rev: number; fields: Record<string, unknown> } | { ok: false; code?: string; message?: string } | null> {
	try {
		const res = await gatewayFetch(
			`/api/sessions/${encodeURIComponent(sessionId)}/proposal/${encodeURIComponent(type)}/snapshot?rev=${encodeURIComponent(String(rev))}`,
		);
		const body = await res.json().catch(() => null);
		return body as any;
	} catch (err) {
		console.error("[proposal] readProposalSnapshot failed:", err);
		return null;
	}
}

/** Restore a proposal snapshot to the live draft. Returns server JSON or null on error. */
export async function restoreProposalSnapshot(
	sessionId: string,
	type: string,
	rev: number,
): Promise<{ ok: true; newRev: number; fields: Record<string, unknown> } | { ok: false; code?: string; message?: string } | null> {
	try {
		const res = await gatewayFetch(
			`/api/sessions/${encodeURIComponent(sessionId)}/proposal/${encodeURIComponent(type)}/restore`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rev }),
			},
		);
		const body = await res.json().catch(() => null);
		return body as any;
	} catch (err) {
		console.error("[proposal] restoreProposalSnapshot failed:", err);
		return null;
	}
}

/** Delete a draft from the server. Fire-and-forget — errors are logged, not thrown. */
export async function deleteDraftFromServer(sessionId: string, type: string): Promise<void> {
	try {
		await gatewayFetch(`/api/sessions/${sessionId}/draft?type=${encodeURIComponent(type)}`, {
			method: "DELETE",
		});
	} catch (err) {
		console.error("[draft-api] Failed to delete draft:", err);
	}
}
