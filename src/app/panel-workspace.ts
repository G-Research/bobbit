import type { ProposalType } from "./proposal-registry.js";

export type PanelWorkspaceKind = "chat" | "preview" | "proposal" | "review" | "inbox";
export type LegacyPanelTab = "chat" | "preview" | "review" | "inbox" | ProposalType;

export interface PanelWorkspaceTab {
	id: string;
	kind: PanelWorkspaceKind;
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
		| { type: "review"; title?: string; reviewTitle?: string; sessionId?: string }
		| { type: "inbox"; sessionId?: string };
	state?: Record<string, unknown>;
}

export const CHAT_PANEL_TAB_ID = "chat";
export const LIVE_PREVIEW_PANEL_TAB_ID = "preview:live";
export const INBOX_PANEL_TAB_ID = "inbox";
export const PANEL_WORKSPACE_NO_SESSION_KEY = "__no-session__";

const PROPOSAL_LABELS: Record<ProposalType, string> = {
	goal: "Goal",
	project: "Project",
	role: "Role",
	tool: "Tool",
	staff: "Staff",
};

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
	return tabs;
}

export function activePanelTabIdForSession(stateLike: any, sessionId: string | null | undefined): string {
	const sid = panelWorkspaceSessionKey(sessionId);
	const activeBySession = stateLike?.panelWorkspaceActiveBySession;
	if (activeBySession && typeof activeBySession === "object" && typeof activeBySession[sid] === "string") {
		return activeBySession[sid];
	}
	const tabs = stateLike?.panelTabsBySession?.[sid];
	if (
		activeMirrorSessionKey(stateLike) === sid &&
		typeof stateLike?.activePanelTabId === "string" &&
		Array.isArray(tabs) &&
		tabs.some((tab: PanelWorkspaceTab) => tab?.id === stateLike.activePanelTabId)
	) {
		return stateLike.activePanelTabId;
	}
	return CHAT_PANEL_TAB_ID;
}

export function setActivePanelTabIdForSession(stateLike: any, sessionId: string | null | undefined, tabId: string): void {
	const sid = panelWorkspaceSessionKey(sessionId);
	if (!stateLike.panelWorkspaceActiveBySession || typeof stateLike.panelWorkspaceActiveBySession !== "object" || Array.isArray(stateLike.panelWorkspaceActiveBySession)) {
		stateLike.panelWorkspaceActiveBySession = {};
	}
	stateLike.panelWorkspaceActiveBySession[sid] = tabId;
	if (activeMirrorSessionKey(stateLike) === sid) stateLike.activePanelTabId = tabId;
	if (stateLike.panelWorkspace && typeof stateLike.panelWorkspace === "object") stateLike.panelWorkspace.activeTabId = tabId;
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

export function reviewPanelTabId(title: string): string {
	return `review:${encodeURIComponent(title)}`;
}

export function reviewTitleFromPanelTab(tab: PanelWorkspaceTab | undefined | null): string {
	if (!tab) return "";
	if (tab.source?.type === "review") {
		if (typeof tab.source.reviewTitle === "string") return tab.source.reviewTitle;
		if (typeof tab.source.title === "string") return tab.source.title;
	}
	const encoded = tab.id.startsWith("review:") ? tab.id.slice("review:".length) : "";
	if (encoded) {
		try { return decodeURIComponent(encoded); } catch { return encoded; }
	}
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
	activeProposalTypes: ProposalType[];
	assistantProposalType: ProposalType | null;
	reviewTitles: string[];
	reviewPanelOpen: boolean;
	inboxPanelOpen: boolean;
	inboxHasPending: boolean;
}

export function buildPanelWorkspaceTabs(input: BuildPanelWorkspaceTabsInput): PanelWorkspaceTab[] {
	const tabs: PanelWorkspaceTab[] = [{
		id: CHAT_PANEL_TAB_ID,
		kind: "chat",
		title: "Chat",
		label: "Chat",
		legacyTab: "chat",
		source: { type: "chat", sessionId: input.sessionId },
	}];

	if (input.isPreviewSession) {
		const entry = input.previewEntry || "inline.html";
		const title = `Preview: ${entry}`;
		tabs.push({
			id: LIVE_PREVIEW_PANEL_TAB_ID,
			kind: "preview",
			title,
			label: title,
			legacyTab: "preview",
			source: { type: "preview", entry, sessionId: input.sessionId },
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
		for (const title of input.reviewTitles) {
			tabs.push({
				id: reviewPanelTabId(title),
				kind: "review",
				title: `Review: ${title}`,
				label: `Review: ${title}`,
				legacyTab: "review",
				source: { type: "review", title, reviewTitle: title, sessionId: input.sessionId },
			});
		}
	}

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

	return tabs;
}

export function panelContentTabs(tabs: PanelWorkspaceTab[]): PanelWorkspaceTab[] {
	return tabs.filter((tab) => tab.kind !== "chat");
}

export function findPanelTab(tabs: PanelWorkspaceTab[], id: string | null | undefined): PanelWorkspaceTab | undefined {
	if (!id) return undefined;
	const exact = tabs.find((tab) => tab.id === id);
	if (exact) return exact;
	if (id.startsWith("review:")) {
		const rawTitle = id.slice("review:".length);
		let decodedTitle = rawTitle;
		try { decodedTitle = decodeURIComponent(rawTitle); } catch { /* keep raw */ }
		return tabs.find((tab) => tab.kind === "review" && reviewTitleFromPanelTab(tab) === decodedTitle);
	}
	return undefined;
}

export function firstContentPanelTab(tabs: PanelWorkspaceTab[]): PanelWorkspaceTab | undefined {
	return tabs.find((tab) => tab.kind !== "chat");
}

export function panelTabIdFromLegacy(tab: LegacyPanelTab | string | null | undefined, reviewActiveTitle: string): string | null {
	if (!tab) return null;
	if (tab === "chat") return CHAT_PANEL_TAB_ID;
	if (tab === "preview") return LIVE_PREVIEW_PANEL_TAB_ID;
	if (tab === "inbox") return INBOX_PANEL_TAB_ID;
	if (tab === "review") return reviewActiveTitle ? reviewPanelTabId(reviewActiveTitle) : null;
	if (tab === "goal" || tab === "project" || tab === "role" || tab === "tool" || tab === "staff") {
		return proposalPanelTabId(tab);
	}
	return null;
}
