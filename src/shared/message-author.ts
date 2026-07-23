/** Bobbit-owned accountable author metadata for visible messages. */
export type MessageAuthorKind = "user" | "agent" | "system";

export interface MessageAuthor {
	kind: MessageAuthorKind;
	id: string;
	label: string;
}

/** Additive envelope used at Bobbit boundaries without changing Pi message roles. */
export type BobbitMessage<T extends object = Record<string, unknown>> = T & {
	author?: MessageAuthor;
};

export const MAX_MESSAGE_AUTHOR_ID_LENGTH = 256;
export const MAX_MESSAGE_AUTHOR_LABEL_LENGTH = 256;

export const LOCAL_USER_AUTHOR: MessageAuthor = Object.freeze({
	kind: "user",
	id: "user:local",
	label: "User",
});

/** Sanitize one identity component; author ids are metadata, never path names. */
export function sanitizeAuthorIdComponent(
	value: string,
	fallback = "unknown",
	maxLength = 64,
): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, Math.max(1, maxLength));
	if (normalized) return normalized;
	const safeFallback = fallback
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, Math.max(1, maxLength));
	return safeFallback || "unknown";
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
	return typeof value === "string"
		&& value.length <= maxLength
		&& value.trim().length > 0;
}

/** Validate untrusted author metadata before it crosses storage or wire boundaries. */
export function isMessageAuthor(value: unknown): value is MessageAuthor {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (candidate.kind === "user" || candidate.kind === "agent" || candidate.kind === "system")
		&& isBoundedNonEmptyString(candidate.id, MAX_MESSAGE_AUTHOR_ID_LENGTH)
		&& isBoundedNonEmptyString(candidate.label, MAX_MESSAGE_AUTHOR_LABEL_LENGTH);
}

/** Normalize a display label without changing the trusted metadata it came from. */
export function normalizeMessageAuthorLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.trim()
		.replace(/\s+/g, " ");
	return normalized || undefined;
}

/** Format the stable author-id portion intended for model-facing attribution. */
export function formatDisplayAuthorId(author: MessageAuthor): string | undefined {
	if (!isMessageAuthor(author) || author.kind === "system") return undefined;
	const remainder = author.id.replace(/^(?:user|staff|session):/, "");
	if (!remainder.trim()) return undefined;
	if (author.kind === "user") return remainder;
	// Avoid turning an unusable legacy id into the sanitizer's safe construction fallback.
	if (!/[a-z0-9]/i.test(remainder)) return undefined;
	return sanitizeAuthorIdComponent(remainder).slice(0, 6) || undefined;
}

export function isToolResultRole(role: unknown): boolean {
	return role === "toolResult" || role === "tool_result" || role === "tool";
}

export function isToolResultBlock(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const block = value as Record<string, unknown>;
	return block.type === "tool_result"
		|| block.type === "toolResult"
		|| isToolResultRole(block.role);
}

/** Provider histories may encode tool output as a user-role message of tool-result blocks. */
export function isToolResultOnlyMessage(message: unknown): boolean {
	if (!message || typeof message !== "object" || Array.isArray(message)) return false;
	const candidate = message as Record<string, unknown>;
	if (isToolResultRole(candidate.role)) return true;
	if (
		(candidate.role !== "user" && candidate.role !== "user-with-attachments")
		|| !Array.isArray(candidate.content)
	) return false;
	let foundToolResult = false;
	for (const block of candidate.content) {
		if (isToolResultBlock(block)) {
			foundToolResult = true;
			continue;
		}
		if (
			block
			&& typeof block === "object"
			&& !Array.isArray(block)
			&& (block as Record<string, unknown>).type === "text"
			&& typeof (block as Record<string, unknown>).text === "string"
			&& ((block as Record<string, unknown>).text as string).trim() === ""
		) continue;
		return false;
	}
	return foundToolResult;
}

export const isToolResultMessage = isToolResultOnlyMessage;

/** Return true only for visible prompts whose content has an accountable producer. */
export function isAccountablePromptMessage(message: unknown): boolean {
	if (!message || typeof message !== "object" || Array.isArray(message)) return false;
	const candidate = message as Record<string, unknown>;
	return (candidate.role === "user" || candidate.role === "user-with-attachments")
		&& !isToolResultOnlyMessage(candidate);
}
