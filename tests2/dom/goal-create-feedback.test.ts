import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySession, Project } from "../../src/app/state.js";
import type { Workflow } from "../../src/app/api.js";
import type { PanelWorkspaceTab } from "../../src/app/panel-workspace.js";

vi.mock("../../src/app/lazy-review.js", () => ({
	ensureReviewComponents: vi.fn(),
}));

type StateModule = typeof import("../../src/app/state.js");
type ProposalPanelsModule = typeof import("../../src/app/proposal-panels.js");

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
	settled: boolean;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	let settled = false;
	const promise = new Promise<T>((res, rej) => {
		resolve = (value) => {
			settled = true;
			res(value);
		};
		reject = (reason) => {
			settled = true;
			rej(reason);
		};
	});
	return { promise, resolve, reject, get settled() { return settled; } };
}

const now = 1_783_682_557_000;
const project: Project = {
	id: "project-1",
	name: "Project One",
	rootPath: "/repo",
	colorLight: "#fff",
	colorDark: "#000",
};
const workflow: Workflow = {
	id: "general",
	name: "General",
	description: "General workflow",
	gates: [],
	createdAt: now,
	updatedAt: now,
};

let state!: StateModule["state"];
let setRenderApp!: StateModule["setRenderApp"];
let proposalPanelContent!: ProposalPanelsModule["proposalPanelContent"];
let host!: HTMLElement;
let goalPosts: Array<{ path: string; body: Record<string, unknown> }> = [];
let delayedGoalPosts: Deferred<Response>[] = [];
let titleCounter = 0;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "Content-Type": "application/json", ...(init.headers || {}) },
	});
}

function emptyResponse(status = 204): Response {
	return new Response(null, { status });
}

function installFetchStub(): void {
	const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
		const url = new URL(rawUrl, window.location.origin);
		const path = `${url.pathname}${url.search}`;
		const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();

		if (method === "POST" && url.pathname === "/api/goals") {
			const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
			goalPosts.push({ path: url.pathname, body });
			const pending = deferred<Response>();
			delayedGoalPosts.push(pending);
			return pending.promise;
		}

		if (path === "/api/workflows?projectId=project-1") return Promise.resolve(jsonResponse({ workflows: [workflow] }));
		if (path === "/api/projects/project-1/structured") return Promise.resolve(jsonResponse({ components: [{ name: "default", repo: "." }] }));
		if (path === "/api/projects/project-1/qa-testing-config") return Promise.resolve(jsonResponse({ configured: false }));
		if (path === "/api/roles?projectId=project-1") return Promise.resolve(jsonResponse({ roles: [] }));
		if (path === "/api/tools?projectId=project-1") return Promise.resolve(jsonResponse({ tools: [], diagnostics: [] }));
		if (path === "/api/tool-group-policies?projectId=project-1") return Promise.resolve(jsonResponse({}));
		if (path === "/api/sessions") return Promise.resolve(jsonResponse({ sessions: state?.gatewaySessions ?? [], generation: 1 }));
		if (path === "/api/goals") return Promise.resolve(jsonResponse({ goals: state?.goals ?? [], generation: 1 }));
		if (path === "/api/projects") return Promise.resolve(jsonResponse({ projects: state?.projects ?? [project] }));
		if (path.startsWith("/api/sessions/archived")) return Promise.resolve(jsonResponse({ sessions: [] }));
		if (path.startsWith("/api/goals/archived")) return Promise.resolve(jsonResponse({ goals: [] }));
		if (method === "DELETE" && url.pathname.startsWith("/api/sessions/")) return Promise.resolve(emptyResponse());

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

function primarySubmit(): HTMLElement {
	const submit = host.querySelector<HTMLElement>("[data-testid='proposal-primary-submit']");
	if (!submit) throw new Error("Missing goal proposal submit wrapper");
	return submit;
}

function primaryButton(): HTMLButtonElement {
	const button = primarySubmit().querySelector<HTMLButtonElement>("button");
	if (!button) throw new Error("Missing goal proposal submit button");
	return button;
}

function hasBusyState(): boolean {
	const submit = primarySubmit();
	const button = primaryButton();
	return submit.getAttribute("aria-busy") === "true"
		|| button.getAttribute("aria-busy") === "true"
		|| !!submit.querySelector('[aria-busy="true"]');
}

function proposalTab(): PanelWorkspaceTab {
	return {
		id: "proposal:goal:session-1",
		kind: "proposal",
		title: "Goal Proposal",
		label: "Goal",
		legacyTab: "goal",
		source: { type: "proposal", proposalType: "goal", sessionId: "session-1" },
	};
}

function session(): GatewaySession {
	return {
		id: "session-1",
		title: "Assistant session",
		cwd: "/repo",
		projectId: "project-1",
		status: "idle",
		createdAt: now,
		lastActivity: now,
		clientCount: 1,
	};
}

function resetSharedState(surface: "assistant" | "regular"): void {
	const title = `Create feedback ${++titleCounter}`;
	const fields = {
		title,
		spec: "Verify create-goal pending feedback.",
		cwd: "/repo",
		workflow: "general",
		projectId: "project-1",
	};
	state.gatewaySessions = [session()];
	state.goals = [];
	state.projects = [project];
	state.activeProjectId = "project-1";
	state.activeProposals = {
		goal: { sessionId: "session-1", fields, streaming: false, rev: 1 },
	};
	state.previewProjectId = "project-1";
	state.previewTitle = title;
	state.previewSpec = fields.spec;
	state.previewCwd = "/repo";
	state.previewCwdEdited = false;
	state.previewSpecEditMode = false;
	state.previewMetadataRows = [];
	state.previewMetadataEdited = false;
	state.cwdDropdownOpen = false;
	state.cwdHighlightIndex = -1;
	state.sandboxStatus = { configured: false, available: false, imageExists: false };
	state.selectedSessionId = surface === "assistant" ? "session-1" : null;
	state.connectingSessionId = null;
	state.remoteAgent = surface === "assistant"
		? { gatewaySessionId: "session-1", disconnect: vi.fn(), prompt: vi.fn() } as any
		: null;
	state.assistantType = surface === "assistant" ? "goal" : null;
	state.chatPanel = null;
	state.appView = "authenticated";
	state.connectionStatus = "connected" as any;
	state.sessionsGeneration = -1;
	state.goalsGeneration = -1;
	state.roles = [];
	state.archivedSessions = [];
}

async function renderGoalProposal(surface: "assistant" | "regular"): Promise<void> {
	resetSharedState(surface);
	setRenderApp(() => render(proposalPanelContent(proposalTab(), () => surface === "assistant" ? "goal" : null), host));
	render(proposalPanelContent(proposalTab(), () => surface === "assistant" ? "goal" : null), host);
	await waitFor(() => {
		const button = primaryButton();
		expect(button.textContent).toContain("Create Goal");
		expect(button.disabled).toBe(false);
	});
}

async function clickCreateAndExpectPending(): Promise<HTMLButtonElement> {
	primaryButton().click();
	await nextFrame();
	const button = primaryButton();
	expect(primarySubmit().textContent).toContain("Creating…");
	expect(button.disabled).toBe(true);
	expect(hasBusyState(), "Create Goal pending state should expose aria-busy=true").toBe(true);
	return button;
}

beforeEach(async () => {
	document.body.innerHTML = `<div id="host"></div>`;
	host = document.getElementById("host")!;
	goalPosts = [];
	delayedGoalPosts = [];
	installFetchStub();
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});

	const stateMod = await import("../../src/app/state.js");
	const proposalPanelsMod = await import("../../src/app/proposal-panels.js");
	state = stateMod.state;
	setRenderApp = stateMod.setRenderApp;
	proposalPanelContent = proposalPanelsMod.proposalPanelContent;
});

afterEach(async () => {
	setRenderApp?.(() => {});
	for (const pending of delayedGoalPosts) {
		if (!pending.settled) pending.resolve(jsonResponse({ error: "test cleanup" }, { status: 500 }));
	}
	await Promise.allSettled(delayedGoalPosts.map((pending) => pending.promise));
	await Promise.resolve();
	await Promise.resolve();
	if (host) render(null, host);
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("goal proposal Create Goal pending feedback", () => {
	it("assistant preview disables Create Goal, marks it busy, and suppresses duplicate POSTs while pending", async () => {
		await renderGoalProposal("assistant");
		const pendingButton = await clickCreateAndExpectPending();

		pendingButton.click();
		pendingButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await Promise.resolve();

		expect(goalPosts).toHaveLength(1);
		expect(delayedGoalPosts).toHaveLength(1);
	});

	it("assistant preview clears Create Goal pending feedback after a failed create", async () => {
		await renderGoalProposal("assistant");
		await clickCreateAndExpectPending();

		delayedGoalPosts[0].resolve(jsonResponse({ error: "boom" }, { status: 500 }));

		await waitFor(() => {
			const button = primaryButton();
			expect(button.disabled).toBe(false);
			expect(primarySubmit().textContent).toContain("Create Goal");
			expect(primarySubmit().textContent).not.toContain("Creating…");
			expect(hasBusyState()).toBe(false);
		});
		expect(goalPosts).toHaveLength(1);
	});

	it("regular proposal panel disables Create Goal, marks it busy, and suppresses duplicate POSTs while pending", async () => {
		await renderGoalProposal("regular");
		const pendingButton = await clickCreateAndExpectPending();

		pendingButton.click();
		pendingButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await Promise.resolve();

		expect(goalPosts).toHaveLength(1);
		expect(delayedGoalPosts).toHaveLength(1);
	});

	it("regular proposal panel clears Create Goal pending feedback after a failed create", async () => {
		await renderGoalProposal("regular");
		await clickCreateAndExpectPending();

		delayedGoalPosts[0].resolve(jsonResponse({ error: "boom" }, { status: 500 }));

		await waitFor(() => {
			const button = primaryButton();
			expect(button.disabled).toBe(false);
			expect(primarySubmit().textContent).toContain("Create Goal");
			expect(primarySubmit().textContent).not.toContain("Creating…");
			expect(hasBusyState()).toBe(false);
		});
		expect(goalPosts).toHaveLength(1);
	});
});
