import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../../tests2/dom/_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/ui/components/GitStatusWidget.js";
import type { GatewaySession, Goal } from "../../../src/app/state.js";
import type { TeamAgent } from "../../../src/app/goal-dashboard.js";

type StateModule = typeof import("../../../src/app/state.js");
type DashboardModule = typeof import("../../../src/app/goal-dashboard.js");

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
		title: "Agent duration regression",
		cwd: "/repo",
		projectId: "project-1",
		state: "in-progress",
		spec: "Verify team lead lifecycle durations on the real dashboard path.",
		createdAt: NOW - 60_000,
		updatedAt: NOW,
		setupStatus: "ready",
		team: true,
	};
}

function makeLead(overrides: Partial<GatewaySession> = {}): GatewaySession {
	return {
		id: "lead-session",
		title: "Team Lead",
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

async function waitForAgentCards(count: number): Promise<HTMLElement[]> {
	for (let i = 0; i < 30; i++) {
		const cards = [...host.querySelectorAll<HTMLElement>(".agent-card")];
		if (cards.length === count) return cards;
		await nextFrame();
	}
	throw new Error(`Timed out waiting for ${count} agent cards`);
}

function cardDuration(card: HTMLElement): string {
	const meta = [...card.querySelectorAll<HTMLElement>(".agent-card-meta-item")];
	return meta.at(-1)?.textContent?.trim() ?? "";
}

function resetSharedState(): void {
	clearDashboardState();
	state.gatewaySessions = liveSessions;
	state.archivedSessions = archivedSessions;
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
}

async function renderAgentsDashboard(): Promise<HTMLElement[]> {
	state.gatewaySessions = liveSessions;
	state.archivedSessions = archivedSessions;
	window.location.hash = `#/goal/${GOAL_ID}?tab=agents`;
	setRenderApp(() => render(renderGoalDashboard(), host));
	await loadDashboardData(GOAL_ID);
	return waitForAgentCards((liveSessions.length + archivedSessions.length > 0 ? 1 : 0) + teamAgents.length);
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

	const stateMod = await import("../../../src/app/state.js");
	const dashboardMod = await import("../../../src/app/goal-dashboard.js");
	state = stateMod.state;
	setRenderApp = stateMod.setRenderApp;
	clearDashboardState = dashboardMod.clearDashboardState;
	loadDashboardData = dashboardMod.loadDashboardData;
	renderGoalDashboard = dashboardMod.renderGoalDashboard;
	installFetchStub();
	resetSharedState();
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

describe("Goal dashboard Agents-tab durations", () => {
	it("derives a live team lead duration from the matching session createdAt", async () => {
		liveSessions = [makeLead({ createdAt: NOW - 12 * 60_000 })];
		const [leadCard] = await renderAgentsDashboard();

		expect(cardDuration(leadCard), "LEAD_UPTIME_EPOCH_REGRESSION: live lead must use session.createdAt").toBe("12m");
	});

	it("freezes an archived team lead duration at its session archivedAt", async () => {
		archivedSessions = [makeLead({
			status: "archived",
			archived: true,
			createdAt: NOW - 3 * 60 * 60_000,
			archivedAt: NOW - 2 * 60 * 60_000,
		})];
		const [leadCard] = await renderAgentsDashboard();

		expect(cardDuration(leadCard), "LEAD_UPTIME_ARCHIVE_REGRESSION: archived lead must stop at session.archivedAt").toBe("1h 0m");
	});

	it.each([
		["missing", undefined],
		["zero", 0],
		["non-finite", Number.NaN],
		["future", NOW + 24 * 60 * 60_000],
	])("keeps an archived team lead at zero age when archivedAt is %s", async (_case, archivedAt) => {
		archivedSessions = [makeLead({
			status: "archived",
			archived: true,
			createdAt: NOW - 40 * 60_000,
			archivedAt: archivedAt as number,
		})];
		let [leadCard] = await renderAgentsDashboard();
		const durations = [cardDuration(leadCard)];

		vi.mocked(Date.now).mockReturnValue(NOW + 25 * 60_000);
		render(renderGoalDashboard(), host);
		await nextFrame();
		[leadCard] = await waitForAgentCards(1);
		durations.push(cardDuration(leadCard));

		expect(
			durations,
			"LEAD_UPTIME_INVALID_ARCHIVE_END: archived leads without a valid end time must not keep aging",
		).toEqual(["0m", "0m"]);
	});

	it.each([
		["missing", undefined],
		["non-finite", Number.NaN],
		["future", NOW + 5 * 60_000],
	])("uses a non-negative zero-age fallback for a %s lead createdAt", async (_case, createdAt) => {
		liveSessions = [makeLead({ createdAt: createdAt as number })];
		const [leadCard] = await renderAgentsDashboard();
		const duration = cardDuration(leadCard);

		expect(duration, "LEAD_UPTIME_INVALID_LIFECYCLE: invalid lead timestamps must not produce epoch or negative durations").toBe("0m");
		expect(duration).not.toMatch(/^-|NaN|Infinity|\d{5,}h/);
	});

	it("keeps the current-time fallback for a regular archived agent with zero archivedAt", async () => {
		teamAgents = [{
			sessionId: "archived-coder",
			role: "coder",
			status: "archived",
			worktreePath: "/repo/coder",
			branch: "agent/coder",
			task: "Archived work",
			createdAt: NOW - 40 * 60_000,
			archivedAt: 0,
		}];
		let [agentCard] = await renderAgentsDashboard();

		expect(cardDuration(agentCard)).toBe("40m");

		vi.mocked(Date.now).mockReturnValue(NOW + 25 * 60_000);
		render(renderGoalDashboard(), host);
		await nextFrame();
		[agentCard] = await waitForAgentCards(1);

		expect(cardDuration(agentCard)).toBe("1h 5m");
	});

	it("preserves live and archived duration behavior for regular team agents", async () => {
		teamAgents = [
			{
				sessionId: "live-coder",
				role: "coder",
				status: "idle",
				worktreePath: "/repo/live",
				branch: "agent/live",
				task: "Live work",
				createdAt: NOW - 70 * 60_000,
			},
			{
				sessionId: "archived-reviewer",
				role: "reviewer",
				status: "archived",
				worktreePath: "/repo/reviewer",
				branch: "agent/reviewer",
				task: "Review work",
				createdAt: NOW - 3 * 60 * 60_000,
				archivedAt: NOW - 75 * 60_000,
				title: "Archived Reviewer",
			},
		];
		const cards = await renderAgentsDashboard();
		const live = cards.find((card) => card.textContent?.includes("CODER"));
		const archived = cards.find((card) => card.textContent?.includes("REVIEWER"));

		expect(live).toBeTruthy();
		expect(archived).toBeTruthy();
		expect(cardDuration(live!)).toBe("1h 10m");
		expect(cardDuration(archived!)).toBe("1h 45m");
	});
});
