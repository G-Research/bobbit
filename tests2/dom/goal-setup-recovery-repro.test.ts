import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Load this while happy-dom's custom-elements registry is still available.
import "../../src/ui/components/GitStatusWidget.js";
import type { GatewaySession, Goal } from "../../src/app/state.js";

type StateModule = typeof import("../../src/app/state.js");
type DashboardModule = typeof import("../../src/app/goal-dashboard.js");
type RenderHelpersModule = typeof import("../../src/app/render-helpers.js");

const now = 1_783_682_557_000;
const goalId = "goal-setup-recovery";
let host!: HTMLElement;
let activeGoal!: Goal;
let retryPosts = 0;
let state!: StateModule["state"];
let setRenderApp!: StateModule["setRenderApp"];
let clearDashboardState!: DashboardModule["clearDashboardState"];
let loadDashboardData!: DashboardModule["loadDashboardData"];
let refreshDashboardGoal!: DashboardModule["refreshDashboardGoal"];
let renderGoalDashboard!: DashboardModule["renderGoalDashboard"];
let renderGoalGroup!: RenderHelpersModule["renderGoalGroup"];

class MockWebSocket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = MockWebSocket.OPEN;
	send = vi.fn();
	close = vi.fn(() => { this.readyState = MockWebSocket.CLOSED; });
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function noContent(status = 204): Response {
	return new Response(null, { status });
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: goalId,
		title: "Recover setup status",
		cwd: "/repo/worktree",
		projectId: "project-1",
		state: "todo",
		spec: "Verify setup recovery renders truthfully.",
		createdAt: now,
		updatedAt: now,
		team: true,
		...overrides,
	};
}

function installFetchStub(): void {
	const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
		const url = new URL(raw, window.location.origin);
		const path = `${url.pathname}${url.search}`;
		const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();

		if (method === "POST" && path === `/api/goals/${goalId}/retry-setup`) {
			retryPosts++;
			return Promise.resolve(json({ setupStatus: "retrying" }));
		}
		if (path === `/api/goals/${goalId}`) return Promise.resolve(json(activeGoal));
		if (path === `/api/goals/${goalId}/tasks`) return Promise.resolve(json({ tasks: [] }));
		if (path === `/api/goals/${goalId}/commits?limit=20`) return Promise.resolve(json({ commits: [] }));
		if (path === `/api/goals/${goalId}/gates`) return Promise.resolve(json({ gates: [] }));
		if (path === `/api/goals/${goalId}/git-status?intent=visible`) return Promise.resolve(json({ error: "Not a git repository" }, 400));
		if (path === `/api/goals/${goalId}/cost`) return Promise.resolve(json({ total: 0, sessions: [] }));
		if (path === `/api/goals/${goalId}/tree-cost`) return Promise.resolve(json({ totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0, breakdown: [] }));
		if (path === `/api/goals/${goalId}/pr-status?optional=1`) return Promise.resolve(noContent());
		if (path === `/api/goals/${goalId}/team`) return Promise.resolve(noContent(404));
		if (path === `/api/goals/${goalId}/descendants`) return Promise.resolve(json({ goals: [] }));
		if (path === `/api/goals/${goalId}/pending-mutations`) return Promise.resolve(json({ pending: [] }));
		if (path === `/api/goals/${goalId}/verifications/active`) return Promise.resolve(json({ verifications: [] }));
		if (path === `/api/goals/${goalId}/team/agents?include=archived`) return Promise.resolve(json({ agents: [] }));
		if (path === "/api/sessions" || path === "/api/sessions?since=0") return Promise.resolve(json({ sessions: [], generation: 1 }));
		if (path === "/api/goals" || path === "/api/goals?since=0") return Promise.resolve(json({ goals: state?.goals ?? [], generation: 1 }));
		if (path === "/api/projects") return Promise.resolve(json({ projects: state?.projects ?? [], generation: 1 }));
		if (path.startsWith("/api/sessions/archived") || path.startsWith("/api/goals/archived")) return Promise.resolve(json({ sessions: [], goals: [] }));
		if (path === "/api/staff" || path.startsWith("/api/staff?") || path === "/api/staff/orphaned") return Promise.resolve(json([]));
		if (path === "/api/sandbox/status") return Promise.resolve(json({ available: false }));
		return Promise.resolve(json({}));
	});
	vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
	(window as any).fetch = fetchMock;
}

async function nextFrame(): Promise<void> {
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	await Promise.resolve();
}

async function waitFor<T>(find: () => T | null, label: string): Promise<T> {
	for (let attempt = 0; attempt < 30; attempt++) {
		const found = find();
		if (found) return found;
		await nextFrame();
	}
	throw new Error(`SETUP_RECOVERY_UI_REPRO: timed out waiting for ${label}`);
}

function resetState(): void {
	clearDashboardState();
	state.gatewaySessions = [] as GatewaySession[];
	state.archivedSessions = [] as GatewaySession[];
	state.goals = [] as Goal[];
	state.projects = [{ id: "project-1", name: "Project", rootPath: "/repo", colorLight: "#fff", colorDark: "#000" }];
	state.activeProjectId = "project-1";
	state.remoteAgent = null;
	state.chatPanel = null;
	state.selectedSessionId = null;
	state.connectingSessionId = null;
	state.appView = "authenticated";
	state.connectionStatus = "connected" as any;
	state.sessionsGeneration = -1;
	state.goalsGeneration = -1;
	state.gateStatusCache.clear();
	state.prStatusCache.clear();
}

beforeEach(async () => {
	document.body.innerHTML = `<div id="app"></div><div id="host"></div>`;
	host = document.getElementById("host")!;
	activeGoal = makeGoal({ setupStatus: "error", setupError: "could not lock config file .git/config.lock" });
	retryPosts = 0;
	installFetchStub();
	vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
	vi.spyOn(console, "warn").mockImplementation(() => {});

	const stateModule = await import("../../src/app/state.js");
	const dashboardModule = await import("../../src/app/goal-dashboard.js");
	const renderHelpersModule = await import("../../src/app/render-helpers.js");
	state = stateModule.state;
	setRenderApp = stateModule.setRenderApp;
	clearDashboardState = dashboardModule.clearDashboardState;
	loadDashboardData = dashboardModule.loadDashboardData;
	refreshDashboardGoal = dashboardModule.refreshDashboardGoal;
	renderGoalDashboard = dashboardModule.renderGoalDashboard;
	renderGoalGroup = renderHelpersModule.renderGoalGroup;
	resetState();
});

afterEach(async () => {
	setRenderApp?.(() => {});
	clearDashboardState?.();
	await Promise.resolve();
	if (host) render(null, host);
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function renderDashboardAndSidebar(): Promise<void> {
	state.goals = [{ ...activeGoal }];
	setRenderApp(() => render(
		// Render the dashboard and its real sidebar goal helper from the same state.
		// This is intentionally not a fixture model: refreshDashboardGoal() must
		// invalidate both surfaces after the authoritative live response arrives.
		[renderGoalDashboard(), renderGoalGroup(state.goals[0])],
		host,
	));
	await loadDashboardData(goalId);
	await waitFor(() => host.querySelector("[data-testid='goal-dashboard']"), "dashboard");
	const sidebarGoal = await waitFor(() => host.querySelector<HTMLElement>(`[data-nav-id='goal:${goalId}']`), "sidebar goal");
	sidebarGoal.click();
	await nextFrame();
}

describe("goal setup recovery live UI", () => {
	it("SETUP_RECOVERY_UI_REPRO keeps a current failure actionable, then clears both surfaces and unlocks starts after ready", async () => {
		await renderDashboardAndSidebar();

		const dashboardStart = await waitFor(() => host.querySelector<HTMLButtonElement>(".nav-right button[title='Worktree setup failed']"), "disabled dashboard Start Team control");
		const sidebarStart = await waitFor(() => host.querySelector<HTMLElement>(`[data-nav-id='goal:${goalId}']`)?.parentElement?.querySelector<HTMLButtonElement>("button[title='Worktree setup failed']") ?? null, "disabled sidebar Start Team control");
		expect(host.querySelector(".setup-banner--error")?.textContent).toContain("could not lock config file");
		expect(host.querySelector(".btn-retry")?.textContent).toContain("Retry Setup");
		expect(host.querySelector("span[title='Worktree setup failed']")).toBeTruthy();
		expect(dashboardStart.disabled).toBe(true);
		expect(sidebarStart.disabled, "SETUP_RECOVERY_UI_REPRO: current setup error must disable sidebar Start Team").toBe(true);

		(host.querySelector<HTMLButtonElement>(".btn-retry")!).click();
		const retryingBanner = await waitFor(() => host.querySelector<HTMLElement>(".setup-banner--preparing"), "retrying setup banner");
		expect(retryPosts).toBe(1);
		expect(state.goals[0]).toMatchObject({ setupStatus: "retrying" });
		expect(state.goals[0].setupError).toBeUndefined();
		expect(retryingBanner.getAttribute("data-setup-status")).toBe("retrying");
		expect(host.querySelector<HTMLButtonElement>("button[title='Retrying worktree setup…']")?.disabled).toBe(true);

		// A goal_setup_complete live refresh has no attached agent, but is still
		// authoritative for dashboard and sidebar state.
		activeGoal = makeGoal({ setupStatus: "ready" });
		await refreshDashboardGoal();
		await nextFrame();

		const recoveredDashboardStart = await waitFor(() => host.querySelector<HTMLButtonElement>("button[title='Start the goal team']"), "recovered dashboard Start Team control");
		const recoveredSidebarStart = await waitFor(() => host.querySelector<HTMLButtonElement>("button[title='Start team']"), "recovered sidebar Start Team control");
		expect(state.gatewaySessions).toHaveLength(0);
		expect(state.goals[0]).toMatchObject({ setupStatus: "ready" });
		expect(state.goals[0].setupError).toBeUndefined();
		expect(host.querySelector(".setup-banner--error")).toBeNull();
		expect(host.querySelector(".btn-retry")).toBeNull();
		expect(host.querySelector("span[title='Worktree setup failed']")).toBeNull();
		expect(recoveredDashboardStart.disabled).toBe(false);
		expect(recoveredSidebarStart.disabled).toBe(false);
	});
});
