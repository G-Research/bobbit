import { state, renderApp, activeSessionId } from "./state.js";
import {
	CHAT_PANEL_TAB_ID,
	INBOX_PANEL_TAB_ID,
	LIVE_PREVIEW_PANEL_TAB_ID,
	activePanelTabIdForSession,
	isHistoricalPreviewTab,
	registerPreviewVersion,
	previewEntryLabel,
	previewEntryTabId,
	previewTabDisplayTitle,
	previewVersionedTabId,
	normalizePreviewContentHash,
	panelTabsForSession,
	previewContentHashFromTab,
	proposalPanelTabId,
	reviewPanelTabId,
	reviewTitleFromPanelTab,
	setActivePanelTabIdForSession,
	setPanelTabsForSession,
	type LegacyPanelTab,
	type PanelWorkspaceTab,
} from "./panel-workspace.js";

// WP-E: SSE subscription to per-session preview mount events.
// The gateway watches <stateDir>/preview/<sid>/ and emits a `preview-changed`
// event whenever the agent rewrites the entry file or any sibling asset.
// We bump `previewPanelMtime` to force the iframe to reload via `#mtime=<n>`.

type PanelWorkspaceOptions = {
	sessionId?: string;
	select?: boolean;
	setAssistantTab?: boolean;
	clearCollapse?: boolean;
	rev?: number;
	fields?: Record<string, unknown>;
};

const PROPOSAL_LABELS: Record<string, string> = {
	goal: "Goal Proposal",
	project: "Project Proposal",
	role: "Role Proposal",
	tool: "Tool Proposal",
	staff: "Staff Proposal",
};

let es: EventSource | null = null;
let currentSid: string | null = null;

function panelSessionId(sessionId: string | undefined): string {
	return sessionId || activeSessionId() || "";
}

function activeProposalRevForSession(type: string, sessionId: string): number | undefined {
	const slot = (state as any).activeProposals?.[type];
	if (!slot) return undefined;
	if (sessionId && typeof slot.sessionId === "string" && slot.sessionId && slot.sessionId !== sessionId) return undefined;
	const rev = slot.rev;
	return typeof rev === "number" && Number.isFinite(rev) && rev > 0 ? Math.trunc(rev) : undefined;
}

function mutablePanelTabs(s: any, sessionId: string): PanelWorkspaceTab[] {
	return panelTabsForSession(s, sessionId);
}

function upsertPanelTabState(s: any, sessionId: string, tab: PanelWorkspaceTab): void {
	const tabs = mutablePanelTabs(s, sessionId);
	const idx = tabs.findIndex(t => t?.id === tab.id);
	if (idx >= 0) tabs[idx] = { ...tabs[idx], ...tab };
	else tabs.push(tab);
}

function applyLegacySelection(s: any, tab: PanelWorkspaceTab, options: PanelWorkspaceOptions): void {
	if (options.select === false) return;
	const setAssistantTab = options.setAssistantTab !== false;
	if (tab.kind === "chat") {
		s.previewPanelTab = "chat";
		if (setAssistantTab) s.assistantTab = "chat";
		return;
	}
	if (tab.kind === "preview") {
		s.isPreviewSession = true;
		s.previewPanelActiveTab = "preview";
		s.previewPanelTab = "preview";
		if (s.assistantType && setAssistantTab) s.assistantTab = "preview";
		return;
	}
	if (tab.kind === "proposal") {
		const source = tab.source as Record<string, unknown>;
		const proposalType = typeof source.proposalType === "string" ? source.proposalType : "goal";
		s.assistantHasProposal = true;
		s.previewPanelActiveTab = proposalType;
		s.previewPanelTab = proposalType;
		if (s.assistantType && setAssistantTab) s.assistantTab = "preview";
		return;
	}
	if (tab.kind === "review") {
		const title = reviewTitleFromPanelTab(tab);
		s.reviewPanelOpen = true;
		s.reviewActiveTab = title;
		s.previewPanelActiveTab = "review";
		s.previewPanelTab = "review";
		if (s.assistantType && setAssistantTab) s.assistantTab = "preview";
		return;
	}
	if (tab.kind === "inbox") {
		s.previewPanelActiveTab = "inbox";
		s.previewPanelTab = "inbox";
	}
}

function clearCollapseKey(sessionId: string | undefined): void {
	if (!sessionId) return;
	try { localStorage.removeItem(`bobbit-preview-collapsed-${sessionId}`); } catch { /* ignore */ }
}

function emitPanelWorkspaceEvent(action: "select" | "close", detail: Record<string, unknown>): void {
	try {
		if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
		const eventDetail = { action, ...detail };
		window.dispatchEvent(new CustomEvent("bobbit-panel-workspace", { detail: eventDetail }));
		window.dispatchEvent(new CustomEvent(`bobbit-panel-workspace:${action}`, { detail: eventDetail }));
	} catch { /* ignore */ }
}

async function notifyOptionalPanelWorkspaceModule(action: "select" | "close", detail: Record<string, unknown>): Promise<void> {
	try {
		const spec = "./" + "panel-workspace.js";
		const mod: any = await import(/* @vite-ignore */ spec);
		const payload = { action, ...detail };
		const fn = action === "close"
			? mod.closePanelTab ?? mod.removePanelTab ?? mod.applyPanelWorkspaceSelection
			: mod.selectPanelTab ?? mod.openPanelTab ?? mod.upsertPanelTab ?? mod.applyPanelWorkspaceSelection;
		if (typeof fn === "function") await fn(payload);
	} catch { /* optional integration point; absent until core workspace lands */ }
}

export function selectPanelWorkspaceTab(tab: PanelWorkspaceTab, options: PanelWorkspaceOptions = {}): void {
	const s = state as any;
	const sessionId = panelSessionId(options.sessionId);
	upsertPanelTabState(s, sessionId, tab);
	if (options.select !== false) {
		setActivePanelTabIdForSession(s, sessionId, tab.id);
	}
	applyLegacySelection(s, tab, options);
	if (options.clearCollapse !== false) clearCollapseKey(sessionId || undefined);
	const detail = { tab, activeTabId: options.select === false ? activePanelTabIdForSession(s, sessionId) : tab.id, options };
	emitPanelWorkspaceEvent("select", detail);
	void notifyOptionalPanelWorkspaceModule("select", detail);
}

export function removePanelWorkspaceTabs(ids: string[], options: PanelWorkspaceOptions = {}): void {
	const s = state as any;
	const sessionId = panelSessionId(options.sessionId);
	const idSet = new Set(ids);
	const tabs = panelTabsForSession(s, sessionId);
	const kept = tabs.filter((tab: PanelWorkspaceTab) => !idSet.has(tab.id));
	setPanelTabsForSession(s, sessionId, kept);
	if (s.panelWorkspace && typeof s.panelWorkspace === "object" && Array.isArray(s.panelWorkspace.tabs)) {
		s.panelWorkspace.tabs = kept;
	}
	const detail = { tabIds: ids, options };
	emitPanelWorkspaceEvent("close", detail);
	void notifyOptionalPanelWorkspaceModule("close", detail);
}

export function selectHtmlPreviewTab(args: {
	sessionId?: string;
	entry?: string;
	mtime?: number;
	id?: string;
	title?: string;
	url?: string;
	contentHash?: string;
	source?: Record<string, unknown>;
	state?: Record<string, unknown>;
	dedupeWithLive?: boolean;
	historical?: boolean;
	version?: number;
	select?: boolean;
	setAssistantTab?: boolean;
}): void {
	const sessionId = args.sessionId || activeSessionId() || "";
	const entry = previewEntryLabel(args.entry || state.previewPanelEntry || "inline.html");
	const s = state as any;
	const explicitVersion = typeof args.version === "number" && Number.isFinite(args.version) && args.version > 0
		? Math.trunc(args.version)
		: typeof args.state?.version === "number" && Number.isFinite(args.state.version) && args.state.version > 0
		? Math.trunc(args.state.version)
		: typeof args.source?.version === "number" && Number.isFinite(args.source.version) && args.source.version > 0
		? Math.trunc(args.source.version)
		: undefined;
	const requestedHistorical = args.historical === true || args.source?.historical === true || args.state?.historical === true || args.dedupeWithLive === false;
	const contentHash = normalizePreviewContentHash(args.contentHash)
		|| (normalizePreviewContentHash(args.state?.contentHash) || normalizePreviewContentHash(args.source?.contentHash))
		|| (!requestedHistorical ? normalizePreviewContentHash(s.previewPanelContentHash) : "");
	const existingTabs = panelTabsForSession(s, sessionId);
	const entryForTab = (candidate: PanelWorkspaceTab): string => {
		const candidateSource = candidate.source as Record<string, unknown>;
		const candidateState = (candidate.state || {}) as Record<string, unknown>;
		const raw = typeof candidateState.entry === "string" ? candidateState.entry : typeof candidateSource.entry === "string" ? candidateSource.entry : "inline.html";
		return previewEntryLabel(raw);
	};
	const currentFilenameTab = existingTabs.find((candidate: PanelWorkspaceTab) => candidate.kind === "preview"
		&& candidate.id === previewEntryTabId(entry)
		&& !isHistoricalPreviewTab(candidate)
		&& entryForTab(candidate) === entry);
	const collapseToCurrent = requestedHistorical
		&& !!contentHash
		&& !!currentFilenameTab
		&& previewContentHashFromTab(currentFilenameTab) === contentHash;
	const shouldUseHistorical = requestedHistorical && !collapseToCurrent;
	const version = registerPreviewVersion(s, sessionId, entry, contentHash, { current: !shouldUseHistorical, version: explicitVersion });
	const isVersionedHistorical = shouldUseHistorical
		&& typeof version === "number"
		&& Number.isFinite(version)
		&& version > 0;
	const id = isVersionedHistorical
		? previewVersionedTabId(entry, version)
		: previewEntryTabId(entry);
	const title = previewTabDisplayTitle(entry, version, isVersionedHistorical);
	const source: Record<string, unknown> = {
		type: "html-preview",
		sessionId,
		entry,
		...args.source,
	};
	const tabState: Record<string, unknown> = {
		...args.state,
		entry,
		mtime: args.mtime,
		url: args.url,
	};
	if (contentHash) {
		source.contentHash = contentHash;
		tabState.contentHash = contentHash;
	}
	if (version != null) {
		source.version = version;
		tabState.version = version;
	}
	if (isVersionedHistorical) {
		source.historical = true;
		tabState.historical = true;
		source.dedupeWithLive = false;
		tabState.dedupeWithLive = false;
	} else {
		source.historical = false;
		tabState.historical = false;
		delete source.dedupeWithLive;
		delete tabState.dedupeWithLive;
		if (args.select !== false) source.live = true;
	}
	const tab: PanelWorkspaceTab = {
		id,
		kind: "preview",
		title,
		label: title,
		legacyTab: "preview",
		source: source as PanelWorkspaceTab["source"],
		state: tabState,
	};
	if (!isVersionedHistorical && args.select !== false) {
		for (let i = 0; i < existingTabs.length; i++) {
			const candidate = existingTabs[i];
			if (candidate.kind !== "preview" || candidate.id === tab.id) continue;
			const candidateSource = { ...candidate.source as Record<string, unknown> };
			if (candidateSource.live === true) {
				delete candidateSource.live;
				existingTabs[i] = { ...candidate, source: candidateSource as PanelWorkspaceTab["source"] };
			}
		}
		setPanelTabsForSession(s, sessionId, existingTabs);
	}
	selectPanelWorkspaceTab(tab, {
		sessionId,
		select: args.select,
		setAssistantTab: args.setAssistantTab,
	});
	if (args.select !== false) s.previewPanelMountedTabId = tab.id;
}

export function selectProposalWorkspaceTab(type: string, options: PanelWorkspaceOptions = {}): void {
	const sessionId = panelSessionId(options.sessionId);
	const requestedRev = typeof options.rev === "number" && Number.isFinite(options.rev) && options.rev > 0
		? Math.trunc(options.rev)
		: undefined;
	const activeRev = requestedRev != null ? activeProposalRevForSession(type, sessionId) : undefined;
	const rev = activeRev === requestedRev ? undefined : requestedRev;
	const baseTitle = PROPOSAL_LABELS[type] || `${type.charAt(0).toUpperCase()}${type.slice(1)} Proposal`;
	selectPanelWorkspaceTab({
		id: proposalPanelTabId(type, rev),
		kind: "proposal",
		title: rev ? `${baseTitle} rev ${rev}` : baseTitle,
		label: rev ? `${baseTitle.replace(/ Proposal$/, "")} r${rev}` : (PROPOSAL_LABELS[type]?.replace(/ Proposal$/, "") || type),
		legacyTab: type as LegacyPanelTab,
		source: { type: "proposal", proposalType: type as any, sessionId, rev, historical: rev != null },
		state: rev != null ? {
			rev,
			fields: options.fields,
			historical: true,
		} : {},
	}, { ...options, sessionId });
}

export function selectReviewWorkspaceTab(title: string, options: PanelWorkspaceOptions = {}): void {
	const sessionId = panelSessionId(options.sessionId);
	selectPanelWorkspaceTab({
		id: reviewPanelTabId(title),
		kind: "review",
		title: `Review: ${title}`,
		label: `Review: ${title}`,
		legacyTab: "review",
		source: { type: "review", title, reviewTitle: title, sessionId },
	}, { ...options, sessionId });
}

export function closeReviewWorkspaceTabs(titles?: string[], options: PanelWorkspaceOptions = {}): void {
	const s = state as any;
	const sessionId = panelSessionId(options.sessionId);
	const existingTabs = panelTabsForSession(s, sessionId);
	const ids = titles && titles.length > 0
		? titles.map(reviewPanelTabId)
		: existingTabs
			.filter((tab: PanelWorkspaceTab) => tab?.kind === "review" || tab?.id?.startsWith("review:"))
			.map((tab: PanelWorkspaceTab) => tab.id);
	if (ids.length > 0) removePanelWorkspaceTabs(ids, options);
}

export function selectSensiblePanelWorkspaceTab(options: PanelWorkspaceOptions = {}): void {
	const s = state as any;
	const sessionId = options.sessionId || activeSessionId() || "";
	if (s.reviewPanelOpen && s.reviewDocuments instanceof Map && s.reviewDocuments.size > 0) {
		const title = s.reviewActiveTab || [...s.reviewDocuments.keys()][0];
		if (title) {
			selectReviewWorkspaceTab(title, { ...options, sessionId });
			return;
		}
	}
	if (s.isPreviewSession) {
		selectHtmlPreviewTab({
			sessionId,
			entry: s.previewPanelEntry || "index.html",
			mtime: s.previewPanelMtime,
			contentHash: s.previewPanelContentHash,
			id: LIVE_PREVIEW_PANEL_TAB_ID,
			select: options.select,
			setAssistantTab: options.setAssistantTab,
		});
		return;
	}
	for (const type of ["goal", "project", "role", "tool", "staff"]) {
		if (s.activeProposals?.[type]) {
			selectProposalWorkspaceTab(type, { ...options, sessionId });
			return;
		}
	}
	if (s.inboxPanelOpen || (Array.isArray(s.inboxEntries) && s.inboxEntries.length > 0)) {
		selectPanelWorkspaceTab({ id: INBOX_PANEL_TAB_ID, kind: "inbox", title: "Inbox", label: "Inbox", legacyTab: "inbox", source: { type: "inbox", sessionId } }, { ...options, sessionId });
		return;
	}
	selectPanelWorkspaceTab({ id: CHAT_PANEL_TAB_ID, kind: "chat", title: "Chat", label: "Chat", legacyTab: "chat", source: { type: "chat", sessionId } }, { ...options, sessionId, clearCollapse: false });
}

/** Start an SSE subscription to preview-events for the given session. */
export function startPreviewSubscription(sessionId: string): void {
	stopPreviewSubscription();
	currentSid = sessionId;

	// Bootstrap: GET the current mount state so the iframe can render
	// immediately on session-select instead of waiting for the next
	// preview-changed event. 404 = no mount yet (skip).
	void (async () => {
		try {
			const r = await fetch(
				`/api/preview/mount?sessionId=${encodeURIComponent(sessionId)}`,
				{ credentials: "include" },
			);
			if (!r.ok) return;
			if (currentSid !== sessionId) return; // session switched mid-flight
			const data = await r.json();
			let entry = "";
			let mtime: number | undefined;
			let contentHash = "";
			const artifactId = typeof data?.artifactId === "string" && data.artifactId ? data.artifactId : undefined;
			if (typeof data?.entry === "string" && data.entry) {
				entry = data.entry;
				state.previewPanelEntry = data.entry;
			}
			if (typeof data?.mtime === "number") {
				mtime = data.mtime;
				state.previewPanelMtime = data.mtime;
			}
			contentHash = normalizePreviewContentHash(data?.contentHash);
			(state as any).previewPanelContentHash = contentHash;
			if (entry) {
				selectHtmlPreviewTab({
					sessionId,
					entry,
					mtime,
					contentHash,
					id: LIVE_PREVIEW_PANEL_TAB_ID,
					source: { live: true, origin: "preview-bootstrap", ...(artifactId ? { artifactId } : {}) },
					state: artifactId ? { artifactId } : undefined,
					select: state.previewPanelTab === "preview" || state.previewPanelActiveTab === "preview",
				});
			}
			renderApp();
		} catch { /* ignore bootstrap failures */ }
	})();

	try {
		es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/preview-events`, {
			withCredentials: true,
		});
		es.addEventListener("preview-changed", (ev: MessageEvent) => {
			try {
				const data = JSON.parse(ev.data);
				let entry = state.previewPanelEntry;
				let mtime = Date.now();
				if (typeof data?.entry === "string" && data.entry) {
					entry = data.entry;
					state.previewPanelEntry = data.entry;
				}
				if (typeof data?.mtime === "number") {
					mtime = data.mtime;
					state.previewPanelMtime = data.mtime;
				} else {
					state.previewPanelMtime = mtime;
				}
				const contentHash = normalizePreviewContentHash(data?.contentHash);
				const artifactId = typeof data?.artifactId === "string" && data.artifactId ? data.artifactId : undefined;
				(state as any).previewPanelContentHash = contentHash;
				if (entry) {
					selectHtmlPreviewTab({
						sessionId,
						entry,
						mtime,
						contentHash,
						id: LIVE_PREVIEW_PANEL_TAB_ID,
						source: { live: true, origin: "preview-events", ...(artifactId ? { artifactId } : {}) },
						state: artifactId ? { artifactId } : undefined,
						select: activeSessionId() === sessionId,
					});
				}
				renderApp();
			} catch {
				/* ignore malformed events */
			}
		});
		es.onerror = () => {
			// EventSource auto-reconnects; nothing to do here.
		};
	} catch {
		es = null;
	}
}

/** Tear down the current SSE subscription. */
export function stopPreviewSubscription(): void {
	if (es) {
		try { es.close(); } catch { /* noop */ }
		es = null;
	}
	currentSid = null;
}

// --- Backwards-compat shims for legacy call sites ---
//
// session-manager.ts still imports `startPreviewPolling` / `stopPreviewPolling`
// from this module. Re-export them as aliases for the SSE start/stop so we
// don't have to touch session-manager (constraint: minimal diff).

export function startPreviewPolling(): void {
	const sid = activeSessionId();
	if (!sid) return;
	if (currentSid === sid && es) return;
	startPreviewSubscription(sid);
}

export function stopPreviewPolling(): void {
	stopPreviewSubscription();
}
