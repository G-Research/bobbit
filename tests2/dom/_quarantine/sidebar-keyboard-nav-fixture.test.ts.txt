import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/sidebar-keyboard-nav-fixture.spec.ts (v2-dom tier).
// Renders the REAL renderSidebar() + drives the REAL navigateSidebar() /
// expandActiveSidebarItem() keyboard navigation under happy-dom (was an esbuild
// file:// bundle). Navigation reads DOM order via querySelectorAll([data-nav-id])
// — no geometry — so it ports faithfully. fetch/WebSocket are stubbed; session
// navigation's fire-and-forget connectToSession() workspace hydration is served
// a valid /side-panel-workspace body so it never rejects post-test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { renderSidebar, isProjectExpanded, toggleProjectExpanded } from "../../../src/app/sidebar.js";
import { navigateSidebar, expandActiveSidebarItem, installKeyboardNavOverrideClearListener } from "../../../src/app/sidebar-nav.js";
import {
	expandedGoals, saveExpandedGoals, setArchivedSectionExpanded, setProjects, setRenderApp,
	setStaffSectionExpanded, setUngroupedExpanded, state,
	type GatewaySession, type Goal, type Project,
} from "../../../src/app/state.js";

const PROJECT_ID = "sidebar-nav-fixture-project";
const LIVE_GOAL_ID = "11111111-1111-4111-8111-111111111111";
const ARCHIVED_GOAL_ID = "22222222-2222-4222-8222-222222222222";
const GOAL_SESSION_ID = "sidebar-nav-fixture-goal-session";
const LIVE_SESSION_ID = "sidebar-nav-fixture-live-session";

const PROJECT: Project = { id: PROJECT_ID, name: "Sidebar Keyboard Fixture", rootPath: "/tmp/sidebar-keyboard-fixture", colorLight: "#2563eb", colorDark: "#60a5fa" };
const LIVE_GOAL: Goal = { id: LIVE_GOAL_ID, title: "Keyboard Fixture Live Goal", cwd: PROJECT.rootPath, projectId: PROJECT_ID, state: "in-progress", spec: "Live goal.", createdAt: 1, updatedAt: 1, setupStatus: "ready" };
const ARCHIVED_GOAL: Goal = { id: ARCHIVED_GOAL_ID, title: "Keyboard Fixture Archived Goal", cwd: PROJECT.rootPath, projectId: PROJECT_ID, state: "complete", spec: "Archived goal.", createdAt: 2, updatedAt: 2, setupStatus: "ready", archived: true, archivedAt: 3 };
const GOAL_SESSION: GatewaySession = { id: GOAL_SESSION_ID, title: "Keyboard Fixture Goal Session", cwd: PROJECT.rootPath, projectId: PROJECT_ID, goalId: LIVE_GOAL_ID, status: "idle", createdAt: 4, lastActivity: 4, clientCount: 0 };
const LIVE_SESSION: GatewaySession = { id: LIVE_SESSION_ID, title: "Keyboard Fixture Ungrouped Session", cwd: PROJECT.rootPath, projectId: PROJECT_ID, status: "idle", createdAt: 5, lastActivity: 5, clientCount: 0 };

interface FixtureIds { project: string; liveGoal: string; goalSession: string; ungroupedHeader: string; liveSession: string; staffHeader: string; archivedHeader: string; archivedGoal: string; }
const IDS: FixtureIds = {
	project: `project:${PROJECT_ID}`,
	liveGoal: `goal:${LIVE_GOAL_ID}`,
	goalSession: `session:${GOAL_SESSION_ID}`,
	ungroupedHeader: `ungrouped-header:${PROJECT_ID}`,
	liveSession: `session:${LIVE_SESSION_ID}`,
	staffHeader: `staff-header:${PROJECT_ID}`,
	archivedHeader: `archived-header:${PROJECT_ID}`,
	archivedGoal: `goal:${ARCHIVED_GOAL_ID}`,
};

class FixtureWebSocket {
	static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
	readyState = FixtureWebSocket.OPEN;
	addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void { this.readyState = FixtureWebSocket.CLOSED; }
}

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function requestPath(input: any): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try { const u = new URL(raw, window.location.href); return `${u.pathname}${u.search}`; } catch { return raw; }
}
const SESSION_BY_ID = new Map<string, GatewaySession>([[GOAL_SESSION_ID, GOAL_SESSION], [LIVE_SESSION_ID, LIVE_SESSION]]);

function installFetch(): void {
	vi.stubGlobal("fetch", async (input: any) => {
		const url = requestPath(input);
		if (url.includes("/side-panel-workspace")) return response({ version: 1, tabs: [], activeTabId: "", sizeMode: "split" });
		if (url.startsWith("/api/goals?") && url.includes("archived=true")) return response({ goals: [{ ...ARCHIVED_GOAL }], total: 1, hasMore: false, nextCursor: null, archivedSessions: [] });
		if (url.startsWith("/api/sessions/")) {
			const id = url.split("/")[3]?.split("?")[0];
			const s = id ? SESSION_BY_ID.get(id) : undefined;
			return s ? response({ ...s }) : response({ error: "not found" }, 404);
		}
		if (url.startsWith("/api/sessions?")) return response({ sessions: [{ ...GOAL_SESSION }, { ...LIVE_SESSION }], archivedDelegates: [], total: 2, hasMore: false, nextCursor: null });
		if (url.startsWith("/api/roles")) return response([]);
		if (url === "/api/staff" || url.startsWith("/api/staff?") || url === "/api/staff/orphaned") return response({ staff: [] });
		if (url === "/api/projects") return response({ projects: [{ ...PROJECT }] });
		if (url === "/api/preferences") return response({});
		if (url.startsWith("/api/sandbox-status")) return response({ available: false, configured: false });
		return response({ ok: true });
	});
}

function renderFixture(): void {
	render(renderSidebar(), document.getElementById("app")!);
}

let keyboardInstalled = false;
function installKeyboardDriver(): void {
	if (keyboardInstalled) return;
	keyboardInstalled = true;
	installKeyboardNavOverrideClearListener();
	window.addEventListener("keydown", (event) => {
		if (!(event.ctrlKey || event.metaKey)) return;
		if (event.key === "ArrowDown") { event.preventDefault(); navigateSidebar("down"); }
		else if (event.key === "ArrowUp") { event.preventDefault(); navigateSidebar("up"); }
		else if (event.key === "ArrowRight") { event.preventDefault(); expandActiveSidebarItem(true); }
		else if (event.key === "ArrowLeft") { event.preventDefault(); expandActiveSidebarItem(false); }
	});
}

// The sidebar renders decorative bobbit-avatar pixel sprites via canvas 2D +
// toDataURL (bobbit-render.ts) which happy-dom lacks. The avatars are NOT under
// test here — nav order is pure DOM order — so shim a no-op 2D context/toDataURL
// (same spirit as the fetch/WebSocket shims) to let the sidebar mount.
let _origGetContext: any; let _origToDataURL: any;
function stubCanvas(): void {
	const ctx: any = {
		imageSmoothingEnabled: false, fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1, font: "",
		fillRect() {}, clearRect() {}, strokeRect() {}, fillText() {}, strokeText() {},
		beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, stroke() {}, clip() {},
		save() {}, restore() {}, translate() {}, scale() {}, rotate() {}, setTransform() {}, transform() {},
		drawImage() {}, putImageData() {}, setLineDash() {}, getLineDash: () => [],
		createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
		getImageData: (_x = 0, _y = 0, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
		createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
		measureText: () => ({ width: 0 }),
	};
	_origGetContext = (HTMLCanvasElement.prototype as any).getContext;
	_origToDataURL = (HTMLCanvasElement.prototype as any).toDataURL;
	(HTMLCanvasElement.prototype as any).getContext = () => ctx;
	(HTMLCanvasElement.prototype as any).toDataURL = () => "data:image/png;base64,";
}
function restoreCanvas(): void {
	if (_origGetContext) (HTMLCanvasElement.prototype as any).getContext = _origGetContext;
	if (_origToDataURL) (HTMLCanvasElement.prototype as any).toDataURL = _origToDataURL;
}

const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0));

async function resetFixture(options?: { showArchived?: boolean }): Promise<void> {
	installKeyboardDriver();
	const showArchived = options?.showArchived === true;
	localStorage.setItem("bobbit-show-archived", showArchived ? "true" : "false");
	localStorage.setItem("bobbit-show-busy", "true");
	localStorage.setItem("bobbit-show-read", "true");
	setProjects([{ ...PROJECT }]);
	expandedGoals.clear();
	expandedGoals.add(LIVE_GOAL_ID);
	saveExpandedGoals();
	setArchivedSectionExpanded(PROJECT_ID, true);
	setUngroupedExpanded(PROJECT_ID, true);
	setStaffSectionExpanded(PROJECT_ID, true);
	if (!isProjectExpanded(PROJECT_ID)) toggleProjectExpanded(PROJECT_ID);
	Object.assign(state, {
		appView: "authenticated", connectionStatus: "connected",
		gatewaySessions: [{ ...GOAL_SESSION }, { ...LIVE_SESSION }] as GatewaySession[],
		archivedSessions: [] as GatewaySession[],
		goals: [{ ...LIVE_GOAL }, { ...ARCHIVED_GOAL }],
		selectedSessionId: null, connectingSessionId: null, keyboardNavActiveId: null, goalDashboardId: null,
		activeProjectId: PROJECT_ID, sidebarCollapsed: false, showArchived, showBusy: true, showRead: true,
		filtersPopoverOpen: false, searchQuery: "", sessionsLoading: false, sessionsError: "",
		creatingSession: false, creatingSessionForGoalId: null, staffList: [], orphanedStaff: [],
		archivedGoalsCursor: null, archivedGoalsHasMore: false, archivedGoalsTotal: 1,
		archivedSessionsCursor: null, archivedSessionsHasMore: false, archivedSessionsTotal: 0,
	});
	window.history.replaceState({}, "", "#/");
	renderFixture();
	await nextFrame();
}

// ── Snapshot / polling helpers (ported from the Playwright page.evaluate glue) ──
interface ActiveNavSnapshot { id: string | null; activeIds: string[]; fallbackIds: string[]; hash: string; selectedSessionId: string | null; }
function activeNavSnapshot(): ActiveNavSnapshot {
	const idsFor = (selector: string) => Array.from(document.querySelectorAll(selector)).map((el) => el.getAttribute("data-nav-id")).filter((id): id is string => !!id);
	const activeIds = idsFor("[data-nav-id][data-nav-active='true']");
	const fallbackIds = idsFor("[data-nav-id].sidebar-session-active, [data-nav-id].sidebar-active, [data-nav-id][data-active='true']");
	return { id: activeIds[0] ?? fallbackIds[0] ?? null, activeIds, fallbackIds, hash: window.location.hash, selectedSessionId: state.selectedSessionId ?? null };
}
const activeNavId = () => activeNavSnapshot().id;

function navIdsInDomOrder(): string[] {
	const sidebar = document.querySelector(".sidebar-edge");
	if (!sidebar) return [];
	const out: string[] = []; const seen = new Set<string>();
	for (const el of sidebar.querySelectorAll("[data-nav-id]")) {
		const id = el.getAttribute("data-nav-id");
		if (id && !seen.has(id)) { seen.add(id); out.push(id); }
	}
	return out;
}
const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

async function waitForStableNavOrder(requiredIds: string[] = [], absentIds: string[] = []): Promise<string[]> {
	const deadline = Date.now() + 10_000;
	let previous: string[] | null = null; let stableFrames = 0; let latest: string[] = [];
	while (Date.now() < deadline) {
		await nextFrame();
		latest = navIdsInDomOrder();
		const ok = requiredIds.every((id) => latest.includes(id)) && absentIds.every((id) => !latest.includes(id));
		if (latest.length > 0 && ok && previous && sameOrder(latest, previous)) { if (++stableFrames >= 2) return latest; }
		else stableFrames = 0;
		previous = latest;
	}
	throw new Error(`nav order did not stabilize; latest=${JSON.stringify(latest)}`);
}

async function waitForActiveNavId(expected: string | null): Promise<void> {
	const deadline = Date.now() + 5_000; let latest: ActiveNavSnapshot | null = null;
	while (Date.now() < deadline) {
		await nextFrame();
		latest = activeNavSnapshot();
		if (latest.activeIds.length <= 1 && latest.id === expected) return;
	}
	throw new Error(`expected active nav ${JSON.stringify(expected)}; latest=${JSON.stringify(latest)}`);
}

async function resetNavStart(): Promise<void> {
	window.history.replaceState({}, "", "#/");
	Object.assign(state, { keyboardNavActiveId: null, selectedSessionId: null, goalDashboardId: null, connectingSessionId: null, remoteAgent: null });
	renderFixture();
	await waitForActiveNavId(null);
}

async function clearKeyboardOverrideAndRender(): Promise<void> {
	state.keyboardNavActiveId = null;
	renderFixture();
	await nextFrame();
}

async function setShowArchived(showArchived: boolean): Promise<void> {
	localStorage.setItem("bobbit-show-archived", showArchived ? "true" : "false");
	state.showArchived = showArchived;
	renderFixture();
	await nextFrame();
}

function pressCtrlArrow(key: "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight"): void {
	window.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
}

async function walk(key: "ArrowDown" | "ArrowUp", steps: number, expectedOrder: string[]): Promise<Array<string | null>> {
	const visited: Array<string | null> = [];
	for (let i = 0; i < steps; i++) {
		pressCtrlArrow(key);
		const expected = key === "ArrowDown"
			? expectedOrder[i % expectedOrder.length]
			: expectedOrder[(expectedOrder.length - 1 - (i % expectedOrder.length) + expectedOrder.length) % expectedOrder.length];
		await waitForActiveNavId(expected);
		visited.push(activeNavId());
	}
	return visited;
}

const visibleOrder = (ids: FixtureIds) => [ids.project, ids.liveGoal, ids.goalSession, ids.ungroupedHeader, ids.liveSession, ids.staffHeader];
const archivedOrder = (ids: FixtureIds) => [...visibleOrder(ids), ids.archivedHeader, ids.archivedGoal];

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
});

describe("Sidebar keyboard navigation lightweight fixture", () => {
	it("Ctrl+Arrow walks visible rows in DOM order, wraps, and marks one active row", async () => {
		await resetFixture();
		const ids = IDS;
		const expected = visibleOrder(ids);
		expect(await waitForStableNavOrder(expected, [ids.archivedHeader, ids.archivedGoal])).toEqual(expected);

		await resetNavStart();
		const visitedDown = await walk("ArrowDown", expected.length + 1, expected);
		expect(visitedDown.slice(0, expected.length)).toEqual(expected);
		expect(visitedDown[expected.length]).toBe(expected[0]);
		expect(activeNavSnapshot().activeIds).toEqual([expected[0]]);

		await resetNavStart();
		const visitedUp = await walk("ArrowUp", expected.length + 1, expected);
		const reverse = [...expected].reverse();
		expect(visitedUp.slice(0, expected.length)).toEqual(reverse);
		expect(visitedUp[expected.length]).toBe(reverse[0]);
		expect(activeNavSnapshot().activeIds).toEqual([reverse[0]]);

		pressCtrlArrow("ArrowDown");
		await waitForActiveNavId(expected[0]);
		expect(activeNavId()).toBe(expected[0]);
	});

	it("Ctrl+ArrowLeft and Ctrl+ArrowRight collapse expandable rows without moving selection", async () => {
		await resetFixture();
		const ids = IDS;
		const expanded = visibleOrder(ids);
		await waitForStableNavOrder(expanded);

		await resetNavStart();
		pressCtrlArrow("ArrowDown");
		await waitForActiveNavId(ids.project);
		pressCtrlArrow("ArrowLeft");
		await waitForActiveNavId(ids.project);
		expect(await waitForStableNavOrder([ids.project], expanded.slice(1))).toEqual([ids.project]);
		pressCtrlArrow("ArrowRight");
		await waitForActiveNavId(ids.project);
		expect(await waitForStableNavOrder(expanded)).toEqual(expanded);

		pressCtrlArrow("ArrowDown");
		await waitForActiveNavId(ids.liveGoal);
		pressCtrlArrow("ArrowLeft");
		await waitForActiveNavId(ids.liveGoal);
		const goalCollapsed = await waitForStableNavOrder(expanded.filter((id) => id !== ids.goalSession), [ids.goalSession]);
		expect(goalCollapsed.includes(ids.goalSession)).toBe(false);
		pressCtrlArrow("ArrowRight");
		await waitForActiveNavId(ids.liveGoal);
		expect(await waitForStableNavOrder(expanded)).toEqual(expanded);
	});

	it("Show Archived deterministically adds archived rows to the keyboard cycle", async () => {
		await resetFixture();
		const ids = IDS;
		const off = visibleOrder(ids);
		const on = archivedOrder(ids);

		expect(await waitForStableNavOrder(off, [ids.archivedHeader, ids.archivedGoal])).toEqual(off);
		await resetNavStart();
		const visitedOff = new Set((await walk("ArrowDown", off.length, off)).filter((id): id is string => !!id));
		expect(visitedOff.has(ids.archivedHeader)).toBe(false);
		expect(visitedOff.has(ids.archivedGoal)).toBe(false);

		await setShowArchived(true);
		expect(await waitForStableNavOrder(on)).toEqual(on);
		await resetNavStart();
		const visitedOn = new Set((await walk("ArrowDown", on.length, on)).filter((id): id is string => !!id));
		expect(visitedOn.has(ids.archivedHeader)).toBe(true);
		expect(visitedOn.has(ids.archivedGoal)).toBe(true);

		await setShowArchived(false);
		expect(await waitForStableNavOrder(off, [ids.archivedHeader, ids.archivedGoal])).toEqual(off);
	});

	it("route-selected project, goal, and session rows persist after rerender", async () => {
		await resetFixture();
		const ids = IDS;
		const order = visibleOrder(ids);
		await waitForStableNavOrder(order);

		await resetNavStart();
		pressCtrlArrow("ArrowDown");
		await waitForActiveNavId(ids.project);
		expect(activeNavSnapshot().hash).toBe("#/settings/sidebar-nav-fixture-project/general");
		await clearKeyboardOverrideAndRender();
		await waitForActiveNavId(ids.project);

		pressCtrlArrow("ArrowDown");
		await waitForActiveNavId(ids.liveGoal);
		expect(activeNavSnapshot().hash).toBe("#/goal/11111111-1111-4111-8111-111111111111");
		await clearKeyboardOverrideAndRender();
		await waitForActiveNavId(ids.liveGoal);

		pressCtrlArrow("ArrowDown");
		await waitForActiveNavId(ids.goalSession);
		const snap = activeNavSnapshot();
		expect(snap.hash).toBe("#/session/sidebar-nav-fixture-goal-session");
		expect(snap.selectedSessionId).toBe("sidebar-nav-fixture-goal-session");
		await clearKeyboardOverrideAndRender();
		await waitForActiveNavId(ids.goalSession);
	});
});
