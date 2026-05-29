export interface PrWalkthroughChangesetRef {
	baseSha: string;
	headSha: string;
	provider?: string;
	externalUrl?: string;
	prUrl?: string;
	prNumber?: string | number;
	prTitle?: string;
	title?: string;
	filesChanged?: number;
	additions?: number;
	deletions?: number;
}

export type PrWalkthroughPhaseId = "orientation" | "design" | "significant" | "other" | "audit";

export type PrWalkthroughDiffLineSide = "old" | "new" | "context";
export type PrWalkthroughDiffLineKind = "context" | "add" | "del";
export type PrWalkthroughDiffMode = "split" | "inline";

export interface PrWalkthroughDiffLine {
	id: string;
	side: PrWalkthroughDiffLineSide;
	oldLine?: number;
	newLine?: number;
	text: string;
	kind: PrWalkthroughDiffLineKind;
}

export interface PrWalkthroughHunk {
	id: string;
	header: string;
	lines: PrWalkthroughDiffLine[];
}

export interface PrWalkthroughDiffBlock {
	id: string;
	filePath: string;
	oldPath?: string;
	hunks: PrWalkthroughHunk[];
}

export interface PrWalkthroughSuggestedComment {
	id: string;
	cardId: string;
	diffBlockId: string;
	lineId: string;
	body: string;
}

export interface PrWalkthroughCard {
	id: string;
	phaseId: PrWalkthroughPhaseId;
	title: string;
	summary: string;
	rationale?: string;
	diffBlocks: PrWalkthroughDiffBlock[];
	suggestedComments?: PrWalkthroughSuggestedComment[];
	cardSuggestions?: string[];
	checklist?: string[];
}

export interface PrWalkthroughComment {
	id: string;
	cardId: string;
	diffBlockId?: string;
	lineId?: string;
	body: string;
	source: "custom" | "suggested";
	createdAt: string;
	updatedAt?: string;
}

export interface PrWalkthroughDecision {
	cardId: string;
	value: "liked" | "disliked";
	commentIds: string[];
	updatedAt: string;
}

export interface PrWalkthroughReviewDraft {
	changeset: PrWalkthroughChangesetRef;
	decisions: Record<string, PrWalkthroughDecision>;
	comments: PrWalkthroughComment[];
	completedCardIds: string[];
	updatedAt: string;
}

export interface PrWalkthroughDraftState {
	changeset?: PrWalkthroughChangesetRef;
	decisions: Record<string, PrWalkthroughDecision>;
	comments: PrWalkthroughComment[];
	completedCardIds: string[];
}

export type WalkthroughWarningSeverity = "info" | "warning" | "error";

export interface WalkthroughWarning {
	code: string;
	severity: WalkthroughWarningSeverity;
	message: string;
	filePath?: string;
}

export interface WalkthroughLimits {
	maxFiles: number;
	maxDiffBytes: number;
	maxLinesPerFile: number;
	truncatedFiles?: string[];
	omittedFiles?: string[];
}

export interface WalkthroughExportCapability {
	provider: "github" | string;
	available: boolean;
	reason?: string;
	previewUrl?: string;
	submitUrl?: string;
}

export interface WalkthroughResolveRequest {
	sessionId?: string;
	cwd?: string;
	baseSha?: string;
	headSha?: string;
	prUrl?: string;
	prNumber?: string | number;
	provider?: "github" | "local" | string;
	fixture?: boolean;
}

export interface WalkthroughResolveResult {
	changesetId: string;
	changeset: PrWalkthroughChangesetRef;
	cards: PrWalkthroughCard[];
	warnings: WalkthroughWarning[];
	limits?: WalkthroughLimits;
	export?: WalkthroughExportCapability;
}

export interface WalkthroughExportPreviewRow {
	commentId: string;
	cardId: string;
	path?: string;
	side?: "LEFT" | "RIGHT";
	line?: number;
	body: string;
	valid: boolean;
	reason?: string;
}

export interface WalkthroughExportPreview {
	provider: "github" | string;
	changesetId: string;
	body: string;
	comments: WalkthroughExportPreviewRow[];
	warnings: WalkthroughWarning[];
	canSubmit: boolean;
}

export interface WalkthroughExportRequest {
	draft: PrWalkthroughReviewDraft;
	confirm?: boolean;
	event?: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
}

export interface WalkthroughExportResult {
	ok: boolean;
	provider: "github" | string;
	submitted?: boolean;
	reviewUrl?: string;
	preview?: WalkthroughExportPreview;
	warnings?: WalkthroughWarning[];
	error?: string;
}
