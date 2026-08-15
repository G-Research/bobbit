/**
 * Review extension — open and close Markdown documents in the review pane.
 *
 * `review_open` resolves the canonical review locally, then uploads it through
 * the authenticated, session-owned review payload endpoint. Its tool result is
 * a bounded v2 receipt and never contains Markdown.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { apiCallDetailed, readGatewayCreds } from "../_shared/gateway.js";

export const MAX_REVIEW_MARKDOWN_BYTES = 10 * 1024 * 1024;
export const MAX_REVIEW_FILES = 64;
// Keep the complete JSON receipt comfortably below generic 32 KiB egress truncation.
export const MAX_REVIEW_METADATA_BYTES = 24 * 1024;
export const MAX_REVIEW_TITLE_BYTES = 320;
// Deployment-boundary mirror of src/shared/review-artifact-identity.ts. The
// extension is copied outside the compiled source tree, so core tests pin these
// values and semantics against the shared browser/server contract.
export const MAX_REVIEW_TOOL_CALL_ID_BYTES = 200;
export const MAX_REVIEW_ID_BYTES = 300;
export const MAX_REVIEW_FILE_ID_BYTES = 200;

const INVALID_IDENTITY_CHARACTERS = /[\x00-\x1f\x7f]/;
const INVALID_TITLE_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const commonOpenProperties = {
	title: Type.Optional(Type.String({ description: "Review title. Defaults to filename or 'Review'." })),
	replace: Type.Optional(Type.Boolean({ description: "Replace an existing same-title review. Default true." })),
};

const reviewFileSchema = Type.Union([
	Type.Object({
		title: Type.Optional(Type.String({ description: "File tab title. Defaults to 'File N'." })),
		markdown: Type.String({ description: "Inline Markdown content." }),
	}, { additionalProperties: false }),
	Type.Object({
		title: Type.Optional(Type.String({ description: "File tab title. Defaults to the file basename." })),
		file: Type.String({ description: "Path to a Markdown file on disk." }),
	}, { additionalProperties: false }),
]);

const reviewOpenSchema = Type.Union([
	Type.Object({
		...commonOpenProperties,
		markdown: Type.String({ description: "Inline Markdown content." }),
	}, { additionalProperties: false }),
	Type.Object({
		...commonOpenProperties,
		file: Type.String({ description: "Path to a Markdown file on disk." }),
	}, { additionalProperties: false }),
	Type.Object({
		...commonOpenProperties,
		files: Type.Array(reviewFileSchema, {
			minItems: 1,
			maxItems: MAX_REVIEW_FILES,
			description: "Ordered Markdown files belonging to this review.",
		}),
	}, { additionalProperties: false }),
]);

type ReviewFileInput = { title?: string; markdown: string } | { title?: string; file: string };
type ReviewOpenInput =
	| { title?: string; replace?: boolean; markdown: string }
	| { title?: string; replace?: boolean; file: string }
	| { title?: string; replace?: boolean; files: ReviewFileInput[] };

type CanonicalReviewFile = { fileId: string; title: string; markdown: string; bytes: number };
type SafeFailure = { code: string; retryable: boolean; message: string };
type OpenOutcome =
	| { ok: true; status: "opened" }
	| { ok: false; status: "failed"; code: string; retryable: boolean; message: string };

export type ReviewFileIo = {
	openSync(filePath: string, flags: "r"): number;
	fstatSync(fd: number): Pick<fs.Stats, "size" | "isFile">;
	readSync(fd: number, buffer: Buffer, offset: number, length: number, position: null): number;
	closeSync(fd: number): void;
};

const REVIEW_FILE_READ_CHUNK_BYTES = 64 * 1024;
const NODE_REVIEW_FILE_IO: ReviewFileIo = {
	openSync: (filePath, flags) => fs.openSync(filePath, flags),
	fstatSync: (fd) => fs.fstatSync(fd),
	readSync: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
	closeSync: (fd) => fs.closeSync(fd),
};

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

function validateKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): string | null {
	const unexpected = Object.keys(value).find((key) => !allowed.has(key));
	return unexpected ? `${context} contains an unexpected property.` : null;
}

function validateReviewOpenInput(value: unknown): string | null {
	if (!isRecord(value)) return "Parameters must be an object.";

	const keyError = validateKeys(value, new Set(["title", "replace", "markdown", "file", "files"]), "Parameters");
	if (keyError) return keyError;
	if (hasOwn(value, "title") && typeof value.title !== "string") return "'title' must be a string.";
	if (hasOwn(value, "replace") && typeof value.replace !== "boolean") return "'replace' must be a boolean.";

	const sourceKeys = ["markdown", "file", "files"].filter((key) => hasOwn(value, key));
	if (sourceKeys.length !== 1) return "Exactly one of 'markdown', 'file', or 'files' must be provided.";
	if (sourceKeys[0] === "markdown") return typeof value.markdown === "string" ? null : "'markdown' must be a string.";
	if (sourceKeys[0] === "file") return typeof value.file === "string" ? null : "'file' must be a string.";
	if (!Array.isArray(value.files) || value.files.length === 0) return "'files' must be a non-empty array.";
	if (value.files.length > MAX_REVIEW_FILES) return `'files' cannot contain more than ${MAX_REVIEW_FILES} entries.`;
	for (let index = 0; index < value.files.length; index++) {
		const entry = value.files[index];
		if (!isRecord(entry)) return `'files[${index}]' must be an object.`;
		const entryError = validateKeys(entry, new Set(["title", "markdown", "file"]), `'files[${index}]'`);
		if (entryError) return entryError;
		if (hasOwn(entry, "title") && typeof entry.title !== "string") return `'files[${index}].title' must be a string.`;
		const entrySources = ["markdown", "file"].filter((key) => hasOwn(entry, key));
		if (entrySources.length !== 1) return `'files[${index}]' must provide exactly one of 'markdown' or 'file'.`;
		if (typeof entry[entrySources[0]] !== "string") return `'files[${index}].${entrySources[0]}' must be a string.`;
	}
	return null;
}

const SAFE_FAILURES: Record<string, Omit<SafeFailure, "code">> = {
	REVIEW_PAYLOAD_TOO_LARGE: {
		retryable: false,
		message: "Review content exceeds the 10 MiB UTF-8 limit. Reduce the review and try again.",
	},
	REVIEW_PAYLOAD_QUOTA_EXCEEDED: {
		retryable: false,
		message: "Review content storage is full for this session",
	},
	REVIEW_PAYLOAD_INVALID: {
		retryable: false,
		message: "Review content or metadata is invalid. Check the review files and titles.",
	},
	REVIEW_PAYLOAD_SESSION_UNAVAILABLE: {
		retryable: true,
		message: "The review session is unavailable. Reconnect and try again.",
	},
	REVIEW_PAYLOAD_UPLOAD_FORBIDDEN: {
		retryable: false,
		message: "This review cannot be opened from the current session.",
	},
	REVIEW_PAYLOAD_PERSISTENCE_FAILED: {
		retryable: true,
		message: "Review content could not be saved. Try opening the review again.",
	},
	REVIEW_PAYLOAD_WORKSPACE_CONFLICT: {
		retryable: true,
		message: "The review workspace changed while opening. Try again.",
	},
	REVIEW_PAYLOAD_RESPONSE_INVALID: {
		retryable: true,
		message: "The review service returned an invalid response. Try opening the review again.",
	},
	REVIEW_PAYLOAD_GATEWAY_UNAVAILABLE: {
		retryable: true,
		message: "The review service is unavailable. Reconnect and try again.",
	},
	REVIEW_OPEN_FAILED: {
		retryable: true,
		message: "Review content was saved but the pane could not be opened. Try opening it again.",
	},
};

function safeFailure(code: string): SafeFailure {
	const safe = SAFE_FAILURES[code] ?? SAFE_FAILURES.REVIEW_PAYLOAD_GATEWAY_UNAVAILABLE;
	return { code: code in SAFE_FAILURES ? code : "REVIEW_PAYLOAD_GATEWAY_UNAVAILABLE", ...safe };
}

function errorResult(toolCallId: string, failure: SafeFailure) {
	const boundedToolCallId = validIdentity(toolCallId, MAX_REVIEW_TOOL_CALL_ID_BYTES) ? toolCallId : null;
	return {
		content: [{
			type: "text" as const,
			text: JSON.stringify({ action: "review_open", version: 2, toolCallId: boundedToolCallId, error: failure }),
		}],
		details: undefined,
		isError: true,
	};
}

function invalidResult(toolCallId: string) {
	return errorResult(toolCallId, safeFailure("REVIEW_PAYLOAD_INVALID"));
}

function validIdentity(value: string, maxBytes: number): boolean {
	if (value.length === 0 || utf8Bytes(value) > maxBytes || INVALID_IDENTITY_CHARACTERS.test(value)) return false;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}

function validTitle(value: string): boolean {
	return value.length > 0 && utf8Bytes(value) <= MAX_REVIEW_TITLE_BYTES && !INVALID_TITLE_CHARACTERS.test(value);
}

function readMarkdownFile(
	file: string,
	remainingBytes: number,
	fileIo: ReviewFileIo,
): { markdown: string } | { error: SafeFailure } {
	const cwd = process.env.BOBBIT_CWD || process.cwd();
	const filePath = path.isAbsolute(file) ? file : path.resolve(cwd, file);
	if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0) {
		return { error: safeFailure("REVIEW_PAYLOAD_INVALID") };
	}

	let fd: number | undefined;
	try {
		fd = fileIo.openSync(filePath, "r");
		const stat = fileIo.fstatSync(fd);
		if (!stat.isFile()) return { error: safeFailure("REVIEW_PAYLOAD_INVALID") };
		if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
			return { error: safeFailure("REVIEW_PAYLOAD_INVALID") };
		}
		if (stat.size > remainingBytes) return { error: safeFailure("REVIEW_PAYLOAD_TOO_LARGE") };

		// Read from this descriptor only. The extra byte detects a file that grows
		// after fstat without ever requesting or retaining an unbounded body.
		const buffer = Buffer.alloc(Math.min(REVIEW_FILE_READ_CHUNK_BYTES, remainingBytes + 1));
		const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
		const markdownParts: string[] = [];
		let totalBytesRead = 0;
		while (true) {
			const readLimit = Math.min(buffer.length, remainingBytes + 1 - totalBytesRead);
			const bytesRead = fileIo.readSync(fd, buffer, 0, readLimit, null);
			if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > readLimit) {
				return { error: safeFailure("REVIEW_PAYLOAD_INVALID") };
			}
			if (bytesRead === 0) break;
			totalBytesRead += bytesRead;
			if (totalBytesRead > remainingBytes) {
				return { error: safeFailure("REVIEW_PAYLOAD_TOO_LARGE") };
			}
			const chunk = buffer.subarray(0, bytesRead);
			if (chunk.includes(0)) return { error: safeFailure("REVIEW_PAYLOAD_INVALID") };
			markdownParts.push(decoder.decode(chunk, { stream: true }));
		}
		markdownParts.push(decoder.decode());
		return { markdown: markdownParts.join("") };
	} catch {
		// Includes fatal UTF-8 decoding errors and all descriptor I/O failures.
		return { error: safeFailure("REVIEW_PAYLOAD_INVALID") };
	} finally {
		if (fd !== undefined) {
			try { fileIo.closeSync(fd); } catch { /* content has already resolved to a safe result */ }
		}
	}
}

function sanitizeOpenOutcome(value: unknown): OpenOutcome {
	if (isRecord(value) && value.ok === true && value.status === "opened") return { ok: true, status: "opened" };
	if (isRecord(value) && value.ok === false && value.status === "failed" && typeof value.code === "string") {
		const failure = safeFailure(value.code);
		return { ok: false, status: "failed", ...failure };
	}
	return { ok: false, status: "failed", ...safeFailure("REVIEW_OPEN_FAILED") };
}

function sanitizeReceipt(
	value: unknown,
	expected: {
		toolCallId: string;
		reviewId: string;
		title: string;
		files: CanonicalReviewFile[];
		activeFileId: string;
		replace: boolean;
		totalBytes: number;
	},
): Record<string, unknown> | null {
	if (!isRecord(value)
		|| value.action !== "review_open"
		|| value.version !== 2
		|| value.toolCallId !== expected.toolCallId
		|| typeof value.payloadId !== "string"
		|| !/^[A-Za-z0-9_-]{20,64}$/.test(value.payloadId)
		|| typeof value.hash !== "string"
		|| !/^[a-f0-9]{64}$/.test(value.hash)
		|| typeof value.reviewId !== "string"
		|| !validIdentity(value.reviewId, MAX_REVIEW_ID_BYTES)
		|| (!expected.replace && value.reviewId !== expected.reviewId)
		|| value.title !== expected.title
		|| typeof value.activeFileId !== "string"
		|| !validIdentity(value.activeFileId, MAX_REVIEW_FILE_ID_BYTES)
		|| value.replace !== expected.replace
		|| value.totalBytes !== expected.totalBytes
		|| !Array.isArray(value.files)
		|| value.files.length !== expected.files.length) {
		return null;
	}

	// A replace:true upload is allowed to retain the authoritative review and
	// duplicate-title file identities already present in the workspace. Validate
	// the returned ordered metadata instead of requiring the extension's fresh
	// provisional UUIDs, then emit those server-owned identities in the receipt.
	const seenFileIds = new Set<string>();
	const metadata: Array<{ fileId: string; title: string; bytes: number }> = [];
	for (let index = 0; index < expected.files.length; index++) {
		const received = value.files[index];
		const file = expected.files[index];
		if (!isRecord(received)
			|| typeof received.fileId !== "string"
			|| !validIdentity(received.fileId, MAX_REVIEW_FILE_ID_BYTES)
			|| seenFileIds.has(received.fileId)
			|| (!expected.replace && received.fileId !== file.fileId)
			|| received.title !== file.title
			|| received.bytes !== file.bytes
			|| hasOwn(received, "markdown")) return null;
		seenFileIds.add(received.fileId);
		metadata.push({ fileId: received.fileId, title: file.title, bytes: file.bytes });
	}
	if (!seenFileIds.has(value.activeFileId)) return null;

	return {
		action: "review_open",
		version: 2,
		toolCallId: expected.toolCallId,
		payloadId: value.payloadId,
		reviewId: value.reviewId,
		title: expected.title,
		activeFileId: value.activeFileId,
		replace: expected.replace,
		totalBytes: expected.totalBytes,
		hash: value.hash,
		files: metadata,
		automaticOpen: sanitizeOpenOutcome(value.automaticOpen),
	};
}

function failureFromResponse(status: number, body: unknown): SafeFailure {
	if (isRecord(body) && typeof body.code === "string") return safeFailure(body.code);
	if (status === 413) return safeFailure("REVIEW_PAYLOAD_TOO_LARGE");
	if (status === 400 || status === 422) return safeFailure("REVIEW_PAYLOAD_INVALID");
	if (status === 401 || status === 403) return safeFailure("REVIEW_PAYLOAD_UPLOAD_FORBIDDEN");
	if (status === 404) return safeFailure("REVIEW_PAYLOAD_SESSION_UNAVAILABLE");
	return safeFailure("REVIEW_PAYLOAD_GATEWAY_UNAVAILABLE");
}

type ReviewExtensionApi = Parameters<ExtensionFactory>[0];

function registerReviewTools(pi: ReviewExtensionApi, fileIo: ReviewFileIo): void {
	pi.registerTool({
		name: "review_open",
		label: "Review Open",
		description: "Open one or more Markdown files as a single review for inline commenting.",
		parameters: reviewOpenSchema,

		async execute(toolCallId, rawParams) {
			if (!validIdentity(toolCallId, MAX_REVIEW_TOOL_CALL_ID_BYTES)) return invalidResult(toolCallId);
			const validationError = validateReviewOpenInput(rawParams);
			if (validationError) return invalidResult(toolCallId);
			const params = rawParams as ReviewOpenInput;
			const isMultiFile = "files" in params;
			const inputs: ReviewFileInput[] = isMultiFile
				? params.files
				: ["markdown" in params ? { markdown: params.markdown } : { file: params.file }];
			const defaultReviewTitle = !isMultiFile && "file" in params ? path.basename(params.file) : "Review";
			const title = params.title ?? defaultReviewTitle;
			if (!validTitle(title)) return invalidResult(toolCallId);

			const reviewId = randomUUID();
			const files: CanonicalReviewFile[] = [];
			let totalBytes = 0;
			for (let index = 0; index < inputs.length; index++) {
				const input = inputs[index];
				const fileTitle = isMultiFile
					? input.title ?? ("file" in input ? path.basename(input.file) : `File ${index + 1}`)
					: title;
				if (!validTitle(fileTitle)) return invalidResult(toolCallId);

				let markdown: string;
				if ("markdown" in input) {
					markdown = input.markdown;
				} else {
					const loaded = readMarkdownFile(input.file, MAX_REVIEW_MARKDOWN_BYTES - totalBytes, fileIo);
					if ("error" in loaded) return errorResult(toolCallId, loaded.error);
					markdown = loaded.markdown;
				}
				const bytes = utf8Bytes(markdown);
				totalBytes += bytes;
				if (totalBytes > MAX_REVIEW_MARKDOWN_BYTES) {
					return errorResult(toolCallId, safeFailure("REVIEW_PAYLOAD_TOO_LARGE"));
				}
				files.push({ fileId: randomUUID(), title: fileTitle, markdown, bytes });
			}

			const activeFileId = files[0].fileId;
			const replace = params.replace !== false;
			const metadataBytes = utf8Bytes(JSON.stringify({
				toolCallId,
				reviewId,
				title,
				activeFileId,
				replace,
				files: files.map(({ fileId, title: fileTitle, bytes }) => ({ fileId, title: fileTitle, bytes })),
			}));
			if (metadataBytes > MAX_REVIEW_METADATA_BYTES) return invalidResult(toolCallId);

			const sessionId = process.env.BOBBIT_SESSION_ID;
			const sessionSecret = process.env.BOBBIT_SESSION_SECRET;
			const creds = readGatewayCreds();
			if (!sessionId || !sessionSecret || "error" in creds) {
				return errorResult(toolCallId, safeFailure("REVIEW_PAYLOAD_SESSION_UNAVAILABLE"));
			}

			let response;
			try {
				response = await apiCallDetailed(
					creds,
					"POST",
					`/api/sessions/${encodeURIComponent(sessionId)}/review-payloads`,
					{
						toolCallId,
						review: {
							reviewId,
							title,
							files: files.map(({ fileId, title: fileTitle, markdown }) => ({ fileId, title: fileTitle, markdown })),
							activeFileId,
							replace,
						},
					},
					{
						extraHeaders: { "X-Bobbit-Session-Secret": sessionSecret },
						// A lost response must not silently replay this persistence mutation.
						// The bounded error receipt leaves an explicit user retry available.
						retries: 0,
					},
				);
			} catch {
				return errorResult(toolCallId, safeFailure("REVIEW_PAYLOAD_GATEWAY_UNAVAILABLE"));
			}
			if (!response.ok) return errorResult(toolCallId, failureFromResponse(response.status, response.body));

			const receipt = sanitizeReceipt(response.body, {
				toolCallId,
				reviewId,
				title,
				files,
				activeFileId,
				replace,
				totalBytes,
			});
			if (!receipt) return errorResult(toolCallId, safeFailure("REVIEW_PAYLOAD_RESPONSE_INVALID"));
			return { content: [{ type: "text" as const, text: JSON.stringify(receipt) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "review_close",
		label: "Review Close",
		description: "Close matching Markdown reviews or all reviews.",
		parameters: Type.Object({
			title: Type.Optional(Type.String({ description: "Match title: close each whole review and all files; omit for all caller reviews." })),
		}),

		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: JSON.stringify({ action: "review_close", title: params.title || null }) }],
				details: undefined,
			};
		},
	});
}

export function createReviewExtension(
	dependencies: { fileIo?: ReviewFileIo } = {},
): ExtensionFactory {
	const fileIo = dependencies.fileIo ?? NODE_REVIEW_FILE_IO;
	return (pi) => registerReviewTools(pi, fileIo);
}

const extension = createReviewExtension();
export default extension;
