import "./app.css";
import "./storage.js"; // must initialize before anything else
import { mark, markPaint, installResumeHooks } from "./perf.js";
mark("main:module"); // earliest reachable mark — module evaluation start
import {
	state,
	renderApp,
	setRenderApp,
	GW_URL_KEY,
	GW_TOKEN_KEY,
	activeSessionId,
	resetSessionsHydration,
} from "./state.js";
import { getRouteFromHash } from "./routing.js";
import { registerShortcut, startListening, loadSavedBindings } from "./shortcut-registry.js";

// ---------------------------------------------------------------------------
// §G — Pre-first-paint critical path is intentionally TINY.
//
// Everything else — render.ts (the Lit-templated views), session-manager.ts
// (connect/auth/refresh), api.ts (gatewayFetch + RemoteAgent transitively),
// dialogs.ts, goal-entry.ts, render-helpers.ts, mobile-header.ts and the
// custom-element side-effect graph behind ../ui/index.js — is loaded via
// dynamic `import()` after the skeleton paints. The skeleton in index.html
// keeps the screen non-blank during that window; once renderApp() lands the
// real UI we hide it (single removal point, no re-show path).
//
// Do NOT add static imports of anything that is not strictly required to
// stamp `init:first-paint`. The bundle-size assertion in
// `tests/pre-first-paint-budget.test.ts` enforces this.
// ---------------------------------------------------------------------------

// Light caches for the route-level dynamic imports we touch repeatedly.
let _renderModule: typeof import("./render.js") | null = null;
let _sessionManagerModule: typeof import("./session-manager.js") | null = null;
let _apiModule: typeof import("./api.js") | null = null;
let _goalDashboardModule: typeof import("./goal-dashboard.js") | null = null;

async function loadRender() {
	if (!_renderModule) _renderModule = await import("./render.js");
	return _renderModule;
}
async function loadSessionManager() {
	if (!_sessionManagerModule) _sessionManagerModule = await import("./session-manager.js");
	return _sessionManagerModule;
}
async function loadApi() {
	if (!_apiModule) _apiModule = await import("./api.js");
	return _apiModule;
}
async function loadDashboardData(goalId: string): Promise<void> {
	if (!_goalDashboardModule) _goalDashboardModule = await import("./goal-dashboard.js");
	return _goalDashboardModule.loadDashboardData(goalId);
}
function clearDashboardState(): void {
	// No-op when the dashboard chunk hasn't been loaded yet — nothing to clear,
	// and importing it here would defeat the route-level code-split.
	if (_goalDashboardModule) _goalDashboardModule.clearDashboardState();
}

// Expose state on window for E2E tests (harmless in production — the state
// object is already mutable from devtools and contains no secrets).
(window as any).__bobbitState = state;

// ============================================================================
// GATEWAY STARTUP POLLING
// ============================================================================

/**
 * Try to authenticate with the gateway. If it's not up yet (502, network error),
 * poll every 1.5s until it responds. Throws on auth failures (401).
 */
async function waitForGateway(url: string, token: string): Promise<void> {
	const POLL_INTERVAL = 1500;
	const MAX_WAIT = 120_000;
	const start = Date.now();
	const sm = await loadSessionManager();

	while (true) {
		try {
			await sm.authenticateGateway(url, token);
			return; // Success
		} catch (err: any) {
			// Auth failures are permanent — don't retry
			if (err?.message?.includes("Invalid auth token")) throw err;

			// If we've exceeded the max wait, give up
			if (Date.now() - start >= MAX_WAIT) throw err;

			// Gateway not ready — wait and retry
			await new Promise(r => setTimeout(r, POLL_INTERVAL));
		}
	}
}

// ============================================================================
// HASH CHANGE HANDLER (browser back/forward)
// ============================================================================

let handlingHashChange = false;
let pendingHashChange = false;

async function handleHashChange(): Promise<void> {
	if (handlingHashChange) {
		// Another hash change arrived while we're still processing the previous one.
		// Flag it so we re-process after the current handler finishes. This ensures
		// rapid switches (A→B→A) don't silently drop the final destination.
		pendingHashChange = true;
		return;
	}
	handlingHashChange = true;

	try {
		const route = getRouteFromHash();
		const savedUrl = localStorage.getItem(GW_URL_KEY);
		const savedToken = localStorage.getItem(GW_TOKEN_KEY);

		if (!savedUrl || !savedToken) {
			state.appView = "disconnected";
			renderApp();
			return;
		}

		const sm = await loadSessionManager();
		const api = await loadApi();
		const { applyProjectPalette, connectToSession, flushAndTeardownDraft } = sm;
		const { refreshSessions } = api;

		// Flush and tear down draft handlers when leaving a session view.
		// Session-to-session switches handle this via selectSession(), but
		// navigation to non-session views (settings, roles, dashboard, etc.)
		// bypasses selectSession entirely, leaving the draft unflushed and
		// the editor content lost when the DOM is replaced (CT-02, PI-04f).
		if (route.view !== "session") {
			flushAndTeardownDraft();
		}

		if (route.view === "goal" && route.goalId) {
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.appView = "authenticated";
			// Apply palette for the goal's project
			const goalForPalette = state.goals.find(g => g.id === route.goalId);
			applyProjectPalette(goalForPalette?.projectId);
			await refreshSessions();
			await loadDashboardData(route.goalId);
		} else if (route.view === "session" && route.sessionId) {
			clearDashboardState();
			if (state.selectedSessionId === route.sessionId || state.connectingSessionId === route.sessionId) {
				return;
			}
			if (state.remoteAgent?.gatewaySessionId === route.sessionId) {
				return;
			}
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.goalDashboardId = null;
			// A3: skip /api/sessions/:id existence probe — connectToSession
			// surfaces SESSION_NOT_FOUND via the WS auth path; the catch block
			// below routes that to the dedicated session-not-found view.
			await connectToSession(route.sessionId, true);
		} else if (route.view === "goal-dashboard" && route.goalId) {
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.goalDashboardId = route.goalId;
			// Apply palette for the goal's project
			const gdGoal = state.goals.find(g => g.id === route.goalId);
			applyProjectPalette(gdGoal?.projectId);
			state.appView = "authenticated";
			loadDashboardData(route.goalId);
			renderApp();
			await refreshSessions();
		} else if (route.view === "roles") {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadRolePageData } = await import("./role-manager-page.js");
			loadRolePageData();
			renderApp();
			await refreshSessions();
		} else if (route.view === "role-edit" && route.roleName) {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadRolePageData, navigateToRoleEdit } = await import("./role-manager-page.js");
			await loadRolePageData();
			navigateToRoleEdit(route.roleName);
			await refreshSessions();
		} else if (route.view === "tools") {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadToolPageData } = await import("./tool-manager-page.js");
			loadToolPageData();
			renderApp();
			await refreshSessions();
		} else if (route.view === "tool-edit" && route.toolName) {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadToolPageData, navigateToToolEdit } = await import("./tool-manager-page.js");
			await loadToolPageData();
			navigateToToolEdit(route.toolName);
			await refreshSessions();
		} else if (route.view === "workflows") {
			// Standalone /workflows route is deprecated — redirect to the active
			// project's settings Workflows tab. Workflows are project-scoped, and
			// Settings is the single home for managing them.
			const projectId = state.activeProjectId || (state.projects[0]?.id ?? null);
			if (projectId) {
				const { setHashRoute } = await import("./routing.js");
				setHashRoute("settings", `${projectId}/workflows`, true);
				return;
			}
			// No project yet — fall through to the legacy page so the empty state shows.
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadWorkflowPageData } = await import("./workflow-page.js");
			loadWorkflowPageData();
			renderApp();
			await refreshSessions();
		} else if (route.view === "workflow-edit" && route.workflowId) {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadWorkflowPageData, navigateToWorkflowEdit } = await import("./workflow-page.js");
			await loadWorkflowPageData();
			navigateToWorkflowEdit(route.workflowId);
			await refreshSessions();
		} else if (route.view === "skills") {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadSkillsPageData } = await import("./skills-page.js");
			loadSkillsPageData();
			renderApp();
			await refreshSessions();
		} else if (route.view === "staff") {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadStaffPageData } = await import("./staff-page.js");
			loadStaffPageData();
			renderApp();
			await refreshSessions();
		} else if (route.view === "staff-edit" && route.staffId) {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadStaffPageData, navigateToStaffEdit } = await import("./staff-page.js");
			await loadStaffPageData();
			navigateToStaffEdit(route.staffId);
			await refreshSessions();
		} else {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.goalDashboardId = null;
			state.appView = "authenticated";
			applyProjectPalette(); // Revert to global palette
			renderApp();
			await refreshSessions();
		}
	} finally {
		handlingHashChange = false;
		// If another hash change arrived while we were processing, handle it now.
		// Read the current hash (not the one that was pending) — we always want
		// the latest state. This prevents rapid A→B→A from getting stuck on B.
		if (pendingHashChange) {
			pendingHashChange = false;
			handleHashChange();
		}
	}
}

// ============================================================================
// INIT
// ============================================================================

async function initApp() {
	mark("init:start");
	installResumeHooks();
	// F1: arm the sessions-hydration latch so consumers calling
	// awaitSessionsHydrated() during boot block until the first post-auth
	// refreshSessions() lands.
	resetSessionsHydration();
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	// Palette is loaded from server preferences after gateway auth (see below)

	// Check for token in URL (passed by gateway auto-open)
	const params = new URLSearchParams(window.location.search);
	const urlToken = params.get("token");
	if (urlToken) {
		localStorage.setItem(GW_URL_KEY, window.location.origin);
		localStorage.setItem(GW_TOKEN_KEY, urlToken);
		window.history.replaceState({}, "", window.location.pathname + window.location.hash);
	}

	let savedUrl = localStorage.getItem(GW_URL_KEY);
	let savedToken = localStorage.getItem(GW_TOKEN_KEY);

	// Auto-connect in localhost mode: probe the server without credentials.
	// If it reports localhost: true, store a dummy token and proceed — no
	// gateway dialog needed.
	if (!savedUrl || !savedToken) {
		try {
			const probe = await fetch(`${window.location.origin}/api/health`);
			if (probe.ok) {
				const health = await probe.json();
				if (health.localhost) {
					savedUrl = window.location.origin;
					savedToken = "localhost";
					localStorage.setItem(GW_URL_KEY, savedUrl);
					localStorage.setItem(GW_TOKEN_KEY, savedToken);
				}
			}
		} catch {
			// Server not reachable — fall through to disconnected state
		}
	}

	// If we have credentials, show "starting" immediately instead of
	// "disconnected" — the gateway may just be booting up.
	if (savedUrl && savedToken) {
		state.appView = "gateway-starting";
	}

	// §G: stamp init:first-paint as early as possible. The skeleton is
	// already on screen (it's static HTML in index.html) — we don't need
	// renderApp() to run before stamping the mark. The real Lit views
	// land asynchronously below once render.ts has loaded.
	mark("init:first-render");
	markPaint("init:first-paint");

	// B1: when resuming directly into /session/:id, pre-warm the WebSocket in
	// parallel with `waitForGateway` and the lazy module loads. The
	// TCP+TLS+upgrade+auth_ok round-trips overlap with `/api/health` and the
	// dynamic-import network/parse, so by the time `connectToSession` runs the
	// connect promise is often already settled.
	if (savedUrl && savedToken) {
		const initialRoute = getRouteFromHash();
		if (initialRoute.view === "session" && initialRoute.sessionId) {
			try {
				const { RemoteAgent } = await import("./remote-agent.js");
				const preAgent = new RemoteAgent();
				const connectPromise = preAgent.connect(savedUrl, savedToken, initialRoute.sessionId)
					.catch((err) => {
						// Swallow — connectToSession will re-throw via the awaited
						// promise and surface the standard error UI. Without the catch,
						// an unhandled rejection lands before the consumer attaches.
						throw err;
					});
				// Defuse unhandled-rejection: re-attached when consumed.
				connectPromise.catch(() => { /* will surface via connectToSession */ });
				state.preWarmedAgent = { sessionId: initialRoute.sessionId, agent: preAgent, connectPromise };
				mark("ws:prewarm-start");
			} catch { /* non-fatal */ }
		}
	}

	// Now lazy-load render.ts so we can install setRenderApp and render
	// the real shell. The skeleton remains visible until the first
	// renderApp() lands. This is also when we wire up the chat panel
	// container (state.chatPanel is created lazily by session-manager
	// when a session is actually connected).
	const { doRenderApp } = await loadRender();
	setRenderApp(doRenderApp);
	renderApp();
	// state.chatPanel is created lazily by session-manager when the user
	// actually connects to a session — none of the unauthenticated views
	// (disconnected / gateway-starting / session-not-found / landing) render
	// it, so deferring saves the ChatPanel + AgentInterface custom-element
	// graph from the bootstrap chunk.

	// §E PWA-resume skeleton — hide on first paint of the real app. Single
	// removal point; no re-show path. The skeleton is a sibling of #app and
	// outside Lit's render target, so this is safe for Lit.
	try {
		const sk = document.getElementById("bobbit-skeleton");
		if (sk) {
			sk.setAttribute("hidden", "");
			sk.style.setProperty("display", "none", "important");
			sk.style.setProperty("pointer-events", "none", "important");
		}
	} catch { /* never block bootstrap */ }

	// Listen for browser back/forward navigation — register early so hash changes
	// during async init (gateway wait, session refresh) are not silently missed.
	window.addEventListener("hashchange", handleHashChange);

	// Lazy-load helpers we'll need below.
	const { migrateLegacyVisitedMap } = await import("./render-helpers.js");

	if (savedUrl && savedToken) {
		try {
			mark("init:gateway-wait-start");
			await waitForGateway(savedUrl, savedToken);
			mark("init:gateway-wait-end");

			const sm = await loadSessionManager();
			const api = await loadApi();
			const { connectToSession, startPostAuthBackgroundFetches } = sm;
			const { gatewayFetch, refreshSessions } = api;

			// A1: fire post-auth REST fetches as side-effects so route
			// dispatch can run in parallel. Resolves the sessionsHydrated
			// latch on completion; consumers that need state.gatewaySessions
			// populated `await awaitSessionsHydrated()` instead of relying on
			// bootstrap-step ordering.
			startPostAuthBackgroundFetches();

			// A2: load saved preferences fire-and-forget. The palette is
			// already applied inline (`index.html`); showTimestamps and
			// playAgentFinishSound are not visible on first paint.
			gatewayFetch("/api/preferences").then(async (prefRes) => {
				if (!prefRes.ok) return;
				try {
					const prefs = await prefRes.json();
					if (prefs.palette && prefs.palette !== "forest") {
						document.documentElement.dataset.palette = prefs.palette;
						localStorage.setItem('palette', prefs.palette);
					} else {
						localStorage.removeItem('palette');
					}
					if (prefs.showTimestamps) {
						document.documentElement.dataset.showTimestamps = "true";
					}
					document.documentElement.dataset.playAgentFinishSound =
						prefs.playAgentFinishSound === false ? "false" : "true";
				} catch { /* non-fatal */ }
				mark("init:prefs-loaded");
			}).catch(() => { /* non-fatal */ });

			// Fire-and-forget one-shot migration of legacy localStorage read state
			// to the server. Idempotent — guarded by the localStorage key.
			migrateLegacyVisitedMap().catch(() => { /* non-fatal */ });

			const route = getRouteFromHash();
			if (route.view === "goal" && route.goalId) {
				await loadDashboardData(route.goalId);
			} else if (route.view === "session" && route.sessionId) {
				// A3: skip existence probe — connectToSession surfaces
				// SESSION_NOT_FOUND via the WS auth path; the dedicated
				// `session-not-found` view is rendered from there.
				await connectToSession(route.sessionId, true);
			} else if (route.view === "goal-dashboard" && route.goalId) {
				state.goalDashboardId = route.goalId;
				loadDashboardData(route.goalId);
				renderApp();
				await refreshSessions();
			} else if (route.view === "roles") {
				const { loadRolePageData } = await import("./role-manager-page.js");
				loadRolePageData();
			} else if (route.view === "role-edit" && route.roleName) {
				const { loadRolePageData, navigateToRoleEdit } = await import("./role-manager-page.js");
				await loadRolePageData();
				navigateToRoleEdit(route.roleName);
			} else if (route.view === "tools") {
				const { loadToolPageData } = await import("./tool-manager-page.js");
				loadToolPageData();
			} else if (route.view === "tool-edit" && route.toolName) {
				const { loadToolPageData, navigateToToolEdit } = await import("./tool-manager-page.js");
				await loadToolPageData();
				navigateToToolEdit(route.toolName);
			} else if (route.view === "workflows") {
				const projectId = state.activeProjectId || (state.projects[0]?.id ?? null);
				if (projectId) {
					const { setHashRoute } = await import("./routing.js");
					setHashRoute("settings", `${projectId}/workflows`, true);
					return;
				}
				const { loadWorkflowPageData } = await import("./workflow-page.js");
				loadWorkflowPageData();
			} else if (route.view === "workflow-edit" && route.workflowId) {
				const { loadWorkflowPageData, navigateToWorkflowEdit } = await import("./workflow-page.js");
				await loadWorkflowPageData();
				navigateToWorkflowEdit(route.workflowId);
			} else if (route.view === "skills") {
				const { loadSkillsPageData } = await import("./skills-page.js");
				loadSkillsPageData();
			} else if (route.view === "staff") {
				const { loadStaffPageData } = await import("./staff-page.js");
				loadStaffPageData();
			} else if (route.view === "staff-edit" && route.staffId) {
				const { loadStaffPageData, navigateToStaffEdit } = await import("./staff-page.js");
				await loadStaffPageData();
				navigateToStaffEdit(route.staffId);
			}
		} catch {
			state.appView = "disconnected";
			renderApp();
		}
	}

	// ========================================================================
	// KEYBOARD SHORTCUT REGISTRY
	// ========================================================================

	// Helper: build ordered session list and navigate up/down
	async function navigateSession(direction: "up" | "down"): Promise<void> {
		const allSessions = state.gatewaySessions;
		const nonDelegate = allSessions.filter((s) => !s.delegateOf);
		const staffSessionIds = new Set(state.staffList.map((s) => s.currentSessionId).filter(Boolean));
		const byAge = (a: { createdAt: number }, b: { createdAt: number }) => a.createdAt - b.createdAt;
		const sortedGoals = [...state.goals].sort((a, b) => a.createdAt - b.createdAt);

		const ordered: string[] = [];
		for (const goal of sortedGoals) {
			const goalSessions = nonDelegate
				.filter((s) => s.goalId === goal.id || s.teamGoalId === goal.id)
				.sort(byAge);
			for (const s of goalSessions) ordered.push(s.id);
		}
		const ungrouped = nonDelegate
			.filter((s) => !s.goalId && !s.teamGoalId && !staffSessionIds.has(s.id))
			.sort(byAge);
		for (const s of ungrouped) ordered.push(s.id);
		const staffSessions = nonDelegate
			.filter((s) => staffSessionIds.has(s.id))
			.sort(byAge);
		for (const s of staffSessions) ordered.push(s.id);

		if (ordered.length > 1) {
			const currentId = state.selectedSessionId ?? activeSessionId();
			const currentIndex = currentId ? ordered.indexOf(currentId) : -1;
			let nextIndex: number;
			if (direction === "up") {
				nextIndex = currentIndex <= 0 ? ordered.length - 1 : currentIndex - 1;
			} else {
				nextIndex = currentIndex >= ordered.length - 1 ? 0 : currentIndex + 1;
			}
			const nextId = ordered[nextIndex];
			if (nextId && nextId !== currentId) {
				const sm = await loadSessionManager();
				sm.connectToSession(nextId, true);
			}
		}
	}

	// MIGRATED shortcuts (all allowInInput: true to preserve existing behavior)
	registerShortcut({
		id: "new-session", label: "New session", category: "Sessions",
		defaultBindings: [
			{ key: "t", ctrlOrMeta: true, shift: false, alt: false },
			{ key: "n", ctrlOrMeta: false, shift: false, alt: true },
		],
		allowInInput: true,
		handler: async () => {
			if (state.appView !== "authenticated") return;
			const sm = await loadSessionManager();
			sm.createAndConnectSession();
		},
	});

	registerShortcut({
		id: "new-session-popover", label: "New session (with options)", category: "Sessions",
		defaultBindings: [
			{ key: "t", ctrlOrMeta: true, shift: true, alt: false },
			{ key: "n", ctrlOrMeta: false, shift: true, alt: true },
		],
		allowInInput: true,
		handler: async () => {
			if (state.appView !== "authenticated") return;
			const { toggleRolePicker } = await import("./sidebar.js");
			// Synthesize a click event targeting the new-session button area
			const chevron = document.querySelector("[title='New session with role']");
			const syntheticEvent = new MouseEvent("click", { bubbles: true });
			if (chevron) Object.defineProperty(syntheticEvent, "currentTarget", { value: chevron });
			toggleRolePicker(syntheticEvent);
		},
	});

	registerShortcut({
		id: "focus-input", label: "Focus message input", category: "Navigation",
		defaultBindings: [{ key: "/", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: true,
		handler: () => {
			const textarea = document.querySelector("message-editor")?.querySelector("textarea");
			if (textarea) (textarea as HTMLElement).focus();
		},
	});

	registerShortcut({
		id: "toggle-sidebar", label: "Toggle sidebar", category: "UI",
		defaultBindings: [{ key: "[", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: true,
		handler: () => {
			state.sidebarCollapsed = !state.sidebarCollapsed;
			localStorage.setItem("bobbit-sidebar-collapsed", String(state.sidebarCollapsed));
			renderApp();
		},
	});

	registerShortcut({
		id: "prev-session", label: "Previous session", category: "Sessions",
		defaultBindings: [{ key: "ArrowUp", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: true,
		handler: () => navigateSession("up"),
	});

	registerShortcut({
		id: "next-session", label: "Next session", category: "Sessions",
		defaultBindings: [{ key: "ArrowDown", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: true,
		handler: () => navigateSession("down"),
	});

	registerShortcut({
		id: "toggle-preview", label: "Collapse/expand preview panel", category: "UI",
		defaultBindings: [{ key: "]", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: true,
		handler: () => {
			const hasPanel = !state.assistantType && (state.isPreviewSession || state.activeProposals.goal != null || state.reviewPanelOpen);
			if (hasPanel) {
				// If fullscreen, exit fullscreen and collapse in one step
				if (state.previewPanelFullscreen) {
					state.previewPanelFullscreen = false;
				}
				const key = `bobbit-preview-collapsed-${activeSessionId()}`;
				const collapsed = localStorage.getItem(key) === "true";
				localStorage.setItem(key, String(!collapsed));
				renderApp();
			}
		},
	});

	registerShortcut({
		id: "toggle-fullscreen-preview", label: "Toggle fullscreen preview", category: "UI",
		defaultBindings: [{ key: "#", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: true,
		handler: () => {
			const hasPanel = !state.assistantType && (state.isPreviewSession || state.reviewPanelOpen);
			if (hasPanel) {
				const key = `bobbit-preview-collapsed-${activeSessionId()}`;
				if (state.previewPanelFullscreen) {
					// Exiting fullscreen — restore whatever state we saved on entry
					state.previewPanelFullscreen = false;
					const restore = sessionStorage.getItem("bobbit-pre-fullscreen-collapsed");
					if (restore === "true") {
						localStorage.setItem(key, "true");
					}
					sessionStorage.removeItem("bobbit-pre-fullscreen-collapsed");
				} else {
					// Entering fullscreen — remember current collapsed state
					const wasCollapsed = localStorage.getItem(key) === "true";
					sessionStorage.setItem("bobbit-pre-fullscreen-collapsed", String(wasCollapsed));
					localStorage.setItem(key, "false");
					state.previewPanelFullscreen = true;
				}
				renderApp();
			}
		},
	});

	// NEW shortcuts
	registerShortcut({
		id: "new-goal", label: "New goal", category: "Goals",
		defaultBindings: [{ key: "g", ctrlOrMeta: false, shift: false, alt: true }],
		handler: () => {
			import("./goal-entry.js").then(({ startNewGoalFlow }) => {
				const anchor = document.querySelector("[data-new-goal-trigger]") as HTMLElement | null;
				startNewGoalFlow(anchor);
			});
		},
	});

	registerShortcut({
		id: "terminate-session", label: "Terminate session", category: "Sessions",
		defaultBindings: [{ key: "d", ctrlOrMeta: true, shift: true, alt: false }],
		handler: async () => {
			const id = activeSessionId();
			if (id) {
				const sm = await loadSessionManager();
				sm.terminateSession(id);
			}
		},
	});

	registerShortcut({
		id: "show-settings", label: "Settings", category: "UI",
		defaultBindings: [{ key: ",", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: true,
		handler: async () => {
			const { toggleSettings } = await import("./settings-page.js");
			toggleSettings();
		},
	});

	await loadSavedBindings();
	startListening();
	// Marker for E2E tests: indicates the keydown listener is attached so
	// tests can dispatch synthetic keyboard events without racing startup.
	if (typeof document !== "undefined") {
		document.body.dataset.shortcutsReady = "1";
	}

	// Sync preferences when the page becomes visible (covers cross-device
	// changes when the user switches back to this tab/app).
	document.addEventListener("visibilitychange", async () => {
		if (document.visibilityState !== "visible") return;
		if (state.appView !== "authenticated") return;
		const api = await loadApi();
		const { gatewayFetch, refreshSessions, resetPrPollThrottle } = api;
		// Reset PR poll throttle so the next session poll refreshes PR badges immediately
		resetPrPollThrottle();
		// Trigger an immediate session refresh (includes PR status due to throttle reset)
		refreshSessions();
		try {
			const res = await gatewayFetch("/api/preferences");
			if (!res.ok) return;
			const prefs = await res.json();
			// Apply palette
			const palette = (prefs.palette as string) || "forest";
			if (palette === "forest") {
				delete document.documentElement.dataset.palette;
				localStorage.removeItem('palette');
			} else {
				document.documentElement.dataset.palette = palette;
				localStorage.setItem('palette', palette);
			}
			// Apply showTimestamps
			document.documentElement.dataset.showTimestamps = prefs.showTimestamps ? "true" : "";
			// Apply playAgentFinishSound — default ON when unset.
			document.documentElement.dataset.playAgentFinishSound =
				prefs.playAgentFinishSound === false ? "false" : "true";
			// Reload shortcuts if changed
			if (prefs.shortcuts) {
				await loadSavedBindings();
			}
		} catch {}
	});
}

initApp();

// Register service worker for PWA installability
if ('serviceWorker' in navigator) {
	navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Vite HMR hot-reload detection
if (import.meta.hot) {
	import.meta.hot.on('vite:beforeFullReload', () => {
		sessionStorage.setItem('bobbit-hot-reload', '1');
		// Flush any pending draft so the message editor content survives the reload
		import("./session-manager.js").then(m => m.flushPendingDraft());
	});
}
