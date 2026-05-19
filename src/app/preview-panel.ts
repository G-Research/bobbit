import { state, renderApp, activeSessionId } from "./state.js";

// WP-E: SSE subscription to per-session preview mount events.
// The gateway watches <stateDir>/preview/<sid>/ and emits a `preview-changed`
// event whenever the agent rewrites the entry file or any sibling asset.
// We bump `previewPanelMtime` to force the iframe to reload via `#mtime=<n>`.

type PanelWorkspaceTabKind = "chat" | "preview" | "proposal" | "review" | "inbox";

type PanelWorkspaceTab = {
	id: string;
	kind: PanelWorkspaceTabKind;
	title: string;
	source?: Record<string, unknown>;
	state?: Record<string, unknown>;
};

type PanelWorkspaceOptions = {
	sessionId?: string;
	select?: boolean;
	setAssistantTab?: boolean;
	clearCollapse?: boolean;
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

function safeBaseName(path: string | undefined): string {
	if (!path) return "";
	const clean = path.split(/[?#]/, 1)[0]?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
	return clean.split("/").filter(Boolean).pop() || clean || "";
}

function reviewTabId(title: string): string {
	return `review:${encodeURIComponent(title)}`;
}

function activePanelTabId(s: any): string {
	return typeof s.activePanelTabId === "string" ? s.activePanelTabId
		: typeof s.panelWorkspace?.activeTabId === "string" ? s.panelWorkspace.activeTabId
		: "";
}

function mutablePanelTabs(s: any): PanelWorkspaceTab[] | null {
	if (Array.isArray(s.panelWorkspace?.tabs)) return s.panelWorkspace.tabs as PanelWorkspaceTab[];
	if (Array.isArray(s.panelTabs)) return s.panelTabs as PanelWorkspaceTab[];
	if (Object.prototype.hasOwnProperty.call(s, "panelTabs")) {
		s.panelTabs = [];
		return s.panelTabs as PanelWorkspaceTab[];
	}
	return null;
}

function upsertPanelTabState(s: any, tab: PanelWorkspaceTab): void {
	const tabs = mutablePanelTabs(s);
	if (!tabs) return;
	const idx = tabs.findIndex(t => t?.id === tab.id);
	if (idx >= 0) tabs[idx] = { ...tabs[idx], ...tab };
	else tabs.push(tab);
}

function setActivePanelTabState(s: any, tabId: string): void {
	if ("activePanelTabId" in s) s.activePanelTabId = tabId;
	if (s.panelWorkspace && typeof s.panelWorkspace === "object") s.panelWorkspace.activeTabId = tabId;
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
		const proposalType = typeof tab.source?.proposalType === "string" ? tab.source.proposalType : "goal";
		s.assistantHasProposal = true;
		s.previewPanelActiveTab = proposalType;
		s.previewPanelTab = proposalType;
		if (s.assistantType && setAssistantTab) s.assistantTab = "preview";
		return;
	}
	if (tab.kind === "review") {
		const title = typeof tab.source?.reviewTitle === "string" ? tab.source.reviewTitle : tab.title.replace(/^Review:\s*/, "");
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
	upsertPanelTabState(s, tab);
	if (options.select !== false) setActivePanelTabState(s, tab.id);
	applyLegacySelection(s, tab, options);
	if (options.clearCollapse !== false) clearCollapseKey(options.sessionId || activeSessionId() || undefined);
	const detail = { tab, activeTabId: options.select === false ? activePanelTabId(s) : tab.id, options };
	emitPanelWorkspaceEvent("select", detail);
	void notifyOptionalPanelWorkspaceModule("select", detail);
}

export function removePanelWorkspaceTabs(ids: string[], options: PanelWorkspaceOptions = {}): void {
	const s = state as any;
	const idSet = new Set(ids);
	for (const holder of [s, s.panelWorkspace].filter(Boolean)) {
		if (!Array.isArray(holder.tabs ?? holder.panelTabs)) continue;
		const key = Array.isArray(holder.tabs) ? "tabs" : "panelTabs";
		holder[key] = holder[key].filter((tab: PanelWorkspaceTab) => !idSet.has(tab.id));
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
	source?: Record<string, unknown>;
	select?: boolean;
	setAssistantTab?: boolean;
}): void {
	const sessionId = args.sessionId || activeSessionId() || "";
	const entry = args.entry || state.previewPanelEntry || "index.html";
	const tab: PanelWorkspaceTab = {
		id: args.id || `preview:live:${sessionId || "active"}`,
		kind: "preview",
		title: args.title || `Preview: ${safeBaseName(entry) || "inline.html"}`,
		source: {
			type: "html-preview",
			sessionId,
			entry,
			...args.source,
		},
		state: {
			entry,
			mtime: args.mtime,
			url: args.url,
		},
	};
	selectPanelWorkspaceTab(tab, {
		sessionId,
		select: args.select,
		setAssistantTab: args.setAssistantTab,
	});
}

export function selectProposalWorkspaceTab(type: string, options: PanelWorkspaceOptions = {}): void {
	const sessionId = options.sessionId || activeSessionId() || "";
	selectPanelWorkspaceTab({
		id: `proposal:${type}`,
		kind: "proposal",
		title: PROPOSAL_LABELS[type] || `${type.charAt(0).toUpperCase()}${type.slice(1)} Proposal`,
		source: { type: "proposal", proposalType: type, sessionId },
	}, { ...options, sessionId });
}

export function selectReviewWorkspaceTab(title: string, options: PanelWorkspaceOptions = {}): void {
	const sessionId = options.sessionId || activeSessionId() || "";
	selectPanelWorkspaceTab({
		id: reviewTabId(title),
		kind: "review",
		title: `Review: ${title}`,
		source: { type: "review", reviewTitle: title, sessionId },
	}, { ...options, sessionId });
}

export function closeReviewWorkspaceTabs(titles?: string[], options: PanelWorkspaceOptions = {}): void {
	const s = state as any;
	const existingTabs = Array.isArray(s.panelWorkspace?.tabs) ? s.panelWorkspace.tabs
		: Array.isArray(s.panelTabs) ? s.panelTabs
		: [];
	const ids = titles && titles.length > 0
		? titles.map(reviewTabId)
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
			id: `preview:live:${sessionId || "active"}`,
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
		selectPanelWorkspaceTab({ id: "inbox", kind: "inbox", title: "Inbox", source: { type: "inbox", sessionId } }, { ...options, sessionId });
		return;
	}
	selectPanelWorkspaceTab({ id: "chat", kind: "chat", title: "Chat", source: { type: "chat", sessionId } }, { ...options, sessionId, clearCollapse: false });
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
			if (typeof data?.entry === "string" && data.entry) {
				entry = data.entry;
				state.previewPanelEntry = data.entry;
			}
			if (typeof data?.mtime === "number") {
				mtime = data.mtime;
				state.previewPanelMtime = data.mtime;
			}
			if (entry) {
				selectHtmlPreviewTab({
					sessionId,
					entry,
					mtime,
					id: `preview:live:${sessionId}`,
					source: { live: true, origin: "preview-bootstrap" },
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
				if (entry) {
					selectHtmlPreviewTab({
						sessionId,
						entry,
						mtime,
						id: `preview:live:${sessionId}`,
						source: { live: true, origin: "preview-events" },
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
