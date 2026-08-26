// v2-native — pure bounded model context for immutable uploaded attachments.
import { describe, expect, it } from "vitest";
import {
	appendUploadedAttachmentContext,
	UPLOADED_ATTACHMENT_AGGREGATE_TOKEN_BUDGET,
	UPLOADED_ATTACHMENT_PER_FILE_TOKEN_BUDGET,
} from "../../src/shared/uploaded-attachment-context.js";

function document(overrides: Record<string, unknown> = {}) {
	return {
		type: "document",
		fileName: "notes.txt",
		mimeType: "text/plain",
		size: 12,
		pointer: "attachment:opaque-1",
		extractedText: "ATTACHED_MARKER",
		...overrides,
	};
}

describe("uploaded attachment model context", () => {
	it("exports explicit nonzero default excerpt budgets", () => {
		expect(UPLOADED_ATTACHMENT_PER_FILE_TOKEN_BUDGET).toBeGreaterThan(0);
		expect(UPLOADED_ATTACHMENT_AGGREGATE_TOKEN_BUDGET)
			.toBeGreaterThanOrEqual(UPLOADED_ATTACHMENT_PER_FILE_TOKEN_BUDGET);
	});

	it("adds extracted text, an opaque pointer, and escaped metadata", () => {
		const result = appendUploadedAttachmentContext("What is attached?", [document({
			fileName: 'notes & "todo" <today>.txt',
			mimeType: 'text/plain; note="unsafe"',
			pointer: "attachment:opaque&1",
		})]);

		expect(result).toContain("What is attached?");
		expect(result).toContain('filename="notes &amp; &quot;todo&quot; &lt;today&gt;.txt"');
		expect(result).toContain('mime-type="text/plain; note=&quot;unsafe&quot;"');
		expect(result).toContain('size-bytes="12"');
		expect(result).toContain('pointer="attachment:opaque&amp;1"');
		expect(result).toContain("ATTACHED_MARKER");
	});

	it("takes deterministic leading excerpts within per-file and aggregate budgets", () => {
		const result = appendUploadedAttachmentContext("Inspect", [
			document({ pointer: "attachment:first", extractedText: "abcdefghij" }),
			document({ pointer: "attachment:second", extractedText: "klmnopqrst" }),
			document({ pointer: "attachment:third", extractedText: "uvwxyz" }),
		], {
			perFileTokenBudget: 6,
			aggregateTokenBudget: 9,
		});

		expect(result).toContain("<leading-excerpt>\nabcdef\n</leading-excerpt>");
		expect(result).toContain("<leading-excerpt>\nklm\n</leading-excerpt>");
		expect(result).toContain("pointer=\"attachment:third\">\n<leading-excerpt>\n</leading-excerpt>");
		expect(result.match(/EXCERPT TRUNCATED/g)).toHaveLength(3);
		expect(result).not.toContain("ghij");
		expect(result).not.toContain("nopqrst");
		expect(result).not.toContain("uvwxyz");
	});

	it("accounts for escaped markup and UTF-8 without splitting Unicode scalars", () => {
		const markup = appendUploadedAttachmentContext("", [document({ extractedText: "<&x" })], {
			perFileTokenBudget: 4,
			aggregateTokenBudget: 4,
		});
		expect(markup).toContain("<leading-excerpt>\n&lt;\n</leading-excerpt>");
		expect(markup).not.toContain("&amp;");

		const unicode = appendUploadedAttachmentContext("", [document({ extractedText: "😀a" })], {
			perFileTokenBudget: 4,
			aggregateTokenBudget: 4,
		});
		expect(unicode).toContain("<leading-excerpt>\n😀\n</leading-excerpt>");
		expect(unicode).not.toContain("😀a");
		expect(unicode).toContain("EXCERPT TRUNCATED");
	});

	it("marks truncation unambiguously and directs reads to the immutable pointer", () => {
		const result = appendUploadedAttachmentContext("Inspect", [document({
			pointer: "attachment:stable-snapshot",
			extractedText: "long document",
		})], {
			perFileTokenBudget: 4,
			aggregateTokenBudget: 4,
		});

		expect(result).toContain("long");
		expect(result).toContain("EXCERPT TRUNCATED");
		expect(result).toContain('Read the immutable attachment at pointer "attachment:stable-snapshot" for the remainder.');
	});

	it("identifies arbitrary binary files by pointer without injecting base64", () => {
		const result = appendUploadedAttachmentContext("Inspect this", [document({
			fileName: "archive.custom",
			mimeType: "application/octet-stream",
			size: 4,
			pointer: "attachment:binary-snapshot",
			extractedText: undefined,
			content: "AAECAw==",
		})]);

		expect(result).toContain('filename="archive.custom"');
		expect(result).toContain('pointer="attachment:binary-snapshot"');
		expect(result).toContain("Binary content is not embedded in the prompt");
		expect(result).toContain("Read the immutable attachment");
		expect(result).not.toContain("AAECAw==");
	});

	it("skips images and rejects malformed or non-opaque document inputs", () => {
		const malformed = [
			{ type: "image", fileName: "pic.png", pointer: "attachment:image" },
			null,
			"bad",
			document({ type: "other" }),
			document({ fileName: "" }),
			document({ fileName: "bad\nname.txt" }),
			document({ mimeType: 42 }),
			document({ size: -1 }),
			document({ size: 1.5 }),
			document({ pointer: "C:\\host\\secret.txt" }),
			document({ pointer: "attachment:has space" }),
			document({ extractedText: 42 }),
		];

		expect(appendUploadedAttachmentContext("hello", malformed)).toBe("hello");
		expect(appendUploadedAttachmentContext("hello", undefined)).toBe("hello");
	});

	it("does not add a truncation marker when the complete excerpt fits", () => {
		const result = appendUploadedAttachmentContext("hello", [document({ extractedText: "short" })], {
			perFileTokenBudget: 5,
			aggregateTokenBudget: 5,
		});

		expect(result).toContain("<leading-excerpt>\nshort\n</leading-excerpt>");
		expect(result).not.toContain("EXCERPT TRUNCATED");
	});
});
