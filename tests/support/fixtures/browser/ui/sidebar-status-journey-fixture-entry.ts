import { html, render } from "lit";
import { commitGatewayConnection } from "../../../../../src/app/gateway-fetch.js";
import { doRenderApp } from "../../../../../src/app/render.js";
import { markSessionVisited } from "../../../../../src/app/render-helpers.js";
import { animateSidebarStatusChanges, captureSidebarStatusMotion, installSidebarStatusMotionClickGuard } from "../../../../../src/app/sidebar-status-motion.js";
import { buildSidebarStatusSections, renderSidebarStatusContent, renderSidebarViewControls } from "../../../../../src/app/sidebar.js";
import {
	setProjects,
	setRenderApp,
	state,
	type GatewaySession,
	type Goal,
	type Project,
} from "../../../../../src/app/state.js";
import {
	setArchivedSectionExpanded,
	setStaffSectionExpanded,
	setUngroupedExpanded,
} from "../../../../../src/app/sidebar-tree-state.js";
import {
	SIDEBAR_SESSION_VIEW_STORAGE_KEY,
	SIDEBAR_STATUS_COLLAPSED_SECTIONS_STORAGE_KEY,
	SIDEBAR_STATUS_FILTER_STORAGE_KEYS,
	loadSidebarSessionView,
	loadSidebarStatusCollapsedSections,
	loadSidebarStatusFilter,
} from "../../../../../src/app/sidebar-view-preferences.js";

const PROJECT_ID = "sidebar-status-project";
const PROJECT: Project = {
	id: PROJECT_ID,
	name: "Status Journey Project",
	rootPath: "/tmp/sidebar-status-journey",
	colorLight: "#2563eb",
	colorDark: "#60a5fa",
};
const GOAL_ID = "sidebar-status-goal";
const GOAL: Goal = {
	id: GOAL_ID,
	title: "Improve session manager sidebar",
	cwd: PROJECT.rootPath,
	projectId: PROJECT_ID,
	state: "in-progress",
	spec: "Status fixture goal",
	createdAt: 1,
	updatedAt: 1,
};

const IDS = {
	project: PROJECT_ID,
	pinnedNew: "status-pinned-new",
	pinnedOld: "status-pinned-old",
	unreadNew: "status-unread-new",
	unreadOld: "status-unread-old",
	readNew: "status-read-new",
	readOld: "status-read-old",
	busy: "status-busy",
	teamLead: "status-team-lead",
	teamMember: "status-team-member",
	staffSession: "status-staff-session",
	archived: "status-archived",
} as const;

const STAFF_ID = "status-staff-agent";
const STAFF_NAME = "Async Status Staff";
const STAFF_RUNTIME_TITLE = "Underlying Staff Runtime";

const VIEW_KEYS = [
	SIDEBAR_SESSION_VIEW_STORAGE_KEY,
	SIDEBAR_STATUS_COLLAPSED_SECTIONS_STORAGE_KEY,
	...Object.values(SIDEBAR_STATUS_FILTER_STORAGE_KEYS),
	"bobbit-show-archived",
	"bobbit-show-busy",
	"bobbit-show-read",
	"bobbit-sidebar-collapsed",
];
const FIXTURE_GATEWAY_BASE_URL = "https://fixture.test/team/bobbit";
const FIXTURE_GATEWAY_TOKEN = "fixture-token";
const persistedPinTags = new Map<string, string[]>();
let staffResponseBarrier: Promise<void> = Promise.resolve();
let releaseStaffResponse: (() => void) | null = null;

function prepareStaffResponse(deferred: boolean): void {
	if (!deferred) {
		staffResponseBarrier = Promise.resolve();
		releaseStaffResponse = null;
		return;
	}
	staffResponseBarrier = new Promise<void>((resolve) => {
		releaseStaffResponse = resolve;
	});
}

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
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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
	const route = mountedRoute(requestUrl(input));
	const method = init?.method ?? request?.method ?? "GET";
	(window as any).__sidebarStatusRequests.push({ route, method });

	const pinMatch = route.match(/^\/api\/sessions\/([^/]+)\/pin$/);
	if (pinMatch && method === "PUT") {
		const sessionId = decodeURIComponent(pinMatch[1]);
		const raw = typeof init?.body === "string" ? init.body : "{}";
		const pinned = JSON.parse(raw).pinned === true;
		const next = pinned ? ["future=preserved", "pinned=true"] : ["future=preserved"];
		persistedPinTags.set(sessionId, next);
		return response({ user_tags: next });
	}
	if (route.endsWith("/mark-read") && method === "POST") return response({ ok: true });
	if (route === "/api/projects") return response({ projects: [{ ...PROJECT }] });
	if (route.startsWith("/api/sessions") && route.includes("include=archived")) {
		return response({ sessions: [fixtureArchivedSession()], archivedDelegates: [], total: 1, hasMore: false, nextCursor: null });
	}
	if (route.startsWith("/api/sessions")) return response({ sessions: [], archivedDelegates: [], total: 0, hasMore: false, nextCursor: null });
	if (route.startsWith("/api/goals")) return response({ goals: [], total: 0, hasMore: false, nextCursor: null, archivedSessions: [] });
	if (route === "/api/staff/orphaned") return response({ staff: [] });
	if (route === "/api/staff" || route.startsWith("/api/staff?")) {
		await staffResponseBarrier;
		return response({ staff: [{
			id: STAFF_ID,
			name: STAFF_NAME,
			description: "Loaded asynchronously for the Status startup journey",
			state: "active",
			currentSessionId: IDS.staffSession,
			triggers: [],
			projectId: PROJECT_ID,
		}] });
	}
	if (route === "/api/preferences") return response({});
	if (route.startsWith("/api/sandbox-status")) return response({ available: false, configured: false });
	return response({ ok: true });
}) as typeof window.fetch;

function installFixtureStyle(): void {
	if (document.getElementById("sidebar-status-journey-style")) return;
	const style = document.createElement("style");
	style.id = "sidebar-status-journey-style";
	style.textContent = `
		html, body, #app { height: 100%; margin: 0; }
		body { font-family: ui-sans-serif, system-ui, sans-serif; }
		#app { width: 100%; min-height: 760px; }
		.hidden, [hidden] { display: none !important; }
		.app-shell { min-height: 760px; }
		button, input { font: inherit; }
	`;
	document.head.appendChild(style);
}

function createSession(input: Partial<GatewaySession> & Pick<GatewaySession, "id" | "title" | "status" | "createdAt" | "lastActivity">): GatewaySession {
	return {
		cwd: PROJECT.rootPath,
		projectId: PROJECT_ID,
		clientCount: 0,
		lastReadAt: input.lastActivity + 1,
		server_tags: [],
		user_tags: persistedPinTags.get(input.id) ?? [],
		...input,
	};
}

function fixtureSessions(): GatewaySession[] {
	return [
		createSession({ id: IDS.pinnedNew, title: "Pinned Newest", status: "idle", createdAt: 91, lastActivity: 9_100, user_tags: persistedPinTags.get(IDS.pinnedNew) ?? ["pinned=true"] }),
		createSession({ id: IDS.pinnedOld, title: "Pinned Older", status: "idle", createdAt: 81, lastActivity: 8_100, user_tags: persistedPinTags.get(IDS.pinnedOld) ?? ["pinned=true"] }),
		createSession({ id: IDS.unreadNew, title: "Unread Newest", status: "idle", createdAt: 71, lastActivity: 7_100, lastReadAt: 1, lastTurnErrored: true, consecutiveErrorTurns: 3, goalId: GOAL_ID }),
		createSession({ id: IDS.unreadOld, title: "Unread Older", status: "idle", createdAt: 61, lastActivity: 6_100, lastReadAt: 1, lastTurnErrored: true, consecutiveErrorTurns: 3 }),
		createSession({ id: IDS.readNew, title: "Read Newest", status: "idle", createdAt: 51, lastActivity: 5_100 }),
		createSession({ id: IDS.readOld, title: "Read Older", status: "idle", createdAt: 41, lastActivity: 4_100 }),
		createSession({ id: IDS.busy, title: "Active Shimmer Session", status: "streaming", createdAt: 31, lastActivity: 3_100 }),
		createSession({ id: IDS.teamLead, title: "Visible Team Lead", status: "idle", createdAt: 21, lastActivity: 2_100, role: "team-lead" }),
		createSession({ id: IDS.teamMember, title: "Hidden Team Member", status: "idle", createdAt: 11, lastActivity: 1_100, role: "coder", teamLeadSessionId: IDS.teamLead }),
		createSession({ id: IDS.staffSession, title: STAFF_RUNTIME_TITLE, status: "idle", createdAt: 6, lastActivity: 600 }),
	];
}

function fixtureArchivedSession(): GatewaySession {
	return createSession({
		id: IDS.archived,
		title: "Archived Safe Session",
		status: "archived",
		createdAt: 1,
		lastActivity: 100,
		archived: true,
		archivedAt: 200,
	});
}

function loadPreferences(): void {
	state.sidebarSessionView = loadSidebarSessionView();
	state.statusShowArchived = loadSidebarStatusFilter("showArchived");
	state.statusShowBusy = loadSidebarStatusFilter("showBusy");
	state.statusShowRead = loadSidebarStatusFilter("showRead");
	state.statusShowTeams = loadSidebarStatusFilter("showTeams");
	state.statusCollapsedSections = loadSidebarStatusCollapsedSections();
	state.showArchived = localStorage.getItem("bobbit-show-archived") === "true";
	state.showBusy = localStorage.getItem("bobbit-show-busy") !== "false";
	state.showRead = localStorage.getItem("bobbit-show-read") !== "false";
	state.sidebarCollapsed = localStorage.getItem("bobbit-sidebar-collapsed") === "true";
}

function renderFixture(): void {
	doRenderApp();
}

async function nextFrames(frames = 2): Promise<void> {
	await new Promise<void>((resolve) => {
		const step = (remaining: number) => remaining <= 0 ? resolve() : requestAnimationFrame(() => step(remaining - 1));
		step(frames);
	});
}

type FixtureSurface = "desktop" | "mobile" | "collapsed";

async function resetFixture(options: {
	preserveStorage?: boolean;
	preservePins?: boolean;
	initialView?: "project" | "status";
	surface?: FixtureSurface;
	deferStaff?: boolean;
} = {}): Promise<void> {
	commitGatewayConnection(FIXTURE_GATEWAY_BASE_URL, FIXTURE_GATEWAY_TOKEN);
	(window as any).__sidebarStatusRequests = [];
	installFixtureStyle();
	if (!options.preserveStorage) VIEW_KEYS.forEach((key) => localStorage.removeItem(key));
	if (!options.preservePins) persistedPinTags.clear();
	if (options.initialView) localStorage.setItem(SIDEBAR_SESSION_VIEW_STORAGE_KEY, options.initialView);
	if (options.surface === "collapsed") localStorage.setItem("bobbit-sidebar-collapsed", "true");
	prepareStaffResponse(options.deferStaff === true);
	loadPreferences();
	setProjects([{ ...PROJECT }]);
	setUngroupedExpanded(PROJECT_ID, true);
	setStaffSectionExpanded(PROJECT_ID, true);
	setArchivedSectionExpanded(PROJECT_ID, true);
	Object.assign(state, {
		appView: "authenticated",
		connectionStatus: "connected",
		gatewaySessions: fixtureSessions(),
		archivedSessions: [fixtureArchivedSession()],
		goals: [{ ...GOAL }],
		selectedSessionId: null,
		connectingSessionId: null,
		remoteAgent: null,
		chatPanel: null,
		keyboardNavActiveId: null,
		activeProjectId: PROJECT_ID,
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
	window.history.replaceState({}, "", "#/settings");
	if (options.surface === "mobile") renderMobileStatusFixture();
	else renderFixture();
	await nextFrames();
}

function simulateReload(): void {
	loadPreferences();
	state.gatewaySessions = fixtureSessions();
	state.archivedSessions = [fixtureArchivedSession()];
	state.filtersPopoverOpen = false;
	state.searchQuery = "";
	renderFixture();
}

function markFixtureSessionRead(sessionId: string): void {
	const session = state.gatewaySessions.find((candidate) => candidate.id === sessionId);
	if (session) {
		session.lastTurnErrored = false;
		session.consecutiveErrorTurns = 0;
	}
	markSessionVisited(sessionId);
	renderFixture();
}

function reorderUnreadFixtureRows(): void {
	const session = state.gatewaySessions.find((candidate) => candidate.id === IDS.unreadOld);
	if (session) session.lastActivity = 7_200;
	renderFixture();
}

function renderMobileStatusFixture(): void {
	setRenderApp(renderMobileStatusFixture);
	state.sidebarSessionView = "status";
	localStorage.setItem(SIDEBAR_SESSION_VIEW_STORAGE_KEY, "status");
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	installSidebarStatusMotionClickGuard();
	const motion = captureSidebarStatusMotion(app);
	render(html`<div class="sidebar-root">${renderSidebarViewControls("mobile")}${renderSidebarStatusContent(buildSidebarStatusSections(undefined, "mobile"))}</div>`, app);
	animateSidebarStatusChanges(motion, app);
}

setRenderApp(renderFixture);
(window as any).bobbitState = state;
(window as any).__bobbitState = state;
(window as any).__sidebarStatusJourneyIds = IDS;
(window as any).__resetSidebarStatusJourney = resetFixture;
(window as any).__reloadSidebarStatusJourney = simulateReload;
(window as any).__markSidebarStatusSessionRead = markFixtureSessionRead;
(window as any).__reorderSidebarStatusUnreadRows = reorderUnreadFixtureRows;
(window as any).__renderMobileSidebarStatusJourney = renderMobileStatusFixture;
(window as any).__releaseSidebarStatusStaffResponse = () => {
	releaseStaffResponse?.();
	releaseStaffResponse = null;
};
(window as any).__sidebarStatusJourneyReady = true;
