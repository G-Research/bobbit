import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_helpers/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// v2-native — arbitrary file selection and text detection for composer uploads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageEditor } from "../../src/ui/components/MessageEditor.js";
import { loadAttachment } from "../../src/ui/utils/attachment-utils.js";

if (!customElements.get("message-editor")) customElements.define("message-editor", MessageEditor);

afterEach(() => { document.body.innerHTML = ""; });
beforeEach(() => { document.body.innerHTML = ""; });

const SAFE_ATTACHMENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function expectSafeAttachmentId(id: string): void {
	expect(id).toMatch(SAFE_ATTACHMENT_ID);
}

describe("composer file attachments", () => {
	it("leaves the native picker unrestricted by default but honors a host restriction", async () => {
		const editor = document.createElement("message-editor") as MessageEditor;
		document.body.appendChild(editor);
		await editor.updateComplete;

		const input = editor.querySelector('input[type="file"]') as HTMLInputElement;
		expect(input.accept).toBe("");

		editor.acceptedTypes = ".txt,application/json";
		await editor.updateComplete;
		expect(input.accept).toBe(".txt,application/json");
	});

	it("keeps a special filename exact while minting a safe opaque ID", async () => {
		const fileName = "notes with spaces & unicode-©.custom";
		const file = new File(["UNKNOWN_EXTENSION_MARKER ©"], fileName, { type: "" });
		const attachment = await loadAttachment(file);

		expect(attachment.type).toBe("document");
		expect(attachment.fileName).toBe(fileName);
		expect(attachment.mimeType).toBe("text/plain");
		expect(attachment.content).toBe("VU5LTk9XTl9FWFRFTlNJT05fTUFSS0VSIMKp");
		expect(attachment.extractedText).toBe("UNKNOWN_EXTENSION_MARKER ©");
		expectSafeAttachmentId(attachment.id);
		expect(attachment.id).not.toContain(fileName);
	});

	it("uses readable UTF-8 bytes instead of a misleading binary MIME type", async () => {
		const file = new File(["MIME_IS_ONLY_A_HINT"], "notes.opaque", { type: "application/x-custom" });
		const attachment = await loadAttachment(file);

		expect(attachment.type).toBe("document");
		expect(attachment.content).toBe("TUlNRV9JU19PTkxZX0FfSElOVA==");
		expect(attachment.extractedText).toBe("MIME_IS_ONLY_A_HINT");
		expectSafeAttachmentId(attachment.id);
	});

	const malformedSpecialFiles = [
		{
			label: "PDF extension",
			name: "payload.pdf",
			mimeType: "application/x-fake-pdf",
		},
		{
			label: "DOCX MIME type",
			name: "payload.bin",
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		},
		{
			label: "PPTX extension",
			name: "payload.pptx",
			mimeType: "application/x-fake-presentation",
		},
	] as const;

	for (const testCase of malformedSpecialFiles) {
		it(`retains exact binary bytes when ${testCase.label} extraction fails`, async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				const bytes = new Uint8Array([0, 255, 1, 2]);
				const file = new File([bytes], testCase.name, { type: testCase.mimeType });
				const attachment = await loadAttachment(file);

				expect(attachment).toMatchObject({
					type: "document",
					fileName: testCase.name,
					mimeType: testCase.mimeType,
					size: bytes.byteLength,
					content: "AP8BAg==",
				});
				expect(attachment.extractedText).toBeUndefined();
				expect(attachment.preview).toBeUndefined();
				expectSafeAttachmentId(attachment.id);
			} finally {
				errorSpy.mockRestore();
			}
		});
	}

	it("preserves specialized extraction for a valid PPTX archive", async () => {
		const { default: JSZip } = await import("jszip");
		const zip = new JSZip();
		zip.file("ppt/slides/slide1.xml", "<p:sld><a:t>VALID_PPTX_MARKER</a:t></p:sld>");
		const archive = await zip.generateAsync({ type: "uint8array" });
		const bytes = new Uint8Array(archive.byteLength);
		bytes.set(archive);
		const attachment = await loadAttachment(
			new File([bytes.buffer], "valid.pptx", { type: "application/x-extension-match" }),
		);

		expect(attachment.mimeType).toBe(
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		);
		expect(attachment.extractedText).toContain("<slide number=\"1\">");
		expect(attachment.extractedText).toContain("VALID_PPTX_MARKER");
		expectSafeAttachmentId(attachment.id);
	});

	it("uses the same safe opaque ID path for images", async () => {
		const attachment = await loadAttachment(
			new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image with spaces & ©.png", { type: "image/png" }),
		);

		expect(attachment.type).toBe("image");
		expect(attachment.fileName).toBe("image with spaces & ©.png");
		expect(attachment.content).toBe("iVBORw==");
		expectSafeAttachmentId(attachment.id);
	});

	it("keeps arbitrary binary bytes instead of rejecting the file type", async () => {
		const file = new File([new Uint8Array([0, 255, 1, 2])], "data.custom", { type: "application/x-custom" });
		const attachment = await loadAttachment(file);

		expect(attachment.type).toBe("document");
		expect(attachment.mimeType).toBe("application/x-custom");
		expect(attachment.content).toBe("AP8BAg==");
		expect(attachment.extractedText).toBeUndefined();
		expectSafeAttachmentId(attachment.id);
	});
});
