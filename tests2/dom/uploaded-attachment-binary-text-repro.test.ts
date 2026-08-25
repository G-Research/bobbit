// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { loadAttachment } from "../../src/ui/utils/attachment-utils.ts";

const cases = [
	{
		label: ".txt extension with NUL bytes",
		name: "declared-text.txt",
		type: "application/octet-stream",
		bytes: Uint8Array.from([0x66, 0x6f, 0x6f, 0x00, 0x01]),
		expectedBase64: "Zm9vAAE=",
	},
	{
		label: "text/plain MIME with binary control density",
		name: "declared-text.bin",
		type: "text/plain",
		bytes: Uint8Array.from([0x66, 0x6f, 0x6f, 0x01]),
		expectedBase64: "Zm9vAQ==",
	},
	{
		label: "text/plain MIME with malformed UTF-8",
		name: "malformed.txt",
		type: "text/plain",
		bytes: Uint8Array.from([0xc3, 0x28]),
		expectedBase64: "wyg=",
	},
] as const;

describe("binary-looking files declared as text", () => {
	for (const testCase of cases) {
		it(`keeps ${testCase.label} exact as a document without extractedText`, async () => {
			const file = new File([testCase.bytes], testCase.name, { type: testCase.type });
			const attachment = await loadAttachment(file);

			expect(
				attachment,
				`ATTACHMENT_BINARY_RETENTION_FAILED: ${testCase.label} input must remain byte-exact as a document attachment`,
			).toMatchObject({
				type: "document",
				fileName: testCase.name,
				size: testCase.bytes.byteLength,
				content: testCase.expectedBase64,
			});
			expect(
				attachment.extractedText,
				`ATTACHMENT_BINARY_TEXT_MISCLASSIFIED: ${testCase.label} must not receive extractedText`,
			).toBeUndefined();
			expect(
				attachment.mimeType,
				`ATTACHMENT_BINARY_METADATA_CHANGED: ${testCase.label} input must retain its original MIME metadata`,
			).toBe(testCase.type);
		});
	}
});
