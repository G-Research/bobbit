import { html } from "lit";
import { doRenderApp, setSelectedWorkflowId } from "../../src/app/render.js";
import { renderApp, setProjects, setRenderApp, state, type GatewaySession, type Project } from "../../src/app/state.js";
import { clearProposalDismissed, isProposalDismissed, markProposalDismissed } from "../../src/app/proposal-helpers.js";
import { PROPOSAL_TYPE_REGISTRY, type ProposalType } from "../../src/app/proposal-registry.js";
import { addAnnotation, clearAllAnnotations } from "../../src/ui/components/review/AnnotationStore.js";

type FetchLogEntry = { url: string; method: string; body: any };
type ReviewDoc = { title: string; markdown: string };

type ProposalFixture = {
	type: ProposalType;
	initial: Record<string, unknown>;
	partial: Record<string, unknown>;
};

type StoredProposal = {
	fields: Record<string, unknown>;
	rev: number;
	mode?: "provisional" | "registered";
};

type ResetOptions = {
	clearDismissals?: boolean;
	clearPersisted?: boolean;
	hydrateProposals?: boolean;
};

const SESSION_ID = "proposal-review-fixture-session";
const PROJECT_ID = "proposal-review-fixture-project";
const PROJECT_ROOT = "/tmp/proposal-review-fixture";
const PROPOSAL_STORE_KEY = `bobbit-proposal-review-fixture-proposals-${SESSION_ID}`;

const PROJECT: Project = {
	id: PROJECT_ID,
	name: "Fixture Project",
	rootPath: PROJECT_ROOT,
	colorLight: "#3b82f6",
	colorDark: "#60a5fa",
};

const SESSION: GatewaySession = {
	id: SESSION_ID,
	title: "Fixture Session",
	cwd: PROJECT_ROOT,
	projectId: PROJECT_ID,
	status: "idle",
	createdAt: 1,
	lastActivity: 1,
	clientCount: 1,
};

export const PROPOSAL_FIXTURES: ProposalFixture[] = [
	{
		type: "goal",
		initial: { title: "Parity Goal A", workflow: "general", spec: "Body A.", cwd: "/tmp/parity-goal" },
		partial: { title: "Parity Goal A — edited", spec: "Body B." },
	},
	{
		type: "project",
		initial: {
			name: "Parity Project",
			root_path: "/tmp/parity-project",
			build_command: "echo parity",
			test_command: "echo parity-test",
			components: [{ name: "core", repo: ".", commands: { build: "echo build-core" } }],
		},
		partial: { name: "Parity Project", root_path: "/tmp/parity-project", build_command: "echo parity-edited" },
	},
	{
		type: "role",
		initial: { name: "parity-role", label: "Parity Role", prompt: "Parity prompt body.", tools: "", accessory: "none" },
		partial: { name: "parity-role", label: "parity-role-edited", prompt: "P", tools: "", accessory: "none" },
	},
	{
		type: "tool",
		initial: { tool: "parity-tool", action: "docs", content: "Parity tool docs." },
		partial: { tool: "parity-tool", action: "docs", content: "parity-tool-edited content" },
	},
	{
		type: "staff",
		initial: { name: "parity-staff", description: "Parity staff description.", prompt: "Parity staff prompt.", triggers: "[]", cwd: "" },
		partial: { name: "parity-staff", description: "parity-staff-edited", prompt: "P", triggers: "[]", cwd: "" },
	},
];

let fetchLog: FetchLogEntry[] = [];
let promptLog: string[] = [];

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

function cloneFields(fields: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(fields));
}

function readPersistedProposals(): Partial<Record<ProposalType, StoredProposal>> {
	try {
		const raw = localStorage.getItem(PROPOSAL_STORE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writePersistedProposals(store: Partial<Record<ProposalType, StoredProposal>>): void {
	try {
		localStorage.setItem(PROPOSAL_STORE_KEY, JSON.stringify(store));
	} catch {
		/* ignore quota errors */
	}
}

function clearPersistedProposals(): void {
	try { localStorage.removeItem(PROPOSAL_STORE_KEY); } catch { /* ignore */ }
}

function persistProposalSlot(type: ProposalType, slot: StoredProposal): void {
	const store = readPersistedProposals();
	store[type] = { ...slot, fields: cloneFields(slot.fields) };
	writePersistedProposals(store);
}

function rehydratePersistedProposals(): void {
	const store = readPersistedProposals();
	for (const fixture of PROPOSAL_FIXTURES) {
		const persisted = store[fixture.type];
		if (!persisted?.fields) continue;
		emitProposal(fixture.type, persisted.fields, { rev: persisted.rev, ignoreDismissal: false });
	}
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = requestPath(input);
	const method = (init?.method || "GET").toUpperCase();
	const body = parseBody(init);
	fetchLog.push({ url, method, body });

	if (url.startsWith("/api/projects/" + PROJECT_ID + "/structured")) return response({ components: [] });
	if (url.startsWith("/api/projects/" + PROJECT_ID + "/qa-testing-config")) return response({ configured: false });
	if (url.startsWith("/api/projects")) return response({ projects: [PROJECT] });
	if (url.startsWith("/api/workflows")) return response({ workflows: [{ id: "general", name: "General", description: "General workflow", gates: [] }] });
	if (url === "/api/tools") return response({ tools: [] });
	if (url === "/api/roles") return response({ roles: [] });
	if (url.startsWith("/api/staff")) return method === "POST"
		? response({ id: "fixture-staff", ...(body || {}) }, 201)
		: response({ staff: [] });
	if (url.includes("/review/annotations")) return response({ annotations: {}, submitted: false });
	if (url.includes("/review/submitted")) return response({ submitted: false });
	if (url.includes("/proposal/") || url.includes("/draft")) return response({ ok: true });
	if (url === "/api/sandbox-status") return response({ available: false, configured: false });
	return response({ ok: true });
}) as typeof window.fetch;

function addFixtureStyle(): void {
	if (document.getElementById("proposal-review-fixture-style")) return;
	const style = document.createElement("style");
	style.id = "proposal-review-fixture-style";
	style.textContent = `
		body { margin: 0; font-family: system-ui, sans-serif; }
		.app-shell { height: 900px; }
		.hidden, [hidden] { display: none !important; }
		.goal-tab-pill { margin: 2px; }
		.goal-tab-dot { display: inline-block; width: 0.5em; height: 0.5em; border-radius: 999px; background: currentColor; }
		.goal-preview-panel { min-height: 280px; }
	`;
	document.head.appendChild(style);
}

function resetState(options: ResetOptions = {}): void {
	const clearDismissals = options.clearDismissals ?? true;
	const clearPersisted = options.clearPersisted ?? true;
	fetchLog = [];
	promptLog = [];
	clearAllAnnotations(SESSION_ID);
	if (clearPersisted) clearPersistedProposals();
	if (clearDismissals) {
		for (const type of PROPOSAL_FIXTURES.map((f) => f.type)) clearProposalDismissed(SESSION_ID, type);
	}
	setProjects([PROJECT]);
	Object.assign(state, {
		appView: "authenticated",
		connectionStatus: "connected",
		gatewaySessions: [{ ...SESSION }],
		goals: [],
		selectedSessionId: SESSION_ID,
		connectingSessionId: null,
		assistantType: null,
		assistantTab: "chat",
		assistantHasProposal: false,
		activeProposals: {},
		projectProposalAcceptedBySessionId: {},
		activeProjectId: PROJECT_ID,
		previewTitle: "",
		previewCwd: "",
		previewSpec: "",
		previewTitleEdited: false,
		previewCwdEdited: false,
		previewSpecEdited: false,
		previewProjectId: PROJECT_ID,
		rolePreviewName: "",
		rolePreviewLabel: "",
		rolePreviewPrompt: "",
		rolePreviewTools: "",
		rolePreviewAccessory: "none",
		toolPreviewName: "",
		toolPreviewDocs: "",
		toolPreviewRendererHtml: "",
		toolPreviewChecklist: { docs: "pending", renderer: "pending", tests: "pending", config: "pending" },
		staffPreviewName: "",
		staffPreviewDescription: "",
		staffPreviewPrompt: "",
		staffPreviewTriggers: "[]",
		staffPreviewCwd: "",
		staffPreviewWorktree: true,
		isPreviewSession: false,
		previewPanelTab: "chat",
		previewPanelActiveTab: "preview",
		previewPanelMtime: 0,
		previewPanelEntry: "",
		previewPanelFullscreen: false,
		panelTabsBySession: {},
		panelTabs: [],
		activePanelTabId: "chat",
		panelWorkspaceActiveBySession: {},
		panelWorkspacePreviewKeyBySession: {},
		reviewDocuments: new Map(),
		reviewActiveTab: "",
		reviewPanelOpen: false,
		inboxEntries: [],
		inboxPanelOpen: false,
		chatPanel: html`<div data-testid="fixture-chat" style="padding:12px;"><textarea aria-label="Chat input"></textarea></div>`,
		remoteAgent: {
			gatewaySessionId: SESSION_ID,
			title: "Fixture Session",
			state: { messages: [], isArchived: false },
			prompt: (text: string) => { promptLog.push(text); },
			disconnect: () => {},
			summarizeGoalTitle: () => {},
		},
	});
	window.location.hash = `#/session/${SESSION_ID}`;
	localStorage.setItem("gateway.url", window.location.origin);
	localStorage.setItem("gateway.token", "fixture-token");
	addFixtureStyle();
	if (options.hydrateProposals) rehydratePersistedProposals();
}

function applyProposalMirrors(type: ProposalType, fields: Record<string, unknown>): void {
	if (type === "goal") {
		state.previewTitle = String(fields.title ?? "");
		state.previewCwd = String(fields.cwd ?? PROJECT_ROOT);
		state.previewSpec = String(fields.spec ?? "");
		state.previewProjectId = PROJECT_ID;
		setSelectedWorkflowId(String(fields.workflow ?? "general"));
		return;
	}
	if (type === "role") {
		state.rolePreviewName = String(fields.name ?? "");
		state.rolePreviewLabel = String(fields.label ?? "");
		state.rolePreviewPrompt = String(fields.prompt ?? "");
		state.rolePreviewTools = String(fields.tools ?? "");
		state.rolePreviewAccessory = String(fields.accessory ?? "none");
		return;
	}
	if (type === "tool") {
		state.toolPreviewName = String(fields.tool ?? "");
		if (fields.action === "docs") {
			state.toolPreviewChecklist.docs = "done";
			state.toolPreviewDocs = String(fields.content ?? "");
		}
		if (fields.action === "renderer") {
			state.toolPreviewChecklist.renderer = "done";
			state.toolPreviewRendererHtml = String(fields.content ?? "");
		}
		return;
	}
	if (type === "staff") {
		state.staffPreviewName = String(fields.name ?? "");
		state.staffPreviewDescription = String(fields.description ?? "");
		state.staffPreviewPrompt = String(fields.prompt ?? "");
		state.staffPreviewTriggers = String(fields.triggers ?? "[]");
		state.staffPreviewCwd = String(fields.cwd ?? PROJECT_ROOT);
	}
}

function emitProposal(type: ProposalType, fields: Record<string, unknown>, opts: { rev?: number; ignoreDismissal?: boolean } = {}): boolean {
	const plugin = PROPOSAL_TYPE_REGISTRY[type];
	const prev = state.activeProposals[type];
	const merged = plugin.mergeFields(prev?.fields ?? {}, fields);
	const isFirstEmit = prev == null;
	if (isFirstEmit && !opts.ignoreDismissal && isProposalDismissed(SESSION_ID, type, merged)) return false;
	const slot = {
		sessionId: SESSION_ID,
		fields: merged,
		streaming: false,
		mode: type === "project" ? "registered" as const : undefined,
		rev: opts.rev ?? prev?.rev ?? 1,
	};
	state.activeProposals[type] = slot;
	persistProposalSlot(type, { fields: merged, rev: slot.rev, mode: slot.mode });
	state.assistantHasProposal = true;
	if (type === "project") delete state.projectProposalAcceptedBySessionId[SESSION_ID];
	applyProposalMirrors(type, merged);
	if (isFirstEmit) {
		plugin.onFirstEmit(slot, { isAssistant: false, isMobile: window.innerWidth < 768 });
	}
	renderApp();
	return true;
}

function activeSlot(type: ProposalType): Record<string, unknown> | null {
	const slot = state.activeProposals[type];
	return slot ? JSON.parse(JSON.stringify(slot.fields)) : null;
}

function setReviewDocs(docs: ReviewDoc[], annotations: Record<string, any[]> = {}): void {
	state.reviewDocuments = new Map(docs.map((doc) => [doc.title, doc]));
	state.reviewActiveTab = docs[0]?.title ?? "";
	state.reviewPanelOpen = docs.length > 0;
	state.previewPanelActiveTab = "review";
	state.previewPanelTab = "review";
	for (const [title, anns] of Object.entries(annotations)) {
		for (const ann of anns) addAnnotation(SESSION_ID, title, ann);
	}
	renderApp();
}

setRenderApp(doRenderApp);

// Mirror the production proposal-open effect closely enough for the fixture: a user
// explicitly opening a proposal card clears the typed dismissal and restores the slot.
document.addEventListener("proposal-open", (event) => {
	const detail = (event as CustomEvent).detail || {};
	const type = detail.type as ProposalType;
	if (!type || !(type in PROPOSAL_TYPE_REGISTRY)) return;
	clearProposalDismissed(SESSION_ID, type);
	emitProposal(type, detail.fields || {}, { rev: detail.rev, ignoreDismissal: true });
});

(window as any).__proposalReviewFixtures = PROPOSAL_FIXTURES;
(window as any).__resetProposalReviewFixture = (options?: ResetOptions) => { resetState(options); doRenderApp(); };
(window as any).__rehydrateProposalReviewFixture = () => {
	resetState({ clearDismissals: false, clearPersisted: false, hydrateProposals: true });
	doRenderApp();
};
(window as any).__emitProposalFixture = (type: ProposalType, fields: Record<string, unknown>, opts?: { rev?: number; ignoreDismissal?: boolean }) => emitProposal(type, fields, opts || {});
(window as any).__setAllProposalFixtures = () => {
	for (const fixture of PROPOSAL_FIXTURES) emitProposal(fixture.type, fixture.initial);
};
(window as any).__readProposalSlot = (type: ProposalType) => activeSlot(type);
(window as any).__markProposalDismissed = (type: ProposalType) => {
	const fields = activeSlot(type);
	if (fields) markProposalDismissed(SESSION_ID, type, fields);
	delete state.activeProposals[type];
	state.assistantHasProposal = Object.keys(state.activeProposals).length > 0;
	renderApp();
};
(window as any).__proposalDismissalExists = (type: ProposalType) => !!localStorage.getItem(`bobbit-${type}-proposal-dismissed-${SESSION_ID}`);
(window as any).__dispatchProposalOpen = (type: ProposalType, fields: Record<string, unknown>, rev?: number) => {
	document.dispatchEvent(new CustomEvent("proposal-open", { detail: { type, fields, rev } }));
};
(window as any).__setReviewFixture = setReviewDocs;
(window as any).__getReviewState = () => ({
	open: state.reviewPanelOpen,
	active: state.reviewActiveTab,
	titles: [...state.reviewDocuments.keys()],
});
(window as any).__getProposalReviewFetchLog = () => fetchLog.slice();
(window as any).__getProposalReviewPromptLog = () => promptLog.slice();
(window as any).__proposalReviewReady = true;
