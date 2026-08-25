import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import JSZip from "jszip";
import { MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES } from "../../src/server/agent/uploaded-specialized-document-extractor.js";
import {
	MAX_UPLOADED_ATTACHMENT_READ_BYTES,
	listUploadedAttachments,
	persistUploadedAttachmentOccurrence,
	purgeUploadedAttachments,
	readUploadedAttachmentRange,
	resetUploadedAttachmentUsageForTesting,
	setUploadedAttachmentRootForTesting,
	setUploadedAttachmentSessionQuotaForTesting,
	setUploadedAttachmentStoreHooksForTesting,
	sweepUploadedAttachments,
} from "../../src/server/agent/uploaded-attachment-store.js";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

function document(id: string, fileName: string, mimeType: string, bytes: Buffer) {
	return {
		id,
		type: "document" as const,
		fileName,
		mimeType,
		size: bytes.length,
		content: bytes.toString("base64"),
	};
}

async function ooxml(entries: Record<string, string>): Promise<Buffer> {
	const zip = new JSZip();
	for (const [name, content] of Object.entries(entries)) zip.file(name, content);
	return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function minimalPdf(text: string): Buffer {
	const objects: Array<string | undefined> = [
		undefined,
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		undefined,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	objects[4] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
	let output = "%PDF-1.4\n";
	const offsets = [0];
	for (let index = 1; index < objects.length; index++) {
		offsets[index] = Buffer.byteLength(output);
		output += `${index} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xrefOffset = Buffer.byteLength(output);
	output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let index = 1; index < objects.length; index++) output += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
	output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(output);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	await expect(promise).rejects.toMatchObject({ code });
}

describe("immutable uploaded attachment store", () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-uploaded-attachments-"));
		setUploadedAttachmentRootForTesting(root);
	});

	afterEach(() => {
		setUploadedAttachmentRootForTesting(undefined);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("persists exact immutable bytes and serves capped byte-exact ranges", async () => {
		const bytes = Buffer.from([0x00, 0xff, 0x10, 0x41, 0x42, 0x43]);
		const saved = await persistUploadedAttachmentOccurrence(SESSION_A, "occurrence-one", [
			document("client-id", "opaque.weird", "application/x-custom", bytes),
		]);
		const pointer = saved.attachments[0].pointer;
		expect(pointer).toMatch(/^bobbit-attachment:v1:/);
		expect(pointer).not.toContain(SESSION_A);
		expect(pointer).not.toContain("occurrence-one");

		const metadata = await listUploadedAttachments(SESSION_A, pointer);
		expect(metadata).toEqual([expect.objectContaining({
			pointer,
			fileName: "opaque.weird",
			mimeType: "application/x-custom",
			size: bytes.length,
		})]);
		expect(JSON.stringify(metadata)).not.toContain(root);
		expect(Object.keys(metadata[0]).sort()).toEqual(["fileName", "mimeType", "pointer", "sha256", "size"]);

		const first = await readUploadedAttachmentRange({ sessionId: SESSION_A, pointer, offset: 1, length: 3 });
		expect(first).toMatchObject({
			offset: 1,
			length: 3,
			bytesRead: 3,
			nextOffset: 4,
			eof: false,
			encoding: "base64",
		});
		expect(Buffer.from(first.data, "base64")).toEqual(bytes.subarray(1, 4));

		const tail = await readUploadedAttachmentRange({ sessionId: SESSION_A, pointer, offset: 4, length: 20 });
		expect(Buffer.from(tail.data, "base64")).toEqual(bytes.subarray(4));
		expect(tail).toMatchObject({ bytesRead: 2, nextOffset: 6, eof: true });
	});

	it("derives trusted text from exact bytes and reuses it with the immutable pointer", async () => {
		const original = {
			...document("a", "same.unknown", "application/octet-stream", Buffer.from("trusted bytes")),
			extractedText: "FORGED CLIENT TEXT",
		};
		const first = await persistUploadedAttachmentOccurrence(SESSION_A, "same-occurrence", [original]);
		const restored = await persistUploadedAttachmentOccurrence(SESSION_A, "same-occurrence", [{ ...original }]);
		expect(restored).toEqual(first);
		expect(first.attachments[0].trustedExtractedText).toBe("trusted bytes");
		expect(JSON.stringify(first)).not.toContain("FORGED CLIENT TEXT");

		const listed = await listUploadedAttachments(SESSION_A, first.attachments[0].pointer);
		expect(listed[0]).not.toHaveProperty("trustedExtractedText");

		await expectCode(
			persistUploadedAttachmentOccurrence(SESSION_A, "same-occurrence", [
				document("a", "same.bin", "application/octet-stream", Buffer.from("second")),
			]),
			"UPLOADED_ATTACHMENT_OCCURRENCE_CONFLICT",
		);
	});

	it("derives bounded PDF, DOCX, and PPTX text from immutable bytes and stores it for idempotent admission", async () => {
		const pdf = minimalPdf("SERVER_PDF_MARKER");
		const docx = await ooxml({
			"word/document.xml": "<w:document xmlns:w=\"urn:w\"><w:body><w:p><w:r><w:t>SERVER_DOCX_MARKER</w:t></w:r></w:p></w:body></w:document>",
		});
		const pptx = await ooxml({
			"ppt/slides/slide1.xml": "<p:sld xmlns:p=\"urn:p\" xmlns:a=\"urn:a\"><a:t>SERVER_PPTX_MARKER</a:t></p:sld>",
		});
		const originals = [
			{ ...document("pdf", "marker.pdf", "application/pdf", pdf), extractedText: "FORGED PDF" },
			{ ...document("docx", "marker.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx), extractedText: "FORGED DOCX" },
			{ ...document("pptx", "marker.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", pptx), extractedText: "FORGED PPTX" },
		];
		const first = await persistUploadedAttachmentOccurrence(SESSION_A, "specialized", originals);
		const restored = await persistUploadedAttachmentOccurrence(SESSION_A, "specialized", originals.map((item) => ({
			...item,
			extractedText: "DIFFERENT FORGED RETRY TEXT",
		})));

		expect(restored).toEqual(first);
		expect(first.attachments.map((item) => item.trustedExtractedText)).toEqual([
			expect.stringContaining("SERVER_PDF_MARKER"),
			expect.stringContaining("SERVER_DOCX_MARKER"),
			expect.stringContaining("SERVER_PPTX_MARKER"),
		]);
		expect(JSON.stringify(first)).not.toMatch(/FORGED/);
		for (const attachment of first.attachments) {
			const listed = await listUploadedAttachments(SESSION_A, attachment.pointer);
			expect(JSON.stringify(listed)).not.toMatch(/SERVER_(?:PDF|DOCX|PPTX)_MARKER/);
			expect(listed[0]).not.toHaveProperty("trustedExtractedText");
		}
	});

	it("bounds specialized output and rejects oversized OOXML entries to pointer-only", async () => {
		const boundedDocx = await ooxml({
			"word/document.xml": `<w:document xmlns:w="urn:w"><w:t>BOUNDED_MARKER_${"x".repeat(20_000)}</w:t></w:document>`,
		});
		const suspiciousDocx = await ooxml({
			"word/document.xml": `<w:document xmlns:w="urn:w"><w:t>${"z".repeat(1024 * 1024)}</w:t></w:document>`,
		});
		const saved = await persistUploadedAttachmentOccurrence(SESSION_A, "bounded-specialized", [
			document("bounded", "bounded.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", boundedDocx),
			document("suspicious", "suspicious.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", suspiciousDocx),
		]);
		expect(saved.attachments[0].trustedExtractedText).toContain("BOUNDED_MARKER");
		expect(Buffer.byteLength(saved.attachments[0].trustedExtractedText!, "utf8")).toBe(MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES);
		expect(saved.attachments[1]).not.toHaveProperty("trustedExtractedText");
	});

	it("keeps binary, malformed UTF-8, and malformed specialized documents pointer-only despite forged text", async () => {
		const inputs = [
			{ ...document("nul", "nul.bin", "text/plain", Buffer.from([0x41, 0x00, 0x42])), extractedText: "FORGED NUL" },
			{ ...document("utf8", "bad.custom", "text/plain", Buffer.from([0xc3, 0x28])), extractedText: "FORGED UTF8" },
			{ ...document("pdf", "claimed.pdf", "application/pdf", Buffer.from("ordinary UTF-8 bytes")), extractedText: "FORGED PDF" },
		];
		const saved = await persistUploadedAttachmentOccurrence(SESSION_A, "pointer-only", inputs);
		expect(saved.attachments).toHaveLength(3);
		for (const attachment of saved.attachments) expect(attachment).not.toHaveProperty("trustedExtractedText");
		expect(JSON.stringify(saved)).not.toMatch(/FORGED/);
	});

	it("rejects malformed, foreign-session, foreign-occurrence and invalid range access", async () => {
		const first = await persistUploadedAttachmentOccurrence(SESSION_A, "occ-a", [
			document("a", "a.dat", "application/octet-stream", Buffer.from("abcdef")),
		]);
		const second = await persistUploadedAttachmentOccurrence(SESSION_A, "occ-b", [
			document("b", "b.dat", "application/octet-stream", Buffer.from("uvwxyz")),
		]);
		const pointer = first.attachments[0].pointer;

		await expectCode(listUploadedAttachments(SESSION_B, pointer), "UPLOADED_ATTACHMENT_NOT_FOUND");
		await expectCode(listUploadedAttachments(SESSION_A, pointer, "occ-b"), "UPLOADED_ATTACHMENT_NOT_FOUND");
		await expectCode(listUploadedAttachments(SESSION_A, "../../host-secret"), "UPLOADED_ATTACHMENT_INVALID");
		await expectCode(readUploadedAttachmentRange({ sessionId: SESSION_A, pointer, expectedOccurrenceId: "occ-b" }), "UPLOADED_ATTACHMENT_NOT_FOUND");
		await expectCode(readUploadedAttachmentRange({ sessionId: SESSION_A, pointer, offset: -1, length: 1 }), "UPLOADED_ATTACHMENT_INVALID");
		await expectCode(readUploadedAttachmentRange({ sessionId: SESSION_A, pointer, offset: 7, length: 1 }), "UPLOADED_ATTACHMENT_RANGE_INVALID");
		await expectCode(readUploadedAttachmentRange({ sessionId: SESSION_A, pointer, length: MAX_UPLOADED_ATTACHMENT_READ_BYTES + 1 }), "UPLOADED_ATTACHMENT_INVALID");

		expect(second.attachments[0].pointer).not.toBe(pointer);
		const firstParts = pointer.split(":");
		const secondParts = second.attachments[0].pointer.split(":");
		const crossOccurrencePointer = [...firstParts.slice(0, -1), secondParts.at(-1)!].join(":");
		await expectCode(readUploadedAttachmentRange({ sessionId: SESSION_A, pointer: crossOccurrencePointer }), "UPLOADED_ATTACHMENT_NOT_FOUND");
	});

	it("validates exact attachment shapes and byte counts before writing", async () => {
		await expectCode(persistUploadedAttachmentOccurrence(SESSION_A, "bad", [{
			...document("a", "a.bin", "application/octet-stream", Buffer.from("abc")),
			size: 2,
		}]), "UPLOADED_ATTACHMENT_INVALID");
		await expectCode(persistUploadedAttachmentOccurrence(SESSION_A, "bad", [{
			...document("a", "a.bin", "application/octet-stream", Buffer.from("abc")),
			content: "not base64",
		}]), "UPLOADED_ATTACHMENT_INVALID");
		await expectCode(persistUploadedAttachmentOccurrence(SESSION_A, "bad", [{
			...document("a", "../not-a-path", "application/octet-stream", Buffer.from("abc")),
			unexpected: true,
		}]), "UPLOADED_ATTACHMENT_INVALID");
		await expectCode(persistUploadedAttachmentOccurrence(SESSION_A, "bad", [{
			...document("a", "a.pdf", "application/pdf", Buffer.from("abc")),
			preview: "AB==",
		}]), "UPLOADED_ATTACHMENT_INVALID");
		expect(fs.readdirSync(root)).toEqual([]);
	});

	it("rejects document preview bytes before writes when their occurrence exceeds quota", async () => {
		setUploadedAttachmentSessionQuotaForTesting(1);
		await expectCode(persistUploadedAttachmentOccurrence(SESSION_A, "preview-quota-no-side-effect", [{
			...document("preview", "preview.pdf", "application/pdf", Buffer.from("x")),
			preview: Buffer.from("two preview bytes").toString("base64"),
		}]), "UPLOADED_ATTACHMENT_QUOTA_EXCEEDED");
		expect(fs.readdirSync(root)).toEqual([]);
	});

	it("charges preview bytes after accounting rebuild and preserves admitted PDF display data", async () => {
		const preview = Buffer.from("png!");
		const accepted = {
			...document("pdf", "preview.pdf", "application/pdf", Buffer.from("x")),
			preview: preview.toString("base64"),
		};
		setUploadedAttachmentSessionQuotaForTesting(accepted.size + preview.length);
		const saved = await persistUploadedAttachmentOccurrence(SESSION_A, "preview-before-restart", [accepted]);
		expect(saved.displayAttachments).toEqual([{
			id: accepted.id,
			type: "document",
			fileName: accepted.fileName,
			mimeType: accepted.mimeType,
			size: accepted.size,
			preview: accepted.preview,
		}]);

		resetUploadedAttachmentUsageForTesting();
		const swept = await sweepUploadedAttachments([SESSION_A]);
		expect(swept).toMatchObject({ removed: [], kept: [expect.stringMatching(/^[a-f0-9]{64}$/)] });
		await expectCode(persistUploadedAttachmentOccurrence(SESSION_A, "preview-after-restart", [
			document("blocked", "blocked.bin", "application/octet-stream", Buffer.from("x")),
		]), "UPLOADED_ATTACHMENT_QUOTA_EXCEEDED");
	});

	it("binds exact canonical preview identity into idempotent occurrence admission", async () => {
		const original = {
			...document("pdf", "same.pdf", "application/pdf", Buffer.from("x")),
			preview: Buffer.from("first preview").toString("base64"),
		};
		const first = await persistUploadedAttachmentOccurrence(SESSION_A, "preview-idempotence", [original]);
		expect(await persistUploadedAttachmentOccurrence(SESSION_A, "preview-idempotence", [{ ...original }])).toEqual(first);
		await expectCode(persistUploadedAttachmentOccurrence(SESSION_A, "preview-idempotence", [{
			...original,
			preview: Buffer.from("other preview").toString("base64"),
		}]), "UPLOADED_ATTACHMENT_OCCURRENCE_CONFLICT");
	});

	it("enforces a cumulative per-session quota without charging idempotent retries", async () => {
		setUploadedAttachmentSessionQuotaForTesting(0);
		await expectCode(persistUploadedAttachmentOccurrence(SESSION_A, "quota-no-side-effect", [
			document("blocked", "blocked.bin", "application/octet-stream", Buffer.from("x")),
		]), "UPLOADED_ATTACHMENT_QUOTA_EXCEEDED");
		expect(fs.readdirSync(root)).toEqual([]);

		setUploadedAttachmentSessionQuotaForTesting(10);
		const sixBytes = document("six", "six.bin", "application/octet-stream", Buffer.from("123456"));
		const first = await persistUploadedAttachmentOccurrence(SESSION_A, "quota-first", [sixBytes]);
		expect(await persistUploadedAttachmentOccurrence(SESSION_A, "quota-first", [{ ...sixBytes }])).toEqual(first);
		await persistUploadedAttachmentOccurrence(SESSION_A, "quota-second", [
			document("four", "four.bin", "application/octet-stream", Buffer.from("7890")),
		]);

		await expectCode(persistUploadedAttachmentOccurrence(SESSION_A, "quota-rejected", [
			document("one", "one.bin", "application/octet-stream", Buffer.from("x")),
		]), "UPLOADED_ATTACHMENT_QUOTA_EXCEEDED");
		const readable = await readUploadedAttachmentRange({ sessionId: SESSION_A, pointer: first.attachments[0].pointer });
		expect(Buffer.from(readable.data, "base64").toString()).toBe("123456");
		expect((fs.readdirSync(root, { recursive: true }) as string[]).some((entry) => entry.includes(".tmp-"))).toBe(false);
	});

	it("serializes parallel admissions so committed bytes cannot exceed the quota", async () => {
		setUploadedAttachmentSessionQuotaForTesting(6);
		let releaseCommit!: () => void;
		let reachedCommit!: () => void;
		const atCommit = new Promise<void>((resolve) => { reachedCommit = resolve; });
		const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
		setUploadedAttachmentStoreHooksForTesting({
			beforeCommit: async () => {
				reachedCommit();
				await commitGate;
			},
		});

		const first = persistUploadedAttachmentOccurrence(SESSION_A, "parallel-a", [
			document("a", "a.bin", "application/octet-stream", Buffer.from("aaaa")),
		]);
		await atCommit;
		const second = persistUploadedAttachmentOccurrence(SESSION_A, "parallel-b", [
			document("b", "b.bin", "application/octet-stream", Buffer.from("bbbb")),
		]);
		releaseCommit();
		const outcomes = await Promise.allSettled([first, second]);
		setUploadedAttachmentStoreHooksForTesting(undefined);

		expect(outcomes[0].status).toBe("fulfilled");
		expect(outcomes[1]).toMatchObject({
			status: "rejected",
			reason: { statusCode: 413, code: "UPLOADED_ATTACHMENT_QUOTA_EXCEEDED", retryable: false },
		});
		const accepted = (outcomes[0] as PromiseFulfilledResult<Awaited<typeof first>>).value;
		const range = await readUploadedAttachmentRange({ sessionId: SESSION_A, pointer: accepted.attachments[0].pointer });
		expect(Buffer.from(range.data, "base64").toString()).toBe("aaaa");
		expect((fs.readdirSync(root, { recursive: true }) as string[]).some((entry) => entry.includes("parallel-b") || entry.includes(".tmp-"))).toBe(false);
	});

	it("releases failed writes and removes temporary data without consuming quota", async () => {
		setUploadedAttachmentSessionQuotaForTesting(4);
		setUploadedAttachmentStoreHooksForTesting({ beforeCommit: () => { throw new Error("injected commit failure"); } });
		await expectCode(persistUploadedAttachmentOccurrence(SESSION_A, "failed", [
			document("failed", "failed.bin", "application/octet-stream", Buffer.from("fail")),
		]), "UPLOADED_ATTACHMENT_PERSISTENCE_FAILED");
		expect((fs.readdirSync(root, { recursive: true }) as string[]).some((entry) => entry.includes(".tmp-"))).toBe(false);

		setUploadedAttachmentStoreHooksForTesting(undefined);
		const saved = await persistUploadedAttachmentOccurrence(SESSION_A, "after-failure", [
			document("saved", "saved.bin", "application/octet-stream", Buffer.from("pass")),
		]);
		const range = await readUploadedAttachmentRange({ sessionId: SESSION_A, pointer: saved.attachments[0].pointer });
		expect(Buffer.from(range.data, "base64").toString()).toBe("pass");
	});

	it("rebuilds quota accounting from committed manifests after restart", async () => {
		setUploadedAttachmentSessionQuotaForTesting(6);
		const saved = await persistUploadedAttachmentOccurrence(SESSION_A, "before-restart", [
			document("six", "six.bin", "application/octet-stream", Buffer.from("123456")),
		]);
		resetUploadedAttachmentUsageForTesting();
		setUploadedAttachmentSessionQuotaForTesting(5);
		const swept = await sweepUploadedAttachments([SESSION_A]);
		expect(swept).toMatchObject({ removed: [], kept: [expect.stringMatching(/^[a-f0-9]{64}$/)] });

		await expectCode(persistUploadedAttachmentOccurrence(SESSION_A, "after-restart", [
			document("one", "one.bin", "application/octet-stream", Buffer.from("x")),
		]), "UPLOADED_ATTACHMENT_QUOTA_EXCEEDED");
		const range = await readUploadedAttachmentRange({ sessionId: SESSION_A, pointer: saved.attachments[0].pointer });
		expect(Buffer.from(range.data, "base64").toString()).toBe("123456");
	});

	it("serializes purge with persistence and permanently fences recreation", async () => {
		let releaseCommit!: () => void;
		let reachedCommit!: () => void;
		const atCommit = new Promise<void>((resolve) => { reachedCommit = resolve; });
		const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
		setUploadedAttachmentStoreHooksForTesting({
			beforeCommit: async () => {
				reachedCommit();
				await commitGate;
			},
		});
		const persisting = persistUploadedAttachmentOccurrence(SESSION_A, "purge-race", [
			document("a", "a.bin", "application/octet-stream", Buffer.from("durable")),
		]);
		await atCommit;
		const purging = purgeUploadedAttachments(SESSION_A);
		releaseCommit();
		const saved = await persisting;
		await purging;
		setUploadedAttachmentStoreHooksForTesting(undefined);

		expect(fs.readdirSync(root)).toEqual([]);
		await expectCode(readUploadedAttachmentRange({ sessionId: SESSION_A, pointer: saved.attachments[0].pointer }), "UPLOADED_ATTACHMENT_NOT_FOUND");
		await expectCode(persistUploadedAttachmentOccurrence(SESSION_A, "after-purge", [
			document("b", "b.bin", "application/octet-stream", Buffer.from("new")),
		]), "UPLOADED_ATTACHMENT_NOT_FOUND");
		expect(fs.readdirSync(root)).toEqual([]);
	});

	it("survives a fresh store call and becomes stale after session cleanup", async () => {
		const saved = await persistUploadedAttachmentOccurrence(SESSION_A, "restart", [
			document("a", "restart.bin", "application/octet-stream", Buffer.from("durable")),
		]);
		const pointer = saved.attachments[0].pointer;
		const afterRestart = await readUploadedAttachmentRange({ sessionId: SESSION_A, pointer, offset: 0, length: 64 });
		expect(Buffer.from(afterRestart.data, "base64").toString()).toBe("durable");

		const byteFile = (fs.readdirSync(root, { recursive: true }) as string[])
			.map((entry) => path.join(root, entry))
			.find((entry) => entry.endsWith(".bin"));
		expect(byteFile).toBeTruthy();
		fs.unlinkSync(byteFile!);
		await expectCode(listUploadedAttachments(SESSION_A, pointer), "UPLOADED_ATTACHMENT_NOT_FOUND");

		await purgeUploadedAttachments(SESSION_A);
		await expectCode(readUploadedAttachmentRange({ sessionId: SESSION_A, pointer }), "UPLOADED_ATTACHMENT_NOT_FOUND");
	});
});
