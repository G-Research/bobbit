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
		| { type: "proposal"; proposalType: ProposalType; sessionId?: string }
		| { type: "review"; title?: string; reviewTitle?: string; sessionId?: string }
		| { type: "inbox"; sessionId?: string };
	state?: Record<string, unknown>;
}

export const CHAT_PANEL_TAB_ID = "chat";
export const LIVE_PREVIEW_PANEL_TAB_ID = "preview:live";
export const INBOX_PANEL_TAB_ID = "inbox";

const PROPOSAL_LABELS: Record<ProposalType, string> = {
	goal: "Goal",
	project: "Project",
	role: "Role",
	tool: "Tool",
	staff: "Staff",
};

export function proposalPanelTabId(type: ProposalType): string {
	return `proposal:${type}`;
}

export function reviewPanelTabId(title: string): string {
	return `review:${title}`;
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
		source: { type: "chat" },
	}];

	if (input.isPreviewSession) {
		const entry = input.previewEntry || "inline.html";
		tabs.push({
			id: LIVE_PREVIEW_PANEL_TAB_ID,
			kind: "preview",
			title: `Preview: ${entry}`,
			label: "Preview",
			legacyTab: "preview",
			source: { type: "preview", entry },
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
			source: { type: "proposal", proposalType: type },
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
				source: { type: "review", title },
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
			source: { type: "inbox" },
		});
	}

	return tabs;
}

export function panelContentTabs(tabs: PanelWorkspaceTab[]): PanelWorkspaceTab[] {
	return tabs.filter((tab) => tab.kind !== "chat");
}

export function findPanelTab(tabs: PanelWorkspaceTab[], id: string | null | undefined): PanelWorkspaceTab | undefined {
	if (!id) return undefined;
	return tabs.find((tab) => tab.id === id);
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
