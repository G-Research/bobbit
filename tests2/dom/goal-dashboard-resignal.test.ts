import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/ui/components/GitStatusWidget.js";
import type { GateState } from "../../src/app/api.js";
import type { Goal } from "../../src/app/state.js";

type StateModule = typeof import("../../src/app/state.js");
type DashboardModule = typeof import("../../src/app/goal-dashboard.js");

const GOAL_ID = "11111111-2222-4333-8444-555555555555";
const GATE_ID = "implementation";
const NOW = 1_750_000_000_000;

let state!: StateModule["state"];
let setRenderApp!: StateModule["setRenderApp"];
let clearDashboardState!: DashboardModule["clearDashboardState"];
let loadDashboardData!: DashboardModule["loadDashboardData"];
let renderGoalDashboard!: DashboardModule["renderGoalDashboard"];
let host!: HTMLElement;
let gates: GateState[] = [];

class MockWebSocket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = MockWebSocket.OPEN;
	send = vi.fn();
	close = vi.fn(() => { this.readyState = MockWebSocket.CLOSED; });
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeGoal(): Goal {
	return {
		id: GOAL_ID,
		title: "Re-signal visibility",
		cwd: "/repo",
		projectId: "project-1",
		state: "in-progress",
		spec: "Ensure historical cancelled signals cannot re-signal a newer generation.",
		createdAt: NOW - 60_000,
		updatedAt: NOW,
		setupStatus: "ready",
		workflow: {
			id: "workflow-1",
			name: "Workflow",
			description: "",
			gates: [{ id: GATE_ID, name: "Implementation", dependsOn: [] }],
		},
	};
}

function makeGate(signals: GateState["signals"]): GateState {
	return { gateId: GATE_ID, goalId: GOAL_ID, status: "pending", signals, updatedAt: NOW };
}

function cancelledSignal(id: string) {
	return {
		id,
		gateId: GATE_ID,
		goalId: GOAL_ID,
		sessionId: "session-1",
		timestamp: NOW - 1_000,
		commitSha: "abcdef0123456789",
		verification: {
			status: "cancelled" as const,
			cancellation: { cause: "goal-pause" as const, requestedAt: NOW - 500 },
			steps: [],
		},
	};
}

function runningSignal(id: string) {
	return {
		id,
		gateId: GATE_ID,
		goalId: GOAL_ID,
		sessionId: "session-2",
		timestamp: NOW,
		commitSha: "fedcba9876543210",
		verification: { status: "running" as const, steps: [] },
	};
}

function installFetchStub(goal: Goal): void {
	const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
		const url = new URL(rawUrl, window.location.origin);
		const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
		if (method !== "GET") return Promise.resolve(jsonResponse({ ok: true }));
		if (url.pathname === `/api/goals/${GOAL_ID}`) return Promise.resolve(jsonResponse(goal));
		if (url.pathname === `/api/goals/${GOAL_ID}/tasks`) return Promise.resolve(jsonResponse({ tasks: [] }));
		if (url.pathname === `/api/goals/${GOAL_ID}/commits`) return Promise.resolve(jsonResponse({ commits: [] }));
		if (url.pathname === `/api/goals/${GOAL_ID}/gates` && url.searchParams.get("view") === "summary") {
			return Promise.resolve(jsonResponse({
				passed: 0,
				total: 1,
				gates: gates.map(gate => ({
					gateId: gate.gateId,
					status: gate.status,
					effectiveStatus: gate.signals.some(signal => signal.verification.status === "running") ? "running" : gate.status,
					running: gate.signals.some(signal => signal.verification.status === "running"),
					signalCount: gate.signals.length,
					dependsOn: [],
				})),
			}));
		}
		if (url.pathname === `/api/goals/${GOAL_ID}/gates`) return Promise.resolve(jsonResponse({ gates }));
		if (url.pathname === `/api/goals/${GOAL_ID}/git-status`) return Promise.resolve(jsonResponse({ error: "Not a git repository" }, 400));
		if (url.pathname === `/api/goals/${GOAL_ID}/cost`) return Promise.resolve(jsonResponse({ totalCost: 0 }));
		if (url.pathname === `/api/goals/${GOAL_ID}/pr-status`) return Promise.resolve(new Response(null, { status: 204 }));
		if (url.pathname === `/api/goals/${GOAL_ID}/team`) return Promise.resolve(jsonResponse({}));
		if (url.pathname === `/api/goals/${GOAL_ID}/team/agents`) return Promise.resolve(jsonResponse({ agents: [] }));
		if (url.pathname === `/api/goals/${GOAL_ID}/tree-cost`) return Promise.resolve(jsonResponse({ totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0, breakdown: [] }));
		if (url.pathname === `/api/goals/${GOAL_ID}/descendants`) return Promise.resolve(jsonResponse({ goals: [] }));
		if (url.pathname === `/api/goals/${GOAL_ID}/pending-mutations`) return Promise.resolve(jsonResponse({ pending: [] }));
		if (url.pathname === `/api/goals/${GOAL_ID}/verifications/active`) return Promise.resolve(jsonResponse({ verifications: [] }));
		if (url.pathname === "/api/sessions") return Promise.resolve(jsonResponse({ sessions: [], generation: 1 }));
		return Promise.resolve(jsonResponse({}));
	});
	vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
	(window as any).fetch = fetchMock;
}

async function nextFrame(): Promise<void> {
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	await Promise.resolve();
}

async function renderGateHistory(): Promise<void> {
	window.location.hash = `#/goal/${GOAL_ID}?tab=gates&gate=${GATE_ID}`;
	setRenderApp(() => render(renderGoalDashboard(), host));
	await loadDashboardData(GOAL_ID);
	for (let i = 0; i < 30 && !host.querySelector("[data-testid='goal-dashboard-gate-detail']"); i++) await nextFrame();
	expect(host.querySelector("[data-testid='goal-dashboard-gate-detail']")).toBeTruthy();
}

beforeEach(async () => {
	document.body.innerHTML = '<div id="host"></div>';
	host = document.getElementById("host")!;
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const stateMod = await import("../../src/app/state.js");
	const dashboardMod = await import("../../src/app/goal-dashboard.js");
	state = stateMod.state;
	setRenderApp = stateMod.setRenderApp;
	clearDashboardState = dashboardMod.clearDashboardState;
	loadDashboardData = dashboardMod.loadDashboardData;
	renderGoalDashboard = dashboardMod.renderGoalDashboard;
	clearDashboardState();
	state.goals = [makeGoal()];
	state.projects = [{ id: "project-1", name: "Project", rootPath: "/repo", colorLight: "#fff", colorDark: "#000" }];
	state.activeProjectId = "project-1";
	state.remoteAgent = null;
	state.chatPanel = null;
	state.selectedSessionId = null;
	state.connectingSessionId = null;
	state.appView = "authenticated";
	state.connectionStatus = "connected" as any;
	state.gateStatusCache.clear();
	state.prStatusCache.clear();
	installFetchStub(state.goals[0]);
});

afterEach(async () => {
	setRenderApp?.(() => {});
	clearDashboardState?.();
	await nextFrame();
	if (host) render(null, host);
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Goal dashboard re-signal action", () => {
	it("hides the action for a cancelled historical signal when a newer run exists", async () => {
		gates = [makeGate([cancelledSignal("cancelled-1"), runningSignal("running-2")])];
		await renderGateHistory();

		expect(host.querySelector("[data-signal-id='cancelled-1'] [data-testid='goal-dashboard-signal-cancellation']")?.textContent).toContain("Goal paused");
		expect(host.querySelectorAll("[data-testid='goal-dashboard-resignal']")).toHaveLength(0);
	});

	it("keeps the action for the latest cancelled signal on a pending gate", async () => {
		gates = [makeGate([cancelledSignal("cancelled-1")])];
		await renderGateHistory();

		expect(host.querySelector("[data-signal-id='cancelled-1'] [data-testid='goal-dashboard-signal-cancellation']")?.textContent).toContain("Goal paused");
		expect(host.querySelectorAll("[data-testid='goal-dashboard-resignal']")).toHaveLength(1);
	});
});
