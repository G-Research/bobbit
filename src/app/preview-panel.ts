import { hasCurrentProposalSlotForSession } from "./proposal-registry.js";
import { state, renderApp, activeSessionId } from "./state.js";
import {
	CHAT_PANEL_TAB_ID,
	INBOX_PANEL_TAB_ID,
	LIVE_PREVIEW_PANEL_TAB_ID,
	isHistoricalPreviewTab,
	previewEntryLabel,
	previewEntryTabId,
	previewTabIdentityForContent,
	previewVersionRecordFor,
	normalizePreviewContentHash,
	isPreviewContentDismissed,
	panelTabsForSession,
	previewContentHashFromTab,
	proposalPanelTabId,
	reviewDocumentIdForTitle,
	reviewPanelTabId,
	reviewTitleFromPanelTab,
	type LegacyPanelTab,
	type PanelWorkspaceTab,
} from "./panel-workspace.js";
import {
	closeSidePanelTab,
	getSidePanelWorkspace,
	openSidePanelTab,
	updateSidePanelTab,
	type SidePanelWorkspaceTab,
} from "./side-panel-workspace.js";

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

function emitPanelWorkspaceEvent(action: "select" | "close", detail: Record<string, unknown>): void {
	try {
		if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
		const eventDetail = { action, ...detail };
		window.dispatchEvent(new CustomEvent("bobbit-panel-workspace", { detail: eventDetail }));
		window.dispatchEvent(new CustomEvent(`bobbit-panel-workspace:${action}`, { detail: eventDetail }));
	} catch { /* ignore */ }
}

function sidePanelTabFromLegacy(tab: PanelWorkspaceTab, sessionId: string): SidePanelWorkspaceTab | undefined {
	const updatedAt = Date.now();
	if (tab.kind === "preview") {
		const source = tab.source as Record<string, unknown>;
		const tabState = (tab.state || {}) as Record<string, unknown>;
		const entry = previewEntryLabel(typeof tabState.entry === "string" ? tabState.entry : typeof source.entry === "string" ? source.entry : tab.title);
		const version = typeof source.version === "number" ? source.version : typeof tabState.version === "number" ? tabState.version : undefined;
		const contentHash = normalizePreviewContentHash(source.contentHash) || normalizePreviewContentHash(tabState.contentHash);
		const historical = source.historical === true || tabState.historical === true || (typeof version === "number" && version > 0);
		return {
			id: tab.id,
			kind: "preview",
			title: tab.title,
			label: tab.label,
			source: {
				type: "preview",
				sessionId,
				entry,
				...(historical ? { historical: true } : { live: source.live === true }),
				...(typeof version === "number" && version > 0 ? { version: Math.trunc(version) } : {}),
				...(typeof source.artifactId === "string" ? { artifactId: source.artifactId } : {}),
				...(contentHash ? { contentHash } : {}),
				...(typeof source.path === "string" ? { path: source.path } : {}),
				...(typeof source.url === "string" ? { url: source.url } : {}),
				...(typeof source.toolUseId === "string" ? { toolUseId: source.toolUseId } : {}),
				...(typeof source.blockIndex === "number" ? { blockIndex: source.blockIndex } : {}),
			},
			state: tab.state,
			updatedAt,
		};
	}
	if (tab.kind === "proposal" && tab.source.type === "proposal") {
		const source = tab.source as Record<string, unknown>;
		const proposalType = typeof source.proposalType === "string" ? source.proposalType : "goal";
		const rev = typeof source.rev === "number" && Number.isFinite(source.rev) && source.rev > 0 ? Math.trunc(source.rev) : undefined;
		return {
			id: tab.id,
			kind: "proposal",
			title: tab.title,
			label: tab.label,
			source: { type: "proposal", sessionId, proposalType: proposalType as any, ...(rev ? { rev, historical: true } : {}) },
			state: tab.state,
			updatedAt,
		};
	}
	if (tab.kind === "review") {
		const title = reviewTitleFromPanelTab(tab) || tab.title.replace(/^Review:\s*/, "") || "Review";
		const documentId = typeof (tab.source as any).documentId === "string" && (tab.source as any).documentId
			? (tab.source as any).documentId
			: reviewDocumentIdForTitle(title);
		return {
			id: reviewPanelTabId(documentId),
			kind: "review",
			title: `Review: ${title}`,
			label: `Review: ${title}`,
			source: { type: "review", sessionId, documentId, title },
			state: tab.state,
			updatedAt,
		};
	}
	if (tab.kind === "inbox") {
		return { id: INBOX_PANEL_TAB_ID, kind: "inbox", title: tab.title || "Inbox", label: tab.label || "Inbox", source: { type: "inbox", sessionId }, state: tab.state, updatedAt };
	}
	if (tab.kind === "pack" && tab.source.type === "pack") {
		return {
			id: tab.id,
			kind: "pack",
			title: tab.title,
			label: tab.label,
			source: { type: "pack", sessionId, packId: tab.source.packId, panelId: tab.source.panelId, instanceKey: tab.source.instanceKey || "default", singleton: tab.source.singleton, params: tab.source.params },
			state: tab.state,
			updatedAt,
		};
	}
	return undefined;
}

function isSidePanelTabOpen(sessionId: string, tabId: string): boolean {
	return getSidePanelWorkspace(sessionId).tabs.some((tab) => tab.id === tabId);
}

export function selectPanelWorkspaceTab(tab: PanelWorkspaceTab, options: PanelWorkspaceOptions = {}): void {
	const s = state as any;
	const sessionId = panelSessionId(options.sessionId);
	applyLegacySelection(s, tab, options);
	const sideTab = tab.kind === "chat" ? undefined : sidePanelTabFromLegacy(tab, sessionId);
	if (sideTab) {
		if (options.select === false) {
			if (isSidePanelTabOpen(sessionId, sideTab.id)) void updateSidePanelTab(sideTab.id, sideTab, { sessionId });
		} else {
			void openSidePanelTab(sideTab, { focus: true });
		}
	}
	const activeTabId = options.select === false ? getSidePanelWorkspace(sessionId).activeTabId : tab.id;
	emitPanelWorkspaceEvent("select", { tab, activeTabId, options });
}

export function removePanelWorkspaceTabs(ids: string[], options: PanelWorkspaceOptions = {}): void {
	const sessionId = panelSessionId(options.sessionId);
	for (const id of ids) void closeSidePanelTab(id, { sessionId });
	emitPanelWorkspaceEvent("close", { tabIds: ids, options });
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
	// When the caller explicitly opts out of live dedupe (e.g. PreviewRenderer
	// opening an older artifact whose hash already matches the SSE-updated
	// current tab), respect that intent and force the versioned tab path. The
	// PreviewRenderer already decided collapse-vs-historical before getting
	// here based on the pre-restore current tab hash.
	const collapseToCurrent = requestedHistorical
		&& args.dedupeWithLive !== false
		&& !!contentHash
		&& !!currentFilenameTab
		&& previewContentHashFromTab(currentFilenameTab) === contentHash;
	const shouldUseHistorical = requestedHistorical && !collapseToCurrent;

	// Detect a live SSE event that's rehydrating an older registered version
	// (e.g. the server just restored a historical artifact into the live mount
	// and broadcast the older content hash). The current filename tab still
	// represents the LATEST fresh write — don't overwrite its metadata with
	// older bytes, and don't change the active tab id (the user may be viewing
	// the historical tab they just opened).
	const isLiveEvent = (args.source as Record<string, unknown> | undefined)?.live === true
		|| (args.source as Record<string, unknown> | undefined)?.origin === "preview-events"
		|| (args.source as Record<string, unknown> | undefined)?.origin === "preview-bootstrap";
	if (isLiveEvent && !requestedHistorical && contentHash && currentFilenameTab) {
		const record = previewVersionRecordFor(s, sessionId, entry);
		const latestVersion = record?.latestVersion ?? 0;
		const hashVersion = record?.hashToVersion?.[contentHash];
		if (latestVersion > 0 && typeof hashVersion === "number" && hashVersion > 0 && hashVersion < latestVersion) {
			// Older version rehydration via live mount — keep the current tab's
			// metadata, its label, and the active selection intact. The live mount
			// state (s.previewPanelContentHash etc) is updated by the caller and
			// drives the iframe; this filename tab will trigger a re-restore via
			// `restoreHistoricalPreviewTab` next time it's selected.
			return;
		}
	}
	const identity = previewTabIdentityForContent(s, sessionId, entry, contentHash, {
		current: !shouldUseHistorical,
		historical: shouldUseHistorical,
		version: explicitVersion,
	});
	const version = identity.version;
	const isVersionedHistorical = identity.historical;
	const id = identity.id;
	const title = identity.title;
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
		for (const candidate of existingTabs) {
			if (candidate.kind !== "preview" || candidate.id === tab.id) continue;
			const candidateSource = { ...candidate.source as Record<string, unknown> };
			if (candidateSource.live === true) {
				delete candidateSource.live;
				const next = { ...candidate, source: candidateSource as PanelWorkspaceTab["source"] };
				const sideTab = sidePanelTabFromLegacy(next, sessionId);
				if (sideTab && isSidePanelTabOpen(sessionId, sideTab.id)) void updateSidePanelTab(sideTab.id, sideTab, { sessionId, skipRender: true });
			}
		}
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
	if (rev == null && !hasCurrentProposalSlotForSession(state as any, type, sessionId)) {
		removePanelWorkspaceTabs([proposalPanelTabId(type)], { sessionId, select: false, clearCollapse: false });
		return;
	}
	const baseTitle = PROPOSAL_LABELS[type] || `${type.charAt(0).toUpperCase()}${type.slice(1)} Proposal`;
	selectPanelWorkspaceTab({
		id: proposalPanelTabId(type, rev),
		kind: "proposal",
		title: rev ? `${baseTitle} (v${rev})` : baseTitle,
		label: rev ? `${baseTitle.replace(/ Proposal$/, "")} (v${rev})` : (PROPOSAL_LABELS[type]?.replace(/ Proposal$/, "") || type),
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
	const sessionId = options.sessionId || activeSessionId() || "";
	const workspace = getSidePanelWorkspace(sessionId);
	const existing = workspace.tabs.find((tab) => tab.id === workspace.activeTabId) || workspace.tabs[0];
	const legacy = existing ? panelTabsForSession(state, sessionId).find((tab) => tab.id === existing.id) : undefined;
	if (legacy) {
		selectPanelWorkspaceTab(legacy, { ...options, sessionId });
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
			if (entry && !isPreviewContentDismissed(sessionId, entry, contentHash)) {
				selectHtmlPreviewTab({
					sessionId,
					entry,
					mtime,
					contentHash,
					id: LIVE_PREVIEW_PANEL_TAB_ID,
					source: { live: true, origin: "preview-bootstrap", ...(artifactId ? { artifactId } : {}) },
					state: artifactId ? { artifactId } : undefined,
					select: false,
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
				if (entry && !isPreviewContentDismissed(sessionId, entry, contentHash)) {
					selectHtmlPreviewTab({
						sessionId,
						entry,
						mtime,
						contentHash,
						id: LIVE_PREVIEW_PANEL_TAB_ID,
						source: { live: true, origin: "preview-events", ...(artifactId ? { artifactId } : {}) },
						state: artifactId ? { artifactId } : undefined,
						select: false,
						setAssistantTab: false,
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
