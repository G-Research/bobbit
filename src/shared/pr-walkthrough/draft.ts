import type {
	PrWalkthroughCard,
	PrWalkthroughChangesetRef,
	PrWalkthroughComment,
	PrWalkthroughDiffLine,
	PrWalkthroughDraftState,
	PrWalkthroughReviewDraft,
} from "./types.js";

export interface PrWalkthroughCommentAnchor {
	comment: PrWalkthroughComment;
	card: PrWalkthroughCard;
	filePath?: string;
	oldPath?: string;
	line?: PrWalkthroughDiffLine;
	side?: "LEFT" | "RIGHT";
	lineNumber?: number;
}

export function buildPrWalkthroughDraft(state: PrWalkthroughDraftState): PrWalkthroughReviewDraft {
	return {
		changeset: state.changeset ?? fixtureDraftChangeset(),
		decisions: { ...state.decisions },
		comments: state.comments.map(comment => ({ ...comment })),
		completedCardIds: [...state.completedCardIds],
		updatedAt: new Date().toISOString(),
	};
}

export function cardRequiresCommentForDislike(state: Pick<PrWalkthroughDraftState, "comments">, cardId: string): boolean {
	return !state.comments.some(comment => comment.cardId === cardId && comment.body.trim().length > 0);
}

export function defaultDiffModeForWidth(width: number): "split" | "inline" {
	return width >= 760 ? "split" : "inline";
}

export function mapDraftCommentsToAnchors(draft: PrWalkthroughReviewDraft, cards: PrWalkthroughCard[]): PrWalkthroughCommentAnchor[] {
	void draft;
	const cardsById = new Map(cards.map(card => [card.id, card]));
	return draft.comments.flatMap(comment => {
		const card = cardsById.get(comment.cardId);
		if (!card) return [];
		const block = comment.diffBlockId ? card.diffBlocks.find(candidate => candidate.id === comment.diffBlockId) : undefined;
		const line = block && comment.lineId
			? block.hunks.flatMap(hunk => hunk.lines).find(candidate => candidate.id === comment.lineId)
			: undefined;
		const side = line?.kind === "del" ? "LEFT" : line ? "RIGHT" : undefined;
		return [{
			comment,
			card,
			filePath: block?.filePath,
			oldPath: block?.oldPath,
			line,
			side,
			lineNumber: side === "LEFT" ? line?.oldLine : line?.newLine,
		}];
	});
}

function fixtureDraftChangeset(): PrWalkthroughChangesetRef {
	return {
		baseSha: "fixture-base",
		headSha: "fixture-head",
		title: "Fixture PR walkthrough",
	};
}
