export const REVIEW_ARTIFACT_TOOL_CALL_ID_MAX_BYTES = 200;
export const REVIEW_ARTIFACT_REVIEW_ID_MAX_BYTES = 300;
export const REVIEW_ARTIFACT_FILE_ID_MAX_BYTES = 200;
export const REVIEW_ARTIFACT_PAYLOAD_ID_MAX_BYTES = 64;
export const REVIEW_ARTIFACT_TAB_PREFIX = "review:";
/** Every UTF-8 byte may occupy three URI-component characters (`%XX`). */
export const REVIEW_ARTIFACT_TAB_ID_MAX_LENGTH = REVIEW_ARTIFACT_TAB_PREFIX.length
	+ REVIEW_ARTIFACT_REVIEW_ID_MAX_BYTES * 3;

export type ReviewArtifactIdentityKind = "toolCallId" | "reviewId" | "fileId";

const MAX_BYTES_BY_KIND: Record<ReviewArtifactIdentityKind, number> = {
	toolCallId: REVIEW_ARTIFACT_TOOL_CALL_ID_MAX_BYTES,
	reviewId: REVIEW_ARTIFACT_REVIEW_ID_MAX_BYTES,
	fileId: REVIEW_ARTIFACT_FILE_ID_MAX_BYTES,
};

const textEncoder = new TextEncoder();

function isWellFormedUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

/**
 * Exact v2 artifact identity contract. Legacy review identities deliberately do
 * not use this validator because their historical normalization is lossy.
 */
export function isReviewArtifactIdentity(value: unknown, kind: ReviewArtifactIdentityKind): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	if (/[\u0000-\u001f\u007f]/.test(value) || !isWellFormedUnicode(value)) return false;
	return textEncoder.encode(value).byteLength <= MAX_BYTES_BY_KIND[kind];
}

export function isReviewArtifactPayloadId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0
		&& value === value.trim()
		&& !/[\u0000-\u001f\u007f]/.test(value)
		&& isWellFormedUnicode(value)
		&& textEncoder.encode(value).byteLength <= REVIEW_ARTIFACT_PAYLOAD_ID_MAX_BYTES;
}

/** Build the exact encoded workspace identity, or fail without truncation. */
export function reviewArtifactTabId(reviewId: unknown): string | null {
	if (!isReviewArtifactIdentity(reviewId, "reviewId")) return null;
	const id = `${REVIEW_ARTIFACT_TAB_PREFIX}${encodeURIComponent(reviewId)}`;
	return id.length <= REVIEW_ARTIFACT_TAB_ID_MAX_LENGTH ? id : null;
}
