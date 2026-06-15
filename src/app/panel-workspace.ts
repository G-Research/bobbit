import type { ProposalType } from "./proposal-registry.js";

export type PanelWorkspaceKind = "preview" | "proposal" | "review" | "inbox" | "pack";
export type LegacyPanelWorkspaceKind = PanelWorkspaceKind | "chat";
export type LegacyPanelTab = "chat" | "preview" | "review" | "inbox" | "pack" | ProposalType;

export interface PanelWorkspaceTab {
	id: string;
	/** New side-pane tabs use PanelWorkspaceKind; "chat" is tolerated only for legacy migration callers. */
	kind: LegacyPanelWorkspaceKind;
	/** Stable, source-derived title for the tab artifact. */
	title: string;
	/** Short label retained for existing tab selectors and compact UI. */
	label: string;
	legacyTab: LegacyPanelTab;
	source:
		| { type: "chat"; sessionId?: string }
		| {
			type: "preview" | "html-preview" | "preview_open";
			entry?: string;
			sessionId?: string;
			live?: boolean;
			origin?: string;
			url?: string;
			path?: string;
			snapshotKind?: string;
			toolUseId?: string;
			blockIndex?: number;
			params?: Record<string, unknown>;
			[key: string]: unknown;
		}
		| { type: "proposal"; proposalType: ProposalType; sessionId?: string; rev?: number; historical?: boolean; [key: string]: unknown }
		| { type: "review"; documentId?: string; title?: string; reviewTitle?: string; sessionId?: string }
		| { type: "inbox"; sessionId?: string }
		| {
			/** A pack-contributed side panel (pack schema V1 §8.1). `{packId, panelId,
			 *  instanceKey}` is the COMPOUND key into the client pack-panel registry
			 *  (panel ids are only pack-unique now); `params` is the typed
			 *  PanelTarget.params the panel rehydrates from (e.g. `{ artifactId }`). */
			type: "pack";
			packId: string;
			panelId: string;
			instanceKey?: string;
			singleton?: boolean;
			params?: Record<string, unknown>;
			sessionId?: string;
			[key: string]: unknown;
		};
	state?: Record<string, unknown>;
}

export const CHAT_PANEL_TAB_ID = "chat";
export const LIVE_PREVIEW_PANEL_TAB_ID = "preview:live";
export const LEGACY_LIVE_PREVIEW_PANEL_TAB_ID = "preview";
export const INBOX_PANEL_TAB_ID = "inbox";
export const DEFAULT_PACK_PANEL_INSTANCE_KEY = "default";
export const PANEL_WORKSPACE_NO_SESSION_KEY = "__no-session__";
const PANEL_TABS_STORAGE_KEY = "bobbit-panel-tabs-by-session";
const PANEL_ACTIVE_STORAGE_KEY = "bobbit-panel-active-by-session";
const PANEL_VERSIONS_STORAGE_KEY = "bobbit-preview-versions-by-session";

function hasLocalStorage(): boolean {
	try { return typeof localStorage !== "undefined"; } catch { return false; }
}

function safeReadObject(key: string): Record<string, unknown> | undefined {
	if (!hasLocalStorage()) return undefined;
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return undefined;
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
	} catch { return undefined; }
}

function safeWriteObject(key: string, value: unknown): void {
	if (!hasLocalStorage()) return;
	try { localStorage.setItem(key, JSON.stringify(value || {})); } catch { /* quota/SSR */ }
}

export function loadPersistedPanelWorkspace(stateLike: any): void {
	if (!stateLike || typeof stateLike !== "object") return;
	// Real app side-panel tabs/active state are server-authoritative. Legacy
	// tab/active localStorage is read only by the one-shot migration path in
	// side-panel-workspace.ts; keep file:// fixtures working without making the
	// gateway UI resurrect closed tabs from old keys.
	const isFileFixture = typeof window !== "undefined" && window.location?.protocol === "file:";
	if (isFileFixture) {
		const tabs = safeReadObject(PANEL_TABS_STORAGE_KEY);
		if (tabs) stateLike.panelTabsBySession = tabs as Record<string, PanelWorkspaceTab[]>;
		const active = safeReadObject(PANEL_ACTIVE_STORAGE_KEY);
		if (active) stateLike.panelWorkspaceActiveBySession = active as Record<string, string>;
	}
	const versions = safeReadObject(PANEL_VERSIONS_STORAGE_KEY);
	if (versions) stateLike.previewVersionsBySession = versions as Record<string, Record<string, PreviewVersionRecord>>;
}

function persistPanelWorkspace(stateLike: any): void {
	if (!stateLike || typeof stateLike !== "object") return;
	const isFileFixture = typeof window !== "undefined" && window.location?.protocol === "file:";
	if (isFileFixture) {
		safeWriteObject(PANEL_TABS_STORAGE_KEY, stateLike.panelTabsBySession);
		safeWriteObject(PANEL_ACTIVE_STORAGE_KEY, stateLike.panelWorkspaceActiveBySession);
	}
	safeWriteObject(PANEL_VERSIONS_STORAGE_KEY, stateLike.previewVersionsBySession);
}

const PROPOSAL_LABELS: Record<ProposalType, string> = {
	goal: "Goal",
	project: "Project",
	role: "Role",
	tool: "Tool",
	staff: "Staff",
};

const PREVIEW_ENTRY_ID_RE = /^preview:entry:([^:]+)(?::v:(\d+))?$/;
const PROPOSAL_ID_RE = /^proposal:([^:]+)(?::rev:(\d+))?$/;
// Pack side-panel tab id scheme `pack:<encoded packId>:<encoded panelId>:<encoded instanceKey>`.
// Legacy two-part ids are accepted for migration compatibility.
const PACK_PANEL_ID_RE = /^pack:([^:]+):([^:]+)(?::([^:]+))?$/;

function isLegacyPreviewPanelTabId(id: string | null | undefined): boolean {
	return id === LEGACY_LIVE_PREVIEW_PANEL_TAB_ID || id === LIVE_PREVIEW_PANEL_TAB_ID;
}

function decodeTabComponent(value: string): string | undefined {
	try { return decodeURIComponent(value); } catch { return undefined; }
}

function positiveInteger(value: string | number | undefined): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : NaN;
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function previewEntryLabel(entry: string | undefined | null): string {
	const clean = (entry || "inline.html").split(/[?#]/, 1)[0]?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "inline.html";
	return clean.split("/").filter(Boolean).pop() || clean || "inline.html";
}

export function previewEntryTabId(entry: string | undefined | null): string {
	return `preview:entry:${encodeURIComponent(previewEntryLabel(entry))}`;
}

export function previewVersionedTabId(entry: string | undefined | null, version: number): string {
	return `${previewEntryTabId(entry)}:v:${Math.max(1, Math.trunc(version))}`;
}

export function previewTabDisplayTitle(entry: string | undefined | null, version?: number, historical = false): string {
	const label = previewEntryLabel(entry);
	return historical && typeof version === "number" && Number.isFinite(version) && version > 0
		? `${label} (v${Math.trunc(version)})`
		: label;
}

export function previewTabEntryFromId(id: string | null | undefined): string | undefined {
	if (!id) return undefined;
	const match = PREVIEW_ENTRY_ID_RE.exec(id);
	if (!match) return undefined;
	const decoded = decodeTabComponent(match[1]);
	return decoded ? previewEntryLabel(decoded) : undefined;
}

export function previewTabVersionFromId(id: string | null | undefined): number | undefined {
	if (!id) return undefined;
	const match = PREVIEW_ENTRY_ID_RE.exec(id);
	return match ? positiveInteger(match[2]) : undefined;
}

function isPreviewPanelTabId(id: string): boolean {
	const match = PREVIEW_ENTRY_ID_RE.exec(id);
	if (!match) return false;
	const entry = decodeTabComponent(match[1]);
	if (!entry || !previewEntryLabel(entry)) return false;
	return match[2] == null || positiveInteger(match[2]) != null;
}

function isCurrentPreviewEntryTabId(id: string | null | undefined): boolean {
	return typeof id === "string" && isPreviewPanelTabId(id) && previewTabVersionFromId(id) == null;
}

function proposalTypeFromId(id: string): ProposalType | undefined {
	const match = PROPOSAL_ID_RE.exec(id);
	if (!match) return undefined;
	const type = match[1] as ProposalType;
	if (!Object.prototype.hasOwnProperty.call(PROPOSAL_LABELS, type)) return undefined;
	if (match[2] != null && positiveInteger(match[2]) == null) return undefined;
	return type;
}

function isReviewPanelTabId(id: string): boolean {
	if (!id.startsWith("review:")) return false;
	const encoded = id.slice("review:".length);
	if (!encoded) return false;
	const decoded = decodeTabComponent(encoded);
	return typeof decoded === "string" && decoded.length > 0;
}

/** A `{packId, panelId, instanceKey}` reference into the client pack-panel registry.
 *  `legacyTwoPart` is true only for migrated `pack:<packId>:<panelId>` ids; callers
 *  should canonicalize those to instanceKey `default` when writing new state. */
export interface PackPanelRef {
	packId: string;
	panelId: string;
	instanceKey: string;
	legacyTwoPart?: boolean;
}

/** Build the side-panel tab id for a pack panel (pack schema V1 §8.1) — encodes
 *  packId, panelId, and durable instanceKey because panel ids are pack-unique and
 *  a panel may have multiple parameterized instances. */
export function packPanelTabId(packId: string, panelId: string, instanceKey: string = DEFAULT_PACK_PANEL_INSTANCE_KEY): string {
	const key = instanceKey && typeof instanceKey === "string" ? instanceKey : DEFAULT_PACK_PANEL_INSTANCE_KEY;
	return `pack:${encodeURIComponent(packId)}:${encodeURIComponent(panelId)}:${encodeURIComponent(key)}`;
}

/** Extract the `{packId, panelId, instanceKey}` from a pack tab id, or undefined
 *  if not one. Legacy two-part `pack:<packId>:<panelId>` ids are accepted and
 *  returned with instanceKey `default` for one-time migration compatibility. */
export function packPanelRefFromTabId(id: string | null | undefined): PackPanelRef | undefined {
	if (!id) return undefined;
	const match = PACK_PANEL_ID_RE.exec(id);
	if (!match) return undefined;
	const packId = decodeTabComponent(match[1]);
	const panelId = decodeTabComponent(match[2]);
	const decodedInstanceKey = match[3] == null ? DEFAULT_PACK_PANEL_INSTANCE_KEY : decodeTabComponent(match[3]);
	return packId && panelId && decodedInstanceKey
		? { packId, panelId, instanceKey: decodedInstanceKey, legacyTwoPart: match[3] == null || undefined }
		: undefined;
}

function isPackPanelTabId(id: string): boolean {
	return packPanelRefFromTabId(id) != null;
}

export function isSidePanelTabId(id: unknown): id is string {
	if (typeof id !== "string" || !id) return false;
	if (id === INBOX_PANEL_TAB_ID) return true;
	if (isPreviewPanelTabId(id)) return true;
	if (proposalTypeFromId(id)) return true;
	if (isReviewPanelTabId(id)) return true;
	return isPackPanelTabId(id);
}

function panelTabKindFromId(id: string): PanelWorkspaceKind | undefined {
	if (id === INBOX_PANEL_TAB_ID) return "inbox";
	if (isPreviewPanelTabId(id)) return "preview";
	if (proposalTypeFromId(id)) return "proposal";
	if (isReviewPanelTabId(id)) return "review";
	if (isPackPanelTabId(id)) return "pack";
	return undefined;
}

export function isPinnedPanelTab(_tab: PanelWorkspaceTab | undefined | null): boolean {
	return false;
}

export function isLivePreviewTab(tab: PanelWorkspaceTab | undefined | null): boolean {
	if (!tab || tab.kind !== "preview") return false;
	if (tab.id === LIVE_PREVIEW_PANEL_TAB_ID || tab.id === LEGACY_LIVE_PREVIEW_PANEL_TAB_ID || tab.id.startsWith("preview:live")) return true;
	const source = tab.source as Record<string, unknown> | undefined;
	const tabState = tab.state as Record<string, unknown> | undefined;
	const hasArtifact = typeof source?.artifactId === "string" && source.artifactId
		|| typeof tabState?.artifactId === "string" && tabState.artifactId;
	const hasLiveSource = source?.live === true || source?.origin === "preview-bootstrap" || source?.origin === "preview-events";
	// Current filename tabs are live when the preview event explicitly marks them
	// live, even if the server also attached an immutable artifact for historical
	// restore. Historical/versioned tabs keep using their artifact-backed URLs.
	if (isCurrentPreviewEntryTabId(tab.id) && !isHistoricalPreviewTab(tab)) return hasLiveSource || !hasArtifact;
	if (hasArtifact) return false;
	return hasLiveSource;
}

export function normalizePreviewContentHash(value: unknown): string {
	if (typeof value !== "string") return "";
	const hash = value.trim().toLowerCase();
	return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

export function previewContentHashFromTab(tab: PanelWorkspaceTab | undefined | null): string {
	if (!tab || tab.kind !== "preview") return "";
	const source = tab.source as Record<string, unknown> | undefined;
	const tabState = tab.state as Record<string, unknown> | undefined;
	return normalizePreviewContentHash(tabState?.contentHash) || normalizePreviewContentHash(source?.contentHash);
}

export function previewTabsHaveSameContent(a: PanelWorkspaceTab | undefined | null, b: PanelWorkspaceTab | undefined | null): boolean {
	const ah = previewContentHashFromTab(a);
	return !!ah && ah === previewContentHashFromTab(b);
}

export function previewTabAllowsLiveDedupe(tab: PanelWorkspaceTab | undefined | null): boolean {
	if (!tab || tab.kind !== "preview") return true;
	const source = tab.source as Record<string, unknown> | undefined;
	const tabState = tab.state as Record<string, unknown> | undefined;
	return source?.dedupeWithLive !== false && tabState?.dedupeWithLive !== false;
}

export function previewTabVersion(tab: PanelWorkspaceTab | undefined | null): number | undefined {
	const stateRev = tab?.state?.version;
	if (typeof stateRev === "number" && Number.isFinite(stateRev) && stateRev > 0) return Math.trunc(stateRev);
	const source = tab?.source as Record<string, unknown> | undefined;
	const sourceRev = source?.version;
	if (typeof sourceRev === "number" && Number.isFinite(sourceRev) && sourceRev > 0) return Math.trunc(sourceRev);
	return previewTabVersionFromId(tab?.id);
}

export function isHistoricalPreviewTab(tab: PanelWorkspaceTab | undefined | null): boolean {
	if (!tab || tab.kind !== "preview") return false;
	const source = tab.source as Record<string, unknown> | undefined;
	return tab.state?.historical === true || source?.historical === true || tab.state?.dedupeWithLive === false || source?.dedupeWithLive === false || previewTabVersionFromId(tab.id) != null;
}

export interface PreviewVersionRecord {
	latestVersion: number;
	latestContentHash?: string;
	hashToVersion: Record<string, number>;
}

function ensurePreviewVersionRecord(stateLike: any, sessionId: string, entry: string): PreviewVersionRecord {
	if (!stateLike.previewVersionsBySession || typeof stateLike.previewVersionsBySession !== "object" || Array.isArray(stateLike.previewVersionsBySession)) {
		stateLike.previewVersionsBySession = {};
	}
	const bySession = stateLike.previewVersionsBySession as Record<string, Record<string, PreviewVersionRecord>>;
	const sid = panelWorkspaceSessionKey(sessionId);
	if (!bySession[sid] || typeof bySession[sid] !== "object" || Array.isArray(bySession[sid])) bySession[sid] = {};
	const key = previewEntryLabel(entry);
	if (!bySession[sid][key] || typeof bySession[sid][key] !== "object") {
		bySession[sid][key] = { latestVersion: 0, hashToVersion: {} };
	}
	if (!bySession[sid][key].hashToVersion || typeof bySession[sid][key].hashToVersion !== "object") bySession[sid][key].hashToVersion = {};
	if (!Number.isFinite(bySession[sid][key].latestVersion)) bySession[sid][key].latestVersion = 0;
	return bySession[sid][key];
}

export function previewVersionRecordFor(stateLike: any, sessionId: string, entry: string | undefined | null): PreviewVersionRecord | undefined {
	const sid = panelWorkspaceSessionKey(sessionId);
	const key = previewEntryLabel(entry);
	const record = stateLike?.previewVersionsBySession?.[sid]?.[key];
	if (!record || typeof record !== "object") return undefined;
	return record as PreviewVersionRecord;
}

export function registerPreviewVersion(stateLike: any, sessionId: string, entry: string | undefined | null, contentHash: unknown, options: { current?: boolean; version?: number } = {}): number | undefined {
	const hash = normalizePreviewContentHash(contentHash);
	const record = ensurePreviewVersionRecord(stateLike, sessionId, previewEntryLabel(entry));
	const explicit = typeof options.version === "number" && Number.isFinite(options.version) && options.version > 0
		? Math.trunc(options.version)
		: undefined;
	if (hash && explicit != null) record.hashToVersion[hash] = explicit;
	let version = hash ? record.hashToVersion[hash] : undefined;
	if (version == null && explicit != null) version = explicit;
	if (version == null && hash) {
		version = Math.max(1, record.latestVersion + 1);
		record.hashToVersion[hash] = version;
	}
	if (version != null && version > record.latestVersion) record.latestVersion = version;
	if (options.current && hash && version != null) {
		// `latestContentHash` tracks the highest registered version. Rehydrating an
		// older artifact (e.g. opening a historical preview tab triggers SSE for
		// the older hash) must NOT downgrade `latestContentHash` from v2 → v1.
		if (version >= record.latestVersion) {
			record.latestContentHash = hash;
			if (version > record.latestVersion) record.latestVersion = version;
		}
	}
	return version;
}

export interface PreviewTabIdentity {
	entry: string;
	id: string;
	title: string;
	label: string;
	version?: number;
	historical: boolean;
	contentHash: string;
}

export function previewTabIdentityForContent(
	stateLike: any,
	sessionId: string,
	entry: string | undefined | null,
	contentHash: unknown,
	options: { current?: boolean; historical?: boolean; version?: number } = {},
): PreviewTabIdentity {
	const normalizedEntry = previewEntryLabel(entry);
	const hash = normalizePreviewContentHash(contentHash);
	const version = registerPreviewVersion(stateLike, sessionId, normalizedEntry, hash, {
		current: options.current === true,
		version: options.version,
	});
	const latestHash = previewVersionRecordFor(stateLike, sessionId, normalizedEntry)?.latestContentHash || "";
	const matchesCurrent = !!hash && !!latestHash && hash === latestHash;
	const historical = options.historical === true
		&& !matchesCurrent
		&& typeof version === "number"
		&& Number.isFinite(version)
		&& version > 0;
	const id = historical ? previewVersionedTabId(normalizedEntry, version!) : previewEntryTabId(normalizedEntry);
	const title = previewTabDisplayTitle(normalizedEntry, version, historical);
	return { entry: normalizedEntry, id, title, label: title, version, historical, contentHash: hash };
}

export function panelWorkspaceSessionKey(sessionId: string | null | undefined): string {
	return sessionId || PANEL_WORKSPACE_NO_SESSION_KEY;
}

function activeMirrorSessionKey(stateLike: any): string {
	const sid = typeof stateLike?.selectedSessionId === "string" && stateLike.selectedSessionId
		? stateLike.selectedSessionId
		: typeof stateLike?.remoteAgent?.gatewaySessionId === "string" && stateLike.remoteAgent.gatewaySessionId
		? stateLike.remoteAgent.gatewaySessionId
		: undefined;
	return panelWorkspaceSessionKey(sid);
}

function ensurePanelTabsBySession(stateLike: any): Record<string, PanelWorkspaceTab[]> {
	if (!stateLike.panelTabsBySession || typeof stateLike.panelTabsBySession !== "object" || Array.isArray(stateLike.panelTabsBySession)) {
		stateLike.panelTabsBySession = {};
	}
	return stateLike.panelTabsBySession as Record<string, PanelWorkspaceTab[]>;
}

export function panelTabsForSession(stateLike: any, sessionId: string | null | undefined): PanelWorkspaceTab[] {
	const sid = panelWorkspaceSessionKey(sessionId);
	const bySession = ensurePanelTabsBySession(stateLike);
	if (!Array.isArray(bySession[sid])) bySession[sid] = [];
	if (activeMirrorSessionKey(stateLike) === sid) stateLike.panelTabs = bySession[sid];
	return bySession[sid];
}

export function setPanelTabsForSession(stateLike: any, sessionId: string | null | undefined, tabs: PanelWorkspaceTab[]): PanelWorkspaceTab[] {
	const sid = panelWorkspaceSessionKey(sessionId);
	const bySession = ensurePanelTabsBySession(stateLike);
	bySession[sid] = tabs;
	if (activeMirrorSessionKey(stateLike) === sid) stateLike.panelTabs = tabs;
	persistPanelWorkspace(stateLike);
	return tabs;
}

function previewEntryFromTab(tab: PanelWorkspaceTab | undefined | null): string {
	if (!tab) return previewEntryLabel(undefined);
	const stateEntry = typeof tab.state?.entry === "string" ? tab.state.entry : "";
	const source = tab.source as Record<string, unknown> | undefined;
	const sourceEntry = typeof source?.entry === "string" ? source.entry : "";
	return previewEntryLabel(stateEntry || sourceEntry || tab.title || tab.label || undefined);
}

function currentPreviewTabIdForSession(stateLike: any, sid: string): string {
	const tabs = Array.isArray(stateLike?.panelTabsBySession?.[sid])
		? stateLike.panelTabsBySession[sid] as PanelWorkspaceTab[]
		: [];
	const current = tabs.find((tab) => tab?.kind === "preview" && isCurrentPreviewEntryTabId(tab.id) && !isHistoricalPreviewTab(tab))
		?? tabs.find((tab) => tab?.kind === "preview" && isLivePreviewTab(tab));
	if (current) {
		return isCurrentPreviewEntryTabId(current.id) ? current.id : previewEntryTabId(previewEntryFromTab(current));
	}
	if (activeMirrorSessionKey(stateLike) === sid && typeof stateLike?.previewPanelEntry === "string" && stateLike.previewPanelEntry) {
		return previewEntryTabId(stateLike.previewPanelEntry);
	}
	return "";
}

function normalizeActivePanelTabId(stateLike: any, sid: string, tabId: unknown): string {
	if (typeof tabId !== "string" || !tabId || tabId === CHAT_PANEL_TAB_ID) return "";
	if (isLegacyPreviewPanelTabId(tabId)) return currentPreviewTabIdForSession(stateLike, sid);
	return isSidePanelTabId(tabId) ? tabId : "";
}

function writeActivePanelTabId(stateLike: any, sid: string, tabId: string): void {
	if (!stateLike.panelWorkspaceActiveBySession || typeof stateLike.panelWorkspaceActiveBySession !== "object" || Array.isArray(stateLike.panelWorkspaceActiveBySession)) {
		stateLike.panelWorkspaceActiveBySession = {};
	}
	stateLike.panelWorkspaceActiveBySession[sid] = tabId;
	if (activeMirrorSessionKey(stateLike) === sid) stateLike.activePanelTabId = tabId;
	if (stateLike.panelWorkspace && typeof stateLike.panelWorkspace === "object") stateLike.panelWorkspace.activeTabId = tabId;
	persistPanelWorkspace(stateLike);
}

export function activeSidePanelTabIdForSession(stateLike: any, sessionId: string | null | undefined): string {
	const sid = panelWorkspaceSessionKey(sessionId);
	const activeBySession = stateLike?.panelWorkspaceActiveBySession;
	if (activeBySession && typeof activeBySession === "object" && typeof activeBySession[sid] === "string") {
		const normalized = normalizeActivePanelTabId(stateLike, sid, activeBySession[sid]);
		if (normalized !== activeBySession[sid]) writeActivePanelTabId(stateLike, sid, normalized);
		return normalized;
	}
	if (activeMirrorSessionKey(stateLike) === sid && typeof stateLike?.activePanelTabId === "string") {
		const normalized = normalizeActivePanelTabId(stateLike, sid, stateLike.activePanelTabId);
		writeActivePanelTabId(stateLike, sid, normalized);
		return normalized;
	}
	return "";
}

export function activePanelTabIdForSession(stateLike: any, sessionId: string | null | undefined): string {
	return activeSidePanelTabIdForSession(stateLike, sessionId);
}

export function setActivePanelTabIdForSession(stateLike: any, sessionId: string | null | undefined, tabId: string): void {
	const sid = panelWorkspaceSessionKey(sessionId);
	writeActivePanelTabId(stateLike, sid, normalizeActivePanelTabId(stateLike, sid, tabId));
}

export function proposalPanelTabId(type: ProposalType | string, rev?: number): string {
	return typeof rev === "number" && Number.isFinite(rev) && rev > 0
		? `proposal:${type}:rev:${Math.trunc(rev)}`
		: `proposal:${type}`;
}

export function proposalRevisionFromPanelTab(tab: PanelWorkspaceTab | undefined | null): number | undefined {
	const stateRev = tab?.state?.rev;
	if (typeof stateRev === "number" && Number.isFinite(stateRev) && stateRev > 0) return stateRev;
	if (tab?.source?.type === "proposal" && typeof tab.source.rev === "number" && Number.isFinite(tab.source.rev) && tab.source.rev > 0) return tab.source.rev;
	const match = /^proposal:[^:]+:rev:(\d+)$/.exec(tab?.id || "");
	return match ? Number(match[1]) : undefined;
}

export function isHistoricalProposalTab(tab: PanelWorkspaceTab | undefined | null): boolean {
	return tab?.kind === "proposal" && proposalRevisionFromPanelTab(tab) != null;
}

const reviewDocumentIdsByTitle = new Map<string, string>();
const reviewDocumentTitlesById = new Map<string, string>();
let reviewHashK: number[] | undefined;

function sha256Hex(input: string): string {
	const bytes = typeof TextEncoder !== "undefined"
		? Array.from(new TextEncoder().encode(input))
		: Array.from(unescape(encodeURIComponent(input)), (ch) => ch.charCodeAt(0));
	const k = reviewHashK ||= (() => {
		const out: number[] = [];
		let n = 2;
		while (out.length < 64) {
			let prime = true;
			for (let i = 2; i * i <= n; i++) if (n % i === 0) { prime = false; break; }
			if (prime) out.push(Math.floor((Math.cbrt(n) % 1) * 0x100000000) >>> 0);
			n++;
		}
		return out;
	})();
	const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
	const bitLen = bytes.length * 8;
	bytes.push(0x80);
	while (bytes.length % 64 !== 56) bytes.push(0);
	for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bitLen / 2 ** (i * 8)) & 0xff);
	const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
	for (let i = 0; i < bytes.length; i += 64) {
		const w = new Array<number>(64);
		for (let j = 0; j < 16; j++) w[j] = ((bytes[i + j * 4] << 24) | (bytes[i + j * 4 + 1] << 16) | (bytes[i + j * 4 + 2] << 8) | bytes[i + j * 4 + 3]) >>> 0;
		for (let j = 16; j < 64; j++) {
			const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
			const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
			w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, hh] = h;
		for (let j = 0; j < 64; j++) {
			const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const temp1 = (hh + s1 + ch + k[j] + w[j]) >>> 0;
			const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (s0 + maj) >>> 0;
			hh = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
		}
		h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
		h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
	}
	return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

export function legacyReviewDocumentIdFromTitle(title: string): string {
	return `legacy-title-${sha256Hex(title || "Review")}`;
}

export function rememberReviewDocumentIdentity(title: string, documentId: string): void {
	if (!title || !documentId) return;
	reviewDocumentIdsByTitle.set(title, documentId);
	reviewDocumentTitlesById.set(documentId, title);
}

export function reviewDocumentIdForTitle(title: string): string {
	return reviewDocumentIdsByTitle.get(title) || legacyReviewDocumentIdFromTitle(title);
}

function looksLikeReviewDocumentId(value: string): boolean {
	return value.startsWith("review-doc:") || value.startsWith("legacy-title-") || reviewDocumentTitlesById.has(value);
}

export function reviewPanelTabId(documentIdOrTitle: string): string {
	const documentId = looksLikeReviewDocumentId(documentIdOrTitle)
		? documentIdOrTitle
		: reviewDocumentIdForTitle(documentIdOrTitle);
	return `review:${encodeURIComponent(documentId)}`;
}

export function reviewDocumentIdFromPanelTab(tab: PanelWorkspaceTab | undefined | null): string {
	if (!tab) return "";
	if (tab.source?.type === "review" && typeof tab.source.documentId === "string" && tab.source.documentId) return tab.source.documentId;
	const encoded = tab.id.startsWith("review:") ? tab.id.slice("review:".length) : "";
	if (encoded) {
		try { return decodeURIComponent(encoded); } catch { return encoded; }
	}
	return "";
}

export function reviewTitleFromPanelTab(tab: PanelWorkspaceTab | undefined | null): string {
	if (!tab) return "";
	if (tab.source?.type === "review") {
		if (typeof tab.source.reviewTitle === "string") return tab.source.reviewTitle;
		if (typeof tab.source.title === "string") return tab.source.title;
	}
	const decodedId = reviewDocumentIdFromPanelTab(tab);
	if (decodedId && !looksLikeReviewDocumentId(decodedId)) return decodedId;
	return tab.title.replace(/^Review:\s*/, "");
}

export function assistantProposalType(assistantType: string | null | undefined): ProposalType | null {
	switch (assistantType) {
		case "goal":
			return "goal";
		case "project":
		case "project-scaffolding":
			return "project";
		case "role":
			return "role";
		case "tool":
			return "tool";
		case "staff":
			return "staff";
		default:
			return null;
	}
}

export interface BuildPanelWorkspaceTabsInput {
	sessionId?: string;
	isPreviewSession: boolean;
	previewEntry: string;
	previewContentHash?: string;
	activeProposalTypes: ProposalType[];
	assistantProposalType: ProposalType | null;
	reviewTitles: string[];
	reviewPanelOpen: boolean;
	inboxPanelOpen: boolean;
	inboxHasPending: boolean;
}

export function buildPanelWorkspaceTabs(input: BuildPanelWorkspaceTabsInput): PanelWorkspaceTab[] {
	const tabs: PanelWorkspaceTab[] = [];

	if (input.inboxPanelOpen) {
		tabs.push({
			id: INBOX_PANEL_TAB_ID,
			kind: "inbox",
			title: input.inboxHasPending ? "Inbox: pending items" : "Inbox",
			label: "Inbox",
			legacyTab: "inbox",
			source: { type: "inbox", sessionId: input.sessionId },
		});
	}

	if (input.isPreviewSession && input.previewEntry) {
		const entry = previewEntryLabel(input.previewEntry);
		const title = previewTabDisplayTitle(entry);
		const contentHash = normalizePreviewContentHash(input.previewContentHash);
		tabs.push({
			id: previewEntryTabId(entry),
			kind: "preview",
			title,
			label: title,
			legacyTab: "preview",
			source: contentHash
				? { type: "preview", entry, sessionId: input.sessionId, contentHash, live: true }
				: { type: "preview", entry, sessionId: input.sessionId, live: true },
			state: contentHash ? { contentHash, entry, historical: false } : { entry, historical: false },
		});
	}

	const proposalTypes: ProposalType[] = [];
	if (input.assistantProposalType) proposalTypes.push(input.assistantProposalType);
	for (const type of input.activeProposalTypes) {
		if (!proposalTypes.includes(type)) proposalTypes.push(type);
	}
	for (const type of proposalTypes) {
		const label = PROPOSAL_LABELS[type];
		tabs.push({
			id: proposalPanelTabId(type),
			kind: "proposal",
			title: `${label} Proposal`,
			label,
			legacyTab: type,
			source: { type: "proposal", proposalType: type, sessionId: input.sessionId },
		});
	}

	if (input.reviewPanelOpen) {
		for (const titleOrDocumentId of input.reviewTitles) {
			const documentId = looksLikeReviewDocumentId(titleOrDocumentId) ? titleOrDocumentId : reviewDocumentIdForTitle(titleOrDocumentId);
			const title = reviewDocumentTitlesById.get(documentId) || titleOrDocumentId;
			tabs.push({
				id: reviewPanelTabId(documentId),
				kind: "review",
				title: `Review: ${title}`,
				label: `Review: ${title}`,
				legacyTab: "review",
				source: { type: "review", documentId, title, reviewTitle: title, sessionId: input.sessionId },
			});
		}
	}

	return tabs;
}

function proposalLabelForType(type: ProposalType): string {
	return PROPOSAL_LABELS[type] || `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

function canonicalPanelTab(rawTab: PanelWorkspaceTab, id: string): PanelWorkspaceTab | null {
	const kind = panelTabKindFromId(id);
	if (!kind) return null;
	if (kind === "preview") {
		const entry = previewTabEntryFromId(id) || previewEntryFromTab(rawTab);
		const version = previewTabVersionFromId(id);
		const historical = version != null;
		const title = previewTabDisplayTitle(entry, version, historical);
		return {
			...rawTab,
			id,
			kind: "preview",
			title,
			label: title,
			legacyTab: "preview",
			source: { ...(rawTab.source as Record<string, unknown>), type: (rawTab.source as Record<string, unknown>)?.type || "html-preview", entry } as PanelWorkspaceTab["source"],
			state: { ...(rawTab.state || {}), entry, ...(historical ? { version, historical: true } : {}) },
		};
	}
	if (kind === "proposal") {
		const type = proposalTypeFromId(id)!;
		const rev = positiveInteger(PROPOSAL_ID_RE.exec(id)?.[2]);
		const label = proposalLabelForType(type);
		return {
			...rawTab,
			id,
			kind: "proposal",
			title: rawTab.title || `${label} Proposal${rev ? ` rev ${rev}` : ""}`,
			label: rawTab.label || (rev ? `${label} r${rev}` : label),
			legacyTab: type,
			source: { ...(rawTab.source as Record<string, unknown>), type: "proposal", proposalType: type, rev, historical: rev != null } as PanelWorkspaceTab["source"],
			state: { ...(rawTab.state || {}), ...(rev != null ? { rev, historical: true } : {}) },
		};
	}
	if (kind === "review") {
		const source = (rawTab.source || {}) as Record<string, unknown>;
		const encoded = id.slice("review:".length);
		let decoded = encoded;
		try { decoded = decodeURIComponent(encoded); } catch { /* keep encoded */ }
		const sourceTitle = typeof source.reviewTitle === "string" ? source.reviewTitle : typeof source.title === "string" ? source.title : undefined;
		const documentId = typeof source.documentId === "string" && source.documentId
			? source.documentId
			: looksLikeReviewDocumentId(decoded) ? decoded : legacyReviewDocumentIdFromTitle(decoded);
		const title = sourceTitle || (!looksLikeReviewDocumentId(decoded) ? decoded : rawTab.title.replace(/^Review:\s*/, "") || "Review");
		if (title && documentId) rememberReviewDocumentIdentity(title, documentId);
		return {
			...rawTab,
			id: reviewPanelTabId(documentId),
			kind: "review",
			title: `Review: ${title}`,
			label: `Review: ${title}`,
			legacyTab: "review",
			source: { ...source, type: "review", documentId, title, reviewTitle: title } as PanelWorkspaceTab["source"],
		};
	}
	if (kind === "pack") {
		const source = (rawTab.source || {}) as Record<string, unknown>;
		const tabState = (rawTab.state || {}) as Record<string, unknown>;
		const ref = packPanelRefFromTabId(id);
		const packId = ref?.packId
			|| (typeof source.packId === "string" ? source.packId : "")
			|| (typeof tabState.packId === "string" ? tabState.packId : "");
		const panelId = ref?.panelId
			|| (typeof source.panelId === "string" ? source.panelId : "")
			|| (typeof tabState.panelId === "string" ? tabState.panelId : "");
		const instanceKey = ref?.instanceKey
			|| (typeof source.instanceKey === "string" ? source.instanceKey : "")
			|| (typeof tabState.instanceKey === "string" ? tabState.instanceKey : "")
			|| DEFAULT_PACK_PANEL_INSTANCE_KEY;
		const title = rawTab.title || panelId || "Panel";
		return {
			...rawTab,
			id: packPanelTabId(packId, panelId, instanceKey),
			kind: "pack",
			title,
			label: rawTab.label || title,
			legacyTab: "pack",
			source: { ...source, type: "pack", packId, panelId, instanceKey } as PanelWorkspaceTab["source"],
			state: { ...tabState, packId, panelId, instanceKey },
		};
	}
	return {
		...rawTab,
		id: INBOX_PANEL_TAB_ID,
		kind: "inbox",
		title: rawTab.title || "Inbox",
		label: rawTab.label || "Inbox",
		legacyTab: "inbox",
		source: { ...(rawTab.source as Record<string, unknown>), type: "inbox" } as PanelWorkspaceTab["source"],
	};
}

function normalizeStoredPanelTab(rawTab: PanelWorkspaceTab | null | undefined): PanelWorkspaceTab | null {
	if (!rawTab || typeof rawTab.id !== "string") return null;
	if (rawTab.id === CHAT_PANEL_TAB_ID || rawTab.kind === "chat") return null;
	if (isLegacyPreviewPanelTabId(rawTab.id)) {
		const entry = previewEntryFromTab(rawTab);
		return canonicalPanelTab(rawTab, previewEntryTabId(entry));
	}
	if (!isSidePanelTabId(rawTab.id)) return null;
	return canonicalPanelTab(rawTab, rawTab.id);
}

function mergeDerivedMetadata(stored: PanelWorkspaceTab, derived: PanelWorkspaceTab | undefined): PanelWorkspaceTab {
	if (!derived) return stored;
	return {
		...stored,
		...derived,
		source: { ...(stored.source as Record<string, unknown>), ...(derived.source as Record<string, unknown>) } as PanelWorkspaceTab["source"],
		state: { ...(stored.state || {}), ...(derived.state || {}) },
	};
}

function pinnedFirst(tabs: PanelWorkspaceTab[]): PanelWorkspaceTab[] {
	return tabs;
}

function shouldDropStoredTabAbsentFromDerived(tab: PanelWorkspaceTab, derivedById: Map<string, PanelWorkspaceTab>): boolean {
	if (derivedById.has(tab.id)) return false;
	if (tab.kind === "proposal" && !isHistoricalProposalTab(tab)) return true;
	if (tab.kind === "review") return true;
	return false;
}

export function normalizeSidePanelTabs(stateLike: any, sessionId: string | null | undefined, derivedTabs: PanelWorkspaceTab[]): PanelWorkspaceTab[] {
	const sid = panelWorkspaceSessionKey(sessionId);
	const derived = derivedTabs
		.map((tab) => normalizeStoredPanelTab(tab))
		.filter((tab): tab is PanelWorkspaceTab => !!tab);
	const derivedById = new Map(derived.map((tab) => [tab.id, tab]));
	const derivedHasInbox = derivedById.has(INBOX_PANEL_TAB_ID);
	const storedTabs = panelTabsForSession(stateLike, sid);
	const seen = new Set<string>();
	const merged: PanelWorkspaceTab[] = [];

	for (const rawTab of storedTabs) {
		const normalized = normalizeStoredPanelTab(rawTab);
		if (!normalized || seen.has(normalized.id)) continue;
		if (normalized.id === INBOX_PANEL_TAB_ID && !derivedHasInbox) continue;
		if (shouldDropStoredTabAbsentFromDerived(normalized, derivedById)) continue;
		seen.add(normalized.id);
		merged.push(mergeDerivedMetadata(normalized, derivedById.get(normalized.id)));
	}

	for (const tab of derived) {
		if (seen.has(tab.id)) continue;
		seen.add(tab.id);
		merged.push(tab);
	}

	return pinnedFirst(merged);
}

export function panelContentTabs(tabs: PanelWorkspaceTab[]): PanelWorkspaceTab[] {
	return tabs.filter((tab) => tab.kind !== "chat" && isSidePanelTabId(tab.id));
}

export function findPanelTab(tabs: PanelWorkspaceTab[], id: string | null | undefined): PanelWorkspaceTab | undefined {
	if (!id || id === CHAT_PANEL_TAB_ID) return undefined;
	if (isLegacyPreviewPanelTabId(id)) {
		return tabs.find((tab) => tab.kind === "preview" && isCurrentPreviewEntryTabId(tab.id) && !isHistoricalPreviewTab(tab))
			?? tabs.find((tab) => tab.kind === "preview" && isLivePreviewTab(tab) && !isHistoricalPreviewTab(tab));
	}
	const exact = tabs.find((tab) => tab.id === id && isSidePanelTabId(tab.id));
	if (exact) return exact;
	if (id.startsWith("review:")) {
		const raw = id.slice("review:".length);
		let decoded = raw;
		try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }
		return tabs.find((tab) => tab.kind === "review" && (reviewDocumentIdFromPanelTab(tab) === decoded || reviewTitleFromPanelTab(tab) === decoded));
	}
	return undefined;
}

export function firstContentPanelTab(tabs: PanelWorkspaceTab[]): PanelWorkspaceTab | undefined {
	return panelContentTabs(tabs)[0];
}

export function nextActivePanelTabId(tabs: PanelWorkspaceTab[], closedId: string | null | undefined): string {
	const validTabs = panelContentTabs(tabs);
	if (validTabs.length === 0) return "";
	const index = validTabs.findIndex((tab) => tab.id === closedId);
	if (index < 0) return validTabs[0]?.id || "";
	return validTabs[index + 1]?.id || validTabs[index - 1]?.id || "";
}

export function reorderSidePanelTab(tabs: PanelWorkspaceTab[], fromId: string, beforeIdOrIndex?: string | number | null): PanelWorkspaceTab[] {
	const ordered = panelContentTabs(tabs);
	const fromIndex = ordered.findIndex((tab) => tab.id === fromId);
	if (fromIndex < 0) return ordered;
	const moving = ordered[fromIndex];

	const without = ordered.filter((_, index) => index !== fromIndex);
	let insertIndex = without.length;
	if (typeof beforeIdOrIndex === "number" && Number.isFinite(beforeIdOrIndex)) {
		insertIndex = Math.trunc(beforeIdOrIndex);
	} else if (typeof beforeIdOrIndex === "string" && beforeIdOrIndex) {
		const targetIndex = without.findIndex((tab) => tab.id === beforeIdOrIndex);
		if (targetIndex >= 0) insertIndex = targetIndex;
	}
	insertIndex = Math.max(0, Math.min(without.length, insertIndex));
	without.splice(insertIndex, 0, moving);
	return without;
}

export function panelTabIdFromLegacy(tab: LegacyPanelTab | string | null | undefined, reviewActiveTitle: string): string | null {
	if (!tab) return null;
	if (tab === "chat") return null;
	if (tab === "preview") return LIVE_PREVIEW_PANEL_TAB_ID;
	if (tab === "inbox") return INBOX_PANEL_TAB_ID;
	if (tab === "review") return reviewActiveTitle ? reviewPanelTabId(reviewActiveTitle) : null;
	if (tab === "goal" || tab === "project" || tab === "role" || tab === "tool" || tab === "staff") {
		return proposalPanelTabId(tab);
	}
	return null;
}
