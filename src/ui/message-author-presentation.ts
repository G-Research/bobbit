import {
	isAccountablePromptMessage,
	isMessageAuthor,
	normalizeMessageAuthorLabel,
	type MessageAuthorKind,
} from "../shared/message-author.js";

/** Transcript-wide decision shared by the main and pre-compaction message lists. */
export interface PromptAuthorDisplayMode {
	readonly showLabels: boolean;
	/** Future authenticated multi-human seam; does not trigger labels in this goal. */
	readonly distinctHumanIds: readonly string[];
}

const NO_HUMAN_IDS: readonly string[] = Object.freeze([]);

/** Safe default used until the transcript owner supplies its computed mode. */
export const NO_PROMPT_AUTHOR_LABELS: Readonly<PromptAuthorDisplayMode> = Object.freeze({
	showLabels: false,
	distinctHumanIds: NO_HUMAN_IDS,
});

/**
 * Select presentation once over every currently loaded transcript slice.
 * Only a validated agent/system prompt creates ambiguity today; multiple
 * unauthenticated human ids are retained solely as a future-facing seam.
 */
export function selectPromptAuthorDisplayMode(
	messages: readonly unknown[],
): PromptAuthorDisplayMode {
	let showLabels = false;
	const humanIds: string[] = [];
	const seenHumanIds = new Set<string>();

	for (const message of messages) {
		if (!isAccountablePromptMessage(message)) continue;
		const author = (message as { author?: unknown }).author;
		if (!isMessageAuthor(author)) continue;
		if (author.kind === "user") {
			if (!seenHumanIds.has(author.id)) {
				seenHumanIds.add(author.id);
				humanIds.push(author.id);
			}
		} else {
			showLabels = true;
		}
	}

	if (!showLabels && humanIds.length === 0) return NO_PROMPT_AUTHOR_LABELS;
	return Object.freeze({
		showLabels,
		distinctHumanIds: Object.freeze(humanIds),
	});
}

export interface PromptAuthorPresentation {
	kind: MessageAuthorKind;
	visibleName: string;
	accessibleName: string;
	normalizedAgentLabel?: string;
}

/** Build the exact, non-fabricated prompt badge copy for trusted metadata. */
export function presentPromptAuthor(author: unknown): PromptAuthorPresentation | undefined {
	if (!isMessageAuthor(author)) return undefined;

	let visibleName: string;
	let normalizedAgentLabel: string | undefined;
	switch (author.kind) {
		case "user":
			visibleName = "User";
			break;
		case "system":
			visibleName = "System";
			break;
		case "agent":
			normalizedAgentLabel = normalizeMessageAuthorLabel(author.label);
			if (!normalizedAgentLabel) return undefined;
			visibleName = `${normalizedAgentLabel} | Agent`;
			break;
	}

	return {
		kind: author.kind,
		visibleName,
		accessibleName: `Prompt author: ${visibleName}`,
		...(normalizedAgentLabel ? { normalizedAgentLabel } : {}),
	};
}
