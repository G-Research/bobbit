import { render } from "lit";
import { renderSidebar, isProjectExpanded, toggleProjectExpanded } from "../../src/app/sidebar.js";
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

const PROJECT_ID = "sidebar-filter-search-project";
const READ_SESSION_ID = "sidebar-filter-read-session";
const ACTIVE_SESSION_ID = "sidebar-filter-active-session";
const BUSY_SESSION_ID = "sidebar-filter-busy-session";
const GOAL_ID = "sidebar-filter-goal";
const GOAL_READ_SESSION_ID = "sidebar-filter-goal-read-session";
const COLLAPSED_PARENT_GOAL_ID = "sidebar-filter-collapsed-parent-goal";
const NESTED_MATCH_GOAL_ID = "sidebar-filter-nested-match-goal";
const ARCHIVED_SESSION_ID = "sidebar-filter-archived-session";

const PROJECT: Project = {
	id: PROJECT_ID,
	name: "Sidebar Filter Fixture",
	rootPath: "/tmp/sidebar-filter-fixture",
	colorLight: "#2563eb",
	colorDark: "#60a5fa",
};

const GOAL: Goal = {
	id: GOAL_ID,
	title: "Goal Filter Matrix",
	cwd: PROJECT.rootPath,
	projectId: PROJECT_ID,
	state: "in-progress",
	spec: "Goal used by the sidebar filter/search fixture.",
	createdAt: 10,
	updatedAt: 10,
	setupStatus: "ready",
};

const COLLAPSED_PARENT_GOAL: Goal = {
	id: COLLAPSED_PARENT_GOAL_ID,
	title: "Collapsed Parent Goal",
	cwd: PROJECT.rootPath,
	projectId: PROJECT_ID,
	state: "in-progress",
	spec: "Parent stays collapsed outside search; search should expand it ephemerally when a descendant matches.",
	createdAt: 11,
	updatedAt: 11,
	setupStatus: "ready",
};

const NESTED_MATCH_GOAL: Goal = {
	id: NESTED_MATCH_GOAL_ID,
	title: "NestedSearchNeedle Child Goal",
	cwd: PROJECT.rootPath,
	projectId: PROJECT_ID,
	parentGoalId: COLLAPSED_PARENT_GOAL_ID,
	state: "in-progress",
	spec: "Matching child used to verify search reveals descendants hidden by collapsed parents.",
	createdAt: 12,
	updatedAt: 12,
	setupStatus: "ready",
};

const IDS = {
	project: `project:${PROJECT_ID}`,
	readSession: READ_SESSION_ID,
	activeSession: ACTIVE_SESSION_ID,
	busySession: BUSY_SESSION_ID,
	goal: `goal:${GOAL_ID}`,
	goalReadSession: GOAL_READ_SESSION_ID,
	collapsedParentGoal: `goal:${COLLAPSED_PARENT_GOAL_ID}`,
	nestedMatchGoal: `goal:${NESTED_MATCH_GOAL_ID}`,
	archivedSession: ARCHIVED_SESSION_ID,
};

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
	if (url === "/api/projects") return response({ projects: [{ ...PROJECT }] });
	if (url.startsWith("/api/sessions")) return response({ sessions: [], archivedDelegates: [], total: 0, hasMore: false, nextCursor: null });
	if (url.startsWith("/api/goals")) return response({ goals: [], total: 0, hasMore: false, nextCursor: null, archivedSessions: [] });
	if (url === "/api/staff" || url.startsWith("/api/staff?") || url === "/api/staff/orphaned") return response({ staff: [] });
	if (url === "/api/preferences") return response({});
	if (url === "/api/sandbox-status") return response({ available: false, configured: false });
	return response({ ok: true });
}) as typeof window.fetch;

function installFixtureStyle(): void {
	if (document.getElementById("sidebar-filter-search-fixture-style")) return;
	const style = document.createElement("style");
	style.id = "sidebar-filter-search-fixture-style";
	style.textContent = `
		html, body, #app { height: 100%; margin: 0; }
		body { font-family: ui-sans-serif, system-ui, sans-serif; }
		#app { width: 960px; min-height: 760px; }
		.hidden, [hidden] { display: none !important; }
		.sidebar-edge { min-height: 720px; border-right: 1px solid #d1d5db; }
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

function readFilterStorage(): void {
	state.showArchived = localStorage.getItem("bobbit-show-archived") === "true";
	state.showBusy = localStorage.getItem("bobbit-show-busy") !== "false";
	state.showRead = localStorage.getItem("bobbit-show-read") !== "false";
}

function fixtureArchivedSessions(): GatewaySession[] {
	return [
		{
			id: ARCHIVED_SESSION_ID,
			title: "ArchivedEchoFixture",
			cwd: PROJECT.rootPath,
			projectId: PROJECT_ID,
			status: "terminated",
			createdAt: 60,
			lastActivity: 1_000,
			lastReadAt: 2_000,
			clientCount: 0,
			archived: true,
			archivedAt: 4_000,
		},
	];
}

function fixtureSessions(): GatewaySession[] {
	return [
		{
			id: READ_SESSION_ID,
			title: "ReadStandaloneAlpha",
			cwd: PROJECT.rootPath,
			projectId: PROJECT_ID,
			status: "idle",
			createdAt: 20,
			lastActivity: 1_000,
			lastReadAt: 2_000,
			clientCount: 0,
		},
		{
			id: ACTIVE_SESSION_ID,
			title: "ActiveReadStandalone",
			cwd: PROJECT.rootPath,
			projectId: PROJECT_ID,
			status: "idle",
			createdAt: 30,
			lastActivity: 1_000,
			lastReadAt: 2_000,
			clientCount: 1,
		},
		{
			id: BUSY_SESSION_ID,
			title: "BusyStandaloneBravo",
			cwd: PROJECT.rootPath,
			projectId: PROJECT_ID,
			status: "streaming",
			createdAt: 40,
			lastActivity: 3_000,
			lastReadAt: 0,
			clientCount: 0,
		},
		{
			id: GOAL_READ_SESSION_ID,
			title: "GoalChildReadCharlie",
			cwd: PROJECT.rootPath,
			projectId: PROJECT_ID,
			goalId: GOAL_ID,
			status: "idle",
			createdAt: 50,
			lastActivity: 1_000,
			lastReadAt: 2_000,
			clientCount: 0,
		},
	];
}

async function resetFixture(opts: { preserveFilterStorage?: boolean } = {}): Promise<void> {
	installFixtureStyle();
	if (!opts.preserveFilterStorage) {
		localStorage.removeItem("bobbit-show-archived");
		localStorage.removeItem("bobbit-show-busy");
		localStorage.removeItem("bobbit-show-read");
	}
	localStorage.removeItem("bobbit-expanded-goals");
	localStorage.removeItem("bobbit-sidebar-tree-state:v1");
	document.documentElement.dataset.subgoalsEnabled = "true";
	document.documentElement.dataset.maxNestingDepth = "5";
	readFilterStorage();
	setProjects([{ ...PROJECT }]);
	if (!isProjectExpanded(PROJECT_ID)) toggleProjectExpanded(PROJECT_ID);
	expandedGoals.clear();
	expandedGoals.add(GOAL_ID);
	saveExpandedGoals();
	setArchivedSectionExpanded(PROJECT_ID, true);
	setUngroupedExpanded(PROJECT_ID, true);
	setStaffSectionExpanded(PROJECT_ID, true);
	Object.assign(state, {
		appView: "authenticated",
		connectionStatus: "connected",
		gatewaySessions: fixtureSessions(),
		archivedSessions: fixtureArchivedSessions(),
		goals: [{ ...GOAL }, { ...COLLAPSED_PARENT_GOAL }, { ...NESTED_MATCH_GOAL }],
		selectedSessionId: ACTIVE_SESSION_ID,
		connectingSessionId: ACTIVE_SESSION_ID,
		keyboardNavActiveId: null,
		activeProjectId: PROJECT_ID,
		sidebarCollapsed: false,
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
		archivedGoalsTotal: 0,
		archivedSessionsCursor: null,
		archivedSessionsHasMore: false,
		archivedSessionsTotal: 1,
	});
	window.history.replaceState({}, "", `#/session/${ACTIVE_SESSION_ID}`);
	renderFixture();
	await nextFrames();
}

async function setFixtureFilters(filters: { showRead?: boolean; showBusy?: boolean; showArchived?: boolean }): Promise<void> {
	if (typeof filters.showRead === "boolean") {
		state.showRead = filters.showRead;
		localStorage.setItem("bobbit-show-read", String(filters.showRead));
	}
	if (typeof filters.showBusy === "boolean") {
		state.showBusy = filters.showBusy;
		localStorage.setItem("bobbit-show-busy", String(filters.showBusy));
	}
	if (typeof filters.showArchived === "boolean") {
		state.showArchived = filters.showArchived;
		localStorage.setItem("bobbit-show-archived", String(filters.showArchived));
	}
	renderFixture();
	await nextFrames();
}

async function setFixtureSearch(query: string): Promise<void> {
	state.searchQuery = query;
	renderFixture();
	await nextFrames();
}

setRenderApp(renderFixture);
(window as any).bobbitState = state;
(window as any).__bobbitState = state;
(window as any).__bobbitRenderSidebarFilterSearchFixture = renderFixture;
(window as any).__resetSidebarFilterSearchFixture = resetFixture;
(window as any).__setSidebarFilterSearchFixtureFilters = setFixtureFilters;
(window as any).__setSidebarFilterSearchFixtureSearch = setFixtureSearch;
(window as any).__sidebarFilterSearchFixtureIds = IDS;
(window as any).__sidebarFilterSearchReady = true;
