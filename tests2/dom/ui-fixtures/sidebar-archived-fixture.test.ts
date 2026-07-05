import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/sidebar-archived-fixture.spec.ts (v2-dom tier).
// Renders the REAL renderSidebar() (desktop/collapsed) + the REAL render-helpers
// archived-section template (mobile) under happy-dom. All assertions are DOM
// order / presence / localStorage (no geometry), so the Chromium fixture ports
// faithfully. Decorative bobbit-avatar canvas rendering is shimmed (not under
// test); fetch/WebSocket are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, render } from "lit";
import { renderSidebar, isProjectExpanded, toggleProjectExpanded } from "../../../src/app/sidebar.js";
import {
	bucketArchivedByProject, filterArchivedGoalsByQuery, filterArchivedSessionsByQuery,
	renderProjectArchivedSection, isStandaloneArchivedSession,
} from "../../../src/app/render-helpers.js";
import {
	expandedGoals, saveExpandedGoals, setArchivedSectionExpanded, setProjects, setRenderApp,
	setStaffSectionExpanded, setUngroupedExpanded, state,
	type GatewaySession, type Goal, type Project,
} from "../../../src/app/state.js";
import {
	setArchivedParentExpanded as setTreeArchivedParentExpanded,
	setGoalExpanded as setTreeGoalExpanded,
	setTeamLeadExpanded as setTreeTeamLeadExpanded,
	resetArchivedSidebarTreeExpansion,
} from "../../../src/app/sidebar-tree-state.js";

const PROJECT_A_ID = "sidebar-archived-project-a";
const PROJECT_B_ID = "sidebar-archived-project-b";
const PROJECT_A: Project = { id: PROJECT_A_ID, name: "Archived Fixture Alpha", rootPath: "/tmp/sidebar-archived-alpha", colorLight: "#2563eb", colorDark: "#60a5fa" };
const PROJECT_B: Project = { id: PROJECT_B_ID, name: "Archived Fixture Bravo", rootPath: "/tmp/sidebar-archived-bravo", colorLight: "#9333ea", colorDark: "#c084fc" };
const PROJECTS = [PROJECT_A, PROJECT_B];

const IDS = {
	projectA: PROJECT_A_ID, projectB: PROJECT_B_ID,
	liveGoalA: "sidebar-archived-live-goal-a", teamGoalA: "sidebar-archived-team-goal-a",
	archivedGoalA1: "sidebar-archived-goal-a-1", archivedGoalA2: "sidebar-archived-goal-a-2",
	archivedGoalB: "sidebar-archived-goal-b", archivedChildGoal: "sidebar-archived-child-goal",
	liveSessionParent: "sidebar-archived-parent-session", archivedDelegate: "sidebar-archived-delegate-session",
	archivedNestedDelegate: "sidebar-archived-nested-delegate-session",
	archivedStandaloneA: "sidebar-archived-standalone-a", archivedStandaloneB: "sidebar-archived-standalone-b",
	legacyLlmReview: "llm-review-sidebar-archived-legacy-001", legacyAgentQa: "agent-qa-sidebar-archived-legacy-001",
	missingGoalReviewTranscript: "llm-review-sidebar-archived-missing-goal-transcript",
	missingGoalReviewPlaceholder: "agent-qa-sidebar-archived-missing-goal-placeholder",
	teamLead: "sidebar-archived-team-lead", teamWorker: "sidebar-archived-team-worker",
	archivedTeamLead: "sidebar-archived-archived-team-lead", archivedTeamWorker: "sidebar-archived-archived-team-worker",
};
type Ids = typeof IDS;

let currentMode: "desktop" | "mobile" = "desktop";

class FixtureWebSocket {
	static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
	readyState = FixtureWebSocket.OPEN;
	addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void { this.readyState = FixtureWebSocket.CLOSED; }
}

function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function requestPath(input: any): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try { const u = new URL(raw, window.location.href); return `${u.pathname}${u.search}`; } catch { return raw; }
}
function installFetch(): void {
	vi.stubGlobal("fetch", async (input: any) => {
		const url = requestPath(input);
		if (url.includes("/side-panel-workspace")) return response({ version: 1, tabs: [], activeTabId: "", sizeMode: "split" });
		if (url === "/api/projects") return response({ projects: PROJECTS });
		if (url.startsWith("/api/goals?") && url.includes("archived=true")) return response({ goals: fixtureGoals().filter(g => g.archived), total: 4, hasMore: false, nextCursor: null, archivedSessions: [] });
		if (url.startsWith("/api/goals?")) return response({ goals: fixtureGoals().filter(g => !g.archived), total: 2, hasMore: false, nextCursor: null });
		if (url.startsWith("/api/sessions?")) return response({ sessions: fixtureLiveSessions(), archivedDelegates: fixtureArchivedSessions().filter(s => !!(s as any).delegateOf), total: 3, hasMore: false, nextCursor: null });
		if (url.startsWith("/api/roles")) return response([]);
		if (url === "/api/staff" || url.startsWith("/api/staff?") || url === "/api/staff/orphaned") return response({ staff: [] });
		if (url === "/api/preferences") return response({});
		if (url.startsWith("/api/sandbox-status")) return response({ available: false, configured: false });
		return response({ ok: true });
	});
}

function goal(partial: Partial<Goal> & Pick<Goal, "id" | "title" | "projectId" | "createdAt">): Goal {
	const project = PROJECTS.find(p => p.id === partial.projectId) ?? PROJECT_A;
	return { cwd: project.rootPath, state: "in-progress", spec: "Sidebar archived fixture goal", updatedAt: partial.createdAt, setupStatus: "ready", ...partial } as Goal;
}
function session(partial: Partial<GatewaySession> & Pick<GatewaySession, "id" | "title" | "projectId" | "createdAt">): GatewaySession {
	const project = PROJECTS.find(p => p.id === partial.projectId) ?? PROJECT_A;
	return { cwd: project.rootPath, status: "idle", lastActivity: partial.createdAt, clientCount: 0, ...partial } as GatewaySession;
}
function fixtureGoals(): Goal[] {
	return [
		goal({ id: IDS.liveGoalA, title: "Alpha Live Goal", projectId: PROJECT_A_ID, createdAt: 10 }),
		goal({ id: IDS.teamGoalA, title: "Alpha Team Goal", projectId: PROJECT_A_ID, createdAt: 20, team: true, teamLeadSessionId: IDS.teamLead } as any),
		goal({ id: IDS.archivedChildGoal, title: "Alpha Archived Child Goal", projectId: PROJECT_A_ID, parentGoalId: IDS.liveGoalA, createdAt: 25, archived: true, archivedAt: 90 } as any),
		goal({ id: IDS.archivedGoalA1, title: "Alpha Archived Goal One", projectId: PROJECT_A_ID, createdAt: 30, archived: true, archivedAt: 100 } as any),
		goal({ id: IDS.archivedGoalA2, title: "Alpha Archived Goal Two", projectId: PROJECT_A_ID, createdAt: 40, archived: true, archivedAt: 110 } as any),
		goal({ id: IDS.archivedGoalB, title: "Bravo Archived Goal", projectId: PROJECT_B_ID, createdAt: 50, archived: true, archivedAt: 120 } as any),
	];
}
function fixtureLiveSessions(): GatewaySession[] {
	return [
		session({ id: IDS.liveSessionParent, title: "Alpha Live Parent Session", projectId: PROJECT_A_ID, createdAt: 15 }),
		session({ id: IDS.teamLead, title: "Alpha Live Team Lead", projectId: PROJECT_A_ID, createdAt: 21, role: "team-lead", goalId: IDS.teamGoalA, teamGoalId: IDS.teamGoalA } as any),
		session({ id: IDS.teamWorker, title: "Alpha Live Team Worker", projectId: PROJECT_A_ID, createdAt: 22, role: "coder", goalId: IDS.teamGoalA, teamGoalId: IDS.teamGoalA, teamLeadSessionId: IDS.teamLead } as any),
	];
}
function fixtureArchivedSessions(): GatewaySession[] {
	return [
		session({ id: IDS.archivedDelegate, title: "Alpha Archived Delegate", projectId: PROJECT_A_ID, createdAt: 60, delegateOf: IDS.liveSessionParent, archived: true, archivedAt: 160, status: "terminated" } as any),
		session({ id: IDS.archivedNestedDelegate, title: "Alpha Archived Nested Delegate", projectId: PROJECT_A_ID, createdAt: 61, delegateOf: IDS.archivedDelegate, archived: true, archivedAt: 161, status: "terminated" } as any),
		session({ id: IDS.archivedStandaloneA, title: "Alpha Archived Standalone Session", projectId: PROJECT_A_ID, createdAt: 70, archived: true, archivedAt: 170, status: "terminated" } as any),
		session({ id: IDS.legacyLlmReview, title: "New session", projectId: PROJECT_A_ID, createdAt: 71, role: "bug-hunter", accessory: "magnifier", goalId: IDS.teamGoalA, archived: true, archivedAt: 171, status: "terminated", nonInteractive: true } as any),
		session({ id: IDS.legacyAgentQa, title: "New session", projectId: PROJECT_A_ID, createdAt: 72, role: "tester", accessory: "magnifier", goalId: IDS.teamGoalA, archived: true, archivedAt: 172, status: "terminated", nonInteractive: true } as any),
		session({ id: IDS.missingGoalReviewTranscript, title: "New session", projectId: PROJECT_A_ID, createdAt: 73, role: "bug-hunter", accessory: "magnifier", goalId: "sidebar-archived-missing-goal", archived: true, archivedAt: 173, status: "terminated", nonInteractive: true, agentSessionFile: "reviews/missing-goal-transcript.jsonl" } as any),
		session({ id: IDS.missingGoalReviewPlaceholder, title: "New session", projectId: PROJECT_A_ID, createdAt: 74, role: "tester", accessory: "magnifier", goalId: "sidebar-archived-missing-goal", archived: true, archivedAt: 174, status: "terminated", nonInteractive: true } as any),
		session({ id: IDS.archivedStandaloneB, title: "Bravo Archived Standalone Session", projectId: PROJECT_B_ID, createdAt: 80, archived: true, archivedAt: 180, status: "terminated" } as any),
		session({ id: IDS.archivedTeamLead, title: "Alpha Archived Team Lead", projectId: PROJECT_A_ID, createdAt: 90, role: "team-lead", goalId: IDS.teamGoalA, teamGoalId: IDS.teamGoalA, archived: true, archivedAt: 190, status: "terminated" } as any),
		session({ id: IDS.archivedTeamWorker, title: "Alpha Archived Team Worker", projectId: PROJECT_A_ID, createdAt: 91, role: "coder", goalId: IDS.teamGoalA, teamGoalId: IDS.teamGoalA, teamLeadSessionId: IDS.archivedTeamLead, archived: true, archivedAt: 191, status: "terminated" } as any),
	];
}

function mobileArchivedTemplate() {
	const q = state.searchQuery;
	const archivedGoals = filterArchivedGoalsByQuery(state.goals.filter(g => g.archived), state.gatewaySessions, state.archivedSessions, q);
	const standaloneArchived = filterArchivedSessionsByQuery(state.archivedSessions.filter(isStandaloneArchivedSession), q);
	const byProject = bucketArchivedByProject(archivedGoals, standaloneArchived, PROJECTS);
	return html`
		<div class="sidebar-root" data-fixture-mode="mobile">
			<input data-search .value=${q} @input=${(event: InputEvent) => { state.searchQuery = (event.currentTarget as HTMLInputElement).value; renderFixture(); }} />
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

function expandProject(projectId: string): void { if (!isProjectExpanded(projectId)) toggleProjectExpanded(projectId); }

async function resetFixture(options: { mode?: "desktop" | "mobile"; showArchived?: boolean; collapsed?: boolean } = {}): Promise<void> {
	currentMode = options.mode ?? "desktop";
	const showArchived = options.showArchived ?? false;
	localStorage.setItem("bobbit-show-archived", showArchived ? "true" : "false");
	localStorage.removeItem("bobbit-archived-collapsed-projects");
	localStorage.removeItem("bobbit-expanded-delegate-parents");
	localStorage.removeItem("bobbit-sidebar-tree-state:v1");
	// happy-dom shares the module-level sidebar-tree-state map across tests (a real
	// page reload would reset it); clear every goal/team-lead/session-children
	// expansion key so each test starts from defaults like the Chromium fixture.
	resetArchivedSidebarTreeExpansion({
		archivedGoalIds: fixtureGoals().map(g => g.id),
		archivedSessionIds: [...fixtureLiveSessions(), ...fixtureArchivedSessions()].map(s => s.id),
	});
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
		appView: "authenticated", connectionStatus: "connected",
		gatewaySessions: fixtureLiveSessions(), archivedSessions: fixtureArchivedSessions(), goals: fixtureGoals(),
		selectedSessionId: null, connectingSessionId: null, keyboardNavActiveId: null, activeProjectId: PROJECT_A_ID,
		sidebarCollapsed: options.collapsed ?? false, showArchived, showBusy: true, showRead: true,
		filtersPopoverOpen: false, searchQuery: "", sessionsLoading: false, sessionsError: "",
		creatingSession: false, creatingSessionForGoalId: null, staffList: [], orphanedStaff: [],
		archivedGoalsCursor: null, archivedGoalsHasMore: false, archivedGoalsTotal: 4,
		archivedSessionsCursor: null, archivedSessionsHasMore: false, archivedSessionsTotal: 10,
	});
	window.history.replaceState({}, "", "#/fixture");
	renderFixture();
	await frame();
}

// ── canvas shim (decorative bobbit avatars; not under test) ──
let _origGetContext: any; let _origToDataURL: any;
function stubCanvas(): void {
	const ctx: any = new Proxy({ imageSmoothingEnabled: false, fillStyle: "", getImageData: (_x = 0, _y = 0, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), measureText: () => ({ width: 0 }), createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), getLineDash: () => [] }, {
		get(t: any, k: string) { if (k in t) return t[k]; return () => {}; }, set(t: any, k: string, v: any) { t[k] = v; return true; },
	});
	_origGetContext = (HTMLCanvasElement.prototype as any).getContext;
	_origToDataURL = (HTMLCanvasElement.prototype as any).toDataURL;
	(HTMLCanvasElement.prototype as any).getContext = () => ctx;
	(HTMLCanvasElement.prototype as any).toDataURL = () => "data:image/png;base64,";
}
function restoreCanvas(): void {
	if (_origGetContext) (HTMLCanvasElement.prototype as any).getContext = _origGetContext;
	if (_origToDataURL) (HTMLCanvasElement.prototype as any).toDataURL = _origToDataURL;
}

const frame = () => new Promise<void>((r) => setTimeout(r, 0));
async function frames(n = 3): Promise<void> { for (let i = 0; i < n; i++) await frame(); }
async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) { if (fn()) return; await frame(); }
	throw new Error("waitFor timed out");
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const count = (sel: string) => document.querySelectorAll(sel).length;

function domIndexes(selectors: string[]): number[] {
	const all = Array.from(document.querySelectorAll("*"));
	return selectors.map((sel) => all.indexOf(document.querySelector(sel) as Element));
}
function expectIncreasing(indexes: number[], label: string): void {
	for (let i = 0; i < indexes.length; i++) {
		expect(indexes[i], `${label} selector ${i} missing`).toBeGreaterThanOrEqual(0);
		if (i > 0) expect(indexes[i], `${label} order ${i}`).toBeGreaterThan(indexes[i - 1]);
	}
}
function standalonePlacement(sessionId: string, projectId: string, nextProjectId: string) {
	const all = Array.from(document.querySelectorAll("*"));
	const row = document.querySelector(`[data-session-id="${sessionId}"]`);
	const archivedHeader = document.querySelector(`[data-nav-id="archived-header:${projectId}"]`);
	const nextProject = document.querySelector(`.project-reorder-section[data-project-id="${nextProjectId}"], section[data-project-id="${nextProjectId}"]`);
	const rowIndex = row ? all.indexOf(row) : -1;
	const headerIndex = archivedHeader ? all.indexOf(archivedHeader) : -1;
	const nextProjectIndex = nextProject ? all.indexOf(nextProject) : all.length;
	const dividerText = all.slice(Math.max(0, headerIndex), Math.max(0, rowIndex)).map(el => el.textContent?.trim()).filter(t => t === "Goals" || t === "Sessions").at(-1) ?? "";
	return { rowIndex, headerIndex, nextProjectIndex, dividerText, isStandalone: rowIndex >= 0 && headerIndex >= 0 && rowIndex > headerIndex && rowIndex < nextProjectIndex && dividerText === "Sessions" };
}
function expectStandalone(sessionId: string, projectId: string, nextProjectId: string, label: string, expected: boolean): void {
	expect(standalonePlacement(sessionId, projectId, nextProjectId).isStandalone, `${label} ${sessionId}`).toBe(expected);
}
function treeExpansionSnapshot(): Record<string, string> {
	const raw = localStorage.getItem("bobbit-sidebar-tree-state:v1");
	return raw ? (JSON.parse(raw).expansion ?? {}) : {};
}
function archivedSectionPreference(projectId: string): string | undefined {
	const raw = localStorage.getItem("bobbit-sidebar-tree-state:v1");
	if (!raw) return undefined;
	return JSON.parse(raw).expansion?.[`sidebar-tree/v1/project-archived/${encodeURIComponent(projectId)}`];
}
function archivedPreferenceKeys(ids: Ids): string[] {
	return [
		`sidebar-tree/v1/project-archived/${encodeURIComponent(ids.projectA)}`,
		`sidebar-tree/v1/goal/${encodeURIComponent(ids.archivedGoalA1)}`,
		`sidebar-tree/v1/team-lead/${encodeURIComponent(ids.archivedTeamLead)}`,
		`sidebar-tree/v1/session-children/${encodeURIComponent(ids.archivedDelegate)}?childClass=delegate`,
		`sidebar-tree/v1/session-children/${encodeURIComponent(ids.archivedDelegate)}?childClass=archived-delegate`,
	];
}
function expectPreferencesPreserved(before: Record<string, string>, after: Record<string, string>, ids: Ids): void {
	for (const key of archivedPreferenceKeys(ids)) {
		expect(before[key], `preference ${key} seeded`).toBeDefined();
		expect(after[key], `preference ${key} preserved`).toBe(before[key]);
	}
}

async function setShowArchived(checked: boolean): Promise<void> {
	if (state.filtersPopoverOpen !== true) { q('[data-testid="sidebar-filters-button"]')!.click(); await frame(); }
	const checkbox = q('[data-testid="sidebar-filter-archived"] input') as HTMLInputElement;
	expect(checkbox).toBeTruthy();
	if ((state.showArchived === true) !== checked) { checkbox.click(); await frames(); }
	await waitFor(() => state.showArchived === checked);
}

async function expandLiveTeamLead(teamLeadId: string, teamWorkerId: string): Promise<void> {
	const lead = q(`[data-session-id="${teamLeadId}"]`);
	expect(lead, "live team lead renders").toBeTruthy();
	const expand = lead!.querySelector(`span[title="Expand"]`) as HTMLElement | null;
	if (expand) { expand.click(); await frames(); }
	await waitFor(() => count(`[data-session-id="${teamWorkerId}"]`) > 0);
}

beforeEach(() => {
	const div = document.createElement("div"); div.id = "app"; document.body.appendChild(div);
	(window as any).WebSocket = FixtureWebSocket;
	window.confirm = () => true;
	window.open = (() => null) as typeof window.open;
	localStorage.clear();
	stubCanvas();
	installFetch();
	setRenderApp(renderFixture);
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
	restoreCanvas();
	localStorage.clear();
});

describe("Sidebar archived deterministic fixture", () => {
	it("Show Archived toggles archived rows on/off and writes the persisted preference", async () => {
		await resetFixture({ showArchived: false });
		const ids = IDS;

		expect(count(`[data-nav-id="archived-header:${ids.projectA}"]`)).toBe(0);
		expect(count(`[data-nav-id="goal:${ids.archivedGoalA1}"]`)).toBe(0);

		await setShowArchived(true);
		await waitFor(() => count(`[data-nav-id="archived-header:${ids.projectA}"]`) === 1);
		expect(count(`[data-nav-id="goal:${ids.archivedGoalA1}"]`)).toBe(1);
		expect(localStorage.getItem("bobbit-show-archived")).toBe("true");

		await setShowArchived(false);
		await waitFor(() => count(`[data-nav-id="archived-header:${ids.projectA}"]`) === 0);
		expect(count(`[data-nav-id="goal:${ids.archivedGoalA1}"]`)).toBe(0);
		expect(localStorage.getItem("bobbit-show-archived")).toBe("false");
	});

	it("desktop per-project archived sections preserve ordering, collapse state, and nested archived goals", async () => {
		await resetFixture({ showArchived: true });
		const ids = IDS;

		expect(count(`[data-nav-id="archived-header:${ids.projectA}"]`)).toBe(1);
		expect(count(`[data-nav-id="archived-header:${ids.projectB}"]`)).toBe(1);
		expect(count(`[data-nav-id="goal:${ids.archivedChildGoal}"]`)).toBe(1);

		expectIncreasing(domIndexes([
			`[data-testid="project-header"][data-project-id="${ids.projectA}"]`,
			`[data-nav-id="goal:${ids.liveGoalA}"]`,
			`[data-nav-id="goal:${ids.archivedChildGoal}"]`,
			`[data-nav-id="archived-header:${ids.projectA}"]`,
			`[data-nav-id="goal:${ids.archivedGoalA1}"]`,
			`[data-nav-id="goal:${ids.archivedGoalA2}"]`,
			`[data-session-id="${ids.archivedStandaloneA}"]`,
			`[data-testid="project-header"][data-project-id="${ids.projectB}"]`,
			`[data-nav-id="archived-header:${ids.projectB}"]`,
			`[data-nav-id="goal:${ids.archivedGoalB}"]`,
		]), "desktop archived rows");

		q(`[data-nav-id="archived-header:${ids.projectB}"]`)!.click();
		await waitFor(() => count(`[data-nav-id="goal:${ids.archivedGoalB}"]`) === 0);
		expect(count(`[data-nav-id="goal:${ids.archivedGoalA1}"]`)).toBe(1);
		expect(archivedSectionPreference(ids.projectB)).toBe("collapsed");
	});

	it("legacy verifier sessions stay out of project-level standalone archive rows", async () => {
		await resetFixture({ showArchived: true });
		const ids = IDS;
		expect(count(`[data-session-id="${ids.archivedStandaloneA}"]`)).toBe(1);
		expectStandalone(ids.legacyLlmReview, ids.projectA, ids.projectB, "desktop llm-review", false);
		expectStandalone(ids.legacyAgentQa, ids.projectA, ids.projectB, "desktop agent-qa", false);
	});

	it("missing-goal verifier transcript uses standalone fallback while empty placeholders stay hidden", async () => {
		await resetFixture({ showArchived: true });
		const ids = IDS;
		expectStandalone(ids.missingGoalReviewTranscript, ids.projectA, ids.projectB, "desktop missing-goal transcript", true);
		expect(count(`[data-session-id="${ids.missingGoalReviewPlaceholder}"]`)).toBe(0);
	});

	it("legacy live team-goal verifier nests near the expanded live team lead", async () => {
		await resetFixture({ showArchived: true });
		const ids = IDS;
		await expandLiveTeamLead(ids.teamLead, ids.teamWorker);
		await waitFor(() => count(`[data-session-id="${ids.legacyLlmReview}"]`) > 0);
		expectIncreasing(domIndexes([
			`[data-session-id="${ids.teamLead}"]`,
			`[data-session-id="${ids.legacyLlmReview}"]`,
			`[data-session-id="${ids.legacyAgentQa}"]`,
			`[data-nav-id="archived-header:${ids.projectA}"]`,
		]), "live team-goal verifier rows");
	});

	it("archived team leads, members, and delegates nest under their live owners", async () => {
		await resetFixture({ showArchived: true });
		const ids = IDS;

		const archivedLead = q(`[data-session-id="${ids.archivedTeamLead}"]`);
		expect(archivedLead, "archived team lead renders").toBeTruthy();
		const leadExpand = archivedLead!.querySelector(`span[title="Expand"]`) as HTMLElement | null;
		if (leadExpand) { leadExpand.click(); await frames(); }
		await waitFor(() => count(`[data-session-id="${ids.archivedTeamWorker}"]`) > 0);

		const parent = q(`[data-session-id="${ids.liveSessionParent}"]`);
		expect(parent, "live parent session renders").toBeTruthy();
		(parent!.querySelector("span") as HTMLElement).click();
		await waitFor(() => count(`[data-session-id="${ids.archivedDelegate}"]`) > 0);
		(q(`[data-session-id="${ids.archivedDelegate}"] span[title="Expand"]`) as HTMLElement).click();
		await waitFor(() => count(`[data-session-id="${ids.archivedNestedDelegate}"]`) > 0);

		await setShowArchived(false);
		await waitFor(() => count(`[data-session-id="${ids.archivedDelegate}"]`) === 0);
		await setShowArchived(true);
		await waitFor(() => count(`[data-session-id="${ids.archivedDelegate}"]`) > 0);
	});

	it("Show Archived off/on preserves explicit archived tree preferences", async () => {
		await resetFixture({ showArchived: true });
		const ids = IDS;
		(window as any); // set archived search preference fixture:
		setArchivedSectionExpanded(ids.projectA, false);
		setTreeGoalExpanded(ids.archivedGoalA1, true);
		setTreeTeamLeadExpanded(ids.archivedTeamLead, false);
		setTreeArchivedParentExpanded(ids.archivedDelegate, true);
		const before = treeExpansionSnapshot();

		await setShowArchived(false);
		await waitFor(() => count(`[data-nav-id="archived-header:${ids.projectA}"]`) === 0);
		await setShowArchived(true);
		await waitFor(() => count(`[data-nav-id="archived-header:${ids.projectA}"]`) > 0);

		expectPreferencesPreserved(before, treeExpansionSnapshot(), ids);
	});

	it("collapsed sidebar recurses into session child and delegate groups", async () => {
		await resetFixture({ showArchived: true, collapsed: true });
		expect(count('[data-testid="sidebar-collapsed"]')).toBeGreaterThan(0);
		const parent = q(`button[title='Alpha Live Parent Session']`);
		expect(parent, "collapsed live parent button").toBeTruthy();
		expect(count(`button[title='Alpha Archived Delegate']`)).toBe(0);

		(parent!.querySelector(".sidebar-chevron-glyph") as HTMLElement).click();
		await waitFor(() => count(`button[title='Alpha Archived Delegate']`) > 0);
		(q(`button[title='Alpha Archived Delegate'] .sidebar-chevron-glyph`) as HTMLElement).click();
		await waitFor(() => count(`button[title='Alpha Archived Nested Delegate']`) > 0);
	});

	it("collapsed sidebar exposes archived goal rows only when Show Archived is on", async () => {
		await resetFixture({ showArchived: true, collapsed: true });
		expect(count('[data-testid="sidebar-collapsed"]')).toBeGreaterThan(0);
		expect(count("button[title='Alpha Archived Goal One']")).toBe(1);

		await resetFixture({ showArchived: false, collapsed: true });
		expect(count('[data-testid="sidebar-collapsed"]')).toBeGreaterThan(0);
		expect(count("button[title='Alpha Archived Goal One']")).toBe(0);
	});

	it("mobile archived sections share bucketing, collapse persistence, and search highlighting", async () => {
		await resetFixture({ mode: "mobile", showArchived: true });
		const ids = IDS;

		expect(count(`[data-nav-id="archived-header:${ids.projectA}"]`)).toBeGreaterThan(0);
		expect(count(`[data-nav-id="archived-header:${ids.projectB}"]`)).toBeGreaterThan(0);
		expect(count(`[data-session-id="${ids.archivedStandaloneA}"]`)).toBeGreaterThan(0);
		expectStandalone(ids.legacyLlmReview, ids.projectA, ids.projectB, "mobile llm-review", false);
		expectStandalone(ids.legacyAgentQa, ids.projectA, ids.projectB, "mobile agent-qa", false);
		expectStandalone(ids.missingGoalReviewTranscript, ids.projectA, ids.projectB, "mobile missing-goal transcript", true);
		expect(count(`[data-session-id="${ids.missingGoalReviewPlaceholder}"]`)).toBe(0);
		expectIncreasing(domIndexes([
			`section[data-project-id="${ids.projectA}"]`,
			`[data-nav-id="archived-header:${ids.projectA}"]`,
			`[data-nav-id="goal:${ids.archivedGoalA1}"]`,
			`section[data-project-id="${ids.projectB}"]`,
			`[data-nav-id="archived-header:${ids.projectB}"]`,
			`[data-nav-id="goal:${ids.archivedGoalB}"]`,
		]), "mobile archived rows");

		q(`[data-nav-id="archived-header:${ids.projectB}"]`)!.click();
		await waitFor(() => count(`[data-nav-id="goal:${ids.archivedGoalB}"]`) === 0);
		expect(archivedSectionPreference(ids.projectB)).toBe("collapsed");

		await resetFixture({ mode: "mobile", showArchived: true });
		const search = q("input[data-search]") as HTMLInputElement;
		search.value = "Goal One";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		await waitFor(() => count(`[data-nav-id="goal:${ids.archivedGoalA1}"]`) === 1);
		expect(count(`[data-nav-id="goal:${ids.archivedGoalA2}"]`)).toBe(0);
		expect(count(`[data-nav-id="goal:${ids.archivedGoalB}"]`)).toBe(0);
		await waitFor(() => (q("strong.font-semibold")?.textContent || "").includes("Goal One"));

		await resetFixture({ mode: "mobile", showArchived: false });
		expect(count(`[data-nav-id="archived-header:${ids.projectA}"]`)).toBe(0);
	});
});
