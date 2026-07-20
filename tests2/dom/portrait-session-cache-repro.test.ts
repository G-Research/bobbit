import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	backToSessions,
	connectToSession,
	disconnectGateway,
	flushAndTeardownDraft,
	selectSession,
	terminateSession,
	uncacheSession,
} from "../../src/app/session-manager.js";
import { GW_SESSION_KEY, GW_TOKEN_KEY, GW_URL_KEY, setRenderApp, state } from "../../src/app/state.js";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import type { ChatPanel } from "../../src/ui/ChatPanel.js";
import * as dialogsLazy from "../../src/app/dialogs-lazy.js";
import * as packEntrypoints from "../../src/app/pack-entrypoints.js";
import * as packPanels from "../../src/app/pack-panels.js";
import * as packRenderers from "../../src/app/pack-renderers.js";
import * as proposalPanelsLazy from "../../src/app/proposal-panels-lazy.js";
import * as reviewSourcesLazy from "../../src/app/review-sources-lazy.js";
import { startPreviewSubscription, stopPreviewSubscription } from "../../src/app/preview-panel.js";
import {
	activeInboxSessionId,
	activeInboxStaffId,
	startInboxSubscription,
	stopInboxSubscription,
} from "../../src/app/inbox-panel.js";

const SESSION_A = "portrait-cache-a";
const SESSION_B = "portrait-cache-b";
const trackedSessionIds = new Set<string>();

interface FetchRecord {
	url: string;
	method: string;
	body?: BodyInit | null;
}

const fetchRecords: FetchRecord[] = [];
let freshConnectSpy: ReturnType<typeof vi.spyOn>;
let resetProjectProposalSpy: ReturnType<typeof vi.spyOn>;

class MockRemoteAgent {
	connected: boolean;
	gatewaySessionId: string;
	disconnect: ReturnType<typeof vi.fn>;
	registerHostApiTransports = vi.fn();

	constructor(sessionId: string, connected = true) {
		this.gatewaySessionId = sessionId;
		this.connected = connected;
		this.disconnect = vi.fn(() => {
			this.connected = false;
		});
	}
}

class MockChatPanel {
	agent?: MockRemoteAgent;
	agentInterface?: {
		session?: MockRemoteAgent;
		projectId?: string;
		gitRepoKnown: "unknown" | "yes" | "no" | "hidden";
		gitStatusLoading: boolean;
		bgProcesses: unknown[];
		requestUpdate: ReturnType<typeof vi.fn>;
		addEventListener: ReturnType<typeof vi.fn>;
		removeEventListener: ReturnType<typeof vi.fn>;
	};
	classList = { add: vi.fn(), remove: vi.fn() };
	addEventListener = vi.fn();

	constructor(agent?: MockRemoteAgent, interfaceSession: MockRemoteAgent | undefined = agent) {
		this.agent = agent;
		this.agentInterface = {
			session: interfaceSession,
			gitRepoKnown: "unknown",
			gitStatusLoading: false,
			bgProcesses: [],
			requestUpdate: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		};
	}
}

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	close = vi.fn();
	addEventListener = vi.fn();
	onerror: ((event: Event) => void) | null = null;

	constructor(_url: string | URL, _init?: EventSourceInit) {
		FakeEventSource.instances.push(this);
	}
}

function genericPayload(): Record<string, unknown> {
	return {
		changed: false,
		generation: 1,
		sessions: [],
		goals: [],
		projects: [],
		tools: [],
		packs: [],
		contributions: [],
		entries: [],
		processes: [],
		proposals: [],
		children: [],
		count: 0,
	};
}

function responseFor(input: RequestInfo | URL, init?: RequestInit): Response {
	const rawUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(rawUrl, "http://localhost");
	const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
	fetchRecords.push({ url: `${url.pathname}${url.search}`, method, body: init?.body });

	if (method === "DELETE") return new Response(null, { status: 204 });
	if (url.pathname.endsWith("/draft") && method === "GET") return new Response(null, { status: 204 });
	if (url.pathname === "/api/preview/mount") return new Response(null, { status: 404 });
	if (url.pathname.endsWith("/side-panel-workspace")) {
		return Response.json({
			version: 1,
			tabs: [],
			activeTabId: "",
			sizeMode: "split",
			metadata: { migratedFromLocalStorageAt: 1 },
		});
	}
	if (url.pathname.includes("/inbox")) return Response.json({ entries: [] });
	if (url.pathname.endsWith("/git-status")) {
		return Response.json({ branch: "master", status: [], clean: true });
	}
	if (url.pathname.endsWith("/pr-status")) return new Response(null, { status: 204 });
	return Response.json(genericPayload());
}

function gatewaySession(id: string) {
	return {
		id,
		title: id,
		cwd: `/mock/${id}`,
		status: "idle",
		createdAt: 1,
		lastActivity: 1,
		clientCount: 1,
	};
}

function trackSession(id: string): void {
	trackedSessionIds.add(id);
	if (!state.gatewaySessions.some((session) => session.id === id)) {
		state.gatewaySessions.push(gatewaySession(id));
	}
}

function setActiveSession(
	selectedSessionId: string | null,
	agent: MockRemoteAgent | null,
	panel: MockChatPanel | null,
): void {
	if (selectedSessionId) trackSession(selectedSessionId);
	if (agent) trackedSessionIds.add(agent.gatewaySessionId);
	state.selectedSessionId = selectedSessionId;
	state.remoteAgent = agent as unknown as RemoteAgent | null;
	state.chatPanel = panel as unknown as ChatPanel | null;
	state.connectionStatus = agent?.connected ? "connected" : "disconnected";
	if (selectedSessionId) localStorage.setItem(GW_SESSION_KEY, selectedSessionId);
}

function cacheThroughDesktopSwitch(sessionId: string, targetSessionId: string): {
	agent: MockRemoteAgent;
	panel: MockChatPanel;
} {
	const agent = new MockRemoteAgent(sessionId);
	const panel = new MockChatPanel(agent);
	setActiveSession(sessionId, agent, panel);
	trackSession(targetSessionId);
	selectSession(targetSessionId);
	return { agent, panel };
}

beforeEach(() => {
	(window as any).happyDOM?.setURL?.("http://localhost/#/");
	setRenderApp(() => {});
	trackedSessionIds.clear();
	fetchRecords.length = 0;
	FakeEventSource.instances.length = 0;

	vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
		Promise.resolve(responseFor(input, init))));
	vi.stubGlobal("EventSource", FakeEventSource);
	vi.stubGlobal("setInterval", vi.fn(() => 1));
	vi.stubGlobal("clearInterval", vi.fn());
	vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
	vi.stubGlobal("cancelAnimationFrame", vi.fn());

	freshConnectSpy = vi.spyOn(RemoteAgent.prototype, "connect")
		.mockRejectedValue(new Error("SESSION_NOT_FOUND: deterministic fresh-connect boundary"));
	vi.spyOn(RemoteAgent.prototype, "requestMessages").mockImplementation(() => {});
	vi.spyOn(dialogsLazy, "confirmAction").mockResolvedValue(true);
	vi.spyOn(dialogsLazy, "showConnectionError").mockImplementation(() => {});
	vi.spyOn(packRenderers, "reconcilePackRenderersForProject").mockResolvedValue();
	vi.spyOn(packPanels, "reconcilePackPanelsForProject").mockResolvedValue();
	vi.spyOn(packEntrypoints, "reconcilePackEntrypointsForProject").mockResolvedValue();
	vi.spyOn(reviewSourcesLazy, "loadReviewSources").mockResolvedValue({
		restorePersistedReviewDocuments: vi.fn(),
	} as any);
	resetProjectProposalSpy = vi.spyOn(proposalPanelsLazy, "resetProjectProposalPanel")
		.mockImplementation(() => {});

	localStorage.clear();
	sessionStorage.clear();
	localStorage.setItem(GW_URL_KEY, "http://localhost");
	localStorage.setItem(GW_TOKEN_KEY, "test-token");
	localStorage.setItem("palette", "forest");

	state.sessionsGeneration = 1;
	state.goalsGeneration = 1;
	state.gatewaySessions = [];
	state.archivedSessions = [];
	state.goals = [];
	state.projects = [];
	state.selectedSessionId = null;
	state.connectingSessionId = null;
	state.chatPanel = null;
	state.remoteAgent = null;
	state.connectionStatus = "disconnected";
	state.appView = "authenticated";
	state.activeProjectId = null;
	state.activeProposals = {};
	state.projectProposalAcceptedBySessionId = {};
	state.assistantType = null;
	state.assistantTab = "chat";
	state.assistantHasProposal = false;
	state.isPreviewSession = false;
	state.previewPanelFullscreen = false;
	state.reviewDocuments = new Map();
	state.reviewActiveTab = "";
	state.reviewPanelOpen = false;
	state.inboxEntries = [];
	state.inboxPanelOpen = false;
	state.inboxAddDialogOpen = false;
	state.cwdDropdownOpen = false;
	state.sidePanelWorkspaceBySession = {};
	state.lastWorkspaceRevisionBySession = {};
	delete document.documentElement.dataset.palette;
	document.body.replaceChildren();
});

afterEach(() => {
	try { backToSessions(); } catch { /* best-effort singleton cleanup */ }
	try { flushAndTeardownDraft(); } catch { /* best-effort singleton cleanup */ }
	try { stopPreviewSubscription(); } catch { /* best-effort singleton cleanup */ }
	try { stopInboxSubscription(); } catch { /* best-effort singleton cleanup */ }
	try { disconnectGateway(); } catch { /* best-effort singleton cleanup */ }
	for (const id of trackedSessionIds) uncacheSession(id);

	state.selectedSessionId = null;
	state.connectingSessionId = null;
	state.chatPanel = null;
	state.remoteAgent = null;
	state.connectionStatus = "disconnected";
	setRenderApp(() => {});
	document.body.replaceChildren();
	localStorage.clear();
	sessionStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("portrait session-list cache ownership", () => {
	it("transfers a matching connected panel and agent without disconnecting and clears active ownership", () => {
		const outgoingAgent = new MockRemoteAgent(SESSION_A);
		const outgoingPanel = new MockChatPanel(outgoingAgent);
		setActiveSession(SESSION_A, outgoingAgent, outgoingPanel);

		backToSessions();

		expect(outgoingAgent.disconnect).not.toHaveBeenCalled();
		expect(state.selectedSessionId).toBeNull();
		expect(state.chatPanel).toBeNull();
		expect(state.remoteAgent).toBeNull();

		uncacheSession(SESSION_A);
		expect(outgoingAgent.disconnect).toHaveBeenCalledOnce();
	});

	it.each([
		"missing selected id",
		"missing agent",
		"missing panel",
		"disconnected agent",
		"wrong agent session",
		"unbound panel",
		"missing panel agent",
		"missing panel interface session",
		"wrong panel agent",
		"wrong panel interface session",
	] as const)("rejects %s and performs safe teardown", (scenario) => {
		let selectedId: string | null = SESSION_A;
		let activeAgent: MockRemoteAgent | null = new MockRemoteAgent(SESSION_A);
		let panel: MockChatPanel | null = new MockChatPanel(activeAgent);
		const detachedAgents: MockRemoteAgent[] = [];

		if (scenario === "missing selected id") {
			selectedId = null;
		} else if (scenario === "missing agent") {
			const detached = new MockRemoteAgent(SESSION_A);
			detachedAgents.push(detached);
			activeAgent = null;
			panel = new MockChatPanel(detached);
		} else if (scenario === "missing panel") {
			panel = null;
		} else if (scenario === "disconnected agent") {
			activeAgent!.connected = false;
		} else if (scenario === "wrong agent session") {
			activeAgent!.gatewaySessionId = SESSION_B;
			panel = new MockChatPanel(activeAgent!);
		} else if (scenario === "unbound panel") {
			panel = new MockChatPanel(undefined, undefined);
		} else if (scenario === "missing panel agent") {
			panel = new MockChatPanel(activeAgent!);
			panel.agent = undefined;
		} else if (scenario === "missing panel interface session") {
			panel = new MockChatPanel(activeAgent!);
			panel.agentInterface!.session = undefined;
		} else if (scenario === "wrong panel agent") {
			const foreign = new MockRemoteAgent(SESSION_B);
			detachedAgents.push(foreign);
			panel = new MockChatPanel(foreign, activeAgent!);
		} else {
			const foreign = new MockRemoteAgent(SESSION_B);
			detachedAgents.push(foreign);
			panel = new MockChatPanel(activeAgent!, foreign);
		}

		setActiveSession(selectedId, activeAgent, panel);
		backToSessions();

		expect(state.selectedSessionId).toBeNull();
		expect(state.chatPanel).toBeNull();
		expect(state.remoteAgent).toBeNull();
		if (activeAgent) expect(activeAgent.disconnect).toHaveBeenCalledOnce();
		for (const detached of detachedAgents) expect(detached.disconnect).not.toHaveBeenCalled();

		const activeDisconnectCount = activeAgent?.disconnect.mock.calls.length ?? 0;
		const detachedDisconnectCounts = detachedAgents.map((agent) => agent.disconnect.mock.calls.length);
		uncacheSession(SESSION_A);
		uncacheSession(SESSION_B);
		expect(activeAgent?.disconnect.mock.calls.length ?? 0).toBe(activeDisconnectCount);
		detachedAgents.forEach((agent, index) => {
			expect(agent.disconnect.mock.calls.length).toBe(detachedDisconnectCounts[index]);
		});
	});

	it("reopens a healthy cached session with exact identities, removes the entry, and creates no agent", async () => {
		const outgoingAgent = new MockRemoteAgent(SESSION_A);
		const outgoingPanel = new MockChatPanel(outgoingAgent);
		setActiveSession(SESSION_A, outgoingAgent, outgoingPanel);
		backToSessions();
		freshConnectSpy.mockClear();

		await connectToSession(SESSION_A, true);

		expect(state.selectedSessionId).toBe(SESSION_A);
		expect(state.chatPanel).toBe(outgoingPanel);
		expect(state.remoteAgent).toBe(outgoingAgent);
		expect(state.connectionStatus).toBe("connected");
		expect(outgoingAgent.registerHostApiTransports).toHaveBeenCalledOnce();
		expect(freshConnectSpy).not.toHaveBeenCalled();
		expect(outgoingAgent.disconnect).not.toHaveBeenCalled();

		uncacheSession(SESSION_A);
		expect(outgoingAgent.disconnect).not.toHaveBeenCalled();
	});

	it("evicts and disconnects a stale cached session before one fresh fallback connect", async () => {
		const { agent: staleAgent } = cacheThroughDesktopSwitch(SESSION_A, SESSION_B);
		staleAgent.connected = false;
		freshConnectSpy.mockClear();

		await connectToSession(SESSION_A, true, { onMissing: "toast" });

		expect(staleAgent.disconnect).toHaveBeenCalledOnce();
		expect(freshConnectSpy).toHaveBeenCalledOnce();
		expect(freshConnectSpy.mock.instances[0]).not.toBe(staleAgent);
		expect(state.chatPanel).toBeNull();
		expect(state.remoteAgent).toBeNull();

		uncacheSession(SESSION_A);
		expect(staleAgent.disconnect).toHaveBeenCalledOnce();
	});

	it("keeps ten cached sessions and disconnects only the oldest on the eleventh admission", () => {
		const agents: MockRemoteAgent[] = [];
		for (let index = 0; index < 11; index++) {
			const id = `lru-session-${String(index).padStart(2, "0")}`;
			const target = `lru-target-${String(index).padStart(2, "0")}`;
			agents.push(cacheThroughDesktopSwitch(id, target).agent);
		}

		expect(agents[0].disconnect).toHaveBeenCalledOnce();
		for (const retained of agents.slice(1)) expect(retained.disconnect).not.toHaveBeenCalled();

		for (let index = 0; index < 11; index++) {
			uncacheSession(`lru-session-${String(index).padStart(2, "0")}`);
		}
		expect(agents[0].disconnect).toHaveBeenCalledOnce();
		for (const retained of agents.slice(1)) expect(retained.disconnect).toHaveBeenCalledOnce();
	});

	it("explicit uncache removes the reusable entry and forces a fresh connect", async () => {
		const { agent } = cacheThroughDesktopSwitch(SESSION_A, SESSION_B);
		uncacheSession(SESSION_A);
		uncacheSession(SESSION_A);
		expect(agent.disconnect).toHaveBeenCalledOnce();
		freshConnectSpy.mockClear();

		await connectToSession(SESSION_A, true, { onMissing: "toast" });

		expect(freshConnectSpy).toHaveBeenCalledOnce();
		expect(freshConnectSpy.mock.instances[0]).not.toBe(agent);
	});

	it("evicts a cached session removed externally and forces a fresh connect", async () => {
		const { agent: cachedAgent } = cacheThroughDesktopSwitch(SESSION_A, SESSION_B);
		freshConnectSpy.mockResolvedValue(undefined);

		await connectToSession(SESSION_B, true, { onMissing: "toast" });
		const notifyingAgent = state.remoteAgent;
		expect(notifyingAgent).toBeInstanceOf(RemoteAgent);
		expect(notifyingAgent).not.toBe(cachedAgent);
		expect(notifyingAgent?.onSessionRemoved).toEqual(expect.any(Function));
		freshConnectSpy.mockClear();

		notifyingAgent!.onSessionRemoved!(SESSION_A, "archived");

		expect(cachedAgent.disconnect).toHaveBeenCalledOnce();
		expect(state.gatewaySessions.some((session) => session.id === SESSION_A)).toBe(false);

		await connectToSession(SESSION_A, true, { onMissing: "toast" });

		expect(freshConnectSpy).toHaveBeenCalledOnce();
		expect(freshConnectSpy.mock.instances[0]).not.toBe(cachedAgent);
		expect(state.remoteAgent).not.toBe(cachedAgent);
	});

	it("disconnectGateway disconnects active and cached agents and leaves no reusable entry", async () => {
		const { agent: cachedAgent } = cacheThroughDesktopSwitch(SESSION_A, SESSION_B);
		const activeAgent = new MockRemoteAgent(SESSION_B);
		setActiveSession(SESSION_B, activeAgent, new MockChatPanel(activeAgent));

		disconnectGateway();

		expect(activeAgent.disconnect).toHaveBeenCalledOnce();
		expect(cachedAgent.disconnect).toHaveBeenCalledOnce();
		expect(state.selectedSessionId).toBeNull();
		expect(state.remoteAgent).toBeNull();
		uncacheSession(SESSION_A);
		expect(cachedAgent.disconnect).toHaveBeenCalledOnce();
		freshConnectSpy.mockClear();

		await connectToSession(SESSION_A, true, { onMissing: "toast" });
		expect(freshConnectSpy).toHaveBeenCalledOnce();
	});

	it("terminate/archive uncaches the session and cannot reuse it", async () => {
		const { agent: cachedAgent } = cacheThroughDesktopSwitch(SESSION_A, SESSION_B);
		freshConnectSpy.mockClear();
		fetchRecords.length = 0;

		await terminateSession(SESSION_A);

		expect(dialogsLazy.confirmAction).toHaveBeenCalledOnce();
		expect(cachedAgent.disconnect).toHaveBeenCalledOnce();
		expect(fetchRecords).toContainEqual(expect.objectContaining({
			url: `/api/sessions/${SESSION_A}`,
			method: "DELETE",
		}));
		uncacheSession(SESSION_A);
		expect(cachedAgent.disconnect).toHaveBeenCalledOnce();

		await connectToSession(SESSION_A, true, { onMissing: "toast" });
		expect(freshConnectSpy).toHaveBeenCalledOnce();
	});

	it("preserves back navigation proposal, review, preview, inbox, draft, storage, and route cleanup", async () => {
		const outgoingAgent = new MockRemoteAgent(SESSION_A);
		const outgoingPanel = new MockChatPanel(outgoingAgent);
		setActiveSession(SESSION_A, outgoingAgent, outgoingPanel);
		backToSessions();
		await connectToSession(SESSION_A, true);

		const editor = { value: "portrait prompt draft" };
		const querySelector = document.querySelector.bind(document);
		vi.spyOn(document, "querySelector").mockImplementation(((selector: string) =>
			selector === "message-editor" ? editor as any : querySelector(selector)) as typeof document.querySelector);
		sessionStorage.setItem(`bobbit_draft_${SESSION_A}`, editor.value);

		state.activeProposals = {
			goal: { sessionId: SESSION_A, fields: { title: "Goal" }, streaming: false, rev: 1 },
			role: { sessionId: SESSION_A, fields: { name: "Role" }, streaming: false, rev: 1 },
			project: { sessionId: SESSION_A, fields: { name: "Project" }, streaming: false, rev: 1 },
		};
		state.projectProposalAcceptedBySessionId[SESSION_A] = true;
		state.assistantType = "goal";
		state.assistantTab = "preview";
		state.assistantHasProposal = true;
		state.reviewDocuments = new Map([["review", { title: "review", markdown: "body" }]]);
		state.reviewActiveTab = "review";
		state.reviewPanelOpen = true;
		state.isPreviewSession = true;
		state.previewPanelFullscreen = true;
		state.cwdDropdownOpen = true;
		state.inboxEntries = [{ id: "entry" } as any];
		state.inboxPanelOpen = true;
		state.inboxAddDialogOpen = true;
		document.documentElement.dataset.palette = "temporary-project-palette";

		startPreviewSubscription(SESSION_A);
		startInboxSubscription(SESSION_A, "staff-1");
		expect(activeInboxSessionId()).toBe(SESSION_A);
		expect(activeInboxStaffId()).toBe("staff-1");
		expect(FakeEventSource.instances).toHaveLength(1);
		const previewSource = FakeEventSource.instances[0];
		resetProjectProposalSpy.mockClear();
		fetchRecords.length = 0;

		backToSessions();

		expect(outgoingAgent.disconnect).not.toHaveBeenCalled();
		expect(state.selectedSessionId).toBeNull();
		expect(state.chatPanel).toBeNull();
		expect(state.remoteAgent).toBeNull();
		expect(state.activeProposals.goal).toBeUndefined();
		expect(state.activeProposals.role).toBeUndefined();
		expect(state.activeProposals.project).toBeUndefined();
		expect(state.projectProposalAcceptedBySessionId[SESSION_A]).toBeUndefined();
		expect(resetProjectProposalSpy).toHaveBeenCalledOnce();
		expect(state.assistantType).toBeNull();
		expect(state.assistantTab).toBe("chat");
		expect(state.assistantHasProposal).toBe(false);
		expect(state.reviewDocuments.size).toBe(0);
		expect(state.reviewActiveTab).toBe("");
		expect(state.reviewPanelOpen).toBe(false);
		expect(state.isPreviewSession).toBe(false);
		expect(state.previewPanelFullscreen).toBe(false);
		expect(previewSource.close).toHaveBeenCalledOnce();
		expect(activeInboxSessionId()).toBeNull();
		expect(activeInboxStaffId()).toBeNull();
		expect(state.inboxEntries).toEqual([]);
		expect(state.inboxPanelOpen).toBe(false);
		expect(state.inboxAddDialogOpen).toBe(false);
		expect(state.cwdDropdownOpen).toBe(false);
		expect(localStorage.getItem(GW_SESSION_KEY)).toBeNull();
		expect(localStorage.getItem(GW_URL_KEY)).toBe("http://localhost");
		expect(sessionStorage.getItem(`bobbit_draft_${SESSION_A}`)).toBe(editor.value);
		expect(document.documentElement.dataset.palette).toBeUndefined();
		expect(window.location.hash).toBe("#/");
		expect(fetchRecords).toContainEqual(expect.objectContaining({
			url: `/api/sessions/${SESSION_A}/draft`,
			method: "PUT",
		}));
		expect(fetchRecords.some((record) =>
			record.method === "GET" && record.url.startsWith("/api/sessions?since="),
		)).toBe(true);
	});
});
