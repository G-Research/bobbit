import { render } from "lit";
import { renderSidebar, isProjectExpanded, toggleProjectExpanded, toggleSidebar } from "../../src/app/sidebar.js";
import {
	expandedGoals,
	isTeamLeadExpanded,
	saveExpandedGoals,
	setArchivedSectionExpanded,
	setFirstClassParentExpanded,
	setProjects,
	setRenderApp,
	setStaffSectionExpanded,
	setUngroupedExpanded,
	state,
	toggleTeamLeadExpanded,
	type GatewaySession,
	type Goal,
	type Project,
} from "../../src/app/state.js";

const PROJECT_ALPHA: Project = {
	id: "sidebar-nav-alpha",
	name: "Alpha Project",
	rootPath: "/tmp/sidebar-nav-alpha",
	colorLight: "#2563eb",
	colorDark: "#60a5fa",
};

const PROJECT_BETA: Project = {
	id: "sidebar-nav-beta",
	name: "Beta Project",
	rootPath: "/tmp/sidebar-nav-beta",
	colorLight: "#16a34a",
	colorDark: "#4ade80",
};

const NOW = 1_700_000_000_000;

const IDS = {
	projectAlpha: PROJECT_ALPHA.id,
	projectBeta: PROJECT_BETA.id,
	sessionA: "sidebar-session-a",
	sessionB: "sidebar-session-b",
	sessionC: "sidebar-session-c",
	staff: "sidebar-staff-1",
	staffSession: "sidebar-staff-session",
	orphanStaff: "sidebar-orphan-staff",
	teamGoal: "sidebar-team-goal",
	teamLead: "sidebar-team-lead",
	teamCoder: "sidebar-team-coder",
	spawnedOne: "sidebar-spawned-1",
	spawnedTwo: "sidebar-spawned-2",
	spawnedArchived: "sidebar-spawned-archived",
	forestParent: "sidebar-forest-parent",
	forestChild: "sidebar-forest-child",
	forestArchivedChild: "sidebar-forest-archived-child",
	soloGoal: "sidebar-solo-goal",
	soloGoalSession: "sidebar-solo-session",
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

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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

let staffCreateResolver: ((value: Response) => void) | null = null;

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = requestPath(input);
	const method = (init?.method || "GET").toUpperCase();
	if (url === "/api/staff" || url.startsWith("/api/staff?")) return json({ staff: staffRecords() });
	if (url === "/api/staff/orphaned") return json({ staff: [orphanStaffRecord()] });
	if (url === "/api/projects") return json({ projects: [{ ...PROJECT_ALPHA }, { ...PROJECT_BETA }] });
	if (url.startsWith("/api/sessions?") || url === "/api/sessions") {
		if (method === "POST") {
			return await new Promise<Response>((resolve) => { staffCreateResolver = resolve; });
		}
		return json({ sessions: liveSessions(), archivedDelegates: archivedSessions(), total: liveSessions().length, hasMore: false, nextCursor: null });
	}
	if (url.startsWith("/api/goals?") && url.includes("archived=true")) {
		return json({ goals: archivedGoals(), total: archivedGoals().length, hasMore: false, nextCursor: null, archivedSessions: archivedSessions() });
	}
	if (url.includes("/team/agents?include=archived")) {
		return json({ agents: archivedSessions().map((s) => ({ sessionId: s.id, title: s.title, role: s.role, teamLeadSessionId: s.teamLeadSessionId, createdAt: s.createdAt, archivedAt: s.archivedAt })) });
	}
	if (url === "/api/preferences") return json({ subgoalsEnabled: true });
	if (url.startsWith("/api/sandbox-status")) return json({ available: false, configured: false });
	return json({ ok: true });
}) as typeof window.fetch;

function session(overrides: Partial<GatewaySession> & Pick<GatewaySession, "id" | "title" | "projectId">): GatewaySession {
	return {
		cwd: overrides.projectId === PROJECT_BETA.id ? PROJECT_BETA.rootPath : PROJECT_ALPHA.rootPath,
		status: "idle",
		createdAt: NOW,
		lastActivity: NOW,
		clientCount: 0,
		...overrides,
	} as GatewaySession;
}

function goal(overrides: Partial<Goal> & Pick<Goal, "id" | "title" | "projectId">): Goal {
	return {
		cwd: overrides.projectId === PROJECT_BETA.id ? PROJECT_BETA.rootPath : PROJECT_ALPHA.rootPath,
		state: "in-progress",
		spec: "Sidebar navigation fixture goal",
		createdAt: NOW,
		updatedAt: NOW,
		setupStatus: "ready",
		...overrides,
	} as Goal;
}

function liveSessions(): GatewaySession[] {
	return [
		session({ id: IDS.sessionA, title: "Alpha Chat", projectId: PROJECT_ALPHA.id, createdAt: NOW + 1, lastActivity: NOW + 100 }),
		session({ id: IDS.sessionB, title: "Bravo Chat", projectId: PROJECT_ALPHA.id, createdAt: NOW + 2, lastActivity: NOW + 90 }),
		session({ id: IDS.sessionC, title: "Charlie Chat", projectId: PROJECT_BETA.id, createdAt: NOW + 3, lastActivity: NOW + 80 }),
		session({ id: IDS.soloGoalSession, title: "Solo Goal Session", projectId: PROJECT_ALPHA.id, goalId: IDS.soloGoal, createdAt: NOW + 4, lastActivity: NOW + 70 }),
		session({ id: IDS.teamLead, title: "Team Lead", projectId: PROJECT_ALPHA.id, teamGoalId: IDS.teamGoal, role: "team-lead", createdAt: NOW + 5, lastActivity: NOW + 60 }),
		session({ id: IDS.teamCoder, title: "Coder", projectId: PROJECT_ALPHA.id, teamGoalId: IDS.teamGoal, role: "coder", teamLeadSessionId: IDS.teamLead, createdAt: NOW + 6, lastActivity: NOW + 50 }),
		session({ id: IDS.staffSession, title: "Staff Session", projectId: PROJECT_ALPHA.id, staffId: IDS.staff, createdAt: NOW + 7, lastActivity: NOW + 40 }),
	];
}

function archivedSessions(): GatewaySession[] {
	return [
		session({ id: "sidebar-archived-reviewer", title: "Archived Reviewer", projectId: PROJECT_ALPHA.id, teamGoalId: IDS.teamGoal, role: "reviewer", teamLeadSessionId: IDS.teamLead, status: "archived", archived: true, archivedAt: NOW + 30, createdAt: NOW + 8 }),
	];
}

function liveGoals(): Goal[] {
	return [
		goal({ id: IDS.soloGoal, title: "Solo Navigation Goal", projectId: PROJECT_ALPHA.id, createdAt: NOW + 1 }),
		goal({ id: IDS.teamGoal, title: "Team Hierarchy Goal", projectId: PROJECT_ALPHA.id, team: true, teamLeadSessionId: IDS.teamLead, createdAt: NOW + 2 }),
		goal({ id: IDS.spawnedOne, title: "AUDIT: SAME TITLE", projectId: PROJECT_ALPHA.id, parentGoalId: IDS.teamGoal, spawnedBySessionId: IDS.teamLead, createdAt: NOW + 3 }),
		goal({ id: IDS.spawnedTwo, title: "AUDIT: SAME TITLE", projectId: PROJECT_ALPHA.id, parentGoalId: IDS.teamGoal, spawnedBySessionId: IDS.teamLead, createdAt: NOW + 4 }),
		// Duplicate id intentionally mirrors a reducer-race shape: render must dedupe by id.
		goal({ id: IDS.spawnedOne, title: "AUDIT: SAME TITLE", projectId: PROJECT_ALPHA.id, parentGoalId: IDS.teamGoal, spawnedBySessionId: IDS.teamLead, createdAt: NOW + 30 }),
		goal({ id: IDS.forestParent, title: "Forest Parent", projectId: PROJECT_BETA.id, createdAt: NOW + 5 }),
		goal({ id: IDS.forestChild, title: "Forest Child", projectId: PROJECT_BETA.id, parentGoalId: IDS.forestParent, createdAt: NOW + 6 }),
	];
}

function archivedGoals(): Goal[] {
	return [
		goal({ id: IDS.spawnedArchived, title: "Archived Spawned Child", projectId: PROJECT_ALPHA.id, parentGoalId: IDS.teamGoal, spawnedBySessionId: IDS.teamLead, archived: true, archivedAt: NOW + 40, state: "complete", createdAt: NOW + 7 }),
		goal({ id: IDS.forestArchivedChild, title: "Archived Forest Child", projectId: PROJECT_BETA.id, parentGoalId: IDS.forestParent, archived: true, archivedAt: NOW + 41, state: "complete", createdAt: NOW + 8 }),
	];
}

function staffRecords() {
	return [
		{ id: IDS.staff, name: "Fixture Staff", description: "Project staff", state: "active", triggers: [], currentSessionId: IDS.staffSession, projectId: PROJECT_ALPHA.id },
	];
}

function orphanStaffRecord() {
	return { id: IDS.orphanStaff, name: "Orphan Fixture Staff", description: "Needs assignment", state: "active" };
}

function installFixtureStyle(): void {
	if (document.getElementById("sidebar-navigation-fixture-style")) return;
	const style = document.createElement("style");
	style.id = "sidebar-navigation-fixture-style";
	style.textContent = `
		html, body, #app { height: 100%; margin: 0; }
		body { font-family: ui-sans-serif, system-ui, sans-serif; }
		#app { width: 980px; min-height: 760px; }
		.hidden, [hidden] { display: none !important; }
		.sidebar-edge { min-height: 720px; border-right: 1px solid #d1d5db; }
		button, input { font: inherit; }
	`;
	document.head.appendChild(style);
}

function nextFrames(frames = 2): Promise<void> {
	return new Promise((resolve) => {
		const step = (remaining: number) => remaining <= 0 ? resolve() : requestAnimationFrame(() => step(remaining - 1));
		step(frames);
	});
}

function renderFixture(): void {
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	render(renderSidebar(), app);
}

function expandDefaults(): void {
	if (!isProjectExpanded(PROJECT_ALPHA.id)) toggleProjectExpanded(PROJECT_ALPHA.id);
	if (!isProjectExpanded(PROJECT_BETA.id)) toggleProjectExpanded(PROJECT_BETA.id);
	setUngroupedExpanded(PROJECT_ALPHA.id, true);
	setUngroupedExpanded(PROJECT_BETA.id, true);
	setStaffSectionExpanded(PROJECT_ALPHA.id, true);
	setStaffSectionExpanded(PROJECT_BETA.id, true);
	setArchivedSectionExpanded(PROJECT_ALPHA.id, true);
	setArchivedSectionExpanded(PROJECT_BETA.id, true);
	for (const id of [IDS.soloGoal, IDS.teamGoal, IDS.forestParent, IDS.forestChild, IDS.spawnedOne, IDS.spawnedTwo]) {
		expandedGoals.add(id);
	}
	saveExpandedGoals();
	if (!isTeamLeadExpanded(IDS.teamLead)) toggleTeamLeadExpanded(IDS.teamLead);
	setFirstClassParentExpanded(IDS.sessionA, true);
}

async function resetFixture(opts?: { showArchived?: boolean; mobile?: boolean }): Promise<void> {
	installFixtureStyle();
	document.documentElement.dataset.subgoalsEnabled = "true";
	document.documentElement.dataset.maxNestingDepth = "5";
	localStorage.setItem("bobbit-show-archived", opts?.showArchived ? "true" : "false");
	localStorage.setItem("bobbit-show-busy", "true");
	localStorage.setItem("bobbit-show-read", "true");
	localStorage.setItem("bobbit-sidebar-collapsed", "false");
	setProjects([{ ...PROJECT_ALPHA }, { ...PROJECT_BETA }]);
	expandedGoals.clear();
	Object.assign(state, {
		appView: "authenticated",
		connectionStatus: "connected",
		gatewaySessions: liveSessions(),
		archivedSessions: archivedSessions(),
		goals: [...liveGoals(), ...(opts?.showArchived ? archivedGoals() : [])],
		selectedSessionId: null,
		connectingSessionId: null,
		keyboardNavActiveId: null,
		activeProjectId: PROJECT_ALPHA.id,
		sidebarCollapsed: false,
		showArchived: !!opts?.showArchived,
		showBusy: true,
		showRead: true,
		filtersPopoverOpen: false,
		searchQuery: "",
		sessionsLoading: false,
		sessionsError: "",
		creatingSession: false,
		creatingSessionForGoalId: null,
		staffList: staffRecords(),
		orphanedStaff: [orphanStaffRecord()],
		archivedGoalsCursor: null,
		archivedGoalsHasMore: false,
		archivedGoalsTotal: archivedGoals().length,
		archivedSessionsCursor: null,
		archivedSessionsHasMore: false,
		archivedSessionsTotal: archivedSessions().length,
		remoteAgent: null,
	});
	expandDefaults();
	if (opts?.mobile) document.documentElement.dataset.forceMobile = "true";
	else delete document.documentElement.dataset.forceMobile;
	window.history.replaceState({}, "", "#/");
	renderFixture();
	await nextFrames();
}

async function selectSession(sessionId: string): Promise<void> {
	const session = [...state.gatewaySessions, ...state.archivedSessions].find((s) => s.id === sessionId);
	if (!session) throw new Error(`Unknown fixture session ${sessionId}`);
	state.selectedSessionId = sessionId;
	state.connectingSessionId = null;
	state.remoteAgent = { gatewaySessionId: sessionId, title: session.title } as any;
	window.history.pushState({}, "", `#/session/${sessionId}`);
	renderFixture();
	await nextFrames();
}

async function selectGoalDashboard(goalId: string): Promise<void> {
	state.selectedSessionId = null;
	state.remoteAgent = null;
	window.history.pushState({}, "", `#/goal/${goalId}`);
	renderFixture();
	await nextFrames();
}

async function setSearch(query: string): Promise<void> {
	state.searchQuery = query;
	renderFixture();
	await nextFrames();
}

async function setShowArchived(show: boolean): Promise<void> {
	state.showArchived = show;
	localStorage.setItem("bobbit-show-archived", show ? "true" : "false");
	state.goals = [...liveGoals(), ...(show ? archivedGoals() : [])];
	expandDefaults();
	renderFixture();
	await nextFrames();
}

async function collapseSidebar(): Promise<void> {
	if (!state.sidebarCollapsed) toggleSidebar();
	await nextFrames();
}

async function expandSidebar(): Promise<void> {
	if (state.sidebarCollapsed) toggleSidebar();
	await nextFrames();
}

async function resolveStaffCreate(): Promise<void> {
	staffCreateResolver?.(json({ id: "sidebar-new-staff-session" }));
	staffCreateResolver = null;
	await nextFrames();
}

setRenderApp(renderFixture);
(window as any).bobbitState = state;
(window as any).__bobbitState = state;
(window as any).__sidebarNavigationFixtureIds = IDS;
(window as any).__sidebarNavigationRender = renderFixture;
(window as any).__resetSidebarNavigationFixture = resetFixture;
(window as any).__sidebarNavigationSelectSession = selectSession;
(window as any).__sidebarNavigationSelectGoalDashboard = selectGoalDashboard;
(window as any).__sidebarNavigationSetSearch = setSearch;
(window as any).__sidebarNavigationSetShowArchived = setShowArchived;
(window as any).__sidebarNavigationCollapse = collapseSidebar;
(window as any).__sidebarNavigationExpand = expandSidebar;
(window as any).__sidebarNavigationResolveStaffCreate = resolveStaffCreate;
(window as any).__sidebarNavigationReady = true;
