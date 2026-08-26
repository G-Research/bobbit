import { findAskResponseAnswers } from "../../shared/ask-envelope.js";
import type { UserQuestion } from "./ask-user-choices-validation.js";

export type AskQuestionTerminalState = "submitting" | "answered" | "dismissing" | "dismissed";

/**
 * Process-local linearization guard for answer-vs-dismiss races. Durable
 * transcript/session metadata rehydrates terminal outcomes after restart.
 */
export class AskQuestionTerminalGuard {
	private readonly states = new Map<string, AskQuestionTerminalState>();

	private key(sessionId: string, toolUseId: string): string {
		return JSON.stringify([sessionId, toolUseId]);
	}

	state(sessionId: string, toolUseId: string): AskQuestionTerminalState | undefined {
		return this.states.get(this.key(sessionId, toolUseId));
	}

	reserveSubmit(sessionId: string, toolUseId: string): { acquired: true } | { acquired: false; state: AskQuestionTerminalState } {
		return this.reserve(sessionId, toolUseId, "submitting");
	}

	reserveDismiss(sessionId: string, toolUseId: string): { acquired: true } | { acquired: false; state: AskQuestionTerminalState } {
		return this.reserve(sessionId, toolUseId, "dismissing");
	}

	private reserve(
		sessionId: string,
		toolUseId: string,
		state: "submitting" | "dismissing",
	): { acquired: true } | { acquired: false; state: AskQuestionTerminalState } {
		const key = this.key(sessionId, toolUseId);
		const existing = this.states.get(key);
		if (existing) return { acquired: false, state: existing };
		this.states.set(key, state);
		return { acquired: true };
	}

	completeSubmit(sessionId: string, toolUseId: string): boolean {
		return this.transition(sessionId, toolUseId, "submitting", "answered");
	}

	completeDismiss(sessionId: string, toolUseId: string): boolean {
		return this.transition(sessionId, toolUseId, "dismissing", "dismissed");
	}

	private transition(
		sessionId: string,
		toolUseId: string,
		expected: AskQuestionTerminalState,
		next: AskQuestionTerminalState,
	): boolean {
		const key = this.key(sessionId, toolUseId);
		if (this.states.get(key) !== expected) return false;
		this.states.set(key, next);
		return true;
	}

	rollbackSubmit(sessionId: string, toolUseId: string): boolean {
		return this.rollback(sessionId, toolUseId, "submitting");
	}

	rollbackDismiss(sessionId: string, toolUseId: string): boolean {
		return this.rollback(sessionId, toolUseId, "dismissing");
	}

	private rollback(sessionId: string, toolUseId: string, expected: AskQuestionTerminalState): boolean {
		const key = this.key(sessionId, toolUseId);
		if (this.states.get(key) !== expected) return false;
		return this.states.delete(key);
	}

	/** Seed a durable outcome without overriding an earlier in-flight winner. */
	observeAnswered(sessionId: string, toolUseId: string): AskQuestionTerminalState {
		return this.observeTerminal(sessionId, toolUseId, "answered");
	}

	observeDismissed(sessionId: string, toolUseId: string): AskQuestionTerminalState {
		return this.observeTerminal(sessionId, toolUseId, "dismissed");
	}

	private observeTerminal(
		sessionId: string,
		toolUseId: string,
		terminal: "answered" | "dismissed",
	): AskQuestionTerminalState {
		const key = this.key(sessionId, toolUseId);
		const existing = this.states.get(key);
		if (existing) return existing;
		this.states.set(key, terminal);
		return terminal;
	}
}

/** Normalize the durable ask-card dismissal list without changing opaque IDs. */
export function normalizeDismissedAskToolUseIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const id of value) {
		if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
		seen.add(id);
		normalized.push(id);
	}
	return normalized;
}

/** Locate the original ask call and return its question shape for validation. */
export function findAskUserChoicesQuestions(messages: unknown[], toolUseId: string): UserQuestion[] | null {
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const candidate = message as { role?: unknown; content?: unknown };
		if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) continue;
		for (const block of candidate.content) {
			if (!block || typeof block !== "object") continue;
			const toolUse = block as {
				type?: unknown;
				name?: unknown;
				id?: unknown;
				arguments?: unknown;
				input?: unknown;
			};
			if (toolUse.type !== "toolCall" && toolUse.type !== "tool_use") continue;
			if (toolUse.name !== "ask_user_choices" || toolUse.id !== toolUseId) continue;
			const args = toolUse.arguments ?? toolUse.input;
			if (!args || typeof args !== "object") return null;
			const questions = (args as { questions?: unknown }).questions;
			return Array.isArray(questions) ? questions as UserQuestion[] : null;
		}
	}
	return null;
}

function textResultObject(result: Record<string, unknown>): Record<string, unknown> | null {
	if (result.isError === true || result.is_error === true) return null;
	const rawContent = result.content;
	const text = typeof rawContent === "string"
		? rawContent
		: Array.isArray(rawContent)
			? rawContent
				.filter((block): block is { type: "text"; text: string } => !!block
					&& typeof block === "object"
					&& (block as { type?: unknown }).type === "text"
					&& typeof (block as { text?: unknown }).text === "string")
				.map(block => block.text)
				.join("\n")
			: "";
	if (!text) return null;
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}

function resultDisposition(result: Record<string, unknown>): "posted" | "resolved" | "failed" {
	if (result.isError === true || result.is_error === true) return "failed";
	const parsed = textResultObject(result);
	if (parsed?.status === "posted") return "posted";
	if (Array.isArray(parsed?.answers)) return "resolved";
	return "failed";
}

/** Return the exact ask ID only for a successful posted-stub tool result. */
export function successfulPostedAskToolUseId(message: unknown): string | null {
	if (!message || typeof message !== "object") return null;
	const result = message as Record<string, unknown>;
	if (result.role !== "toolResult" && result.role !== "tool_result" && result.role !== "tool") return null;
	if (result.toolName !== "ask_user_choices" || resultDisposition(result) !== "posted") return null;
	const id = result.toolCallId ?? result.tool_call_id ?? result.tool_use_id;
	const parsedId = textResultObject(result)?.tool_use_id;
	return typeof id === "string" && id.length > 0 && parsedId === id ? id : null;
}

/** Recompute whether any transcript ask remains neither answered, failed, nor dismissed. */
export function hasUnansweredAskUserChoices(
	messages: unknown[],
	dismissedToolUseIds: ReadonlySet<string>,
	resolvedToolUseIds: ReadonlySet<string> = new Set(),
): boolean {
	const asks = new Map<string, "pending" | "posted" | "resolved" | "failed">();
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const candidate = message as Record<string, unknown>;
		if (candidate.role === "assistant" && Array.isArray(candidate.content)) {
			for (const value of candidate.content) {
				if (!value || typeof value !== "object") continue;
				const block = value as Record<string, unknown>;
				if ((block.type === "toolCall" || block.type === "tool_use")
					&& block.name === "ask_user_choices" && typeof block.id === "string" && block.id.length > 0) {
					asks.set(block.id, "pending");
				}
			}
		}

		const role = candidate.role;
		if (role === "toolResult" || role === "tool_result" || role === "tool") {
			const id = candidate.toolCallId ?? candidate.tool_call_id ?? candidate.tool_use_id;
			if (typeof id === "string" && asks.has(id)) asks.set(id, resultDisposition(candidate));
		}
		if ((role === "user" || role === "user-with-attachments") && Array.isArray(candidate.content)) {
			for (const value of candidate.content) {
				if (!value || typeof value !== "object") continue;
				const block = value as Record<string, unknown>;
				if (block.type !== "tool_result" && block.type !== "toolResult") continue;
				const id = block.tool_use_id ?? block.toolCallId;
				if (typeof id === "string" && asks.has(id)) asks.set(id, resultDisposition(block));
			}
		}
	}

	for (const [id, disposition] of asks) {
		if (dismissedToolUseIds.has(id) || resolvedToolUseIds.has(id)) continue;
		if (findAskResponseAnswers(messages as any[], id)) continue;
		if (disposition === "pending" || disposition === "posted") return true;
	}
	return false;
}

/** One-time migration for sessions persisted before sidebar question state existed. */
export function backfillUnansweredAskState(
	persistedState: unknown,
	messages: unknown,
	dismissedToolUseIds: unknown,
): boolean | undefined {
	if (typeof persistedState === "boolean" || !Array.isArray(messages)) return undefined;
	return hasUnansweredAskUserChoices(
		messages,
		new Set(normalizeDismissedAskToolUseIds(dismissedToolUseIds)),
	);
}
