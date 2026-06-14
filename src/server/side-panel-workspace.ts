import { createHash } from "node:crypto";
import type {
	SidePanelKind,
	SidePanelProposalType,
	SidePanelSizeMode,
	SidePanelWorkspace,
	SidePanelWorkspaceMetadata,
	SidePanelWorkspaceSource,
	SidePanelWorkspaceTab,
} from "../shared/side-panel-workspace.js";
import { isSidePanelKind, isSidePanelProposalType, isSidePanelSizeMode } from "../shared/side-panel-workspace.js";

export interface SidePanelWorkspaceValidators {
	isKnownPackPanel?: (packId: string, panelId: string) => boolean;
}

export type WorkspaceMutation =
	| { type: "open"; tab: unknown; focus?: boolean; placeAfterActive?: boolean }
	| { type: "update"; tabId: string; patch: unknown }
	| { type: "close"; tabId: string }
	| { type: "active"; activeTabId: string }
	| { type: "reorder"; tabIds: string[] }
	| { type: "resize"; sizeMode: SidePanelSizeMode }
	| { type: "migrate"; tabs?: unknown[]; activeTabId?: string; sizeMode?: unknown; metadata?: unknown };

export class SidePanelWorkspaceError extends Error {
	constructor(
		message: string,
		readonly status: number = 400,
		readonly code: string = "SIDE_PANEL_WORKSPACE_INVALID",
	) {
		super(message);
	}
}

const MAX_ID = 300;
const MAX_TITLE = 160;
const MAX_LABEL = 80;
const MAX_ENTRY = 240;
const MAX_DOC_ID = 240;
const MAX_PACK_PART = 120;
const MAX_PARAMS_BYTES = 16 * 1024;
const MAX_STATE_BYTES = 16 * 1024;
const MAX_JSON_DEPTH = 8;
const PREVIEW_ENTRY_ID_RE = /^preview:entry:([^:]+)(?::v:(\d+))?$/;
const PROPOSAL_ID_RE = /^proposal:([^:]+)(?::rev:(\d+))?$/;
const PACK_ID_RE = /^pack:([^:]+):([^:]+):([^:]+)$/;
const LEGACY_PACK_ID_RE = /^pack:([^:]+):([^:]+)$/;

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function truncate(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

function decodeComponent(value: string): string | null {
	try { return decodeURIComponent(value); } catch { return null; }
}

function encodeComponent(value: string): string {
	return encodeURIComponent(value);
}

function positiveInteger(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : NaN;
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN;
	return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function previewEntryLabel(entry: string | undefined | null): string {
	const clean = (entry || "inline.html").split(/[?#]/, 1)[0]?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "inline.html";
	return truncate(clean.split("/").filter(Boolean).pop() || clean || "inline.html", MAX_ENTRY);
}

function hasNoControlChars(value: string): boolean {
	return !/[\x00-\x1f\x7f]/.test(value);
}

function isRouteSafePart(value: string, max = MAX_PACK_PART): boolean {
	return value.length > 0 && value.length <= max && hasNoControlChars(value) && !/[\\/]/.test(value);
}

function cloneJsonObject(value: unknown, maxBytes = MAX_PARAMS_BYTES): Record<string, unknown> | undefined {
	if (value == null) return undefined;
	if (!isObject(value)) return undefined;
	const seen = new Set<object>();
	function clone(input: unknown, depth: number): unknown {
		if (depth > MAX_JSON_DEPTH) throw new Error("too deep");
		if (input == null || typeof input === "string" || typeof input === "number" || typeof input === "boolean") return input;
		if (typeof input !== "object") throw new Error("non-json");
		if (seen.has(input)) throw new Error("cycle");
		seen.add(input);
		if (Array.isArray(input)) {
			if (input.length > 100) throw new Error("array too large");
			return input.map((item) => clone(item, depth + 1));
		}
		const out: Record<string, unknown> = Object.create(null);
		for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
			if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
			if (!hasNoControlChars(key) || key.length > 120) throw new Error("bad key");
			out[key] = clone(raw, depth + 1);
		}
		return out;
	}
	try {
		const cloned = clone(value, 0) as Record<string, unknown>;
		if (Buffer.byteLength(JSON.stringify(cloned), "utf8") > maxBytes) return undefined;
		return cloned;
	} catch {
		return undefined;
	}
}

function normalizeState(value: unknown): Record<string, unknown> | undefined {
	return cloneJsonObject(value, MAX_STATE_BYTES);
}

function metadataFrom(raw: unknown): SidePanelWorkspaceMetadata | undefined {
	if (!isObject(raw)) return undefined;
	const migrated = positiveInteger(raw.migratedFromLocalStorageAt);
	return migrated ? { migratedFromLocalStorageAt: migrated } : undefined;
}

function sourceSessionMatches(source: Record<string, unknown>, sessionId: string): boolean {
	return source.sessionId === sessionId;
}

function titleFor(kind: SidePanelKind, source: SidePanelWorkspaceSource, rawTitle: string): string {
	const title = truncate(rawTitle.trim(), MAX_TITLE);
	if (title) return title;
	if (kind === "preview") return source.type === "preview" ? source.entry : "Preview";
	if (kind === "proposal") return source.type === "proposal" ? `${source.proposalType[0].toUpperCase()}${source.proposalType.slice(1)} Proposal` : "Proposal";
	if (kind === "review") return source.type === "review" ? source.title : "Review";
	if (kind === "inbox") return "Inbox";
	if (kind === "pack" && source.type === "pack") return source.panelId;
	return "Panel";
}

function labelFor(title: string, rawLabel: string): string {
	const label = truncate(rawLabel.trim(), MAX_LABEL);
	return label || truncate(title, MAX_LABEL);
}

function canonicalizePreview(raw: Record<string, unknown>, id: string, sessionId: string): { id: string; source: SidePanelWorkspaceSource } | null {
	const source = isObject(raw.source) ? raw.source : undefined;
	if (!source || source.type !== "preview" || !sourceSessionMatches(source, sessionId)) return null;
	const match = PREVIEW_ENTRY_ID_RE.exec(id);
	if (!match) return null;
	const decodedEntry = decodeComponent(match[1]);
	if (!decodedEntry) return null;
	const entry = previewEntryLabel(asString(source.entry, decodedEntry));
	if (encodeComponent(entry) !== match[1]) return null;
	const idVersion = positiveInteger(match[2]);
	const sourceVersion = positiveInteger(source.version);
	const version = idVersion ?? sourceVersion;
	if (match[2] != null && !idVersion) return null;
	if (source.historical === true && !version) return null;
	const canonicalSource: SidePanelWorkspaceSource = {
		type: "preview",
		sessionId,
		entry,
		...(source.live === true && !version ? { live: true } : {}),
		...(source.historical === true || version ? { historical: source.historical === true || !!version } : {}),
		...(version ? { version } : {}),
		...(typeof source.artifactId === "string" ? { artifactId: truncate(source.artifactId, 200) } : {}),
		...(typeof source.contentHash === "string" ? { contentHash: truncate(source.contentHash, 200) } : {}),
		...(typeof source.path === "string" ? { path: truncate(source.path, 500) } : {}),
		...(typeof source.url === "string" ? { url: truncate(source.url, 1000) } : {}),
		...(typeof source.toolUseId === "string" ? { toolUseId: truncate(source.toolUseId, 160) } : {}),
		...(nonNegativeInteger(source.blockIndex) !== undefined ? { blockIndex: nonNegativeInteger(source.blockIndex)! } : {}),
	};
	return { id, source: canonicalSource };
}

function canonicalizeProposal(raw: Record<string, unknown>, id: string, sessionId: string): { id: string; kind: "proposal"; source: SidePanelWorkspaceSource } | null {
	const source = isObject(raw.source) ? raw.source : undefined;
	if (!source || source.type !== "proposal" || !sourceSessionMatches(source, sessionId)) return null;
	const match = PROPOSAL_ID_RE.exec(id);
	if (!match) return null;
	const proposalType = match[1];
	if (!isSidePanelProposalType(proposalType) || source.proposalType !== proposalType) return null;
	const idRev = positiveInteger(match[2]);
	const sourceRev = positiveInteger(source.rev);
	if (match[2] != null && !idRev) return null;
	const rev = idRev ?? sourceRev;
	const canonicalSource: SidePanelWorkspaceSource = {
		type: "proposal",
		sessionId,
		proposalType: proposalType as SidePanelProposalType,
		...(rev ? { rev } : {}),
		...(source.historical === true || idRev ? { historical: source.historical === true || !!idRev } : {}),
	};
	return { id, kind: "proposal", source: canonicalSource };
}

function canonicalizeReview(raw: Record<string, unknown>, id: string, sessionId: string): { id: string; kind: "review"; source: SidePanelWorkspaceSource } | null {
	const source = isObject(raw.source) ? raw.source : undefined;
	if (!id.startsWith("review:")) return null;
	const encoded = id.slice("review:".length);
	const decoded = decodeComponent(encoded);
	if (!decoded) return null;
	if (!source || source.type !== "review" || !sourceSessionMatches(source, sessionId)) return null;
	let documentId = typeof source.documentId === "string" && source.documentId.trim() ? source.documentId.trim() : decoded;
	let canonicalId = `review:${encodeComponent(documentId)}`;
	const rawTitle = asString(source.title, asString((source as Record<string, unknown>).reviewTitle, decoded)).trim() || decoded;
	// Legacy title-based review tabs had no durable document id; migrate them to a deterministic id.
	if (!("documentId" in source) && !id.startsWith("review:legacy-title-")) {
		documentId = `legacy-title-${createHash("sha256").update(rawTitle).digest("hex").slice(0, 16)}`;
		canonicalId = `review:${documentId}`;
	}
	if (!documentId || documentId.length > MAX_DOC_ID || !hasNoControlChars(documentId)) return null;
	const title = truncate(rawTitle, MAX_TITLE) || documentId;
	return { id: canonicalId, kind: "review", source: { type: "review", sessionId, documentId, title } };
}

function canonicalizeInbox(raw: Record<string, unknown>, id: string, sessionId: string): { id: string; kind: "inbox"; source: SidePanelWorkspaceSource } | null {
	const source = isObject(raw.source) ? raw.source : undefined;
	if (id !== "inbox" || !source || source.type !== "inbox" || !sourceSessionMatches(source, sessionId)) return null;
	return { id: "inbox", kind: "inbox", source: { type: "inbox", sessionId, ...(typeof source.staffId === "string" ? { staffId: truncate(source.staffId, 160) } : {}) } };
}

function canonicalizePack(raw: Record<string, unknown>, id: string, sessionId: string, validators?: SidePanelWorkspaceValidators): { id: string; kind: "pack"; source: SidePanelWorkspaceSource } | null {
	const source = isObject(raw.source) ? raw.source : undefined;
	if (!source || source.type !== "pack" || !sourceSessionMatches(source, sessionId)) return null;
	const match = PACK_ID_RE.exec(id);
	const legacyMatch = match ? null : LEGACY_PACK_ID_RE.exec(id);
	if (!match && !legacyMatch) return null;
	const legacy = !match;
	const encodedPackId = match?.[1] ?? legacyMatch?.[1] ?? "";
	const encodedPanelId = match?.[2] ?? legacyMatch?.[2] ?? "";
	const encodedInstanceKey = match?.[3] ?? "default";
	const packId = decodeComponent(encodedPackId);
	const panelId = decodeComponent(encodedPanelId);
	const instanceKey = decodeComponent(encodedInstanceKey);
	if (!packId || !panelId || !instanceKey) return null;
	if (source.packId !== packId || source.panelId !== panelId) return null;
	const sourceInstance = typeof source.instanceKey === "string" && source.instanceKey ? source.instanceKey : (legacy ? "default" : "");
	if (sourceInstance !== instanceKey) return null;
	if (!isRouteSafePart(packId) || !isRouteSafePart(panelId) || !isRouteSafePart(instanceKey)) return null;
	if (validators?.isKnownPackPanel && !validators.isKnownPackPanel(packId, panelId)) return null;
	const params = cloneJsonObject(source.params);
	if (source.params !== undefined && params === undefined) return null;
	const canonicalId = `pack:${encodeComponent(packId)}:${encodeComponent(panelId)}:${encodeComponent(instanceKey)}`;
	return {
		id: canonicalId,
		kind: "pack",
		source: {
			type: "pack",
			sessionId,
			packId,
			panelId,
			instanceKey,
			...(source.singleton === true ? { singleton: true } : {}),
			...(params ? { params } : {}),
		},
	};
}

export function canonicalizeTab(raw: unknown, sessionId: string, validators?: SidePanelWorkspaceValidators): SidePanelWorkspaceTab | null {
	if (!isObject(raw)) return null;
	const id = asString(raw.id).trim();
	const kind = raw.kind;
	if (!id || id.length > MAX_ID || !hasNoControlChars(id) || !isSidePanelKind(kind)) return null;
	let canonical: { id: string; kind?: SidePanelKind; source: SidePanelWorkspaceSource } | null = null;
	if (kind === "preview") canonical = canonicalizePreview(raw, id, sessionId);
	else if (kind === "proposal") canonical = canonicalizeProposal(raw, id, sessionId);
	else if (kind === "review") canonical = canonicalizeReview(raw, id, sessionId);
	else if (kind === "inbox") canonical = canonicalizeInbox(raw, id, sessionId);
	else if (kind === "pack") canonical = canonicalizePack(raw, id, sessionId, validators);
	if (!canonical) return null;
	const canonicalKind = canonical.kind ?? kind;
	if (canonicalKind !== kind) return null;
	const title = titleFor(kind, canonical.source, asString(raw.title));
	const label = labelFor(title, asString(raw.label));
	const state = normalizeState(raw.state);
	if (raw.state !== undefined && state === undefined) return null;
	return {
		id: canonical.id,
		kind,
		title,
		label,
		source: canonical.source,
		...(state ? { state } : {}),
		updatedAt: positiveInteger(raw.updatedAt) ?? Date.now(),
	};
}

export function emptyWorkspace(sessionId: string, now = Date.now()): SidePanelWorkspace {
	return { version: 1, sessionId, revision: 0, tabs: [], activeTabId: "", sizeMode: "split", updatedAt: now };
}

export function canonicalizeWorkspace(raw: unknown, sessionId: string, validators?: SidePanelWorkspaceValidators): SidePanelWorkspace {
	const now = Date.now();
	if (!isObject(raw)) return emptyWorkspace(sessionId, now);
	const seen = new Set<string>();
	const tabs: SidePanelWorkspaceTab[] = [];
	for (const item of Array.isArray(raw.tabs) ? raw.tabs : []) {
		const tab = canonicalizeTab(item, sessionId, validators);
		if (!tab || seen.has(tab.id)) continue;
		seen.add(tab.id);
		tabs.push(tab);
	}
	const activeCandidate = asString(raw.activeTabId);
	const activeTabId = activeCandidate && tabs.some((tab) => tab.id === activeCandidate) ? activeCandidate : (tabs[0]?.id ?? "");
	const sizeMode = isSidePanelSizeMode(raw.sizeMode) ? raw.sizeMode : "split";
	const metadata = metadataFrom(raw.metadata);
	return {
		version: 1,
		sessionId,
		revision: Math.max(0, Math.trunc(typeof raw.revision === "number" && Number.isFinite(raw.revision) ? raw.revision : 0)),
		tabs,
		activeTabId,
		sizeMode,
		...(metadata ? { metadata } : {}),
		updatedAt: positiveInteger(raw.updatedAt) ?? now,
	};
}

export function nextActiveAfterClose(tabsBeforeClose: SidePanelWorkspaceTab[], closedId: string, previousActiveId: string): string {
	if (previousActiveId && previousActiveId !== closedId && tabsBeforeClose.some((tab) => tab.id === previousActiveId)) return previousActiveId;
	const index = tabsBeforeClose.findIndex((tab) => tab.id === closedId);
	if (index < 0) return tabsBeforeClose[0]?.id ?? "";
	const remaining = tabsBeforeClose.filter((tab) => tab.id !== closedId);
	if (remaining.length === 0) return "";
	return remaining[Math.min(index, remaining.length - 1)]?.id ?? remaining[0]?.id ?? "";
}

function commit(workspace: SidePanelWorkspace, patch: Partial<SidePanelWorkspace>, now = Date.now()): SidePanelWorkspace {
	return {
		...workspace,
		...patch,
		revision: workspace.revision + 1,
		updatedAt: now,
	};
}

function tabArraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function applyWorkspaceMutation(workspace: SidePanelWorkspace, mutation: WorkspaceMutation, validators?: SidePanelWorkspaceValidators): SidePanelWorkspace {
	const now = Date.now();
	const latest = canonicalizeWorkspace(workspace, workspace.sessionId, validators);
	if (mutation.type === "open") {
		const tab = canonicalizeTab(mutation.tab, latest.sessionId, validators);
		if (!tab) throw new SidePanelWorkspaceError("Invalid side-panel tab", 400, "INVALID_TAB");
		tab.updatedAt = now;
		const existingIndex = latest.tabs.findIndex((item) => item.id === tab.id);
		let tabs = latest.tabs.slice();
		if (existingIndex >= 0) {
			tabs[existingIndex] = tab;
		} else if (mutation.placeAfterActive && latest.activeTabId) {
			const activeIndex = tabs.findIndex((item) => item.id === latest.activeTabId);
			if (activeIndex >= 0) tabs.splice(activeIndex + 1, 0, tab);
			else tabs.push(tab);
		} else {
			tabs.push(tab);
		}
		const activeTabId = mutation.focus === false ? (latest.activeTabId || tabs[0]?.id || "") : tab.id;
		return commit(latest, { tabs, activeTabId }, now);
	}
	if (mutation.type === "update") {
		const index = latest.tabs.findIndex((tab) => tab.id === mutation.tabId);
		if (index < 0) throw new SidePanelWorkspaceError("Side-panel tab not found", 404, "TAB_NOT_FOUND");
		if (!isObject(mutation.patch)) throw new SidePanelWorkspaceError("Invalid tab patch", 400, "INVALID_PATCH");
		const merged = { ...latest.tabs[index], ...mutation.patch, id: latest.tabs[index].id, kind: latest.tabs[index].kind };
		const tab = canonicalizeTab(merged, latest.sessionId, validators);
		if (!tab) throw new SidePanelWorkspaceError("Invalid side-panel tab patch", 400, "INVALID_TAB");
		tab.updatedAt = now;
		const tabs = latest.tabs.slice();
		tabs[index] = tab;
		return commit(latest, { tabs }, now);
	}
	if (mutation.type === "close") {
		if (!latest.tabs.some((tab) => tab.id === mutation.tabId)) return latest;
		const activeTabId = nextActiveAfterClose(latest.tabs, mutation.tabId, latest.activeTabId);
		return commit(latest, { tabs: latest.tabs.filter((tab) => tab.id !== mutation.tabId), activeTabId }, now);
	}
	if (mutation.type === "active") {
		if (mutation.activeTabId && !latest.tabs.some((tab) => tab.id === mutation.activeTabId)) {
			throw new SidePanelWorkspaceError("Active side-panel tab does not exist", 400, "ACTIVE_TAB_NOT_FOUND");
		}
		if (latest.activeTabId === mutation.activeTabId) return latest;
		return commit(latest, { activeTabId: mutation.activeTabId }, now);
	}
	if (mutation.type === "reorder") {
		const currentIds = latest.tabs.map((tab) => tab.id).sort();
		const requestedIds = mutation.tabIds.slice().sort();
		if (!tabArraysEqual(currentIds, requestedIds) || new Set(mutation.tabIds).size !== mutation.tabIds.length) {
			throw new SidePanelWorkspaceError("Reorder must include each open tab exactly once", 400, "INVALID_REORDER");
		}
		if (tabArraysEqual(latest.tabs.map((tab) => tab.id), mutation.tabIds)) return latest;
		const byId = new Map(latest.tabs.map((tab) => [tab.id, tab]));
		return commit(latest, { tabs: mutation.tabIds.map((id) => byId.get(id)!) }, now);
	}
	if (mutation.type === "resize") {
		if (!isSidePanelSizeMode(mutation.sizeMode)) throw new SidePanelWorkspaceError("Invalid side-panel size mode", 400, "INVALID_SIZE_MODE");
		if (latest.sizeMode === mutation.sizeMode) return latest;
		return commit(latest, { sizeMode: mutation.sizeMode }, now);
	}
	if (mutation.type === "migrate") {
		if (latest.tabs.length > 0 || latest.metadata?.migratedFromLocalStorageAt) return latest;
		const tabs: SidePanelWorkspaceTab[] = [];
		const seen = new Set<string>();
		for (const rawTab of Array.isArray(mutation.tabs) ? mutation.tabs : []) {
			const tab = canonicalizeTab(rawTab, latest.sessionId, validators);
			if (!tab || seen.has(tab.id)) continue;
			seen.add(tab.id);
			tabs.push({ ...tab, updatedAt: now });
		}
		const activeCandidate = typeof mutation.activeTabId === "string" ? mutation.activeTabId : "";
		const activeTabId = activeCandidate && tabs.some((tab) => tab.id === activeCandidate) ? activeCandidate : (tabs[0]?.id ?? "");
		const sizeMode = isSidePanelSizeMode(mutation.sizeMode) ? mutation.sizeMode : latest.sizeMode;
		return commit(latest, { tabs, activeTabId, sizeMode, metadata: { ...(latest.metadata ?? {}), migratedFromLocalStorageAt: now } }, now);
	}
	return latest;
}

export class SidePanelWorkspaceLocks {
	private readonly chains = new Map<string, Promise<unknown>>();

	async with<T>(sessionId: string, fn: () => Promise<T> | T): Promise<T> {
		const previous = this.chains.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		const chained = previous.then(() => current, () => current);
		this.chains.set(sessionId, chained);
		try {
			await previous.catch(() => undefined);
			return await fn();
		} finally {
			release();
			if (this.chains.get(sessionId) === chained) this.chains.delete(sessionId);
		}
	}
}
