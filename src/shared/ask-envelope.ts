/**
 * Shared envelope format for the non-blocking `ask_user_choices` flow.
 *
 * When the UI submits answers for a pending question, the server appends a
 * normal `role: "user"` message to the transcript whose text body is:
 *
 *     [ask_user_choices_response tool_use_id=<ID>]
 *     {"answers":[{"question":"...","selected":"...","other_text":null}, ...]}
 *
 * The marker line must appear at position 0 of the message text. The body
 * (from the newline onward) is a JSON object with an `answers` array.
 *
 * This module is the single source of truth for that format — shared by the
 * server (envelope construction + transcript scan) and the UI (renderer
 * filter + transcript lookup).
 */

export interface AskResponseAnswer {
	question: string;
	/** Single-select: option text the user picked; "Other" when free-text.
	 *  Multi-select: array of option texts (may include "Other"). */
	selected: string | string[];
	/** Free-text content when "Other" was picked, otherwise null. */
	other_text: string | null;
}

/** Regex that matches a well-formed envelope message text.
 *  Group 1 = tool_use_id; group 2 = JSON body (everything after the first newline). */
export const ASK_ENVELOPE_REGEX =
	/^\[ask_user_choices_response tool_use_id=([A-Za-z0-9_-]+)\]\n([\s\S]+)$/;

/** Cheap prefix test — true for any text starting with the marker line (used by
 *  the transcript render-layer filter where we don't need to parse the body). */
export const ASK_ENVELOPE_PREFIX_REGEX =
	/^\[ask_user_choices_response tool_use_id=[A-Za-z0-9_-]+\]\n/;

/** Build an envelope message body from a tool_use_id and answers. */
export function buildAskResponseEnvelope(
	toolUseId: string,
	answers: AskResponseAnswer[],
): string {
	return `[ask_user_choices_response tool_use_id=${toolUseId}]\n${JSON.stringify({ answers })}`;
}

export interface ParsedAskEnvelope {
	toolUseId: string;
	answers: AskResponseAnswer[];
}

/** Parse envelope text. Returns null if the text does not conform (bad marker,
 *  bad charset, missing newline, non-JSON body, or body missing `answers`). */
export function parseAskResponseEnvelope(text: string): ParsedAskEnvelope | null {
	if (typeof text !== "string") return null;
	const m = ASK_ENVELOPE_REGEX.exec(text);
	if (!m) return null;
	const toolUseId = m[1];
	const body = m[2];
	let parsed: any;
	try { parsed = JSON.parse(body); } catch { return null; }
	if (!parsed || typeof parsed !== "object") return null;
	const answers = parsed.answers;
	if (!Array.isArray(answers)) return null;
	for (const a of answers) {
		if (!a || typeof a !== "object") return null;
		if (typeof a.question !== "string") return null;
		if (typeof a.selected !== "string" && !Array.isArray(a.selected)) return null;
		if (a.other_text !== null && typeof a.other_text !== "string") return null;
	}
	return { toolUseId, answers: answers as AskResponseAnswer[] };
}

/** Extract the plain-text of a transcript message as a single string.
 *  Handles both string content and `[{type:"text", text:"..."}]` arrays. */
function extractMessageText(msg: any): string {
	if (!msg) return "";
	const c = msg.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		const first = c.find((b: any) => b && b.type === "text" && typeof b.text === "string");
		if (first) return first.text as string;
	}
	return "";
}

/** True iff `msg` is a user transcript message whose text is an envelope. */
export function isAskResponseEnvelope(msg: any): boolean {
	if (!msg) return false;
	if (msg.role !== "user" && msg.role !== "user-with-attachments") return false;
	const text = extractMessageText(msg);
	return ASK_ENVELOPE_PREFIX_REGEX.test(text);
}

/**
 * Scan a transcript message list for an envelope matching the given tool_use_id.
 * Returns the parsed answers array, or null if not found.
 *
 * Defensive: only considers messages that appear *after* the corresponding
 * `tool_use` block (if found). If no tool_use with the given id appears in the
 * transcript at all, returns null (envelope without a cause is ignored).
 */
export function findAskResponseAnswers(
	messages: any[] | undefined | null,
	toolUseId: string,
): AskResponseAnswer[] | null {
	if (!Array.isArray(messages) || !toolUseId) return null;
	// Locate the assistant tool_use index first (defensive — otherwise reject).
	let toolUseIdx = -1;
	for (let i = 0; i < messages.length; i++) {
		const m: any = messages[i];
		if (m?.role === "assistant" && Array.isArray(m.content)) {
			const hit = m.content.some(
				(b: any) => b && (b.type === "toolCall" || b.type === "tool_use")
					&& b.id === toolUseId && b.name === "ask_user_choices",
			);
			if (hit) { toolUseIdx = i; break; }
		}
	}
	if (toolUseIdx === -1) return null;
	for (let i = toolUseIdx + 1; i < messages.length; i++) {
		const m: any = messages[i];
		if (m?.role !== "user" && m?.role !== "user-with-attachments") continue;
		const text = extractMessageText(m);
		const parsed = parseAskResponseEnvelope(text);
		if (parsed && parsed.toolUseId === toolUseId) return parsed.answers;
	}
	return null;
}
