export type SidePanelSizeMode = "collapsed" | "split" | "fullscreen";
export type SidePanelKind = "preview" | "proposal" | "review" | "inbox" | "context" | "pack";
export type SidePanelProposalType = "goal" | "project" | "workflow" | "role" | "tool" | "staff";

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
		type: "context";
		sessionId: string;
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

/** Durable, session-owned review payload identity. These fields are an atomic
 * tuple: artifact-backed review sources must provide all three, while legacy
 * inline review sources provide none of them. */
export interface SidePanelReviewPayloadSource {
	type: "review";
	sessionId: string;
	reviewId: string;
	title: string;
	toolCallId: string;
	payloadId: string;
	contentHash: string;
	documentId?: never;
	reviewTitle?: never;
}

/** Canonical inline review identity retained for existing and migrated tabs. */
export interface SidePanelLegacyReviewSource {
	type: "review";
	sessionId: string;
	reviewId: string;
	title: string;
	documentId?: string;
	reviewTitle?: string;
	toolCallId?: never;
	payloadId?: never;
	contentHash?: never;
}

/** Persisted pre-reviewId sources accepted only during legacy canonicalization. */
export interface SidePanelMigratingReviewSource {
	type: "review";
	sessionId: string;
	reviewId?: undefined;
	documentId?: string;
	title: string;
	reviewTitle?: string;
	toolCallId?: never;
	payloadId?: never;
	contentHash?: never;
}

export type SidePanelReviewSource =
	| SidePanelReviewPayloadSource
	| SidePanelLegacyReviewSource
	| SidePanelMigratingReviewSource;

export interface SidePanelWorkspaceState extends Record<string, unknown> {
	/** Exact selected file identity for a canonical review tab. */
	activeFileId?: string;
}

export interface SidePanelWorkspaceTab {
	id: string;
	kind: SidePanelKind;
	title: string;
	label: string;
	source: SidePanelWorkspaceSource;
	state?: SidePanelWorkspaceState;
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
export const SIDE_PANEL_KINDS: readonly SidePanelKind[] = ["preview", "proposal", "review", "inbox", "context", "pack"] as const;
export const SIDE_PANEL_PROPOSAL_TYPES: readonly SidePanelProposalType[] = ["goal", "project", "workflow", "role", "tool", "staff"] as const;

export function isSidePanelSizeMode(value: unknown): value is SidePanelSizeMode {
	return typeof value === "string" && (SIDE_PANEL_SIZE_MODES as readonly string[]).includes(value);
}

export function isSidePanelKind(value: unknown): value is SidePanelKind {
	return typeof value === "string" && (SIDE_PANEL_KINDS as readonly string[]).includes(value);
}

export function isSidePanelProposalType(value: unknown): value is SidePanelProposalType {
	return typeof value === "string" && (SIDE_PANEL_PROPOSAL_TYPES as readonly string[]).includes(value);
}
