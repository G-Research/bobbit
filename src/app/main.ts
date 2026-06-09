import "./app.css";
// Eagerly load CSS that is also used by proposal preview panes
// ([data-panel="project-proposal"], [data-panel="role-proposal"],
// [data-panel="tool-proposal"]). These stylesheets are otherwise only
// imported by their lazy *-page.ts modules — opening a proposal pane in a
// fresh tab without first visiting the corresponding Settings page would
// render the pane unstyled. Vite chunks CSS and JS independently, so an
// eager CSS import does NOT pull in the lazy JS chunk.
// Pinned by tests/e2e/ui/proposal-pane-styles.spec.ts.
import "./workflow-page.css";
import "./role-manager.css";
import "./tool-manager.css";
import "./marketplace.css";
import "./storage.js"; // must initialize before anything else
// Eagerly register <bg-process-pill> so it's available the moment the chat
// view mounts. Lazy-loading via `ensureBgProcessPill()` (lazy-widgets.ts) was
// 9.3 kB cheaper but produced occasional pill-overflow test flakes during the
// first paint on cold start, before the chunk had landed. Trading 9 kB raw
// (still well under the 600 kB entry budget) for deterministic upgrade.
import "../ui/components/BgProcessPill.js";
import { ChatPanel } from "../ui/index.js";
import {
	state,
	setRenderApp,
	renderApp,
	GW_URL_KEY,
	GW_TOKEN_KEY,
	activeSessionId,
	expandedGoals,
} from "./state.js";
import { gatewayFetch, refreshSessions, resetPrPollThrottle } from "./api.js";
import { getRouteFromHash, setHashRoute } from "./routing.js";
import { authenticateGateway, connectToSession, createAndConnectSession, terminateSession, applyProjectPalette, flushAndTeardownDraft, flushPendingDraft } from "./session-manager.js";
import { migrateLegacyVisitedMap } from "./render-helpers.js";
import { installPwaLifecycleRecovery, markAppBooted } from "./pwa-lifecycle.js";
import { doRenderApp, showHeaderToast, workspaceSessionId } from "./render.js";
import { renderTool } from "../ui/tools/index.js";
import { navigateSidebar, expandActiveSidebarItem, installKeyboardNavOverrideClearListener } from "./sidebar-nav.js";
import { toggleRolePicker } from "./sidebar.js";
import { startNewGoalFlow } from "./goal-entry.js";
import { toggleShowArchived, toggleShowBusy, toggleShowRead } from "../ui/components/sidebar-filters.js";
import { PROPOSAL_TYPES } from "./proposal-registry.js";
// goal-dashboard is dynamic-imported lazily to keep it out of the main chunk.
// See docs/design/ui-bundle-size-reduction.md (Task A).
let _goalDashboardModule: typeof import("./goal-dashboard.js") | null = null;
async function loadDashboardData(goalId: string): Promise<void> {
	if (!_goalDashboardModule) _goalDashboardModule = await import("./goal-dashboard.js");
	return _goalDashboardModule.loadDashboardData(goalId);
}
function clearDashboardState(): void {
	// No-op when the dashboard chunk hasn't been loaded yet — nothing to clear,
	// and importing it here would defeat the route-level code-split.
	if (_goalDashboardModule) _goalDashboardModule.clearDashboardState();
}
import { registerShortcut, startListening, loadSavedBindings } from "./shortcut-registry.js";
import { activeSidePanelTabIdForSession, loadPersistedPanelWorkspace } from "./panel-workspace.js";
import { bootMark } from "./boot-timing.js";

// Boot-timing: this fires only after the entire eager module graph has been
// fetched + evaluated (the Vite dev module waterfall), so `t` here ≈ cost of
// navigation → all modules ready. Dev-only; no-op in production.
bootMark("modules-evaluated");

// ============================================================================
// WIRE UP RENDER
// ============================================================================

setRenderApp(doRenderApp);

// Restore side-pane tab order, active tab, and preview-version registry from
// localStorage so user reorders survive reload. Persistence is keyed per
// session; the corresponding writes live in panel-workspace.ts.
loadPersistedPanelWorkspace(state);

// Expose state on window for E2E tests (harmless in production — the state
// object is already mutable from devtools and contains no secrets).
(window as any).__bobbitState = state;
// Expose the render trigger too, so tests that patch in-memory state can
// force a fresh paint without relying on viewport-resize side effects.
(window as any).__bobbitRenderApp = renderApp;
// Expose the expanded-goals set so tests that inject synthetic goals into
// state.goals can also force them into the expanded state (the normal
// auto-expand path only fires for goals the server has confirmed).
(window as any).__bobbitExpandedGoals = expandedGoals;

// E2E test hook: expose renderTool() and lit-html's render() so browser-based
// tests can mount renderers directly without going through the session
// pipeline. Used by tests/e2e/ui/children-tool-renderers.spec.ts.
(window as any).__bobbitRenderTool = renderTool;
import("lit").then(m => { (window as any).__bobbitLitRender = m.render; }).catch(() => {});

// E2E test hook: re-drive pack-renderer reconciliation (extension-host §4a) the
// SAME way a marketplace install/uninstall does (marketplace-page.ts), so browser
// E2E can assert the running UI reconciles (stale pack renderer removed, built-in
// restored) WITHOUT a page reload. Used by tests/e2e/ui/extension-host.spec.ts.
(window as any).__bobbitReconcilePackRenderers = async () => {
	// Delegate to the REAL marketplace-mutation reconcile (renderers + panels +
	// entrypoints), which FORCE re-registers from freshly fetched metadata —
	// bypassing the per-registry dedupe guard so an install/uninstall tears down
	// removed renderers/panels/entrypoints+routes WITHOUT a reload. The previous
	// hook only force-registered renderers and used the DEDUPED panel/entrypoint
	// reconcile, so an uninstall left a stale pack panel/route mounted (a latent
	// test-hook bug surfaced by the D2 litmus uninstall-reconcile assertion).
	const { reconcileRenderersForActiveSession } = await import("./marketplace-page.js");
	await reconcileRenderersForActiveSession();
};

// E2E test hook: run a pack composer-slash/git-widget/command-palette launcher
// entrypoint by id — the SAME `runLauncherEntrypoint` the MessageEditor slash menu
// calls on a user click (Slice C1). Lets the pr-walkthrough-pack browser E2E
// (tests/e2e/ui/pr-walkthrough-pack.spec.ts) trigger "entrypoint launches the
// panel" deterministically without racing the composer's one-shot slash-skills
// cache. Faithful: it exercises the real launcher→navigate→openPanel chain.
(window as any).__bobbitRunPackLauncher = async (id: string): Promise<void> => {
	const { runLauncherEntrypoint } = await import("./pack-entrypoints.js");
	runLauncherEntrypoint(id);
};

function hasActiveProposalPanel(): boolean {
	return PROPOSAL_TYPES.some((type) => state.activeProposals[type] != null);
}

function hasActiveWalkthroughPanel(): boolean {
	// Used by the in-app resize keyboard shortcuts to recognise the unified panel
	// as a fullscreen-able walkthrough. The standalone `/walkthrough` route has no
	// panel-level resize chrome, so it intentionally has no special-case here.
	return activeSidePanelTabIdForSession(state, workspaceSessionId()).startsWith("walkthrough:");
}

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

	while (true) {
		try {
			await authenticateGateway(url, token);
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

/**
 * Slice C1 — restore a `#/ext/<routeId>?<params>` pack deep-link (extension-host-
 * phase2 §7 C1.2a): ensure pack entrypoints are reconciled for the active project
 * (so a cold-load deep-link resolves even if the boot reconcile is still in flight),
 * look the routeId up in the client pack-route registry, and open the target panel
 * with the parsed params (the panel rehydrates its content from host.store). A
 * routeId with no registered owner (e.g. the pack was uninstalled) is ignored.
 */
async function restoreExtRoute(routeId: string | undefined, params: Record<string, string> | undefined): Promise<void> {
	if (!routeId) return;
	try {
		const { reconcilePackEntrypointsForProject, lookupPackRoute } = await import("./pack-entrypoints.js");
		await reconcilePackEntrypointsForProject(state.activeProjectId ?? undefined);
		const entry = lookupPackRoute(routeId);
		if (!entry) return; // owning pack not installed for this project
		const openParams: Record<string, unknown> = {};
		if (params) for (const key of entry.paramKeys) if (key in params) openParams[key] = params[key];
		const { openPackPanel } = await import("./pack-panels.js");
		openPackPanel({ panelId: entry.targetPanelId, params: openParams });
	} catch { /* non-fatal — a bad deep-link must never break boot */ }
}

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

		// Flush and tear down draft handlers when leaving a session view.
		// Session-to-session switches handle this via selectSession(), but
		// navigation to non-session views (settings, roles, dashboard, etc.)
		// bypasses selectSession entirely, leaving the draft unflushed and
		// the editor content lost when the DOM is replaced (CT-02, PI-04f).
		if (route.view !== "session") {
			flushAndTeardownDraft();
		}

		if (route.view === "ext") {
			// Slice C1 — pack deep-link. Open the target panel as an overlay on the
			// CURRENT view (do NOT tear down the session/goal context); the panel mounts
			// into the side-panel workspace of the active session.
			if (state.appView !== "authenticated") state.appView = "authenticated";
			await restoreExtRoute(route.extRouteId, route.extParams);
			renderApp();
		} else if (route.view === "goal" && route.goalId) {
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
			const checkRes = await gatewayFetch(`/api/sessions/${route.sessionId}`);
			if (checkRes.ok) {
				await connectToSession(route.sessionId, true);
			} else {
				setHashRoute("landing");
				state.appView = "authenticated";
				renderApp();
				await refreshSessions();
			}
		} else if (route.view === "goal-dashboard" && route.goalId) {
			// Preserve prior UI state so a missing goal can keep the current view.
			const prevSelectedSessionId = state.selectedSessionId;
			const prevGoalDashboardId = state.goalDashboardId;
			const prevAppView = state.appView;

			// Refresh sessions first so state.goals contains the latest active,
			// archived, and cross-project goal data before we try to resolve.
			await refreshSessions();

			// Resolve the goal: in-state first, then fall back to a per-id API
			// fetch (covers cross-project and freshly-spawned goals not yet in
			// the local goals list).
			let gdGoal: any = state.goals.find(g => g.id === route.goalId) || null;
			if (!gdGoal) {
				try {
					const res = await gatewayFetch(`/api/goals/${route.goalId}`);
					if (res.ok) {
						const fetched: any = await res.json().catch(() => null);
						if (fetched && fetched.id) {
							gdGoal = fetched;
							// Merge into state.goals so the sidebar can reflect
							// the target project on the upcoming render.
							const idx = state.goals.findIndex(g => g.id === fetched.id);
							if (idx >= 0) state.goals[idx] = { ...state.goals[idx], ...fetched };
							else state.goals.push(fetched);
						}
					}
				} catch { /* ignore — handled below */ }
			}

			if (!gdGoal) {
				// Goal can't be resolved anywhere — toast and stay on prior view.
				showHeaderToast(`Goal no longer exists (id=${route.goalId.slice(0, 8)})`);
				state.selectedSessionId = prevSelectedSessionId;
				state.goalDashboardId = prevGoalDashboardId;
				state.appView = prevAppView;
				// Restore the hash to the previous concrete route when possible,
				// rather than leaving the bad #/goal/<id> in the URL bar. Use
				// replaceState-style routing so we don't recurse through handleHashChange.
				if (prevSelectedSessionId) {
					setHashRoute("session", prevSelectedSessionId, true);
				} else if (prevGoalDashboardId) {
					setHashRoute("goal-dashboard", prevGoalDashboardId, true);
				}
				renderApp();
				return;
			}

			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.goalDashboardId = route.goalId;
			// Apply palette for the goal's project. applyProjectPalette also
			// updates state.activeProjectId, which keeps the sidebar/breadcrumb
			// pointed at the right project for cross-project navigation.
			applyProjectPalette(gdGoal.projectId);
			state.appView = "authenticated";
			loadDashboardData(route.goalId);
			renderApp();
			await refreshSessions();
		} else if (route.view === "walkthrough") {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.goalDashboardId = null;
			state.appView = "authenticated";
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
		} else if (route.view === "market") {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.selectedSessionId = null;
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadMarketplaceData } = await import("./marketplace-page.js");
			loadMarketplaceData();
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
	bootMark("initApp-start");
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	// Palette is loaded from server preferences after gateway auth (see below)

	state.chatPanel = new ChatPanel();

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
	bootMark("first-render-call");
	renderApp();
	// Signal boot intent. renderApp() defers the real Lit render to a rAF, so
	// #app may still be empty right now — markAppBooted() does NOT clear the
	// index.html boot watchdog until #app ACTUALLY paints (via MutationObserver).
	// See pwa-lifecycle.ts.
	markAppBooted();

	// Listen for browser back/forward navigation — register early so hash changes
	// during async init (gateway wait, session refresh) are not silently missed.
	window.addEventListener("hashchange", handleHashChange);

	if (savedUrl && savedToken) {
		try {
			await waitForGateway(savedUrl, savedToken);

			// Register pack-contributed tool renderers (extension-host §4a). Fire-and-
			// forget so it never blocks boot; re-driven from /api/tools metadata so it
			// survives reload. A zero-pack install resolves to an empty list (no-op).
			void (async () => {
				try {
					const { reconcilePackRenderersForProject } = await import("./pack-renderers.js");
					// Thread the active project so a project-scope pack's renderer
					// metadata + Blob fetch resolve the same winner (design §4b). May be
					// null this early in boot; server/global-scope packs still register,
					// and connecting to a session re-drives this with the SESSION's
					// project (session-manager) so a reload / deep-link into a session
					// whose project differs from the active/default resolves correctly.
					await reconcilePackRenderersForProject(state.activeProjectId ?? undefined);
					// Slice B4 — same lifecycle for pack-contributed side panels.
					const { reconcilePackPanelsForProject } = await import("./pack-panels.js");
					await reconcilePackPanelsForProject(state.activeProjectId ?? undefined);
					// Slice C1 — same lifecycle for pack-contributed entrypoints + deep-link routes.
					const { reconcilePackEntrypointsForProject } = await import("./pack-entrypoints.js");
					await reconcilePackEntrypointsForProject(state.activeProjectId ?? undefined);
				} catch { /* non-fatal — built-in renderers/panels are unaffected */ }
			})();

			// Load saved preferences (palette, timestamps, AI gateway)
			try {
				const prefRes = await gatewayFetch("/api/preferences");
				if (prefRes.ok) {
					const prefs = await prefRes.json();
					if (prefs.palette && prefs.palette !== "forest") {
						document.documentElement.dataset.palette = prefs.palette;
						localStorage.setItem('palette', prefs.palette);
					} else {
						localStorage.removeItem('palette');
					}
					// Apply showTimestamps
					if (prefs.showTimestamps) {
						document.documentElement.dataset.showTimestamps = "true";
					}
					// Apply playAgentFinishSound — default ON when unset.
					document.documentElement.dataset.playAgentFinishSound =
						prefs.playAgentFinishSound === false ? "false" : "true";
					// Apply subgoalsEnabled — default OFF (only explicit true opts in).
					document.documentElement.dataset.subgoalsEnabled =
						prefs.subgoalsEnabled === true ? "true" : "false";
					// Apply maxNestingDepth — default 3 when unset/invalid.
					document.documentElement.dataset.maxNestingDepth =
						(typeof prefs.maxNestingDepth === "number" && Number.isFinite(prefs.maxNestingDepth))
							? String(prefs.maxNestingDepth)
							: "3";
				}
			} catch {}

			// Fire-and-forget one-shot migration of legacy localStorage read state
			// to the server. Idempotent — guarded by the localStorage key.
			migrateLegacyVisitedMap().catch(() => { /* non-fatal */ });

			const route = getRouteFromHash();
			if (route.view === "goal" && route.goalId) {
				await loadDashboardData(route.goalId);
			} else if (route.view === "session" && route.sessionId) {
				const checkRes = await gatewayFetch(`/api/sessions/${route.sessionId}`);
				if (checkRes.ok) {
					await connectToSession(route.sessionId, true);
				}
			} else if (route.view === "goal-dashboard" && route.goalId) {
				state.goalDashboardId = route.goalId;
				loadDashboardData(route.goalId);
				renderApp();
				await refreshSessions();
			} else if (route.view === "walkthrough") {
				state.appView = "authenticated";
				renderApp();
				await refreshSessions();
			} else if (route.view === "ext") {
				// Slice C1 — cold-load pack deep-link restoration.
				state.appView = "authenticated";
				renderApp();
				await refreshSessions();
				await restoreExtRoute(route.extRouteId, route.extParams);
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
			} else if (route.view === "market") {
				const { loadMarketplaceData } = await import("./marketplace-page.js");
				loadMarketplaceData();
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

	// Sidebar keyboard navigation. Source of truth for the row order is the
	// rendered DOM (so search filters, collapsed sections, and archived view
	// are honoured automatically). See src/app/sidebar-nav.ts.
	installKeyboardNavOverrideClearListener();

	// MIGRATED shortcuts (all allowInInput: true to preserve existing behavior)
	registerShortcut({
		id: "new-session", label: "New session", category: "Sessions",
		defaultBindings: [
			{ key: "t", ctrlOrMeta: true, shift: false, alt: false },
			{ key: "n", ctrlOrMeta: false, shift: false, alt: true },
		],
		allowInInput: true,
		handler: () => { if (state.appView === "authenticated") createAndConnectSession(); },
	});

	registerShortcut({
		id: "new-session-popover", label: "New session (with options)", category: "Sessions",
		defaultBindings: [
			{ key: "t", ctrlOrMeta: true, shift: true, alt: false },
			{ key: "n", ctrlOrMeta: false, shift: true, alt: true },
		],
		allowInInput: true,
		handler: () => {
			if (state.appView !== "authenticated") return;
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
		id: "focus-search", label: "Focus sidebar search", category: "Navigation",
		defaultBindings: [{ key: "k", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: true,
		handler: () => {
			const input = document.querySelector<HTMLInputElement>("search-box input[data-search]");
			input?.focus();
		},
	});

	registerShortcut({
		// Ctrl+[ — expand preview panel one level (collapsed → half → full) when a
		// preview/review/proposal panel is visible. Falls back to toggling the
		// sidebar when no such panel exists.
		id: "toggle-sidebar", label: "Expand preview / toggle sidebar", category: "UI",
		defaultBindings: [{ key: "[", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: true,
		handler: () => {
			const canFullscreen = !state.assistantType && (state.isPreviewSession || state.reviewPanelOpen || state.inboxPanelOpen || hasActiveWalkthroughPanel());
			const hasPanel = canFullscreen || (!state.assistantType && hasActiveProposalPanel());
			if (hasPanel) {
				const key = `bobbit-preview-collapsed-${workspaceSessionId()}`;
				const collapsed = localStorage.getItem(key) === "true";
				if (collapsed) {
					// level 0 → 1: uncollapse to half view
					localStorage.setItem(key, "false");
				} else if (!state.previewPanelFullscreen && canFullscreen) {
					// level 1 → 2: enter fullscreen
					sessionStorage.setItem("bobbit-pre-fullscreen-collapsed", "false");
					state.previewPanelFullscreen = true;
				}
				// already at level 2 — no-op
				renderApp();
				return;
			}
			state.sidebarCollapsed = !state.sidebarCollapsed;
			localStorage.setItem("bobbit-sidebar-collapsed", String(state.sidebarCollapsed));
			renderApp();
		},
	});

	registerShortcut({
		id: "prev-session", label: "Previous sidebar row", category: "Sessions",
		defaultBindings: [{ key: "ArrowUp", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: true,
		handler: () => { navigateSidebar("up"); },
	});

	registerShortcut({
		id: "next-session", label: "Next sidebar row", category: "Sessions",
		defaultBindings: [{ key: "ArrowDown", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: true,
		handler: () => { navigateSidebar("down"); },
	});

	// Ctrl+→ / Ctrl+←: allowInInput is FALSE so native word-jump wins inside
	// the prompt editor and other text inputs. The sidebar only captures these
	// keys when focus is outside any input (e.g. on the sidebar itself).
	registerShortcut({
		id: "sidebar-expand", label: "Expand sidebar group", category: "Sessions",
		defaultBindings: [{ key: "ArrowRight", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: false,
		handler: () => { expandActiveSidebarItem(true); },
	});

	registerShortcut({
		id: "sidebar-collapse", label: "Collapse sidebar group", category: "Sessions",
		defaultBindings: [{ key: "ArrowLeft", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: false,
		handler: () => { expandActiveSidebarItem(false); },
	});

	registerShortcut({
		// Ctrl+] — collapse preview panel one level (full → half → collapsed).
		id: "toggle-preview", label: "Collapse preview panel", category: "UI",
		defaultBindings: [{ key: "]", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: true,
		handler: () => {
			const hasPanel = !state.assistantType && (state.isPreviewSession || state.reviewPanelOpen || state.inboxPanelOpen || hasActiveWalkthroughPanel() || hasActiveProposalPanel());
			if (!hasPanel) return;
			const key = `bobbit-preview-collapsed-${workspaceSessionId()}`;
			if (state.previewPanelFullscreen) {
				// level 2 → 1: exit fullscreen, keep half view
				state.previewPanelFullscreen = false;
				localStorage.setItem(key, "false");
				sessionStorage.removeItem("bobbit-pre-fullscreen-collapsed");
			} else if (localStorage.getItem(key) !== "true") {
				// level 1 → 0: collapse
				localStorage.setItem(key, "true");
			}
			// already at level 0 — no-op
			renderApp();
		},
	});

	registerShortcut({
		// Ctrl+# — jump straight to fullscreen (level 2). If already fullscreen,
		// jump straight to collapsed (level 0).
		id: "toggle-fullscreen-preview", label: "Fullscreen ↔ collapsed preview", category: "UI",
		defaultBindings: [{ key: "#", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: true,
		handler: () => {
			const hasWalkthroughPanel = hasActiveWalkthroughPanel();
			const hasPanel = !state.assistantType && (state.isPreviewSession || state.reviewPanelOpen || state.inboxPanelOpen || hasWalkthroughPanel || hasActiveProposalPanel());
			if (hasPanel) {
				const key = `bobbit-preview-collapsed-${workspaceSessionId()}`;
				if (state.previewPanelFullscreen) {
					// level 2 → 0: exit fullscreen and collapse
					state.previewPanelFullscreen = false;
					localStorage.setItem(key, "true");
					sessionStorage.removeItem("bobbit-pre-fullscreen-collapsed");
				} else if (state.isPreviewSession || hasWalkthroughPanel) {
					// any non-fullscreen level → 2: jump to fullscreen
					localStorage.setItem(key, "false");
					state.previewPanelFullscreen = true;
				} else {
					// Proposal/review/inbox-only panels have no fullscreen surface.
					const collapsed = localStorage.getItem(key) === "true";
					localStorage.setItem(key, collapsed ? "false" : "true");
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
			const anchor = document.querySelector("[data-new-goal-trigger]") as HTMLElement | null;
			startNewGoalFlow(anchor);
		},
	});

	registerShortcut({
		id: "terminate-session", label: "Terminate session", category: "Sessions",
		defaultBindings: [{ key: "d", ctrlOrMeta: true, shift: true, alt: false }],
		handler: () => {
			const id = activeSessionId();
			if (id) terminateSession(id);
		},
	});

	registerShortcut({
		id: "ui.toggle-show-archived", label: "Toggle Show Archived", category: "UI",
		defaultBindings: [{ key: "a", ctrlOrMeta: false, shift: true, alt: true }],
		allowInInput: true,
		handler: () => {
			toggleShowArchived();
		},
	});

	registerShortcut({
		id: "ui.toggle-show-busy", label: "Toggle Show Busy", category: "UI",
		defaultBindings: [{ key: "b", ctrlOrMeta: false, shift: true, alt: true }],
		allowInInput: true,
		handler: () => {
			toggleShowBusy();
		},
	});

	registerShortcut({
		id: "ui.toggle-show-read", label: "Toggle Show Read", category: "UI",
		defaultBindings: [{ key: "r", ctrlOrMeta: false, shift: true, alt: true }],
		allowInInput: true,
		handler: () => {
			toggleShowRead();
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

	// Refresh ${shortcutHint(...)} evaluations that were stamped as "" by the
	// early renderApp() at the top of initApp(): at that point no shortcut had
	// been registered yet, so toolbar/sidebar titles like "New goal" were missing
	// their "(Alt+G)" suffix until some incidental state change re-rendered.
	renderApp();

	// Sync preferences when the page becomes visible (covers cross-device
	// changes when the user switches back to this tab/app).
	document.addEventListener("visibilitychange", async () => {
		if (document.visibilityState !== "visible") return;
		if (state.appView !== "authenticated") return;
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
			// Apply subgoalsEnabled — default OFF (only explicit true opts in).
			document.documentElement.dataset.subgoalsEnabled =
				prefs.subgoalsEnabled === true ? "true" : "false";
			// Apply maxNestingDepth — default 3 when unset/invalid.
			document.documentElement.dataset.maxNestingDepth =
				(typeof prefs.maxNestingDepth === "number" && Number.isFinite(prefs.maxNestingDepth))
					? String(prefs.maxNestingDepth)
					: "3";
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

// iOS PWA grey-screen recovery (frozen/killed standalone snapshot on relaunch).
// All paths are gated on standalone display mode, so a normal browser tab and
// the dev server are unaffected. Division of labor: this recovers a DEAD/FROZEN
// page (force reload to re-bootstrap); the existing `visibilitychange` handler
// above and `_onVisibilityChange` in remote-agent.ts recover a dead WebSocket on
// a LIVE page. The two are disjoint and must not be conflated. See
// src/app/pwa-lifecycle.ts.
if (import.meta.hot) {
	// Never let the inline boot watchdog fight Vite HMR full-reloads in dev.
	if (typeof window !== "undefined" && window.__bobbitBootWatchdog != null) {
		clearTimeout(window.__bobbitBootWatchdog as ReturnType<typeof setTimeout>);
		window.__bobbitBootWatchdog = undefined;
	}
}
installPwaLifecycleRecovery();

// Vite HMR hot-reload detection
if (import.meta.hot) {
	import.meta.hot.on('vite:beforeFullReload', () => {
		sessionStorage.setItem('bobbit-hot-reload', '1');
		// Flush any pending draft so the message editor content survives the reload
		flushPendingDraft();
	});
}
