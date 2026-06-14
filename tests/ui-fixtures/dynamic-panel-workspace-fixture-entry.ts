import { html } from "lit";
import { doRenderApp, setSelectedWorkflowId } from "../../src/app/render.js";
import { renderApp, setProjects, setRenderApp, state, type GatewaySession, type Project } from "../../src/app/state.js";
import { selectReviewWorkspaceTab } from "../../src/app/preview-panel.js";
import {
	CHAT_PANEL_TAB_ID,
	LIVE_PREVIEW_PANEL_TAB_ID,
	panelWorkspaceSessionKey,
	previewTabDisplayTitle,
	previewVersionedTabId,
	registerPreviewVersion,
	setActivePanelTabIdForSession,
	setPanelTabsForSession,
	type PanelWorkspaceTab,
} from "../../src/app/panel-workspace.js";
import { clearAllAnnotations } from "../../src/ui/components/review/AnnotationStore.js";

type ReviewDoc = { title: string; markdown: string };
type HistoricalPreviewInput = { toolId: string; entry: string; bodyText: string; contentHash: string; title?: string; label?: string };
type LivePreviewInput = { entry: string; bodyText?: string; contentHash: string };
type WorkspaceState = {
	assistantGoal?: boolean;
	goal?: { title: string; cwd: string; spec: string };
	livePreview?: LivePreviewInput;
	reviews?: ReviewDoc[];
	reviewActiveTab?: string;
};
type FetchLogEntry = { url: string; method: string; body: any };

const PROJECT_ID = "dynamic-workspace-project";
const PROJECT_ROOT = "/tmp/dynamic-workspace";
const SESSION_A = "dynamic-workspace-session-a";
const SESSION_B = "dynamic-workspace-session-b";
const STORE_KEY = "bobbit-dynamic-panel-workspace-fixture";

const PROJECT: Project = {
	id: PROJECT_ID,
	name: "Dynamic Workspace Project",
	rootPath: PROJECT_ROOT,
	colorLight: "#3b82f6",
	colorDark: "#60a5fa",
};

const SESSIONS: GatewaySession[] = [
	{
		id: SESSION_A,
		title: "Workspace Session A",
		cwd: PROJECT_ROOT,
		projectId: PROJECT_ID,
		status: "idle",
		createdAt: 1,
		lastActivity: 1,
		clientCount: 1,
	},
	{
		id: SESSION_B,
		title: "Workspace Session B",
		cwd: PROJECT_ROOT,
		projectId: PROJECT_ID,
		status: "idle",
		createdAt: 2,
		lastActivity: 2,
		clientCount: 1,
	},
];

let fetchLog: FetchLogEntry[] = [];
let promptLog: string[] = [];
let workspaces: Record<string, WorkspaceState> = {};
let knownPreviews: Array<{ sessionId: string; entry: string; html: string; contentHash: string }> = [];

class FixtureWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = FixtureWebSocket.OPEN;
	addEventListener(): void {}
	removeEventListener(): void {}
	send(): void {}
	close(): void { this.readyState = FixtureWebSocket.CLOSED; }
}

(window as any).WebSocket = FixtureWebSocket;
window.confirm = () => true;

function response(body: any, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestPath(input: RequestInfo | URL): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try {
		const url = new URL(raw, window.location.href);
		return `${url.pathname}${url.search}`;
	} catch {
		return raw;
	}
}

function parseBody(init?: RequestInit): any {
	if (!init?.body || typeof init.body !== "string") return null;
	try { return JSON.parse(init.body); } catch { return init.body; }
}

function previewHtmlForBodyText(bodyText: string): string {
	return `<!DOCTYPE html><html><body><h1>${bodyText}</h1></body></html>`;
}

function fallbackHash(seed: string): string {
	let acc = 0;
	for (let i = 0; i < seed.length; i += 1) acc = (acc * 31 + seed.charCodeAt(i)) >>> 0;
	return acc.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

function currentSessionId(): string {
	return state.selectedSessionId || state.remoteAgent?.gatewaySessionId || SESSION_A;
}

function workspaceKey(sessionId = currentSessionId()): string {
	return panelWorkspaceSessionKey(sessionId);
}

function currentWorkspace(): WorkspaceState {
	const sid = currentSessionId();
	workspaces[sid] ||= {};
	return workspaces[sid];
}

function cloneWorkspaceMap(input: Record<string, WorkspaceState>): Record<string, WorkspaceState> {
	return JSON.parse(JSON.stringify(input));
}

function addFixtureStyle(): void {
	if (document.getElementById("dynamic-panel-workspace-fixture-style")) return;
	const style = document.createElement("style");
	style.id = "dynamic-panel-workspace-fixture-style";
	style.textContent = `
		:root { --border:#d0d0d0; --background:#fff; --foreground:#111; --muted-foreground:#666; --primary:#2563eb; --secondary:#f4f4f5; }
		body { margin: 0; font-family: system-ui, sans-serif; }
		.app-shell { height: 900px; }
		.hidden, [hidden] { display: none !important; }
		.flex { display: flex; }
		.inline-flex { display: inline-flex; }
		.flex-col { flex-direction: column; }
		.items-center { align-items: center; }
		.justify-between { justify-content: space-between; }
		.flex-1 { flex: 1 1 0%; }
		.shrink-0 { flex-shrink: 0; }
		.min-h-0 { min-height: 0; }
		.min-w-0 { min-width: 0; }
		.min-w-max { min-width: max-content; }
		.w-full { width: 100%; }
		.h-full { height: 100%; }
		.overflow-hidden { overflow: hidden; }
		.overflow-x-auto { overflow-x: auto; }
		.overflow-y-auto, .overflow-auto { overflow-y: auto; }
		.fixed { position: fixed; }
		.top-0 { top: 0; }
		.left-0 { left: 0; }
		.right-0 { right: 0; }
		.z-50 { z-index: 50; }
		.border-b { border-bottom: 1px solid var(--border); }
		.border-l { border-left: 1px solid var(--border); }
		.border-border { border-color: var(--border); }
		.bg-background { background: var(--background); }
		.text-foreground { color: var(--foreground); }
		.text-muted-foreground { color: var(--muted-foreground); }
		.gap-1 { gap: 0.25rem; }
		.gap-2 { gap: 0.5rem; }
		.px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
		.py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
		.p-5 { padding: 1.25rem; }
		.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.goal-tab-bar { background: var(--background); overflow-x: auto; }
		.goal-tab-pill { display: inline-flex; align-items: center; gap: 0.25rem; border: 1px solid var(--border); border-radius: 999px; background: var(--background); padding: 0.25rem 0.5rem 0.25rem 0.6rem; white-space: nowrap; max-width: 18rem; }
		.goal-tab-pill--active { background: var(--primary); color: #fff; }
		.goal-tab-pill-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.goal-tab-close { display: inline-flex; align-items: center; justify-content: center; width: 1rem; height: 1rem; border-radius: 999px; }
		.goal-tab-dot { display: inline-block; width: 0.5em; height: 0.5em; border-radius: 999px; background: currentColor; }
		.goal-preview-panel { min-height: 280px; }
		.goal-chat-panel { min-width: 300px; }
		.preview-slider { width: 100%; }
		[data-mobile-header] .goal-preview-panel[data-panel-tab-id] { padding-top: var(--mobile-header-height, 60px) !important; }
		review-pane, review-document { display: block; }
	`;
	document.head.appendChild(style);
}

function persistFixture(): void {
	try {
		localStorage.setItem(STORE_KEY, JSON.stringify({
			selectedSessionId: currentSessionId(),
			workspaces,
			panelTabsBySession: state.panelTabsBySession,
			panelWorkspaceActiveBySession: state.panelWorkspaceActiveBySession,
			previewVersionsBySession: (state as any).previewVersionsBySession,
			knownPreviews,
		}));
	} catch {
		/* best-effort fixture persistence */
	}
}

function readPersistedFixture(): any | null {
	try {
		const raw = localStorage.getItem(STORE_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

function sessionById(sessionId: string): GatewaySession {
	return SESSIONS.find((session) => session.id === sessionId) || SESSIONS[0];
}

function setRemoteAgent(sessionId: string): void {
	state.remoteAgent = {
		gatewaySessionId: sessionId,
		title: sessionById(sessionId).title,
		state: { messages: [], isArchived: false },
		prompt: (text: string) => { promptLog.push(text); },
		disconnect: () => {},
		summarizeGoalTitle: () => {},
	} as any;
}

function applyWorkspace(sessionId: string): void {
	const ws = workspaces[sessionId] || {};
	state.assistantType = ws.assistantGoal ? "goal" : null;
	state.assistantTab = ws.assistantGoal ? "preview" : "chat";
	state.assistantHasProposal = !!ws.assistantGoal;
	state.previewTitle = ws.goal?.title || "";
	state.previewCwd = ws.goal?.cwd || PROJECT_ROOT;
	state.previewSpec = ws.goal?.spec || "";
	state.previewProjectId = ws.assistantGoal ? PROJECT_ID : "";
	state.activeProposals = ws.assistantGoal
		? {
			goal: {
				sessionId,
				fields: { title: state.previewTitle, cwd: state.previewCwd, spec: state.previewSpec, workflow: "general" },
				streaming: false,
				rev: 1,
			},
		}
		: {};
	state.isPreviewSession = !!ws.livePreview;
	state.previewPanelEntry = ws.livePreview?.entry || "";
	state.previewPanelMtime = ws.livePreview ? 1000 : 0;
	(state as any).previewPanelContentHash = ws.livePreview?.contentHash || "";
	state.previewPanelFullscreen = false;
	state.reviewDocuments = new Map((ws.reviews || []).map((doc) => [doc.title, doc]));
	state.reviewActiveTab = ws.reviewActiveTab || ws.reviews?.[0]?.title || "";
	state.reviewPanelOpen = (ws.reviews || []).length > 0;
	state.inboxEntries = [];
	state.inboxPanelOpen = false;
	state.chatPanel = html`<div data-testid="fixture-chat" style="padding:12px;"><textarea aria-label="Chat input"></textarea></div>`;
}

function resetState(options: { clearPersisted?: boolean; selectedSessionId?: string } = {}): void {
	if (options.clearPersisted ?? true) {
		try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
	}
	fetchLog = [];
	promptLog = [];
	knownPreviews = [];
	workspaces = {};
	for (const session of SESSIONS) clearAllAnnotations(session.id);
	setProjects([PROJECT]);
	const selectedSessionId = options.selectedSessionId || SESSION_A;
	Object.assign(state, {
		appView: "authenticated",
		connectionStatus: "connected",
		gatewaySessions: SESSIONS.map((session) => ({ ...session })),
		goals: [],
		selectedSessionId,
		connectingSessionId: null,
		activeProjectId: PROJECT_ID,
		creatingSession: false,
		projectProposalAcceptedBySessionId: {},
		panelTabsBySession: {},
		panelTabs: [],
		activePanelTabId: CHAT_PANEL_TAB_ID,
		panelWorkspaceActiveBySession: {},
		panelWorkspacePreviewKeyBySession: {},
		previewVersionsBySession: {},
		previewPanelTab: "chat",
		previewPanelActiveTab: "preview",
		defaultCwd: PROJECT_ROOT,
		sessionsLoading: false,
		sessionsError: "",
		inboxPanelOpen: false,
		inboxEntries: [],
	});
	(state as any).previewPanelMountedTabId = "";
	setSelectedWorkflowId("general");
	setRemoteAgent(selectedSessionId);
	applyWorkspace(selectedSessionId);
	window.location.hash = `#/session/${selectedSessionId}`;
	localStorage.setItem("gateway.url", window.location.origin);
	localStorage.setItem("gateway.token", "fixture-token");
	addFixtureStyle();
}

function rehydrateState(): void {
	const saved = readPersistedFixture();
	resetState({ clearPersisted: false, selectedSessionId: saved?.selectedSessionId || SESSION_A });
	if (saved?.workspaces) workspaces = cloneWorkspaceMap(saved.workspaces);
	if (Array.isArray(saved?.knownPreviews)) knownPreviews = saved.knownPreviews;
	if (saved?.panelTabsBySession && typeof saved.panelTabsBySession === "object") {
		state.panelTabsBySession = saved.panelTabsBySession;
	}
	if (saved?.panelWorkspaceActiveBySession && typeof saved.panelWorkspaceActiveBySession === "object") {
		state.panelWorkspaceActiveBySession = saved.panelWorkspaceActiveBySession;
	}
	if (saved?.previewVersionsBySession && typeof saved.previewVersionsBySession === "object") {
		(state as any).previewVersionsBySession = saved.previewVersionsBySession;
	}
	applyWorkspace(currentSessionId());
}

function renderNow(): void {
	persistFixture();
	renderApp();
}

function selectSession(sessionId: string): void {
	const previousSessionId = currentSessionId();
	if (previousSessionId && previousSessionId !== sessionId) {
		setActivePanelTabIdForSession(state, previousSessionId, CHAT_PANEL_TAB_ID);
	}
	state.selectedSessionId = sessionId;
	setRemoteAgent(sessionId);
	applyWorkspace(sessionId);
	const sid = workspaceKey(sessionId);
	state.panelTabs = Array.isArray(state.panelTabsBySession?.[sid]) ? state.panelTabsBySession[sid] : [];
	state.activePanelTabId = state.panelWorkspaceActiveBySession?.[sid] || CHAT_PANEL_TAB_ID;
	window.location.hash = `#/session/${sessionId}`;
	renderNow();
}

function setGoalProposal(goal: Partial<{ title: string; cwd: string; spec: string }> = {}): void {
	const ws = currentWorkspace();
	ws.assistantGoal = true;
	ws.goal = {
		title: goal.title || "Fixture Dynamic Goal",
		cwd: goal.cwd || PROJECT_ROOT,
		spec: goal.spec || "Fixture dynamic goal spec.",
	};
	applyWorkspace(currentSessionId());
	renderNow();
}

function setLivePreview(preview: LivePreviewInput): void {
	const ws = currentWorkspace();
	ws.livePreview = { ...preview };
	knownPreviews.push({
		sessionId: currentSessionId(),
		entry: preview.entry,
		html: previewHtmlForBodyText(preview.bodyText || preview.entry),
		contentHash: preview.contentHash,
	});
	registerPreviewVersion(state, currentSessionId(), preview.entry, preview.contentHash, { current: true });
	applyWorkspace(currentSessionId());
	setActivePanelTabIdForSession(state, currentSessionId(), LIVE_PREVIEW_PANEL_TAB_ID);
	renderNow();
}

function makeHistoricalPreviewTab(sessionId: string, preview: HistoricalPreviewInput): PanelWorkspaceTab {
	const htmlText = previewHtmlForBodyText(preview.bodyText);
	knownPreviews.push({ sessionId, entry: preview.entry, html: htmlText, contentHash: preview.contentHash });
	const version = registerPreviewVersion(state, sessionId, preview.entry, preview.contentHash, { current: false });
	const title = preview.title || previewTabDisplayTitle(preview.entry, version, true);
	return {
		id: version ? previewVersionedTabId(preview.entry, version) : `preview:entry:${encodeURIComponent(preview.entry)}`,
		kind: "preview",
		title,
		label: preview.label || title,
		legacyTab: "preview",
		source: {
			type: "preview_open",
			sessionId,
			entry: preview.entry,
			toolUseId: preview.toolId,
			blockIndex: 1,
			contentHash: preview.contentHash,
			snapshotKind: "inline",
			dedupeWithLive: false,
			historical: true,
			...(version != null ? { version } : {}),
		},
		state: {
			sessionId,
			entry: preview.entry,
			contentHash: preview.contentHash,
			snapshotKind: "inline",
			snapshotHtml: htmlText,
			dedupeWithLive: false,
			historical: true,
			...(version != null ? { version } : {}),
		},
	};
}

function setHistoricalPreviews(sessionId: string, previews: HistoricalPreviewInput[]): void {
	const tabs = previews.map((preview) => makeHistoricalPreviewTab(sessionId, preview));
	setPanelTabsForSession(state, sessionId, tabs);
	if (currentSessionId() === sessionId && tabs[0] && !workspaces[sessionId]?.livePreview) {
		setActivePanelTabIdForSession(state, sessionId, tabs[0].id);
	}
	renderNow();
}

function openReviewDoc(doc: ReviewDoc): void {
	const ws = currentWorkspace();
	const existing = ws.reviews || [];
	const next = existing.filter((candidate) => candidate.title !== doc.title);
	next.push(doc);
	ws.reviews = next;
	ws.reviewActiveTab = doc.title;
	applyWorkspace(currentSessionId());
	selectReviewWorkspaceTab(doc.title, { sessionId: currentSessionId(), select: true });
	renderNow();
}

function setReviewDocs(docs: ReviewDoc[]): void {
	const ws = currentWorkspace();
	ws.reviews = docs.map((doc) => ({ ...doc }));
	ws.reviewActiveTab = docs[0]?.title || "";
	applyWorkspace(currentSessionId());
	if (docs[0]) setActivePanelTabIdForSession(state, currentSessionId(), `review:${encodeURIComponent(docs[0].title)}`);
	renderNow();
}

function setReviewDocsForSession(sessionId: string, docs: ReviewDoc[]): void {
	workspaces[sessionId] ||= {};
	workspaces[sessionId].reviews = docs.map((doc) => ({ ...doc }));
	workspaces[sessionId].reviewActiveTab = docs[0]?.title || "";
	if (currentSessionId() === sessionId) applyWorkspace(sessionId);
	renderNow();
}

function getFixtureState(): Record<string, unknown> {
	const sid = currentSessionId();
	return {
		selectedSessionId: sid,
		activePanelTabId: state.activePanelTabId,
		previewPanelEntry: state.previewPanelEntry,
		previewPanelContentHash: (state as any).previewPanelContentHash,
		panelWorkspaceActiveBySession: state.panelWorkspaceActiveBySession,
		panelTabsBySession: state.panelTabsBySession,
		reviewTitles: [...state.reviewDocuments.keys()],
		fetchLog: fetchLog.slice(),
		promptLog: promptLog.slice(),
	};
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = requestPath(input);
	const method = (init?.method || "GET").toUpperCase();
	const body = parseBody(init);
	fetchLog.push({ url, method, body });

	if (url.startsWith(`/api/projects/${PROJECT_ID}/structured`)) return response({ components: [] });
	if (url.startsWith(`/api/projects/${PROJECT_ID}/qa-testing-config`)) return response({ configured: false });
	if (url.startsWith("/api/projects")) return response({ projects: [PROJECT] });
	if (url.startsWith("/api/workflows")) return response({ workflows: [{ id: "general", name: "General", description: "General workflow", gates: [] }] });
	if (url === "/api/tools") return response({ tools: [] });
	if (url === "/api/roles") return response({ roles: [] });
	if (url.startsWith("/api/staff")) return response({ staff: [] });
	if (url.startsWith("/api/sandbox-status")) return response({ available: false, configured: false });
	if (url.includes("/review/annotations")) return response({ annotations: {}, submitted: false });
	if (url.includes("/review/submitted")) return response({ submitted: false });
	if (url.includes("/proposal/") || url.includes("/draft")) return response({ ok: true });
	if (url.startsWith("/api/sessions/") && method === "PATCH") return response({ ok: true });
	if (url.startsWith("/api/preview/mount")) {
		const sessionId = new URL(url, window.location.href).searchParams.get("sessionId") || currentSessionId();
		if (method === "GET") {
			const ws = workspaces[sessionId]?.livePreview;
			const entry = ws?.entry || state.previewPanelEntry || "inline.html";
			const contentHash = ws?.contentHash || (state as any).previewPanelContentHash || fallbackHash(`${sessionId}:${entry}`);
			return response({ url: `/preview/${sessionId}/${entry}`, path: `${sessionId}/${entry}`, relPath: `${sessionId}/${entry}`, entry, mtime: 1234, contentHash });
		}
		if (method === "POST") {
			const htmlBody = typeof body?.html === "string" ? body.html : "";
			const fileBody = typeof body?.file === "string" ? body.file : "";
			const requestedEntry = typeof body?.entry === "string" && body.entry ? body.entry : fileBody.split(/[\\/]/).pop() || "inline.html";
			const known = knownPreviews.find((preview) => preview.sessionId === sessionId && preview.html === htmlBody)
				|| knownPreviews.find((preview) => preview.sessionId === sessionId && preview.entry === requestedEntry);
			const entry = known?.entry || requestedEntry;
			const contentHash = known?.contentHash || fallbackHash(`${sessionId}:${entry}:${htmlBody || fileBody}`);
			return response({ url: `/preview/${sessionId}/${entry}`, path: `${sessionId}/${entry}`, relPath: `${sessionId}/${entry}`, entry, mtime: Date.now(), contentHash });
		}
	}
	return response({ ok: true });
}) as typeof window.fetch;

setRenderApp(doRenderApp);

(window as any).__dynamicPanelWorkspaceSessions = { a: SESSION_A, b: SESSION_B };
(window as any).__resetDynamicPanelWorkspaceFixture = () => { resetState(); doRenderApp(); };
(window as any).__rehydrateDynamicPanelWorkspaceFixture = () => { rehydrateState(); doRenderApp(); };
(window as any).__selectDynamicWorkspaceSession = selectSession;
(window as any).__setDynamicGoalProposal = setGoalProposal;
(window as any).__setDynamicLivePreview = setLivePreview;
(window as any).__setDynamicHistoricalPreviews = setHistoricalPreviews;
(window as any).__setDynamicReviewDocs = setReviewDocs;
(window as any).__setDynamicReviewDocsForSession = setReviewDocsForSession;
(window as any).__openDynamicReviewDoc = openReviewDoc;
(window as any).__getDynamicPanelWorkspaceState = getFixtureState;
(window as any).__dynamicPanelWorkspaceReady = true;
