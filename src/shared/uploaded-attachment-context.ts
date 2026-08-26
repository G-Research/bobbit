const TOKEN_BYTES = new TextEncoder();

/**
 * Excerpt budgets use a conservative, dependency-free token estimate: one
 * UTF-8 byte is one token unit. This deliberately overestimates ordinary text,
 * is deterministic in browsers and Node, and never splits a Unicode scalar.
 */
export const UPLOADED_ATTACHMENT_PER_FILE_TOKEN_BUDGET = 2_048;
export const UPLOADED_ATTACHMENT_AGGREGATE_TOKEN_BUDGET = 8_192;

const MAX_FILE_NAME_LENGTH = 1_024;
const MAX_MIME_TYPE_LENGTH = 255;
const MAX_POINTER_LENGTH = 512;
const ATTACHMENT_POINTER_PATTERN = /^attachment:[^\s\u0000-\u001f\u007f]+$/u;

export interface UploadedAttachmentContextInput {
	type?: unknown;
	fileName?: unknown;
	mimeType?: unknown;
	size?: unknown;
	pointer?: unknown;
	extractedText?: unknown;
}

export interface UploadedAttachmentContextOptions {
	perFileTokenBudget?: number;
	aggregateTokenBudget?: number;
}

interface ValidatedDocumentContext {
	fileName: string;
	mimeType: string;
	size: number;
	pointer: string;
	extractedText?: string;
}

function countTokenUnits(value: string): number {
	return TOKEN_BYTES.encode(value).byteLength;
}

function isSafeMetadata(value: unknown, maxLength: number): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= maxLength
		&& !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateDocument(candidate: unknown): ValidatedDocumentContext | undefined {
	if (!candidate || typeof candidate !== "object") return undefined;
	const attachment = candidate as UploadedAttachmentContextInput;
	if (attachment.type !== "document") return undefined;
	if (!isSafeMetadata(attachment.fileName, MAX_FILE_NAME_LENGTH)) return undefined;
	if (!isSafeMetadata(attachment.mimeType, MAX_MIME_TYPE_LENGTH)) return undefined;
	if (!Number.isSafeInteger(attachment.size) || (attachment.size as number) < 0) return undefined;
	if (!isSafeMetadata(attachment.pointer, MAX_POINTER_LENGTH)
		|| !ATTACHMENT_POINTER_PATTERN.test(attachment.pointer)) return undefined;
	if (attachment.extractedText !== undefined && typeof attachment.extractedText !== "string") return undefined;

	return {
		fileName: attachment.fileName,
		mimeType: attachment.mimeType,
		size: attachment.size as number,
		pointer: attachment.pointer,
		extractedText: attachment.extractedText,
	};
}

function escapeMarkup(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function normalizeBudget(value: number | undefined, fallback: number): number {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fallback;
}

/**
 * Return a leading, markup-escaped excerpt whose rendered value fits the
 * supplied token-unit budget. Iterating by code point prevents partial
 * surrogate pairs. Escaping before accounting prevents hostile markup from
 * inflating the emitted excerpt beyond its budget.
 */
function takeLeadingExcerpt(text: string, tokenBudget: number): {
	text: string;
	tokenUnits: number;
	truncated: boolean;
} {
	let escaped = "";
	let consumedCodeUnits = 0;
	let tokenUnits = 0;

	for (const codePoint of text) {
		const escapedCodePoint = escapeMarkup(codePoint);
		const nextUnits = countTokenUnits(escapedCodePoint);
		if (tokenUnits + nextUnits > tokenBudget) break;
		escaped += escapedCodePoint;
		tokenUnits += nextUnits;
		consumedCodeUnits += codePoint.length;
	}

	return {
		text: escaped,
		tokenUnits,
		truncated: consumedCodeUnits < text.length,
	};
}

/**
 * Add validated browser-uploaded document context to model-facing text.
 * Callers keep the original user text separately for transcript presentation.
 *
 * Documents must already have an immutable, session-scoped `attachment:`
 * pointer. Images are intentionally ignored because they travel through image
 * input. Binary content is represented only by safe metadata and its pointer.
 */
export function appendUploadedAttachmentContext(
	modelText: string,
	attachments: unknown,
	options: UploadedAttachmentContextOptions = {},
): string {
	if (!Array.isArray(attachments) || attachments.length === 0) return modelText;

	const perFileBudget = normalizeBudget(
		options.perFileTokenBudget,
		UPLOADED_ATTACHMENT_PER_FILE_TOKEN_BUDGET,
	);
	const aggregateBudget = normalizeBudget(
		options.aggregateTokenBudget,
		UPLOADED_ATTACHMENT_AGGREGATE_TOKEN_BUDGET,
	);
	let aggregateRemaining = aggregateBudget;
	const blocks: string[] = [];

	for (const candidate of attachments) {
		const attachment = validateDocument(candidate);
		if (!attachment) continue;

		const pointer = escapeMarkup(attachment.pointer);
		const attributes = [
			`filename="${escapeMarkup(attachment.fileName)}"`,
			`mime-type="${escapeMarkup(attachment.mimeType)}"`,
			`size-bytes="${attachment.size}"`,
			`pointer="${pointer}"`,
		].join(" ");

		if (attachment.extractedText === undefined) {
			blocks.push(
				`<user-attachment ${attributes}>\n`
				+ `Binary content is not embedded in the prompt. Read the immutable attachment at pointer "${pointer}".\n`
				+ "</user-attachment>",
			);
			continue;
		}

		const excerptBudget = Math.min(perFileBudget, aggregateRemaining);
		const excerpt = takeLeadingExcerpt(attachment.extractedText, excerptBudget);
		aggregateRemaining -= excerpt.tokenUnits;
		const lines = [`<user-attachment ${attributes}>`, "<leading-excerpt>"];
		if (excerpt.text) lines.push(excerpt.text);
		lines.push("</leading-excerpt>");
		if (excerpt.truncated) {
			lines.push(
				`[EXCERPT TRUNCATED: more content is available. Read the immutable attachment at pointer "${pointer}" for the remainder.]`,
			);
		}
		lines.push("</user-attachment>");
		blocks.push(lines.join("\n"));
	}

	if (blocks.length === 0) return modelText;
	return `${modelText}${modelText ? "\n\n" : ""}${blocks.join("\n\n")}`;
}
