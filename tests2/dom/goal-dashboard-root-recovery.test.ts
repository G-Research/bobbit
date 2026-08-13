import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/ui/components/GitStatusWidget.js";
import type { Goal } from "../../src/app/state.js";

type StateModule = typeof import("../../src/app/state.js");
type DashboardModule = typeof import("../../src/app/goal-dashboard.js");

let state!: StateModule["state"];
let setRenderApp!: StateModule["setRenderApp"];
let clearDashboardState!: DashboardModule["clearDashboardState"];
let loadDashboardData!: DashboardModule["loadDashboardData"];
let notifyGoalEventForDashboard!: DashboardModule["notifyGoalEventForDashboard"];
let renderGoalDashboard!: DashboardModule["renderGoalDashboard"];
let host!: HTMLElement;
let activeGoal!: Goal;
let retryResult: "success" | "failed" | "network";
let webSocketSendCount: number;
let descendantsRequestCount: number;
let holdDescendantsResponse = false;
let resolveDescendantsResponse: ((response: Response) => void) | undefined;

const now = 1_783_682_557_000;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
	});
}

function makeGoal(): Goal {
	return {
		id: "root-recovery-goal",
		title: "Root recovery goal",
		cwd: "/repo",
		projectId: "project-1",
		state: "in-progress",
		spec: "spec",
		createdAt: now,
		updatedAt: now,
		setupStatus: "ready",
		schedulerRecovery: { kind: "root", code: "RETRY_STORM", reason: "retry storm", retryable: true, updatedAt: now },
	};
}

function installFetchStub(): void {
	const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
		const url = new URL(rawUrl, window.location.origin);
		const path = `${url.pathname}${url.search}`;
		const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();

		if (method === "POST" && path === `/api/goals/${activeGoal.id}/retry-scheduled-start`) {
			if (retryResult === "network") return Promise.reject(new Error("offline"));
			return Promise.resolve(jsonResponse({}, { status: retryResult === "success" ? 200 : 409 }));
		}
		if (path === `/api/goals/${activeGoal.id}`) return Promise.resolve(jsonResponse(activeGoal));
		if (path === `/api/goals/${activeGoal.id}/tasks`) return Promise.resolve(jsonResponse({ tasks: [] }));
		if (path === `/api/goals/${activeGoal.id}/commits?limit=20`) return Promise.resolve(jsonResponse({ commits: [] }));
		if (path === `/api/goals/${activeGoal.id}/gates`) return Promise.resolve(jsonResponse({ gates: [] }));
		if (path === `/api/goals/${activeGoal.id}/git-status?intent=visible`) return Promise.resolve(jsonResponse({ error: "Not a git repository" }, { status: 400 }));
		if (path === `/api/goals/${activeGoal.id}/cost`) return Promise.resolve(jsonResponse({ total: 0, sessions: [] }));
		if (path === `/api/goals/${activeGoal.id}/tree-cost`) return Promise.resolve(jsonResponse({ totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0, breakdown: [] }));
		if (path === `/api/goals/${activeGoal.id}/pr-status?optional=1&intent=visible`) return Promise.resolve(new Response(null, { status: 204 }));
		if (path === `/api/goals/${activeGoal.id}/team`) return Promise.resolve(new Response(null, { status: 404 }));
		// Deliberately contain the root too: this represents the duplicate cache
		// which used to restore recovery after the root action's stale render.
		if (path === `/api/goals/${activeGoal.id}/descendants`) {
			descendantsRequestCount++;
			if (holdDescendantsResponse) {
				return new Promise<Response>(resolve => { resolveDescendantsResponse = resolve; });
			}
			return Promise.resolve(jsonResponse({ goals: [activeGoal] }));
		}
		if (path === `/api/goals/${activeGoal.id}/mutations/pending`) return Promise.resolve(jsonResponse({ pending: [] }));
		if (path === `/api/goals/${activeGoal.id}/verifications/active`) return Promise.resolve(jsonResponse({ verifications: [] }));
		if (path === "/api/sessions") return Promise.resolve(jsonResponse({ sessions: [], generation: 1 }));
		if (path === "/api/goals") return Promise.resolve(jsonResponse({ goals: state.goals, generation: 1 }));
		if (path === "/api/projects") return Promise.resolve(jsonResponse({ projects: state.projects }));
		if (path.startsWith("/api/sessions/archived") || path.startsWith("/api/goals/archived")) return Promise.resolve(jsonResponse({ sessions: [], goals: [] }));
		if (path === "/api/staff" || path.startsWith("/api/staff?") || path === "/api/staff/orphaned") return Promise.resolve(jsonResponse([]));
		if (path === "/api/sandbox/status") return Promise.resolve(jsonResponse({ available: false }));
		return Promise.resolve(jsonResponse({}));
	});
	vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
	(window as any).fetch = fetchMock;
}

async function nextFrame(): Promise<void> {
	await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
	await Promise.resolve();
}

async function waitFor<T>(lookup: () => T | null): Promise<T> {
	for (let i = 0; i < 30; i++) {
		const value = lookup();
		if (value) return value;
		await nextFrame();
	}
	throw new Error("Timed out waiting for dashboard update");
}

beforeEach(async () => {
	document.documentElement.dataset.subgoalsEnabled = "true";
	document.body.innerHTML = '<div id="host"></div>';
	host = document.getElementById("host")!;
	activeGoal = makeGoal();
	retryResult = "success";
	webSocketSendCount = 0;
	descendantsRequestCount = 0;
	holdDescendantsResponse = false;
	resolveDescendantsResponse = undefined;
	installFetchStub();
	vi.stubGlobal("WebSocket", class extends EventTarget {
		static OPEN = 1;
		readyState = 1;
		send() { webSocketSendCount++; }
		close() {}
	} as unknown as typeof WebSocket);

	const stateMod = await import("../../src/app/state.js");
	const dashboardMod = await import("../../src/app/goal-dashboard.js");
	state = stateMod.state;
	setRenderApp = stateMod.setRenderApp;
	clearDashboardState = dashboardMod.clearDashboardState;
	loadDashboardData = dashboardMod.loadDashboardData;
	notifyGoalEventForDashboard = dashboardMod.notifyGoalEventForDashboard;
	renderGoalDashboard = dashboardMod.renderGoalDashboard;
	clearDashboardState();
	state.goals = [activeGoal];
	state.gatewaySessions = [];
	state.projects = [{ id: "project-1", name: "Project", rootPath: "/repo", colorLight: "#fff", colorDark: "#000" }];
	state.activeProjectId = "project-1";
	state.gateStatusCache.clear();
	state.prStatusCache.clear();
	setRenderApp(() => render(renderGoalDashboard(), host));
	await loadDashboardData(activeGoal.id);
	await waitFor(() => host.querySelector<HTMLButtonElement>("[data-testid='goal-scheduler-recovery-retry']"));
	// Let the asynchronous descendants response populate its canonical cache.
	await nextFrame();
});

afterEach(() => {
	setRenderApp?.(() => {});
	clearDashboardState?.();
	if (host) render(null, host);
	document.body.innerHTML = "";
	delete document.documentElement.dataset.subgoalsEnabled;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("root scheduler recovery retry", () => {
	it("does not let an older descendants response restore consumed root recovery", async () => {
		// Start a descendants refresh, but hold its pre-retry snapshot until the
		// successful retry has cleared every local recovery cache.
		holdDescendantsResponse = true;
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
		notifyGoalEventForDashboard();
		expect(descendantsRequestCount).toBe(2);

		const button = host.querySelector<HTMLButtonElement>("[data-testid='goal-scheduler-recovery-retry']")!;
		button.click();
		await waitFor(() => state.goals[0]?.schedulerRecovery === undefined);
		expect(state.goals[0]?.schedulerRecovery).toBeUndefined();

		resolveDescendantsResponse!(jsonResponse({ goals: [activeGoal] }));
		await nextFrame();
		await nextFrame();

		// Lit commits the render queued by reconciliation asynchronously; do not
		// mistake the previous DOM frame for a stale cache or broadcast dependency.
		expect(host.querySelector("[data-testid='goal-scheduler-recovery-retry']")).toBeNull();
		expect(state.goals[0]?.schedulerRecovery).toBeUndefined();
		expect(webSocketSendCount).toBe(0);
	});

	it.each(["failed", "network"] as const)("retains root recovery when the POST %s", async (result) => {
		retryResult = result;
		host.querySelector<HTMLButtonElement>("[data-testid='goal-scheduler-recovery-retry']")!.click();
		await nextFrame();
		await nextFrame();

		expect(state.goals[0]?.schedulerRecovery).toEqual(activeGoal.schedulerRecovery);
		expect(host.querySelector("[data-testid='goal-scheduler-recovery-retry']")).toBeTruthy();
	});
});
