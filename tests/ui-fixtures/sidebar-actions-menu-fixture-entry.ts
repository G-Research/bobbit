import { render } from "lit";
import { renderSidebar, isProjectExpanded, toggleProjectExpanded } from "../../src/app/sidebar.js";
import {
	expandedGoals,
	saveExpandedGoals,
	setProjects,
	setRenderApp,
	setUngroupedExpanded,
	state,
	type GatewaySession,
	type Goal,
	type Project,
} from "../../src/app/state.js";
import "../../src/ui/components/SidebarActionsPopover.js";

const PROJECT_ID = "sidebar-actions-fixture-project";
const STANDARD_SESSION_ID = "sidebar-actions-standard-session";
const GENERAL_SESSION_ID = "sidebar-actions-general-session";
const TEAM_LEAD_SESSION_ID = "sidebar-actions-team-lead-session";
const GOAL_ID = "11111111-aaaa-4aaa-8aaa-111111111111";
const FORK_ID = "22222222-bbbb-4bbb-8bbb-222222222222";

const PROJECT: Project = {
	id: PROJECT_ID,
	name: "Sidebar Actions Fixture",
	rootPath: "/tmp/sidebar-actions-fixture",
	colorLight: "#2563eb",
	colorDark: "#60a5fa",
};

const BASE_SESSION: Omit<GatewaySession, "id" | "title"> = {
	cwd: PROJECT.rootPath,
	projectId: PROJECT_ID,
	status: "idle",
	createdAt: 10,
	lastActivity: 10,
	clientCount: 0,
};

const STANDARD_SESSION: GatewaySession = {
	...BASE_SESSION,
	id: STANDARD_SESSION_ID,
	title: "Actions Fixture Standard Session",
};

const GENERAL_SESSION: GatewaySession = {
	...BASE_SESSION,
	id: GENERAL_SESSION_ID,
	title: "Actions Fixture Role General",
	role: "general",
};

const TEAM_LEAD_SESSION: GatewaySession = {
	...BASE_SESSION,
	id: TEAM_LEAD_SESSION_ID,
	title: "Actions Fixture Team Lead",
	role: "team-lead",
};

const GOAL: Goal = {
	id: GOAL_ID,
	title: "Actions Fixture Goal",
	cwd: PROJECT.rootPath,
	projectId: PROJECT_ID,
	state: "in-progress",
	spec: "Goal used by sidebar actions menu fixture.",
	createdAt: 20,
	updatedAt: 20,
	setupStatus: "ready",
};

const SESSIONS = [STANDARD_SESSION, GENERAL_SESSION, TEAM_LEAD_SESSION];
const GOALS = [GOAL];

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
window.open = ((url?: string | URL) => {
	(window as any).__sidebarActionsOpenedUrls.push(String(url));
	return { opener: null } as any;
}) as typeof window.open;

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

function sessionFor(id: string | undefined): GatewaySession | undefined {
	if (!id) return undefined;
	if (id === FORK_ID) {
		return { ...STANDARD_SESSION, id: FORK_ID, title: "Forked fixture session", cwd: "/tmp/fork" };
	}
	return SESSIONS.find((session) => session.id === id);
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const path = requestPath(input);
	if (path === "/api/projects") return response({ projects: [{ ...PROJECT }] });
	if (path === "/api/preferences") return response({});
	if (path === "/api/sandbox-status") return response({ available: false, configured: false });
	if (path === "/api/staff" || path.startsWith("/api/staff?") || path === "/api/staff/orphaned") return response({ staff: [] });
	if (path.startsWith("/api/goals?") && path.includes("archived=true")) {
		return response({ goals: [], total: 0, hasMore: false, nextCursor: null, archivedSessions: [] });
	}
	if (path.startsWith("/api/goals?")) return response({ goals: GOALS.map((goal) => ({ ...goal })) });
	if (path === `/api/goals/${GOAL_ID}/github-link`) return response({ available: false, reason: "no-branch" });
	if (path.startsWith(`/api/goals/${GOAL_ID}/gates`)) return response({ passed: 0, total: 0, gates: [] });
	if (path.startsWith("/api/sessions?") || path === "/api/sessions") {
		return response({ sessions: SESSIONS.map((session) => ({ ...session })), archivedDelegates: [], total: SESSIONS.length, hasMore: false, nextCursor: null });
	}
	const forkMatch = path.match(/^\/api\/sessions\/([^/]+)\/fork$/);
	if (forkMatch) {
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
		(window as any).__sidebarActionsForkBodies.push(body);
		return response({ id: FORK_ID, cwd: "/tmp/fork", status: "idle", title: "Forked fixture session", projectId: PROJECT_ID }, 201);
	}
	const sessionMatch = path.match(/^\/api\/sessions\/([^/?]+)/);
	if (sessionMatch) {
		const session = sessionFor(decodeURIComponent(sessionMatch[1]));
		return session ? response({ ...session }) : response({ error: "not found" }, 404);
	}
	return response({ ok: true });
}) as typeof window.fetch;

function installFixtureStyle(): void {
	if (document.getElementById("sidebar-actions-fixture-style")) return;
	const style = document.createElement("style");
	style.id = "sidebar-actions-fixture-style";
	style.textContent = `
		html, body, #app { height: 100%; margin: 0; }
		body { font-family: ui-sans-serif, system-ui, sans-serif; }
		#app { width: 920px; min-height: 720px; padding: 8px; box-sizing: border-box; }
		.hidden, [hidden] { display: none !important; }
		.sidebar-edge { min-height: 680px; border-right: 1px solid #d1d5db; }
		.sidebar-actions { opacity: 1 !important; pointer-events: auto !important; }
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

function installClipboardFallback(): void {
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: () => Promise.reject(new Error("forced clipboard failure")) },
	});
	(document as any).execCommand = (cmd: string) => {
		if (cmd !== "copy") return false;
		const active = document.activeElement as HTMLTextAreaElement | null;
		const text = active && typeof active.value === "string" ? active.value : window.getSelection()?.toString() ?? "";
		(window as any).__sidebarActionsExecCopies.push(text);
		return true;
	};
}

async function resetFixture(): Promise<void> {
	installFixtureStyle();
	installClipboardFallback();
	(window as any).__sidebarActionsForkBodies = [];
	(window as any).__sidebarActionsExecCopies = [];
	(window as any).__sidebarActionsOpenedUrls = [];
	localStorage.setItem("bobbit-show-archived", "false");
	localStorage.setItem("bobbit-show-busy", "true");
	localStorage.setItem("bobbit-show-read", "true");
	setProjects([{ ...PROJECT }]);
	setUngroupedExpanded(PROJECT_ID, true);
	if (!isProjectExpanded(PROJECT_ID)) toggleProjectExpanded(PROJECT_ID);
	expandedGoals.clear();
	expandedGoals.add(GOAL_ID);
	saveExpandedGoals();
	Object.assign(state, {
		appView: "authenticated",
		connectionStatus: "connected",
		gatewaySessions: SESSIONS.map((session) => ({ ...session })) as GatewaySession[],
		archivedSessions: [] as GatewaySession[],
		goals: GOALS.map((goal) => ({ ...goal })),
		selectedSessionId: null,
		connectingSessionId: null,
		keyboardNavActiveId: null,
		goalDashboardId: null,
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
		archivedGoalsTotal: 0,
		archivedSessionsCursor: null,
		archivedSessionsHasMore: false,
		archivedSessionsTotal: 0,
	});
	window.history.replaceState({}, "", "#/landing");
	renderFixture();
	await nextFrames();
}

setRenderApp(renderFixture);
(window as any).bobbitState = state;
(window as any).__bobbitState = state;
(window as any).__resetSidebarActionsFixture = resetFixture;
(window as any).__sidebarActionsFixtureIds = {
	project: PROJECT_ID,
	session: STANDARD_SESSION_ID,
	generalSession: GENERAL_SESSION_ID,
	teamLeadSession: TEAM_LEAD_SESSION_ID,
	goal: GOAL_ID,
	fork: FORK_ID,
};
(window as any).__sidebarActionsReady = true;
