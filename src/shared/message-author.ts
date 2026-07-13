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
