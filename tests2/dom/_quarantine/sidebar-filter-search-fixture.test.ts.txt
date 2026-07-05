import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/sidebar-filter-search-fixture.spec.ts (v2-dom tier).
// Renders the REAL renderSidebar() filter/search behavior under happy-dom (was an
// esbuild file:// bundle). passesSidebarFilters() is applied via Array.filter so
// filtered/collapsed rows are DOM-REMOVED (not CSS-hidden) — the legacy
// `offsetParent !== null` visibility probe is therefore equivalent to DOM
// presence, which is what we assert. Decorative bobbit-avatar canvas is shimmed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { renderSidebar, isProjectExpanded, toggleProjectExpanded } from "../../../src/app/sidebar.js";
import {
	expandedGoals, saveExpandedGoals, setArchivedSectionExpanded, setProjects, setRenderApp,
	setStaffSectionExpanded, setUngroupedExpanded, state,
	type GatewaySession, type Goal, type Project,
} from "../../../src/app/state.js";
import { resetArchivedSidebarTreeExpansion } from "../../../src/app/sidebar-tree-state.js";

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

const PROJECT: Project = { id: PROJECT_ID, name: "Sidebar Filter Fixture", rootPath: "/tmp/sidebar-filter-fixture", colorLight: "#2563eb", colorDark: "#60a5fa" };
const GOAL: Goal = { id: GOAL_ID, title: "Goal Filter Matrix", cwd: PROJECT.rootPath, projectId: PROJECT_ID, state: "in-progress", spec: "Goal.", createdAt: 10, updatedAt: 10, setupStatus: "ready" };
const COLLAPSED_PARENT_GOAL: Goal = { id: COLLAPSED_PARENT_GOAL_ID, title: "Collapsed Parent Goal", cwd: PROJECT.rootPath, projectId: PROJECT_ID, state: "in-progress", spec: "Parent stays collapsed.", createdAt: 11, updatedAt: 11, setupStatus: "ready" };
const NESTED_MATCH_GOAL: Goal = { id: NESTED_MATCH_GOAL_ID, title: "NestedSearchNeedle Child Goal", cwd: PROJECT.rootPath, projectId: PROJECT_ID, parentGoalId: COLLAPSED_PARENT_GOAL_ID, state: "in-progress", spec: "Matching child.", createdAt: 12, updatedAt: 12, setupStatus: "ready" } as Goal;

const IDS = {
	project: `project:${PROJECT_ID}`, readSession: READ_SESSION_ID, activeSession: ACTIVE_SESSION_ID, busySession: BUSY_SESSION_ID,
	goal: `goal:${GOAL_ID}`, goalReadSession: GOAL_READ_SESSION_ID,
	collapsedParentGoal: `goal:${COLLAPSED_PARENT_GOAL_ID}`, collapsedParentSession: COLLAPSED_PARENT_SESSION_ID,
	childSessionParent: CHILD_SESSION_PARENT_ID, firstClassChildSession: FIRST_CLASS_CHILD_SESSION_ID,
	delegateChildSession: DELEGATE_CHILD_SESSION_ID, archivedDelegateChildSession: ARCHIVED_DELEGATE_CHILD_SESSION_ID,
	nestedMatchGoal: `goal:${NESTED_MATCH_GOAL_ID}`, archivedSession: ARCHIVED_SESSION_ID,
};

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
		if (url === "/api/projects") return response({ projects: [{ ...PROJECT }] });
		if (url.startsWith("/api/sessions")) return response({ sessions: [], archivedDelegates: [], total: 0, hasMore: false, nextCursor: null });
		if (url.startsWith("/api/goals")) return response({ goals: [], total: 0, hasMore: false, nextCursor: null, archivedSessions: [] });
		if (url.startsWith("/api/roles")) return response([]);
		if (url === "/api/staff" || url.startsWith("/api/staff?") || url === "/api/staff/orphaned") return response({ staff: [] });
		if (url === "/api/preferences") return response({});
		if (url.startsWith("/api/sandbox-status")) return response({ available: false, configured: false });
		return response({ ok: true });
	});
}

function fixtureArchivedSessions(): GatewaySession[] {
	return [
		{ id: ARCHIVED_SESSION_ID, title: "ArchivedEchoFixture", cwd: PROJECT.rootPath, projectId: PROJECT_ID, status: "terminated", createdAt: 60, lastActivity: 1_000, lastReadAt: 2_000, clientCount: 0, archived: true, archivedAt: 4_000 } as GatewaySession,
		{ id: ARCHIVED_DELEGATE_CHILD_SESSION_ID, title: "ArchivedDelegateChildNeedle", role: "archived-delegate-child-role", cwd: PROJECT.rootPath, projectId: PROJECT_ID, goalId: COLLAPSED_PARENT_GOAL_ID, teamGoalId: COLLAPSED_PARENT_GOAL_ID, delegateOf: CHILD_SESSION_PARENT_ID, status: "terminated", createdAt: 83, lastActivity: 1_000, lastReadAt: 2_000, clientCount: 0, archived: true, archivedAt: 4_000 } as GatewaySession,
	];
}
function fixtureSessions(): GatewaySession[] {
	return [
		{ id: READ_SESSION_ID, title: "ReadStandaloneAlpha", cwd: PROJECT.rootPath, projectId: PROJECT_ID, status: "idle", createdAt: 20, lastActivity: 1_000, lastReadAt: 2_000, clientCount: 0 } as GatewaySession,
		{ id: ACTIVE_SESSION_ID, title: "ActiveReadStandalone", cwd: PROJECT.rootPath, projectId: PROJECT_ID, status: "idle", createdAt: 30, lastActivity: 1_000, lastReadAt: 2_000, clientCount: 1 } as GatewaySession,
		{ id: BUSY_SESSION_ID, title: "BusyStandaloneBravo", cwd: PROJECT.rootPath, projectId: PROJECT_ID, status: "streaming", createdAt: 40, lastActivity: 3_000, lastReadAt: 0, clientCount: 0 } as GatewaySession,
		{ id: GOAL_READ_SESSION_ID, title: "GoalChildReadCharlie", cwd: PROJECT.rootPath, projectId: PROJECT_ID, goalId: GOAL_ID, status: "idle", createdAt: 50, lastActivity: 1_000, lastReadAt: 2_000, clientCount: 0 } as GatewaySession,
		{ id: COLLAPSED_PARENT_SESSION_ID, title: "CollapsedRuntimeNeedle", role: "runtime-child-role-needle", cwd: PROJECT.rootPath, projectId: PROJECT_ID, goalId: COLLAPSED_PARENT_GOAL_ID, status: "idle", createdAt: 55, lastActivity: 1_000, lastReadAt: 2_000, clientCount: 0 } as GatewaySession,
		{ id: CHILD_SESSION_PARENT_ID, title: "OpaqueChildContainer", role: "container-role", cwd: PROJECT.rootPath, projectId: PROJECT_ID, goalId: COLLAPSED_PARENT_GOAL_ID, status: "idle", createdAt: 80, lastActivity: 1_000, lastReadAt: 2_000, clientCount: 0 } as GatewaySession,
		{ id: FIRST_CLASS_CHILD_SESSION_ID, title: "FirstClassChildNeedle", role: "first-class-child-role", cwd: PROJECT.rootPath, projectId: PROJECT_ID, goalId: COLLAPSED_PARENT_GOAL_ID, parentSessionId: CHILD_SESSION_PARENT_ID, status: "idle", createdAt: 81, lastActivity: 1_000, lastReadAt: 2_000, clientCount: 0 } as GatewaySession,
		{ id: DELEGATE_CHILD_SESSION_ID, title: "DelegateChildNeedle", role: "delegate-child-role", cwd: PROJECT.rootPath, projectId: PROJECT_ID, goalId: COLLAPSED_PARENT_GOAL_ID, delegateOf: CHILD_SESSION_PARENT_ID, status: "idle", createdAt: 82, lastActivity: 1_000, lastReadAt: 2_000, clientCount: 0 } as GatewaySession,
	];
}

function renderFixture(): void { render(renderSidebar(), document.getElementById("app")!); }

function readFilterStorage(): void {
	state.showArchived = localStorage.getItem("bobbit-show-archived") === "true";
	state.showBusy = localStorage.getItem("bobbit-show-busy") !== "false";
	state.showRead = localStorage.getItem("bobbit-show-read") !== "false";
}

async function resetFixture(opts: { preserveFilterStorage?: boolean } = {}): Promise<void> {
	if (!opts.preserveFilterStorage) {
		localStorage.removeItem("bobbit-show-archived"); localStorage.removeItem("bobbit-show-busy"); localStorage.removeItem("bobbit-show-read");
	}
	localStorage.removeItem("bobbit-expanded-goals");
	localStorage.removeItem("bobbit-sidebar-tree-state:v1");
	resetArchivedSidebarTreeExpansion({
		archivedGoalIds: [GOAL_ID, COLLAPSED_PARENT_GOAL_ID, NESTED_MATCH_GOAL_ID],
		archivedSessionIds: [...fixtureSessions(), ...fixtureArchivedSessions()].map(s => s.id),
	});
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
		appView: "authenticated", connectionStatus: "connected",
		gatewaySessions: fixtureSessions(), archivedSessions: fixtureArchivedSessions(),
		goals: [{ ...GOAL }, { ...COLLAPSED_PARENT_GOAL }, { ...NESTED_MATCH_GOAL }],
		selectedSessionId: ACTIVE_SESSION_ID, connectingSessionId: ACTIVE_SESSION_ID, keyboardNavActiveId: null,
		activeProjectId: PROJECT_ID, sidebarCollapsed: false, filtersPopoverOpen: false, searchQuery: "",
		sessionsLoading: false, sessionsError: "", creatingSession: false, creatingSessionForGoalId: null,
		staffList: [], orphanedStaff: [], archivedGoalsCursor: null, archivedGoalsHasMore: false, archivedGoalsTotal: 0,
		archivedSessionsCursor: null, archivedSessionsHasMore: false, archivedSessionsTotal: 1,
	});
	window.history.replaceState({}, "", `#/session/${ACTIVE_SESSION_ID}`);
	renderFixture();
	await frame();
}

async function setFilters(filters: { showRead?: boolean; showBusy?: boolean; showArchived?: boolean }): Promise<void> {
	if (typeof filters.showRead === "boolean") { state.showRead = filters.showRead; localStorage.setItem("bobbit-show-read", String(filters.showRead)); }
	if (typeof filters.showBusy === "boolean") { state.showBusy = filters.showBusy; localStorage.setItem("bobbit-show-busy", String(filters.showBusy)); }
	if (typeof filters.showArchived === "boolean") { state.showArchived = filters.showArchived; localStorage.setItem("bobbit-show-archived", String(filters.showArchived)); }
	renderFixture();
	await frame();
}
async function setSearch(query: string): Promise<void> { state.searchQuery = query; renderFixture(); await frame(); }

// ── canvas shim ──
let _origGetContext: any; let _origToDataURL: any;
function stubCanvas(): void {
	const ctx: any = new Proxy({ imageSmoothingEnabled: false, fillStyle: "", getImageData: (_x = 0, _y = 0, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), measureText: () => ({ width: 0 }), createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), getLineDash: () => [] }, { get(t: any, k: string) { return k in t ? t[k] : () => {}; }, set(t: any, k: string, v: any) { t[k] = v; return true; } });
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
async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) { if (fn()) return; await frame(); }
	throw new Error("waitFor timed out");
}
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const count = (sel: string) => document.querySelectorAll(sel).length;

// Filtered/collapsed rows are DOM-removed (passesSidebarFilters via Array.filter),
// so DOM presence in .sidebar-edge is exactly the legacy offsetParent visibility.
function visibleSessionIds(): string[] {
	return Array.from(document.querySelectorAll<HTMLElement>(".sidebar-edge [data-session-id]")).map((el) => el.dataset.sessionId || "").filter(Boolean);
}
const sessionVisible = (id: string) => waitFor(() => visibleSessionIds().includes(id));
const sessionHidden = (id: string) => waitFor(() => !visibleSessionIds().includes(id));

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
	// Prevent a debounced straggler render from firing renderFixture into a
	// torn-down / foreign container under isolate:false (shared state module).
	setRenderApp(() => {});
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
	restoreCanvas();
	localStorage.clear();
	delete document.documentElement.dataset.subgoalsEnabled;
	delete document.documentElement.dataset.maxNestingDepth;
});

describe("Sidebar filter/search lightweight fixture", () => {
	it("filter defaults and localStorage persistence render with the single-project sidebar", async () => {
		await resetFixture();
		const ids = IDS;
		expect(count(`[data-nav-id="${ids.project}"]`)).toBeGreaterThan(0);
		expect(q("button[title='Project settings']")).toBeTruthy();
		expect(q("button[title^='New goal in']")).toBeTruthy();

		q('[data-testid="sidebar-filters-button"]')!.click();
		await frame();
		const popover = q('[data-testid="sidebar-filters-popover"]');
		expect(popover).toBeTruthy();
		const cb = (name: string) => q(`[data-testid="sidebar-filter-${name}"] input`) as HTMLInputElement;
		expect(cb("archived").checked).toBe(false);
		expect(cb("busy").checked).toBe(true);
		expect(cb("read").checked).toBe(true);

		cb("archived").click(); await frame();
		cb("busy").click(); await frame();
		cb("read").click(); await frame();
		await waitFor(() => localStorage.getItem("bobbit-show-archived") === "true" && localStorage.getItem("bobbit-show-busy") === "false" && localStorage.getItem("bobbit-show-read") === "false");

		await resetFixture({ preserveFilterStorage: true });
		q('[data-testid="sidebar-filters-button"]')!.click();
		await frame();
		expect((q('[data-testid="sidebar-filter-archived"] input') as HTMLInputElement).checked).toBe(true);
		expect((q('[data-testid="sidebar-filter-busy"] input') as HTMLInputElement).checked).toBe(false);
		expect((q('[data-testid="sidebar-filter-read"] input') as HTMLInputElement).checked).toBe(false);
	});

	it("search input filters rows, auto-opens archived results, supports full search, and Escape clears", async () => {
		await resetFixture();
		const ids = IDS;
		const searchInput = q("input[data-search]") as HTMLInputElement;

		const type = async (v: string) => { searchInput.value = v; searchInput.dispatchEvent(new Event("input", { bubbles: true })); await frame(); };
		await type("ReadStandaloneAlpha");
		await waitFor(() => state.searchQuery === "ReadStandaloneAlpha");
		await sessionVisible(ids.readSession);
		await sessionHidden(ids.busySession);
		await waitFor(() => state.showArchived === true);

		await type("ArchivedEchoFixture");
		await waitFor(() => state.searchQuery === "ArchivedEchoFixture");
		await sessionVisible(ids.archivedSession);
		const fullSearch = Array.from(document.querySelectorAll("button, a")).find((b) => (b.textContent || "").trim() === "Full Search") as HTMLElement;
		expect(fullSearch).toBeTruthy();
		fullSearch.click();
		await waitFor(() => window.location.hash.includes("#/search?q=ArchivedEchoFixture"));

		window.history.replaceState({}, "", `#/session/${ids.activeSession}`);
		const live = q("input[data-search]") as HTMLInputElement;
		live.focus();
		live.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await frame();
		await waitFor(() => (q("input[data-search]") as HTMLInputElement).value === "");
		await waitFor(() => state.searchQuery === "");
		await waitFor(() => state.showArchived === false);
	});

	it("search expands retained collapsed goal ancestors ephemerally", async () => {
		await resetFixture();
		const ids = IDS;
		const key = "bobbit-sidebar-tree-state:v1";
		expect(count(`[data-nav-id="${ids.collapsedParentGoal}"]`)).toBeGreaterThan(0);
		expect(count(`[data-nav-id="${ids.nestedMatchGoal}"]`)).toBe(0);
		const before = localStorage.getItem(key);

		await setSearch("NestedSearchNeedle");
		expect(count(`[data-nav-id="${ids.collapsedParentGoal}"]`)).toBeGreaterThan(0);
		await waitFor(() => count(`[data-nav-id="${ids.nestedMatchGoal}"]`) > 0);
		expect(localStorage.getItem(key)).toBe(before);

		await setSearch("");
		expect(count(`[data-nav-id="${ids.collapsedParentGoal}"]`)).toBeGreaterThan(0);
		expect(count(`[data-nav-id="${ids.nestedMatchGoal}"]`)).toBe(0);
	});

	it("search reveals matching runtime rows under collapsed goals without persisting expansion", async () => {
		await resetFixture();
		const ids = IDS;
		const key = "bobbit-sidebar-tree-state:v1";
		expect(count(`[data-nav-id="${ids.collapsedParentGoal}"]`)).toBeGreaterThan(0);
		await sessionHidden(ids.collapsedParentSession);
		const before = localStorage.getItem(key);

		await setSearch("runtime-child-role-needle");
		expect(count(`[data-nav-id="${ids.collapsedParentGoal}"]`)).toBeGreaterThan(0);
		await sessionVisible(ids.collapsedParentSession);
		expect(localStorage.getItem(key)).toBe(before);

		await setSearch("");
		expect(count(`[data-nav-id="${ids.collapsedParentGoal}"]`)).toBeGreaterThan(0);
		await sessionHidden(ids.collapsedParentSession);
	});

	it("search retains matching first-class and delegate child sessions with goal ownership", async () => {
		await resetFixture();
		const ids = IDS;
		const key = "bobbit-sidebar-tree-state:v1";
		await sessionHidden(ids.childSessionParent);
		await sessionHidden(ids.firstClassChildSession);
		await sessionHidden(ids.delegateChildSession);
		const before = localStorage.getItem(key);

		await setSearch("FirstClassChildNeedle");
		expect(count(`[data-nav-id="${ids.collapsedParentGoal}"]`)).toBeGreaterThan(0);
		await sessionVisible(ids.childSessionParent);
		await sessionVisible(ids.firstClassChildSession);
		await sessionHidden(ids.delegateChildSession);
		expect(localStorage.getItem(key)).toBe(before);

		await setSearch("DelegateChildNeedle");
		expect(count(`[data-nav-id="${ids.collapsedParentGoal}"]`)).toBeGreaterThan(0);
		await sessionVisible(ids.childSessionParent);
		await sessionVisible(ids.delegateChildSession);
		await sessionHidden(ids.firstClassChildSession);
		expect(localStorage.getItem(key)).toBe(before);

		await setFilters({ showArchived: true });
		await setSearch("ArchivedDelegateChildNeedle");
		expect(count(`[data-nav-id="${ids.collapsedParentGoal}"]`)).toBeGreaterThan(0);
		await sessionVisible(ids.childSessionParent);
		await sessionVisible(ids.archivedDelegateChildSession);
		await sessionHidden(ids.firstClassChildSession);
		expect(localStorage.getItem(key)).toBe(before);

		await setSearch("");
		await sessionHidden(ids.firstClassChildSession);
		await sessionHidden(ids.delegateChildSession);
		await sessionHidden(ids.archivedDelegateChildSession);
	});

	it("Show Read and Show Busy filters hide rows while search bypasses the filters", async () => {
		await resetFixture();
		const ids = IDS;
		await sessionVisible(ids.readSession);
		await sessionVisible(ids.activeSession);
		await sessionVisible(ids.busySession);
		await sessionVisible(ids.goalReadSession);

		await setFilters({ showRead: false });
		await sessionHidden(ids.readSession);
		await sessionVisible(ids.activeSession);
		await sessionHidden(ids.goalReadSession);
		expect(count(`[data-nav-id="${ids.goal}"]`)).toBeGreaterThan(0);

		await setSearch("ReadStandaloneAlpha");
		await sessionVisible(ids.readSession);
		await setSearch("GoalChildReadCharlie");
		expect(count(`[data-nav-id="${ids.goal}"]`)).toBeGreaterThan(0);
		await sessionVisible(ids.goalReadSession);
		await setSearch("");
		await sessionHidden(ids.goalReadSession);

		await setFilters({ showRead: true, showBusy: false });
		await sessionHidden(ids.busySession);
		await sessionVisible(ids.readSession);
		await setSearch("BusyStandaloneBravo");
		await sessionVisible(ids.busySession);
		await setSearch("");
		await sessionHidden(ids.busySession);
	});
});
