import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	ASK_TOOL_USE_ID_PATTERN,
	isAskResponseEnvelope,
	parseAskResponseEnvelope,
	type AskResponseAnswer,
} from "../shared/ask-envelope.js";
import {
	isMessageAuthor,
	isToolResultOnlyMessage,
	normalizeMessageAuthorLabel,
	type BobbitMessage,
	type MessageAuthor,
	type MessageAuthorKind,
} from "../shared/message-author.js";
import { classifyAskUserChoicesState } from "./tools/ask-user-choices-state.js";

export type TranscriptHistoryKind = "user" | "system" | "agent" | "question";
export type TranscriptHistoryFilter = "all" | TranscriptHistoryKind;
export type TranscriptHistoryQuestionStatus = "unanswered" | "answered" | "dismissed" | "failed";

export interface TranscriptHistoryEntry {
	id: string;
	targetId: string;
	ordinal: number;
	kind: TranscriptHistoryKind;
	author?: MessageAuthor;
	authorLabel: string;
	typeLabel: string;
	excerpt: string;
	unresolved: boolean;
	toolUseId?: string;
	questionStatus?: TranscriptHistoryQuestionStatus;
}

export interface DOMRectLike {
	bottom: number;
}

export interface TranscriptNavigation {
	entries: TranscriptHistoryEntry[];
	unresolvedQuestions: TranscriptHistoryEntry[];
}

interface AskCandidate {
	entry: TranscriptHistoryEntry;
	result?: ToolResultMessage;
	responseAnswers: AskResponseAnswer[] | null;
	dismissed: boolean;
}

const ASK_TOOL_USE_ID_REGEX = new RegExp(`^(?:${ASK_TOOL_USE_ID_PATTERN})$`);
const EXCERPT_LIMIT = 180;

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** Stable message identity shared by history entries and transcript DOM targets. */
export function transcriptMessageIdentity(message: unknown, ordinal: number): string {
	const candidate = message && typeof message === "object"
		? message as Record<string, unknown>
		: {};
	const id = nonEmptyString(candidate.id);
	if (id) return id;
	return `synth:${candidate._origin ?? "unknown"}:${candidate._order ?? 0}:${candidate._insertionTick ?? 0}:${ordinal}`;
}

/** The exact value render owners should stamp as `data-transcript-target`. */
export function transcriptMessageTargetId(message: unknown, ordinal: number): string {
	return `message:${transcriptMessageIdentity(message, ordinal)}`;
}

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function excerpt(value: string): string {
	const normalized = normalizeText(value);
	return normalized.length <= EXCERPT_LIMIT
		? normalized
		: `${normalized.slice(0, EXCERPT_LIMIT - 1).trimEnd()}…`;
}

function textContent(message: Record<string, unknown>): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } =>
			Boolean(block && typeof block === "object"
				&& (block as Record<string, unknown>).type === "text"
				&& typeof (block as Record<string, unknown>).text === "string"))
		.map((block) => block.text)
		.join("\n");
}

function messageAuthor(message: Record<string, unknown>): MessageAuthor | undefined {
	return isMessageAuthor(message.author) ? message.author : undefined;
}

function authorKind(message: Record<string, unknown>, fallback: MessageAuthorKind): MessageAuthorKind {
	return messageAuthor(message)?.kind ?? fallback;
}

function authorLabel(message: Record<string, unknown>, fallback: string): string {
	if (!isMessageAuthor(message.author)) return fallback;
	if (message.author.kind === "system") return "System";
	return normalizeMessageAuthorLabel(message.author.label) ?? fallback;
}

function historyKind(kind: MessageAuthorKind): Exclude<TranscriptHistoryKind, "question"> {
	return kind;
}

function validAskParams(value: unknown): value is { questions: Array<{ question: string }> } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const questions = (value as Record<string, unknown>).questions;
	if (!Array.isArray(questions) || questions.length < 1 || questions.length > 5) return false;
	return questions.every((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const question = value as Record<string, unknown>;
		if (!nonEmptyString(question.question)) return false;
		if (!Array.isArray(question.options)
			|| question.options.length < 2
			|| question.options.length > 8
			|| !question.options.every((option) => Boolean(nonEmptyString(option)))) return false;
		if (question.tab_label !== undefined
			&& (!nonEmptyString(question.tab_label) || (question.tab_label as string).length > 24)) return false;
		if (questions.length > 1 && !nonEmptyString(question.tab_label)) return false;
		if (question.multi !== undefined && typeof question.multi !== "boolean") return false;
		for (const bound of [question.min, question.max]) {
			if (bound !== undefined && (!Number.isInteger(bound) || (bound as number) < 1)) return false;
		}
		return true;
	});
}

function toolParams(block: Record<string, unknown>): unknown {
	return block.arguments ?? block.input;
}

function asToolResult(message: Record<string, unknown>): { id: string; result: ToolResultMessage } | null {
	const role = message.role;
	if (role !== "toolResult" && role !== "tool_result" && role !== "tool") return null;
	const id = nonEmptyString(message.toolCallId ?? message.tool_call_id ?? message.tool_use_id);
	if (!id) return null;
	return { id, result: message as unknown as ToolResultMessage };
}

function blockToolResults(message: Record<string, unknown>): Array<{ id: string; result: ToolResultMessage }> {
	if ((message.role !== "user" && message.role !== "user-with-attachments")
		|| !Array.isArray(message.content)) return [];
	const results: Array<{ id: string; result: ToolResultMessage }> = [];
	for (const value of message.content) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const block = value as Record<string, unknown>;
		if (block.type !== "tool_result" && block.type !== "toolResult") continue;
		const id = nonEmptyString(block.tool_use_id ?? block.toolCallId);
		if (!id) continue;
		const content = typeof block.content === "string"
			? [{ type: "text", text: block.content }]
			: Array.isArray(block.content) ? block.content : [];
		results.push({
			id,
			result: {
				role: "toolResult",
				toolCallId: id,
				toolName: "ask_user_choices",
				content,
				isError: block.is_error === true || block.isError === true,
				timestamp: typeof message.timestamp === "number" ? message.timestamp : 0,
			} as ToolResultMessage,
		});
	}
	return results;
}

function refreshCandidate(candidate: AskCandidate): void {
	const state = classifyAskUserChoicesState(candidate.result, candidate.responseAnswers);
	candidate.entry.questionStatus = state.answers
		? "answered"
		: state.failed
			? "failed"
			: candidate.dismissed
				? "dismissed"
				: "unanswered";
	candidate.entry.unresolved = candidate.entry.questionStatus === "unanswered";
}

function pushEntry(
	entries: TranscriptHistoryEntry[],
	entry: Omit<TranscriptHistoryEntry, "ordinal">,
): TranscriptHistoryEntry {
	const complete = { ...entry, ordinal: entries.length };
	entries.push(complete);
	return complete;
}

/** Build the chronological client-only navigation projection from the active transcript. */
export function deriveTranscriptNavigation(
	messages: readonly BobbitMessage<any>[] | null | undefined,
	options: { dismissedToolUseIds?: ReadonlySet<string> } = {},
): TranscriptNavigation {
	const entries: TranscriptHistoryEntry[] = [];
	const asks = new Map<string, AskCandidate>();
	if (!Array.isArray(messages)) return { entries, unresolvedQuestions: [] };

	for (let messageOrdinal = 0; messageOrdinal < messages.length; messageOrdinal++) {
		const message = messages[messageOrdinal] as Record<string, unknown>;
		if (!message || typeof message !== "object") continue;
		const targetId = transcriptMessageTargetId(message, messageOrdinal);

		const directResult = asToolResult(message);
		const results = directResult ? [directResult] : blockToolResults(message);
		for (const relation of results) {
			const candidate = asks.get(relation.id);
			if (!candidate) continue;
			candidate.result = relation.result;
			refreshCandidate(candidate);
		}
		if (directResult || isToolResultOnlyMessage(message)) continue;

		if (isAskResponseEnvelope(message)) {
			const parsed = parseAskResponseEnvelope(textContent(message));
			const candidate = parsed ? asks.get(parsed.toolUseId) : undefined;
			if (candidate) {
				candidate.responseAnswers = parsed!.answers;
				refreshCandidate(candidate);
			}
			continue;
		}

		const role = message.role;
		if (role === "user" || role === "user-with-attachments") {
			const text = excerpt(textContent(message));
			if (!text) continue;
			const author = messageAuthor(message);
			const kind = author?.kind ?? "user";
			pushEntry(entries, {
				id: `${targetId}:${kind}`,
				targetId,
				kind: historyKind(kind),
				...(author ? { author } : {}),
				authorLabel: authorLabel(message, kind === "user" ? "User" : kind === "system" ? "System" : "Agent"),
				typeLabel: kind === "user" ? "Prompt" : kind === "system" ? "System Message" : "Agent prompt",
				excerpt: text,
				unresolved: false,
			});
			continue;
		}

		if (role === "system-notification" || role === "mutation-pending" || role === "error") {
			const raw = role === "system-notification"
				? message.message ?? message.content
				: role === "mutation-pending" ? message.summary : message.content;
			const text = excerpt(typeof raw === "string" ? raw : "");
			if (!text) continue;
			const author = messageAuthor(message);
			pushEntry(entries, {
				id: `${targetId}:system`,
				targetId,
				kind: "system",
				...(author ? { author } : {}),
				authorLabel: authorLabel(message, "System"),
				typeLabel: role === "error" ? "Error" : "System event",
				excerpt: text,
				unresolved: false,
			});
			continue;
		}

		if (role !== "assistant" || !Array.isArray(message.content)) continue;
		const fallbackKind = authorKind(message, "agent");
		const owningAuthor = messageAuthor(message);
		const owningAuthorLabel = authorLabel(
			message,
			fallbackKind === "agent" ? "Assistant" : fallbackKind === "system" ? "System" : "User",
		);
		let bufferedText: string[] = [];
		let textStart = 0;
		const flushText = () => {
			const text = excerpt(bufferedText.join("\n"));
			if (text) {
				pushEntry(entries, {
					id: `${targetId}:${fallbackKind}:${textStart}`,
					targetId,
					kind: historyKind(fallbackKind),
					...(owningAuthor ? { author: owningAuthor } : {}),
					authorLabel: owningAuthorLabel,
					typeLabel: fallbackKind === "agent" ? "Response" : fallbackKind === "system" ? "System Message" : "Message",
					excerpt: text,
					unresolved: false,
				});
			}
			bufferedText = [];
		};

		for (let blockOrdinal = 0; blockOrdinal < message.content.length; blockOrdinal++) {
			const value = message.content[blockOrdinal];
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			const block = value as Record<string, unknown>;
			if (block.type === "text" && typeof block.text === "string") {
				if (bufferedText.length === 0) textStart = blockOrdinal;
				bufferedText.push(block.text);
				continue;
			}
			if (block.type !== "toolCall" && block.type !== "tool_use") continue;
			flushText();

			if (block.name === "__compaction_summary" || block.name === "__context_cleared") {
				pushEntry(entries, {
					id: `${targetId}:system:${blockOrdinal}`,
					targetId,
					kind: "system",
					authorLabel: "System",
					typeLabel: "System event",
					excerpt: block.name === "__context_cleared" ? "Context cleared" : "Context compacted",
					unresolved: false,
				});
				continue;
			}
			if (block.name !== "ask_user_choices") continue;
			const id = nonEmptyString(block.id);
			const params = toolParams(block);
			if (!id || !ASK_TOOL_USE_ID_REGEX.test(id) || !validAskParams(params)) continue;
			const questions = params.questions.map((question) => question.question).join(" · ");
			const dismissed = options.dismissedToolUseIds?.has(id) === true;
			const entry = pushEntry(entries, {
				id: `${targetId}:question:${id}`,
				targetId,
				kind: "question",
				...(owningAuthor ? { author: owningAuthor } : {}),
				authorLabel: owningAuthorLabel,
				typeLabel: "Multiple-choice question",
				excerpt: excerpt(questions),
				unresolved: !dismissed,
				toolUseId: id,
				questionStatus: dismissed ? "dismissed" : "unanswered",
			});
			const candidate: AskCandidate = { entry, responseAnswers: null, dismissed };
			asks.set(id, candidate);
			refreshCandidate(candidate);
		}
		flushText();
	}

	return {
		entries,
		unresolvedQuestions: entries.filter((entry) => entry.kind === "question" && entry.unresolved),
	};
}

/** Apply the active author/type filter and normalized case-insensitive search. */
export function filterTranscriptEntries(
	entries: readonly TranscriptHistoryEntry[],
	filter: TranscriptHistoryFilter,
	query: string,
): TranscriptHistoryEntry[] {
	const needle = normalizeText(query).toLocaleLowerCase();
	return entries.filter((entry) => {
		if (filter !== "all" && entry.kind !== filter) return false;
		if (!needle) return true;
		const haystack = normalizeText(`${entry.authorLabel} ${entry.typeLabel} ${entry.excerpt}`).toLocaleLowerCase();
		return haystack.includes(needle);
	});
}

/** Select the nearest fully-above unresolved ask, otherwise the newest ask. */
export function selectUnansweredTarget(
	unresolved: readonly TranscriptHistoryEntry[],
	rects: ReadonlyMap<string, DOMRectLike>,
	viewportTop: number,
): TranscriptHistoryEntry | null {
	let nearest: TranscriptHistoryEntry | null = null;
	let nearestBottom = Number.NEGATIVE_INFINITY;
	for (const entry of unresolved) {
		const rect = rects.get(entry.targetId);
		if (!rect || !Number.isFinite(rect.bottom) || rect.bottom > viewportTop) continue;
		if (rect.bottom > nearestBottom
			|| (rect.bottom === nearestBottom && (!nearest || entry.ordinal > nearest.ordinal))) {
			nearest = entry;
			nearestBottom = rect.bottom;
		}
	}
	if (nearest) return nearest;
	let newest: TranscriptHistoryEntry | null = null;
	for (const entry of unresolved) {
		if (!newest || entry.ordinal > newest.ordinal) newest = entry;
	}
	return newest;
}
