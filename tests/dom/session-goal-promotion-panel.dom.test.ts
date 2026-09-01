import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests/support/helpers/dom/setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelWorkspaceTab } from "../../src/app/panel-workspace.js";
import type { Project } from "../../src/app/state.js";
import type { Workflow } from "../../src/app/api.js";

vi.mock("../../src/app/lazy-review.js", () => ({ ensureReviewComponents: vi.fn() }));

const OWNER = "proposal-owner";
const OTHER = "active-but-not-owner";
const now = 1_786_912_000_000;
const project: Project = {
	id: "project-1",
	name: "Promotion Project",
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

let state: typeof import("../../src/app/state.js").state;
let setRenderApp: typeof import("../../src/app/state.js").setRenderApp;
let proposalPanelContent: typeof import("../../src/app/proposal-panels.js").proposalPanelContent;
let updateLocalSessionStatus: typeof import("../../src/app/api.js").updateLocalSessionStatus;
let refreshSessions: typeof import("../../src/app/api.js").refreshSessions;
let host: HTMLElement;
let requests: Array<{ path: string; method: string; body?: Record<string, unknown> }>;
let eligibility: Record<string, unknown>;
let sessionSnapshot: Array<Record<string, unknown>> | undefined;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function tab(): PanelWorkspaceTab {
	return {
		id: `proposal:goal:${OWNER}`,
		kind: "proposal",
		title: "Goal Proposal",
		label: "Goal",
		legacyTab: "goal",
		source: { type: "proposal", proposalType: "goal", sessionId: OWNER },
	};
}

function installFetch(): void {
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = new URL(String(input), window.location.origin);
		const method = (init.method || "GET").toUpperCase();
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		requests.push({ path: url.pathname, method, body });
		if (url.pathname === `/api/sessions/${OWNER}/proposal/goal/worktree-mode`) {
			if (method === "PUT") return json({ ...eligibility, mode: body?.mode });
			return json(eligibility);
		}
		if (url.pathname === `/api/sessions/${OWNER}/proposal/goal/accept` && method === "POST") {
			return json({
				id: "goal-1", title: String(body?.title || "Promoted"), cwd: "/repo-wt/session-owner",
				projectId: project.id, state: "in-progress", spec: String(body?.spec || ""),
				createdAt: now, updatedAt: now, branch: "session/proposal", worktreePath: "/repo-wt/session-owner",
			});
		}
		if (url.pathname === "/api/workflows") return json({ workflows: [workflow] });
		if (url.pathname === `/api/projects/${project.id}/structured`) return json({ components: [{ name: "default", repo: "." }] });
		if (url.pathname === `/api/projects/${project.id}/qa-testing-config`) return json({ configured: false });
		if (url.pathname === "/api/roles") return json({ roles: [] });
		if (url.pathname === "/api/tools") return json({ tools: [], diagnostics: [] });
		if (url.pathname === "/api/tool-group-policies") return json({});
		if (url.pathname === "/api/sessions") return json({ sessions: sessionSnapshot ?? state.gatewaySessions, generation: state.sessionsGeneration + 1 });
		if (url.pathname === "/api/goals") return json({ goals: state.goals, generation: 2 });
		if (url.pathname === "/api/projects") return json({ projects: [project] });
		if (url.pathname.includes("/archived")) return json({ sessions: [], goals: [] });
		return json({});
	}) as unknown as typeof fetch);
}

async function frame(): Promise<void> {
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	await Promise.resolve();
}

async function waitFor(assertion: () => void): Promise<void> {
	let last: unknown;
	for (let i = 0; i < 40; i++) {
		try { assertion(); return; } catch (err) { last = err; await frame(); }
	}
	throw last;
}

function resetState(worktreeMode?: "current-session"): void {
	const fields: Record<string, unknown> = {
		title: "Promote this session",
		spec: "Keep this transcript and checkout.",
		cwd: "/repo",
		workflow: "general",
		projectId: project.id,
	};
	if (worktreeMode) fields.worktreeMode = worktreeMode;
	state.projects = [project];
	state.goals = [];
	state.gatewaySessions = [
		{ id: OWNER, title: "Owner", cwd: "/repo-wt/session-owner", projectId: project.id, status: "idle", createdAt: now, lastActivity: now, clientCount: 1, branch: "session/proposal", worktreePath: "/repo-wt/session-owner" } as any,
		{ id: OTHER, title: "Other", cwd: "/repo", projectId: project.id, status: "idle", createdAt: now, lastActivity: now, clientCount: 1 } as any,
	];
	state.activeProposals = { goal: { sessionId: OWNER, fields, streaming: false, rev: 1 } };
	state.goalWorktreeModeBySession = {};
	state.goalWorktreeModeRevisionBySession = {};
	state.previewProjectId = project.id;
	state.selectedSessionId = OTHER;
	state.connectingSessionId = null;
	state.remoteAgent = null;
	state.assistantType = null;
	state.chatPanel = null;
	state.appView = "authenticated";
	state.connectionStatus = "connected" as any;
	state.sessionsGeneration = -1;
	state.goalsGeneration = -1;
	state.sandboxStatus = { configured: true, available: true, imageExists: true };
	state.roles = [];
	state.archivedSessions = [];
	state.previewMetadataRows = [];
}

async function mount(mode?: "current-session"): Promise<void> {
	resetState(mode);
	setRenderApp(() => render(proposalPanelContent(tab(), () => null), host));
	render(proposalPanelContent(tab(), () => null), host);
	await waitFor(() => expect(host.querySelector("[data-testid='goal-form-worktree-mode']")).not.toBeNull());
}

beforeEach(async () => {
	document.body.innerHTML = '<div id="host"></div>';
	host = document.getElementById("host")!;
	requests = [];
	sessionSnapshot = undefined;
	eligibility = {
		mode: "new-worktree",
		eligible: true,
		branch: "session/proposal",
		worktreePath: "/repo-wt/session-owner",
		componentCount: 1,
		sandboxed: true,
	};
	installFetch();
	({ state, setRenderApp } = await import("../../src/app/state.js"));
	({ updateLocalSessionStatus, refreshSessions } = await import("../../src/app/api.js"));
	({ proposalPanelContent } = await import("../../src/app/proposal-panels.js"));
});

afterEach(() => {
	setRenderApp?.(() => {});
	if (host) render(null, host);
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("current-session goal proposal panel", () => {
	it("defaults to New worktree and derives eligibility from the proposal owner, not the active tab", async () => {
		await mount();
		await waitFor(() => expect(requests.some((r) => r.path === `/api/sessions/${OWNER}/proposal/goal/worktree-mode` && r.method === "GET")).toBe(true));
		expect(requests.some((r) => r.path.includes(OTHER) && r.path.includes("worktree-mode"))).toBe(false);
		expect((host.querySelector("[data-testid='goal-form-worktree-new']") as HTMLInputElement).checked).toBe(true);
		const summary = host.querySelector("[data-testid='goal-form-worktree-summary']");
		expect(summary?.textContent).toContain("New worktree");
		expect(summary?.textContent).toContain("isolated branch and checkout");
		expect(summary?.textContent).not.toContain(project.name);
		const newOption = host.querySelector("[data-testid='goal-form-worktree-option-new']");
		expect(newOption?.textContent).toContain("Create a dedicated branch and isolated checkout");
		expect(newOption?.textContent).toContain("Generated for this goal");
		const currentOption = host.querySelector("[data-testid='goal-form-worktree-option-current-session']");
		expect(currentOption?.textContent).toContain("Keep its checkout, transcript, and sandbox unchanged");
		await waitFor(() => expect(currentOption?.textContent).toContain("/repo-wt/session-owner"));
	});

	it("supports arrow-key traversal and Escape dismissal from the disclosure summary", async () => {
		await mount();
		await waitFor(() => expect((host.querySelector("[data-testid='goal-form-worktree-current-session']") as HTMLInputElement).disabled).toBe(false));
		const details = host.querySelector("[data-testid='goal-form-worktree-mode']") as HTMLDetailsElement;
		const summary = host.querySelector("[data-testid='goal-form-worktree-summary']") as HTMLElement;
		const newOption = host.querySelector("[data-testid='goal-form-worktree-option-new']") as HTMLButtonElement;
		const currentOption = host.querySelector("[data-testid='goal-form-worktree-option-current-session']") as HTMLButtonElement;
		details.open = true;
		summary.focus();
		summary.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(newOption);
		newOption.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(currentOption);
		currentOption.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(details.open).toBe(false);
		expect(document.activeElement).toBe(summary);

		details.open = true;
		currentOption.focus();
		currentOption.click();
		expect(details.open).toBe(false);
		expect(document.activeElement).toBe(summary);
	});

	it("persists Current session, renders authoritative coordinates, disables inherited controls, and accepts without coordinate authority", async () => {
		await mount();
		await waitFor(() => expect((host.querySelector("[data-testid='goal-form-worktree-current-session']") as HTMLInputElement).disabled).toBe(false));
		const current = host.querySelector("[data-testid='goal-form-worktree-current-session']") as HTMLInputElement;
		current.click();
		await waitFor(() => expect(requests.some((r) => r.method === "PUT" && r.path.endsWith("/proposal/goal/worktree-mode"))).toBe(true));
		expect(requests.find((r) => r.method === "PUT")?.body).toEqual({ mode: "current-session" });
		await waitFor(() => expect(host.querySelector("[data-testid='goal-form-worktree-summary']")?.textContent).toContain("Current session"));
		expect((host.querySelector("[data-testid='goal-form-worktree-current-session']") as HTMLInputElement).checked).toBe(true);
		expect(host.querySelector("[data-testid='goal-form-worktree-branch']")?.textContent).toBe("session/proposal");
		expect(host.querySelector("[data-testid='goal-form-worktree-path']")?.textContent).toBe("/repo-wt/session-owner");
		const toggles = [...host.querySelectorAll<HTMLInputElement>("input.toggle-switch")];
		expect(toggles.slice(0, 2).every((input) => input.disabled)).toBe(true);

		const create = host.querySelector("[data-testid='proposal-primary-submit'] button") as HTMLButtonElement;
		expect(create.disabled).toBe(false);
		create.click();
		await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.path.endsWith("/proposal/goal/accept"))).toBe(true));
		const accept = requests.find((r) => r.method === "POST" && r.path.endsWith("/proposal/goal/accept"))!;
		expect(accept.path).toBe(`/api/sessions/${OWNER}/proposal/goal/accept`);
		expect(accept.body).not.toHaveProperty("sessionId");
		expect(accept.body).not.toHaveProperty("cwd");
		expect(accept.body).not.toHaveProperty("branch");
		expect(accept.body).not.toHaveProperty("worktreePath");
		expect(accept.body).not.toHaveProperty("repoPath");
		expect(accept.body).not.toHaveProperty("sandboxed");
		expect(requests.some((r) => r.method === "POST" && r.path === "/api/goals")).toBe(false);
	});

	it("retains an ineligible restored Current session selection, blocks Create, and recovers through New worktree", async () => {
		eligibility = {
			mode: "current-session",
			eligible: false,
			reason: "Current session unavailable — this session already belongs to a goal.",
		};
		await mount("current-session");
		await waitFor(() => expect(host.querySelector("[data-testid='goal-form-worktree-current-unavailable']")?.textContent).toContain("already belongs to a goal"));
		const current = host.querySelector("[data-testid='goal-form-worktree-current-session']") as HTMLInputElement;
		expect(current.checked).toBe(true);
		expect(current.disabled).toBe(true);
		expect((host.querySelector("[data-testid='proposal-primary-submit'] button") as HTMLButtonElement).disabled).toBe(true);

		(host.querySelector("[data-testid='goal-form-worktree-new']") as HTMLInputElement).click();
		await waitFor(() => expect(requests.some((r) => r.method === "PUT" && r.body?.mode === "new-worktree")).toBe(true));
		await waitFor(() => expect((host.querySelector("[data-testid='proposal-primary-submit'] button") as HTMLButtonElement).disabled).toBe(false));
	});

	it("refreshes eligibility across owner idle → streaming → idle status transitions", async () => {
		eligibility.mode = "current-session";
		await mount("current-session");
		await waitFor(() => expect((host.querySelector("[data-testid='goal-form-worktree-current-session']") as HTMLInputElement).disabled).toBe(false));
		const initialGets = requests.filter((request) => request.method === "GET" && request.path.endsWith("/worktree-mode")).length;

		eligibility = {
			mode: "current-session",
			eligible: false,
			reason: "Current session must be idle.",
		};
		updateLocalSessionStatus(OWNER, "streaming");
		await waitFor(() => expect((host.querySelector("[data-testid='goal-form-worktree-current-session']") as HTMLInputElement).disabled).toBe(true));
		await waitFor(() => expect(host.querySelector("[data-testid='goal-form-worktree-current-unavailable']")?.textContent).toContain("must be idle"));
		expect(requests.filter((request) => request.method === "GET" && request.path.endsWith("/worktree-mode")).length).toBeGreaterThan(initialGets);
		expect((host.querySelector("[data-testid='proposal-primary-submit'] button") as HTMLButtonElement).disabled).toBe(true);

		eligibility = {
			mode: "current-session",
			eligible: true,
			branch: "session/proposal",
			worktreePath: "/repo-wt/session-owner",
			componentCount: 1,
		};
		updateLocalSessionStatus(OWNER, "idle");
		await waitFor(() => expect((host.querySelector("[data-testid='goal-form-worktree-current-session']") as HTMLInputElement).disabled).toBe(false));
		expect((host.querySelector("[data-testid='proposal-primary-submit'] button") as HTMLButtonElement).disabled).toBe(false);
	});

	it("refreshes eligibility when a session-list snapshot changes owner relation metadata", async () => {
		eligibility.mode = "current-session";
		await mount("current-session");
		await waitFor(() => expect((host.querySelector("[data-testid='goal-form-worktree-current-session']") as HTMLInputElement).disabled).toBe(false));

		eligibility = {
			mode: "current-session",
			eligible: false,
			reason: "Current session already belongs to another Bobbit workflow.",
		};
		sessionSnapshot = state.gatewaySessions.map((session) => session.id === OWNER
			? { ...session, role: "reviewer" }
			: { ...session });
		await refreshSessions();
		await waitFor(() => expect(host.querySelector("[data-testid='goal-form-worktree-current-unavailable']")?.textContent).toContain("already belongs"));
		expect((host.querySelector("[data-testid='goal-form-worktree-current-session']") as HTMLInputElement).disabled).toBe(true);
		expect((host.querySelector("[data-testid='proposal-primary-submit'] button") as HTMLButtonElement).disabled).toBe(true);

		eligibility = {
			mode: "current-session",
			eligible: true,
			branch: "session/proposal",
			worktreePath: "/repo-wt/session-owner",
			componentCount: 1,
		};
		sessionSnapshot = state.gatewaySessions.map((session) => session.id === OWNER
			? { ...session, role: undefined }
			: { ...session });
		await refreshSessions();
		await waitFor(() => expect((host.querySelector("[data-testid='goal-form-worktree-current-session']") as HTMLInputElement).disabled).toBe(false));
	});

	it("revalidates immediately before acceptance and blocks a newly ineligible owner", async () => {
		eligibility.mode = "current-session";
		await mount("current-session");
		await waitFor(() => expect((host.querySelector("[data-testid='proposal-primary-submit'] button") as HTMLButtonElement).disabled).toBe(false));
		const getsBeforeCreate = requests.filter((request) => request.method === "GET" && request.path.endsWith("/worktree-mode")).length;
		eligibility = {
			mode: "current-session",
			eligible: false,
			reason: "Current session must be idle.",
		};

		(host.querySelector("[data-testid='proposal-primary-submit'] button") as HTMLButtonElement).click();
		await waitFor(() => expect(host.querySelector("[data-testid='goal-form-worktree-current-unavailable']")?.textContent).toContain("must be idle"));
		expect(requests.filter((request) => request.method === "GET" && request.path.endsWith("/worktree-mode")).length).toBeGreaterThan(getsBeforeCreate);
		expect(requests.some((request) => request.method === "POST" && request.path.endsWith("/proposal/goal/accept"))).toBe(false);
		expect((host.querySelector("[data-testid='proposal-primary-submit'] button") as HTMLButtonElement).disabled).toBe(true);
	});
});
