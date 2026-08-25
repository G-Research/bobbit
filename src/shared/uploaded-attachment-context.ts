export interface UploadedAttachmentContext {
	type?: unknown;
	fileName?: unknown;
	mimeType?: unknown;
	size?: unknown;
	extractedText?: unknown;
}

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Add browser-uploaded document context to the model-facing prompt while the
 * caller keeps the user's typed text as the visible transcript body.
 *
 * Images travel through the model's image input. Text-readable documents carry
 * their extracted text; arbitrary binary files still carry a manifest so the
 * agent can identify what the user attached without injecting base64 into the
 * context window.
 */
export function appendUploadedAttachmentContext(
	modelText: string,
	attachments: unknown,
): string {
	if (!Array.isArray(attachments) || attachments.length === 0) return modelText;

	const blocks: string[] = [];
	for (const candidate of attachments) {
		if (!candidate || typeof candidate !== "object") continue;
		const attachment = candidate as UploadedAttachmentContext;
		if (attachment.type === "image") continue;

		const fileName = typeof attachment.fileName === "string" && attachment.fileName
			? attachment.fileName
			: "unnamed";
		const mimeType = typeof attachment.mimeType === "string" && attachment.mimeType
			? attachment.mimeType
			: "application/octet-stream";
		const size = typeof attachment.size === "number" && Number.isFinite(attachment.size) && attachment.size >= 0
			? ` size="${attachment.size}"`
			: "";
		const attributes = `filename="${escapeAttribute(fileName)}" mime-type="${escapeAttribute(mimeType)}"${size}`;

		if (typeof attachment.extractedText === "string") {
			blocks.push(`<user-attachment ${attributes}>\n${attachment.extractedText}\n</user-attachment>`);
		} else {
			blocks.push(`<user-attachment ${attributes} content="binary; metadata only" />`);
		}
	}

	if (blocks.length === 0) return modelText;
	return `${modelText}${modelText ? "\n\n" : ""}${blocks.join("\n\n")}`;
}
