// v2-native — browser-uploaded document context delivered to the remote agent.
import { describe, expect, it } from "vitest";
import { appendUploadedAttachmentContext } from "../../src/shared/uploaded-attachment-context.js";

describe("uploaded attachment model context", () => {
	it("adds extracted text and escaped metadata for uploaded documents", () => {
		const result = appendUploadedAttachmentContext("What is attached?", [{
			type: "document",
			fileName: 'notes & "todo".txt',
			mimeType: "text/plain",
			size: 12,
			extractedText: "ATTACHED_MARKER",
		}]);

		expect(result).toContain("What is attached?");
		expect(result).toContain('filename="notes &amp; &quot;todo&quot;.txt"');
		expect(result).toContain('mime-type="text/plain" size="12"');
		expect(result).toContain("ATTACHED_MARKER");
	});

	it("identifies arbitrary binary files without injecting their base64", () => {
		const result = appendUploadedAttachmentContext("Inspect this", [{
			type: "document",
			fileName: "archive.custom",
			mimeType: "application/octet-stream",
			size: 4,
			content: "AAECAw==",
		}]);

		expect(result).toContain('filename="archive.custom"');
		expect(result).toContain('content="binary; metadata only"');
		expect(result).not.toContain("AAECAw==");
	});

	it("leaves prompts unchanged for images and malformed attachment values", () => {
		expect(appendUploadedAttachmentContext("hello", [
			{ type: "image", fileName: "pic.png" },
			null,
			"bad",
		])).toBe("hello");
		expect(appendUploadedAttachmentContext("hello", undefined)).toBe("hello");
	});
});
