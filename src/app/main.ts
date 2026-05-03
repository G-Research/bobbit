import "./app.css";
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
import { loadSnapshot, scheduleSave } from "./ui-snapshot.js";
import { loadDashboardData, clearDashboardState } from "./goal-dashboard.js";
import { registerShortcut, startListening, loadSavedBindings } from "./shortcut-registry.js";

// ============================================================================
// WIRE UP RENDER
// ============================================================================

setRenderApp(doRenderApp);

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

	// ------------------------------------------------------------------
	// SYNCHRONOUS SNAPSHOT HYDRATE — first paint must happen before any
	// `await`. We project the persisted snapshot onto `state` so the very
	// first renderApp() call below paints the last-known view, even if
	// the gateway is unreachable / iOS just restored a process snapshot.
	// Reconciliation with fresh server data flows through the existing
	// reducer survivor filter (see remote-agent.ts → `"snapshot"` action).
	// ------------------------------------------------------------------
	try {
		const snap = loadSnapshot();
		if (snap) {
			if (Array.isArray(snap.projects)) state.projects = snap.projects;
			if (typeof snap.activeProjectId === "string" || snap.activeProjectId === null) {
				state.activeProjectId = snap.activeProjectId;
			}
			if (Array.isArray(snap.goals)) state.goals = snap.goals;
			if (Array.isArray(snap.archivedSessions)) state.archivedSessions = snap.archivedSessions;
			if (typeof snap.selectedSessionId === "string") {
				state.selectedSessionId = snap.selectedSessionId;
			}
			// Connection status from snapshot is informational — actual WS
			// state is recomputed once the network call lands. Showing the
			// last-known status ("connected") avoids a brief disconnected flash.
			if (typeof snap.activeSession?.connectionStatus === "string") {
				state.connectionStatus = snap.activeSession.connectionStatus;
			}
			// Any saved creds → assume we'll be authenticated; non-authed paint
			// is reserved for the genuinely-no-creds case below.
			const preUrl = localStorage.getItem(GW_URL_KEY);
			const preToken = localStorage.getItem(GW_TOKEN_KEY);
			if (preUrl && preToken) state.appView = "authenticated";
		}
	} catch { /* snapshot hydrate must never crash bootstrap */ }

	// Trigger the inline-skeleton prepaint defined in index.html so the
	// last-rendered transcript text shows up even when the prior snapshot
	// was written by THIS bootstrap (i.e. same-URL navigations where the
	// inline script's first invocation ran with empty localStorage).
	try { (window as any).__bobbitPrepaint?.(); } catch { /* non-fatal */ }

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
	// "disconnected" — the gateway may just be booting up. With a hydrated
	// snapshot we go directly to "authenticated" view (the cached UI is
	// already rendered); only fall back to "gateway-starting" when there's
	// no snapshot to paint.
	if (savedUrl && savedToken && state.appView !== "authenticated") {
		state.appView = "gateway-starting";
	}
	renderApp();
	// Mark the app container as having been rendered by Lit — the inline
	// watchdog in index.html cancels its 3 s / 10 s escalation when this
	// attribute appears.
	try {
		const appEl = document.getElementById("app");
		if (appEl) appEl.setAttribute("data-rendered", "true");
	} catch { /* non-fatal */ }

	// Tear down any leftover boot-skeleton DOM and disarm the inline
	// prepaint function. Normally the inline MutationObserver in index.html
	// hides the skeleton when `data-rendered` flips, but a tab loaded with
	// a stale (pre-fix) cached `index.html` runs the older prepaint script
	// that re-appends a `Reconnecting…` pill on every `localStorage.setItem`
	// via a monkey-patched `Storage.prototype.setItem`. The patch itself is
	// baked into the cached document and we can't remove it from here — but
	// we CAN replace `window.__bobbitPrepaint` (which the patch calls) with
	// a no-op, so the patch becomes harmless until the user reloads onto
	// the fixed shell. On the fixed shell this whole block is a benign
	// no-op (skeleton is already `.--hide`, no pills exist, and the
	// fresh `__bobbitPrepaint` itself early-returns on data-rendered).
	try {
		(window as any).__bobbitPrepaint = () => {};
		document.querySelectorAll("[data-bobbit-pill]").forEach((el) => el.remove());
		const sk = document.querySelector("[data-bobbit-skeleton]") as HTMLElement | null;
		if (sk) sk.classList.add("--hide");
	} catch { /* non-fatal */ }

	// Persist the initial state immediately so a hard reload before any
	// further mutation still has a snapshot to hydrate from.
	try { scheduleSave(state); } catch { /* non-fatal */ }

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

	// Helper: build ordered session list and navigate up/down
	function navigateSession(direction: "up" | "down"): void {
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
				connectToSession(nextId, true);
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
