import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { AskResponseAnswer } from "../../shared/ask-envelope.js";

export interface AskUserChoicesState {
	posted: boolean;
	answers: AskResponseAnswer[] | null;
	failed: boolean;
	unresolved: boolean;
}

/** Read all text blocks from a tool result using Pi's current result shape. */
function resultText(result: ToolResultMessage | undefined): string {
	if (!result || !Array.isArray(result.content)) return "";
	return result.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n");
}

function parseResultObject(result: ToolResultMessage | undefined): Record<string, unknown> | null {
	if (!result || result.isError) return null;
	const text = resultText(result);
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

function isAnswer(value: unknown): value is AskResponseAnswer {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const answer = value as Record<string, unknown>;
	return typeof answer.question === "string"
		&& (typeof answer.selected === "string"
			|| (Array.isArray(answer.selected)
				&& answer.selected.every((selection) => typeof selection === "string")))
		&& (answer.other_text === null || typeof answer.other_text === "string");
}

/** Legacy blocking-tool answers retained for transcripts created before the posted-stub flow. */
function legacyAnswers(result: ToolResultMessage | undefined): AskResponseAnswer[] | null {
	const parsed = parseResultObject(result);
	if (!parsed || !Array.isArray(parsed.answers) || !parsed.answers.every(isAnswer)) return null;
	return parsed.answers as AskResponseAnswer[];
}

/**
 * Classify the transcript-backed lifecycle of one ask call.
 *
 * A missing result is still pending. A completed non-stub result without legacy
 * answers is terminal failure even when an extension omitted `isError`.
 */
export function classifyAskUserChoicesState(
	result: ToolResultMessage | undefined,
	responseAnswers: AskResponseAnswer[] | null,
): AskUserChoicesState {
	const parsed = parseResultObject(result);
	const posted = parsed?.status === "posted";
	const legacy = posted ? null : legacyAnswers(result);
	const answers = responseAnswers ?? legacy;
	const failed = Boolean(result?.isError)
		|| (Boolean(result) && !posted && !legacy);
	return {
		posted,
		answers,
		failed,
		unresolved: !answers && !failed,
	};
}
