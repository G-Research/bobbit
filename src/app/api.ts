import {
	state,
	renderApp,
	setProjectsIfChanged,
	type GatewaySession,
	type Goal,
	type Project,
} from "./state.js";
// Re-export for back-compat: many call sites import `gatewayFetch` from
// `./api.js`. The implementation now lives in `./gateway-fetch.js` (tiny,
// dependency-free) so utility modules like `fetch-tool-content.ts` can
// import it without pulling the entire app-shell graph.
import { gatewayFetch, GW_TOKEN_KEY, GW_URL_KEY } from "./gateway-fetch.js";
export { gatewayFetch };
import { sessionHueRotation, sessionColorMap } from "./session-colors.js";
import { RemoteAgent } from "./remote-agent.js";
import { showFaviconBadge } from "./favicon-badge.js";
import { clearGoalChildrenFetchedCache } from "./render-helpers.js";
import { needsHumanAttentionOnIdleTransition, needsImmediateHumanAttention } from "./notification-policy.js";
import { errorFromResponse, errorDetails } from "./error-helpers.js";
import { dispatchGateStatusCacheUpdated } from "./gate-status-events.js";
import { showHeaderToast } from "./header-toast.js";
import { ensureProjectPlayFinishSoundOverride } from "./play-finish-sound.js";
export { errorFromResponse, errorDetails };
// `dialogs.ts` is heavy (~90 kB) and only needed once the user opens a dialog;
// route these through `dialogs-lazy.js` so it stays out of the eager
// session-runtime chunk that imports this module. `countDescendants` is a
// synchronous pure helper, so it lives in its own tiny standalone module.
// (dialogs-lazy is a thin wrapper, so no api.ts↔dialogs.ts module-init cycle.)
import {
	confirmAction,
	showArchiveGoalDialog,
	showPauseGoalDialog,
	showResumeGoalDialog,
	showStopTeamDialog,
} from "./dialogs-lazy.js";
import { countDescendants } from "./goal-descendants-count.js";
import { isInitialSessionsLoad } from "./session-load-state.js";
import { expandSidebarTreeNode } from "./sidebar-tree-state.js";
import { HEADQUARTERS_PROJECT_ID, isHeadquartersProject } from "./headquarters.js";

function configApiProjectId(projectId?: string | null): string {
	const selected = projectId || state.activeProjectId || HEADQUARTERS_PROJECT_ID;
	return !selected || selected === "system" || isHeadquartersProject(selected) ? HEADQUARTERS_PROJECT_ID : selected;
}

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

export type SidebarCopyLinkTitle = "Copy session link" | "Copy goal link";

export function absoluteHashUrl(hash: string): string {
	const route = hash.startsWith("#")
		? hash
		: hash.startsWith("/")
			? `#${hash}`
			: `#/${hash}`;
	if (typeof location === "undefined") return route;
	return `${location.origin}${location.pathname}${location.search}${route}`;
}

export function sessionDeepLink(sessionId: string): string {
	return absoluteHashUrl(`/session/${encodeURIComponent(sessionId)}`);
}

export function sessionPathDeepLink(sessionId: string): string {
	const path = `/session/${encodeURIComponent(sessionId)}`;
	if (typeof location === "undefined") return path;
	return `${location.origin}${path}`;
}

export function goalDeepLink(goalId: string): string {
	return absoluteHashUrl(`/goal/${encodeURIComponent(goalId)}`);
}

/** Copy text via the async Clipboard API, falling back to a legacy
 *  execCommand("copy") path so text is still copied in insecure contexts
 *  (e.g. plain http:// over NordLynx) where the Clipboard API is blocked. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
	try {
		if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Clipboard API unavailable or rejected (insecure context) — fall through.
	}
	return legacyCopyText(text);
}

function legacyCopyText(text: string): boolean {
	if (typeof document === "undefined") return false;
	let ta: HTMLTextAreaElement | null = null;
	try {
		ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.style.position = "fixed";
		ta.style.top = "-1000px";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		ta.setSelectionRange(0, text.length);
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		ta?.remove();
	}
}

/** Flash the same "Link copied" toast the session header uses. `headerToast()`
 *  is rendered at the app-shell level in every view (landing, active session,
 *  disconnected), so `showHeaderToast` alone surfaces the toast everywhere —
 *  no standalone body fallback is needed (a fallback would double-mount the
 *  `data-testid="header-toast"` element on the landing view). */
async function flashSidebarToast(text: string): Promise<void> {
	try {
		showHeaderToast(text);
	} catch {
		// best-effort toast
	}
}

export async function copySidebarLink(url: string, title: SidebarCopyLinkTitle): Promise<void> {
	const copied = await copyTextToClipboard(url);
	if (!copied) console.warn(`[sidebar] ${title}: failed to copy link`, url);
	await flashSidebarToast(copied ? "Link copied" : "Couldn't copy link");
}

export type GoalGithubLinkResponse =
	| { available: true; url: string; kind: "pr" | "branch" }
	| { available: false; reason: "no-branch" | "no-github-remote" | "goal-not-found" };

const GOAL_GITHUB_LINK_POSITIVE_TTL_MS = 60_000;
const GOAL_GITHUB_LINK_NEGATIVE_TTL_MS = 10_000;

type GoalGithubLinkCacheEntry = {
	value: GoalGithubLinkResponse;
	fetchedAt: number;
};

const goalGithubLinkCache = new Map<string, GoalGithubLinkCacheEntry>();
const goalGithubLinkInFlight = new Map<string, Promise<GoalGithubLinkResponse>>();

function sameGoalGithubLink(a: GoalGithubLinkResponse | undefined, b: GoalGithubLinkResponse): boolean {
	if (!a || a.available !== b.available) return false;
	if (a.available && b.available) return a.url === b.url && a.kind === b.kind;
	if (!a.available && !b.available) return a.reason === b.reason;
	return false;
}

function isGoalGithubLinkCacheEntryFresh(entry: GoalGithubLinkCacheEntry): boolean {
	const ttl = entry.value.available ? GOAL_GITHUB_LINK_POSITIVE_TTL_MS : GOAL_GITHUB_LINK_NEGATIVE_TTL_MS;
	return Date.now() - entry.fetchedAt < ttl;
}

function getFreshGoalGithubLinkCacheEntry(goalId: string): GoalGithubLinkCacheEntry | undefined {
	const entry = goalGithubLinkCache.get(goalId);
	if (!entry) return undefined;
	if (isGoalGithubLinkCacheEntryFresh(entry)) return entry;
	goalGithubLinkCache.delete(goalId);
	return undefined;
}

function cacheGoalGithubLink(goalId: string, value: GoalGithubLinkResponse, skipRender = false): GoalGithubLinkResponse {
	const changed = !sameGoalGithubLink(goalGithubLinkCache.get(goalId)?.value, value);
	goalGithubLinkCache.set(goalId, { value, fetchedAt: Date.now() });
	if (changed && !skipRender) renderApp();
	return value;
}

function parseGoalGithubLinkResponse(value: unknown): GoalGithubLinkResponse {
	if (!value || typeof value !== "object") throw new Error("Invalid GitHub link response");
	const data = value as Partial<GoalGithubLinkResponse>;
	if (data.available === true) {
		const url = (data as { url?: unknown }).url;
		const kind = (data as { kind?: unknown }).kind;
		if (typeof url === "string" && (kind === "pr" || kind === "branch")) return { available: true, url, kind };
	}
	if (data.available === false) {
		const reason = (data as { reason?: unknown }).reason;
		if (reason === "no-branch" || reason === "no-github-remote" || reason === "goal-not-found") return { available: false, reason };
	}
	throw new Error("Invalid GitHub link response");
}

export function getCachedGoalGithubLink(goalId: string): GoalGithubLinkResponse | undefined {
	const prUrl = state.prStatusCache.get(goalId)?.url;
	if (prUrl) return { available: true, url: prUrl, kind: "pr" };
	return getFreshGoalGithubLinkCacheEntry(goalId)?.value;
}

export function clearGoalGithubLinkCache(goalId?: string): void {
	if (goalId) {
		goalGithubLinkCache.delete(goalId);
		goalGithubLinkInFlight.delete(goalId);
	} else {
		goalGithubLinkCache.clear();
		goalGithubLinkInFlight.clear();
	}
}

export async function fetchGoalGithubLink(goalId: string, opts?: { force?: boolean; skipRender?: boolean }): Promise<GoalGithubLinkResponse> {
	const prUrl = state.prStatusCache.get(goalId)?.url;
	if (prUrl) return { available: true, url: prUrl, kind: "pr" };

	if (!opts?.force) {
		const cached = getFreshGoalGithubLinkCacheEntry(goalId)?.value;
		if (cached) return cached;
		const inFlight = goalGithubLinkInFlight.get(goalId);
		if (inFlight) return inFlight;
	}

	const request = (async () => {
		const res = await gatewayFetch(`/api/goals/${encodeURIComponent(goalId)}/github-link`);
		if (res.status === 404) return cacheGoalGithubLink(goalId, { available: false, reason: "goal-not-found" }, opts?.skipRender);
		if (!res.ok) throw new Error(`Failed to fetch goal GitHub link: ${res.status}`);
		return cacheGoalGithubLink(goalId, parseGoalGithubLinkResponse(await res.json()), opts?.skipRender);
	})();
	goalGithubLinkInFlight.set(goalId, request);
	try {
		return await request;
	} finally {
		if (goalGithubLinkInFlight.get(goalId) === request) goalGithubLinkInFlight.delete(goalId);
	}
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

const SESSION_LIST_PUSH_REFRESH_DEBOUNCE_MS = 100;
const SESSION_LIST_PUSH_RECONNECT_MS = 3_000;
let sessionListPushRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let sessionListPushRefreshInFlight = false;
let sessionListPushRefreshQueued = false;
let sessionListPushStaffRefreshNeeded = false;
let sessionListPushWs: WebSocket | null = null;
let sessionListPushReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let sessionListPushIntentionalClose = false;
let sessionListPushVisibilityHandlerInstalled = false;

function canRefreshSessionListFromPush(): boolean {
	if (state.appView !== "authenticated") return false;
	if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
	return true;
}

function canConnectSessionListPush(): boolean {
	if (state.appView !== "authenticated") return false;
	if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
	return !!localStorage.getItem(GW_TOKEN_KEY);
}

async function refreshClientListsFromPush(includeStaff: boolean): Promise<void> {
	if (includeStaff) {
		await refreshStaffStateFromApi();
	}
	await refreshSessions();
}

function scheduleClientListRefreshFromPush(includeStaff: boolean): void {
	if (!canRefreshSessionListFromPush()) return;
	if (includeStaff) sessionListPushStaffRefreshNeeded = true;
	if (sessionListPushRefreshTimer) return;
	if (sessionListPushRefreshInFlight) {
		sessionListPushRefreshQueued = true;
		return;
	}

	sessionListPushRefreshTimer = setTimeout(() => {
		sessionListPushRefreshTimer = null;
		if (!canRefreshSessionListFromPush()) return;
		const refreshStaff = sessionListPushStaffRefreshNeeded;
		sessionListPushStaffRefreshNeeded = false;
		sessionListPushRefreshInFlight = true;
		void refreshClientListsFromPush(refreshStaff)
			.catch((err) => console.warn("[session-list-push] refresh failed:", err))
			.finally(() => {
				sessionListPushRefreshInFlight = false;
				if (sessionListPushRefreshQueued || sessionListPushStaffRefreshNeeded) {
					sessionListPushRefreshQueued = false;
					scheduleClientListRefreshFromPush(false);
				}
			});
	}, SESSION_LIST_PUSH_REFRESH_DEBOUNCE_MS);
}

export function scheduleSessionListRefreshFromPush(): void {
	scheduleClientListRefreshFromPush(false);
}

export function scheduleStaffListRefreshFromPush(): void {
	scheduleClientListRefreshFromPush(true);
}

function sessionListPushWsUrl(): string {
	const configured = localStorage.getItem(GW_URL_KEY) || window.location.origin;
	return `${configured.replace(/\/$/, "").replace(/^http/i, "ws")}/ws/viewer`;
}

function clearSessionListPushReconnect(): void {
	if (sessionListPushReconnectTimer) {
		clearTimeout(sessionListPushReconnectTimer);
		sessionListPushReconnectTimer = null;
	}
}

function scheduleSessionListPushReconnect(): void {
	clearSessionListPushReconnect();
	if (sessionListPushIntentionalClose) return;
	if (!canConnectSessionListPush()) return;
	sessionListPushReconnectTimer = setTimeout(() => {
		sessionListPushReconnectTimer = null;
		startSessionListPushSync();
	}, SESSION_LIST_PUSH_RECONNECT_MS);
}

export function startSessionListPushSync(): void {
	if (!canConnectSessionListPush()) return;
	const token = localStorage.getItem(GW_TOKEN_KEY)!;
	if (sessionListPushWs && (sessionListPushWs.readyState === WebSocket.OPEN || sessionListPushWs.readyState === WebSocket.CONNECTING)) return;

	sessionListPushIntentionalClose = false;
	clearSessionListPushReconnect();

	const ws = new WebSocket(sessionListPushWsUrl());
	sessionListPushWs = ws;

	ws.addEventListener("open", () => {
		try { ws.send(JSON.stringify({ type: "auth", token })); } catch { /* close handler reconnects */ }
	});

	ws.addEventListener("message", (event) => {
		try {
			const msg = JSON.parse(event.data as string);
			if (msg?.type === "session_created" || msg?.type === "sessions_changed" || msg?.type === "session_removed") {
				scheduleSessionListRefreshFromPush();
			} else if (msg?.type === "staff_changed") {
				scheduleStaffListRefreshFromPush();
			}
		} catch {
			// ignore malformed frames
		}
	});

	ws.addEventListener("close", () => {
		if (sessionListPushWs === ws) sessionListPushWs = null;
		scheduleSessionListPushReconnect();
	});

	ws.addEventListener("error", () => {
		// close follows error and owns reconnection
	});
}

export function stopSessionListPushSync(): void {
	sessionListPushIntentionalClose = true;
	clearSessionListPushReconnect();
	if (sessionListPushRefreshTimer) {
		clearTimeout(sessionListPushRefreshTimer);
		sessionListPushRefreshTimer = null;
	}
	sessionListPushRefreshQueued = false;
	sessionListPushStaffRefreshNeeded = false;
	if (sessionListPushWs && (sessionListPushWs.readyState === WebSocket.OPEN || sessionListPushWs.readyState === WebSocket.CONNECTING)) {
		sessionListPushWs.close();
	}
	sessionListPushWs = null;
}

function installSessionListPushVisibilityHandler(): void {
	if (sessionListPushVisibilityHandlerInstalled || typeof document === "undefined") return;
	sessionListPushVisibilityHandlerInstalled = true;
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		if (state.appView !== "authenticated") return;
		startSessionListPushSync();
	});
}

export function startSessionPolling(): void {
	stopSessionPolling();
	installSessionListPushVisibilityHandler();
	startSessionListPushSync();
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
	stopSessionListPushSync();
}

/**
 * Clear any sessions-fetch error and re-fetch. Used by the sidebar/landing
 * "Retry" buttons: clearing the error lets `isInitialSessionsLoad` show the
 * one-time spinner again on a genuine retry after an initial-load failure.
 */
export function retryLoadSessions(): void {
	state.sessionsError = "";
	refreshSessions();
}

export async function refreshSessions(): Promise<void> {
	const isInitial = isInitialSessionsLoad({
		gatewaySessionsLength: state.gatewaySessions.length,
		sessionsGeneration: state.sessionsGeneration,
		sessionsError: state.sessionsError,
	});
	if (isInitial) {
		state.sessionsLoading = true;
		state.sessionsError = "";
		renderApp();
	}

	let sessionsChanged = false;
	let goalsChanged = false;
	let projectsChanged = false;

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
			// available on the very first render and landing/mobile pages without
			// an active session still pick up cross-tab project reorder changes.
			fetchProjectsSnapshot(),
		]);
		// Apply projects before processing sessions so renderApp() already has
		// the correct project list for sidebar grouping. The equality gate avoids
		// repainting every 5s polling tick when order/content is unchanged.
		if (projectsResult !== null) {
			projectsChanged = setProjectsIfChanged(projectsResult);
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

			// Warm each source-project override without delaying session state,
			// transitions, badges, or completion of this refresh.
			for (const projectId of new Set(newSessions.map((session) => session.projectId))) {
				if (projectId) void ensureProjectPlayFinishSoundOverride(projectId);
			}

			// Beep when a non-active background session finishes streaming
			const activeId = state.remoteAgent?.gatewaySessionId;
			for (const s of newSessions) {
				const prev = _prevSessionStatus.get(s.id);
				if (prev === "streaming" && s.status === "idle" && s.id !== activeId) {
					const goalId = s.teamGoalId || s.goalId;
					const goal = goalId ? state.goals.find(g => g.id === goalId) : undefined;
					if (needsHumanAttentionOnIdleTransition(s, goal, newSessions, state.gateStatusCache)
						|| needsImmediateHumanAttention(s, state.gateStatusCache)) {
						void RemoteAgent.playNotificationBeep(s);
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
				// Goal branch/repo metadata drives the GitHub menu link; invalidate lazy
				// lookups whenever the goal list changes so negative entries don't stick
				// after a branch or remote becomes available.
				clearGoalGithubLinkCache();
				// Auto-expand only newly discovered top-level goals that have live
				// owning sessions after the initial hydration. Automatic expansion is
				// non-explicit so it cannot override a user's explicit collapse
				// preference. Sub-goals never auto-open themselves or their parent just
				// because polling discovered them.
				if (!isInitial) {
					for (const g of incoming) {
						if (!prevGoalIds.has(g.id) && !g.parentGoalId && state.gatewaySessions.some((s) => s.goalId === g.id || s.teamGoalId === g.id)) {
							expandSidebarTreeNode({ kind: "goal", goalId: g.id }, { explicit: false });
						}
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
		if (sessionsChanged || goalsChanged || projectsChanged || isInitial) {
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
 *  field, which leaves the dedicated archived-goals page unfetched. */
export function archivedGoalsLoaded(): boolean {
	return _archivedGoalsLoaded;
}

/** Reset the archived sessions state (flag + data). Called on toggle-off. */
export function clearArchivedSessionsState(): void {
	_archivedSessionsLoaded = false;
	_archivedGoalsLoaded = false;
	state.archivedSessions = [];
	clearArchivedSearchState();
	clearGoalChildrenFetchedCache();
}

/** Fetch archived sessions from the API (paginated). */
export async function fetchArchivedSessions(): Promise<void> {
	if (state.showArchived && state.searchQuery.trim()) {
		scheduleArchivedRemoteSearch(state.searchQuery);
		return;
	}
	_archivedSessionsLoaded = true;
	// Reset pagination state and load first page — but don't clear archivedSessions
	// to preserve BFS-enriched delegates from the live poll
	state.archivedSessionsCursor = null;
	state.archivedSessionsHasMore = false;
	state.archivedSessionsTotal = 0;
	await fetchArchivedSessionsPaginated();
}

const ARCHIVED_SEARCH_DEBOUNCE_MS = 250;
let _archivedSearchTimer: ReturnType<typeof setTimeout> | null = null;
let _archivedSearchRunId = 0;

function resetArchivedSearchPagination(query = ""): void {
	state.archivedSearchQuery = query;
	state.archivedSearchGoalsCursor = null;
	state.archivedSearchGoalsHasMore = false;
	state.archivedSearchGoalsTotal = 0;
	state.archivedSearchGoalsLoading = false;
	state.archivedSearchSessionsCursor = null;
	state.archivedSearchSessionsHasMore = false;
	state.archivedSearchSessionsTotal = 0;
	state.archivedSearchSessionsLoading = false;
}

export function clearArchivedSearchState(): void {
	if (_archivedSearchTimer) {
		clearTimeout(_archivedSearchTimer);
		_archivedSearchTimer = null;
	}
	_archivedSearchRunId++;
	resetArchivedSearchPagination();
}

function mergeArchivedGoalsIntoState(goals: Goal[]): void {
	if (goals.length === 0) return;
	const incoming = new Map(goals.map((g) => [g.id, g]));
	const seen = new Set<string>();
	state.goals = state.goals.map((g) => {
		const next = incoming.get(g.id);
		if (!next) return g;
		seen.add(g.id);
		return next;
	});
	for (const goal of goals) {
		if (!seen.has(goal.id)) state.goals.push(goal);
	}
}

function isArchivedSessionRecord(session: GatewaySession): boolean {
	return session.archived === true || session.status === "archived";
}

function mergeArchivedSessionsIntoState(sessions: GatewaySession[]): void {
	if (sessions.length === 0) return;
	const incoming = new Map(sessions.map((s) => [s.id, s]));
	const seen = new Set<string>();
	state.archivedSessions = state.archivedSessions.map((s) => {
		const next = incoming.get(s.id);
		if (!next) return s;
		seen.add(s.id);
		return next;
	});
	for (const session of sessions) {
		if (!seen.has(session.id)) state.archivedSessions.push(session);
	}
}

function archivedSearchStillCurrent(query: string, runId: number): boolean {
	return runId === _archivedSearchRunId
		&& state.showArchived
		&& state.searchQuery.trim() === query;
}

export function scheduleArchivedRemoteSearch(query: string, delay = ARCHIVED_SEARCH_DEBOUNCE_MS): void {
	const trimmed = query.trim();
	if (_archivedSearchTimer) {
		clearTimeout(_archivedSearchTimer);
		_archivedSearchTimer = null;
	}
	if (!trimmed || !state.showArchived) {
		clearArchivedSearchState();
		return;
	}
	const runId = ++_archivedSearchRunId;
	if (state.archivedSearchQuery !== trimmed) {
		resetArchivedSearchPagination(trimmed);
	}
	state.archivedSearchQuery = trimmed;
	state.archivedSearchGoalsLoading = true;
	state.archivedSearchSessionsLoading = true;
	_archivedSearchTimer = setTimeout(() => {
		_archivedSearchTimer = null;
		void Promise.all([
			fetchArchivedSearchGoalsPage(50, undefined, trimmed, runId),
			fetchArchivedSearchSessionsPage(50, undefined, trimmed, runId),
		]);
	}, delay);
}

export async function fetchArchivedSearchGoalsPaginated(limit = 50, afterCursor?: number): Promise<void> {
	const query = state.searchQuery.trim();
	if (!query || !state.showArchived) return;
	state.archivedSearchQuery = query;
	await fetchArchivedSearchGoalsPage(limit, afterCursor, query, _archivedSearchRunId);
}

export async function fetchArchivedSearchSessionsPaginated(limit = 50, afterCursor?: number): Promise<void> {
	const query = state.searchQuery.trim();
	if (!query || !state.showArchived) return;
	state.archivedSearchQuery = query;
	await fetchArchivedSearchSessionsPage(limit, afterCursor, query, _archivedSearchRunId);
}

async function fetchArchivedSearchGoalsPage(limit: number, afterCursor: number | undefined, query: string, runId: number): Promise<void> {
	state.archivedSearchGoalsLoading = true;
	renderApp();
	try {
		const params = new URLSearchParams({ archived: "true", limit: String(limit), q: query });
		if (afterCursor !== undefined) params.set("after", String(afterCursor));
		const res = await gatewayFetch(`/api/goals?${params}`);
		if (!res.ok || !archivedSearchStillCurrent(query, runId)) return;
		const data = await res.json();
		if (!archivedSearchStillCurrent(query, runId)) return;
		const goals: Goal[] = (data.goals || []).filter((g: Goal) => g.archived === true);
		mergeArchivedGoalsIntoState(goals);
		const affiliatedSessions: GatewaySession[] = (data.archivedSessions || []).filter(isArchivedSessionRecord);
		mergeArchivedSessionsIntoState(affiliatedSessions);
		state.archivedSearchGoalsTotal = data.total ?? goals.length;
		state.archivedSearchGoalsHasMore = data.hasMore ?? false;
		state.archivedSearchGoalsCursor = data.nextCursor ?? null;
	} catch {
		// Silently fail; local already-loaded archive filtering still works.
	} finally {
		if (archivedSearchStillCurrent(query, runId)) {
			state.archivedSearchGoalsLoading = false;
			renderApp();
		}
	}
}

async function fetchArchivedSearchSessionsPage(limit: number, afterCursor: number | undefined, query: string, runId: number): Promise<void> {
	state.archivedSearchSessionsLoading = true;
	renderApp();
	try {
		const params = new URLSearchParams({ include: "archived", limit: String(limit), q: query });
		if (afterCursor !== undefined) params.set("after", String(afterCursor));
		const res = await gatewayFetch(`/api/sessions?${params}`);
		if (!res.ok || !archivedSearchStillCurrent(query, runId)) return;
		const data = await res.json();
		if (!archivedSearchStillCurrent(query, runId)) return;
		const sessions: GatewaySession[] = (data.sessions || []).filter(isArchivedSessionRecord);
		const archivedDelegates: GatewaySession[] = (data.archivedDelegates || []).filter(isArchivedSessionRecord);
		mergeArchivedSessionsIntoState([...sessions, ...archivedDelegates]);
		state.archivedSearchSessionsTotal = data.total ?? sessions.length;
		state.archivedSearchSessionsHasMore = data.hasMore ?? false;
		state.archivedSearchSessionsCursor = data.nextCursor ?? null;
	} catch {
		// Silently fail; local already-loaded archive filtering still works.
	} finally {
		if (archivedSearchStillCurrent(query, runId)) {
			state.archivedSearchSessionsLoading = false;
			renderApp();
		}
	}
}

// ============================================================================
// SEARCH API
// ============================================================================

export async function searchApi(query: string, type?: string, limit?: number, offset?: number): Promise<{ results: any[]; total: number }> {
	try {
		const params = new URLSearchParams({ q: query, includeArchived: "true" });
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

async function fetchProjectsSnapshot(): Promise<Project[] | null> {
  try {
    const res = await gatewayFetch("/api/projects");
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data?.projects)) return data.projects;
    return Array.isArray(data) ? data : [];
  } catch {
    return null;
  }
}

export async function fetchProjects(): Promise<Project[]> {
  return (await fetchProjectsSnapshot()) ?? [];
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

/**
 * Monorepo workspace frameworks detected at `rootPath`. Mirrors the server-
 * side `MonorepoFramework` union (see `src/server/agent/monorepo-scan.ts`).
 */
export type MonorepoFramework =
  | "pnpm"
  | "npm-yarn-workspaces"
  | "nx"
  | "turbo"
  | "lerna"
  | "cargo"
  | "go"
  | "gradle";

export interface MonorepoCandidate {
  relativePath: string;
  frameworks: MonorepoFramework[];
  packageName?: string;
}

export interface MonorepoScanResult {
  frameworks: MonorepoFramework[];
  candidates: MonorepoCandidate[];
  truncated: boolean;
  totalCount: number;
}

export interface ProjectScanResult {
  repos: DetectedRepo[];
  monorepo?: MonorepoScanResult;
}

/**
 * Full server payload from POST /api/projects/scan — `{ repos, monorepo }`.
 * Use this when you need the monorepo block (V2 Add-Project flow); legacy
 * call sites that only want `repos` should keep using `scanProjectRepos`.
 */
export async function scanProject(dirPath: string): Promise<ProjectScanResult> {
  const res = await gatewayFetch(`/api/projects/scan?path=${encodeURIComponent(dirPath)}`, {
    method: 'POST',
    body: JSON.stringify({ path: dirPath }),
  });
  if (!res.ok) throw new Error(`Scan failed (${res.status})`);
  const data = await res.json();
  const repos = Array.isArray(data?.repos) ? data.repos as DetectedRepo[] : [];
  const monorepo = data?.monorepo && typeof data.monorepo === "object"
    ? data.monorepo as MonorepoScanResult
    : undefined;
  return { repos, monorepo };
}

export async function scanProjectRepos(dirPath: string): Promise<DetectedRepo[]> {
  const { repos } = await scanProject(dirPath);
  return repos;
}

export async function browseDirectory(dirPath?: string, options?: { prefix?: string; limit?: number }): Promise<{
  current: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
  truncated?: boolean;
}> {
  const params = new URLSearchParams();
  if (dirPath) params.set("path", dirPath);
  const prefix = options?.prefix;
  if (prefix) params.set("prefix", prefix);
  if (typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0) {
    params.set("limit", String(Math.floor(options.limit)));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await gatewayFetch(`/api/browse-directory${suffix}`);
  if (!res.ok) throw new Error('Browse failed');
  return res.json();
}

export async function createDirectory(dirPath: string): Promise<{ path: string }> {
  const res = await gatewayFetch("/api/create-directory", {
    method: "POST",
    body: JSON.stringify({ path: dirPath }),
  });
  if (!res.ok) throw await errorFromResponse(res, `Failed to create directory: ${res.status}`);
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
    const { message, code, stack } = errorDetails(err);
    showConnectionError("Failed to promote project", message, { code, stack });
    return null;
  }
}

// ============================================================================
// PAGINATED ARCHIVES
// ============================================================================

export async function fetchArchivedGoalsPaginated(limit = 50, afterCursor?: number): Promise<void> {
	if (afterCursor === undefined && state.showArchived && state.searchQuery.trim()) {
		scheduleArchivedRemoteSearch(state.searchQuery);
		return;
	}
	try {
		const params = new URLSearchParams({ archived: "true", limit: String(limit) });
		if (afterCursor !== undefined) params.set("after", String(afterCursor));
		const res = await gatewayFetch(`/api/goals?${params}`);
		if (!res.ok) return;
		// Mark the dedicated archived-goals page as fetched for non-search archive pagination.
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
	if (afterCursor === undefined && state.showArchived && state.searchQuery.trim()) {
		scheduleArchivedRemoteSearch(state.searchQuery);
		return;
	}
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

export interface GateStatusSummaryGate {
	gateId: string;
	name?: string;
	status: "pending" | "passed" | "failed" | "bypassed";
	effectiveStatus: "pending" | "passed" | "failed" | "running";
	running: boolean;
	awaitingSignoffCount: number;
	dependsOn: string[];
	signalCount: number;
	updatedAt?: number;
	failedSteps?: string[];
}

export interface GateStatusSummary {
	passed: number;
	/** Count of gates a human forced past verification. Distinct from passed. */
	bypassed: number;
	/** Alias for `bypassed` — server emits both names. */
	bypassedCount: number;
	total: number;
	verifying: boolean;
	verifyingCount: number;
	awaitingSignoffCount: number;
	awaitingHumanSignoff: boolean;
	runningGateIds: string[];
	gates: GateStatusSummaryGate[];
}

function emptyGateStatusSummary(): GateStatusSummary {
	return {
		passed: 0,
		bypassed: 0,
		bypassedCount: 0,
		total: 0,
		verifying: false,
		verifyingCount: 0,
		awaitingSignoffCount: 0,
		awaitingHumanSignoff: false,
		runningGateIds: [],
		gates: [],
	};
}

function normalizeGateStatusSummary(data: any): GateStatusSummary {
	const raw = data?.summary && typeof data.summary === "object" ? data.summary : data;
	const awaitingSignoffCount = typeof raw?.awaitingSignoffCount === "number" ? raw.awaitingSignoffCount : 0;
	const runningGateIds = Array.isArray(raw?.runningGateIds) ? raw.runningGateIds.filter((id: unknown): id is string => typeof id === "string") : [];
	const bypassed = typeof raw?.bypassed === "number"
		? raw.bypassed
		: (typeof raw?.bypassedCount === "number" ? raw.bypassedCount : 0);
	return {
		passed: typeof raw?.passed === "number" ? raw.passed : 0,
		bypassed,
		bypassedCount: bypassed,
		total: typeof raw?.total === "number" ? raw.total : (Array.isArray(data?.gates) ? data.gates.length : 0),
		verifying: typeof raw?.verifying === "boolean" ? raw.verifying : runningGateIds.length > 0,
		verifyingCount: typeof raw?.verifyingCount === "number" ? raw.verifyingCount : runningGateIds.length,
		awaitingSignoffCount,
		awaitingHumanSignoff: typeof raw?.awaitingHumanSignoff === "boolean" ? raw.awaitingHumanSignoff : awaitingSignoffCount > 0,
		runningGateIds,
		gates: Array.isArray(raw?.gates) ? raw.gates : (Array.isArray(data?.gates) ? data.gates : []),
	};
}

async function fetchGateStatusSummary(goalId: string): Promise<GateStatusSummary> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/gates?view=summary`);
		if (!res.ok) return emptyGateStatusSummary();
		return normalizeGateStatusSummary(await res.json());
	} catch {
		return emptyGateStatusSummary();
	}
}

function applyGateStatusSummary(goalId: string, summary: GateStatusSummary): boolean {
	const prev = state.gateStatusCache.get(goalId);
	const next = {
		passed: summary.passed,
		bypassed: summary.bypassed,
		total: summary.total,
		verifying: summary.verifying,
		verifyingCount: summary.verifyingCount,
		awaitingSignoffCount: summary.awaitingSignoffCount,
		awaitingHumanSignoff: summary.awaitingHumanSignoff,
		runningGateIds: summary.runningGateIds,
		gates: summary.gates,
	};
	if (!prev
		|| prev.passed !== next.passed
		|| prev.bypassed !== next.bypassed
		|| prev.total !== next.total
		|| prev.verifying !== next.verifying
		|| prev.verifyingCount !== next.verifyingCount
		|| prev.awaitingSignoffCount !== next.awaitingSignoffCount
		|| prev.awaitingHumanSignoff !== next.awaitingHumanSignoff
		|| JSON.stringify(prev.runningGateIds ?? []) !== JSON.stringify(next.runningGateIds)
		|| JSON.stringify(prev.gates ?? []) !== JSON.stringify(next.gates)) {
		state.gateStatusCache.set(goalId, next);
		dispatchGateStatusCacheUpdated(goalId);
		return true;
	}
	return false;
}

/** Fetch gate statuses for all goals with workflows and update the cache.
 *  Returns true if any data changed. When skipRender is true, the caller is responsible for renderApp(). */
async function refreshGateStatusCache(skipRender = false): Promise<boolean> {
	const goalsWithWorkflow = state.goals.filter(g => g.workflow && g.workflow.gates.length > 0);
	if (goalsWithWorkflow.length === 0) return false;

	const results = await Promise.all(goalsWithWorkflow.map(async (g) => {
		const token = reserveGateStatusRefreshToken(g.id);
		return {
			goalId: g.id,
			token,
			summary: await fetchGateStatusSummary(g.id),
		};
	}));

	let changed = false;
	for (const { goalId, token, summary } of results) {
		if (!isLatestGateStatusRefresh(goalId, token)) continue;
		changed = applyGateStatusSummary(goalId, summary) || changed;
	}
	if (changed && !skipRender) renderApp();
	return changed;
}

const scheduledGateStatusRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
const gateStatusRefreshTokens = new Map<string, number>();

function reserveGateStatusRefreshToken(goalId: string): number {
	const next = (gateStatusRefreshTokens.get(goalId) ?? 0) + 1;
	gateStatusRefreshTokens.set(goalId, next);
	return next;
}

function isLatestGateStatusRefresh(goalId: string, token: number): boolean {
	return gateStatusRefreshTokens.get(goalId) === token;
}

export function scheduleGateStatusRefreshForGoal(goalId: string | null | undefined, delayMs = 50): void {
	if (!goalId) return;
	const token = reserveGateStatusRefreshToken(goalId);
	const existing = scheduledGateStatusRefreshes.get(goalId);
	if (existing) clearTimeout(existing);
	scheduledGateStatusRefreshes.set(goalId, setTimeout(() => {
		scheduledGateStatusRefreshes.delete(goalId);
		void refreshGateStatusForGoal(goalId, token);
	}, delayMs));
}

/** Refresh gate status cache for a single goal (called from WS event handlers). */
export async function refreshGateStatusForGoal(goalId: string, token = reserveGateStatusRefreshToken(goalId)): Promise<void> {
	const goal = state.goals.find(g => g.id === goalId);
	if (!goal?.workflow?.gates.length) return;
	const summary = await fetchGateStatusSummary(goalId);
	if (!isLatestGateStatusRefresh(goalId, token)) return;
	if (applyGateStatusSummary(goalId, summary)) renderApp();
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
				const res = await gatewayFetch(`/api/goals/${g.id}/pr-status?optional=1`);
				if (res.status === 204 || res.status === 404) return { goalId: g.id, pr: null, noPr: true };
				if (!res.ok) return { goalId: g.id, pr: null, noPr: false };
				const data = await res.json();
				return { goalId: g.id, pr: data as { state: string; url?: string; number?: number; reviewDecision?: string; mergeable?: string; viewerCanMergeAsAdmin?: boolean }, noPr: false };
			} catch {
				return { goalId: g.id, pr: null, noPr: false };
			}
		})
	);

	let changed = false;
	for (const { goalId, pr, noPr } of results) {
		const prev = state.prStatusCache.get(goalId);
		if (pr) {
			if (!prev
				|| prev.state !== pr.state
				|| prev.reviewDecision !== pr.reviewDecision
				|| prev.mergeable !== pr.mergeable
				|| prev.viewerCanMergeAsAdmin !== pr.viewerCanMergeAsAdmin) {
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

export async function createGoal(title: string, cwd: string, opts?: { spec?: string; workflowId?: string; reattemptOf?: string; sandboxed?: boolean; projectId?: string; enabledOptionalSteps?: string[]; autoStartTeam?: boolean; workflow?: unknown; inlineRoles?: Record<string, unknown>; subgoalsAllowed?: boolean; maxNestingDepth?: number; divergencePolicy?: "strict" | "balanced" | "autonomous"; maxConcurrentChildren?: number; parentGoalId?: string; metadata?: Record<string, unknown> }): Promise<Goal | null> {
	const { spec = "", workflowId, reattemptOf, sandboxed, projectId, enabledOptionalSteps, autoStartTeam, workflow, inlineRoles, subgoalsAllowed, maxNestingDepth, divergencePolicy, maxConcurrentChildren, parentGoalId, metadata } = opts ?? {};
	try {
		const body: Record<string, any> = { title, spec, team: true, worktree: !isHeadquartersProject(projectId) };
		const trimmedCwd = typeof cwd === "string" ? cwd.trim() : "";
		if (trimmedCwd) body.cwd = trimmedCwd;
		if (workflowId) body.workflowId = workflowId;
		if (reattemptOf) body.reattemptOf = reattemptOf;
		if (sandboxed !== undefined) body.sandboxed = !!sandboxed;
		if (projectId) body.projectId = projectId;
		if (enabledOptionalSteps?.length) body.enabledOptionalSteps = enabledOptionalSteps;
		if (autoStartTeam !== undefined) body.autoStartTeam = autoStartTeam;
		if (workflow !== undefined) body.workflow = workflow;
		if (inlineRoles !== undefined && inlineRoles !== null && Object.keys(inlineRoles).length > 0) {
			body.inlineRoles = inlineRoles;
		}
		if (subgoalsAllowed !== undefined) body.subgoalsAllowed = subgoalsAllowed;
		if (maxNestingDepth !== undefined) body.maxNestingDepth = maxNestingDepth;
		if (divergencePolicy !== undefined) body.divergencePolicy = divergencePolicy;
		if (maxConcurrentChildren !== undefined) body.maxConcurrentChildren = maxConcurrentChildren;
		if (parentGoalId) body.parentGoalId = parentGoalId;
		// Hierarchical per-goal metadata: forward only when it is a non-empty
		// plain object. Absent/empty metadata is dropped entirely so the goal
		// resolves to no override — byte-identical to current behaviour.
		if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && Object.keys(metadata).length > 0) {
			body.metadata = metadata;
		}
		const res = await gatewayFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed to create goal: ${res.status}`);
		const goal = await res.json() as Goal;
		await refreshSessions();
		const goalsById = new Map(state.goals.map(g => [g.id, g]));
		let cursor: Goal | undefined = goalsById.get(goal.id) ?? goal;
		const seenGoalIds = new Set<string>();
		while (cursor && !seenGoalIds.has(cursor.id)) {
			seenGoalIds.add(cursor.id);
			expandSidebarTreeNode({ kind: "goal", goalId: cursor.id }, { explicit: false });
			cursor = cursor.parentGoalId ? goalsById.get(cursor.parentGoalId) : undefined;
		}
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

/**
 * Update an existing goal's per-goal sub-goal policy via
 * `PATCH /api/goals/:id/policy`. Used by the existing-goal Sub-goals settings
 * control on the goal dashboard so a user can turn on sub-goals for a parent
 * that was created with the toggle off. Backend authz is split server-side
 * (see nested-goal-routes.ts /policy handler): a body carrying ONLY the
 * sub-goal opt-in fields (`subgoalsAllowed` / `maxNestingDepth`) is
 * OPERATOR-class, so a verified human cookie is accepted (else team-lead
 * match); only bodies that touch orchestration fields
 * (`divergencePolicy` / `maxConcurrentChildren`) stay team-lead-only. This
 * helper only ever sends the two sub-goal fields, so it rides the operator
 * path. It just forwards the request with the session credentials. Returns
 * true on success.
 */
export async function patchGoalSubgoalPolicy(
	id: string,
	updates: { subgoalsAllowed?: boolean; maxNestingDepth?: number },
): Promise<boolean> {
	try {
		const body: Record<string, unknown> = {};
		if (updates.subgoalsAllowed !== undefined) body.subgoalsAllowed = updates.subgoalsAllowed;
		if (updates.maxNestingDepth !== undefined) body.maxNestingDepth = updates.maxNestingDepth;
		const res = await gatewayFetch(`/api/goals/${id}/policy`, {
			method: "PATCH",
			body: JSON.stringify(body),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed to update sub-goal settings: ${res.status}`);
		await refreshSessions();
		return true;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to update sub-goal settings", message, { code, stack });
		return false;
	}
}

export async function deleteGoal(id: string): Promise<void> {
	const goal = state.goals.find((g) => g.id === id);
	if (!goal) return;
	const goalTitle = goal.title || "this goal";
	const sessionsUnderGoal = state.gatewaySessions.filter((s) => s.goalId === id);

	// Detect active team (mirror of render-helpers heuristic).
	const isTeamGoal = !!(goal as any)?.team;
	const teamActive = isTeamGoal && state.gatewaySessions.some(
		(s) => (s.goalId === id || s.teamGoalId === id)
			&& s.role === "team-lead"
			&& s.status !== "terminated",
	);

	// descendants > 0 routes through cascade-confirm dialog; else single-goal confirm.
	const descendants = countDescendants(id);

	if (descendants > 0) {
		// Show the cascade-archive confirmation dialog first. The server's
		// archiveOne handles team teardown inside the cascade after the user
		// confirms — we must NOT pre-tear down before confirmation (destructive,
		// non-undoable). The cascade-confirm dialog handles teams itself.
		const result = await showArchiveGoalDialog(goal);
		if (result.archived > 0) {
			// Eager local archive flip avoids a flash-of-live-goals.
			// Skip when partial errors occurred — the server may not have
			// archived all descendants, so refreshSessions() is authoritative.
			if (!result.hasErrors) {
				const allIds = collectGoalIdsFor(id);
				eagerMarkArchived(allIds);
			}
			await refreshSessions();
		}
		return;
	}

	// Single-goal path — wording adapts to active-team state.
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
		if (!ok) return;
	}

	try {
		const res = await gatewayFetch(`/api/goals/${id}?cascade=false`, { method: "DELETE" });
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		eagerMarkArchived([id]);
		await refreshSessions();
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to archive goal", message, { code, stack });
	}
}

/** Collect a goal + all its non-archived descendants from client state. */
function collectGoalIdsFor(rootId: string): string[] {
	// Walk THROUGH archived nodes (mirroring countDescendants walk-through
	// semantics) so live descendants under archived intermediates are included
	// in the eager-archive flip. Only collect non-archived IDs since already-
	// archived goals need no flip.
	const out = [rootId];
	const queue = [rootId];
	const seen = new Set<string>([rootId]);
	while (queue.length > 0) {
		const cur = queue.shift()!;
		for (const g of state.goals) {
			if (g.parentGoalId !== cur || seen.has(g.id)) continue;
			seen.add(g.id);
			if (!g.archived) out.push(g.id); // only collect non-archived
			queue.push(g.id); // always descend through archived
		}
	}
	return out;
}

/**
 * Mutate `state.goals` to flip `archived: true` (and stamp `archivedAt`) for
 * the given ids. Safe to call before `refreshSessions()` returns — the next
 * fetch will replace the goal list anyway, but this gives the sidebar an
 * instant visual update instead of waiting for the network round-trip.
 */
function eagerMarkArchived(ids: string[]): void {
	const idSet = new Set(ids);
	const now = Date.now();
	for (const g of state.goals) {
		if (idSet.has(g.id) && !g.archived) {
			g.archived = true;
			(g as Goal).archivedAt = now;
		}
	}
}

export type GoalPauseResumeAction = "pause" | "resume";

const goalPauseResumePending = new Map<string, { fetchRef: unknown }>();

function goalPauseResumePendingKey(goalId: string, action: GoalPauseResumeAction): string {
	return `${goalId}:${action}`;
}

function currentFetchRef(): unknown {
	return typeof globalThis !== "undefined" ? globalThis.fetch : undefined;
}

export function isGoalPauseResumeActionPending(goalId: string | undefined | null, action: GoalPauseResumeAction): boolean {
	if (!goalId) return false;
	const key = goalPauseResumePendingKey(goalId, action);
	const entry = goalPauseResumePending.get(key);
	if (!entry) return false;
	if (entry.fetchRef !== currentFetchRef()) {
		goalPauseResumePending.delete(key);
		return false;
	}
	return true;
}

export function getGoalPauseResumePendingAction(goalId: string | undefined | null): GoalPauseResumeAction | null {
	if (!goalId) return null;
	if (isGoalPauseResumeActionPending(goalId, "pause")) return "pause";
	if (isGoalPauseResumeActionPending(goalId, "resume")) return "resume";
	return null;
}

function setGoalPauseResumeActionPending(goalId: string, action: GoalPauseResumeAction, pending: boolean): void {
	const key = goalPauseResumePendingKey(goalId, action);
	if (pending) goalPauseResumePending.set(key, { fetchRef: currentFetchRef() });
	else goalPauseResumePending.delete(key);
	renderApp();
}

/** Pause a goal with cascade-confirm UX. */
export async function pauseGoalWithDialog(id: string): Promise<void> {
	if (isGoalPauseResumeActionPending(id, "pause")) return;
	setGoalPauseResumeActionPending(id, "pause", true);
	try {
		const goal = state.goals.find((g) => g.id === id);
		if (!goal) return;
		const descendants = countDescendants(id);
		const result = await showPauseGoalDialog(goal, descendants);
		if (result.paused > 0) {
			await refreshSessions();
		}
	} finally {
		setGoalPauseResumeActionPending(id, "pause", false);
	}
}

/** Resume a goal with cascade-confirm UX. */
export async function resumeGoalWithDialog(id: string): Promise<void> {
	if (isGoalPauseResumeActionPending(id, "resume")) return;
	setGoalPauseResumeActionPending(id, "resume", true);
	try {
		const goal = state.goals.find((g) => g.id === id);
		if (!goal) return;
		const descendants = countDescendants(id);
		const result = await showResumeGoalDialog(goal, descendants);
		if (result.resumed > 0) {
			await refreshSessions();
		}
	} finally {
		setGoalPauseResumeActionPending(id, "resume", false);
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

export async function refreshAgentSession(sessionId: string, opts?: { force?: boolean }): Promise<boolean> {
	await flashSidebarToast("Refreshing agent…");
	let ok = false;
	try {
		const res = await gatewayFetch(`/api/sessions/${encodeURIComponent(sessionId)}/restart`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ force: opts?.force === true }),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed to refresh agent: ${res.status}`);
		ok = true;
		await flashSidebarToast("Agent refreshed");
		return true;
	} catch (err) {
		const { message } = errorDetails(err);
		console.error("[refresh-agent] Failed:", err);
		await flashSidebarToast(`Refresh agent failed: ${message}`);
		return false;
	} finally {
		try {
			await refreshSessions();
		} catch (err) {
			console.warn("[refresh-agent] Session refresh failed after restart", err);
		}
		if (!ok) renderApp();
	}
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

export async function completeTeam(goalId: string, opts?: { confirmBypassedGates?: boolean }): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team/complete`, {
			method: "POST",
			body: JSON.stringify({ confirmBypassedGates: opts?.confirmBypassedGates === true }),
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

/**
 * Tear down a goal's team. When the goal has live descendant teams, the
 * server returns 409 HAS_DESCENDANT_TEAMS — the dialog wrapper below
 * (`teardownTeamWithDialog`) handles that case by prompting the user to
 * cascade. Direct callers that already know there are no descendants (or
 * accept the failure mode) can use this raw helper.
 */
export async function teardownTeam(goalId: string, cascade = false): Promise<boolean> {
	try {
		// Server requires explicit `cascade` (returns 422 CASCADE_REQUIRED when
		// omitted). Always send the value, even when false, to honour the
		// AGENTS.md "every cascade-affecting REST call requires explicit cascade"
		// contract.
		const url = `/api/goals/${goalId}/team/teardown?cascade=${cascade ? "true" : "false"}`;
		const res = await gatewayFetch(url, { method: "POST" });
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		await refreshSessions();
		return true;
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to tear down team", message, { code, stack });
		return false;
	}
}

/**
 * Tear down with cascade-confirmation dialog when descendants are present.
 * Pre-flight: try cascade=false. On 409 HAS_DESCENDANT_TEAMS, show the
 * confirmation dialog with the descendant list + count and let the user
 * choose. On any other status the no-cascade path completes immediately.
 *
 * Returns true if the teardown completed (with or without cascade), false
 * on cancel or network error.
 */
export async function teardownTeamWithDialog(goalId: string): Promise<boolean> {
	try {
		// Explicit cascade=false on the probe — server returns 422
		// CASCADE_REQUIRED otherwise. See AGENTS.md.
		const probe = await gatewayFetch(`/api/goals/${goalId}/team/teardown?cascade=false`, { method: "POST" });
		if (probe.ok) {
			await refreshSessions();
			return true;
		}
		if (probe.status === 409) {
			const body = await probe.json().catch(() => null) as { code?: string; count?: number; descendants?: Array<{ id: string; title: string }> } | null;
			if (body?.code === "HAS_DESCENDANT_TEAMS") {
				// R-024 + R-040: the descendant-count-zero short-circuit lives
				// here so the dialog only ever returns "cascade" | "cancel".
				// In practice the 409 path always implies count > 0, but we
				// still treat a defensive 0-count response as a no-op success.
				if ((body.count ?? 0) === 0) {
					await refreshSessions();
					return true;
				}
				// R-041: resolve the goal title from live client state. The
				// historical `window.__goalCache` fallback is gone — if the
				// goal isn't in state yet we use the raw goalId as the title.
				const liveGoal = state.goals.find(g => g.id === goalId);
				const goal = liveGoal
					? { id: liveGoal.id, title: liveGoal.title }
					: { id: goalId, title: goalId };
				const decision = await showStopTeamDialog(goal, body.count ?? 0, body.descendants ?? []);
				if (decision === "cancel") return false;
				if (decision === "cascade") {
					const r = await gatewayFetch(`/api/goals/${goalId}/team/teardown?cascade=true`, { method: "POST" });
					if (!r.ok) throw new Error(`Failed: ${r.status}`);
					await refreshSessions();
					return true;
				}
				return false;
			}
		}
		throw new Error(`Failed: ${probe.status}`);
	} catch (err) {
		showConnectionError("Failed to tear down team", err instanceof Error ? err.message : String(err));
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
	type: "command" | "llm-review" | "agent-qa" | "human-signoff";
	run?: string;
	prompt?: string;
	expect?: "success" | "failure";
	timeout?: number;
	phase?: number;
	optional?: boolean;
	/** Sign-off card title — only meaningful for `human-signoff` steps. */
	label?: string;
	/** Toggle label shown at goal creation — only meaningful for `optional` steps. */
	optionalLabel?: string;
	role?: string;
	description?: string;
	/** Structural reference: which component to run from (Phase 2). */
	component?: string;
	/** Structural reference: which command on that component to invoke (Phase 2). */
	command?: string;
}

export interface WorkflowGate {
	id: string;
	name: string;
	dependsOn: string[];
	content?: boolean;
	injectDownstream?: boolean;
	optional?: boolean;
	manual?: boolean;
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

export interface VerificationTimeoutInfo {
	configuredSeconds: number;
	elapsedMs: number;
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
			status?: "waiting" | "running" | "passed" | "failed" | "timeout" | "skipped";
			/** Present only when a review turn exhausted its configured allowance. */
			timeout?: VerificationTimeoutInfo;
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
	accessory?: string;
}

export type CreateStaffAgentData = {
	name: string;
	description: string;
	systemPrompt: string;
	cwd?: string;
	worktree?: boolean;
	triggers?: any[];
	projectId?: string;
	sandboxed?: boolean;
	accessory?: string;
	/** Optional role to attach. `null`/omitted = no role. */
	roleId?: string | null;
};

// `roleId` accepts `null` to explicitly clear the field; JSON.stringify keeps
// nulls (it only strips `undefined`), so the server receives the clear signal.
export type StaffAgentUpdate = Partial<Pick<StaffAgent, "name" | "description" | "systemPrompt" | "cwd" | "state" | "triggers" | "memory" | "contextPolicy" | "accessory">> & { roleId?: string | null };

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

export async function refreshStaffStateFromApi(): Promise<void> {
	const [staffList, orphanedStaff] = await Promise.all([
		fetchStaff(),
		fetchOrphanedStaff(),
	]);
	state.staffList = staffList.map((s) => ({
		id: s.id,
		name: s.name,
		description: s.description,
		state: s.state,
		lastWakeAt: s.lastWakeAt,
		currentSessionId: s.currentSessionId,
		triggers: s.triggers,
		projectId: s.projectId,
	}));
	state.orphanedStaff = orphanedStaff.map((s) => ({
		id: s.id,
		name: s.name,
		description: s.description,
		state: s.state,
		projectId: s.projectId,
	}));
	renderApp();
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

export async function createStaffAgent(data: CreateStaffAgentData): Promise<StaffAgent | null> {
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

export async function updateStaffAgent(id: string, updates: StaffAgentUpdate): Promise<boolean> {
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
	/** "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" — overrides default.sessionThinkingLevel / default.reviewThinkingLevel. "xhigh" is auto-detected from per-model metadata when available; otherwise Bobbit falls back to known family rules (Claude Opus 4.6+, gpt-5.1-codex-max, gpt-5.2* / gpt-5.4* / gpt-5.5*). "max" requires per-model metadata. */
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

export async function fetchRoles(projectId?: string): Promise<RoleData[]> {
	try {
		const apiProjectId = configApiProjectId(projectId);
		const qs = `?projectId=${encodeURIComponent(apiProjectId)}`;
		const res = await gatewayFetch(`/api/roles${qs}`);
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
	/** Public policy keys returned by /api/mcp-servers for Tools controls. */
	policyKey?: string;
	serverPolicyKey?: string;
	packagePolicyKey?: string;
	subNamespacePolicyKey?: string;
	operationPolicyKey?: string;
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
	/** Public server policy key (for gateway runtimes this differs from name). */
	serverPolicyKey?: string;
	policyKey?: string;
	mcpPolicyKey?: string;
	/** Active provider sub-namespaces for grouped gateway-backed MCP servers. */
	activeSubNamespaces?: string[];
	tools: McpOperationInfo[];
}

/** GET /api/mcp-servers — returns one entry per registered MCP server with its operations. */
export async function fetchMcpServers(opts?: { projectId?: string; cwd?: string; ensure?: boolean }): Promise<McpServerInfo[]> {
	try {
		const params = new URLSearchParams();
		params.set("projectId", configApiProjectId(opts?.projectId));
		if (opts?.cwd) params.set("cwd", opts.cwd);
		if (opts?.ensure) params.set("ensure", "true");
		const qs = params.toString();
		const res = await gatewayFetch(`/api/mcp-servers${qs ? `?${qs}` : ""}`);
		if (!res.ok) return [];
		const data = await res.json();
		if (!Array.isArray(data)) return [];
		return data as McpServerInfo[];
	} catch {
		return [];
	}
}

export interface ToolProviderProvenance {
	providerKey: string;
	packName: string;
	listName: string;
	scope: string;
	sourcePath?: string;
}

export interface ToolDiagnostic {
	severity?: "error" | "warning" | "info" | string;
	level?: "error" | "warning" | "info" | string;
	code?: string;
	message?: string;
	reason?: string;
	tool?: string;
	toolName?: string;
	name?: string;
	group?: string;
	groupDir?: string;
	sourcePath?: string;
	path?: string;
	providerKey?: string;
	origin?: string;
	fallback?: string;
	fallbackTool?: string;
	skipped?: boolean;
	[key: string]: unknown;
}

export interface ToolsResponse {
	tools: ToolInfo[];
	diagnostics: ToolDiagnostic[];
}

export interface ToolInfo {
	name: string;
	description: string;
	group: string;
	docs?: string;
	detail_docs?: string;
	hasRenderer?: boolean;
	rendererFile?: string;
	/** Extension-host renderer delivery (design extension-host.md §2.5): "pack" ⇒ the UI
	 *  serves + lazy-imports the pre-built ESM renderer at runtime; "builtin" ⇒ metadata. */
	rendererKind?: "builtin" | "pack";
	/** True when the tool ships a server-actions module (`actions:` in the tool YAML). */
	hasActions?: boolean;
	/** Optional declared action-name allowlist (from `actions.names`). */
	actionNames?: string[];
	/** Structural `packId` of the winning pack that contributed this tool (pack
	 *  schema V1 — present only for `rendererKind:"pack"` tools). The client threads
	 *  it into the tool renderer's host so `host.ui.openPanel({panelId})` resolves
	 *  the panel within the renderer's OWN pack, never a global panel-id search that
	 *  would collide when another installed pack shares the panel id. */
	packId?: string;
	grantPolicy?: string;
	providerType?: "pi-extension" | string;
	origin?: "marketplace-pi-extension" | "builtin" | "server" | "user" | "project" | string;
	originPackName?: string | null;
	originPackId?: string | null;
	sourcePath?: string;
	providers?: ToolProviderProvenance[];
	/** Optional backend diagnostics for invalid/skipped config-level tool overrides. */
	diagnostics?: Array<ToolDiagnostic | string> | ToolDiagnostic | string;
	invalidReason?: ToolDiagnostic | string | Record<string, unknown>;
	invalid?: boolean;
	valid?: boolean;
}

function isToolApiRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeToolDiagnostics(raw: unknown): ToolDiagnostic[] {
	if (!raw) return [];
	if (typeof raw === "string") return raw.trim() ? [{ message: raw }] : [];
	if (Array.isArray(raw)) return raw.flatMap((item) => normalizeToolDiagnostics(item));
	if (isToolApiRecord(raw)) return [raw as ToolDiagnostic];
	return [];
}

function normalizeToolInfo(raw: unknown): ToolInfo | null {
	if (typeof raw === "string") return { name: raw, description: "", group: "Other" };
	if (!isToolApiRecord(raw)) return null;
	const name = typeof raw.name === "string" ? raw.name : undefined;
	if (!name) return null;
	return raw as unknown as ToolInfo;
}

function dedupeToolDiagnostics(diagnostics: ToolDiagnostic[]): ToolDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = [diagnostic.toolName, diagnostic.tool, diagnostic.name, diagnostic.extensionPath, diagnostic.path, diagnostic.sourcePath, diagnostic.code, diagnostic.reason, diagnostic.message]
			.map((value) => typeof value === "string" ? value : "")
			.join("\0");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function normalizeToolsResponse(data: unknown): ToolsResponse {
	const root = isToolApiRecord(data) ? data : undefined;
	const rawTools = Array.isArray(root?.tools) ? root.tools : Array.isArray(data) ? data : [];
	return {
		tools: rawTools.map(normalizeToolInfo).filter((tool): tool is ToolInfo => Boolean(tool)),
		diagnostics: dedupeToolDiagnostics([
			...normalizeToolDiagnostics(root?.diagnostics),
			...normalizeToolDiagnostics(root?.toolDiagnostics),
			...normalizeToolDiagnostics(root?.invalidTools),
			...normalizeToolDiagnostics(root?.invalidToolDiagnostics),
		]),
	};
}

// ============================================================================
// PACK-SCOPED CONTRIBUTIONS (pack schema V1 — design pack-schema-v1-rationalisation.md §6.4)
//
// Panels / entrypoints / routes are PACK-scoped (no longer anchored to a carrier
// tool). They are served by GET /api/ext/contributions?projectId=, ONE row per
// installed + active pack (after the winning-pack collapse), with empty arrays
// when a pack declares none. Activation filtering is applied server-side
// (disabled entrypoints omitted; panels/routes always present when the pack is
// installed + active). The client registries (pack-panels / pack-entrypoints)
// reconcile from THIS endpoint, not /api/tools.
// ============================================================================

/** One pack-contributed panel (id + optional display title; the ESM `entry`
 *  path stays server-side — the client addresses panels by `{packId, panelId}`). */
export interface PackPanelWire {
	id: string;
	title?: string;
}

/** One pack-contributed entrypoint. `listName` is the `contents.entrypoints[]`
 *  basename — the SINGLE activation toggle key mapping onto both the launcher id
 *  and (for `kind:"route"`) the deep-link routeId. */
export interface PackEntrypointWire {
	id: string;
	kind: "composer-slash" | "session-menu" | "route";
	label?: string;
	icon?: string;
	routeId?: string;
	target?: { action?: string; panelId?: string; route?: string; channel?: string; singletonKey?: string; params?: Record<string, unknown> };
	paramKeys?: string[];
	listName: string;
}

/** All pack-scoped contributions for ONE installed + active pack (§6.4). */
export interface PackContributionsWire {
	packId: string;
	packName: string;
	panels: PackPanelWire[];
	entrypoints: PackEntrypointWire[];
	/** Pack-local channel names only; module/handler paths stay server-side. */
	channelNames?: string[];
	routeNames: string[];
}

/** Fetch the project-scoped pack-contribution metadata (§6.4). Returns one row
 *  per installed + active pack (empty arrays when it declares no
 *  panels/entrypoints/routes), so the client reconcile is deterministic
 *  (reconcile-on-uninstall keys off a row disappearing, not becoming empty). */
export async function fetchContributions(projectId?: string): Promise<PackContributionsWire[]> {
	try {
		const apiProjectId = configApiProjectId(projectId);
		const qs = `?projectId=${encodeURIComponent(apiProjectId)}`;
		const res = await gatewayFetch(`/api/ext/contributions${qs}`);
		if (!res.ok) throw await errorFromResponse(res, `Failed to fetch contributions: ${res.status}`);
		const data = await res.json();
		return Array.isArray(data?.packs) ? (data.packs as PackContributionsWire[]) : [];
	} catch (err) {
		console.error("[pack-api] fetchContributions failed:", err);
		return [];
	}
}

export async function fetchToolsResponse(projectId?: string): Promise<ToolsResponse> {
	try {
		const apiProjectId = configApiProjectId(projectId);
		const qs = `?projectId=${encodeURIComponent(apiProjectId)}`;
		const res = await gatewayFetch(`/api/tools${qs}`);
		if (!res.ok) throw await errorFromResponse(res, `Failed to fetch tools: ${res.status}`);
		return normalizeToolsResponse(await res.json());
	} catch (err) {
		console.error("[role-api] fetchTools failed:", err);
		return { tools: [], diagnostics: [] };
	}
}

export async function fetchTools(projectId?: string): Promise<ToolInfo[]> {
	return (await fetchToolsResponse(projectId)).tools;
}

export async function fetchToolDetail(name: string, projectId?: string): Promise<ToolInfo | null> {
	try {
		const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
		const res = await gatewayFetch(`/api/tools/${encodeURIComponent(name)}${qs}`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function updateTool(name: string, updates: { description?: string; group?: string; docs?: string; detail_docs?: string; grantPolicy?: string | null }, projectId?: string): Promise<boolean> {
	try {
		const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
		const res = await gatewayFetch(`/api/tools/${encodeURIComponent(name)}${qs}`, {
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

export async function fetchGroupPolicies(projectId?: string): Promise<Record<string, string>> {
	try {
		const apiProjectId = configApiProjectId(projectId);
		const qs = `?projectId=${encodeURIComponent(apiProjectId)}`;
		const res = await gatewayFetch(`/api/tool-group-policies${qs}`);
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

export async function updateGroupPolicy(group: string, policy: string | null, projectId?: string): Promise<void> {
	await gatewayFetch(`/api/tool-group-policies/${encodeURIComponent(group)}`, {
		method: "PUT",
		body: JSON.stringify(projectId ? { policy, projectId } : { policy }),
	});
}

export async function createRole(role: {
	name: string;
	label: string;
	promptTemplate: string;
	toolPolicies?: Record<string, string>;
	accessory: string;
	model?: string;
	thinkingLevel?: string;
	description?: string;
	projectId?: string;
}): Promise<RoleData | null> {
	try {
		// Strip undefined fields so the wire payload stays minimal and the
		// server's optional-string validation (model, thinkingLevel) doesn't
		// see empty strings as "set".
		const body: Record<string, unknown> = {
			name: role.name,
			label: role.label,
			promptTemplate: role.promptTemplate,
			accessory: role.accessory,
		};
		if (role.toolPolicies !== undefined) body.toolPolicies = role.toolPolicies;
		if (role.projectId !== undefined && role.projectId !== "") body.projectId = role.projectId;
		if (role.model !== undefined && role.model !== "") body.model = role.model;
		if (role.thinkingLevel !== undefined && role.thinkingLevel !== "") body.thinkingLevel = role.thinkingLevel;
		if (role.description !== undefined && role.description !== "") body.description = role.description;
		const res = await gatewayFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
		return await res.json();
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to create role", message, { code, stack });
		return null;
	}
}

export async function fetchRoleDetail(name: string, projectId?: string): Promise<RoleData | null> {
	try {
		const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
		const res = await gatewayFetch(`/api/roles/${encodeURIComponent(name)}${qs}`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
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
// APP INFO + HARNESS STATUS API
// ============================================================================

export interface AppInfo {
	version: string;
	buildType: "installed" | "source";
	commitSha?: string;
}

export async function fetchAppInfo(): Promise<AppInfo | null> {
	try {
		const res = await gatewayFetch("/api/app-info");
		if (!res.ok) return null;
		const data = await res.json().catch(() => null);
		if (typeof data?.version !== "string" || (data?.buildType !== "installed" && data?.buildType !== "source")) return null;
		return {
			version: data.version,
			buildType: data.buildType,
			...(typeof data.commitSha === "string" ? { commitSha: data.commitSha } : {}),
		};
	} catch {
		return null;
	}
}

export interface HarnessStatus {
	restartAvailable: boolean;
}

export async function fetchHarnessStatus(): Promise<HarnessStatus> {
	try {
		const res = await gatewayFetch("/api/harness-status");
		if (!res.ok) return { restartAvailable: false };
		const data = await res.json().catch(() => null);
		return { restartAvailable: data?.restartAvailable === true };
	} catch {
		return { restartAvailable: false };
	}
}

export async function requestHarnessRestart(): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await gatewayFetch("/api/harness/restart", { method: "POST" });
		if (res.ok) return { ok: true };
		const data = await res.json().catch(() => null);
		const error = typeof data?.error === "string" ? data.error : `Restart request failed: ${res.status}`;
		return { ok: false, error };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : "Restart request failed" };
	}
}

/**
 * POST one boot/reload-timing sample to the harness-gated sink
 * (`/api/dev/boot-timing` → `<stateDir>/boot-timing.jsonl`). Fire-and-forget;
 * swallows all errors so diagnostics can never disrupt the app. No-op-safe to
 * call when the server is not under the harness (returns a 403 we ignore).
 */
export async function postBootTiming(sample: unknown): Promise<void> {
	try {
		await gatewayFetch("/api/dev/boot-timing", {
			method: "POST",
			body: JSON.stringify(sample),
		});
	} catch { /* ignore */ }
}

// ============================================================================
// SANDBOX STATUS API
// ============================================================================

export async function fetchSandboxStatus(projectId?: string) {
	const apiProjectId = configApiProjectId(projectId);
	const res = await gatewayFetch(`/api/sandbox-status?projectId=${encodeURIComponent(apiProjectId)}`);
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
		const res = await gatewayFetch(`/api/sessions/${sessionId}/draft?type=${encodeURIComponent(type)}&optional=1`);
		if (res.status === 204 || !res.ok) return null;
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

/**
 * Tell the proposing agent that the user just accepted (or rejected) its
 * proposal. Enqueues a synthetic user-style message to the session via
 * POST /api/sessions/:id/notify. Fire-and-forget — never throws, never
 * blocks the accept flow on the network call.
 *
 * `summary` should be a one-line human-readable identifier of what was
 * accepted (e.g. role name, project name, goal title) so the agent can
 * mention it back specifically. The message wording is normalised here
 * so all five accept paths produce identical UX.
 */
export async function notifyProposalDecision(
	sessionId: string,
	type: "goal" | "project" | "role" | "tool" | "staff",
	decision: "accepted" | "rejected",
	summary: string,
): Promise<void> {
	const verb = decision === "accepted" ? "accepted" : "rejected";
	const message = `[SYSTEM: The user ${verb} your ${type} proposal${summary ? ` "${summary}"` : ""}. ${decision === "accepted" ? "The change is now live in the project — continue with your task." : "Adjust your approach and propose again, or pick a different path."}]`;
	try {
		await gatewayFetch(`/api/sessions/${sessionId}/notify`, {
			method: "POST",
			body: JSON.stringify({ message }),
		});
	} catch (err) {
		// Never let a notification failure block the accept flow — the user
		// has already taken the action successfully and the network failure
		// is a separate concern.
		console.warn("[proposal-notify] Failed to notify proposing session:", err);
	}
}

// ============================================================================
// MARKETPLACE API (Pack-Based Marketplace — see docs/design/pack-based-marketplace.md §9)
// ============================================================================

/** Install scopes a pack may target (wire form). */
export type MarketScope = "global-user" | "server" | "project";

export interface PackManifest {
	name: string;
	description: string;
	version: string;
	author?: string;
	homepage?: string;
	/** Ships-disabled-by-default (built-in first-party packs). When true, the
	 *  pack contributes nothing until explicitly enabled (`DisabledRefs.enabled`). */
	defaultDisabled?: boolean;
	contents: {
		roles: string[];
		tools: string[];
		skills: string[];
		/** Entrypoint `listName` basenames (pack-schema-v1 §1.2). Optional on the
		 *  client wire — present on browse/installed payloads that declare them. */
		entrypoints?: string[];
		/** MCP contribution `listName` basenames (schema 2). Optional so older
		 *  pack/source responses keep parsing while MCP-aware catalogues render chips. */
		mcp?: string[];
		/** Pi runtime extension basenames (schema 2 `contents.pi-extensions`). */
		piExtensions?: string[];
	};
}

export interface PackMeta {
	sourceUrl: string;
	sourceRef: string;
	commit: string;
	packName: string;
	version: string;
	installedAt: string;
	updatedAt: string;
	scope: MarketScope;
}

export type MarketplaceSourceType = "pack" | "mcp-gateway";
export type StoredMarketplaceSourceType = MarketplaceSourceType | "mcp-registry";

export interface MarketplaceSource {
	id: string;
	url: string;
	ref?: string;
	/** Server-persisted readable label for MCP gateway sources. Render verbatim. */
	displayName?: string;
	/** Gateway URL authority/path before duplicate suffixing. */
	normalizedName?: string;
	/** Source backend type. Omitted means the original pack git/local source. Legacy mcp-registry rows may still appear as unsupported. */
	type?: StoredMarketplaceSourceType;
	addedAt: string;
	lastSyncedAt?: string;
	lastCommit?: string;
	/** Optional summary metadata for MCP gateway/legacy registry sources. */
	mcpProviderCount?: number;
	discoveredMcpProviders?: number;
	gatewayProviderCount?: number;
	mcpServerCount?: number;
	discoveredMcpServers?: number;
	/** Response-only migration note for unsupported legacy source rows. */
	unsupportedReason?: string;
	/** Response-only: marks the synthetic, non-removable built-in source (§4.4). */
	builtin?: boolean;
}

/** One-line per-entity descriptions sourced from the pack dir (R3). Keyed by the
 *  identity used by the corresponding row: roles/skills by name, activation tools
 *  by concrete tool name, manifest chips by declared tool group, and entrypoints
 *  by `listName`. MUST stay in sync with the server type of the same name
 *  (`src/server/agent/marketplace-install.ts`). */
export interface PackEntityDescriptions {
	roles?: Record<string, string>;
	tools?: Record<string, string>;
	skills?: Record<string, string>;
	entrypoints?: Record<string, string>;
	mcp?: Record<string, string>;
	piExtensions?: Record<string, string>;
}

export interface PackMcpContributionWire {
	ref?: string;
	listName?: string;
	serverName?: string;
	subNamespace?: string;
	label?: string;
	description?: string;
	transport?: "stdio" | "http";
	command?: string;
	args?: string[];
	cwd?: string;
	env?: string[] | Record<string, unknown>;
	url?: string;
	headers?: string[] | Record<string, unknown>;
	status?: string;
	ownerStatus?: string;
	overriddenBy?: string;
	winningPack?: string;
	error?: string;
	toolCount?: number;
	operations?: PackActivationMcpOperationEntry[];
	disabledOperations?: string[];
	staleDisabledOperations?: string[];
}

export interface PackActivationMcpOperationEntry {
	name: string;
	label?: string;
	description?: string;
	toolName?: string;
	selected?: boolean;
	disabledByActivation?: boolean;
	policyKey?: string;
	policy?: "allow" | "ask" | "never";
	stale?: boolean;
	shadowed?: boolean;
}

export interface PackActivationMcpEntry extends PackMcpContributionWire {
	/** Stable DisabledRefs.mcp key; gateway backends prefer contributionId. */
	ref: string;
	/** Stable installed MCP contribution id used for DisabledRefs.mcp/mcpOperations ownership. */
	contributionId?: string;
	/** Runtime MCP server name. Older servers may omit it; the UI falls back to ref. */
	serverName?: string;
	sourceId?: string;
	installedPackName?: string;
	gatewayProviderId?: string;
	runtimeServerKey?: string;
	selectedOperationCount?: number;
	totalOperationCount?: number;
	operations?: PackActivationMcpOperationEntry[];
	disabledOperations?: string[];
	staleDisabledOperations?: string[];
}

export interface PiExtensionDiagnostic {
	status: "ok" | "disabled" | "unresolved" | "discovery-failed" | "runtime-load-failed" | "remap-failed";
	code: string;
	message: string;
	updatedAt: string;
	stale?: boolean;
}

export interface PiExtensionToolInfo {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface PackActivationPiExtensionEntry {
	/** Stable DisabledRefs.piExtensions key, usually the contents.pi-extensions basename. */
	ref: string;
	listName?: string;
	label?: string;
	entryRelativePath?: string;
	diagnostic?: PiExtensionDiagnostic;
	tools?: PiExtensionToolInfo[];
}

export type MarketplaceBrowseSourceType = "builtin" | StoredMarketplaceSourceType;

export interface MarketplaceBrowseSourceState {
	sourceId: string;
	sourceName: string;
	sourceType: MarketplaceBrowseSourceType;
	builtin?: boolean;
	status: "ok" | "loading" | "error" | "unsupported";
	error?: string;
	lastSyncedAt?: string;
}

export interface BrowsePackSource {
	id: string;
	name: string;
	type: "builtin" | MarketplaceSourceType;
	builtin?: boolean;
}

export interface McpGatewaySkippedEntryDiagnostic {
	id?: string;
	name?: string;
	reason?: string;
	message?: string;
	[key: string]: unknown;
}

export interface McpGatewayDiagnosticsWire {
	skippedEntries?: McpGatewaySkippedEntryDiagnostic[];
	[key: string]: unknown;
}

export interface BrowsePackWire extends PackManifest {
	dirName: string;
	hasTools: boolean;
	/** Stable union-browse row key, usually `${source.id}:${dirName}`. */
	browseKey?: string;
	/** Source provenance for union Browse rows. */
	source?: BrowsePackSource;
	/** Response-only: shipped first-party pack (built-in source). */
	builtin?: boolean;
	/** Response-only: resolved in place (not copy-installed). */
	provided?: boolean;
	descriptions?: PackEntityDescriptions;
	/** Optional MCP details for gateway virtual packs or authored schema-2 packs. */
	mcp?: PackMcpContributionWire[];
	mcpServers?: PackMcpContributionWire[];
	/** Response-only metadata for virtual MCP gateway provider packs. */
	sourceType?: StoredMarketplaceSourceType;
	gatewayProviderId?: string;
	mcpGatewayDiagnostics?: McpGatewayDiagnosticsWire | string[];
}

export interface MarketplaceBrowseResponse {
	sources: MarketplaceBrowseSourceState[];
	packs: BrowsePackWire[];
}

export interface InstalledPackWire {
	scope: MarketScope;
	packName: string;
	manifest: PackManifest;
	meta: PackMeta;
	status: "ok" | "corrupt";
	/** Response-only: a built-in first-party pack row (no install ledger entry). */
	builtin?: boolean;
	/** True iff the source's latest manifest version differs from the installed
	 *  version AND the source could be checked. MUST stay in sync with the server
	 *  `InstalledPackWire` (`src/server/agent/marketplace-install.ts`). */
	updateAvailable: boolean;
	/** `"unknown"` when the source can't be checked (removed / never-synced / no
	 *  version data) — disambiguates "up to date" from "source unknown". */
	sourceStatus: "ok" | "unknown";
}

export interface ConflictPackRef {
	packEntryId: string;
	scope: string;
	label: string;
}

export interface ConflictWire {
	type: "roles" | "tools" | "skills";
	name: string;
	winner: ConflictPackRef;
	shadowed: ConflictPackRef[];
}

/** Discriminated result for marketplace calls so the UI can degrade gracefully
 *  (show the server's error) while the REST backend is still being built. */
export type MarketResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: string; status: number };

async function marketFetch<T>(
	path: string,
	init?: RequestInit,
	emptyOk = false,
): Promise<MarketResult<T>> {
	try {
		const res = await gatewayFetch(path, init);
		if (!res.ok) {
			let error = `HTTP ${res.status}`;
			try {
				const body = await res.json();
				if (body && typeof body.error === "string") error = body.error;
			} catch {
				/* non-JSON error body */
			}
			return { ok: false, error, status: res.status };
		}
		if (emptyOk || res.status === 204) return { ok: true, data: undefined as unknown as T };
		const data = (await res.json()) as T;
		return { ok: true, data };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err), status: 0 };
	}
}

function jsonInit(method: string, body?: unknown): RequestInit {
	return {
		method,
		headers: { "Content-Type": "application/json" },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	};
}

export function listMarketplaceSources(): Promise<MarketResult<{ sources: MarketplaceSource[] }>> {
	return marketFetch("/api/marketplace/sources");
}

export function addMarketplaceSource(url: string, ref?: string, type?: MarketplaceSourceType): Promise<MarketResult<{ source: MarketplaceSource }>> {
	const body: { url: string; ref?: string; type?: MarketplaceSourceType } = { url };
	if (ref) body.ref = ref;
	// Preserve legacy pack-source behavior against older servers by omitting the
	// default type; MCP gateway sources need the explicit discriminator.
	if (type && type !== "pack") body.type = type;
	return marketFetch("/api/marketplace/sources", jsonInit("POST", body));
}

export function removeMarketplaceSource(id: string): Promise<MarketResult<void>> {
	return marketFetch(`/api/marketplace/sources/${encodeURIComponent(id)}`, { method: "DELETE" }, true);
}

export function syncMarketplaceSource(id: string): Promise<MarketResult<{ source: MarketplaceSource }>> {
	return marketFetch(`/api/marketplace/sources/${encodeURIComponent(id)}/sync`, { method: "POST" });
}

export function browseMarketplacePacks(id: string): Promise<MarketResult<{ packs: BrowsePackWire[] }>> {
	return marketFetch(`/api/marketplace/sources/${encodeURIComponent(id)}/packs`);
}

export function browseMarketplace(projectId?: string): Promise<MarketResult<MarketplaceBrowseResponse>> {
	const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
	return marketFetch(`/api/marketplace/browse${qs}`);
}

export function installMarketplacePack(opts: { sourceId: string; dirName: string; scope: MarketScope; projectId?: string }): Promise<MarketResult<{ installed: InstalledPackWire }>> {
	return marketFetch("/api/marketplace/install", jsonInit("POST", opts));
}

export function updateInstalledPack(opts: { scope: MarketScope; packName: string; projectId?: string }): Promise<MarketResult<{ installed: InstalledPackWire }>> {
	return marketFetch("/api/marketplace/update", jsonInit("POST", opts));
}

export function uninstallMarketplacePack(opts: { scope: MarketScope; packName: string; projectId?: string }): Promise<MarketResult<void>> {
	return marketFetch("/api/marketplace/installed", jsonInit("DELETE", opts), true);
}

export function listInstalledPacks(projectId?: string): Promise<MarketResult<{ installed: InstalledPackWire[] }>> {
	const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
	return marketFetch(`/api/marketplace/installed${qs}`);
}

export function getPackOrder(scope: MarketScope, projectId?: string): Promise<MarketResult<{ scope: MarketScope; order: string[] }>> {
	const params = new URLSearchParams({ scope });
	if (projectId) params.set("projectId", projectId);
	return marketFetch(`/api/marketplace/pack-order?${params}`);
}

export function setPackOrder(opts: { scope: MarketScope; projectId?: string; order: string[] }): Promise<MarketResult<{ scope: MarketScope; order: string[] }>> {
	return marketFetch("/api/marketplace/pack-order", jsonInit("PUT", opts));
}

export function getPackConflicts(projectId?: string): Promise<MarketResult<{ conflicts: ConflictWire[] }>> {
	const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
	return marketFetch(`/api/packs/conflicts${qs}`);
}

// ============================================================================
// PACK ACTIVATION (pack schema V1 — design pack-schema-v1-rationalisation.md §6.7/§9)
//
// Per-scope/project activation overrides for USER-FACING entities only:
// roles, tools, skills, entrypoints (entrypoints keyed by `listName`). Default
// (absent) = all enabled. The GET/PUT `catalogue` is the UNFILTERED authoritative
// source for the Market UI toggles — server-expanded from pack declarations (tool
// groups become concrete tool names), NOT from the runtime-filtered /api/tools or
// /api/ext/contributions — so a disabled entity stays visible + re-enableable.
// ============================================================================

/** Disabled entity refs by kind for one pack/scope. Entrypoints keyed by `listName`. */
export interface DisabledRefs {
	/** Explicit-enable sentinel for ships-disabled-by-default packs. `true` opts
	 *  the pack IN; absent ⇒ manifest default. Unused for normal packs. */
	enabled?: boolean;
	roles?: string[];
	tools?: string[];
	skills?: string[];
	entrypoints?: string[];
	mcp?: string[];
	piExtensions?: string[];
	/** contributionId -> disabled operation names. */
	mcpOperations?: Record<string, string[]>;
}

/** The UNFILTERED catalogue of toggleable entities a pack exposes (§6.7). */
export interface PackActivationCatalogue {
	roles: string[];
	/** Concrete tool names, not manifest tool-group directory names. */
	tools: string[];
	skills: string[];
	entrypoints: Array<{
		listName: string;
		label?: string;
		kind?: PackEntrypointWire["kind"];
		routeId?: string;
	}>;
	/** MCP activation refs. Rich entries are preferred, but older backends may
	 *  return string refs; the UI normalizes both. */
	mcp?: Array<string | PackActivationMcpEntry>;
	/** Pi extension activation refs. Rich entries are preferred, but older backends may
	 *  return string refs; the UI normalizes both. */
	piExtensions?: Array<string | PackActivationPiExtensionEntry>;
	/** One-line per-entity descriptions for the activation disclosure (R3). */
	descriptions?: PackEntityDescriptions;
}

/** GET/PUT /api/marketplace/pack-activation response (§6.7). */
export interface PackActivationResponse {
	scope: MarketScope;
	packName: string;
	catalogue: PackActivationCatalogue;
	disabled: DisabledRefs;
	revision?: string;
}

export function getPackActivation(scope: MarketScope, packName: string, projectId?: string): Promise<MarketResult<PackActivationResponse>> {
	const params = new URLSearchParams({ scope, packName });
	if (projectId) params.set("projectId", projectId);
	return marketFetch(`/api/marketplace/pack-activation?${params}`);
}

export function setPackActivation(opts: { scope: MarketScope; projectId?: string; packName: string; disabled: DisabledRefs }): Promise<MarketResult<PackActivationResponse>> {
	return marketFetch("/api/marketplace/pack-activation", jsonInit("PUT", opts));
}

export function setMcpOperationActivation(opts: {
	scope: MarketScope;
	projectId?: string;
	contributionId: string;
	operationName: string;
	disabled: boolean;
	expectedRevision?: string;
}): Promise<MarketResult<PackActivationResponse>> {
	return marketFetch("/api/marketplace/pack-activation/mcp-operation", jsonInit("PATCH", opts));
}
