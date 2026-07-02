import { html, render } from "lit";
import { renderSidebar, isProjectExpanded, toggleProjectExpanded } from "../../src/app/sidebar.js";
import {
	bucketArchivedByProject,
	filterArchivedGoalsByQuery,
	filterArchivedSessionsByQuery,
	renderProjectArchivedSection,
	isStandaloneArchivedSession,
} from "../../src/app/render-helpers.js";
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

const PROJECT_A_ID = "sidebar-archived-project-a";
const PROJECT_B_ID = "sidebar-archived-project-b";

const PROJECT_A: Project = {
	id: PROJECT_A_ID,
	name: "Archived Fixture Alpha",
	rootPath: "/tmp/sidebar-archived-alpha",
	colorLight: "#2563eb",
	colorDark: "#60a5fa",
};

const PROJECT_B: Project = {
	id: PROJECT_B_ID,
	name: "Archived Fixture Bravo",
	rootPath: "/tmp/sidebar-archived-bravo",
	colorLight: "#9333ea",
	colorDark: "#c084fc",
};

const PROJECTS = [PROJECT_A, PROJECT_B];

const IDS = {
	projectA: PROJECT_A_ID,
	projectB: PROJECT_B_ID,
	liveGoalA: "sidebar-archived-live-goal-a",
	teamGoalA: "sidebar-archived-team-goal-a",
	archivedGoalA1: "sidebar-archived-goal-a-1",
	archivedGoalA2: "sidebar-archived-goal-a-2",
	archivedGoalB: "sidebar-archived-goal-b",
	archivedChildGoal: "sidebar-archived-child-goal",
	liveSessionParent: "sidebar-archived-parent-session",
	archivedDelegate: "sidebar-archived-delegate-session",
	archivedNestedDelegate: "sidebar-archived-nested-delegate-session",
	archivedStandaloneA: "sidebar-archived-standalone-a",
	archivedStandaloneB: "sidebar-archived-standalone-b",
	legacyLlmReview: "llm-review-sidebar-archived-legacy-001",
	legacyAgentQa: "agent-qa-sidebar-archived-legacy-001",
	missingGoalReviewTranscript: "llm-review-sidebar-archived-missing-goal-transcript",
	missingGoalReviewPlaceholder: "agent-qa-sidebar-archived-missing-goal-placeholder",
	teamLead: "sidebar-archived-team-lead",
	teamWorker: "sidebar-archived-team-worker",
	archivedTeamLead: "sidebar-archived-archived-team-lead",
	archivedTeamWorker: "sidebar-archived-archived-team-worker",
};

let currentMode: "desktop" | "mobile" = "desktop";

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
	if (url === "/api/projects") return response({ projects: PROJECTS });
	if (url.startsWith("/api/goals?") && url.includes("archived=true")) {
		return response({ goals: fixtureGoals().filter(g => g.archived), total: 4, hasMore: false, nextCursor: null, archivedSessions: [] });
	}
	if (url.startsWith("/api/goals?")) return response({ goals: fixtureGoals().filter(g => !g.archived), total: 2, hasMore: false, nextCursor: null });
	if (url.startsWith("/api/sessions?")) {
		return response({ sessions: fixtureLiveSessions(), archivedDelegates: fixtureArchivedSessions().filter(s => !!s.delegateOf), total: 3, hasMore: false, nextCursor: null });
	}
	if (url === "/api/staff" || url.startsWith("/api/staff?") || url === "/api/staff/orphaned") return response({ staff: [] });
	if (url === "/api/preferences") return response({});
	if (url === "/api/sandbox-status") return response({ available: false, configured: false });
	return response({ ok: true });
}) as typeof window.fetch;

function goal(partial: Partial<Goal> & Pick<Goal, "id" | "title" | "projectId" | "createdAt">): Goal {
	const project = PROJECTS.find(p => p.id === partial.projectId) ?? PROJECT_A;
	return {
		cwd: project.rootPath,
		state: "in-progress",
		spec: "Sidebar archived fixture goal",
		updatedAt: partial.createdAt,
		setupStatus: "ready",
		...partial,
	};
}

function session(partial: Partial<GatewaySession> & Pick<GatewaySession, "id" | "title" | "projectId" | "createdAt">): GatewaySession {
	const project = PROJECTS.find(p => p.id === partial.projectId) ?? PROJECT_A;
	return {
		cwd: project.rootPath,
		status: "idle",
		lastActivity: partial.createdAt,
		clientCount: 0,
		...partial,
	};
}

function fixtureGoals(): Goal[] {
	return [
		goal({ id: IDS.liveGoalA, title: "Alpha Live Goal", projectId: PROJECT_A_ID, createdAt: 10 }),
		goal({ id: IDS.teamGoalA, title: "Alpha Team Goal", projectId: PROJECT_A_ID, createdAt: 20, team: true, teamLeadSessionId: IDS.teamLead }),
		goal({ id: IDS.archivedChildGoal, title: "Alpha Archived Child Goal", projectId: PROJECT_A_ID, parentGoalId: IDS.liveGoalA, createdAt: 25, archived: true, archivedAt: 90 }),
		goal({ id: IDS.archivedGoalA1, title: "Alpha Archived Goal One", projectId: PROJECT_A_ID, createdAt: 30, archived: true, archivedAt: 100 }),
		goal({ id: IDS.archivedGoalA2, title: "Alpha Archived Goal Two", projectId: PROJECT_A_ID, createdAt: 40, archived: true, archivedAt: 110 }),
		goal({ id: IDS.archivedGoalB, title: "Bravo Archived Goal", projectId: PROJECT_B_ID, createdAt: 50, archived: true, archivedAt: 120 }),
	];
}

function fixtureLiveSessions(): GatewaySession[] {
	return [
		session({ id: IDS.liveSessionParent, title: "Alpha Live Parent Session", projectId: PROJECT_A_ID, createdAt: 15 }),
		session({ id: IDS.teamLead, title: "Alpha Live Team Lead", projectId: PROJECT_A_ID, createdAt: 21, role: "team-lead", goalId: IDS.teamGoalA, teamGoalId: IDS.teamGoalA }),
		session({ id: IDS.teamWorker, title: "Alpha Live Team Worker", projectId: PROJECT_A_ID, createdAt: 22, role: "coder", goalId: IDS.teamGoalA, teamGoalId: IDS.teamGoalA, teamLeadSessionId: IDS.teamLead }),
	];
}

function fixtureArchivedSessions(): GatewaySession[] {
	return [
		session({ id: IDS.archivedDelegate, title: "Alpha Archived Delegate", projectId: PROJECT_A_ID, createdAt: 60, delegateOf: IDS.liveSessionParent, archived: true, archivedAt: 160, status: "terminated" }),
		session({ id: IDS.archivedNestedDelegate, title: "Alpha Archived Nested Delegate", projectId: PROJECT_A_ID, createdAt: 61, delegateOf: IDS.archivedDelegate, archived: true, archivedAt: 161, status: "terminated" }),
		session({ id: IDS.archivedStandaloneA, title: "Alpha Archived Standalone Session", projectId: PROJECT_A_ID, createdAt: 70, archived: true, archivedAt: 170, status: "terminated" }),
		session({ id: IDS.legacyLlmReview, title: "New session", projectId: PROJECT_A_ID, createdAt: 71, role: "bug-hunter", accessory: "magnifier", goalId: IDS.teamGoalA, archived: true, archivedAt: 171, status: "terminated", nonInteractive: true }),
		session({ id: IDS.legacyAgentQa, title: "New session", projectId: PROJECT_A_ID, createdAt: 72, role: "tester", accessory: "magnifier", goalId: IDS.teamGoalA, archived: true, archivedAt: 172, status: "terminated", nonInteractive: true }),
		session({ id: IDS.missingGoalReviewTranscript, title: "New session", projectId: PROJECT_A_ID, createdAt: 73, role: "bug-hunter", accessory: "magnifier", goalId: "sidebar-archived-missing-goal", archived: true, archivedAt: 173, status: "terminated", nonInteractive: true, ...({ agentSessionFile: "reviews/missing-goal-transcript.jsonl" } as any) }),
		session({ id: IDS.missingGoalReviewPlaceholder, title: "New session", projectId: PROJECT_A_ID, createdAt: 74, role: "tester", accessory: "magnifier", goalId: "sidebar-archived-missing-goal", archived: true, archivedAt: 174, status: "terminated", nonInteractive: true }),
		session({ id: IDS.archivedStandaloneB, title: "Bravo Archived Standalone Session", projectId: PROJECT_B_ID, createdAt: 80, archived: true, archivedAt: 180, status: "terminated" }),
		session({ id: IDS.archivedTeamLead, title: "Alpha Archived Team Lead", projectId: PROJECT_A_ID, createdAt: 90, role: "team-lead", goalId: IDS.teamGoalA, teamGoalId: IDS.teamGoalA, archived: true, archivedAt: 190, status: "terminated" }),
		session({ id: IDS.archivedTeamWorker, title: "Alpha Archived Team Worker", projectId: PROJECT_A_ID, createdAt: 91, role: "coder", goalId: IDS.teamGoalA, teamGoalId: IDS.teamGoalA, teamLeadSessionId: IDS.archivedTeamLead, archived: true, archivedAt: 191, status: "terminated" }),
	];
}

function installFixtureStyle(): void {
	if (document.getElementById("sidebar-archived-fixture-style")) return;
	const style = document.createElement("style");
	style.id = "sidebar-archived-fixture-style";
	style.textContent = `
		html, body, #app { min-height: 100%; margin: 0; }
		body { font-family: ui-sans-serif, system-ui, sans-serif; }
		#app { width: 980px; min-height: 760px; }
		.hidden, [hidden] { display: none !important; }
		.sidebar-edge { min-height: 720px; border-right: 1px solid #d1d5db; }
		button, input { font: inherit; }
		[data-fixture-mode='mobile'] { width: 390px; min-height: 720px; }
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

function mobileArchivedTemplate() {
	const q = state.searchQuery;
	const archivedGoals = filterArchivedGoalsByQuery(state.goals.filter(g => g.archived), state.gatewaySessions, state.archivedSessions, q);
	const standaloneArchived = filterArchivedSessionsByQuery(
		state.archivedSessions.filter(isStandaloneArchivedSession),
		q,
	);
	const byProject = bucketArchivedByProject(archivedGoals, standaloneArchived, PROJECTS);
	return html`
		<div class="sidebar-root" data-fixture-mode="mobile">
			<input data-search .value=${q} @input=${(event: InputEvent) => {
				state.searchQuery = (event.currentTarget as HTMLInputElement).value;
				renderFixture();
			}} />
			<div data-project-reorder-list>
				${PROJECTS.map(project => {
					const bucket = byProject.get(project.id)!;
					return html`
						<section data-project-id=${project.id}>
							<div data-testid="project-header">${project.name}</div>
							${renderProjectArchivedSection(project, bucket.archivedGoals, bucket.standaloneArchivedSessions, "mobile")}
						</section>
					`;
				})}
			</div>
		</div>
	`;
}

function renderFixture(): void {
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	render(currentMode === "mobile" ? mobileArchivedTemplate() : renderSidebar(), app);
}

function expandProject(projectId: string): void {
	if (!isProjectExpanded(projectId)) toggleProjectExpanded(projectId);
}

async function resetFixture(options: { mode?: "desktop" | "mobile"; showArchived?: boolean; collapsed?: boolean } = {}): Promise<void> {
	installFixtureStyle();
	currentMode = options.mode ?? "desktop";
	const showArchived = options.showArchived ?? false;
	localStorage.setItem("bobbit-show-archived", showArchived ? "true" : "false");
	localStorage.removeItem("bobbit-archived-collapsed-projects");
	localStorage.removeItem("bobbit-expanded-delegate-parents");
	localStorage.setItem("bobbit-show-busy", "true");
	localStorage.setItem("bobbit-show-read", "true");
	setProjects(PROJECTS.map(p => ({ ...p })));
	for (const project of PROJECTS) {
		expandProject(project.id);
		setArchivedSectionExpanded(project.id, true);
		setUngroupedExpanded(project.id, true);
		setStaffSectionExpanded(project.id, true);
	}
	expandedGoals.clear();
	expandedGoals.add(IDS.liveGoalA);
	expandedGoals.add(IDS.teamGoalA);
	saveExpandedGoals();
	Object.assign(state, {
		appView: "authenticated",
		connectionStatus: "connected",
		gatewaySessions: fixtureLiveSessions(),
		archivedSessions: fixtureArchivedSessions(),
		goals: fixtureGoals(),
		selectedSessionId: null,
		connectingSessionId: null,
		keyboardNavActiveId: null,
		activeProjectId: PROJECT_A_ID,
		sidebarCollapsed: options.collapsed ?? false,
		showArchived,
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
		archivedGoalsTotal: 4,
		archivedSessionsCursor: null,
		archivedSessionsHasMore: false,
		archivedSessionsTotal: 10,
	});
	window.history.replaceState({}, "", "#/fixture");
	renderFixture();
	await nextFrames();
}

setRenderApp(renderFixture);
(window as any).bobbitState = state;
(window as any).__bobbitState = state;
(window as any).__sidebarArchivedFixtureIds = IDS;
(window as any).__renderSidebarArchivedFixture = renderFixture;
(window as any).__resetSidebarArchivedFixture = resetFixture;
(window as any).__sidebarArchivedReady = true;
