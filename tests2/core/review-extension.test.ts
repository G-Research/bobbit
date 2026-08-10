import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import reviewExtension, {
	createReviewExtension,
	MAX_REVIEW_FILES,
	MAX_REVIEW_MARKDOWN_BYTES,
	MAX_REVIEW_TITLE_BYTES,
	MAX_REVIEW_TOOL_CALL_ID_BYTES,
	MAX_REVIEW_ID_BYTES,
	MAX_REVIEW_FILE_ID_BYTES,
	type ReviewFileIo,
} from "../../defaults/tools/review/extension.ts";
import {
	REVIEW_ARTIFACT_FILE_ID_MAX_BYTES,
	REVIEW_ARTIFACT_REVIEW_ID_MAX_BYTES,
	REVIEW_ARTIFACT_TOOL_CALL_ID_MAX_BYTES,
} from "../../src/shared/review-artifact-identity.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredTool = {
	name: string;
	parameters: any;
	execute: (toolCallId: string, params: any) => Promise<ToolResult>;
};
type Upload = {
	url: string;
	init: RequestInit;
	body: {
		toolCallId: string;
		review: {
			reviewId: string;
			title: string;
			files: Array<{ fileId: string; title: string; markdown: string }>;
			activeFileId: string;
			replace: boolean;
		};
	};
};

let reviewOpen: RegisteredTool;
let fixtureDir: string;
let uploads: Upload[] = [];
let nextResponse: ((upload: Upload) => Response) | undefined;

function defaultResponse(upload: Upload): Response {
	const { toolCallId, review } = upload.body;
	const files = review.files.map((file) => ({
		fileId: file.fileId,
		title: file.title,
		bytes: Buffer.byteLength(file.markdown, "utf8"),
	}));
	return Response.json({
		action: "review_open",
		version: 2,
		toolCallId,
		payloadId: "payload_abcdefghijklmnop",
		reviewId: review.reviewId,
		title: review.title,
		activeFileId: review.activeFileId,
		replace: review.replace,
		totalBytes: files.reduce((total, file) => total + file.bytes, 0),
		hash: "a".repeat(64),
		files,
		automaticOpen: { ok: true, status: "opened" },
	}, { status: 201 });
}

beforeAll(() => {
	fixtureDir = mkdtempSync(path.join(tmpdir(), "bobbit-review-extension-"));
	writeFileSync(path.join(fixtureDir, "architecture.md"), "# Architecture\n", "utf8");
	writeFileSync(path.join(fixtureDir, "notes.md"), "# Notes\n", "utf8");
	writeFileSync(path.join(fixtureDir, "binary.md"), Buffer.from([0x23, 0x20, 0x61, 0x00, 0x62]));
	writeFileSync(path.join(fixtureDir, "malformed-utf8.md"), Buffer.from([0x23, 0x20, 0xc3, 0x28]));
	mkdirSync(path.join(fixtureDir, "folder.md"));
	process.env.BOBBIT_CWD = fixtureDir;
	process.env.BOBBIT_DIR = fixtureDir;
	process.env.BOBBIT_GATEWAY_URL = "http://review.test";
	process.env.BOBBIT_TOKEN = "gateway-token";
	process.env.BOBBIT_SESSION_ID = "11111111-1111-4111-8111-111111111111";
	process.env.BOBBIT_SESSION_SECRET = "own-session-secret";
	globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const body = JSON.parse(String(init.body)) as Upload["body"];
		const upload = { url: String(input), init, body };
		uploads.push(upload);
		return (nextResponse ?? defaultResponse)(upload);
	}) as typeof fetch;

	const tools = new Map<string, RegisteredTool>();
	reviewExtension({
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
	} as any);
	const tool = tools.get("review_open");
	assert.ok(tool, "review_open should be registered");
	reviewOpen = tool;
});

beforeEach(() => {
	uploads = [];
	nextResponse = undefined;
});

afterAll(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
});

function textOf(result: ToolResult): string {
	const text = result.content?.[0]?.text;
	assert.equal(typeof text, "string", "review_open should return a text result");
	return text;
}

async function execute(params: any, toolCallId = "review-open-contract-test"): Promise<ToolResult> {
	return reviewOpen.execute(toolCallId, params);
}

async function executeSuccess(params: any, toolCallId?: string): Promise<any> {
	const result = await execute(params, toolCallId);
	assert.notEqual(result.isError, true, `expected success, received ${textOf(result)}`);
	return JSON.parse(textOf(result));
}

async function executeError(params: any, toolCallId?: string): Promise<any> {
	const result = await execute(params, toolCallId);
	return parseError(result);
}

function parseError(result: ToolResult): any {
	assert.equal(result.isError, true, `expected an error, received ${textOf(result)}`);
	const parsed = JSON.parse(textOf(result));
	assert.equal(parsed.action, "review_open");
	assert.equal(parsed.version, 2);
	assert.equal(typeof parsed.error?.code, "string");
	assert.equal(typeof parsed.error?.retryable, "boolean");
	assert.equal(typeof parsed.error?.message, "string");
	return parsed;
}

function registerReviewOpen(fileIo: ReviewFileIo): RegisteredTool {
	const tools = new Map<string, RegisteredTool>();
	createReviewExtension({ fileIo })({
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
	} as any);
	const tool = tools.get("review_open");
	assert.ok(tool, "injected review_open should be registered");
	return tool;
}

function assertCanonicalReceipt(result: any, expected: {
	title: string;
	replace: boolean;
	files: Array<{ title: string; markdown: string }>;
}): void {
	assert.equal(result.action, "review_open");
	assert.equal(result.version, 2);
	assert.equal(typeof result.payloadId, "string");
	assert.equal(typeof result.reviewId, "string");
	assert.equal(result.title, expected.title);
	assert.equal(result.replace, expected.replace);
	assert.equal(result.markdown, undefined);
	assert.equal(result.file, undefined);
	assert.equal(result.files.length, expected.files.length);
	assert.deepEqual(
		result.files.map((file: any) => ({ title: file.title, bytes: file.bytes })),
		expected.files.map((file) => ({ title: file.title, bytes: Buffer.byteLength(file.markdown, "utf8") })),
	);
	for (const file of result.files) {
		assert.equal(typeof file.fileId, "string");
		assert.equal(file.markdown, undefined, "receipt metadata must not contain Markdown");
	}
	assert.equal(new Set(result.files.map((file: any) => file.fileId)).size, result.files.length);
	assert.deepEqual(result.automaticOpen, { ok: true, status: "opened" });

	const upload = uploads.at(-1);
	assert.ok(upload, "successful review must upload canonical content");
	assert.equal(upload.body.review.title, expected.title);
	assert.equal(upload.body.review.replace, expected.replace);
	assert.deepEqual(
		upload.body.review.files.map((file) => ({ title: file.title, markdown: file.markdown })),
		expected.files,
	);
	assert.deepEqual(
		result.files.map((file: any) => file.fileId),
		upload.body.review.files.map((file) => file.fileId),
	);
	assert.equal(result.activeFileId, upload.body.review.files[0].fileId);
}

describe("review_open durable receipt contract", () => {
	it("pins the copied extension identity contract and applies UTF-8 max/+1 before upload", async () => {
		assert.equal(MAX_REVIEW_TOOL_CALL_ID_BYTES, REVIEW_ARTIFACT_TOOL_CALL_ID_MAX_BYTES);
		assert.equal(MAX_REVIEW_ID_BYTES, REVIEW_ARTIFACT_REVIEW_ID_MAX_BYTES);
		assert.equal(MAX_REVIEW_FILE_ID_BYTES, REVIEW_ARTIFACT_FILE_ID_MAX_BYTES);
		const exactToolCallId = `${"界".repeat(66)}é`;
		assert.equal(Buffer.byteLength(exactToolCallId, "utf8"), REVIEW_ARTIFACT_TOOL_CALL_ID_MAX_BYTES);
		await executeSuccess({ markdown: "exact identity" }, exactToolCallId);
		assert.equal(uploads.at(-1)?.body.toolCallId, exactToolCallId);

		uploads = [];
		const failure = await execute({ markdown: "must not persist" }, `${exactToolCallId}x`);
		assert.equal(JSON.parse(textOf(failure)).error.code, "REVIEW_PAYLOAD_INVALID");
		assert.equal(uploads.length, 0);
	});

	it("publishes a closed schema with exactly one source mode and bounded file count", () => {
		const schema = reviewOpen.parameters;
		const valid = [
			{ markdown: "" },
			{ file: "architecture.md" },
			{ title: "Bundle", replace: false, files: [{ markdown: "one" }] },
			{ files: [{ title: "Inline", markdown: "one" }, { file: "notes.md" }] },
		];
		for (const params of valid) assert.equal(Value.Check(schema, params), true, JSON.stringify(params));

		const invalid = [
			{},
			{ markdown: "inline", file: "architecture.md" },
			{ files: [] },
			{ files: Array.from({ length: MAX_REVIEW_FILES + 1 }, () => ({ markdown: "x" })) },
			{ markdown: "inline", files: [{ markdown: "nested" }] },
			{ files: [{}] },
			{ files: [{ markdown: "nested", file: "notes.md" }] },
			{ files: [{ markdown: 42 }] },
			{ markdown: "inline", unexpected: true },
		];
		for (const params of invalid) assert.equal(Value.Check(schema, params), false, JSON.stringify(params));
	});

	it("mirrors schema validation for direct execute callers without uploading", async () => {
		const invalid = [
			{},
			{ markdown: "inline", file: "architecture.md" },
			{ files: [] },
			{ files: Array.from({ length: MAX_REVIEW_FILES + 1 }, () => ({ markdown: "x" })) },
			{ files: [{}] },
			{ files: [{ markdown: "nested", file: "notes.md" }] },
			{ files: [{ markdown: 42 }] },
		];
		for (const params of invalid) assert.equal((await executeError(params)).error.code, "REVIEW_PAYLOAD_INVALID");
		assert.equal(uploads.length, 0, "invalid inputs must fail before persistence");
	});

	it("loads mixed inline and relative files atomically, preserving order and duplicate titles", async () => {
		const result = await executeSuccess({
			title: "System review",
			files: [
				{ title: "Overview", markdown: "Inline overview" },
				{ title: "Repeated", file: "architecture.md" },
				{ title: "Repeated", markdown: "Inline details" },
				{ file: "notes.md" },
			],
		});
		assertCanonicalReceipt(result, {
			title: "System review",
			replace: true,
			files: [
				{ title: "Overview", markdown: "Inline overview" },
				{ title: "Repeated", markdown: "# Architecture\n" },
				{ title: "Repeated", markdown: "Inline details" },
				{ title: "notes.md", markdown: "# Notes\n" },
			],
		});
	});

	it("assigns deterministic defaults and keeps legacy inline/file inputs", async () => {
		const grouped = await executeSuccess({ files: [{ markdown: "first" }, { file: "architecture.md" }] });
		assertCanonicalReceipt(grouped, {
			title: "Review",
			replace: true,
			files: [
				{ title: "File 1", markdown: "first" },
				{ title: "architecture.md", markdown: "# Architecture\n" },
			],
		});

		const inline = await executeSuccess({ title: "Release notes", markdown: "", replace: false });
		assertCanonicalReceipt(inline, {
			title: "Release notes",
			replace: false,
			files: [{ title: "Release notes", markdown: "" }],
		});

		const file = await executeSuccess({ file: "architecture.md" });
		assertCanonicalReceipt(file, {
			title: "architecture.md",
			replace: true,
			files: [{ title: "architecture.md", markdown: "# Architecture\n" }],
		});
	});

	it("authenticates the exact owning-session upload and binds the receipt to the tool call", async () => {
		const receipt = await executeSuccess({ markdown: "private body" }, "tool-call-exact");
		assert.equal(receipt.toolCallId, "tool-call-exact");
		assert.equal(uploads[0].body.toolCallId, "tool-call-exact");
		assert.equal(uploads[0].url, "http://review.test/api/sessions/11111111-1111-4111-8111-111111111111/review-payloads");
		const headers = new Headers(uploads[0].init.headers);
		assert.equal(headers.get("authorization"), "Bearer gateway-token");
		assert.equal(headers.get("x-bobbit-session-secret"), "own-session-secret");
	});

	it("accepts an exact 10 MiB file using fatal chunked UTF-8 decoding and rejects one byte more atomically", async () => {
		const chunkBytes = 64 * 1024;
		const exact = `${"x".repeat(chunkBytes - 1)}é${"x".repeat(MAX_REVIEW_MARKDOWN_BYTES - chunkBytes - 1)}`;
		assert.equal(Buffer.byteLength(exact, "utf8"), MAX_REVIEW_MARKDOWN_BYTES);
		writeFileSync(path.join(fixtureDir, "exact-limit.md"), exact, "utf8");
		const receipt = await executeSuccess({ file: "exact-limit.md" });
		assert.equal(receipt.totalBytes, MAX_REVIEW_MARKDOWN_BYTES);
		assert.equal(uploads.length, 1);

		uploads = [];
		const over = await executeError({ files: [{ markdown: exact }, { markdown: "x" }] });
		assert.equal(over.error.code, "REVIEW_PAYLOAD_TOO_LARGE");
		assert.equal(over.error.retryable, false);
		assert.equal(uploads.length, 0, "over-limit reviews must not partially upload");
	});

	it("caps a descriptor read at the remaining budget plus one when the file grows after fstat", async () => {
		const growth = Buffer.from("abcde");
		let produced = 0;
		let closed = false;
		const requestedRanges: Array<{ start: number; end: number }> = [];
		const fileIo: ReviewFileIo = {
			openSync: () => 73,
			fstatSync: () => ({ size: 4, isFile: () => true }),
			readSync: (_fd, buffer, offset, length) => {
				requestedRanges.push({ start: produced, end: produced + length });
				const bytesRead = Math.min(length, produced === 0 ? 4 : growth.length - produced);
				growth.copy(buffer, offset, produced, produced + bytesRead);
				produced += bytesRead;
				return bytesRead;
			},
			closeSync: () => { closed = true; },
		};
		const injectedOpen = registerReviewOpen(fileIo);
		const result = await injectedOpen.execute("growing-file", {
			files: [
				{ markdown: "x".repeat(MAX_REVIEW_MARKDOWN_BYTES - 4) },
				{ file: "growing.md" },
			],
		});
		const failure = parseError(result);
		assert.equal(failure.error.code, "REVIEW_PAYLOAD_TOO_LARGE");
		assert.equal(produced, 5, "the reader should stop on the single over-budget byte");
		assert.deepEqual(requestedRanges, [{ start: 0, end: 5 }, { start: 4, end: 5 }]);
		assert.ok(requestedRanges.every(({ end }) => end <= 5), "reads must stay within remaining bytes plus one");
		assert.equal(closed, true, "the descriptor must close after a limit failure");
		assert.equal(uploads.length, 0, "a growing over-limit review must fail before upload");
	});

	it("rejects oversized metadata and unsafe files before upload", async () => {
		assert.equal(
			(await executeError({ title: "é".repeat(Math.floor(MAX_REVIEW_TITLE_BYTES / 2) + 1), markdown: "x" })).error.code,
			"REVIEW_PAYLOAD_INVALID",
		);
		assert.equal((await executeError({ files: [{ file: "missing.md" }] })).error.code, "REVIEW_PAYLOAD_INVALID");
		assert.equal((await executeError({ files: [{ file: "folder.md" }] })).error.code, "REVIEW_PAYLOAD_INVALID");
		assert.equal((await executeError({ files: [{ file: "binary.md" }] })).error.code, "REVIEW_PAYLOAD_INVALID");
		assert.equal((await executeError({ files: [{ file: "malformed-utf8.md" }] })).error.code, "REVIEW_PAYLOAD_INVALID");
		assert.equal(uploads.length, 0);
	});

	it("returns bounded safe failures for metadata rejected after tool-call transport", async () => {
		const oversizedTitle = "title-".repeat(200_000);
		const oversizedPath = `missing/${"segment/".repeat(150_000)}review.md`;
		const cases = [
			{ title: oversizedTitle, markdown: "short" },
			{ files: [{ title: oversizedTitle, markdown: "short" }] },
			{ file: oversizedPath },
			{ files: Array.from({ length: MAX_REVIEW_FILES + 1 }, () => ({ markdown: "short" })) },
		];

		for (const params of cases) {
			const failure = await executeError(params);
			assert.equal(failure.error.code, "REVIEW_PAYLOAD_INVALID");
			assert.equal(failure.error.retryable, false);
			const serialized = JSON.stringify(failure);
			assert.ok(Buffer.byteLength(serialized, "utf8") < 1024);
			assert.doesNotMatch(serialized, /title-title-title|segment\/segment/);
		}
		assert.equal(uploads.length, 0, "invalid metadata must never reach persistence");
	});

	it("returns no partial receipt when a later file cannot be loaded", async () => {
		const error = await executeError({
			files: [{ file: "architecture.md" }, { file: "missing.md" }],
		});
		assert.equal(error.error.code, "REVIEW_PAYLOAD_INVALID");
		assert.equal(error.payloadId, undefined);
		assert.equal(uploads.length, 0);
	});

	it("emits fresh identities and preserves replace:false", async () => {
		const params = { title: "Duplicate", replace: false, files: [{ title: "Same", markdown: "first" }, { title: "Same", markdown: "second" }] };
		const first = await executeSuccess(params);
		const second = await executeSuccess(params);
		assert.notEqual(first.reviewId, second.reviewId);
		assert.equal(new Set([...first.files, ...second.files].map((file: any) => file.fileId)).size, 4);
	});

	it("accepts an authoritative replacement review identity from the server", async () => {
		nextResponse = (upload) => {
			const { toolCallId, review } = upload.body;
			const files = review.files.map((file) => ({ fileId: file.fileId, title: file.title, bytes: Buffer.byteLength(file.markdown, "utf8") }));
			return Response.json({
				action: "review_open", version: 2, toolCallId,
				payloadId: "payload_abcdefghijklmnop", reviewId: "existing-review-id",
				title: review.title, activeFileId: review.activeFileId, replace: true,
				totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), hash: "b".repeat(64), files,
				automaticOpen: { ok: true, status: "opened" },
			}, { status: 201 });
		};
		const receipt = await executeSuccess({ title: "Existing", markdown: "body" });
		assert.equal(receipt.reviewId, "existing-review-id");
	});

	it("preserves the allowlisted non-retryable session quota failure", async () => {
		nextResponse = () => Response.json({
			code: "REVIEW_PAYLOAD_QUOTA_EXCEEDED",
			message: "C:\\secret\\payload.json token=credential",
			stack: "private stack",
			retryable: true,
		}, { status: 507 });
		const failure = await executeError({ markdown: "secret markdown marker" });
		assert.deepEqual(failure.error, {
			code: "REVIEW_PAYLOAD_QUOTA_EXCEEDED",
			message: "Review content storage is full for this session",
			retryable: false,
		});
		const text = JSON.stringify(failure);
		assert.doesNotMatch(text, /secret markdown marker|payload\.json|credential|private stack/);
	});

	it("sanitizes server failures and never reflects raw errors, paths, credentials, or stacks", async () => {
		nextResponse = () => Response.json({
			code: "UNKNOWN_RAW_CODE",
			message: "C:\\secret\\payload.json token=credential",
			stack: "private stack",
		}, { status: 500 });
		const failure = await executeError({ markdown: "secret markdown marker" });
		assert.equal(failure.error.code, "REVIEW_PAYLOAD_GATEWAY_UNAVAILABLE");
		const text = JSON.stringify(failure);
		assert.doesNotMatch(text, /secret markdown marker|payload\.json|credential|private stack|UNKNOWN_RAW_CODE/);
	});

	it("fails closed on a malformed or mismatched success response", async () => {
		nextResponse = () => Response.json({
			action: "review_open",
			version: 2,
			toolCallId: "forged-tool-call",
			payloadId: "payload_abcdefghijklmnop",
			hash: "a".repeat(64),
			files: [],
		}, { status: 201 });
		const failure = await executeError({ markdown: "body" });
		assert.equal(failure.error.code, "REVIEW_PAYLOAD_RESPONSE_INVALID");
		assert.equal(failure.error.retryable, true);
	});

	it("preserves a sanitized structured automatic-open failure in a retryable receipt", async () => {
		nextResponse = (upload) => {
			const { toolCallId, review } = upload.body;
			const files = review.files.map((file) => ({ fileId: file.fileId, title: file.title, bytes: Buffer.byteLength(file.markdown, "utf8") }));
			return Response.json({
				action: "review_open", version: 2, toolCallId,
				payloadId: "payload_abcdefghijklmnop", reviewId: review.reviewId,
				title: review.title, activeFileId: review.activeFileId, replace: review.replace,
				totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), hash: "c".repeat(64), files,
				automaticOpen: {
					ok: false, status: "failed", code: "REVIEW_PAYLOAD_PERSISTENCE_FAILED", retryable: true,
					message: "C:\\private\\workspace stack",
				},
			}, { status: 201 });
		};
		const receipt = await executeSuccess({ markdown: "body" });
		assert.deepEqual(receipt.automaticOpen, {
			ok: false,
			status: "failed",
			code: "REVIEW_PAYLOAD_PERSISTENCE_FAILED",
			retryable: true,
			message: "Review content could not be saved. Try opening the review again.",
		});
	});
});
