import { beforeAll as syncBeforeAll } from "vitest";
import { syncCustomElements } from "../../tests/support/helpers/dom/setup/custom-elements.js";
syncBeforeAll(() => syncCustomElements());

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/ui/components/GitStatusWidget.js";
import type { Goal } from "../../src/app/state.js";

type StateModule = typeof import("../../src/app/state.js");
type DashboardModule = typeof import("../../src/app/goal-dashboard.js");

const goal: Goal = {
	id: "mutation-goal",
	title: "Mutation goal",
	cwd: "/repo",
	projectId: "project-1",
	state: "in-progress",
	spec: "A goal with a pending plan mutation.",
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_000_000,
	setupStatus: "ready",
};

let state: StateModule["state"];
let setRenderApp: StateModule["setRenderApp"];
let loadDashboardData: DashboardModule["loadDashboardData"];
let clearDashboardState: DashboardModule["clearDashboardState"];
let renderGoalDashboard: DashboardModule["renderGoalDashboard"];
let host: HTMLElement;
let pending = true;
let decisionOk = true;
const decisions: Array<{ path: string; body: unknown }> = [];

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFetch(): void {
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
		const url = new URL(raw, window.location.origin);
		const path = `${url.pathname}${url.search}`;
		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

		if (path === `/api/goals/${goal.id}`) return json(goal);
		if (path === `/api/goals/${goal.id}/tasks`) return json({ tasks: [] });
		if (path === `/api/goals/${goal.id}/commits?limit=20`) return json({ commits: [] });
		if (path === `/api/goals/${goal.id}/gates`) return json({ gates: [] });
		if (path === `/api/goals/${goal.id}/git-status?intent=visible`) return json({ error: "Not a git repository" }, 400);
		if (path === `/api/goals/${goal.id}/cost`) return json({ total: 0, sessions: [] });
		if (path === `/api/goals/${goal.id}/pr-status?optional=1&intent=visible`) return new Response(null, { status: 204 });
		if (path === `/api/goals/${goal.id}/team`) return new Response(null, { status: 404 });
		if (path === `/api/goals/${goal.id}/tree-cost`) return json({ totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0, breakdown: [] });
		if (path === `/api/goals/${goal.id}/descendants`) return json({ goals: [] });
		if (path === `/api/goals/${goal.id}/verifications/active`) return json({ verifications: [] });
		if (path === `/api/goals/${goal.id}/mutations/pending`) return json({ pending: pending ? [{
			requestId: "request-1",
			goalId: goal.id,
			kind: "expansion",
			summary: "Add a verification step",
			expiresAt: Date.now() + 60_000,
		}] : [] });
		if (method === "POST" && path === `/api/goals/${goal.id}/mutation/request-1/decision`) {
			decisions.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
			if (decisionOk) pending = false;
			return json(decisionOk ? { applied: true } : { error: "conflict" }, decisionOk ? 200 : 409);
		}
		if (path === "/api/sessions") return json({ sessions: [], generation: 1 });
		if (path === "/api/projects") return json({ projects: state.projects });
		if (path.startsWith("/api/sessions/archived") || path.startsWith("/api/goals/archived")) return json({ sessions: [], goals: [] });
		return json({});
	}));
}

async function waitFor(selector: string): Promise<HTMLElement> {
	for (let i = 0; i < 50; i++) {
		const element = host.querySelector<HTMLElement>(selector);
		if (element) return element;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${selector}`);
}

beforeEach(async () => {
	document.documentElement.dataset.subgoalsEnabled = "true";
	document.body.innerHTML = '<div id="host"></div>';
	host = document.getElementById("host")!;
	pending = true;
	decisionOk = true;
	decisions.length = 0;
	vi.stubGlobal("WebSocket", class extends EventTarget {
		static OPEN = 1;
		readyState = 1;
		send() {}
		close() {}
	} as unknown as typeof WebSocket);

	const stateModule = await import("../../src/app/state.js");
	const dashboardModule = await import("../../src/app/goal-dashboard.js");
	state = stateModule.state;
	setRenderApp = stateModule.setRenderApp;
	loadDashboardData = dashboardModule.loadDashboardData;
	clearDashboardState = dashboardModule.clearDashboardState;
	renderGoalDashboard = dashboardModule.renderGoalDashboard;
	clearDashboardState();
	state.goals = [goal];
	state.gatewaySessions = [];
	state.projects = [{ id: "project-1", name: "Project", rootPath: "/repo", colorLight: "#fff", colorDark: "#000" }];
	state.activeProjectId = "project-1";
	state.gateStatusCache.clear();
	state.prStatusCache.clear();
	installFetch();
	setRenderApp(() => render(renderGoalDashboard(), host));
});

afterEach(() => {
	setRenderApp?.(() => {});
	clearDashboardState?.();
	render(null, host);
	delete document.documentElement.dataset.subgoalsEnabled;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("dashboard mutation-pending card", () => {
	it("rehydrates, submits decisions, clears only after success, and can rehydrate again", async () => {
		await loadDashboardData(goal.id);
		const card = await waitFor("[data-testid='dashboard-mutation-pending-card']");
		expect(card.textContent).toContain("Add a verification step");

		decisionOk = false;
		(await waitFor("[data-testid='dashboard-mutation-pending-reject']") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(decisions).toHaveLength(1));
		expect(decisions[0]?.body).toEqual({ decision: "reject" });
		expect(host.querySelector("[data-testid='dashboard-mutation-pending-card']")).not.toBeNull();

		decisionOk = true;
		(await waitFor("[data-testid='dashboard-mutation-pending-approve']") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(host.querySelector("[data-testid='dashboard-mutation-pending-card']")).toBeNull());
		expect(decisions[1]?.body).toEqual({ decision: "approve" });

		pending = true;
		clearDashboardState();
		await loadDashboardData(goal.id);
		expect((await waitFor("[data-testid='dashboard-mutation-pending-card']")).textContent).toContain("Add a verification step");
	});
});
