import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertReviewPayloadReference,
	MAX_REVIEW_MARKDOWN_BYTES,
	persistReviewPayload,
	readReviewPayload,
	removeReviewPayloads,
	reviewPayloadReceipt,
	ReviewPayloadError,
	setReviewPayloadRootForTesting,
	sweepReviewPayloads,
} from "../../src/server/review-payload-store.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const otherSessionId = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];

async function isolatedRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "bobbit-review-payload-"));
	roots.push(root);
	setReviewPayloadRootForTesting(root);
	return root;
}

function upload(markdown: string, overrides: Record<string, unknown> = {}) {
	return {
		toolCallId: "tool-call-1",
		review: {
			reviewId: "review-1",
			title: "Review",
			files: [{ fileId: "file-1", title: "File", markdown }],
			activeFileId: "file-1",
			replace: true,
			...overrides,
		},
	};
}

afterEach(async () => {
	setReviewPayloadRootForTesting(undefined);
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable review payload store", () => {
	it("accepts exactly 10 MiB by UTF-8 bytes and rejects one byte over atomically", async () => {
		await isolatedRoot();
		const exact = "x".repeat(MAX_REVIEW_MARKDOWN_BYTES);
		const persisted = await persistReviewPayload(sessionId, upload(exact));
		expect(persisted.totalBytes).toBe(MAX_REVIEW_MARKDOWN_BYTES);
		expect((await readReviewPayload(sessionId, persisted.payloadId)).files[0].markdown).toBe(exact);

		await expect(persistReviewPayload(sessionId, upload(`${exact}x`))).rejects.toMatchObject({
			statusCode: 413,
			code: "REVIEW_PAYLOAD_TOO_LARGE",
		});
	});

	it("accounts for multibyte Markdown, preserves exact identity/order, and emits a payload-free receipt", async () => {
		await isolatedRoot();
		const body = {
			toolCallId: "call-multibyte",
			review: {
				reviewId: "review-multibyte",
				title: "Exact review",
				files: [
					{ fileId: "file-a", title: "A", markdown: "🙂" },
					{ fileId: "file-b", title: "B", markdown: "é\n" },
				],
				activeFileId: "file-b",
				replace: false,
			},
		};
		const persisted = await persistReviewPayload(sessionId, body);
		expect(persisted.totalBytes).toBe(Buffer.byteLength("🙂é\n", "utf8"));
		expect(persisted.files.map((file) => file.fileId)).toEqual(["file-a", "file-b"]);
		const receipt = reviewPayloadReceipt(persisted, { ok: true, status: "opened" });
		expect(receipt.files).toEqual([
			{ fileId: "file-a", title: "A", bytes: 4 },
			{ fileId: "file-b", title: "B", bytes: 3 },
		]);
		expect(JSON.stringify(receipt)).not.toContain("🙂");
		expect(JSON.stringify(receipt)).not.toContain("é");
	});

	it("rejects duplicate identities and mismatched references without changing an installed payload", async () => {
		await isolatedRoot();
		await expect(persistReviewPayload(sessionId, {
			toolCallId: "call",
			review: {
				reviewId: "review",
				title: "Review",
				files: [
					{ fileId: "same", title: "A", markdown: "a" },
					{ fileId: "same", title: "B", markdown: "b" },
				],
				activeFileId: "same",
				replace: true,
			},
		})).rejects.toMatchObject({ code: "REVIEW_PAYLOAD_INVALID" });

		const persisted = await persistReviewPayload(sessionId, upload("safe"));
		expect(() => assertReviewPayloadReference(persisted, { toolCallId: "wrong", reviewId: persisted.reviewId, hash: persisted.hash }))
			.toThrowError(ReviewPayloadError);
		expect((await readReviewPayload(sessionId, persisted.payloadId)).files[0].markdown).toBe("safe");
	});

	it("purges owner content and sweeps orphan sessions", async () => {
		await isolatedRoot();
		const owned = await persistReviewPayload(sessionId, upload("owned"));
		const orphan = await persistReviewPayload(otherSessionId, upload("orphan"));
		const sweep = await sweepReviewPayloads([sessionId]);
		expect(sweep.kept).toEqual([sessionId]);
		expect(sweep.removed).toEqual([otherSessionId]);
		await expect(readReviewPayload(otherSessionId, orphan.payloadId)).rejects.toMatchObject({ code: "REVIEW_PAYLOAD_NOT_FOUND" });
		await removeReviewPayloads(sessionId);
		await expect(readReviewPayload(sessionId, owned.payloadId)).rejects.toMatchObject({ code: "REVIEW_PAYLOAD_NOT_FOUND" });
	});
});
