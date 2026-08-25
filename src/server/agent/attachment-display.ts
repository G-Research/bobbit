/**
 * Safe, outward-only attachment presentation data.
 *
 * File bytes and extracted text deliberately do not belong here. They are model /
 * attachment-store data; this shape is only enough to restore transcript tiles.
 */
export interface AttachmentDisplayMetadata {
	id: string;
	type: "image" | "document";
	fileName: string;
	mimeType: string;
	size: number;
	/** Optional bounded image preview (base64 without a data URL prefix). */
	preview?: string;
}

const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_CHARS = Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_MIME = /^[\x20-\x7e]{1,255}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function safeFileName(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
	if (/[\0-\x1f\x7f]/.test(value)) return undefined;
	// A browser upload supplies a basename. Fail closed rather than persisting a
	// client-claimed host path in transcript presentation metadata.
	if (value.includes("/") || value.includes("\\")) return undefined;
	return value;
}

/** Validate and clone untrusted attachment presentation metadata. */
export function sanitizeAttachmentDisplayMetadata(value: unknown): AttachmentDisplayMetadata[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ATTACHMENTS) return undefined;
	const out: AttachmentDisplayMetadata[] = [];
	const ids = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		const raw = item as Record<string, unknown>;
		const fileName = safeFileName(raw.fileName);
		if (!SAFE_ID.test(String(raw.id ?? "")) || ids.has(raw.id as string)
			|| (raw.type !== "image" && raw.type !== "document")
			|| !fileName || typeof raw.mimeType !== "string" || !SAFE_MIME.test(raw.mimeType)
			|| !Number.isSafeInteger(raw.size) || (raw.size as number) < 0 || (raw.size as number) > MAX_FILE_BYTES) {
			return undefined;
		}
		if (raw.preview !== undefined && (typeof raw.preview !== "string"
			|| raw.preview.length > MAX_PREVIEW_CHARS || !BASE64.test(raw.preview))) return undefined;
		ids.add(raw.id as string);
		out.push({
			id: raw.id as string,
			type: raw.type,
			fileName,
			mimeType: raw.mimeType,
			size: raw.size as number,
			...(typeof raw.preview === "string" ? { preview: raw.preview } : {}),
		});
	}
	return out;
}
