import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/ui/components/GitStatusWidget.js";
import type { GatewaySession, Goal } from "../../src/app/state.js";
import type { TeamAgent } from "../../src/app/goal-dashboard.js";

type StateModule = typeof import("../../src/app/state.js");
type DashboardModule = typeof import("../../src/app/goal-dashboard.js");

const NOW = 1_750_000_000_000;
const GOAL_ID = "11111111-2222-4333-8444-555555555555";

let state!: StateModule["state"];
let setRenderApp!: StateModule["setRenderApp"];
let clearDashboardState!: DashboardModule["clearDashboardState"];
let loadDashboardData!: DashboardModule["loadDashboardData"];
let renderGoalDashboard!: DashboardModule["renderGoalDashboard"];
let host!: HTMLElement;
let goal!: Goal;
let liveSessions: GatewaySession[] = [];
let archivedSessions: GatewaySession[] = [];
let teamAgents: TeamAgent[] = [];

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
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function makeGoal(): Goal {
	return {
		id: GOAL_ID,
		title: "Agent dedupe regression",
		cwd: "/repo",
		projectId: "project-1",
		state: "in-progress",
		spec: "Render each team session once.",
		createdAt: NOW - 60_000,
		updatedAt: NOW,
		setupStatus: "ready",
		team: true,
	};
}

function makeLead(id: string, overrides: Partial<GatewaySession> = {}): GatewaySession {
	return {
		id,
		title: `Lead ${id}`,
		cwd: "/repo",
		projectId: "project-1",
		status: "idle",
		createdAt: NOW - 12 * 60_000,
		lastActivity: NOW,
		clientCount: 1,
		goalId: GOAL_ID,
		teamGoalId: GOAL_ID,
		role: "team-lead",
		...overrides,
	};
}

function makeAgent(sessionId: string, role: string, overrides: Partial<TeamAgent> = {}): TeamAgent {
	return {
		sessionId,
		role,
		status: "idle",
		worktreePath: `/repo/${sessionId}`,
		branch: `agent/${sessionId}`,
		task: `${role} work`,
		createdAt: NOW - 10 * 60_000,
		...overrides,
	};
}

function installFetchStub(): void {
	const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
		const url = new URL(rawUrl, window.location.origin);
		const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
		if (method !== "GET") return Promise.resolve(jsonResponse({ ok: true }));

		if (url.pathname === `/api/goals/${GOAL_ID}`) return Promise.resolve(jsonResponse(goal));
		if (url.pathname === `/api/goals/${GOAL_ID}/tasks`) return Promise.resolve(jsonResponse({ tasks: [] }));
		if (url.pathname === `/api/goals/${GOAL_ID}/commits`) return Promise.resolve(jsonResponse({ commits: [] }));
		if (url.pathname === `/api/goals/${GOAL_ID}/gates`) return Promise.resolve(jsonResponse({ gates: [] }));
		if (url.pathname === `/api/goals/${GOAL_ID}/git-status`) return Promise.resolve(jsonResponse({ error: "Not a git repository" }, 400));
		if (url.pathname === `/api/goals/${GOAL_ID}/cost`) return Promise.resolve(jsonResponse({ totalCost: 0 }));
		if (url.pathname === `/api/goals/${GOAL_ID}/pr-status`) return Promise.resolve(new Response(null, { status: 204 }));
		if (url.pathname === `/api/goals/${GOAL_ID}/team`) return Promise.resolve(jsonResponse({ teamLeadSessionId: liveSessions[0]?.id ?? archivedSessions[0]?.id }));
		if (url.pathname === `/api/goals/${GOAL_ID}/team/agents`) return Promise.resolve(jsonResponse({ agents: teamAgents }));
		if (url.pathname === `/api/goals/${GOAL_ID}/tree-cost`) return Promise.resolve(jsonResponse({ totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0, breakdown: [] }));
		if (url.pathname === `/api/goals/${GOAL_ID}/descendants`) return Promise.resolve(jsonResponse({ goals: [] }));
		if (url.pathname === `/api/goals/${GOAL_ID}/pending-mutations`) return Promise.resolve(jsonResponse({ pending: [] }));
		if (url.pathname === `/api/goals/${GOAL_ID}/verifications/active`) return Promise.resolve(jsonResponse({ verifications: [] }));
		if (url.pathname === "/api/sessions" && url.searchParams.get("include") === "archived") {
			return Promise.resolve(jsonResponse({ sessions: archivedSessions, total: archivedSessions.length, hasMore: false }));
		}
		if (url.pathname === "/api/sessions") return Promise.resolve(jsonResponse({ sessions: liveSessions, generation: 1 }));
		return Promise.resolve(jsonResponse({}));
	});
	vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
	(window as any).fetch = fetchMock;
}

async function nextFrame(): Promise<void> {
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	await Promise.resolve();
}

async function waitForAgentView(expectedCount: number): Promise<HTMLElement[]> {
	for (let i = 0; i < 30; i++) {
		const cards = [...host.querySelectorAll<HTMLElement>(".agent-card")];
		const badge = host.querySelector<HTMLElement>("[data-testid='tab-agents'] .tab-count");
		if (cards.length === expectedCount && badge?.textContent?.trim() === String(expectedCount)) return cards;
		await nextFrame();
	}
	const actualCards = host.querySelectorAll(".agent-card").length;
	const actualBadge = host.querySelector("[data-testid='tab-agents'] .tab-count")?.textContent?.trim();
	throw new Error(`Timed out waiting for ${expectedCount} cards/badge; found ${actualCards}/${actualBadge}`);
}

async function renderAgentsDashboard(expectedCount: number): Promise<HTMLElement[]> {
	state.gatewaySessions = liveSessions;
	state.archivedSessions = archivedSessions;
	window.location.hash = `#/goal/${GOAL_ID}?tab=agents`;
	setRenderApp(() => render(renderGoalDashboard(), host));
	await loadDashboardData(GOAL_ID);
	return waitForAgentView(expectedCount);
}

beforeEach(async () => {
	document.body.innerHTML = '<div id="host"></div>';
	host = document.getElementById("host")!;
	goal = makeGoal();
	liveSessions = [];
	archivedSessions = [];
	teamAgents = [];
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	const canvasContext = new Proxy({}, { get: () => () => {}, set: () => true });
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(canvasContext as CanvasRenderingContext2D);
	vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,c3RhdGlj");
	vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
	vi.spyOn(console, "warn").mockImplementation(() => {});

	const stateMod = await import("../../src/app/state.js");
	const dashboardMod = await import("../../src/app/goal-dashboard.js");
	state = stateMod.state;
	setRenderApp = stateMod.setRenderApp;
	clearDashboardState = dashboardMod.clearDashboardState;
	loadDashboardData = dashboardMod.loadDashboardData;
	renderGoalDashboard = dashboardMod.renderGoalDashboard;
	installFetchStub();
	clearDashboardState();
	state.goals = [goal];
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

describe("Goal dashboard Agents-tab reconciliation", () => {
	it("renders an archived lead once when session state and the agents response overlap", async () => {
		archivedSessions = [makeLead("archived-lead", {
			status: "archived",
			archived: true,
			archivedAt: NOW - 60_000,
		})];
		teamAgents = [makeAgent("archived-lead", "team-lead", {
			status: "archived",
			archivedAt: NOW - 60_000,
			title: "Archived Team Lead",
		})];

		const cards = await renderAgentsDashboard(1);

		expect(cards).toHaveLength(1);
		expect(cards[0].textContent).toContain("Archived Team Lead");
		expect(cards[0].textContent).toContain("Dismissed");
	});

	it("adds a live lead fallback when the agents response omits it", async () => {
		liveSessions = [makeLead("live-lead", { title: "Current Team Lead" })];

		const cards = await renderAgentsDashboard(1);

		expect(cards[0].textContent).toContain("Current Team Lead");
		expect(cards[0].classList.contains("opacity-70")).toBe(false);
	});

	it("prefers a live lead during live and archived lifecycle overlap", async () => {
		liveSessions = [makeLead("overlap-lead", { title: "Live Team Lead", status: "streaming" })];
		archivedSessions = [makeLead("overlap-lead", {
			title: "Stale Archived Lead",
			status: "archived",
			archived: true,
			archivedAt: NOW - 60_000,
		})];
		teamAgents = [makeAgent("overlap-lead", "team-lead", {
			status: "archived",
			archivedAt: NOW - 60_000,
			task: "Preserved response task",
		})];

		const cards = await renderAgentsDashboard(1);

		expect(cards[0].classList.contains("opacity-70")).toBe(false);
		expect(cards[0].textContent).toContain("Live Team Lead");
		expect(cards[0].textContent).toContain("Preserved response task");
		expect(cards[0].textContent).not.toContain("Dismissed");
	});

	it("keeps regular agents alongside the reconciled lead", async () => {
		liveSessions = [makeLead("live-lead")];
		teamAgents = [makeAgent("coder-session", "coder", { title: "Coder Agent" })];

		const cards = await renderAgentsDashboard(2);

		expect(cards.map(card => card.textContent)).toEqual([
		expect.stringContaining("Lead live-lead"),
		expect.stringContaining("CODER"),
		]);
	});

	it("preserves distinct historical team leads with different session IDs", async () => {
		archivedSessions = [makeLead("historical-lead-1", {
			status: "archived",
			archived: true,
			archivedAt: NOW - 60_000,
		})];
		teamAgents = [
			makeAgent("historical-lead-1", "team-lead", {
				status: "archived",
				archivedAt: NOW - 60_000,
				title: "Historical Lead One",
			}),
			makeAgent("historical-lead-2", "team-lead", {
				status: "archived",
				archivedAt: NOW - 120_000,
				title: "Historical Lead Two",
			}),
		];

		const cards = await renderAgentsDashboard(2);
		const text = cards.map(card => card.textContent).join(" ");

		expect(text).toContain("Historical Lead One");
		expect(text).toContain("Historical Lead Two");
	});
});
