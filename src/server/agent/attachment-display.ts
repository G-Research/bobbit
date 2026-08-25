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
	/** Optional bounded document preview or projection-time hydrated image preview. */
	preview?: string;
}

export interface PromptImageInput {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ValidatedUploadedPromptAttachments {
	images?: PromptImageInput[];
	attachments?: AttachmentDisplayMetadata[];
	documents: unknown[];
}

export const MAX_PROMPT_ATTACHMENTS = 10;
export const MAX_PROMPT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 4 * Math.ceil(MAX_PROMPT_ATTACHMENT_BYTES / 3);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_MIME = /^[\x20-\x7e]{1,255}$/;
const SAFE_IMAGE_MIME = /^image\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** Decode canonical, bounded base64 without accepting alternate spellings. */
function decodeCanonicalBase64(value: unknown): Buffer | undefined {
	if (typeof value !== "string" || value.length > MAX_PREVIEW_CHARS
		|| value.length % 4 !== 0) return undefined;
	const bytes = Buffer.from(value, "base64");
	if (bytes.length > MAX_PROMPT_ATTACHMENT_BYTES || bytes.toString("base64") !== value) return undefined;
	return bytes;
}

/**
 * Decode an untrusted display preview only when it is canonical, bounded base64.
 * The attachment store reuses this exact validation before charging durable
 * document previews, while display sanitization applies it before sidecar IO.
 */
export function decodeAttachmentDisplayPreview(value: unknown): Buffer | undefined {
	return decodeCanonicalBase64(value);
}

function safeFileName(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
	if (/[\0-\x1f\x7f]/.test(value)) return undefined;
	// A browser upload supplies a basename. Fail closed rather than persisting a
	// client-claimed host path in transcript presentation metadata.
	if (value.includes("/") || value.includes("\\")) return undefined;
	return value;
}

/**
 * Validate and clone untrusted attachment presentation metadata. Image bytes
 * are deliberately discarded: Pi's image content block is their durable owner.
 * Document previews remain because the immutable document store charges them.
 */
export function sanitizeAttachmentDisplayMetadata(value: unknown): AttachmentDisplayMetadata[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROMPT_ATTACHMENTS) return undefined;
	const out: AttachmentDisplayMetadata[] = [];
	const ids = new Set<string>();
	for (const item of value) {
		if (!isPlainObject(item)) return undefined;
		const raw = item;
		const fileName = safeFileName(raw.fileName);
		if (!SAFE_ID.test(String(raw.id ?? "")) || ids.has(raw.id as string)
			|| (raw.type !== "image" && raw.type !== "document")
			|| !fileName || typeof raw.mimeType !== "string" || !SAFE_MIME.test(raw.mimeType)
			|| !Number.isSafeInteger(raw.size) || (raw.size as number) < 0 || (raw.size as number) > MAX_PROMPT_ATTACHMENT_BYTES) {
			return undefined;
		}
		if (raw.preview !== undefined && decodeAttachmentDisplayPreview(raw.preview) === undefined) return undefined;
		ids.add(raw.id as string);
		out.push({
			id: raw.id as string,
			type: raw.type,
			fileName,
			mimeType: raw.mimeType,
			size: raw.size as number,
			...(raw.type === "document" && typeof raw.preview === "string" ? { preview: raw.preview } : {}),
		});
	}
	return out;
}

/**
 * Pure authoritative validation for uploaded prompt images plus presentation
 * metadata. A browser image appears once in `images` and once in `attachments`;
 * correspondence is positional among image attachments so that representation
 * is counted once, while server-resolved image mentions may have no tile entry.
 */
export function validateUploadedPromptAttachments(
	imagesValue: unknown,
	attachmentsValue: unknown,
): ValidatedUploadedPromptAttachments | undefined {
	if (imagesValue !== undefined && !Array.isArray(imagesValue)) return undefined;
	if (attachmentsValue !== undefined && !Array.isArray(attachmentsValue)) return undefined;
	const rawImages = imagesValue as unknown[] | undefined;
	const rawAttachments = attachmentsValue as unknown[] | undefined;
	if ((rawImages?.length ?? 0) > MAX_PROMPT_ATTACHMENTS || (rawAttachments?.length ?? 0) > MAX_PROMPT_ATTACHMENTS) return undefined;

	const images: PromptImageInput[] = [];
	const imageBytes: Buffer[] = [];
	for (const candidate of rawImages ?? []) {
		if (!isPlainObject(candidate)
			|| Object.keys(candidate).some((key) => key !== "type" && key !== "data" && key !== "mimeType")
			|| candidate.type !== "image"
			|| typeof candidate.mimeType !== "string" || !SAFE_IMAGE_MIME.test(candidate.mimeType)) return undefined;
		const bytes = decodeCanonicalBase64(candidate.data);
		if (!bytes) return undefined;
		images.push({ type: "image", data: candidate.data as string, mimeType: candidate.mimeType });
		imageBytes.push(bytes);
	}

	let attachments: AttachmentDisplayMetadata[] | undefined;
	if (rawAttachments?.length) {
		attachments = sanitizeAttachmentDisplayMetadata(rawAttachments);
		if (!attachments) return undefined;
	}
	const documents: unknown[] = [];
	let presentedImageIndex = 0;
	for (let index = 0; index < (rawAttachments?.length ?? 0); index++) {
		const candidate = rawAttachments![index];
		if (!isPlainObject(candidate)) return undefined;
		if (candidate.type === "document") {
			documents.push(candidate);
			continue;
		}
		const allowed = new Set(["id", "type", "fileName", "mimeType", "size", "content", "preview"]);
		if (Object.keys(candidate).some((key) => !allowed.has(key))) return undefined;
		const image = images[presentedImageIndex];
		const bytes = imageBytes[presentedImageIndex];
		if (!image || !bytes
			|| candidate.mimeType !== image.mimeType
			|| candidate.content !== image.data
			|| (candidate.preview !== undefined && candidate.preview !== image.data)
			|| candidate.size !== bytes.length) return undefined;
		presentedImageIndex++;
	}
	if (presentedImageIndex !== (attachments?.filter((attachment) => attachment.type === "image").length ?? 0)) return undefined;
	if (images.length + documents.length > MAX_PROMPT_ATTACHMENTS) return undefined;

	return {
		...(images.length ? { images } : {}),
		...(attachments?.length ? { attachments } : {}),
		documents,
	};
}

/** Hydrate metadata-only image tiles from the corresponding Pi image blocks. */
export function hydrateAttachmentDisplayImages(
	attachments: AttachmentDisplayMetadata[],
	content: unknown,
): AttachmentDisplayMetadata[] {
	if (!Array.isArray(content) || !attachments.some((attachment) => attachment.type === "image")) return attachments;
	const imageBlocks = content.filter((block): block is Record<string, unknown> =>
		isPlainObject(block) && block.type === "image");
	let imageIndex = 0;
	return attachments.map((attachment) => {
		if (attachment.type !== "image") return attachment;
		const block = imageBlocks[imageIndex++];
		if (!block || block.mimeType !== attachment.mimeType) return attachment;
		const bytes = decodeCanonicalBase64(block.data);
		if (!bytes || bytes.length !== attachment.size) return attachment;
		return { ...attachment, preview: block.data as string };
	});
}
