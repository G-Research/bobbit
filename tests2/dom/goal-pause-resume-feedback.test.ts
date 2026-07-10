import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySession, Goal } from "../../src/app/state.js";

type StateModule = typeof import("../../src/app/state.js");
type DashboardModule = typeof import("../../src/app/goal-dashboard.js");
type RenderModule = typeof import("../../src/app/render.js");
type ApiModule = typeof import("../../src/app/api.js");

let state!: StateModule["state"];
let setRenderApp!: StateModule["setRenderApp"];
let clearDashboardState!: DashboardModule["clearDashboardState"];
let loadDashboardData!: DashboardModule["loadDashboardData"];
let renderGoalDashboard!: DashboardModule["renderGoalDashboard"];
let doRenderApp!: RenderModule["doRenderApp"];
let pauseGoalWithDialog!: ApiModule["pauseGoalWithDialog"];
let resumeGoalWithDialog!: ApiModule["resumeGoalWithDialog"];

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
	settled: boolean;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const deferredState = { settled: false };
	const promise = new Promise<T>((res, rej) => {
		resolve = (value) => {
			deferredState.settled = true;
			res(value);
		};
		reject = (reason) => {
			deferredState.settled = true;
			rej(reason);
		};
	});
	return { promise, resolve, reject, get settled() { return deferredState.settled; } };
}

class MockWebSocket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = MockWebSocket.OPEN;
	send = vi.fn();
	close = vi.fn(() => {
		this.readyState = MockWebSocket.CLOSED;
	});
}

const now = 1_783_682_557_000;
let host!: HTMLElement;
let activeGoal!: Goal;
let delayedMutations: Deferred<Response>[] = [];
let mutationPosts: string[] = [];

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "Content-Type": "application/json", ...(init.headers || {}) },
	});
}

function emptyResponse(status = 204): Response {
	return new Response(null, { status });
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-pending-feedback",
		title: "Pending feedback goal",
		cwd: "/repo",
		projectId: "project-1",
		state: "in-progress",
		spec: "spec",
		createdAt: now,
		updatedAt: now,
		setupStatus: "ready",
		...overrides,
	};
}

function makeSession(goalId: string): GatewaySession {
	return {
		id: "session-1",
		title: "Goal session",
		cwd: "/repo",
		projectId: "project-1",
		status: "idle",
		createdAt: now,
		lastActivity: now,
		clientCount: 1,
		goalId,
	};
}

function installFetchStub(): void {
	const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
		const url = new URL(rawUrl, window.location.origin);
		const path = `${url.pathname}${url.search}`;
		const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();

		if (method === "POST" && /^\/api\/goals\/[^/]+\/(pause|resume)$/.test(url.pathname)) {
			mutationPosts.push(url.pathname);
			const pending = deferred<Response>();
			delayedMutations.push(pending);
			return pending.promise;
		}

		if (path === `/api/goals/${activeGoal.id}`) return Promise.resolve(jsonResponse(activeGoal));
		if (path === `/api/goals/${activeGoal.id}/tasks`) return Promise.resolve(jsonResponse({ tasks: [] }));
		if (path === `/api/goals/${activeGoal.id}/commits?limit=20`) return Promise.resolve(jsonResponse({ commits: [] }));
		if (path === `/api/goals/${activeGoal.id}/gates`) return Promise.resolve(jsonResponse({ gates: [] }));
		if (path === `/api/goals/${activeGoal.id}/git-status`) return Promise.resolve(jsonResponse({ error: "Not a git repository" }, { status: 400 }));
		if (path === `/api/goals/${activeGoal.id}/cost`) return Promise.resolve(jsonResponse({ total: 0, sessions: [] }));
		if (path === `/api/goals/${activeGoal.id}/tree-cost`) return Promise.resolve(jsonResponse({
			totalCostUsd: 0,
			totalTokensIn: 0,
			totalTokensOut: 0,
			breakdown: [{
				goalId: activeGoal.id,
				depth: 0,
				title: activeGoal.title,
				costUsd: 0,
				tokensIn: 0,
				tokensOut: 0,
			}],
		}));
		if (path === `/api/goals/${activeGoal.id}/pr-status?optional=1`) return Promise.resolve(emptyResponse());
		if (path === `/api/goals/${activeGoal.id}/team`) return Promise.resolve(emptyResponse(404));
		if (path === `/api/goals/${activeGoal.id}/descendants`) return Promise.resolve(jsonResponse({ goals: [] }));
		if (path === `/api/goals/${activeGoal.id}/pending-mutations`) return Promise.resolve(jsonResponse({ pending: [] }));
		if (path === `/api/goals/${activeGoal.id}/verifications/active`) return Promise.resolve(jsonResponse({ verifications: [] }));
		if (path === "/api/sessions") return Promise.resolve(jsonResponse({ sessions: state?.gatewaySessions ?? [], generation: 1 }));
		if (path === "/api/goals") return Promise.resolve(jsonResponse({ goals: state?.goals ?? [activeGoal], generation: 1 }));
		if (path === "/api/projects") return Promise.resolve(jsonResponse({ projects: state?.projects ?? [] }));
		if (path.startsWith("/api/sessions/archived")) return Promise.resolve(jsonResponse({ sessions: [] }));
		if (path.startsWith("/api/goals/archived")) return Promise.resolve(jsonResponse({ goals: [] }));
		if (path === "/api/staff" || path.startsWith("/api/staff?")) return Promise.resolve(jsonResponse([]));
		if (path === "/api/staff/orphaned") return Promise.resolve(jsonResponse([]));
		if (path === "/api/sandbox/status") return Promise.resolve(jsonResponse({ available: false }));

		return Promise.resolve(jsonResponse({}));
	});
	vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
	(window as any).fetch = fetchMock;
	(globalThis as any).fetch = fetchMock;
}

async function nextFrame(): Promise<void> {
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	await Promise.resolve();
}

async function waitFor(assertion: () => void): Promise<void> {
	let lastError: unknown;
	for (let i = 0; i < 30; i++) {
		try {
			assertion();
			return;
		} catch (err) {
			lastError = err;
			await nextFrame();
		}
	}
	throw lastError;
}

async function waitForElement<T extends Element>(selector: string): Promise<T> {
	for (let i = 0; i < 20; i++) {
		const el = host.querySelector<T>(selector) ?? document.querySelector<T>(selector);
		if (el) return el;
		await nextFrame();
	}
	throw new Error(`Timed out waiting for ${selector}`);
}

async function waitForErrorDetailsMessage(message: string): Promise<void> {
	await waitFor(() => {
		const detail = document.querySelector("error-details") as (HTMLElement & { message?: string }) | null;
		expect(detail).toBeTruthy();
		expect(detail?.message).toContain(message);
	});
}

function resetSharedState(): void {
	clearDashboardState();
	state.gatewaySessions = [] as GatewaySession[];
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
	activeGoal = makeGoal();
	delayedMutations = [];
	mutationPosts = [];
	installFetchStub();
	vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
	vi.spyOn(console, "warn").mockImplementation(() => {});

	const stateMod = await import("../../src/app/state.js");
	const dashboardMod = await import("../../src/app/goal-dashboard.js");
	const renderMod = await import("../../src/app/render.js");
	const apiMod = await import("../../src/app/api.js");
	state = stateMod.state;
	setRenderApp = stateMod.setRenderApp;
	clearDashboardState = dashboardMod.clearDashboardState;
	loadDashboardData = dashboardMod.loadDashboardData;
	renderGoalDashboard = dashboardMod.renderGoalDashboard;
	doRenderApp = renderMod.doRenderApp;
	pauseGoalWithDialog = apiMod.pauseGoalWithDialog;
	resumeGoalWithDialog = apiMod.resumeGoalWithDialog;
	resetSharedState();
});

afterEach(async () => {
	// Stop production continuations from scheduling more full-app renders, then
	// settle any deliberately delayed pause/resume requests before jsdom globals
	// (including customElements) are restored by Vitest.
	setRenderApp?.(() => {});
	for (const pending of delayedMutations) {
		if (!pending.settled) pending.resolve(jsonResponse({ paused: 0, resumed: 0 }));
	}
	await Promise.allSettled(delayedMutations.map((pending) => pending.promise));
	await Promise.resolve();
	await Promise.resolve();
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

	if (host) render(null, host);
	if (state) resetSharedState();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function renderDashboard(goal: Goal): Promise<void> {
	activeGoal = goal;
	state.goals = [goal];
	setRenderApp(() => render(renderGoalDashboard(), host));
	await loadDashboardData(goal.id);
	await waitForElement("[data-testid='goal-dashboard']");
}

describe("goal pause/resume pending feedback", () => {
	it("disables dashboard Pause and labels it Pausing… while the no-descendant request is pending", async () => {
		await renderDashboard(makeGoal({ paused: false }));
		const button = await waitForElement<HTMLButtonElement>("[data-testid='goal-pause-btn']");

		button.click();
		await nextFrame();
		const pendingButton = await waitForElement<HTMLButtonElement>("[data-testid='goal-pause-btn']");

		expect(pendingButton.disabled).toBe(true);
		expect(pendingButton.textContent).toContain("Pausing…");

		void pauseGoalWithDialog(activeGoal.id);
		await Promise.resolve();
		expect(mutationPosts.filter((path) => path.endsWith("/pause"))).toHaveLength(1);
	});

	it("disables dashboard Resume and labels it Resuming… while the no-descendant request is pending", async () => {
		await renderDashboard(makeGoal({ paused: true }));
		const button = await waitForElement<HTMLButtonElement>("[data-testid='goal-resume-btn']");

		button.click();
		await nextFrame();
		const pendingButton = await waitForElement<HTMLButtonElement>("[data-testid='goal-resume-btn']");

		expect(pendingButton.disabled).toBe(true);
		expect(pendingButton.textContent).toContain("Resuming…");

		void resumeGoalWithDialog(activeGoal.id);
		await Promise.resolve();
		expect(mutationPosts.filter((path) => path.endsWith("/resume"))).toHaveLength(1);
	});

	it("disables transcript paused-banner Resume and labels it Resuming… while the no-descendant request is pending", async () => {
		const goal = makeGoal({ paused: true });
		activeGoal = goal;
		state.goals = [goal];
		state.gatewaySessions = [makeSession(goal.id)];
		state.selectedSessionId = "session-1";
		state.remoteAgent = { gatewaySessionId: "session-1", title: "Goal session" } as any;
		setRenderApp(doRenderApp);
		doRenderApp();
		const button = await waitForElement<HTMLButtonElement>("[data-testid='goal-paused-banner-resume-btn']");

		button.click();
		await nextFrame();
		const pendingButton = await waitForElement<HTMLButtonElement>("[data-testid='goal-paused-banner-resume-btn']");

		expect(pendingButton.disabled).toBe(true);
		expect(pendingButton.textContent).toContain("Resuming…");

		void resumeGoalWithDialog(goal.id);
		await Promise.resolve();
		expect(mutationPosts.filter((path) => path.endsWith("/resume"))).toHaveLength(1);
	});

	it("suppresses duplicate pause helper calls even when DOM disabled suppression is bypassed", async () => {
		await renderDashboard(makeGoal({ paused: false }));

		void pauseGoalWithDialog(activeGoal.id);
		void pauseGoalWithDialog(activeGoal.id);
		await Promise.resolve();

		expect(mutationPosts.filter((path) => path.endsWith("/pause"))).toHaveLength(1);
		expect(delayedMutations).toHaveLength(1);
	});

	it("suppresses duplicate resume helper calls even when DOM disabled suppression is bypassed", async () => {
		await renderDashboard(makeGoal({ paused: true }));

		void resumeGoalWithDialog(activeGoal.id);
		void resumeGoalWithDialog(activeGoal.id);
		await Promise.resolve();

		expect(mutationPosts.filter((path) => path.endsWith("/resume"))).toHaveLength(1);
		expect(delayedMutations).toHaveLength(1);
	});

	it("clears dashboard Pause pending feedback and renders the connection error path on failed pause", async () => {
		await renderDashboard(makeGoal({ paused: false }));
		const button = await waitForElement<HTMLButtonElement>("[data-testid='goal-pause-btn']");

		button.click();
		await nextFrame();
		expect((await waitForElement<HTMLButtonElement>("[data-testid='goal-pause-btn']")).textContent).toContain("Pausing…");

		delayedMutations[0].resolve(jsonResponse({ error: "boom" }, { status: 500 }));

		await waitFor(() => {
			const current = host.querySelector<HTMLButtonElement>("[data-testid='goal-pause-btn']");
			expect(current?.disabled).toBe(false);
			expect(current?.textContent).toContain("Pause");
		});
		await waitForErrorDetailsMessage("HTTP 500");
		expect(document.body.textContent).toContain("Failed to pause goal");
	});

	it("clears dashboard Resume pending feedback and renders the connection error path on failed resume", async () => {
		await renderDashboard(makeGoal({ paused: true }));
		const button = await waitForElement<HTMLButtonElement>("[data-testid='goal-resume-btn']");

		button.click();
		await nextFrame();
		expect((await waitForElement<HTMLButtonElement>("[data-testid='goal-resume-btn']")).textContent).toContain("Resuming…");

		delayedMutations[0].resolve(jsonResponse({ error: "boom" }, { status: 500 }));

		await waitFor(() => {
			const current = host.querySelector<HTMLButtonElement>("[data-testid='goal-resume-btn']");
			expect(current?.disabled).toBe(false);
			expect(current?.textContent).toContain("Resume");
		});
		await waitForErrorDetailsMessage("HTTP 500");
		expect(document.body.textContent).toContain("Failed to resume goal");
	});
});
