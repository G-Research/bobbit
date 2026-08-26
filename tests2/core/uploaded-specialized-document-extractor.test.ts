import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
	deriveSpecializedDocumentText,
	MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES,
} from "../../src/server/agent/uploaded-specialized-document-extractor.js";
import {
	extractPdfTextInIsolate,
	MAX_CONCURRENT_PDF_EXTRACTIONS,
	type PdfExtractionChildOptions,
} from "../../src/server/agent/uploaded-pdf-extractor-isolate.js";

function pdfWithContentStream(stream: Buffer, compressed = false): Buffer {
	const objects: Array<Buffer | undefined> = [
		undefined,
		Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
		Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
		Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"),
		undefined,
		Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
	];
	const encoded = compressed ? deflateSync(stream, { level: 9 }) : stream;
	objects[4] = Buffer.concat([
		Buffer.from(`<< /Length ${encoded.length}${compressed ? " /Filter /FlateDecode" : ""} >>\nstream\n`),
		encoded,
		Buffer.from("\nendstream"),
	]);

	const parts = [Buffer.from("%PDF-1.4\n")];
	const offsets = [0];
	let length = parts[0].length;
	for (let index = 1; index < objects.length; index++) {
		offsets[index] = length;
		const object = Buffer.concat([Buffer.from(`${index} 0 obj\n`), objects[index]!, Buffer.from("\nendobj\n")]);
		parts.push(object);
		length += object.length;
	}
	const xrefOffset = length;
	let trailer = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let index = 1; index < objects.length; index++) trailer += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
	trailer += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	parts.push(Buffer.from(trailer));
	return Buffer.concat(parts);
}

function minimalPdf(text: string): Buffer {
	return pdfWithContentStream(Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`));
}

async function ooxml(entries: Record<string, string>): Promise<Uint8Array> {
	const zip = new JSZip();
	for (const [name, content] of Object.entries(entries)) zip.file(name, content);
	return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

class FakeChild extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	killCount = 0;
	kill(): boolean {
		this.killCount++;
		return true;
	}
	succeed(result: unknown): void {
		this.stdout.write(JSON.stringify(result));
		this.emit("close", 0, null);
	}
}

function fakeFactory(fake: FakeChild, inspect?: (options: PdfExtractionChildOptions) => void) {
	return (_source: string, options: PdfExtractionChildOptions) => {
		inspect?.(options);
		return fake;
	};
}

describe("uploaded specialized document extractor", () => {
	it("extracts valid PDF text in the bounded child isolate", async () => {
		const result = await deriveSpecializedDocumentText({
			fileName: "valid.pdf",
			mimeType: "application/pdf",
			bytes: minimalPdf("ISOLATED_PDF_MARKER"),
		});
		expect(result).toEqual({ recognized: true, text: expect.stringContaining("ISOLATED_PDF_MARKER") });
		expect(Buffer.byteLength(result.text!, "utf8")).toBeLessThanOrEqual(MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES);
	});

	it("returns pointer-only for malformed PDFs", async () => {
		await expect(deriveSpecializedDocumentText({
			fileName: "malformed.pdf",
			mimeType: "application/pdf",
			bytes: Buffer.from("%PDF-not-a-document"),
		})).resolves.toEqual({ recognized: true });
	});

	it("bounds a real high-expansion FlateDecode stream while the gateway event loop remains responsive", async () => {
		const expanded = `BT /F1 12 Tf 72 720 Td (${"EXPANSION_MARKER_".repeat(400_000)}) Tj ET`;
		const pdf = pdfWithContentStream(Buffer.from(expanded), true);
		expect(pdf.length).toBeLessThan(100_000);
		let heartbeat = false;
		const timer = setTimeout(() => { heartbeat = true; }, 0);
		const started = Date.now();
		const result = await deriveSpecializedDocumentText({ fileName: "expansion.pdf", mimeType: "application/pdf", bytes: pdf });
		clearTimeout(timer);
		expect(heartbeat).toBe(true);
		expect(Date.now() - started).toBeLessThan(6_500);
		expect(result.recognized).toBe(true);
		if (result.text !== undefined) {
			expect(result.text).toContain("EXPANSION_MARKER");
			expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES);
		}
	}, 10_000);

	it("rejects excess concurrent submissions immediately instead of queueing them", async () => {
		const children: FakeChild[] = [];
		const pending = Array.from({ length: MAX_CONCURRENT_PDF_EXTRACTIONS }, () => extractPdfTextInIsolate(Buffer.from("pdf"), {
			timeoutMs: 1_000,
			childFactory: (_source, options) => {
				expect(options).toEqual({
					args: ["--max-old-space-size=64", "--max-semi-space-size=8", "--stack-size=4096"],
					windowsHide: true,
				});
				const child = new FakeChild();
				children.push(child);
				return child;
			},
		}));
		expect(children).toHaveLength(MAX_CONCURRENT_PDF_EXTRACTIONS);
		const started = Date.now();
		await expect(extractPdfTextInIsolate(Buffer.from("not queued"), {
			childFactory: () => { throw new Error("must not spawn"); },
		})).resolves.toBeUndefined();
		expect(Date.now() - started).toBeLessThan(100);
		for (const child of children) child.succeed({ kind: "result", text: "done" });
		await expect(Promise.all(pending)).resolves.toEqual(children.map(() => "done"));
		expect(children.every((child) => child.killCount === 0)).toBe(true);
	});

	it("cleans up timeout, worker-error, and invalid-output paths", async () => {
		const timedOut = new FakeChild();
		await expect(extractPdfTextInIsolate(Buffer.from("timeout"), {
			timeoutMs: 20,
			childFactory: fakeFactory(timedOut),
		})).resolves.toBeUndefined();
		expect(timedOut.killCount).toBe(1);
		expect(timedOut.eventNames()).toEqual([]);
		expect(timedOut.stdin.listenerCount("error")).toBe(0);
		expect(timedOut.stdout.listenerCount("data")).toBe(0);
		expect(timedOut.stdout.listenerCount("error")).toBe(0);

		const errored = new FakeChild();
		const errorResult = extractPdfTextInIsolate(Buffer.from("error"), { childFactory: fakeFactory(errored) });
		errored.emit("error", new Error("child failed"));
		await expect(errorResult).resolves.toBeUndefined();
		expect(errored.killCount).toBe(1);
		expect(errored.eventNames()).toEqual([]);

		const oversized = new FakeChild();
		const oversizedResult = extractPdfTextInIsolate(Buffer.from("oversized"), { childFactory: fakeFactory(oversized) });
		oversized.stdout.write("x".repeat(MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES * 3));
		await expect(oversizedResult).resolves.toBeUndefined();
		expect(oversized.killCount).toBe(1);
		expect(oversized.eventNames()).toEqual([]);
	});

	it("preserves bounded DOCX and PPTX extraction", async () => {
		const docx = await ooxml({
			"word/document.xml": "<w:document xmlns:w=\"urn:w\"><w:t>DOCX_UNCHANGED_MARKER</w:t></w:document>",
		});
		const pptx = await ooxml({
			"ppt/slides/slide1.xml": "<p:sld xmlns:p=\"urn:p\" xmlns:a=\"urn:a\"><a:t>PPTX_UNCHANGED_MARKER</a:t></p:sld>",
		});
		await expect(deriveSpecializedDocumentText({ fileName: "a.docx", mimeType: "", bytes: docx }))
			.resolves.toEqual({ recognized: true, text: "DOCX_UNCHANGED_MARKER" });
		await expect(deriveSpecializedDocumentText({ fileName: "a.pptx", mimeType: "", bytes: pptx }))
			.resolves.toEqual({ recognized: true, text: "[Slide 1]\nPPTX_UNCHANGED_MARKER" });
	});
});
