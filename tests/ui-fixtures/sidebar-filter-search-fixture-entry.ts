import { render } from "lit";
import { clearArchivedSessionsState } from "../../src/app/api.js";
import { commitGatewayConnection } from "../../src/app/gateway-fetch.js";
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
const COLLAPSED_PARENT_SESSION_ID = "sidebar-filter-collapsed-parent-session";
const CHILD_SESSION_PARENT_ID = "sidebar-filter-child-session-parent";
const FIRST_CLASS_CHILD_SESSION_ID = "sidebar-filter-first-class-child-session";
const DELEGATE_CHILD_SESSION_ID = "sidebar-filter-delegate-child-session";
const ARCHIVED_DELEGATE_CHILD_SESSION_ID = "sidebar-filter-archived-delegate-child-session";
const NESTED_MATCH_GOAL_ID = "sidebar-filter-nested-match-goal";
const ARCHIVED_SESSION_ID = "sidebar-filter-archived-session";
const ARCHIVED_SESSION_PAGE_TWO_ID = "sidebar-filter-archived-session-page-two";
const ARCHIVED_SESSION_PAGE_THREE_ID = "sidebar-filter-archived-session-page-three";
const ARCHIVED_GOAL_PAGE_ONE_ID = "sidebar-filter-archived-goal-page-one";
const ARCHIVED_GOAL_PAGE_TWO_ID = "sidebar-filter-archived-goal-page-two";
const ARCHIVED_GOAL_PAGE_THREE_ID = "sidebar-filter-archived-goal-page-three";
const REMOTE_ARCHIVED_SESSION_ID = "sidebar-filter-remote-archived-session";
const FIXTURE_GATEWAY_BASE_URL = "https://fixture.test/team/bobbit";
const FIXTURE_GATEWAY_TOKEN = "fixture-token";

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
	collapsedParentSession: COLLAPSED_PARENT_SESSION_ID,
	childSessionParent: CHILD_SESSION_PARENT_ID,
	firstClassChildSession: FIRST_CLASS_CHILD_SESSION_ID,
	delegateChildSession: DELEGATE_CHILD_SESSION_ID,
	archivedDelegateChildSession: ARCHIVED_DELEGATE_CHILD_SESSION_ID,
	nestedMatchGoal: `goal:${NESTED_MATCH_GOAL_ID}`,
	archivedSession: ARCHIVED_SESSION_ID,
	archivedSessionPageTwo: ARCHIVED_SESSION_PAGE_TWO_ID,
	archivedSessionPageThree: ARCHIVED_SESSION_PAGE_THREE_ID,
	archivedGoalPageTwo: ARCHIVED_GOAL_PAGE_TWO_ID,
	archivedGoalPageThree: ARCHIVED_GOAL_PAGE_THREE_ID,
	remoteArchivedSession: REMOTE_ARCHIVED_SESSION_ID,
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

function requestUrl(input: RequestInfo | URL): URL {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	return new URL(raw, window.location.href);
}

function mountedRoute(url: URL): string {
	const gateway = new URL(FIXTURE_GATEWAY_BASE_URL);
	const mount = gateway.pathname.replace(/\/$/, "");
	if (url.origin !== gateway.origin || (url.pathname !== mount && !url.pathname.startsWith(`${mount}/`))) {
		throw new Error(`Fixture request escaped mounted gateway: ${url.href}`);
	}
	return `${url.pathname.slice(mount.length) || "/"}${url.search}`;
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const request = input instanceof Request ? input : null;
	const url = requestUrl(input);
	const headers = new Headers(init?.headers ?? request?.headers);
	(window as any).__sidebarFilterSearchRequests.push({
		url: url.href,
		method: init?.method ?? request?.method ?? "GET",
		credentials: init?.credentials ?? request?.credentials ?? null,
		authorization: headers.get("Authorization"),
	});
	const route = mountedRoute(url);
	if (route === "/api/projects") return response({ projects: [{ ...PROJECT }] });
	if (route.startsWith("/api/sessions") && route.includes("q=RemoteBeyondFirstPageNeedle")) {
		return response({
			sessions: [{
				id: REMOTE_ARCHIVED_SESSION_ID,
				title: "RemoteBeyondFirstPageNeedle",
				cwd: PROJECT.rootPath,
				projectId: PROJECT_ID,
				status: "archived",
				createdAt: 1,
				lastActivity: 1,
				lastReadAt: 2,
				clientCount: 0,
				archived: true,
			}],
			archivedDelegates: [], total: 1, hasMore: false, nextCursor: null,
		});
	}
	if (route.startsWith("/api/sessions") && url.searchParams.get("include") === "archived") {
		const after = url.searchParams.get("after");
		if (after === "200") {
			return response({ sessions: [fixtureArchivedPageSession(ARCHIVED_SESSION_PAGE_TWO_ID, "Archived Session Page Two", 3_000)], archivedDelegates: [], total: 4, hasMore: true, nextCursor: 100 });
		}
		if (after === "100") {
			return response({ sessions: [fixtureArchivedPageSession(ARCHIVED_SESSION_PAGE_THREE_ID, "Archived Session Page Three", 2_000)], archivedDelegates: [], total: 4, hasMore: false, nextCursor: null });
		}
		return response({ sessions: fixtureArchivedSessions(), archivedDelegates: [], total: 4, hasMore: true, nextCursor: 200 });
	}
	if (route.startsWith("/api/sessions")) return response({ sessions: [], archivedDelegates: [], total: 0, hasMore: false, nextCursor: null });
	if (route.startsWith("/api/goals") && url.searchParams.get("archived") === "true" && !url.searchParams.has("q")) {
		const after = url.searchParams.get("after");
		if (after === "200") {
			return response({ goals: [fixtureArchivedGoal(ARCHIVED_GOAL_PAGE_TWO_ID, "Archived Goal Page Two", 3_000)], total: 3, hasMore: true, nextCursor: 100, archivedSessions: [] });
		}
		if (after === "100") {
			return response({ goals: [fixtureArchivedGoal(ARCHIVED_GOAL_PAGE_THREE_ID, "Archived Goal Page Three", 2_000)], total: 3, hasMore: false, nextCursor: null, archivedSessions: [] });
		}
		return response({ goals: [fixtureArchivedGoal(ARCHIVED_GOAL_PAGE_ONE_ID, "Archived Goal Page One", 4_000)], total: 3, hasMore: true, nextCursor: 200, archivedSessions: [] });
	}
	if (route.startsWith("/api/goals")) return response({ goals: [], total: 0, hasMore: false, nextCursor: null, archivedSessions: [] });
	if (route === "/api/staff" || route.startsWith("/api/staff?") || route === "/api/staff/orphaned") return response({ staff: [] });
	if (route === "/api/preferences") return response({});
	if (route.startsWith("/api/sandbox-status")) return response({ available: false, configured: false });
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

function fixtureArchivedGoal(id: string, title: string, archivedAt: number): Goal {
	return {
		id,
		title,
		cwd: PROJECT.rootPath,
		projectId: PROJECT_ID,
		state: "complete",
		spec: `${title} pagination fixture.`,
		createdAt: archivedAt - 100,
		updatedAt: archivedAt,
		setupStatus: "ready",
		archived: true,
		archivedAt,
	};
}

function fixtureArchivedPageSession(id: string, title: string, archivedAt: number): GatewaySession {
	return {
		id,
		title,
		cwd: PROJECT.rootPath,
		projectId: PROJECT_ID,
		status: "terminated",
		createdAt: archivedAt - 100,
		lastActivity: archivedAt - 50,
		lastReadAt: archivedAt,
		clientCount: 0,
		archived: true,
		archivedAt,
	};
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
		{
			id: ARCHIVED_DELEGATE_CHILD_SESSION_ID,
			title: "ArchivedDelegateChildNeedle",
			role: "archived-delegate-child-role",
			cwd: PROJECT.rootPath,
			projectId: PROJECT_ID,
			goalId: COLLAPSED_PARENT_GOAL_ID,
			teamGoalId: COLLAPSED_PARENT_GOAL_ID,
			delegateOf: CHILD_SESSION_PARENT_ID,
			status: "terminated",
			createdAt: 83,
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
		{
			id: COLLAPSED_PARENT_SESSION_ID,
			title: "CollapsedRuntimeNeedle",
			role: "runtime-child-role-needle",
			cwd: PROJECT.rootPath,
			projectId: PROJECT_ID,
			goalId: COLLAPSED_PARENT_GOAL_ID,
			status: "idle",
			createdAt: 55,
			lastActivity: 1_000,
			lastReadAt: 2_000,
			clientCount: 0,
		},
		{
			id: CHILD_SESSION_PARENT_ID,
			title: "OpaqueChildContainer",
			role: "container-role",
			cwd: PROJECT.rootPath,
			projectId: PROJECT_ID,
			goalId: COLLAPSED_PARENT_GOAL_ID,
			status: "idle",
			createdAt: 80,
			lastActivity: 1_000,
			lastReadAt: 2_000,
			clientCount: 0,
		},
		{
			id: FIRST_CLASS_CHILD_SESSION_ID,
			title: "FirstClassChildNeedle",
			role: "first-class-child-role",
			cwd: PROJECT.rootPath,
			projectId: PROJECT_ID,
			goalId: COLLAPSED_PARENT_GOAL_ID,
			parentSessionId: CHILD_SESSION_PARENT_ID,
			status: "idle",
			createdAt: 81,
			lastActivity: 1_000,
			lastReadAt: 2_000,
			clientCount: 0,
		},
		{
			id: DELEGATE_CHILD_SESSION_ID,
			title: "DelegateChildNeedle",
			role: "delegate-child-role",
			cwd: PROJECT.rootPath,
			projectId: PROJECT_ID,
			goalId: COLLAPSED_PARENT_GOAL_ID,
			delegateOf: CHILD_SESSION_PARENT_ID,
			status: "idle",
			createdAt: 82,
			lastActivity: 1_000,
			lastReadAt: 2_000,
			clientCount: 0,
		},
	];
}

async function resetFixture(opts: { preserveFilterStorage?: boolean } = {}): Promise<void> {
	// Publish a valid mounted connection before renderSidebar persists missing session colours.
	commitGatewayConnection(FIXTURE_GATEWAY_BASE_URL, FIXTURE_GATEWAY_TOKEN);
	clearArchivedSessionsState();
	(window as any).__sidebarFilterSearchRequests = [];
	installFixtureStyle();
	if (!opts.preserveFilterStorage) {
		localStorage.removeItem("bobbit-show-archived");
		localStorage.removeItem("bobbit-show-busy");
		localStorage.removeItem("bobbit-show-read");
		localStorage.removeItem("bobbit-sidebar-session-view");
		localStorage.removeItem("bobbit-status-show-archived");
		localStorage.removeItem("bobbit-status-show-busy");
		localStorage.removeItem("bobbit-status-show-read");
		localStorage.removeItem("bobbit-status-show-teams");
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
		sidebarSessionView: "project",
		statusShowArchived: false,
		statusShowBusy: true,
		statusShowRead: true,
		statusShowTeams: false,
		filtersPopoverOpen: false,
		searchQuery: "",
		archivedSearchDemand: false,
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
