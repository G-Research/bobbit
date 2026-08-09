export type SidePanelSizeMode = "collapsed" | "split" | "fullscreen";
export type SidePanelKind = "preview" | "proposal" | "review" | "inbox" | "pack";
export type SidePanelProposalType = "goal" | "project" | "role" | "tool" | "staff";

export type SidePanelWorkspaceSource =
	| {
		type: "preview";
		sessionId: string;
		entry: string;
		live?: boolean;
		historical?: boolean;
		version?: number;
		artifactId?: string;
		contentHash?: string;
		path?: string;
		url?: string;
		toolUseId?: string;
		blockIndex?: number;
	}
	| {
		type: "proposal";
		sessionId: string;
		proposalType: SidePanelProposalType;
		rev?: number;
		historical?: boolean;
	}
	| SidePanelReviewSource
	| {
		type: "inbox";
		sessionId: string;
		staffId?: string;
	}
	| {
		type: "pack";
		sessionId: string;
		packId: string;
		panelId: string;
		instanceKey: string;
		singleton?: boolean;
		params?: Record<string, unknown>;
	};

/** Canonical review workspace identity. `documentId` and a missing `reviewId`
 * are accepted only while persisted legacy workspaces are canonicalized. */
export type SidePanelReviewSource =
	| {
		type: "review";
		sessionId: string;
		reviewId: string;
		title: string;
		documentId?: string;
		reviewTitle?: string;
	}
	| {
		type: "review";
		sessionId: string;
		reviewId?: undefined;
		documentId?: string;
		title: string;
		reviewTitle?: string;
	};

export interface SidePanelWorkspaceTab {
	id: string;
	kind: SidePanelKind;
	title: string;
	label: string;
	source: SidePanelWorkspaceSource;
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

export const SIDE_PANEL_SIZE_MODES: readonly SidePanelSizeMode[] = ["collapsed", "split", "fullscreen"] as const;
export const SIDE_PANEL_KINDS: readonly SidePanelKind[] = ["preview", "proposal", "review", "inbox", "pack"] as const;
export const SIDE_PANEL_PROPOSAL_TYPES: readonly SidePanelProposalType[] = ["goal", "project", "role", "tool", "staff"] as const;

export function isSidePanelSizeMode(value: unknown): value is SidePanelSizeMode {
	return typeof value === "string" && (SIDE_PANEL_SIZE_MODES as readonly string[]).includes(value);
}

export function isSidePanelKind(value: unknown): value is SidePanelKind {
	return typeof value === "string" && (SIDE_PANEL_KINDS as readonly string[]).includes(value);
}

export function isSidePanelProposalType(value: unknown): value is SidePanelProposalType {
	return typeof value === "string" && (SIDE_PANEL_PROPOSAL_TYPES as readonly string[]).includes(value);
}
