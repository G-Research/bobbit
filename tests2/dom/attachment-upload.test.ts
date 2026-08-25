import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// v2-native — arbitrary file selection and text detection for composer uploads.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageEditor } from "../../src/ui/components/MessageEditor.js";
import { loadAttachment } from "../../src/ui/utils/attachment-utils.js";

if (!customElements.get("message-editor")) customElements.define("message-editor", MessageEditor);

afterEach(() => { document.body.innerHTML = ""; });
beforeEach(() => { document.body.innerHTML = ""; });

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

	it("extracts UTF-8 text even when the extension and MIME type are unknown", async () => {
		const file = new File(["UNKNOWN_EXTENSION_MARKER ©"], "notes.custom", { type: "" });
		const attachment = await loadAttachment(file);

		expect(attachment.type).toBe("document");
		expect(attachment.fileName).toBe("notes.custom");
		expect(attachment.mimeType).toBe("text/plain");
		expect(attachment.extractedText).toBe("UNKNOWN_EXTENSION_MARKER ©");
	});

	it("uses readable UTF-8 bytes instead of a misleading binary MIME type", async () => {
		const file = new File(["MIME_IS_ONLY_A_HINT"], "notes.opaque", { type: "application/x-custom" });
		const attachment = await loadAttachment(file);

		expect(attachment.type).toBe("document");
		expect(attachment.content).toBe("TUlNRV9JU19PTkxZX0FfSElOVA==");
		expect(attachment.extractedText).toBe("MIME_IS_ONLY_A_HINT");
	});

	it("keeps arbitrary binary bytes instead of rejecting the file type", async () => {
		const file = new File([new Uint8Array([0, 255, 1, 2])], "data.custom", { type: "application/x-custom" });
		const attachment = await loadAttachment(file);

		expect(attachment.type).toBe("document");
		expect(attachment.mimeType).toBe("application/x-custom");
		expect(attachment.content).toBe("AP8BAg==");
		expect(attachment.extractedText).toBeUndefined();
	});
});
