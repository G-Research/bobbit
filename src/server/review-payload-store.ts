import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	isReviewArtifactIdentity,
	type ReviewArtifactIdentityKind,
} from "../shared/review-artifact-identity.js";
import { bobbitStateDir } from "./bobbit-dir.js";

export const MAX_REVIEW_MARKDOWN_BYTES = 10 * 1024 * 1024;
export const MAX_REVIEW_PAYLOAD_FILES = 64;
export const MAX_REVIEW_PAYLOAD_METADATA_BYTES = 256 * 1024;
// JSON may expand one Markdown byte to six ASCII bytes (for example a control
// character encoded as `\u0000`). Keep this review-only transport/storage cap
// bounded while allowing every canonical payload at the exact 10 MiB Markdown
// limit. The generic request-body and WebSocket limits remain unchanged.
export const MAX_REVIEW_JSON_EXPANSION = 6;
export const MAX_REVIEW_PAYLOAD_REQUEST_BYTES = MAX_REVIEW_MARKDOWN_BYTES * MAX_REVIEW_JSON_EXPANSION
	+ MAX_REVIEW_PAYLOAD_METADATA_BYTES;
/** Historical payloads are never evicted; later uploads fail once either cap is reached. */
export const MAX_REVIEW_PAYLOADS_PER_SESSION = 64;
export const MAX_REVIEW_PAYLOAD_SESSION_STORAGE_BYTES = 256 * 1024 * 1024;
const MAX_REVIEW_RECEIPT_METADATA_BYTES = 24 * 1024;

const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const VALID_PAYLOAD_ID = /^[A-Za-z0-9_-]{20,64}$/;
const MAX_TITLE_BYTES = 320;
const PAYLOAD_FILE = "payload.json";

export interface CanonicalReviewPayloadFile {
	fileId: string;
	title: string;
	markdown: string;
	bytes: number;
}

export interface CanonicalReviewPayload {
	action: "review_open";
	version: 2;
	sessionId: string;
	toolCallId: string;
	payloadId: string;
	reviewId: string;
	title: string;
	files: CanonicalReviewPayloadFile[];
	activeFileId: string;
	replace: boolean;
	totalBytes: number;
	hash: string;
	createdAt: number;
}

export interface ReviewPayloadReceipt {
	action: "review_open";
	version: 2;
	toolCallId: string;
	payloadId: string;
	reviewId: string;
	title: string;
	activeFileId: string;
	replace: boolean;
	totalBytes: number;
	hash: string;
	files: Array<{ fileId: string; title: string; bytes: number }>;
	automaticOpen: ReviewPayloadOpenOutcome;
}

export type ReviewPayloadOpenOutcome =
	| { ok: true; status: "opened" }
	| { ok: false; status: "failed"; code: string; retryable: boolean; message: string };

export class ReviewPayloadError extends Error {
	constructor(
		readonly statusCode: number,
		readonly code: string,
		message: string,
		readonly retryable = false,
	) {
		super(message);
		this.name = "ReviewPayloadError";
	}
}

type UploadBody = {
	toolCallId: string;
	review: {
		reviewId: string;
		title: string;
		files: Array<{ fileId: string; title: string; markdown: string }>;
		activeFileId: string;
		replace: boolean;
	};
};

let rootOverride: string | undefined;

export function setReviewPayloadRootForTesting(root: string | undefined): void {
	rootOverride = root;
}

export function reviewPayloadRoot(): string {
	return rootOverride ?? path.join(bobbitStateDir(), "review-payloads");
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function artifactIdentity(value: unknown, name: string, kind: ReviewArtifactIdentityKind): string {
	if (!isReviewArtifactIdentity(value, kind)) {
		throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", `Invalid ${name}`);
	}
	return value;
}

function boundedTitle(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > MAX_TITLE_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
		throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", `Invalid ${name}`);
	}
	return value;
}

function validateSessionId(sessionId: string): void {
	if (!VALID_SESSION_ID.test(sessionId)) throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Invalid session identity");
}

function validatePayloadId(payloadId: string): void {
	if (!VALID_PAYLOAD_ID.test(payloadId)) throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Invalid payload identity");
}

function canonicalHashInput(payload: Pick<CanonicalReviewPayload, "sessionId" | "toolCallId" | "reviewId" | "title" | "files" | "activeFileId" | "replace" | "totalBytes">): string {
	return JSON.stringify({
		sessionId: payload.sessionId,
		toolCallId: payload.toolCallId,
		reviewId: payload.reviewId,
		title: payload.title,
		files: payload.files.map(({ fileId, title, markdown, bytes }) => ({ fileId, title, markdown, bytes })),
		activeFileId: payload.activeFileId,
		replace: payload.replace,
		totalBytes: payload.totalBytes,
	});
}

function payloadHash(payload: Parameters<typeof canonicalHashInput>[0]): string {
	return createHash("sha256").update(canonicalHashInput(payload), "utf8").digest("hex");
}

function coerceUploadBody(sessionId: string, raw: unknown, reviewIdOverride?: string): Omit<CanonicalReviewPayload, "payloadId" | "hash" | "createdAt"> {
	validateSessionId(sessionId);
	if (!isPlainObject(raw) || !isPlainObject(raw.review)) {
		throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Invalid review payload");
	}
	const allowedRoot = new Set(["toolCallId", "review"]);
	if (Object.keys(raw).some((key) => !allowedRoot.has(key))) throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Invalid review payload fields");
	const review = raw.review;
	const allowedReview = new Set(["reviewId", "title", "files", "activeFileId", "replace"]);
	if (Object.keys(review).some((key) => !allowedReview.has(key))) throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Invalid review fields");

	const toolCallId = artifactIdentity(raw.toolCallId, "tool call identity", "toolCallId");
	const reviewId = reviewIdOverride ?? artifactIdentity(review.reviewId, "review identity", "reviewId");
	if (reviewIdOverride) artifactIdentity(review.reviewId, "review identity", "reviewId");
	artifactIdentity(reviewId, "review identity", "reviewId");
	const title = boundedTitle(review.title, "review title");
	if (!Array.isArray(review.files) || review.files.length === 0 || review.files.length > MAX_REVIEW_PAYLOAD_FILES) {
		throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", `Review must contain 1-${MAX_REVIEW_PAYLOAD_FILES} files`);
	}
	if (typeof review.replace !== "boolean") throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Invalid replacement setting");

	const seen = new Set<string>();
	let totalBytes = 0;
	const files = review.files.map((entry, index): CanonicalReviewPayloadFile => {
		if (!isPlainObject(entry) || Object.keys(entry).some((key) => !new Set(["fileId", "title", "markdown"]).has(key))) {
			throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", `Invalid review file ${index + 1}`);
		}
		const fileId = artifactIdentity(entry.fileId, `file ${index + 1} identity`, "fileId");
		if (seen.has(fileId)) throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Duplicate review file identity");
		seen.add(fileId);
		const fileTitle = boundedTitle(entry.title, `file ${index + 1} title`);
		if (typeof entry.markdown !== "string") throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", `Invalid review file ${index + 1} content`);
		const bytes = utf8Bytes(entry.markdown);
		totalBytes += bytes;
		if (totalBytes > MAX_REVIEW_MARKDOWN_BYTES) {
			throw new ReviewPayloadError(413, "REVIEW_PAYLOAD_TOO_LARGE", "Review content exceeds the 10 MiB UTF-8 limit");
		}
		return { fileId, title: fileTitle, markdown: entry.markdown, bytes };
	});
	const activeFileId = artifactIdentity(review.activeFileId, "active file identity", "fileId");
	if (!seen.has(activeFileId)) throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Active file is not part of the review");

	const metadataBytes = utf8Bytes(JSON.stringify({ toolCallId, reviewId, title, activeFileId, replace: review.replace, files: files.map(({ fileId, title, bytes }) => ({ fileId, title, bytes })) }));
	if (metadataBytes > MAX_REVIEW_RECEIPT_METADATA_BYTES) throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Review metadata is too large");

	return {
		action: "review_open",
		version: 2,
		sessionId,
		toolCallId,
		reviewId,
		title,
		files,
		activeFileId,
		replace: review.replace,
		totalBytes,
	};
}

export function validateReviewPayloadUpload(sessionId: string, raw: unknown, reviewIdOverride?: string): Omit<CanonicalReviewPayload, "payloadId" | "hash" | "createdAt"> {
	return coerceUploadBody(sessionId, raw, reviewIdOverride);
}

function sessionDir(sessionId: string): string {
	validateSessionId(sessionId);
	return path.join(reviewPayloadRoot(), sessionId);
}

function payloadDir(sessionId: string, payloadId: string): string {
	validatePayloadId(payloadId);
	return path.join(sessionDir(sessionId), payloadId);
}

function createPayloadId(): string {
	return randomBytes(18).toString("base64url");
}

export interface ReviewPayloadPersistenceOptions {
	/** Must be called while the owning ReviewPayloadSessionCoordinator is held. */
	enforceSessionQuota?: boolean;
	/** Narrow injection seam for bounded quota tests. */
	quota?: { maxCount: number; maxBytes: number };
}

async function sessionStorageUsage(ownerDir: string): Promise<{ count: number; bytes: number }> {
	let children: fs.Dirent[];
	try {
		children = await fs.promises.readdir(ownerDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { count: 0, bytes: 0 };
		throw new ReviewPayloadError(500, "REVIEW_PAYLOAD_PERSISTENCE_FAILED", "Review content storage could not be inspected", true);
	}
	let count = 0;
	let bytes = 0;
	for (const child of children) {
		if (child.name.startsWith(".tmp-") || !child.isDirectory() || child.isSymbolicLink()) continue;
		try {
			const stat = await fs.promises.lstat(path.join(ownerDir, child.name, PAYLOAD_FILE));
			if (!stat.isFile() || stat.isSymbolicLink()) continue;
			count += 1;
			bytes += stat.size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
			throw new ReviewPayloadError(500, "REVIEW_PAYLOAD_PERSISTENCE_FAILED", "Review content storage could not be inspected", true);
		}
	}
	return { count, bytes };
}

function quotaError(): ReviewPayloadError {
	return new ReviewPayloadError(507, "REVIEW_PAYLOAD_QUOTA_EXCEEDED", "Review content storage is full for this session");
}

export async function persistReviewPayload(
	sessionId: string,
	raw: unknown,
	reviewIdOverride?: string,
	options: ReviewPayloadPersistenceOptions = {},
): Promise<CanonicalReviewPayload> {
	const base = coerceUploadBody(sessionId, raw, reviewIdOverride);
	const ownerDir = sessionDir(sessionId);
	const hash = payloadHash(base);
	let payloadId = createPayloadId();
	let createdAt = Date.now();
	let payload: CanonicalReviewPayload = { ...base, payloadId, hash, createdAt };
	let serialized = JSON.stringify(payload);

	if (options.enforceSessionQuota) {
		const quota = options.quota ?? {
			maxCount: MAX_REVIEW_PAYLOADS_PER_SESSION,
			maxBytes: MAX_REVIEW_PAYLOAD_SESSION_STORAGE_BYTES,
		};
		const usage = await sessionStorageUsage(ownerDir);
		const prospectiveBytes = utf8Bytes(serialized);
		if (usage.count + 1 > quota.maxCount || usage.bytes + prospectiveBytes > quota.maxBytes) throw quotaError();
	}

	// Admission is complete before the owner or temp directory is created. Route
	// callers hold the per-session coordinator across this entire write.
	try {
		await fs.promises.mkdir(ownerDir, { recursive: true });
	} catch {
		throw new ReviewPayloadError(500, "REVIEW_PAYLOAD_PERSISTENCE_FAILED", "Review content could not be saved", true);
	}

	for (let attempt = 0; attempt < 5; attempt++) {
		const finalDir = payloadDir(sessionId, payloadId);
		const tmpDir = path.join(ownerDir, `.tmp-${payloadId}-${process.pid}-${Date.now()}-${attempt}`);
		try {
			await fs.promises.mkdir(tmpDir, { recursive: false, mode: 0o700 });
			await fs.promises.writeFile(path.join(tmpDir, PAYLOAD_FILE), serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
			await fs.promises.rename(tmpDir, finalDir);
			return payload;
		} catch (error) {
			await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code === "EEXIST" || code === "ENOTEMPTY") {
				payloadId = createPayloadId();
				createdAt = Date.now();
				payload = { ...base, payloadId, hash, createdAt };
				serialized = JSON.stringify(payload);
				continue;
			}
			throw new ReviewPayloadError(500, "REVIEW_PAYLOAD_PERSISTENCE_FAILED", "Review content could not be saved", true);
		}
	}
	throw new ReviewPayloadError(500, "REVIEW_PAYLOAD_PERSISTENCE_FAILED", "Review content could not be saved", true);
}

function coerceStoredPayload(raw: unknown): CanonicalReviewPayload | null {
	if (!isPlainObject(raw) || raw.action !== "review_open" || raw.version !== 2 || typeof raw.createdAt !== "number" || !Number.isSafeInteger(raw.createdAt) || raw.createdAt <= 0) return null;
	if (typeof raw.payloadId !== "string" || typeof raw.hash !== "string" || !/^[a-f0-9]{64}$/.test(raw.hash)) return null;
	let base: Omit<CanonicalReviewPayload, "payloadId" | "hash" | "createdAt">;
	try {
		base = coerceUploadBody(raw.sessionId as string, {
			toolCallId: raw.toolCallId,
			review: {
				reviewId: raw.reviewId,
				title: raw.title,
				files: Array.isArray(raw.files) ? raw.files.map((file) => isPlainObject(file) ? { fileId: file.fileId, title: file.title, markdown: file.markdown } : file) : raw.files,
				activeFileId: raw.activeFileId,
				replace: raw.replace,
			},
		});
	} catch {
		return null;
	}
	try { validatePayloadId(raw.payloadId); } catch { return null; }
	if (raw.totalBytes !== base.totalBytes) return null;
	if (!Array.isArray(raw.files) || raw.files.some((file, index) => !isPlainObject(file) || file.bytes !== base.files[index]?.bytes)) return null;
	const payload: CanonicalReviewPayload = { ...base, payloadId: raw.payloadId, hash: raw.hash, createdAt: raw.createdAt };
	return payloadHash(payload) === payload.hash ? payload : null;
}

export async function readReviewPayload(sessionId: string, payloadId: string): Promise<CanonicalReviewPayload> {
	validateSessionId(sessionId);
	validatePayloadId(payloadId);
	const dir = payloadDir(sessionId, payloadId);
	const file = path.join(dir, PAYLOAD_FILE);
	try {
		const [dirStat, fileStat] = await Promise.all([fs.promises.lstat(dir), fs.promises.lstat(file)]);
		if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > MAX_REVIEW_PAYLOAD_REQUEST_BYTES) {
			throw new ReviewPayloadError(404, "REVIEW_PAYLOAD_NOT_FOUND", "Review content is unavailable");
		}
		const parsed = JSON.parse(await fs.promises.readFile(file, "utf8"));
		const payload = coerceStoredPayload(parsed);
		if (!payload || payload.sessionId !== sessionId || payload.payloadId !== payloadId) {
			throw new ReviewPayloadError(409, "REVIEW_PAYLOAD_INVALID_REFERENCE", "Review content reference is invalid");
		}
		return payload;
	} catch (error) {
		if (error instanceof ReviewPayloadError) throw error;
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new ReviewPayloadError(404, "REVIEW_PAYLOAD_NOT_FOUND", "Review content is unavailable");
		throw new ReviewPayloadError(500, "REVIEW_PAYLOAD_READ_FAILED", "Review content could not be loaded", true);
	}
}

export function assertReviewPayloadReference(payload: CanonicalReviewPayload, reference: { toolCallId: unknown; reviewId: unknown; hash: unknown }): void {
	if (typeof reference.toolCallId !== "string" || !reference.toolCallId
		|| typeof reference.reviewId !== "string" || !reference.reviewId
		|| typeof reference.hash !== "string" || !reference.hash
		|| reference.toolCallId !== payload.toolCallId
		|| reference.reviewId !== payload.reviewId
		|| reference.hash !== payload.hash) {
		throw new ReviewPayloadError(409, "REVIEW_PAYLOAD_REFERENCE_MISMATCH", "Review content reference does not match", false);
	}
}

export function reviewPayloadReceipt(payload: CanonicalReviewPayload, automaticOpen: ReviewPayloadOpenOutcome): ReviewPayloadReceipt {
	return {
		action: "review_open",
		version: 2,
		toolCallId: payload.toolCallId,
		payloadId: payload.payloadId,
		reviewId: payload.reviewId,
		title: payload.title,
		activeFileId: payload.activeFileId,
		replace: payload.replace,
		totalBytes: payload.totalBytes,
		hash: payload.hash,
		files: payload.files.map(({ fileId, title, bytes }) => ({ fileId, title, bytes })),
		automaticOpen,
	};
}

export async function removeReviewPayloads(sessionId: string): Promise<void> {
	if (!VALID_SESSION_ID.test(sessionId)) return;
	await fs.promises.rm(path.join(reviewPayloadRoot(), sessionId), { recursive: true, force: true });
}

export async function sweepReviewPayloads(knownSessionIds: Iterable<string>): Promise<{ removed: string[]; kept: string[] }> {
	const known = new Set([...knownSessionIds].filter((id) => VALID_SESSION_ID.test(id)).map((id) => id.toLowerCase()));
	const removed: string[] = [];
	const kept: string[] = [];
	let entries: fs.Dirent[];
	try { entries = await fs.promises.readdir(reviewPayloadRoot(), { withFileTypes: true }); } catch { return { removed, kept }; }
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const candidate = path.join(reviewPayloadRoot(), entry.name);
		if (!VALID_SESSION_ID.test(entry.name) || !known.has(entry.name.toLowerCase())) {
			await fs.promises.rm(candidate, { recursive: true, force: true });
			removed.push(entry.name);
			continue;
		}
		kept.push(entry.name);
		const children = await fs.promises.readdir(candidate, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
		for (const child of children) {
			if (child.name.startsWith(".tmp-") && child.isDirectory() && !child.isSymbolicLink()) {
				await fs.promises.rm(path.join(candidate, child.name), { recursive: true, force: true });
			}
		}
	}
	return { removed: removed.sort(), kept: kept.sort() };
}

export type ReviewPayloadUploadBody = UploadBody;
