import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const annotationStoreMocks = vi.hoisted(() => ({
	initAnnotationStore: vi.fn(),
}));

vi.mock("../../src/ui/components/review/AnnotationStore.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../../src/ui/components/review/AnnotationStore.js")>(),
	initAnnotationStore: annotationStoreMocks.initAnnotationStore,
}));

import {
	backToSessions,
	connectToSession,
	disconnectGateway,
	flushAndTeardownDraft,
	selectSession,
	uncacheSession,
} from "../../src/app/session-manager.js";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import type { SidePanelWorkspace } from "../../src/app/side-panel-workspace.js";
import {
	GW_SESSION_KEY,
	GW_TOKEN_KEY,
	GW_URL_KEY,
	setRenderApp,
	state,
	type GatewaySession,
} from "../../src/app/state.js";
import { ChatPanel } from "../../src/ui/ChatPanel.js";
import { storage } from "../../src/app/storage.js";
import * as dialogsLazy from "../../src/app/dialogs-lazy.js";
import * as packEntrypoints from "../../src/app/pack-entrypoints.js";
import * as packPanels from "../../src/app/pack-panels.js";
import * as packRenderers from "../../src/app/pack-renderers.js";
import * as reviewSourcesLazy from "../../src/app/review-sources-lazy.js";
import { stopPreviewSubscription } from "../../src/app/preview-panel.js";
import { stopInboxSubscription } from "../../src/app/inbox-panel.js";
import {
	clearReviewSubmitted,
	clearReviewTombstone,
	getReviewTombstone,
	isReviewSubmitted,
	markReviewSubmitted,
	setReviewTombstone,
} from "../../src/ui/components/review/AnnotationStore.js";
import * as reviewSources from "../../src/app/review-sources.js";

const SESSION_A = "cold-session-a";
const SESSION_B = "cold-session-b";
const TRANSCRIPT_SIZE = 321;
const trackedSessions = [SESSION_A, SESSION_B] as const;

type TimelineEntry =
	| { kind: "ws"; sessionId: string; frame: Record<string, unknown> }
	| { kind: "rest"; sessionId?: string; path: string; method: string };

interface DeferredGate {
	promise: Promise<void>;
	release: () => void;
	settled: boolean;
}

interface WorkspaceDeleteAttempt {
	tabId: string;
	baseRevision?: number;
}

type WorkspaceDeleteOutcome =
	| { kind: "confirmed-204" }
	| { kind: "conflict-409"; current: SidePanelWorkspace }
	| { kind: "network-error"; message: string };

const timeline: TimelineEntry[] = [];
const workspaceGates = new Map<string, DeferredGate>();
const workspaceFetchCount = new Map<string, number>();
const authoritativeWorkspaces = new Map<string, SidePanelWorkspace>();
const workspaceDeleteOutcomes = new Map<string, WorkspaceDeleteOutcome[]>();
const workspaceDeleteAttempts = new Map<string, WorkspaceDeleteAttempt[]>();
const transcripts = new Map<string, any[]>();
const projectDrafts = new Map<string, Record<string, unknown>>();
let sessionListGate: DeferredGate | null = null;
let sessionListFetchCount = 0;
let sessionListResponseSessions: GatewaySession[] | null = null;

function deferredGate(): DeferredGate {
	let releasePromise!: () => void;
	const gate: DeferredGate = {
		promise: new Promise<void>((resolve) => { releasePromise = resolve; }),
		release: () => {},
		settled: false,
	};
	gate.release = () => {
		if (gate.settled) return;
		gate.settled = true;
		releasePromise();
	};
	return gate;
}

function gateFor(sessionId: string): DeferredGate {
	let gate = workspaceGates.get(sessionId);
	if (!gate) {
		gate = deferredGate();
		workspaceGates.set(sessionId, gate);
	}
	return gate;
}

function gatewaySession(id: string): GatewaySession {
	return {
		id,
		title: id,
		cwd: `/fixture/${id}`,
		status: "idle",
		createdAt: 1,
		lastActivity: 1,
		clientCount: 1,
	};
}

function transcriptFor(sessionId: string): any[] {
	return Array.from({ length: TRANSCRIPT_SIZE }, (_, index) => ({
		id: `${sessionId}-message-${index}`,
		role: index % 2 === 0 ? "user" : "assistant",
		content: `${sessionId} transcript row ${index}`,
		timestamp: new Date(1_700_000_000_000 + index).toISOString(),
	}));
}

function workspaceFor(sessionId: string): SidePanelWorkspace {
	const stamp = sessionId === SESSION_A ? 10 : 20;
	return {
		version: 1,
		sessionId,
		revision: stamp,
		tabs: [
			{
				id: "preview:entry:index.html",
				kind: "preview",
				title: `${sessionId} preview`,
				label: "index.html",
				source: { type: "preview", sessionId, entry: "index.html", live: true },
				state: { contentHash: `${sessionId}-preview-hash`, mtime: stamp },
				updatedAt: stamp,
			},
			{
				id: "proposal:goal",
				kind: "proposal",
				title: `${sessionId} proposal`,
				label: "Goal",
				source: { type: "proposal", sessionId, proposalType: "goal" },
				state: { fields: { title: `${sessionId} restored goal`, spec: "restored spec" } },
				updatedAt: stamp,
			},
			{
				id: `review:${sessionId}-review`,
				kind: "review",
				title: `${sessionId} review`,
				label: "Review",
				source: {
					type: "review",
					sessionId,
					documentId: `${sessionId}-review`,
					title: `${sessionId} review`,
				},
				state: { markdown: `# ${sessionId} review` },
				updatedAt: stamp,
			},
		],
		activeTabId: "preview:entry:index.html",
		sizeMode: "fullscreen",
		metadata: { migratedFromLocalStorageAt: stamp },
		updatedAt: stamp,
	};
}

function cloneWorkspace(workspace: SidePanelWorkspace): SidePanelWorkspace {
	return JSON.parse(JSON.stringify(workspace)) as SidePanelWorkspace;
}

function authoritativeWorkspace(sessionId: string): SidePanelWorkspace {
	let workspace = authoritativeWorkspaces.get(sessionId);
	if (!workspace) {
		workspace = workspaceFor(sessionId);
		authoritativeWorkspaces.set(sessionId, workspace);
	}
	return workspace;
}

function requestBaseRevision(input: RequestInfo | URL, init: RequestInit | undefined, url: URL): number | undefined {
	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
	const ifMatch = headers.get("if-match")?.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
	if (ifMatch) {
		const parsed = Number(ifMatch);
		if (Number.isInteger(parsed) && parsed >= 0) return parsed;
	}
	const queryRevision = Number(url.searchParams.get("baseRevision"));
	if (url.searchParams.has("baseRevision") && Number.isInteger(queryRevision) && queryRevision >= 0) return queryRevision;
	if (typeof init?.body === "string") {
		try {
			const parsed = JSON.parse(init.body) as { baseRevision?: unknown };
			if (typeof parsed.baseRevision === "number" && Number.isInteger(parsed.baseRevision) && parsed.baseRevision >= 0) {
				return parsed.baseRevision;
			}
		} catch { /* no JSON revision */ }
	}
	return undefined;
}

function sessionIdFromPath(path: string): string | undefined {
	return /^\/api\/sessions\/([^/?]+)/.exec(path)?.[1];
}

async function fetchFixture(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const rawUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(rawUrl, "http://localhost");
	const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
	const sessionId = sessionIdFromPath(url.pathname);
	timeline.push({ kind: "rest", path: `${url.pathname}${url.search}`, method, ...(sessionId ? { sessionId } : {}) });

	const openTabMatch = url.pathname.endsWith("/side-panel-workspace/open");
	if (openTabMatch && sessionId && method === "POST") {
		const current = authoritativeWorkspace(sessionId);
		const body = typeof init?.body === "string" ? JSON.parse(init.body) as { tab?: any; focus?: boolean } : {};
		const incoming = body.tab;
		const tabs = incoming
			? [...current.tabs.filter((tab) => tab.id !== incoming.id), incoming]
			: current.tabs;
		const next = {
			...current,
			revision: current.revision + 1,
			tabs,
			activeTabId: body.focus !== false && incoming ? incoming.id : current.activeTabId,
			updatedAt: current.updatedAt + 1,
		};
		authoritativeWorkspaces.set(sessionId, next);
		return Response.json(cloneWorkspace(next));
	}

	const deleteTabMatch = url.pathname.match(/\/side-panel-workspace\/tabs\/([^/]+)$/);
	if (deleteTabMatch && sessionId && method === "DELETE") {
		const attempt: WorkspaceDeleteAttempt = {
			tabId: decodeURIComponent(deleteTabMatch[1]),
			baseRevision: requestBaseRevision(input, init, url),
		};
		const attempts = workspaceDeleteAttempts.get(sessionId) || [];
		attempts.push(attempt);
		workspaceDeleteAttempts.set(sessionId, attempts);
		const outcomes = workspaceDeleteOutcomes.get(sessionId) || [];
		const outcome = outcomes.shift() || { kind: "confirmed-204" as const };
		if (outcome.kind === "network-error") throw new TypeError(outcome.message);
		if (outcome.kind === "conflict-409") {
			authoritativeWorkspaces.set(sessionId, cloneWorkspace(outcome.current));
			return Response.json({
				error: "Stale side-panel workspace revision",
				code: "STALE_REVISION",
				workspace: cloneWorkspace(outcome.current),
			}, { status: 409 });
		}
		const current = authoritativeWorkspace(sessionId);
		const tabs = current.tabs.filter((tab) => tab.id !== attempt.tabId);
		const activeTabId = tabs.some((tab) => tab.id === current.activeTabId)
			? current.activeTabId
			: tabs[0]?.id || "";
		authoritativeWorkspaces.set(sessionId, {
			...current,
			revision: current.revision + 1,
			tabs,
			activeTabId,
			updatedAt: current.updatedAt + 1,
		});
		return new Response(null, { status: 204 });
	}
	if (url.pathname.endsWith("/side-panel-workspace") && sessionId) {
		workspaceFetchCount.set(sessionId, (workspaceFetchCount.get(sessionId) || 0) + 1);
		await gateFor(sessionId).promise;
		return Response.json(cloneWorkspace(authoritativeWorkspace(sessionId)));
	}
	if (url.pathname.endsWith("/draft") && method === "GET") {
		const projectDraft = sessionId && url.searchParams.get("type") === "project"
			? projectDrafts.get(sessionId)
			: undefined;
		return projectDraft
			? Response.json({ data: projectDraft })
			: new Response(null, { status: 204 });
	}
	if (url.pathname.endsWith("/git-status")) {
		return Response.json({ branch: "master", status: [], clean: true });
	}
	if (url.pathname.endsWith("/bg-processes")) return Response.json({ processes: [] });
	if (url.pathname.endsWith("/pr-status")) return new Response(null, { status: 204 });
	if (url.pathname === "/api/preview/mount") return new Response(null, { status: 404 });
	if (url.pathname === "/api/sessions") {
		sessionListFetchCount++;
		const delayedList = sessionListGate;
		if (delayedList && sessionListFetchCount === 1) await delayedList.promise;
		if (sessionListResponseSessions) {
			return Response.json({ changed: true, generation: 2, sessions: sessionListResponseSessions });
		}
		return Response.json({ changed: false, generation: 1, sessions: state.gatewaySessions });
	}
	if (url.pathname === "/api/goals") {
		return Response.json({ changed: false, generation: 1, goals: [] });
	}
	if (url.pathname === "/api/projects") return Response.json({ projects: [] });
	if (method === "DELETE") return new Response(null, { status: 204 });
	return Response.json({
		changed: false,
		generation: 1,
		sessions: state.gatewaySessions,
		goals: [],
		projects: [],
		entries: [],
		processes: [],
		proposals: [],
	});
}

class ControlledWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: ControlledWebSocket[] = [];

	readonly sessionId: string;
	readyState = ControlledWebSocket.OPEN;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(url: string) {
		this.sessionId = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
		ControlledWebSocket.instances.push(this);
		queueMicrotask(() => {
			if (this.readyState !== ControlledWebSocket.OPEN) return;
			this.onopen?.();
			queueMicrotask(() => this.receive({ type: "auth_ok" }));
		});
	}

	send(raw: string): void {
		const frame = JSON.parse(raw) as Record<string, unknown>;
		timeline.push({ kind: "ws", sessionId: this.sessionId, frame });
		if (frame.type === "get_messages") {
			const data = transcripts.get(this.sessionId) || [];
			queueMicrotask(() => this.receive({ type: "messages", data }));
		}
	}

	receive(frame: Record<string, unknown>): void {
		if (this.readyState !== ControlledWebSocket.OPEN) return;
		this.onmessage?.({ data: JSON.stringify(frame) });
	}

	close(): void {
		this.readyState = ControlledWebSocket.CLOSED;
	}
}

function renderTranscript(sessionId: string, agent: any): void {
	let host = document.querySelector(`[data-cold-transcript="${sessionId}"]`) as HTMLElement | null;
	if (!host) {
		document.querySelectorAll("[data-cold-transcript]").forEach((node) => node.remove());
		host = document.createElement("section");
		host.dataset.coldTranscript = sessionId;
		document.body.append(host);
	}
	const fragment = document.createDocumentFragment();
	for (const message of agent.state.messages || []) {
		const row = document.createElement("div");
		row.dataset.messageId = message.id;
		row.textContent = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		fragment.append(row);
	}
	host.replaceChildren(fragment);
}

function installChatPanelHarness(): void {
	vi.spyOn(ChatPanel.prototype, "setAgent").mockImplementation(async function (this: ChatPanel, agent: any) {
		this.agent = agent;
		let agentInterface: any;
		const composer = {
			onSend: async (input: string) => agent.prompt(input),
			onSteerSend: async (input: string) => agent.steer(input),
		};
		agentInterface = {
			session: agent,
			projectId: undefined,
			cwd: "",
			gitRepoKnown: "unknown",
			gitStatusLoading: false,
			bgProcesses: [],
			requestUpdate: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			querySelector: vi.fn((selector: string) => {
				if (selector !== "message-editor") return null;
				const composerHidden = agentInterface.archived
					|| (agentInterface.nonInteractive && !agent.state.isStreaming);
				return composerHidden ? null : composer;
			}),
		};
		this.agentInterface = agentInterface;
		const sessionId = agent.gatewaySessionId as string;
		let scheduled = false;
		const draw = () => {
			scheduled = false;
			renderTranscript(sessionId, agent);
		};
		draw();
		agent.subscribe((event: any) => {
			if (event?.type !== "message_end" || scheduled) return;
			scheduled = true;
			queueMicrotask(draw);
		});
	});
}

async function waitFor(predicate: () => boolean, failure: string): Promise<void> {
	for (let attempt = 0; attempt < 250; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(failure);
}

function getMessagesIndex(sessionId: string): number {
	return timeline.findIndex((entry) =>
		entry.kind === "ws" && entry.sessionId === sessionId && entry.frame.type === "get_messages");
}

const FIXTURE_BOOTSTRAP_REST_PATHS = new Set([
	"/api/preview/mount",
]);

function isRelevantHydrationRestPath(path: string): boolean {
	const pathname = path.split("?", 1)[0];
	if (FIXTURE_BOOTSTRAP_REST_PATHS.has(pathname)) return false;
	if (pathname === "/api/sessions" || pathname === "/api/projects" || pathname === "/api/goals") return true;
	return /^\/api\/sessions\/[^/]+\/(?:side-panel-workspace|draft|git-status)$/.test(pathname);
}

function firstRelevantRestIndex(): number {
	return timeline.findIndex((entry) => entry.kind === "rest" && isRelevantHydrationRestPath(entry.path));
}

function finalTranscriptRow(sessionId: string): HTMLElement | null {
	return document.querySelector(
		`[data-cold-transcript="${sessionId}"] [data-message-id="${sessionId}-message-${TRANSCRIPT_SIZE - 1}"]`,
	);
}

function workspaceMirrorShape(workspace: SidePanelWorkspace | undefined) {
	if (!workspace) return undefined;
	return {
		sessionId: workspace.sessionId,
		revision: workspace.revision,
		tabs: workspace.tabs.map((tab) => ({ id: tab.id, kind: tab.kind, title: tab.title, label: tab.label })),
		activeTabId: workspace.activeTabId,
		sizeMode: workspace.sizeMode,
	};
}

function expectServerConsistentWorkspaceMirrors(sessionId: string, failureToken: string): void {
	const authoritative = authoritativeWorkspace(sessionId);
	const expectedShape = workspaceMirrorShape(authoritative);
	expect.soft(
		workspaceMirrorShape(state.sidePanelWorkspaceBySession[sessionId]),
		`${failureToken}: keyed workspace diverged from the authoritative server workspace`,
	).toEqual(expectedShape);
	expect.soft(
		workspaceMirrorShape((state as any).panelWorkspace as SidePanelWorkspace | undefined),
		`${failureToken}: foreground panelWorkspace diverged from the authoritative server workspace`,
	).toEqual(expectedShape);
	expect.soft(
		state.lastWorkspaceRevisionBySession[sessionId],
		`${failureToken}: tracked revision diverged from the authoritative server revision`,
	).toBe(authoritative.revision);
	expect.soft(
		state.panelTabs.map((tab) => ({ id: tab.id, kind: tab.kind, title: tab.title, label: tab.label })),
		`${failureToken}: foreground panel tabs diverged from the authoritative server tabs`,
	).toEqual(authoritative.tabs.map((tab) => ({ id: tab.id, kind: tab.kind, title: tab.title, label: tab.label })));
	expect.soft(state.activePanelTabId, `${failureToken}: foreground active tab diverged from the server`).toBe(authoritative.activeTabId);
	expect.soft(state.previewPanelFullscreen, `${failureToken}: foreground size mode diverged from the server`).toBe(
		authoritative.sizeMode === "fullscreen",
	);
}

beforeEach(() => {
	(window as any).happyDOM?.setURL?.("http://localhost/#/");
	setRenderApp(() => {});
	timeline.length = 0;
	workspaceGates.clear();
	workspaceFetchCount.clear();
	authoritativeWorkspaces.clear();
	workspaceDeleteOutcomes.clear();
	workspaceDeleteAttempts.clear();
	projectDrafts.clear();
	sessionListGate = null;
	sessionListFetchCount = 0;
	sessionListResponseSessions = null;
	ControlledWebSocket.instances.length = 0;
	transcripts.clear();
	for (const sessionId of trackedSessions) {
		transcripts.set(sessionId, transcriptFor(sessionId));
		authoritativeWorkspaces.set(sessionId, workspaceFor(sessionId));
	}

	vi.stubGlobal("WebSocket", ControlledWebSocket);
	vi.stubGlobal("fetch", vi.fn(fetchFixture));
	vi.stubGlobal("setInterval", vi.fn(() => 1));
	vi.stubGlobal("clearInterval", vi.fn());
	vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
		queueMicrotask(() => callback(performance.now()));
		return 1;
	}));
	vi.stubGlobal("cancelAnimationFrame", vi.fn());

	installChatPanelHarness();
	vi.spyOn(storage.providerKeys, "set").mockResolvedValue();
	vi.spyOn(dialogsLazy, "showConnectionError").mockImplementation(() => {});
	vi.spyOn(packRenderers, "reconcilePackRenderersForProject").mockResolvedValue();
	vi.spyOn(packPanels, "reconcilePackPanelsForProject").mockResolvedValue();
	vi.spyOn(packEntrypoints, "reconcilePackEntrypointsForProject").mockResolvedValue();
	vi.spyOn(reviewSourcesLazy, "loadReviewSources").mockResolvedValue({
		restorePersistedReviewDocuments: (sessionId: string) => {
			if (state.selectedSessionId !== sessionId) return;
			const documentId = `${sessionId}-review`;
			const hasMatchingWorkspaceTab = state.sidePanelWorkspaceBySession[sessionId]?.tabs.some((tab) => {
				if (tab.kind !== "review") return false;
				const source = tab.source as Record<string, unknown> | undefined;
				return source?.documentId === documentId || tab.id === `review:${documentId}`;
			});
			if (!hasMatchingWorkspaceTab) return;
			const title = `${sessionId} review`;
			state.reviewDocuments = new Map([[title, { title, markdown: `# ${title}` } as any]]);
			state.reviewActiveTab = title;
			state.reviewPanelOpen = true;
		},
	} as any);
	annotationStoreMocks.initAnnotationStore.mockReset();
	annotationStoreMocks.initAnnotationStore.mockResolvedValue(undefined);

	localStorage.clear();
	sessionStorage.clear();
	localStorage.setItem(GW_URL_KEY, "http://localhost");
	localStorage.setItem(GW_TOKEN_KEY, "fixture-token");

	state.sessionsGeneration = 1;
	state.goalsGeneration = 1;
	state.gatewaySessions = trackedSessions.map(gatewaySession);
	state.archivedSessions = [];
	state.goals = [];
	state.projects = [];
	state.selectedSessionId = null;
	state.connectingSessionId = null;
	state.switchGeneration = 0;
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
	state.previewPanelMtime = 0;
	state.previewPanelEntry = "";
	state.previewPanelContentHash = "";
	state.previewPanelArtifactId = "";
	state.previewPanelFullscreen = false;
	state.previewPanelActiveTab = "preview";
	state.previewPanelTab = "chat";
	state.panelTabsBySession = {};
	state.panelTabs = [];
	state.activePanelTabId = "chat";
	state.panelWorkspaceActiveBySession = {};
	state.sidePanelWorkspaceBySession = {};
	state.lastWorkspaceRevisionBySession = {};
	delete (state as any).panelWorkspace;
	delete (state as any).__lastSidePanelUserActiveSelection;
	state.reviewDocuments = new Map();
	state.reviewActiveTab = "";
	state.reviewPanelOpen = false;
	state.inboxEntries = [];
	state.inboxPanelOpen = false;
	state.inboxAddDialogOpen = false;
	state.cwdDropdownOpen = false;
	document.body.replaceChildren();
});

afterEach(async () => {
	for (const gate of workspaceGates.values()) gate.release();
	sessionListGate?.release();
	await Promise.resolve();
	try { backToSessions(); } catch { /* singleton cleanup */ }
	try { flushAndTeardownDraft(); } catch { /* singleton cleanup */ }
	try { stopPreviewSubscription(); } catch { /* singleton cleanup */ }
	try { stopInboxSubscription(); } catch { /* singleton cleanup */ }
	try { disconnectGateway(); } catch { /* singleton cleanup */ }
	for (const sessionId of trackedSessions) {
		await clearReviewSubmitted(sessionId);
		uncacheSession(sessionId);
	}
	state.selectedSessionId = null;
	state.connectingSessionId = null;
	state.chatPanel = null;
	state.remoteAgent = null;
	setRenderApp(() => {});
	document.body.replaceChildren();
	localStorage.clear();
	sessionStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("cold session transcript/workspace ordering", () => {
	it("requests and renders 321 transcript rows before the single initial workspace fetch settles", async () => {
		const pendingConnect = connectToSession(SESSION_A, true);
		await waitFor(
			() => (workspaceFetchCount.get(SESSION_A) || 0) > 0,
			"COLD_SESSION_LOAD_ORDERING_REGRESSION: initial workspace hydration never started",
		);

		try {
			const requestIndex = getMessagesIndex(SESSION_A);
			expect(
				requestIndex,
				"COLD_SESSION_LOAD_ORDERING_REGRESSION: get_messages was blocked by pending side-panel workspace hydration",
			).toBeGreaterThanOrEqual(0);
			const restIndex = firstRelevantRestIndex();
			expect(
				restIndex,
				"COLD_SESSION_LOAD_ORDERING_REGRESSION: the fixture must observe a relevant REST hydration request",
			).toBeGreaterThanOrEqual(0);
			expect(
				requestIndex,
				"COLD_SESSION_LOAD_ORDERING_REGRESSION: get_messages must precede the first relevant REST request globally (session-list, projects, goals, workspace, draft, or git)",
			).toBeLessThan(restIndex);
			expect(
				workspaceFetchCount.get(SESSION_A),
				"COLD_SESSION_LOAD_ORDERING_REGRESSION: a cold connection must have one initial workspace owner",
			).toBe(1);

			await waitFor(
				() => finalTranscriptRow(SESSION_A) !== null,
				"COLD_SESSION_LOAD_ORDERING_REGRESSION: the 321st transcript row did not render while workspace hydration was pending",
			);
			expect(finalTranscriptRow(SESSION_A)?.textContent).toBe(`${SESSION_A} transcript row ${TRANSCRIPT_SIZE - 1}`);
			expect(gateFor(SESSION_A).settled).toBe(false);
			expect(
				state.reviewDocuments.has(`${SESSION_A} review`),
				"PERSISTED_REVIEW_HYDRATION_REGRESSION: persisted review restored before its matching workspace tab hydrated",
			).toBe(false);
		} finally {
			gateFor(SESSION_A).release();
			await pendingConnect.catch(() => {});
		}

		expect(state.sidePanelWorkspaceBySession[SESSION_A]?.tabs.map((tab) => tab.kind)).toEqual([
			"preview",
			"proposal",
			"review",
		]);
		expect(state.activePanelTabId).toBe("preview:entry:index.html");
		expect(state.previewPanelFullscreen).toBe(true);
		expect(
			state.reviewDocuments.has(`${SESSION_A} review`),
			"PERSISTED_REVIEW_HYDRATION_REGRESSION: persisted review was not restored after workspace hydration",
		).toBe(true);
		expect(finalTranscriptRow(SESSION_A)?.textContent).toBe(`${SESSION_A} transcript row ${TRANSCRIPT_SIZE - 1}`);
	});

	it("preserves a server project proposal that arrives before an empty draft restore settles", async () => {
		state.gatewaySessions = state.gatewaySessions.map((session) =>
			session.id === SESSION_A ? { ...session, assistantType: "project" } : session);
		const pendingConnect = connectToSession(SESSION_A, true);

		try {
			await waitFor(
				() => (workspaceFetchCount.get(SESSION_A) || 0) > 0
					&& typeof state.remoteAgent?.onProposal === "function",
				"PROJECT_PROPOSAL_DRAFT_RESTORE_RACE: project callback was not ready while workspace hydration was pending",
			);
			expect(gateFor(SESSION_A).settled).toBe(false);

			const fields = {
				name: "Server project proposal",
				root_path: "/fixture/server-project-proposal",
				test_command: "npm test",
			};
			state.remoteAgent?.onProposal?.("project", fields, false, 1, "rehydrate");
			expect(state.activeProposals.project).toMatchObject({
				sessionId: SESSION_A,
				fields,
				rev: 1,
			});

			gateFor(SESSION_A).release();
			await pendingConnect;

			expect(
				state.activeProposals.project,
				"PROJECT_PROPOSAL_DRAFT_RESTORE_RACE: an empty client draft response erased the newer server proposal",
			).toMatchObject({ sessionId: SESSION_A, fields, rev: 1 });
			expect(state.assistantHasProposal).toBe(true);
		} finally {
			gateFor(SESSION_A).release();
			await pendingConnect.catch(() => {});
		}
	});

	it("preserves a newer server project proposal over a stale nonempty draft restore", async () => {
		state.gatewaySessions = state.gatewaySessions.map((session) =>
			session.id === SESSION_A ? { ...session, assistantType: "project" } : session);
		const staleFields = {
			name: "Stale draft project proposal",
			root_path: "/fixture/stale-draft-project-proposal",
		};
		projectDrafts.set(SESSION_A, {
			activeProjectProposal: {
				sessionId: SESSION_A,
				fields: staleFields,
				streaming: false,
				rev: 1,
			},
			hasReceivedProposal: true,
			assistantTab: "preview",
			accepted: true,
		});
		const pendingConnect = connectToSession(SESSION_A, true);

		try {
			await waitFor(
				() => (workspaceFetchCount.get(SESSION_A) || 0) > 0
					&& typeof state.remoteAgent?.onProposal === "function",
				"PROJECT_PROPOSAL_DRAFT_RESTORE_RACE: project callback was not ready before a stale draft restore",
			);
			const fields = {
				name: "Current server project proposal",
				root_path: "/fixture/current-server-project-proposal",
				test_command: "npm run test:unit",
			};
			state.remoteAgent?.onProposal?.("project", fields, false, 2, "rehydrate");
			expect(state.activeProposals.project).toMatchObject({ sessionId: SESSION_A, fields, rev: 2 });

			gateFor(SESSION_A).release();
			await pendingConnect;

			expect(
				state.activeProposals.project,
				"PROJECT_PROPOSAL_DRAFT_RESTORE_RACE: a stale nonempty draft overwrote the newer server proposal",
			).toMatchObject({ sessionId: SESSION_A, fields, rev: 2 });
			expect(state.activeProposals.project?.fields).not.toEqual(staleFields);
			expect(state.projectProposalAcceptedBySessionId[SESSION_A]).toBeUndefined();
			expect(state.assistantHasProposal).toBe(true);
		} finally {
			gateFor(SESSION_A).release();
			await pendingConnect.catch(() => {});
		}
	});

	it("keeps B foreground mirrors and transcript when A workspace completes after a rapid A to B switch", async () => {
		const connectA = connectToSession(SESSION_A, true);
		await waitFor(
			() => (workspaceFetchCount.get(SESSION_A) || 0) > 0,
			"STALE_WORKSPACE_FOREGROUND_REGRESSION: A hydration did not start",
		);

		const connectB = connectToSession(SESSION_B, true);
		await waitFor(
			() => (workspaceFetchCount.get(SESSION_B) || 0) > 0,
			"STALE_WORKSPACE_FOREGROUND_REGRESSION: B hydration did not start",
		);
		gateFor(SESSION_B).release();
		await connectB;
		await waitFor(
			() => finalTranscriptRow(SESSION_B) !== null,
			"STALE_WORKSPACE_FOREGROUND_REGRESSION: B transcript did not render",
		);

		expect((state as any).panelWorkspace?.sessionId).toBe(SESSION_B);
		gateFor(SESSION_A).release();
		await connectA;

		expect(state.selectedSessionId).toBe(SESSION_B);
		expect(state.remoteAgent?.gatewaySessionId).toBe(SESSION_B);
		expect(
			(state as any).panelWorkspace?.sessionId,
			"STALE_WORKSPACE_FOREGROUND_REGRESSION: abandoned A workspace replaced B's foreground mirror",
		).toBe(SESSION_B);
		expect(state.panelTabs.every((tab) => (tab.source as any).sessionId === SESSION_B)).toBe(true);
		expect(state.activePanelTabId).toBe("preview:entry:index.html");
		expect(state.previewPanelFullscreen).toBe(true);
		expect(state.previewPanelEntry).toBe("index.html");
		expect(state.reviewDocuments.has(`${SESSION_B} review`)).toBe(true);
		expect(finalTranscriptRow(SESSION_B)?.textContent).toBe(`${SESSION_B} transcript row ${TRANSCRIPT_SIZE - 1}`);
		expect(state.sidePanelWorkspaceBySession[SESSION_A]?.sessionId).toBe(SESSION_A);
	});

	it("does not let A cross a delayed session-list await and bind into B's foreground state", async () => {
		const sessionA = { ...gatewaySession(SESSION_A), assistantType: "goal" };
		const sessionB = { ...gatewaySession(SESSION_B), assistantType: "support" };
		state.gatewaySessions = [sessionB];
		sessionListResponseSessions = [sessionA, sessionB];
		const delayedSessionList = deferredGate();
		sessionListGate = delayedSessionList;

		const connectA = connectToSession(SESSION_A, true);
		let connectB: Promise<void> | undefined;

		try {
			await waitFor(
				() => sessionListFetchCount === 1,
				"PRE_BIND_STALE_NAVIGATION_REGRESSION: A never reached delayed session-list hydration",
			);
			expect(getMessagesIndex(SESSION_A)).toBeGreaterThanOrEqual(0);
			expect(delayedSessionList.settled).toBe(false);
			expect(gateFor(SESSION_A).settled).toBe(false);

			const abandonedPanelA = state.chatPanel;
			expect((abandonedPanelA?.agent as any)?.gatewaySessionId).toBeUndefined();
			connectB = connectToSession(SESSION_B, true);
			await waitFor(
				() => (workspaceFetchCount.get(SESSION_B) || 0) > 0,
				"PRE_BIND_STALE_NAVIGATION_REGRESSION: B workspace hydration did not start",
			);
			gateFor(SESSION_B).release();
			await connectB;
			await waitFor(
				() => finalTranscriptRow(SESSION_B) !== null,
				"PRE_BIND_STALE_NAVIGATION_REGRESSION: B transcript did not render",
			);

			const panelB = state.chatPanel;
			const remoteB = state.remoteAgent;
			expect(panelB).not.toBe(abandonedPanelA);
			expect(panelB?.agent as unknown).toBe(remoteB);
			expect(state.reviewDocuments.has(`${SESSION_B} review`)).toBe(true);

			const inboxB = [{ id: "b-inbox-entry", state: "pending", title: "B inbox" }] as any[];
			state.inboxEntries = inboxB;
			state.inboxPanelOpen = true;
			state.assistantType = "support";
			state.assistantTab = "preview";
			state.assistantHasProposal = true;

			delayedSessionList.release();
			await connectA;

			expect.soft(state.remoteAgent, "PRE_BIND_STALE_NAVIGATION_REGRESSION: delayed A replaced B's remote").toBe(remoteB);
			expect.soft(state.chatPanel, "PRE_BIND_STALE_NAVIGATION_REGRESSION: delayed A replaced B's ChatPanel").toBe(panelB);
			expect.soft(
				(panelB?.agent as any)?.gatewaySessionId,
				"PRE_BIND_STALE_NAVIGATION_REGRESSION: delayed A bound into B's ChatPanel",
			).toBe(SESSION_B);
			expect.soft({
				selectedSessionId: state.selectedSessionId,
				visibleBTranscript: finalTranscriptRow(SESSION_B)?.textContent,
				visibleATranscript: document.querySelector(`[data-cold-transcript="${SESSION_A}"]`) !== null,
				panelWorkspaceSessionId: (state as any).panelWorkspace?.sessionId,
				panelTabsOwnedByB: state.panelTabs.every((tab) => (tab.source as any).sessionId === SESSION_B),
				reviewDocumentTitles: [...state.reviewDocuments.keys()],
				reviewActiveTab: state.reviewActiveTab,
				reviewPanelOpen: state.reviewPanelOpen,
				inboxEntryIds: state.inboxEntries.map((entry) => entry.id),
				inboxPanelOpen: state.inboxPanelOpen,
				assistantType: state.assistantType,
				assistantTab: state.assistantTab,
				assistantHasProposal: state.assistantHasProposal,
			}, "PRE_BIND_STALE_NAVIGATION_REGRESSION: delayed A overwrote B's panel, review, inbox, or assistant state").toEqual({
				selectedSessionId: SESSION_B,
				visibleBTranscript: `${SESSION_B} transcript row ${TRANSCRIPT_SIZE - 1}`,
				visibleATranscript: false,
				panelWorkspaceSessionId: SESSION_B,
				panelTabsOwnedByB: true,
				reviewDocumentTitles: [`${SESSION_B} review`],
				reviewActiveTab: `${SESSION_B} review`,
				reviewPanelOpen: true,
				inboxEntryIds: inboxB.map((entry) => entry.id),
				inboxPanelOpen: true,
				assistantType: "support",
				assistantTab: "preview",
				assistantHasProposal: true,
			});
		} finally {
			delayedSessionList.release();
			gateFor(SESSION_A).release();
			gateFor(SESSION_B).release();
			await Promise.allSettled([connectA, ...(connectB ? [connectB] : [])]);
		}
	});

	it.each(["submitted", "closed"] as const)(
		"lets authoritative presence win over an exact %s tombstone and keeps explicit reopen write-free",
		async (tombstoneState) => {
			const reviewA = {
				reviewId: "exact-review-a",
				title: "Exact review A",
				files: [{ fileId: "exact-a-file", title: "A.md", markdown: "# A" }],
				activeFileId: "exact-a-file",
				source: { kind: "markdown-review" as const, sessionId: SESSION_A },
			};
			const reviewB = {
				reviewId: "exact-review-b",
				title: "Exact review B",
				files: [{ fileId: "exact-b-file", title: "B.md", markdown: "# B" }],
				activeFileId: "exact-b-file",
				source: { kind: "markdown-review" as const, sessionId: SESSION_A },
			};
			const reviewTab = (review: typeof reviewA) => ({
				id: `review:${encodeURIComponent(review.reviewId)}`,
				kind: "review" as const,
				title: `Review: ${review.title}`,
				label: `Review: ${review.title}`,
				source: {
					type: "review" as const,
					sessionId: SESSION_A,
					reviewId: review.reviewId,
					documentId: review.reviewId,
					title: review.title,
				},
				updatedAt: 10,
			});

			state.reviewGroupsBySession = {};
			reviewSources.persistReviewGroup(SESSION_A, reviewA);
			reviewSources.persistReviewGroup(SESSION_A, reviewB);
			const seeded = workspaceFor(SESSION_A);
			authoritativeWorkspaces.set(SESSION_A, {
				...seeded,
				tabs: [reviewTab(reviewA), reviewTab(reviewB)],
				activeTabId: reviewTab(reviewA).id,
			});
			await setReviewTombstone(SESSION_A, reviewA.reviewId, tombstoneState);
			vi.mocked(reviewSourcesLazy.loadReviewSources).mockResolvedValue(reviewSources);
			gateFor(SESSION_A).release();

			try {
				await connectToSession(SESSION_A, true);
				await waitFor(
					() => state.sidePanelWorkspaceBySession[SESSION_A]?.tabs.some((tab) => tab.id === reviewTab(reviewA).id) === true,
					`EXACT_REVIEW_${tombstoneState.toUpperCase()}_AUTHORITY_REGRESSION: authoritative A tab was removed`,
				);

				expect(getReviewTombstone(SESSION_A, reviewA.reviewId)).toBe(tombstoneState);
				expect(state.reviewGroups.has(reviewA.reviewId)).toBe(true);
				expect(state.reviewGroups.has(reviewB.reviewId)).toBe(true);
				expect(state.reviewGroupsBySession[SESSION_A]?.map((review) => review.reviewId)).toEqual([
					reviewA.reviewId,
					reviewB.reviewId,
				]);
				expect(state.sidePanelWorkspaceBySession[SESSION_A]?.tabs.map((tab) => tab.id)).toEqual([
					reviewTab(reviewA).id,
					reviewTab(reviewB).id,
				]);
				expect(authoritativeWorkspace(SESSION_A).tabs.map((tab) => tab.id)).toEqual([
					reviewTab(reviewA).id,
					reviewTab(reviewB).id,
				]);

				reviewSources.openMarkdownReviewGroup({
					sessionId: SESSION_A,
					reviewId: reviewA.reviewId,
					title: reviewA.title,
					files: reviewA.files,
					live: true,
				});
				await waitFor(
					() => state.sidePanelWorkspaceBySession[SESSION_A]?.tabs.some((tab) => tab.id === reviewTab(reviewA).id) === true,
					`EXACT_REVIEW_${tombstoneState.toUpperCase()}_LIVE_REOPEN_REGRESSION: fresh A did not stay open`,
				);

				expect(getReviewTombstone(SESSION_A, reviewA.reviewId)).toBe(tombstoneState);
				expect(state.reviewGroups.has(reviewA.reviewId)).toBe(true);
				expect(state.reviewGroups.has(reviewB.reviewId)).toBe(true);
				expect(state.reviewGroupsBySession[SESSION_A]?.map((review) => review.reviewId)).toEqual([
					reviewA.reviewId,
					reviewB.reviewId,
				]);
				expect(state.sidePanelWorkspaceBySession[SESSION_A]?.tabs.map((tab) => tab.id).sort()).toEqual([
					reviewTab(reviewA).id,
					reviewTab(reviewB).id,
				].sort());
			} finally {
				await clearReviewTombstone(SESSION_A, reviewA.reviewId);
				reviewSources.clearPersistedReviewDocuments(SESSION_A);
			}
		},
	);

	it("restores a submitted review when delayed hydration confirms its authoritative primary", async () => {
		await markReviewSubmitted(SESSION_A);
		const pendingConnect = connectToSession(SESSION_A, true);

		try {
			await waitFor(
				() => (workspaceFetchCount.get(SESSION_A) || 0) > 0,
				"SUBMITTED_REVIEW_HYDRATION_REGRESSION: delayed workspace hydration did not start",
			);
			expect(isReviewSubmitted(SESSION_A)).toBe(true);
			expect(state.reviewDocuments.has(`${SESSION_A} review`)).toBe(false);
			expect(gateFor(SESSION_A).settled).toBe(false);

			gateFor(SESSION_A).release();
			await pendingConnect;

			expect.soft(
				state.sidePanelWorkspaceBySession[SESSION_A]?.tabs.some((tab) => tab.kind === "review"),
				"SUBMITTED_REVIEW_AUTHORITY_REGRESSION: delayed hydration removed an authoritative review tab",
			).toBe(true);
			expect.soft(
				state.panelTabs.some((tab) => tab.kind === "review"),
				"SUBMITTED_REVIEW_AUTHORITY_REGRESSION: authoritative review did not reach foreground tabs",
			).toBe(true);
			expect.soft(state.reviewDocuments.has(`${SESSION_A} review`)).toBe(true);
			expect.soft(state.reviewPanelOpen).toBe(true);
		} finally {
			gateFor(SESSION_A).release();
			await pendingConnect.catch(() => {});
			await clearReviewSubmitted(SESSION_A);
		}
	});

	it("never mutates authoritative workspace while reconciling retained submitted suppression", async () => {
		workspaceDeleteOutcomes.set(SESSION_A, [
			{ kind: "network-error", message: "must remain unused" },
		]);
		await markReviewSubmitted(SESSION_A);
		gateFor(SESSION_A).release();
		await connectToSession(SESSION_A, true);

		expect(workspaceDeleteAttempts.get(SESSION_A)).toBeUndefined();
		expect(workspaceFetchCount.get(SESSION_A)).toBe(1);
		expect(authoritativeWorkspace(SESSION_A).revision).toBe(10);
		expect(authoritativeWorkspace(SESSION_A).tabs.some((tab) => tab.kind === "review")).toBe(true);
		expectServerConsistentWorkspaceMirrors(SESSION_A, "SUBMITTED_REVIEW_PASSIVE_SUPPRESSION_REGRESSION");
		expect.soft(state.panelTabs.some((tab) => tab.kind === "review")).toBe(true);
		expect.soft(state.reviewDocuments.has(`${SESSION_A} review`)).toBe(true);
		expect.soft(state.reviewPanelOpen).toBe(true);
	});

	it("keeps the exact cached A agent and panel connected after A to B to A before A hydration releases", async () => {
		const originalConnectA = connectToSession(SESSION_A, true);
		let connectB: Promise<void> | undefined;

		try {
			await waitFor(
				() => (workspaceFetchCount.get(SESSION_A) || 0) > 0 && finalTranscriptRow(SESSION_A) !== null,
				"CACHE_REACTIVATION_HYDRATION_REGRESSION: original A connection did not bind before hydration",
			);
			const cachedPanelA = state.chatPanel;
			const cachedAgentA = state.remoteAgent;
			expect(cachedPanelA).not.toBeNull();
			expect(cachedAgentA).not.toBeNull();
			expect(gateFor(SESSION_A).settled).toBe(false);

			connectB = connectToSession(SESSION_B, true);
			await waitFor(
				() => (workspaceFetchCount.get(SESSION_B) || 0) > 0,
				"CACHE_REACTIVATION_HYDRATION_REGRESSION: B hydration did not start",
			);
			gateFor(SESSION_B).release();
			await connectB;

			await connectToSession(SESSION_A, true);
			expect(state.chatPanel).toBe(cachedPanelA);
			expect(state.remoteAgent).toBe(cachedAgentA);
			expect(cachedAgentA?.connected).toBe(true);

			gateFor(SESSION_A).release();
			await originalConnectA;

			expect.soft(state.selectedSessionId).toBe(SESSION_A);
			expect.soft(
				state.remoteAgent === cachedAgentA,
				"CACHE_REACTIVATION_HYDRATION_REGRESSION: stale original A completion detached the reactivated cached agent",
			).toBe(true);
			expect.soft(
				state.chatPanel === cachedPanelA,
				"CACHE_REACTIVATION_HYDRATION_REGRESSION: stale original A completion replaced the reactivated cached panel",
			).toBe(true);
			expect.soft(cachedAgentA?.connected).toBe(true);
			expect.soft(
				state.chatPanel?.agent as unknown,
				"CACHE_REACTIVATION_HYDRATION_REGRESSION: reactivated panel no longer references the exact cached RemoteAgent",
			).toBe(cachedAgentA);
		} finally {
			gateFor(SESSION_A).release();
			gateFor(SESSION_B).release();
			await Promise.allSettled([originalConnectA, ...(connectB ? [connectB] : [])]);
		}
	});

	it("projects capability readOnly as interactive and nonInteractive as idle-hidden before held hydration", async () => {
		state.gatewaySessions = state.gatewaySessions.map((session) => {
			if (session.id === SESSION_A) return { ...session, readOnly: true };
			if (session.id === SESSION_B) return { ...session, nonInteractive: true };
			return session;
		});
		const connectReadOnly = connectToSession(SESSION_A, true);
		let connectNonInteractive: Promise<void> | undefined;

		try {
			await waitFor(
				() => (workspaceFetchCount.get(SESSION_A) || 0) > 0,
				"SESSION_RESTRICTION_HYDRATION_REGRESSION: read-only hydration did not start",
			);
			const readOnlyInterface = state.chatPanel?.agentInterface as any;
			expect(readOnlyInterface).toBeTruthy();
			expect(gateFor(SESSION_A).settled).toBe(false);

			connectNonInteractive = connectToSession(SESSION_B, true);
			await waitFor(
				() => (workspaceFetchCount.get(SESSION_B) || 0) > 0,
				"SESSION_RESTRICTION_HYDRATION_REGRESSION: non-interactive hydration did not start",
			);
			const nonInteractiveInterface = state.chatPanel?.agentInterface as any;
			expect(nonInteractiveInterface).toBeTruthy();
			expect(gateFor(SESSION_B).settled).toBe(false);

			const readOnlyComposer = readOnlyInterface.querySelector("message-editor") as { onSend: (input: string) => Promise<void> } | null;
			const nonInteractiveComposer = nonInteractiveInterface.querySelector("message-editor") as { onSend: (input: string) => Promise<void> } | null;
			const readOnlyPrompt = vi.spyOn(readOnlyInterface.session, "prompt").mockResolvedValue(undefined);
			await readOnlyComposer?.onSend("read-only capability remains interactive");

			expect.soft(
				readOnlyInterface.archived === true,
				"SESSION_RESTRICTION_HYDRATION_REGRESSION: capability readOnly was projected as archived",
			).toBe(false);
			expect.soft(readOnlyComposer).not.toBeNull();
			expect.soft(nonInteractiveInterface.archived === true).toBe(false);
			expect.soft(nonInteractiveInterface.nonInteractive).toBe(true);
			expect.soft(nonInteractiveComposer).toBeNull();

			expect.soft(
				readOnlyPrompt,
				"SESSION_RESTRICTION_HYDRATION_REGRESSION: active read-only delegate composer did not submit its follow-up",
			).toHaveBeenCalledWith("read-only capability remains interactive");
			const nonInteractivePromptFrames = timeline.filter((entry) =>
				entry.kind === "ws" && entry.sessionId === SESSION_B && entry.frame.type === "prompt");
			expect.soft(nonInteractivePromptFrames).toHaveLength(0);

			await nonInteractiveInterface.session.handleServerMessage({
				type: "state",
				data: { status: "streaming" },
			});
			const streamingSteerComposer = nonInteractiveInterface.querySelector("message-editor") as {
				onSteerSend: (input: string) => Promise<void>;
			} | null;
			expect.soft(
				streamingSteerComposer,
				"SESSION_RESTRICTION_HYDRATION_REGRESSION: streaming nonInteractive session lost its steer editor",
			).not.toBeNull();
			const nonInteractiveSteer = vi.spyOn(nonInteractiveInterface.session, "steer").mockReturnValue(undefined);
			await streamingSteerComposer?.onSteerSend("streaming follow-up stays steer-only");
			expect.soft(nonInteractiveSteer).toHaveBeenCalledWith("streaming follow-up stays steer-only");
		} finally {
			gateFor(SESSION_A).release();
			gateFor(SESSION_B).release();
			await Promise.allSettled([connectReadOnly, ...(connectNonInteractive ? [connectNonInteractive] : [])]);
		}
	});

	it("retains one reconnect workspace hydration and the zero-seq snapshot fallback", async () => {
		state.selectedSessionId = SESSION_A;
		const remote = new RemoteAgent() as any;
		remote._gatewayUrl = "http://localhost";
		remote._authToken = "fixture-token";
		remote._sessionId = SESSION_A;

		await remote._connectWs(false);
		await waitFor(
			() => (workspaceFetchCount.get(SESSION_A) || 0) === 1,
			"RECONNECT_WORKSPACE_REGRESSION: reconnect hydration did not run exactly once",
		);
		const frames = timeline
			.filter((entry): entry is Extract<TimelineEntry, { kind: "ws" }> => entry.kind === "ws" && entry.sessionId === SESSION_A)
			.map((entry) => entry.frame.type);
		expect(frames).toContain("get_messages");
		expect(frames).toContain("get_state");
		expect(workspaceFetchCount.get(SESSION_A)).toBe(1);

		gateFor(SESSION_A).release();
		remote.disconnect();
	});

	it("reuses the exact cached panel and agent without another socket or workspace fetch", async () => {
		gateFor(SESSION_A).release();
		await connectToSession(SESSION_A, true);
		const cachedPanel = state.chatPanel;
		const cachedAgent = state.remoteAgent;
		const socketCount = ControlledWebSocket.instances.length;
		const workspaceCount = workspaceFetchCount.get(SESSION_A);

		selectSession(SESSION_B);
		await connectToSession(SESSION_A, true);

		expect(state.chatPanel).toBe(cachedPanel);
		expect(state.remoteAgent).toBe(cachedAgent);
		expect(ControlledWebSocket.instances).toHaveLength(socketCount);
		expect(workspaceFetchCount.get(SESSION_A)).toBe(workspaceCount);
		expect(localStorage.getItem(GW_SESSION_KEY)).toBe(SESSION_A);
	});
});
