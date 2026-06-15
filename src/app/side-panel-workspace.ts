import { gatewayFetch } from "./gateway-fetch.js";
import { activeSessionId, renderApp, state } from "./state.js";
import {
	INBOX_PANEL_TAB_ID,
	assistantProposalType,
	buildPanelWorkspaceTabs,
	panelWorkspaceSessionKey,
	previewContentHashFromTab,
	previewEntryLabel,
	previewTabDisplayTitle,
	previewTabEntryFromId,
	previewTabVersionFromId,
	proposalPanelTabId,
	reviewDocumentIdFromPanelTab,
	reviewPanelTabId,
	reviewTitleFromPanelTab,
	type PanelWorkspaceTab,
} from "./panel-workspace.js";

export type SidePanelSizeMode = "collapsed" | "split" | "fullscreen";
export type SidePanelKind = "preview" | "proposal" | "review" | "inbox" | "pack";
export type SidePanelProposalType = "goal" | "project" | "role" | "tool" | "staff";

export interface SidePanelWorkspaceTab {
	id: string;
	kind: SidePanelKind;
	title: string;
	label: string;
	source:
		| { type: "preview"; sessionId: string; entry: string; live?: boolean; historical?: boolean; version?: number; artifactId?: string; contentHash?: string; path?: string; url?: string; toolUseId?: string; blockIndex?: number }
		| { type: "proposal"; sessionId: string; proposalType: SidePanelProposalType; rev?: number; historical?: boolean }
		| { type: "review"; sessionId: string; documentId: string; title: string }
		| { type: "inbox"; sessionId: string; staffId?: string }
		| { type: "pack"; sessionId: string; packId: string; panelId: string; instanceKey: string; singleton?: boolean; params?: Record<string, unknown> };
	state?: Record<string, unknown>;
	updatedAt: number;
}

export interface SidePanelWorkspaceMetadata {
	migratedFromLocalStorageAt?: number;
}

export interface SidePanelWorkspace {
	version: 1;
	sessionId: string;
	revision: number;
	tabs: SidePanelWorkspaceTab[];
	activeTabId: string;
	sizeMode: SidePanelSizeMode;
	metadata?: SidePanelWorkspaceMetadata;
	updatedAt: number;
}

type PreviewSource = Extract<SidePanelWorkspaceTab["source"], { type: "preview" }>;
type ProposalSource = Extract<SidePanelWorkspaceTab["source"], { type: "proposal" }>;
type ReviewSource = Extract<SidePanelWorkspaceTab["source"], { type: "review" }>;
type PackSource = Extract<SidePanelWorkspaceTab["source"], { type: "pack" }>;

export interface OpenSidePanelTabOptions {
	focus?: boolean;
	placeAfterActive?: boolean;
	baseRevision?: number;
	strictRevision?: boolean;
	skipRender?: boolean;
}

export interface SidePanelMutationOptions {
	baseRevision?: number;
	strictRevision?: boolean;
	skipRender?: boolean;
}

type PendingMutation = {
	id: string;
	baseRevision: number;
	baseWorkspace: SidePanelWorkspace;
};

const PANEL_TABS_STORAGE_KEY = "bobbit-panel-tabs-by-session";
const PANEL_ACTIVE_STORAGE_KEY = "bobbit-panel-active-by-session";
const mutationState = new Map<string, PendingMutation>();
let mutationCounter = 0;

function now(): number {
	return Date.now();
}

function emptyWorkspace(sessionId: string): SidePanelWorkspace {
	return {
		version: 1,
		sessionId,
		revision: 0,
		tabs: [],
		activeTabId: "",
		sizeMode: "split",
		updatedAt: now(),
	};
}

function isSizeMode(value: unknown): value is SidePanelSizeMode {
	return value === "collapsed" || value === "split" || value === "fullscreen";
}

function isPanelKind(value: unknown): value is SidePanelKind {
	return value === "preview" || value === "proposal" || value === "review" || value === "inbox" || value === "pack";
}

function isProposalType(value: unknown): value is SidePanelProposalType {
	return value === "goal" || value === "project" || value === "role" || value === "tool" || value === "staff";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function positiveInt(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

function cloneJsonRecord(value: unknown): Record<string, unknown> | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	try {
		const cloned = JSON.parse(JSON.stringify(record));
		return asRecord(cloned);
	} catch {
		return undefined;
	}
}

function decodeComponent(value: string): string {
	try { return decodeURIComponent(value); } catch { return value; }
}

function encodeComponent(value: string): string {
	return encodeURIComponent(value);
}

function normalizeTab(raw: unknown, sessionId: string): SidePanelWorkspaceTab | null {
	const tab = asRecord(raw);
	if (!tab) return null;
	const id = stringValue(tab.id);
	const kind = tab.kind;
	const source = asRecord(tab.source);
	if (!id || !isPanelKind(kind) || !source || source.type !== kind) return null;
	if (stringValue(source.sessionId) && stringValue(source.sessionId) !== sessionId) return null;
	const base = {
		id,
		kind,
		title: stringValue(tab.title) || stringValue(tab.label) || id,
		label: stringValue(tab.label) || stringValue(tab.title) || id,
		state: cloneJsonRecord(tab.state),
		updatedAt: typeof tab.updatedAt === "number" && Number.isFinite(tab.updatedAt) ? tab.updatedAt : now(),
	};
	if (kind === "preview") {
		const entry = previewEntryLabel(stringValue(source.entry) || previewTabEntryFromId(id) || undefined);
		if (!entry) return null;
		const version = positiveInt(source.version) ?? previewTabVersionFromId(id);
		return {
			...base,
			kind,
			source: {
				type: "preview",
				sessionId,
				entry,
				...(source.live === true ? { live: true } : {}),
				...(source.historical === true || version ? { historical: true } : {}),
				...(version ? { version } : {}),
				...(stringValue(source.artifactId) ? { artifactId: stringValue(source.artifactId) } : {}),
				...(stringValue(source.contentHash) ? { contentHash: stringValue(source.contentHash) } : {}),
				...(stringValue(source.path) ? { path: stringValue(source.path) } : {}),
				...(stringValue(source.url) ? { url: stringValue(source.url) } : {}),
				...(stringValue(source.toolUseId) ? { toolUseId: stringValue(source.toolUseId) } : {}),
				...(typeof source.blockIndex === "number" ? { blockIndex: source.blockIndex } : {}),
			},
		};
	}
	if (kind === "proposal") {
		const proposalType = source.proposalType;
		if (!isProposalType(proposalType)) return null;
		const rev = positiveInt(source.rev);
		return {
			...base,
			kind,
			source: { type: "proposal", sessionId, proposalType, ...(rev ? { rev, historical: true } : source.historical === true ? { historical: true } : {}) },
		};
	}
	if (kind === "review") {
		const documentId = stringValue(source.documentId);
		const title = stringValue(source.title) || base.title.replace(/^Review:\s*/, "");
		if (!documentId || !title) return null;
		return { ...base, kind, source: { type: "review", sessionId, documentId, title } };
	}
	if (kind === "inbox") {
		return { ...base, id: INBOX_PANEL_TAB_ID, kind, source: { type: "inbox", sessionId, ...(stringValue(source.staffId) ? { staffId: stringValue(source.staffId) } : {}) } };
	}
	const packId = stringValue(source.packId);
	const panelId = stringValue(source.panelId);
	const instanceKey = stringValue(source.instanceKey) || "default";
	if (!packId || !panelId || !instanceKey) return null;
	return {
		...base,
		kind,
		source: {
			type: "pack",
			sessionId,
			packId,
			panelId,
			instanceKey,
			...(source.singleton === true ? { singleton: true } : {}),
			...(cloneJsonRecord(source.params) ? { params: cloneJsonRecord(source.params) } : {}),
		},
	};
}

function normalizeWorkspace(raw: unknown, sessionId: string): SidePanelWorkspace {
	const record = asRecord(raw);
	if (!record) return emptyWorkspace(sessionId);
	const seen = new Set<string>();
	const tabs: SidePanelWorkspaceTab[] = [];
	for (const rawTab of Array.isArray(record.tabs) ? record.tabs : []) {
		const tab = normalizeTab(rawTab, sessionId);
		if (!tab || seen.has(tab.id)) continue;
		seen.add(tab.id);
		tabs.push(tab);
	}
	const activeTabId = stringValue(record.activeTabId);
	const metadata = asRecord(record.metadata);
	return {
		version: 1,
		sessionId,
		revision: typeof record.revision === "number" && Number.isFinite(record.revision) ? Math.max(0, Math.trunc(record.revision)) : 0,
		tabs,
		activeTabId: tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0]?.id || "",
		sizeMode: isSizeMode(record.sizeMode) ? record.sizeMode : "split",
		...(metadata?.migratedFromLocalStorageAt ? { metadata: { migratedFromLocalStorageAt: Number(metadata.migratedFromLocalStorageAt) } } : {}),
		updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : now(),
	};
}

function activeMirrorSessionKey(): string {
	return panelWorkspaceSessionKey(activeSessionId() || state.selectedSessionId || state.remoteAgent?.gatewaySessionId);
}

function toLegacyPanelTab(tab: SidePanelWorkspaceTab): PanelWorkspaceTab {
	if (tab.kind === "preview") {
		const source = tab.source as PreviewSource;
		const version = source.version;
		return {
			id: tab.id,
			kind: "preview",
			title: tab.title,
			label: tab.label,
			legacyTab: "preview",
			source: { ...source, type: "preview" },
			state: { ...(tab.state || {}), entry: source.entry, ...(version ? { version } : {}), ...(source.historical ? { historical: true } : {}) },
		};
	}
	if (tab.kind === "proposal") {
		const source = tab.source as ProposalSource;
		return {
			id: tab.id,
			kind: "proposal",
			title: tab.title,
			label: tab.label,
			legacyTab: source.proposalType,
			source,
			state: tab.state,
		};
	}
	if (tab.kind === "review") {
		const source = tab.source as ReviewSource;
		return {
			id: tab.id,
			kind: "review",
			title: tab.title,
			label: tab.label,
			legacyTab: "review",
			source: { ...source, reviewTitle: source.title } as PanelWorkspaceTab["source"],
			state: tab.state,
		};
	}
	if (tab.kind === "pack") {
		const source = tab.source as PackSource;
		return {
			id: tab.id,
			kind: "pack",
			title: tab.title,
			label: tab.label,
			legacyTab: "pack",
			source,
			state: { ...(tab.state || {}), packId: source.packId, panelId: source.panelId, instanceKey: source.instanceKey },
		};
	}
	return {
		id: INBOX_PANEL_TAB_ID,
		kind: "inbox",
		title: tab.title,
		label: tab.label,
		legacyTab: "inbox",
		source: tab.source,
		state: tab.state,
	};
}

function syncCompatibilityMirrors(workspace: SidePanelWorkspace): void {
	const sid = panelWorkspaceSessionKey(workspace.sessionId);
	const legacyTabs = workspace.tabs.map(toLegacyPanelTab);
	state.panelTabsBySession[sid] = legacyTabs;
	state.panelWorkspaceActiveBySession[sid] = workspace.activeTabId;
	if (activeMirrorSessionKey() === sid) {
		state.panelTabs = legacyTabs;
		state.activePanelTabId = workspace.activeTabId;
		state.previewPanelFullscreen = workspace.sizeMode === "fullscreen";
		state.inboxPanelOpen = workspace.tabs.some((tab) => tab.id === INBOX_PANEL_TAB_ID && tab.kind === "inbox");
	}
	(state as unknown as { panelWorkspace?: SidePanelWorkspace }).panelWorkspace = workspace;
}

export function getSidePanelWorkspace(sessionId?: string | null): SidePanelWorkspace {
	const sid = panelWorkspaceSessionKey(sessionId || activeSessionId() || state.selectedSessionId || undefined);
	return state.sidePanelWorkspaceBySession[sid] || emptyWorkspace(sid === "__no-session__" ? "" : sid);
}

export function applySidePanelWorkspaceFromServer(rawWorkspace: unknown, options: { source?: "hydrate" | "rest" | "ws"; skipRender?: boolean; force?: boolean } = {}): SidePanelWorkspace {
	const rawSessionId = stringValue(asRecord(rawWorkspace)?.sessionId) || activeSessionId() || state.selectedSessionId || "";
	const workspace = normalizeWorkspace(rawWorkspace, rawSessionId);
	const sid = panelWorkspaceSessionKey(workspace.sessionId);
	const currentRevision = state.lastWorkspaceRevisionBySession[sid];
	const force = options.source === "hydrate" || options.force === true;
	if (!force && typeof currentRevision === "number" && workspace.revision <= currentRevision) {
		return state.sidePanelWorkspaceBySession[sid] || workspace;
	}
	state.sidePanelWorkspaceBySession[sid] = workspace;
	state.lastWorkspaceRevisionBySession[sid] = workspace.revision;
	mutationState.delete(sid);
	syncCompatibilityMirrors(workspace);
	if (!options.skipRender) renderApp();
	return workspace;
}

function applyOptimisticWorkspace(workspace: SidePanelWorkspace, baseWorkspace: SidePanelWorkspace, options?: SidePanelMutationOptions): string {
	const sid = panelWorkspaceSessionKey(workspace.sessionId);
	const mutationId = `side-panel:${++mutationCounter}`;
	mutationState.set(sid, { id: mutationId, baseRevision: baseWorkspace.revision, baseWorkspace });
	state.sidePanelWorkspaceBySession[sid] = workspace;
	syncCompatibilityMirrors(workspace);
	if (!options?.skipRender) renderApp();
	return mutationId;
}

function withWorkspaceUpdate(workspace: SidePanelWorkspace, patch: Partial<SidePanelWorkspace>): SidePanelWorkspace {
	return { ...workspace, ...patch, updatedAt: now() };
}

function upsertTab(workspace: SidePanelWorkspace, tab: SidePanelWorkspaceTab, focus: boolean, placeAfterActive: boolean): SidePanelWorkspace {
	const normalizedTab = normalizeTab(tab, workspace.sessionId) || { ...tab, updatedAt: tab.updatedAt || now() };
	const tabs = workspace.tabs.slice();
	const index = tabs.findIndex((existing) => existing.id === normalizedTab.id);
	if (index >= 0) {
		tabs[index] = { ...tabs[index], ...normalizedTab, source: normalizedTab.source, state: normalizedTab.state ?? tabs[index].state, updatedAt: now() };
	} else if (placeAfterActive && workspace.activeTabId) {
		const activeIndex = tabs.findIndex((existing) => existing.id === workspace.activeTabId);
		tabs.splice(activeIndex >= 0 ? activeIndex + 1 : tabs.length, 0, { ...normalizedTab, updatedAt: now() });
	} else {
		tabs.push({ ...normalizedTab, updatedAt: now() });
	}
	return withWorkspaceUpdate(workspace, { tabs, activeTabId: focus ? normalizedTab.id : workspace.activeTabId || tabs[0]?.id || "" });
}

function nextActiveAfterClose(tabsBeforeClose: SidePanelWorkspaceTab[], closedId: string, previousActiveId: string): string {
	const remaining = tabsBeforeClose.filter((tab) => tab.id !== closedId);
	if (remaining.length === 0) return "";
	if (previousActiveId !== closedId && remaining.some((tab) => tab.id === previousActiveId)) return previousActiveId;
	const closedIndex = tabsBeforeClose.findIndex((tab) => tab.id === closedId);
	if (closedIndex < 0) return remaining[0]?.id || "";
	return remaining[Math.min(closedIndex, remaining.length - 1)]?.id || remaining[remaining.length - 1]?.id || "";
}

function pinnedFirstWorkspaceTabs(tabs: SidePanelWorkspaceTab[]): SidePanelWorkspaceTab[] {
	return tabs;
}

async function readJsonSafe(res: Response): Promise<unknown> {
	try { return await res.json(); } catch { return undefined; }
}

function workspaceFromResponseBody(body: unknown, sessionId: string): SidePanelWorkspace | undefined {
	const record = asRecord(body);
	if (!record) return undefined;
	const candidate = asRecord(record.workspace) || record;
	if (!candidate.tabs && !candidate.version) return undefined;
	return normalizeWorkspace(candidate, stringValue(candidate.sessionId) || sessionId);
}

class WorkspaceRequestError extends Error {
	workspace?: SidePanelWorkspace;
	status?: number;
	constructor(message: string, status?: number, workspace?: SidePanelWorkspace) {
		super(message);
		this.status = status;
		this.workspace = workspace;
	}
}

function useServerWorkspaceApi(): boolean {
	// Unit browser fixtures run from file:// with a mocked fetch layer and no
	// gateway REST API. Keep those fixtures optimistic/in-memory only; the real
	// app is served by the gateway and remains server-authoritative.
	return typeof window === "undefined" || window.location.protocol !== "file:";
}

function applyFixtureWorkspace(workspace: SidePanelWorkspace, options?: { skipRender?: boolean }): SidePanelWorkspace {
	state.sidePanelWorkspaceBySession[panelWorkspaceSessionKey(workspace.sessionId)] = workspace;
	syncCompatibilityMirrors(workspace);
	if (!options?.skipRender) renderApp();
	return workspace;
}

function sidePanelTabFromLegacyMirror(tab: PanelWorkspaceTab, sessionId: string): SidePanelWorkspaceTab | null {
	const updatedAt = now();
	if (tab.kind === "preview") {
		const source = asRecord(tab.source) || {};
		const tabState = asRecord(tab.state) || {};
		const entry = previewEntryLabel(stringValue(tabState.entry) || stringValue(source.entry) || previewTabEntryFromId(tab.id) || tab.title || undefined);
		const idVersion = previewTabVersionFromId(tab.id);
		const version = idVersion ?? positiveInt(source.version) ?? positiveInt(tabState.version);
		const historical = source.historical === true || tabState.historical === true || idVersion != null;
		const contentHash = previewContentHashFromTab(tab);
		const id = historical && version ? `preview:entry:${encodeComponent(entry)}:v:${version}` : `preview:entry:${encodeComponent(entry)}`;
		return {
			id,
			kind: "preview",
			title: tab.title || previewTabDisplayTitle(entry, version, historical),
			label: tab.label || tab.title || previewTabDisplayTitle(entry, version, historical),
			source: {
				type: "preview",
				sessionId,
				entry,
				...(historical ? { historical: true } : { live: true }),
				...(historical && version ? { version } : {}),
				...(stringValue(source.artifactId) ? { artifactId: stringValue(source.artifactId) } : {}),
				...(contentHash ? { contentHash } : {}),
				...(stringValue(source.path) ? { path: stringValue(source.path) } : {}),
				...(stringValue(source.url) ? { url: stringValue(source.url) } : {}),
				...(stringValue(source.toolUseId) ? { toolUseId: stringValue(source.toolUseId) } : {}),
				...(typeof source.blockIndex === "number" ? { blockIndex: source.blockIndex } : {}),
			},
			state: cloneJsonRecord(tab.state),
			updatedAt,
		};
	}
	if (tab.kind === "proposal") {
		const source = asRecord(tab.source) || {};
		const proposalType = stringValue(source.proposalType) as SidePanelProposalType;
		if (!isProposalType(proposalType)) return null;
		const rev = positiveInt(source.rev) ?? positiveInt(tab.state?.rev);
		return {
			id: proposalPanelTabId(proposalType, rev),
			kind: "proposal",
			title: tab.title,
			label: tab.label,
			source: { type: "proposal", sessionId, proposalType, ...(rev ? { rev, historical: true } : {}) },
			state: cloneJsonRecord(tab.state),
			updatedAt,
		};
	}
	if (tab.kind === "review") {
		const title = reviewTitleFromPanelTab(tab) || tab.title.replace(/^Review:\s*/, "") || "Review";
		const documentId = reviewDocumentIdFromPanelTab(tab) || title;
		return {
			id: reviewPanelTabId(documentId),
			kind: "review",
			title: `Review: ${title}`,
			label: `Review: ${title}`,
			source: { type: "review", sessionId, documentId, title },
			state: cloneJsonRecord(tab.state),
			updatedAt,
		};
	}
	if (tab.kind === "inbox") return { id: INBOX_PANEL_TAB_ID, kind: "inbox", title: tab.title || "Inbox", label: tab.label || "Inbox", source: { type: "inbox", sessionId }, state: cloneJsonRecord(tab.state), updatedAt };
	if (tab.kind === "pack") {
		const source = asRecord(tab.source) || {};
		const packId = stringValue(source.packId);
		const panelId = stringValue(source.panelId);
		const instanceKey = stringValue(source.instanceKey) || "default";
		if (!packId || !panelId) return null;
		return { id: `pack:${encodeComponent(packId)}:${encodeComponent(panelId)}:${encodeComponent(instanceKey)}`, kind: "pack", title: tab.title || panelId, label: tab.label || tab.title || panelId, source: { type: "pack", sessionId, packId, panelId, instanceKey, params: cloneJsonRecord(source.params) }, state: cloneJsonRecord(tab.state), updatedAt };
	}
	return null;
}

function fixtureInitialWorkspace(sessionId: string): SidePanelWorkspace | undefined {
	if (useServerWorkspaceApi()) return undefined;
	const sid = panelWorkspaceSessionKey(sessionId);
	const legacyTabs = Array.isArray(state.panelTabsBySession?.[sid]) ? state.panelTabsBySession[sid] as PanelWorkspaceTab[] : [];
	const derivedTabs = buildPanelWorkspaceTabs({
		sessionId,
		isPreviewSession: !!state.isPreviewSession,
		previewEntry: stringValue(state.previewPanelEntry),
		previewContentHash: stringValue((state as any).previewPanelContentHash),
		activeProposalTypes: Object.keys(state.activeProposals || {}) as any,
		assistantProposalType: assistantProposalType(state.assistantType),
		reviewTitles: state.reviewDocuments instanceof Map ? [...state.reviewDocuments.keys()] : [],
		reviewPanelOpen: !!state.reviewPanelOpen,
		inboxPanelOpen: !!state.inboxPanelOpen,
		inboxHasPending: Array.isArray(state.inboxEntries) && state.inboxEntries.length > 0,
	});
	const tabs: SidePanelWorkspaceTab[] = [];
	for (const legacy of [...legacyTabs, ...derivedTabs]) {
		const tab = sidePanelTabFromLegacyMirror(legacy, sessionId);
		if (tab && !tabs.some((existing) => existing.id === tab.id)) tabs.push(tab);
	}
	if (tabs.length === 0) return undefined;
	const requestedActive = stringValue(state.panelWorkspaceActiveBySession?.[sid]) || stringValue(state.activePanelTabId);
	return {
		version: 1,
		sessionId,
		revision: 0,
		tabs,
		activeTabId: tabs.some((tab) => tab.id === requestedActive) ? requestedActive : tabs[0]?.id || "",
		sizeMode: "split",
		updatedAt: now(),
	};
}

async function workspaceRequest(sessionId: string, path: string, init: RequestInit = {}): Promise<SidePanelWorkspace> {
	const res = await gatewayFetch(`/api/sessions/${encodeComponent(sessionId)}/side-panel-workspace${path}`, init);
	const body = await readJsonSafe(res);
	const workspace = workspaceFromResponseBody(body, sessionId);
	if (!res.ok) throw new WorkspaceRequestError(`Side-panel workspace request failed: ${res.status}`, res.status, workspace);
	if (!workspace) throw new WorkspaceRequestError("Invalid side-panel workspace response", res.status);
	return workspace;
}

async function fetchWorkspace(sessionId: string): Promise<SidePanelWorkspace | undefined> {
	const res = await gatewayFetch(`/api/sessions/${encodeComponent(sessionId)}/side-panel-workspace`);
	if (res.status === 404) return undefined;
	const body = await readJsonSafe(res);
	if (!res.ok) throw new WorkspaceRequestError(`Side-panel workspace fetch failed: ${res.status}`, res.status, workspaceFromResponseBody(body, sessionId));
	const workspace = workspaceFromResponseBody(body, sessionId);
	if (!workspace) throw new WorkspaceRequestError("Invalid side-panel workspace response", res.status);
	return workspace;
}

async function settleMutation(sessionId: string, mutationId: string, request: Promise<SidePanelWorkspace>): Promise<SidePanelWorkspace> {
	const sid = panelWorkspaceSessionKey(sessionId);
	try {
		const workspace = await request;
		if (mutationState.get(sid)?.id === mutationId) mutationState.delete(sid);
		return applySidePanelWorkspaceFromServer(workspace, { source: "rest" });
	} catch (err) {
		const pending = mutationState.get(sid);
		const ownsPending = pending?.id === mutationId;
		if (ownsPending) mutationState.delete(sid);
		const latest = err instanceof WorkspaceRequestError ? err.workspace : undefined;
		if (latest) return applySidePanelWorkspaceFromServer(latest, { source: "rest", force: ownsPending });
		try {
			const refetched = await fetchWorkspace(sessionId);
			if (refetched) return applySidePanelWorkspaceFromServer(refetched, { source: "hydrate" });
		} catch { /* fall through to local rollback */ }
		if (pending && ownsPending) {
			state.sidePanelWorkspaceBySession[sid] = pending.baseWorkspace;
			state.lastWorkspaceRevisionBySession[sid] = pending.baseRevision;
			syncCompatibilityMirrors(pending.baseWorkspace);
			renderApp();
			return pending.baseWorkspace;
		}
		throw err;
	}
}

function mutationBody(extra: Record<string, unknown>, workspace: SidePanelWorkspace, options?: SidePanelMutationOptions): string {
	return JSON.stringify({
		...extra,
		baseRevision: options?.baseRevision ?? workspace.revision,
		...(options?.strictRevision === true ? { strictRevision: true } : {}),
	});
}

export async function hydrateSidePanelWorkspace(sessionId: string): Promise<SidePanelWorkspace> {
	mutationState.delete(panelWorkspaceSessionKey(sessionId));
	if (!useServerWorkspaceApi()) {
		const workspace = state.sidePanelWorkspaceBySession[panelWorkspaceSessionKey(sessionId)] || emptyWorkspace(sessionId);
		state.sidePanelWorkspaceBySession[panelWorkspaceSessionKey(sessionId)] = workspace;
		syncCompatibilityMirrors(workspace);
		renderApp();
		return workspace;
	}
	try {
		const fetched = await fetchWorkspace(sessionId);
		if (!fetched) {
			const empty = emptyWorkspace(sessionId);
			return applySidePanelWorkspaceFromServer(empty, { source: "hydrate" });
		}
		const workspace = applySidePanelWorkspaceFromServer(fetched, { source: "hydrate" });
		if (workspace.tabs.length === 0 && !workspace.metadata?.migratedFromLocalStorageAt) {
			void migrateLegacySidePanelLocalStorage(sessionId);
		}
		return workspace;
	} catch (err) {
		console.warn("[side-panel] hydrate failed", err);
		const fallback = state.sidePanelWorkspaceBySession[panelWorkspaceSessionKey(sessionId)] || emptyWorkspace(sessionId);
		state.sidePanelWorkspaceBySession[panelWorkspaceSessionKey(sessionId)] = fallback;
		syncCompatibilityMirrors(fallback);
		renderApp();
		return fallback;
	}
}

function mutationBaseWorkspace(sessionId: string): SidePanelWorkspace {
	const sid = panelWorkspaceSessionKey(sessionId);
	return state.sidePanelWorkspaceBySession[sid] || fixtureInitialWorkspace(sessionId) || getSidePanelWorkspace(sessionId);
}

export async function openSidePanelTab(tab: SidePanelWorkspaceTab, options: OpenSidePanelTabOptions = {}): Promise<SidePanelWorkspace> {
	const sessionId = tab.source.sessionId;
	const base = mutationBaseWorkspace(sessionId);
	const focus = options.focus !== false;
	const optimistic = upsertTab(base, tab, focus, options.placeAfterActive !== false);
	if (!useServerWorkspaceApi()) return applyFixtureWorkspace(optimistic, options);
	const mutationId = applyOptimisticWorkspace(optimistic, base, options);
	return settleMutation(sessionId, mutationId, workspaceRequest(sessionId, "/open", {
		method: "POST",
		body: mutationBody({ tab, focus, placeAfterActive: options.placeAfterActive !== false }, base, options),
	}));
}

export async function updateSidePanelTab(tabId: string, patch: Partial<SidePanelWorkspaceTab>, options: SidePanelMutationOptions & { sessionId?: string } = {}): Promise<SidePanelWorkspace> {
	const sessionId = options.sessionId || activeSessionId() || state.selectedSessionId || "";
	const base = mutationBaseWorkspace(sessionId);
	const tabs = base.tabs.map((tab) => tab.id === tabId ? normalizeTab({ ...tab, ...patch, id: tab.id, source: patch.source || tab.source }, base.sessionId) || tab : tab);
	const optimistic = withWorkspaceUpdate(base, { tabs });
	if (!useServerWorkspaceApi()) return applyFixtureWorkspace(optimistic, options);
	const mutationId = applyOptimisticWorkspace(optimistic, base, options);
	return settleMutation(base.sessionId, mutationId, workspaceRequest(base.sessionId, `/tabs/${encodeComponent(tabId)}`, {
		method: "PATCH",
		body: mutationBody({ patch }, base, options),
	}));
}

export async function closeSidePanelTab(tabId: string, options: SidePanelMutationOptions & { sessionId?: string } = {}): Promise<SidePanelWorkspace> {
	const sessionId = options.sessionId || activeSessionId() || state.selectedSessionId || "";
	const base = mutationBaseWorkspace(sessionId);
	const tabs = base.tabs.filter((tab) => tab.id !== tabId);
	const optimistic = withWorkspaceUpdate(base, { tabs, activeTabId: nextActiveAfterClose(base.tabs, tabId, base.activeTabId) });
	if (!useServerWorkspaceApi()) return applyFixtureWorkspace(optimistic, options);
	const mutationId = applyOptimisticWorkspace(optimistic, base, options);
	return settleMutation(base.sessionId, mutationId, workspaceRequest(base.sessionId, `/tabs/${encodeComponent(tabId)}`, { method: "DELETE" }));
}

export async function setActiveSidePanelTab(tabId: string, options: SidePanelMutationOptions & { sessionId?: string } = {}): Promise<SidePanelWorkspace> {
	const sessionId = options.sessionId || activeSessionId() || state.selectedSessionId || "";
	const base = mutationBaseWorkspace(sessionId);
	const activeTabId = tabId && base.tabs.some((tab) => tab.id === tabId) ? tabId : "";
	const optimistic = withWorkspaceUpdate(base, { activeTabId });
	if (!useServerWorkspaceApi()) return applyFixtureWorkspace(optimistic, options);
	const mutationId = applyOptimisticWorkspace(optimistic, base, options);
	return settleMutation(base.sessionId, mutationId, workspaceRequest(base.sessionId, "/active", {
		method: "POST",
		body: mutationBody({ activeTabId }, base, options),
	}));
}

export async function reorderSidePanelTabs(tabIds: string[], baseRevision?: number, options: SidePanelMutationOptions & { sessionId?: string } = {}): Promise<SidePanelWorkspace> {
	const sessionId = options.sessionId || activeSessionId() || state.selectedSessionId || "";
	const base = mutationBaseWorkspace(sessionId);
	const byId = new Map(base.tabs.map((tab) => [tab.id, tab]));
	const seen = new Set<string>();
	const orderedInputIds: string[] = [];
	for (const id of tabIds) {
		if (!byId.has(id) || seen.has(id)) continue;
		seen.add(id);
		orderedInputIds.push(id);
	}
	let ordered = orderedInputIds.map((id) => byId.get(id)).filter((tab): tab is SidePanelWorkspaceTab => !!tab);
	for (const tab of base.tabs) if (!seen.has(tab.id)) ordered.push(tab);
	ordered = pinnedFirstWorkspaceTabs(ordered);
	const orderedIds = ordered.map((tab) => tab.id);
	const revision = baseRevision ?? options.baseRevision ?? base.revision;
	const optimistic = withWorkspaceUpdate(base, { tabs: ordered, activeTabId: ordered.some((tab) => tab.id === base.activeTabId) ? base.activeTabId : ordered[0]?.id || "" });
	if (!useServerWorkspaceApi()) return applyFixtureWorkspace(optimistic, options);
	const mutationId = applyOptimisticWorkspace(optimistic, base, options);
	return settleMutation(base.sessionId, mutationId, workspaceRequest(base.sessionId, "/reorder", {
		method: "POST",
		body: mutationBody({ tabIds: orderedIds, baseRevision: revision }, base, { ...options, baseRevision: revision }),
	}));
}

export async function setSidePanelSizeMode(sizeMode: SidePanelSizeMode, options: SidePanelMutationOptions & { sessionId?: string } = {}): Promise<SidePanelWorkspace> {
	const sessionId = options.sessionId || activeSessionId() || state.selectedSessionId || "";
	const base = mutationBaseWorkspace(sessionId);
	const optimistic = withWorkspaceUpdate(base, { sizeMode });
	if (!useServerWorkspaceApi()) return applyFixtureWorkspace(optimistic, options);
	const mutationId = applyOptimisticWorkspace(optimistic, base, options);
	return settleMutation(base.sessionId, mutationId, workspaceRequest(base.sessionId, "/resize", {
		method: "POST",
		body: mutationBody({ sizeMode }, base, options),
	}));
}

function readLocalObject(key: string): Record<string, unknown> | undefined {
	try {
		if (typeof localStorage === "undefined") return undefined;
		const raw = localStorage.getItem(key);
		if (!raw) return undefined;
		return asRecord(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

async function sha256Compat(input: string): Promise<string> {
	try {
		const bytes = new TextEncoder().encode(input);
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
	} catch {
		let hash = 2166136261;
		for (let i = 0; i < input.length; i++) hash = Math.imul(hash ^ input.charCodeAt(i), 16777619);
		return (hash >>> 0).toString(16).padStart(8, "0");
	}
}

function legacyPackParts(id: string, source: Record<string, unknown>): { packId: string; panelId: string; instanceKey: string } | undefined {
	const parts = id.split(":");
	if (parts[0] !== "pack") return undefined;
	const packId = decodeComponent(parts[1] || stringValue(source.packId));
	const panelId = decodeComponent(parts[2] || stringValue(source.panelId));
	const instanceKey = decodeComponent(parts[3] || stringValue(source.instanceKey) || "default");
	return packId && panelId ? { packId, panelId, instanceKey } : undefined;
}

async function legacyTabToSidePanel(tab: PanelWorkspaceTab, sessionId: string): Promise<SidePanelWorkspaceTab | null> {
	const updatedAt = now();
	if (tab.kind === "preview") {
		const entry = previewEntryLabel(previewTabEntryFromId(tab.id) || stringValue((tab.source as Record<string, unknown>).entry) || tab.title);
		const version = previewTabVersionFromId(tab.id);
		const title = previewTabDisplayTitle(entry, version, version != null);
		const contentHash = previewContentHashFromTab(tab);
		return {
			id: version ? `preview:entry:${encodeComponent(entry)}:v:${version}` : `preview:entry:${encodeComponent(entry)}`,
			kind: "preview",
			title,
			label: title,
			source: { type: "preview", sessionId, entry, live: version == null, ...(version ? { version, historical: true } : {}), ...(contentHash ? { contentHash } : {}) },
			state: tab.state,
			updatedAt,
		};
	}
	if (tab.kind === "proposal" && tab.source.type === "proposal" && isProposalType(tab.source.proposalType)) {
		const rev = positiveInt(tab.source.rev);
		return { id: rev ? `proposal:${tab.source.proposalType}:rev:${rev}` : `proposal:${tab.source.proposalType}`, kind: "proposal", title: tab.title, label: tab.label, source: { type: "proposal", sessionId, proposalType: tab.source.proposalType, ...(rev ? { rev, historical: true } : {}) }, state: tab.state, updatedAt };
	}
	if (tab.kind === "review") {
		const title = reviewTitleFromPanelTab(tab) || tab.title.replace(/^Review:\s*/, "") || "Review";
		const documentId = `legacy-title:${(await sha256Compat(title)).slice(0, 16)}`;
		return { id: `review:${encodeComponent(documentId)}`, kind: "review", title: `Review: ${title}`, label: `Review: ${title}`, source: { type: "review", sessionId, documentId, title }, state: tab.state, updatedAt };
	}
	if (tab.kind === "inbox") {
		return { id: INBOX_PANEL_TAB_ID, kind: "inbox", title: tab.title || "Inbox", label: tab.label || "Inbox", source: { type: "inbox", sessionId }, state: tab.state, updatedAt };
	}
	if (tab.kind === "pack") {
		const source = asRecord(tab.source) || {};
		const parts = legacyPackParts(tab.id, source);
		if (!parts) return null;
		return { id: `pack:${encodeComponent(parts.packId)}:${encodeComponent(parts.panelId)}:${encodeComponent(parts.instanceKey)}`, kind: "pack", title: tab.title || parts.panelId, label: tab.label || tab.title || parts.panelId, source: { type: "pack", sessionId, ...parts, params: cloneJsonRecord(source.params) }, state: tab.state, updatedAt };
	}
	return null;
}

export async function migrateLegacySidePanelLocalStorage(sessionId: string): Promise<SidePanelWorkspace | undefined> {
	const existing = getSidePanelWorkspace(sessionId);
	if (existing.tabs.length > 0 || existing.metadata?.migratedFromLocalStorageAt) return existing;
	const sid = panelWorkspaceSessionKey(sessionId);
	const tabsBySession = readLocalObject(PANEL_TABS_STORAGE_KEY);
	const activeBySession = readLocalObject(PANEL_ACTIVE_STORAGE_KEY);
	const legacyTabs = Array.isArray(tabsBySession?.[sid]) ? tabsBySession[sid] as PanelWorkspaceTab[] : [];
	const tabs: SidePanelWorkspaceTab[] = [];
	for (const legacyTab of legacyTabs) {
		const tab = await legacyTabToSidePanel(legacyTab, sessionId);
		if (tab && !tabs.some((existingTab) => existingTab.id === tab.id)) tabs.push(tab);
	}
	const oldCollapsedRaw = (() => {
		try { return typeof localStorage !== "undefined" ? localStorage.getItem(`bobbit-preview-collapsed-${sessionId}`) : null; } catch { return null; }
	})();
	const sizeMode: SidePanelSizeMode = oldCollapsedRaw === "true" ? "collapsed" : existing.sizeMode;
	if (tabs.length === 0 && sizeMode === existing.sizeMode) return undefined;
	const requestedActive = stringValue(activeBySession?.[sid]);
	const activeTabId = tabs.some((tab) => tab.id === requestedActive) ? requestedActive : tabs[0]?.id || "";
	try {
		const workspace = await workspaceRequest(sessionId, "/migrate", {
			method: "POST",
			body: JSON.stringify({ tabs, activeTabId, sizeMode, metadata: { migratedFromLocalStorageAt: now() } }),
		});
		return applySidePanelWorkspaceFromServer(workspace, { source: "rest" });
	} catch (err) {
		console.warn("[side-panel] legacy migration failed", err);
		return undefined;
	}
}

export function activeSidePanelTab(sessionId?: string | null): SidePanelWorkspaceTab | undefined {
	const workspace = getSidePanelWorkspace(sessionId);
	return workspace.tabs.find((tab) => tab.id === workspace.activeTabId);
}

export function hasActiveSidePanel(sessionId?: string | null): boolean {
	return !!activeSidePanelTab(sessionId);
}

export function sidePanelSizeMode(sessionId?: string | null): SidePanelSizeMode {
	return getSidePanelWorkspace(sessionId).sizeMode;
}

export function sidePanelPopoutUrl(tab: SidePanelWorkspaceTab): string {
	if (tab.kind === "preview") {
		const source = tab.source as PreviewSource;
		const entry = encodeComponent(source.entry || "inline.html");
		if (source.artifactId) return `/preview/${encodeComponent(source.sessionId)}/_artifact/${encodeComponent(source.artifactId)}/${entry}`;
		return `/preview/${encodeComponent(source.sessionId)}/${entry}`;
	}
	return `#/session/${encodeComponent(tab.source.sessionId)}/panel/${encodeComponent(tab.id)}`;
}

export function sidePanelTabIds(sessionId?: string | null): string[] {
	return getSidePanelWorkspace(sessionId).tabs.map((tab) => tab.id);
}
