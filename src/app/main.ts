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
import "./storage.js"; // must initialize before anything else
import { ChatPanel } from "../ui/index.js";
import {
	state,
	setRenderApp,
	renderApp,
	GW_URL_KEY,
	GW_TOKEN_KEY,
	activeSessionId,
} from "./state.js";
import { gatewayFetch, refreshSessions, resetPrPollThrottle } from "./api.js";
import { getRouteFromHash, setHashRoute } from "./routing.js";
import { authenticateGateway, connectToSession, createAndConnectSession, terminateSession, applyProjectPalette, flushAndTeardownDraft } from "./session-manager.js";
import { migrateLegacyVisitedMap } from "./render-helpers.js";
import { doRenderApp } from "./render.js";
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

// ============================================================================
// WIRE UP RENDER
// ============================================================================

setRenderApp(doRenderApp);

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
	renderApp();

	// Listen for browser back/forward navigation — register early so hash changes
	// during async init (gateway wait, session refresh) are not silently missed.
	window.addEventListener("hashchange", handleHashChange);

	if (savedUrl && savedToken) {
		try {
			await waitForGateway(savedUrl, savedToken);

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

	// Sidebar keyboard navigation. Source of truth for the row order is the
	// rendered DOM (so search filters, collapsed sections, and archived view
	// are honoured automatically). See src/app/sidebar-nav.ts.
	const { navigateSidebar, expandActiveSidebarItem, installKeyboardNavOverrideClearListener } = await import("./sidebar-nav.js");
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
			const canFullscreen = !state.assistantType && (state.isPreviewSession || state.reviewPanelOpen);
			const hasPanel = canFullscreen || (!state.assistantType && state.activeProposals.goal != null);
			if (hasPanel) {
				const key = `bobbit-preview-collapsed-${activeSessionId()}`;
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
			const hasPanel = !state.assistantType && (state.isPreviewSession || state.activeProposals.goal != null || state.reviewPanelOpen);
			if (!hasPanel) return;
			const key = `bobbit-preview-collapsed-${activeSessionId()}`;
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
			const hasPanel = !state.assistantType && (state.isPreviewSession || state.reviewPanelOpen);
			if (hasPanel) {
				const key = `bobbit-preview-collapsed-${activeSessionId()}`;
				if (state.previewPanelFullscreen) {
					// level 2 → 0: exit fullscreen and collapse
					state.previewPanelFullscreen = false;
					localStorage.setItem(key, "true");
					sessionStorage.removeItem("bobbit-pre-fullscreen-collapsed");
				} else {
					// any non-fullscreen level → 2: jump to fullscreen
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
		handler: () => {
			const id = activeSessionId();
			if (id) terminateSession(id);
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
