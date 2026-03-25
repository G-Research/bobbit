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
import { gatewayFetch, refreshSessions } from "./api.js";
import { getRouteFromHash, setHashRoute } from "./routing.js";
import { authenticateGateway, connectToSession, createAndConnectSession, terminateSession } from "./session-manager.js";
import { doRenderApp } from "./render.js";
import { loadDashboardData, clearDashboardState } from "./goal-dashboard.js";
import { registerShortcut, startListening, loadSavedBindings } from "./shortcut-registry.js";

// ============================================================================
// WIRE UP RENDER
// ============================================================================

setRenderApp(doRenderApp);

// ============================================================================
// HASH CHANGE HANDLER (browser back/forward)
// ============================================================================

let handlingHashChange = false;

async function handleHashChange(): Promise<void> {
	if (handlingHashChange) return;
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

		if (route.view === "goal" && route.goalId) {
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.appView = "authenticated";
			await refreshSessions();
			await loadDashboardData(route.goalId);
		} else if (route.view === "session" && route.sessionId) {
			clearDashboardState();
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
			state.goalDashboardId = route.goalId;
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
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadToolPageData, navigateToToolEdit } = await import("./tool-manager-page.js");
			await loadToolPageData();
			navigateToToolEdit(route.toolName);
			await refreshSessions();
		} else if (route.view === "workflows") {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
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
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadWorkflowPageData, navigateToWorkflowEdit } = await import("./workflow-page.js");
			await loadWorkflowPageData();
			navigateToWorkflowEdit(route.workflowId);
			await refreshSessions();
		} else if (route.view === "staff") {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
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
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadStaffPageData, navigateToStaffEdit } = await import("./staff-page.js");
			await loadStaffPageData();
			navigateToStaffEdit(route.staffId);
			await refreshSessions();
		} else if (route.view === "personalities") {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadPersonalityPageData } = await import("./personality-manager-page.js");
			loadPersonalityPageData();
			renderApp();
			await refreshSessions();
		} else if (route.view === "personality-edit" && route.personalityName) {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.goalDashboardId = null;
			state.appView = "authenticated";
			const { loadPersonalityPageData, navigateToPersonalityEdit } = await import("./personality-manager-page.js");
			await loadPersonalityPageData();
			navigateToPersonalityEdit(route.personalityName);
			await refreshSessions();
		} else {
			clearDashboardState();
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.goalDashboardId = null;
			state.appView = "authenticated";
			renderApp();
			await refreshSessions();
		}
	} finally {
		handlingHashChange = false;
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

	renderApp();

	if (savedUrl && savedToken) {
		try {
			await authenticateGateway(savedUrl, savedToken);

			// Load saved preferences (palette + AI gateway)
			try {
				const prefRes = await gatewayFetch("/api/preferences");
				if (prefRes.ok) {
					const prefs = await prefRes.json();
					if (prefs.palette && prefs.palette !== "forest") {
						document.documentElement.dataset.palette = prefs.palette;
					}
					// Load AI Gateway config into ModelSelector
					import("./aigw-config.js").then(({ applyAigwConfig }) => applyAigwConfig(prefs));
				}
			} catch {}

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
				const { loadWorkflowPageData } = await import("./workflow-page.js");
				loadWorkflowPageData();
			} else if (route.view === "workflow-edit" && route.workflowId) {
				const { loadWorkflowPageData, navigateToWorkflowEdit } = await import("./workflow-page.js");
				await loadWorkflowPageData();
				navigateToWorkflowEdit(route.workflowId);
			} else if (route.view === "staff") {
				const { loadStaffPageData } = await import("./staff-page.js");
				loadStaffPageData();
			} else if (route.view === "staff-edit" && route.staffId) {
				const { loadStaffPageData, navigateToStaffEdit } = await import("./staff-page.js");
				await loadStaffPageData();
				navigateToStaffEdit(route.staffId);
			} else if (route.view === "personalities") {
				const { loadPersonalityPageData } = await import("./personality-manager-page.js");
				loadPersonalityPageData();
			} else if (route.view === "personality-edit" && route.personalityName) {
				const { loadPersonalityPageData, navigateToPersonalityEdit } = await import("./personality-manager-page.js");
				await loadPersonalityPageData();
				navigateToPersonalityEdit(route.personalityName);
			}
		} catch {
			renderApp();
		}
	}

	// Listen for browser back/forward navigation
	window.addEventListener("hashchange", handleHashChange);

	// ========================================================================
	// KEYBOARD SHORTCUT REGISTRY
	// ========================================================================

	// Helper: build ordered session list and navigate up/down
	function navigateSession(direction: "up" | "down"): void {
		const allSessions = state.gatewaySessions;
		const nonDelegate = allSessions.filter((s) => !s.delegateOf);
		const staffSessionIds = new Set(state.staffList.map((s) => s.currentSessionId).filter(Boolean));
		const byAge = (a: { createdAt: number }, b: { createdAt: number }) => a.createdAt - b.createdAt;
		const stateOrder: Record<string, number> = { "in-progress": 0, "todo": 1, "complete": 2, "shelved": 3 };
		const sortedGoals = [...state.goals].sort((a, b) => (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9));

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
			const currentId = activeSessionId();
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
		id: "toggle-preview", label: "Toggle preview panel", category: "UI",
		defaultBindings: [{ key: "]", ctrlOrMeta: true, shift: false, alt: false }],
		allowInInput: true,
		handler: () => {
			const hasPanel = !state.assistantType && (state.isPreviewSession || state.activeGoalProposal != null);
			if (hasPanel) {
				const key = `bobbit-preview-collapsed-${activeSessionId()}`;
				const collapsed = localStorage.getItem(key) === "true";
				localStorage.setItem(key, String(!collapsed));
				renderApp();
			}
		},
	});

	// NEW shortcuts
	registerShortcut({
		id: "new-goal", label: "New goal", category: "Goals",
		defaultBindings: [{ key: "g", ctrlOrMeta: false, shift: false, alt: true }],
		handler: () => {
			import("./dialogs.js").then(({ showGoalDialog }) => showGoalDialog());
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

	// Sync preferences when the page becomes visible (covers cross-device
	// changes when the user switches back to this tab/app).
	document.addEventListener("visibilitychange", async () => {
		if (document.visibilityState !== "visible") return;
		if (state.appView !== "authenticated") return;
		try {
			const res = await gatewayFetch("/api/preferences");
			if (!res.ok) return;
			const prefs = await res.json();
			// Apply palette
			const palette = (prefs.palette as string) || "forest";
			if (palette === "forest") {
				delete document.documentElement.dataset.palette;
			} else {
				document.documentElement.dataset.palette = palette;
			}
			// Reload shortcuts if changed
			if (prefs.shortcuts) {
				await loadSavedBindings();
			}
			// Sync AI Gateway config
			import("./aigw-config.js").then(({ applyAigwConfig }) => applyAigwConfig(prefs));
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
	});
}
