export interface PrWalkthroughChangesetRef {
	baseSha: string;
	headSha: string;
	provider?: string;
	externalUrl?: string;
	prUrl?: string;
	prNumber?: string | number;
	prTitle?: string;
	prBody?: string;
	title?: string;
	filesChanged?: number;
	additions?: number;
	deletions?: number;
}

export type PrWalkthroughPhaseId = "orientation" | "design" | "significant" | "other" | "audit";

export type PrWalkthroughDiffLineSide = "old" | "new" | "context";
export type PrWalkthroughDiffLineKind = "context" | "add" | "del";
export type PrWalkthroughDiffMode = "split" | "inline";
export type PrWalkthroughDiffBlockStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "binary";

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
	status?: PrWalkthroughDiffBlockStatus;
	isBinary?: boolean;
	isGenerated?: boolean;
	isTruncated?: boolean;
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

export function buildPrWalkthroughDraft(state: PrWalkthroughDraftState): PrWalkthroughReviewDraft {
	return {
		changeset: state.changeset ?? {
			baseSha: "fixture-base",
			headSha: "fixture-head",
			title: "Fixture PR walkthrough",
		},
		decisions: { ...state.decisions },
		comments: state.comments.map(comment => ({ ...comment })),
		completedCardIds: [...state.completedCardIds],
		updatedAt: new Date().toISOString(),
	};
}

export function cardRequiresCommentForDislike(state: Pick<PrWalkthroughDraftState, "comments">, cardId: string): boolean {
	return !state.comments.some(comment => comment.cardId === cardId && comment.body.trim().length > 0);
}

export function defaultDiffModeForWidth(width: number): PrWalkthroughDiffMode {
	return width >= 760 ? "split" : "inline";
}
