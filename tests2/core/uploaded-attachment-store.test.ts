import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	MAX_UPLOADED_ATTACHMENT_READ_BYTES,
	listUploadedAttachments,
	persistUploadedAttachmentOccurrence,
	purgeUploadedAttachments,
	readUploadedAttachmentRange,
	setUploadedAttachmentRootForTesting,
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

	it("reuses the immutable pointer for an idempotent occurrence and rejects mutation", async () => {
		const original = document("a", "same.bin", "application/octet-stream", Buffer.from("first"));
		const first = await persistUploadedAttachmentOccurrence(SESSION_A, "same-occurrence", [original]);
		const restored = await persistUploadedAttachmentOccurrence(SESSION_A, "same-occurrence", [{ ...original }]);
		expect(restored).toEqual(first);

		await expectCode(
			persistUploadedAttachmentOccurrence(SESSION_A, "same-occurrence", [
				document("a", "same.bin", "application/octet-stream", Buffer.from("second")),
			]),
			"UPLOADED_ATTACHMENT_OCCURRENCE_CONFLICT",
		);
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
