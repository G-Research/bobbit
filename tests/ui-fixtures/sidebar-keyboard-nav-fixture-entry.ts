import { render } from "lit";
import { renderSidebar, isProjectExpanded, toggleProjectExpanded } from "../../src/app/sidebar.js";
import { navigateSidebar, installKeyboardNavOverrideClearListener } from "../../src/app/sidebar-nav.js";
import {
	expandedGoals,
	saveExpandedGoals,
	setArchivedSectionExpanded,
	setProjects,
	setRenderApp,
	setStaffSectionExpanded,
	setUngroupedExpanded,
	state,
	type GatewaySession,
	type Goal,
	type Project,
} from "../../src/app/state.js";

const PROJECT_ID = "sidebar-nav-fixture-project";
const LIVE_GOAL_ID = "sidebar-nav-fixture-live-goal";
const ARCHIVED_GOAL_ID = "sidebar-nav-fixture-archived-goal";

const PROJECT: Project = {
	id: PROJECT_ID,
	name: "Sidebar Keyboard Fixture",
	rootPath: "/tmp/sidebar-keyboard-fixture",
	colorLight: "#2563eb",
	colorDark: "#60a5fa",
};

const LIVE_GOAL: Goal = {
	id: LIVE_GOAL_ID,
	title: "Keyboard Fixture Live Goal",
	cwd: PROJECT.rootPath,
	projectId: PROJECT_ID,
	state: "in-progress",
	spec: "Live goal used to keep the non-archived sidebar cycle populated.",
	createdAt: 1,
	updatedAt: 1,
	setupStatus: "ready",
};

const ARCHIVED_GOAL: Goal = {
	id: ARCHIVED_GOAL_ID,
	title: "Keyboard Fixture Archived Goal",
	cwd: PROJECT.rootPath,
	projectId: PROJECT_ID,
	state: "complete",
	spec: "Archived goal used to verify Show Archived participates in keyboard navigation.",
	createdAt: 2,
	updatedAt: 2,
	setupStatus: "ready",
	archived: true,
	archivedAt: 3,
};

const IDS = {
	project: `project:${PROJECT_ID}`,
	liveGoal: `goal:${LIVE_GOAL_ID}`,
	archivedHeader: `archived-header:${PROJECT_ID}`,
	archivedGoal: `goal:${ARCHIVED_GOAL_ID}`,
};

let keyboardInstalled = false;

class FixtureWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = FixtureWebSocket.OPEN;
	addEventListener(): void {}
	removeEventListener(): void {}
	send(): void {}
	close(): void { this.readyState = FixtureWebSocket.CLOSED; }
}

(window as any).WebSocket = FixtureWebSocket;
window.confirm = () => true;
window.open = (() => null) as typeof window.open;

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestPath(input: RequestInfo | URL): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try {
		const url = new URL(raw, window.location.href);
		return `${url.pathname}${url.search}`;
	} catch {
		return raw;
	}
}

window.fetch = (async (input: RequestInfo | URL) => {
	const url = requestPath(input);
	if (url.startsWith("/api/goals?") && url.includes("archived=true")) {
		return response({ goals: [{ ...ARCHIVED_GOAL }], total: 1, hasMore: false, nextCursor: null, archivedSessions: [] });
	}
	if (url.startsWith("/api/sessions?")) return response({ sessions: [], archivedDelegates: [], total: 0, hasMore: false, nextCursor: null });
	if (url === "/api/staff" || url.startsWith("/api/staff?") || url === "/api/staff/orphaned") return response({ staff: [] });
	if (url === "/api/projects") return response({ projects: [{ ...PROJECT }] });
	if (url === "/api/preferences") return response({});
	if (url === "/api/sandbox-status") return response({ available: false, configured: false });
	return response({ ok: true });
}) as typeof window.fetch;

function installFixtureStyle(): void {
	if (document.getElementById("sidebar-keyboard-nav-fixture-style")) return;
	const style = document.createElement("style");
	style.id = "sidebar-keyboard-nav-fixture-style";
	style.textContent = `
		html, body, #app { height: 100%; margin: 0; }
		body { font-family: ui-sans-serif, system-ui, sans-serif; }
		#app { width: 920px; min-height: 720px; }
		.hidden, [hidden] { display: none !important; }
		.sidebar-edge { min-height: 680px; border-right: 1px solid #d1d5db; }
		button, input { font: inherit; }
	`;
	document.head.appendChild(style);
}

function nextFrames(frames = 2): Promise<void> {
	return new Promise((resolve) => {
		const step = (remaining: number) => {
			if (remaining <= 0) resolve();
			else requestAnimationFrame(() => step(remaining - 1));
		};
		step(frames);
	});
}

function renderFixture(): void {
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	render(renderSidebar(), app);
}

function installKeyboardDriver(): void {
	if (keyboardInstalled) return;
	keyboardInstalled = true;
	installKeyboardNavOverrideClearListener();
	window.addEventListener("keydown", (event) => {
		if (!(event.ctrlKey || event.metaKey)) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			navigateSidebar("down");
		}
	});
}

async function resetFixture(): Promise<void> {
	installFixtureStyle();
	installKeyboardDriver();
	localStorage.setItem("bobbit-show-archived", "false");
	localStorage.setItem("bobbit-show-busy", "true");
	localStorage.setItem("bobbit-show-read", "true");
	setProjects([{ ...PROJECT }]);
	expandedGoals.clear();
	saveExpandedGoals();
	setArchivedSectionExpanded(PROJECT_ID, true);
	setUngroupedExpanded(PROJECT_ID, true);
	setStaffSectionExpanded(PROJECT_ID, true);
	if (!isProjectExpanded(PROJECT_ID)) toggleProjectExpanded(PROJECT_ID);
	Object.assign(state, {
		appView: "authenticated",
		connectionStatus: "connected",
		gatewaySessions: [] as GatewaySession[],
		archivedSessions: [] as GatewaySession[],
		goals: [{ ...LIVE_GOAL }, { ...ARCHIVED_GOAL }],
		selectedSessionId: null,
		connectingSessionId: null,
		keyboardNavActiveId: null,
		activeProjectId: PROJECT_ID,
		sidebarCollapsed: false,
		showArchived: false,
		showBusy: true,
		showRead: true,
		filtersPopoverOpen: false,
		searchQuery: "",
		sessionsLoading: false,
		sessionsError: "",
		creatingSession: false,
		creatingSessionForGoalId: null,
		staffList: [],
		orphanedStaff: [],
		archivedGoalsCursor: null,
		archivedGoalsHasMore: false,
		archivedGoalsTotal: 1,
		archivedSessionsCursor: null,
		archivedSessionsHasMore: false,
		archivedSessionsTotal: 0,
	});
	window.history.replaceState({}, "", "#/");
	renderFixture();
	await nextFrames();
}

setRenderApp(renderFixture);
(window as any).bobbitState = state;
(window as any).__bobbitState = state;
(window as any).__bobbitRenderSidebarFixture = renderFixture;
(window as any).__resetSidebarKeyboardNavFixture = resetFixture;
(window as any).__sidebarKeyboardNavFixtureIds = IDS;
(window as any).__sidebarKeyboardNavReady = true;
