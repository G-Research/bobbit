// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { loadAttachment } from "../../src/ui/utils/attachment-utils.ts";

const BINARY_LOOKING_BYTES = Uint8Array.from([0x66, 0x6f, 0x6f, 0x00, 0x01]);
const EXPECTED_BASE64 = "Zm9vAAE=";

const cases = [
	{ label: ".txt extension", name: "declared-text.txt", type: "application/octet-stream" },
	{ label: "text/plain MIME", name: "declared-text.bin", type: "text/plain" },
] as const;

describe("binary-looking files declared as text", () => {
	for (const testCase of cases) {
		it(`keeps ${testCase.label} bytes exact as a document without extractedText`, async () => {
			const file = new File([BINARY_LOOKING_BYTES], testCase.name, { type: testCase.type });
			const attachment = await loadAttachment(file);

			expect(
				attachment,
				`ATTACHMENT_BINARY_RETENTION_FAILED: ${testCase.label} input must remain byte-exact as a document attachment`,
			).toMatchObject({
				type: "document",
				fileName: testCase.name,
				size: BINARY_LOOKING_BYTES.byteLength,
				content: EXPECTED_BASE64,
			});
			expect(
				attachment.extractedText,
				`ATTACHMENT_BINARY_TEXT_MISCLASSIFIED: ${testCase.label} with NUL/control bytes must not receive extractedText`,
			).toBeUndefined();
			expect(
				attachment.mimeType,
				`ATTACHMENT_BINARY_METADATA_CHANGED: ${testCase.label} input must retain its original MIME metadata`,
			).toBe(testCase.type);
		});
	}
});
