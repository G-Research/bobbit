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
import { showGoalDialog } from "./dialogs.js";
import { loadDashboardData, clearDashboardState } from "./goal-dashboard.js";

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

	state.chatPanel = new ChatPanel();

	// Check for token in URL (passed by gateway auto-open)
	const params = new URLSearchParams(window.location.search);
	const urlToken = params.get("token");
	if (urlToken) {
		localStorage.setItem(GW_URL_KEY, window.location.origin);
		localStorage.setItem(GW_TOKEN_KEY, urlToken);
		window.history.replaceState({}, "", window.location.pathname + window.location.hash);
	}

	const savedUrl = localStorage.getItem(GW_URL_KEY);
	const savedToken = localStorage.getItem(GW_TOKEN_KEY);

	renderApp();

	if (savedUrl && savedToken) {
		try {
			await authenticateGateway(savedUrl, savedToken);

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

	// Global keyboard shortcuts
	window.addEventListener("keydown", (e: KeyboardEvent) => {
		const mod = e.ctrlKey || e.metaKey;

		// Ctrl+T / Cmd+T / Alt+N — New session
		if ((mod && e.key === "t") || (e.altKey && (e.key === "n" || e.key === "N"))) {
			if (state.appView === "authenticated") {
				e.preventDefault();
				createAndConnectSession();
			}
		}

		// Ctrl+/ / Cmd+/ — Focus message input
		if (mod && e.key === "/") {
			e.preventDefault();
			const textarea = document.querySelector("message-editor")?.querySelector("textarea");
			if (textarea) {
				(textarea as HTMLElement).focus();
			}
		}

		// Alt+G — New goal
		if (e.altKey && (e.key === "g" || e.key === "G") && !mod) {
			if (state.appView === "authenticated") {
				e.preventDefault();
				showGoalDialog();
			}
		}

		// Ctrl+Shift+D / Cmd+Shift+D — Terminate current session
		if (mod && e.shiftKey && (e.key === "D" || e.key === "d")) {
			const sid = activeSessionId();
			if (sid) {
				e.preventDefault();
				terminateSession(sid);
			}
		}

		// Ctrl+[ / Cmd+[ — Toggle sidebar
		if (mod && e.key === "[") {
			e.preventDefault();
			state.sidebarCollapsed = !state.sidebarCollapsed;
			localStorage.setItem("bobbit-sidebar-collapsed", String(state.sidebarCollapsed));
			renderApp();
		}

		// Ctrl+Up / Cmd+Up — Previous session
		// Ctrl+Down / Cmd+Down — Next session
		if (mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
			// Build navigable list: Goals -> Sessions -> Staff
			// Within each section, oldest session first (by createdAt)
			const allSessions = state.gatewaySessions;
			const nonDelegate = allSessions.filter((s) => !s.delegateOf);
			const staffSessionIds = new Set(state.staffList.map((s) => s.currentSessionId).filter(Boolean));
			const byAge = (a: { createdAt: number }, b: { createdAt: number }) => a.createdAt - b.createdAt;
			const stateOrder: Record<string, number> = { "in-progress": 0, "todo": 1, "complete": 2, "shelved": 3 };
			const sortedGoals = [...state.goals].sort((a, b) => (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9));

			const ordered: string[] = [];
			// 1. Goal sessions (goals sorted by state, sessions by age within each)
			for (const goal of sortedGoals) {
				const goalSessions = nonDelegate
					.filter((s) => s.goalId === goal.id || s.teamGoalId === goal.id)
					.sort(byAge);
				for (const s of goalSessions) ordered.push(s.id);
			}
			// 2. Ungrouped sessions (by age)
			const ungrouped = nonDelegate
				.filter((s) => !s.goalId && !s.teamGoalId && !staffSessionIds.has(s.id))
				.sort(byAge);
			for (const s of ungrouped) ordered.push(s.id);
			// 3. Staff sessions (by age)
			const staffSessions = nonDelegate
				.filter((s) => staffSessionIds.has(s.id))
				.sort(byAge);
			for (const s of staffSessions) ordered.push(s.id);

			if (ordered.length > 1) {
				const currentId = activeSessionId();
				const currentIndex = currentId ? ordered.indexOf(currentId) : -1;
				let nextIndex: number;
				if (e.key === "ArrowUp") {
					nextIndex = currentIndex <= 0 ? ordered.length - 1 : currentIndex - 1;
				} else {
					nextIndex = currentIndex >= ordered.length - 1 ? 0 : currentIndex + 1;
				}
				const nextId = ordered[nextIndex];
				if (nextId && nextId !== currentId) {
					e.preventDefault();
					connectToSession(nextId, true);
				}
			}
		}

		// Ctrl+] / Cmd+] — Toggle preview panel
		if (mod && e.key === "]") {
			const hasPanel = !state.assistantType && (state.isPreviewSession || state.activeGoalProposal != null);
			if (hasPanel) {
				e.preventDefault();
				const key = `bobbit-preview-collapsed-${activeSessionId()}`;
				const collapsed = localStorage.getItem(key) === "true";
				localStorage.setItem(key, String(!collapsed));
				renderApp();
			}
		}
	});
}

initApp();

// Register service worker for PWA installability
if ('serviceWorker' in navigator) {
	navigator.serviceWorker.register('/sw.js').catch(() => {});
}
