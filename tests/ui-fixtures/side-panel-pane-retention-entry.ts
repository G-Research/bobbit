// Fixture entry for `tests/browser/fixtures/side-panel-pane-retention.fixture.spec.ts`
// (design docs/design/keep-side-panels-mounted.md — real-browser criterion 14,
// plus criteria 7/9 and the mobile round-trip of criteria 10–11).
//
// WHY A REAL BROWSER FIXTURE: the DOM tier stubs `renderPackPanelContent` and can
// only assert the class/style contract — happy-dom never navigates an iframe, has
// no focus/`inert` model and returns 0 from `getBoundingClientRect`. Here the
// pack-panel module is served as REAL ESM bytes through the production lazy
// loader, so `renderPackPanelContent` reaches a real `panel.render()` that emits a
// real `<iframe>` whose document actually loads. Retention is then provable by the
// framed document's OWN load count.
//
// The fixture stands the app up on the `http://fixture.localhost` origin (the same
// technique as `preview-panel-entry.ts` / `dynamic-panel-workspace-fixture-entry.ts`)
// so the spec can serve the framed document with `page.route`, and so
// `useServerWorkspaceApi()` stays TRUE — every workspace mutation the spec drives
// (open / close / activate / resize) goes through the production REST path against
// an in-memory echo server, exactly as the real client does.
import { html } from "lit";
import { doRenderApp } from "../../src/app/render.js";
import { renderApp, setProjects, setRenderApp, state, type GatewaySession, type Project } from "../../src/app/state.js";
import {
	applySidePanelWorkspaceFromServer,
	closeSidePanelTab,
	openSidePanelTab,
	setActiveSidePanelTab,
	setSidePanelSizeMode,
} from "../../src/app/side-panel-workspace.js";
import { registerPackPanels } from "../../src/app/pack-panels.js";
import {
	CHAT_PANEL_TAB_ID,
	packPanelTabId,
	panelTabsForSession,
	panelWorkspaceSessionKey,
	previewEntryTabId,
	setActivePanelTabIdForSession,
} from "../../src/app/panel-workspace.js";
import type { SidePanelSizeMode } from "../../src/shared/side-panel-workspace.js";

const PROJECT_ID = "pane-retention-project";
const PROJECT_ROOT = "/tmp/pane-retention";
const PACK_ID = "retention_pack";
const PANEL_ONE = "pane.one";
const PANEL_TWO = "pane.two";
const FIXTURE_GATEWAY_URL = "http://fixture.localhost";
const FIXTURE_GATEWAY_TOKEN = "fixture-token";

/** Five sessions: four can hold pack panes (one more than the retention cap of
 *  3, so eviction is reachable) and `e` never gets a panel tab at all. */
const SESSION_IDS = ["a", "b", "c", "d", "e"].map((suffix) => `pane-retention-session-${suffix}`);

const PROJECT: Project = {
	id: PROJECT_ID,
	name: "Pane Retention Project",
	rootPath: PROJECT_ROOT,
	colorLight: "#3b82f6",
	colorDark: "#60a5fa",
};

const SESSIONS: GatewaySession[] = SESSION_IDS.map((id, index) => ({
	id,
	title: `Retention ${id.slice(-1).toUpperCase()}`,
	cwd: PROJECT_ROOT,
	projectId: PROJECT_ID,
	status: "idle",
	createdAt: index + 1,
	lastActivity: index + 1,
	clientCount: 1,
}));

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

/**
 * The pack panel module served by the fake `/api/ext/packs/:packId/panels/:panelId`
 * endpoint. Serialised with `Function.prototype.toString()`, so it MUST stay
 * self-contained (only its `toolkit` argument) — it is evaluated as its own ESM
 * module inside a Blob URL by the production loader, not as part of this bundle.
 *
 * `src` is derived only from the pane's OWN params, so it is byte-identical on
 * every re-projection: a `src` mutation therefore always means the render layer
 * re-committed the attribute, never that the panel changed its mind (the same
 * URL-per-session caching contract `vscode-panel` follows).
 */
function retentionPanelFactory(toolkit: any) {
	const html = toolkit.html;
	return {
		render(params: any) {
			const tag = String((params && (params.frameTag || params.__sessionId)) || "anon");
			const url = "/retention-frame.html?frame=" + encodeURIComponent(tag);
			return html`
				<div class="flex-1 flex flex-col min-h-0" data-retention-pane=${tag} style="height:100%;">
					<button type="button" data-retention-focus=${tag} aria-label=${"pane " + tag + " action"}>pane ${tag}</button>
					<iframe
						data-retention-frame=${tag}
						title=${"pane " + tag + " frame"}
						src=${url}
						style="flex:1 1 0%;width:100%;border:0;"
					></iframe>
				</div>
			`;
		},
	};
}

const PANEL_MODULE = `export default ${retentionPanelFactory.toString()};`;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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

function sessionKey(sessionId: string): string {
	return panelWorkspaceSessionKey(sessionId);
}

/** The workspace as the app's own store holds it (the store's type, not the wire
 *  type — they are structurally distinct declarations of the same shape). */
function workspaceFor(sessionId: string) {
	return state.sidePanelWorkspaceBySession[sessionKey(sessionId)];
}

/**
 * In-memory workspace "server": echo back whatever the client has already applied
 * optimistically, one revision newer, so the REST settle path commits it. Tab
 * DELETE answers 204, which `closeSidePanelTab` commits from its own confirmed
 * no-content workspace. This is the same shape `dynamic-panel-workspace-fixture-entry.ts`
 * uses — the point of this fixture is pane LIFETIME, not REST semantics.
 */
function workspaceEndpointResponse(url: string, method: string): Response {
	if (method === "DELETE") return new Response(null, { status: 204 });
	const match = /\/api\/sessions\/([^/]+)\/side-panel-workspace/.exec(url);
	const sessionId = match ? decodeURIComponent(match[1]) : (state.selectedSessionId || SESSION_IDS[0]);
	const workspace = workspaceFor(sessionId);
	if (!workspace) {
		return jsonResponse({ version: 1, sessionId, revision: 0, tabs: [], activeTabId: "", sizeMode: "split", updatedAt: Date.now() });
	}
	return jsonResponse({ ...workspace, revision: workspace.revision + 1, updatedAt: Date.now() });
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = requestPath(input);
	const method = (init?.method || "GET").toUpperCase();
	if (url.includes("/panels/")) {
		return new Response(PANEL_MODULE, { status: 200, headers: { "Content-Type": "text/javascript" } });
	}
	if (url.includes("/side-panel-workspace")) return workspaceEndpointResponse(url, method);
	if (url.startsWith("/api/projects")) return jsonResponse({ projects: [PROJECT] });
	if (url.startsWith("/api/workflows")) return jsonResponse({ workflows: [] });
	if (url.startsWith("/api/ext/contributions")) return jsonResponse({ packs: [] });
	if (url.startsWith("/api/tools") || url.startsWith("/api/roles") || url.startsWith("/api/staff")) {
		return jsonResponse({ tools: [], roles: [], staff: [] });
	}
	if (url.startsWith("/api/sandbox-status")) return jsonResponse({ available: false, configured: false });
	return jsonResponse({ ok: true });
}) as typeof window.fetch;

function addFixtureStyle(): void {
	if (document.getElementById("pane-retention-fixture-style")) return;
	const style = document.createElement("style");
	style.id = "pane-retention-fixture-style";
	// Minimal Tailwind-equivalents plus the REAL app.css split-row and divider
	// rules the geometry assertions depend on (app.css:1147-1190). `[hidden]` is deliberately
	// NOT `!important`: Tailwind's preflight rule loses to a `display:flex`
	// utility class exactly as it does in production, so the fixture still
	// exercises the "hidden alone does not hide a flex box" trap (design §3.3).
	style.textContent = `
		:root { --border:#d0d0d0; --background:#fff; --foreground:#111; --muted-foreground:#666; --primary:#2563eb; --secondary:#f4f4f5; --mobile-header-height:60px; }
		*, *::before, *::after { box-sizing: border-box; }
		body { margin: 0; font-family: system-ui, sans-serif; background: var(--background); color: var(--foreground); }
		.app-shell { height: 100vh; }
		[hidden] { display: none; }
		.hidden { display: none; }
		.flex { display: flex; }
		.inline-flex { display: inline-flex; }
		.flex-col { flex-direction: column; }
		.items-center { align-items: center; }
		.items-end { align-items: flex-end; }
		.justify-between { justify-content: space-between; }
		.flex-1 { flex: 1 1 0%; }
		.shrink-0 { flex-shrink: 0; }
		.min-h-0 { min-height: 0; }
		.min-w-0 { min-width: 0; }
		.w-full { width: 100%; }
		.h-full { height: 100%; }
		.overflow-hidden { overflow: hidden; }
		.overflow-x-auto { overflow-x: auto; }
		.overflow-y-auto, .overflow-auto { overflow-y: auto; }
		.border-b { border-bottom: 1px solid var(--border); }
		.border-l { border-left: 1px solid var(--border); }
		.gap-1 { gap: 0.25rem; }
		.gap-2 { gap: 0.5rem; }
		.px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
		.py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
		.goal-tab-bar { background: var(--background); overflow-x: auto; }
		.goal-tab-pill { display: inline-flex; align-items: center; gap: 0.25rem; border: 1px solid var(--border); border-radius: 999px; padding: 0.25rem 0.5rem; white-space: nowrap; }
		.goal-tab-pill--active { background: var(--primary); color: var(--background); }
		@media (min-width: 768px) {
			.side-panel-split-layout > .side-panel-chat-pane,
			.goal-split-layout > .goal-chat-panel {
				flex: 1 1 auto;
				max-width: calc(100% - var(--side-panel-width, 50%));
				overflow: hidden;
			}
			.side-panel-split-layout > .side-panel-workspace,
			.goal-split-layout > .goal-preview-panel {
				flex: 0 0 var(--side-panel-width, 50%);
				max-width: var(--side-panel-width, 50%);
				overflow: hidden;
			}
			.side-panel-split-layout { position: relative; }
			.side-panel-resize-handle {
				position: absolute;
				top: 0;
				bottom: 0;
				left: calc(100% - var(--side-panel-width, 50%) - 4px);
				width: 8px;
				z-index: 20;
				cursor: col-resize;
				touch-action: none;
				outline: none;
			}
			.side-panel-resize-handle::after {
				content: "";
				position: absolute;
				top: 0;
				bottom: 0;
				left: 3px;
				width: 2px;
				background: transparent;
			}
			.side-panel-resize-handle:hover::after,
			.side-panel-resize-handle:active::after,
			.side-panel-resize-handle:focus-visible::after {
				background: color-mix(in oklch, var(--primary) 55%, transparent);
			}
		}
		.side-panel-slider { width: 100%; }
	`;
	document.head.appendChild(style);
}

function setRemoteAgent(sessionId: string): void {
	state.remoteAgent = {
		gatewaySessionId: sessionId,
		title: SESSIONS.find((session) => session.id === sessionId)?.title || sessionId,
		state: { messages: [], isArchived: false },
		prompt: () => {},
		disconnect: () => {},
		summarizeGoalTitle: () => {},
	} as any;
}

/** Chat pane stand-in with two focusable controls, so the inertness assertions
 *  have a real place to start tabbing from. */
function installChatPanel(): void {
	// `state.chatPanel` is typed as the real <pi-chat-panel> element; fixtures
	// substitute a lit template exactly as the other panel fixtures do.
	state.chatPanel = html`
		<div data-testid="fixture-chat" style="padding:12px;flex:1 1 0%;">
			<textarea aria-label="Chat input" data-testid="fixture-composer"></textarea>
			<button type="button" data-testid="fixture-chat-button">Send</button>
		</div>
	` as any;
}

function resetState(): void {
	releaseColdConnect = null;
	coldSwitchInFlight = null;
	localStorage.setItem("gateway.url", FIXTURE_GATEWAY_URL);
	localStorage.setItem("gateway.token", FIXTURE_GATEWAY_TOKEN);
	setProjects([PROJECT]);
	Object.assign(state, {
		appView: "authenticated",
		connectionStatus: "connected",
		gatewaySessions: SESSIONS.map((session) => ({ ...session })),
		archivedSessions: [],
		goals: [],
		selectedSessionId: SESSION_IDS[0],
		connectingSessionId: null,
		activeProjectId: PROJECT_ID,
		creatingSession: false,
		panelTabsBySession: {},
		panelTabs: [],
		activePanelTabId: CHAT_PANEL_TAB_ID,
		panelWorkspaceActiveBySession: {},
		panelWorkspacePreviewKeyBySession: {},
		sidePanelWorkspaceBySession: {},
		lastWorkspaceRevisionBySession: {},
		previewVersionsBySession: {},
		isPreviewSession: false,
		previewPanelEntry: "",
		reviewPanelOpen: false,
		reviewDocuments: new Map(),
		inboxPanelOpen: false,
		inboxEntries: [],
		defaultCwd: PROJECT_ROOT,
		sessionsLoading: false,
		sessionsError: "",
	});
	// Every session starts with an explicit empty server-authoritative workspace so
	// nothing is derived in render and `e` reliably has no panel tab.
	for (const session of SESSIONS) {
		applySidePanelWorkspaceFromServer({
			version: 1,
			sessionId: session.id,
			revision: 1,
			tabs: [],
			activeTabId: "",
			sizeMode: "split",
			updatedAt: Date.now(),
		}, { source: "hydrate", force: true, skipRender: true });
	}
	registerPackPanels([
		{ packId: PACK_ID, panelId: PANEL_ONE, title: "Pane One" },
		{ packId: PACK_ID, panelId: PANEL_TWO, title: "Pane Two" },
	], PROJECT_ID);
	setRemoteAgent(SESSION_IDS[0]);
	installChatPanel();
	window.location.hash = `#/session/${SESSION_IDS[0]}`;
	addFixtureStyle();
}

/** The per-session mirrors `selectSession` (src/app/session-manager.ts) leaves
 *  behind for the newly selected session. */
function applySelectionMirrors(sessionId: string): void {
	const sid = sessionKey(sessionId);
	state.panelTabs = Array.isArray(state.panelTabsBySession?.[sid]) ? state.panelTabsBySession[sid] : [];
	state.activePanelTabId = state.panelWorkspaceActiveBySession?.[sid] || CHAT_PANEL_TAB_ID;
}

/** WARM switch: the target session is already in the session cache, so
 *  `connectToSession` takes its fast path and never renders a connecting frame. */
function selectSession(sessionId: string): void {
	state.selectedSessionId = sessionId;
	setRemoteAgent(sessionId);
	applySelectionMirrors(sessionId);
	window.location.hash = `#/session/${sessionId}`;
	renderApp();
}

// ── COLD session switch ──────────────────────────────────────────────────────
// The ordinary FIRST visit to a session that is not in the session cache, i.e.
// `connectToSession`'s slow path (src/app/session-manager.ts:1500+):
//
//   selectSession(id)                       → transferActiveSessionToCache() nulls
//                                             state.remoteAgent + state.chatPanel and
//                                             sets connectionStatus "disconnected"
//                                             (session-manager.ts:341-344), sets
//                                             selectedSessionId + hash, renderApp()
//   state.connectingSessionId = id          → renderApp()   (session-manager.ts:1747)
//   await remote.connect(url, token, id)    ← THE DELAY the spec controls
//   setAgent(); connectingSessionId = null  → renderApp()
//
// `renderApp()` is rAF-debounced (src/app/state.ts:952), so the two synchronous
// calls coalesce and the first COMMITTED frame is the CONNECTING frame:
// `hasActiveSession()` is false (no remoteAgent) while `state.connectingSessionId`
// is set. That frame used to be a standalone loader template — a different `html`
// call site at the main-area ChildPart — which detached every retained pane and
// re-navigated its live <iframe>. The old `selectSession()` helper above could
// never reproduce it, so the spec needs this seam.
let releaseColdConnect: (() => void) | null = null;
let coldSwitchInFlight: Promise<void> | null = null;

async function coldSelectSession(sessionId: string): Promise<void> {
	// Phase 1 + 2, with no frame in between (production coalesces them too).
	state.remoteAgent = null;
	state.chatPanel = null;
	state.connectionStatus = "disconnected";
	state.selectedSessionId = sessionId;
	window.location.hash = `#/session/${sessionId}`;
	state.connectingSessionId = sessionId;
	renderApp();
	// The connect() await. Production replaces `state.chatPanel` with a fresh empty
	// ChatPanel here; it is deliberately left null because the shell renders the
	// loader in the chat position while `connectingSessionId` is set, so a chat
	// panel in the DOM during this frame would mean the wrong session's transcript.
	await new Promise<void>((resolve) => { releaseColdConnect = resolve; });
	// Phase 3: connected.
	state.connectingSessionId = null;
	state.connectionStatus = "connected";
	setRemoteAgent(sessionId);
	installChatPanel();
	applySelectionMirrors(sessionId);
	renderApp();
}

function beginColdSelect(sessionId: string): void {
	if (coldSwitchInFlight) throw new Error("a cold switch is already in flight");
	coldSwitchInFlight = coldSelectSession(sessionId);
}

async function completeColdSelect(): Promise<void> {
	const pending = coldSwitchInFlight;
	const release = releaseColdConnect;
	if (!pending || !release) throw new Error("no cold switch in flight");
	coldSwitchInFlight = null;
	releaseColdConnect = null;
	release();
	await pending;
}

/**
 * `focus: false` opens a tab WITHOUT making it active, which is the whole point of
 * the open-but-inactive mobile case: a tab that is merely focused-then-unfocused has
 * already entered retention's append-only order as an `activeKey`, so it would be
 * retained for the wrong reason and the test would prove nothing.
 */
async function openPackPane(input: { sessionId: string; panelId?: string; frameTag: string; select?: boolean; focus?: boolean }): Promise<string> {
	const panelId = input.panelId || PANEL_ONE;
	const tabId = packPanelTabId(PACK_ID, panelId);
	const focus = input.focus !== false;
	if (input.select !== false) selectSession(input.sessionId);
	await openSidePanelTab({
		id: tabId,
		kind: "pack",
		title: panelId,
		label: panelId,
		source: {
			type: "pack",
			sessionId: input.sessionId,
			packId: PACK_ID,
			panelId,
			instanceKey: "default",
			params: { frameTag: input.frameTag },
		},
		updatedAt: Date.now(),
	} as any, { focus });
	if (focus) setActivePanelTabIdForSession(state, input.sessionId, tabId);
	renderApp();
	return tabId;
}

/**
 * A NON-PACK content tab, so the selected session can have an active tab for
 * which retention derives NO active key (`activeSidePanelContentTab()` returns a
 * tab whose `kind !== "pack"`). With no preview entry mirror populated,
 * `htmlPreviewContent()` renders its static empty state — cheap, and it adds no
 * second framed document to confuse the load counters.
 */
async function openPreviewPane(sessionId: string, entry = "index.html"): Promise<string> {
	const tabId = previewEntryTabId(entry);
	selectSession(sessionId);
	await openSidePanelTab({
		id: tabId,
		kind: "preview",
		title: entry,
		label: entry,
		source: { type: "preview", sessionId, entry },
		updatedAt: Date.now(),
	} as any, { focus: true });
	setActivePanelTabIdForSession(state, sessionId, tabId);
	renderApp();
	return tabId;
}

/**
 * Drive a session into a TERMINAL representation while deliberately LEAVING IT IN
 * `state.gatewaySessions` — the shape src/app/team-archived-bucket.ts documents ("a
 * session may appear in both gatewaySessions with status=terminated AND in
 * archivedSessions"). Membership is therefore not a liveness test, which is exactly
 * what the spec asserts against.
 */
function setSessionStatus(sessionId: string, status: string): void {
	state.gatewaySessions = state.gatewaySessions.map((session) =>
		session.id === sessionId ? ({ ...session, status } as any) : session,
	);
	renderApp();
}

async function closePane(sessionId: string, tabId: string): Promise<void> {
	await closeSidePanelTab(tabId, { sessionId });
	renderApp();
}

async function activateTab(sessionId: string, tabId: string): Promise<void> {
	await setActiveSidePanelTab(tabId, { sessionId });
	renderApp();
}

async function setSizeMode(mode: SidePanelSizeMode, sessionId?: string): Promise<void> {
	await setSidePanelSizeMode(mode, { sessionId: sessionId || state.selectedSessionId || SESSION_IDS[0] });
	renderApp();
}

/** Uninstall every pack: the production reconcile path (`registerPackPanels`
 *  with no rows) invalidates the modules and closes the tabs in every session. */
function uninstallPacks(): void {
	registerPackPanels([], PROJECT_ID);
	renderApp();
}

function fixtureState(): Record<string, unknown> {
	const selected = state.selectedSessionId || "";
	return {
		selectedSessionId: selected,
		sizeMode: workspaceFor(selected)?.sizeMode || "",
		activeTabId: workspaceFor(selected)?.activeTabId || "",
		// So the spec can prove the terminal owner is STILL a listed live session at
		// the moment its retained pane is destroyed.
		gatewaySessionIds: state.gatewaySessions.map((session) => session.id),
		gatewaySessionStatuses: Object.fromEntries(state.gatewaySessions.map((session) => [session.id, session.status])),
		tabIdsBySession: Object.fromEntries(SESSION_IDS.map((id) => [id, panelTabsForSession(state, id).map((tab) => tab.id)])),
	};
}

setRenderApp(doRenderApp);

(window as any).__paneRetentionSessions = SESSION_IDS;
(window as any).__paneRetentionPanels = { one: PANEL_ONE, two: PANEL_TWO, packId: PACK_ID };
(window as any).__resetPaneRetentionFixture = () => { resetState(); renderApp(); };
(window as any).__selectPaneRetentionSession = selectSession;
(window as any).__beginColdSelect = beginColdSelect;
(window as any).__completeColdSelect = completeColdSelect;
(window as any).__paneRetentionConnecting = () => ({
	connectingSessionId: state.connectingSessionId,
	hasRemoteAgent: state.remoteAgent !== null,
});
(window as any).__openPackPane = openPackPane;
(window as any).__openPreviewPane = openPreviewPane;
(window as any).__setSessionStatus = setSessionStatus;
(window as any).__closePackPane = closePane;
(window as any).__activatePaneTab = activateTab;
(window as any).__setPaneSizeMode = setSizeMode;
(window as any).__uninstallRetentionPacks = uninstallPacks;
(window as any).__paneRetentionState = fixtureState;
(window as any).__paneRetentionRender = () => renderApp();
(window as any).__paneRetentionReady = true;
