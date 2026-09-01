import { guardProcessEnv } from "../../../tests/support/helpers/unit/env-guard.js";
guardProcessEnv();

import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewAnnotationStore } from "../../../src/server/review-annotation-store.js";
import {
	createReviewPayloadSessionCoordinator,
	readLimitedReviewJson,
} from "../../../src/server/review-payload-routes.js";
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
} from "../../../src/server/review-payload-store.js";
import { createMemFs } from "../../../tests/support/harnesses/shared/mem-fs.js";

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

	it("persists exact multibyte identity maxima and rejects +1 before creating an artifact", async () => {
		const root = await isolatedRoot();
		const reviewId = "界".repeat(100); // 300 bytes
		const toolCallId = `${"界".repeat(66)}é`; // 200 bytes
		const fileId = `${"🙂".repeat(49)}界x`; // 200 bytes
		const exact = {
			toolCallId,
			review: {
				reviewId,
				title: "Identity limits",
				files: [{ fileId, title: "Exact", markdown: "body" }],
				activeFileId: fileId,
				replace: false,
			},
		};
		const persisted = await persistReviewPayload(sessionId, exact);
		const restored = await readReviewPayload(sessionId, persisted.payloadId);
		expect(restored).toMatchObject({ toolCallId, reviewId, activeFileId: fileId });
		expect(restored.files[0].fileId).toBe(fileId);

		for (const invalid of [
			{ ...exact, toolCallId: `${toolCallId}x` },
			{ ...exact, review: { ...exact.review, reviewId: `${reviewId}x` } },
			{ ...exact, review: { ...exact.review, files: [{ ...exact.review.files[0], fileId: `${fileId}x` }], activeFileId: `${fileId}x` } },
		]) {
			await expect(persistReviewPayload(sessionId, invalid)).rejects.toMatchObject({ code: "REVIEW_PAYLOAD_INVALID" });
		}
		expect((await readdir(root)).filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
		expect((await readdir(join(root, sessionId))).filter((entry) => !entry.startsWith(".tmp-"))).toEqual([persisted.payloadId]);
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

	it("settles a chunked over-limit read before end and detaches its data consumer", async () => {
		const stream = new PassThrough();
		const request = stream as unknown as http.IncomingMessage;
		const result = readLimitedReviewJson(request, 4);
		stream.write("12345");

		await expect(result).resolves.toEqual({ ok: false, tooLarge: true });
		expect(stream.isPaused()).toBe(true);
		expect(stream.listenerCount("data")).toBe(0);
		stream.destroy();
	});

	it("serializes the full same-title replacement transaction while replace:false remains distinct", async () => {
		const operations = createReviewPayloadSessionCoordinator();
		let releaseFirst!: () => void;
		const barrier = new Promise<void>((resolveBarrier) => { releaseFirst = resolveBarrier; });
		const entered: string[] = [];
		const reviews: Array<{ reviewId: string; title: string; fileId: string }> = [];
		const replace = (incomingId: string, fileId: string, wait = false) => operations.run(sessionId, async () => {
			entered.push(incomingId);
			const prior = reviews.find((review) => review.title === "Same title");
			if (wait) await barrier;
			const reviewId = prior?.reviewId ?? incomingId;
			const next = { reviewId, title: "Same title", fileId };
			if (prior) reviews.splice(reviews.indexOf(prior), 1, next);
			else reviews.push(next);
			return next;
		});

		const first = replace("review-first", "file-first", true);
		const second = replace("review-second", "file-second");
		await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
		expect(entered).toEqual(["review-first"]);
		releaseFirst();
		expect(await Promise.all([first, second])).toEqual([
			{ reviewId: "review-first", title: "Same title", fileId: "file-first" },
			{ reviewId: "review-first", title: "Same title", fileId: "file-second" },
		]);
		expect(reviews).toEqual([{ reviewId: "review-first", title: "Same title", fileId: "file-second" }]);

		const distinct: string[] = [];
		await Promise.all([
			operations.run(sessionId, async () => { distinct.push("review-a"); }),
			operations.run(sessionId, async () => { distinct.push("review-b"); }),
		]);
		expect(distinct).toEqual(["review-a", "review-b"]);
	});

	it("admits concurrent payloads atomically against one shared session quota", async () => {
		const root = await isolatedRoot();
		const operations = createReviewPayloadSessionCoordinator();
		const quota = { maxCount: 1, maxBytes: 1024 * 1024 };
		const attempts = await Promise.allSettled([
			operations.run(sessionId, () => persistReviewPayload(sessionId, upload("first"), undefined, { enforceSessionQuota: true, quota })),
			operations.run(sessionId, () => persistReviewPayload(sessionId, upload("second"), undefined, { enforceSessionQuota: true, quota })),
		]);

		expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
		const rejected = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
		expect(rejected?.reason).toMatchObject({ statusCode: 507, code: "REVIEW_PAYLOAD_QUOTA_EXCEEDED", retryable: false });
		const ownerEntries = await readdir(join(root, sessionId));
		expect(ownerEntries).toHaveLength(1);
		expect(ownerEntries.some((entry) => entry.startsWith(".tmp-"))).toBe(false);
	});

	it("permanently fences a stalled owner before purge and removes accepted bytes after they drain", async () => {
		const root = await isolatedRoot();
		const operations = createReviewPayloadSessionCoordinator();
		let releaseUpload!: () => void;
		let markStarted!: () => void;
		const stalled = new Promise<void>((resolveUpload) => { releaseUpload = resolveUpload; });
		const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
		const accepted = operations.run(sessionId, async () => {
			markStarted();
			await stalled;
			return persistReviewPayload(sessionId, upload("accepted before purge"), undefined, { enforceSessionQuota: true });
		});
		await started;
		const purge = operations.purge(sessionId, () => removeReviewPayloads(sessionId));

		await expect(operations.run(sessionId, async () => "late upload")).rejects.toMatchObject({
			code: "REVIEW_PAYLOAD_SESSION_UNAVAILABLE",
		});
		releaseUpload();
		await accepted;
		await purge;
		expect(existsSync(join(root, sessionId))).toBe(false);
		await expect(operations.run(sessionId, async () => "post-purge upload")).rejects.toMatchObject({
			code: "REVIEW_PAYLOAD_SESSION_UNAVAILABLE",
		});
	});
});


describe("read-only review tombstone reopen hints", () => {
	it("reads the saved active file without mutating exact or sibling tombstones when writes are unavailable", () => {
		const memfs = createMemFs();
		const stateDir = resolve("/memfs/review-read-only-reopen");
		const store = new ReviewAnnotationStore(stateDir, memfs);
		store.setReviewTombstone(sessionId, "target", "closed", "file-active");
		store.setReviewTombstone(sessionId, "sibling", "submitted", "sibling-file");
		const originalWrite = memfs.writeFileSync.bind(memfs);
		memfs.writeFileSync = (() => { throw new Error("injected persistence failure"); }) as typeof memfs.writeFileSync;

		expect(store.getReviewActiveFile(sessionId, "target")).toBe("file-active");
		expect(store.getReviewTombstone(sessionId, "target")).toBe("closed");
		expect(store.getReviewTombstone(sessionId, "sibling")).toBe("submitted");
		expect(store.getReviewActiveFile(sessionId, "sibling")).toBe("sibling-file");

		memfs.writeFileSync = originalWrite as typeof memfs.writeFileSync;
	});
});
