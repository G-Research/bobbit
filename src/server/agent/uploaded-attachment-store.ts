import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { decodeLikelyUtf8Text } from "../../shared/uploaded-attachment-text.js";
import { bobbitStateDir } from "../bobbit-dir.js";
import { decodeAttachmentDisplayPreview } from "./attachment-display.js";
import {
	boundServerDerivedDocumentText,
	deriveSpecializedDocumentText,
	MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES,
} from "./uploaded-specialized-document-extractor.js";

export const MAX_UPLOADED_ATTACHMENTS_PER_OCCURRENCE = 10;
export const MAX_UPLOADED_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOADED_ATTACHMENT_AGGREGATE_BYTES = 200 * 1024 * 1024;
export const MAX_UPLOADED_ATTACHMENT_SERIALIZED_SEND_BYTES = 200 * 1024 * 1024;
export const MAX_UPLOADED_ATTACHMENT_READ_BYTES = 64 * 1024;
/**
 * Every range read verifies one complete, admission-bounded snapshot before
 * projecting bytes. Reserve the worst case up front so concurrent callers can
 * never turn the 64 KiB response API into unbounded gateway memory growth.
 */
export const MAX_UPLOADED_ATTACHMENT_SNAPSHOT_READ_RESERVATIONS = 2;
const MAX_UPLOADED_ATTACHMENT_SNAPSHOT_READ_RESERVED_BYTES =
	MAX_UPLOADED_ATTACHMENT_BYTES * MAX_UPLOADED_ATTACHMENT_SNAPSHOT_READ_RESERVATIONS;
/** Durable exact-byte snapshots retained by one session across prompt occurrences. */
export const MAX_UPLOADED_ATTACHMENT_SESSION_BYTES = 1024 * 1024 * 1024;
/**
 * Bound committed attachment records to at most 5,120 blobs plus 512 manifests
 * per session, while leaving substantially more room than the review store's
 * 64-record cap for realistic attachment-heavy sessions.
 */
export const MAX_UPLOADED_ATTACHMENT_OCCURRENCES_PER_SESSION = 512;

const VERSION = 1 as const;
const MANIFEST_FILE = "manifest.json";
const MAX_MANIFEST_BYTES = 128 * 1024;
/**
 * Charge the maximum committed manifest size instead of its variable serialized
 * length. This deterministic nonzero cost bounds metadata storage even for
 * zero-byte blobs and rebuilds identically from every validated manifest.
 */
export const UPLOADED_ATTACHMENT_OCCURRENCE_RECORD_BYTES = MAX_MANIFEST_BYTES;
const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const VALID_HASH = /^[a-f0-9]{64}$/;
const VALID_FILE_KEY = /^[A-Za-z0-9_-]{24}$/;
const POINTER_PATTERN = /^bobbit-attachment:v1:([a-f0-9]{64}):([a-f0-9]{64}):([A-Za-z0-9_-]{24})$/;
const INVALID_METADATA_CHARACTERS = /[\x00-\x1f\x7f]/;

export interface UploadedAttachmentSnapshotInput {
	id: string;
	type: "document";
	fileName: string;
	mimeType: string;
	size: number;
	content: string;
	extractedText?: string;
	preview?: string;
}

export interface StoredUploadedAttachmentMetadata {
	pointer: string;
	fileName: string;
	mimeType: string;
	size: number;
	sha256: string;
}

export interface StoredUploadedDocumentDisplayMetadata {
	id: string;
	type: "document";
	fileName: string;
	mimeType: string;
	size: number;
	preview?: string;
}

export interface StoredUploadedAttachmentOccurrence {
	occurrenceId: string;
	attachments: Array<StoredUploadedAttachmentMetadata & { trustedExtractedText?: string }>;
	/** Store-validated presentation data whose preview bytes own occurrence quota. */
	displayAttachments: StoredUploadedDocumentDisplayMetadata[];
}

export interface UploadedAttachmentRange {
	pointer: string;
	fileName: string;
	mimeType: string;
	size: number;
	offset: number;
	length: number;
	bytesRead: number;
	nextOffset: number;
	eof: boolean;
	encoding: "base64";
	data: string;
}

interface ManifestAttachment extends StoredUploadedAttachmentMetadata {
	id: string;
	fileKey: string;
	trustedExtractedText?: string;
	previewSize?: number;
	previewSha256?: string;
}

interface Manifest {
	version: typeof VERSION;
	sessionId: string;
	occurrenceId: string;
	sessionKey: string;
	occurrenceKey: string;
	contentDigest: string;
	createdAt: number;
	attachments: ManifestAttachment[];
}

interface CanonicalInput {
	id: string;
	fileName: string;
	mimeType: string;
	size: number;
	bytes: Buffer;
	sha256: string;
	trustedExtractedText?: string;
	preview?: string;
	previewSize?: number;
	previewSha256?: string;
}

export class UploadedAttachmentStoreError extends Error {
	constructor(
		readonly statusCode: number,
		readonly code: string,
		message: string,
		readonly retryable = false,
	) {
		super(message);
		this.name = "UploadedAttachmentStoreError";
	}
}

export interface UploadedAttachmentStoreTestHooks {
	/** Runs after temporary bytes are written but before the occurrence is committed. */
	beforeCommit?: (input: { sessionId: string; occurrenceId: string }) => void | Promise<void>;
	/** Runs after a read snapshot is verified but before its requested range is returned. */
	afterReadIntegrityVerified?: (input: { sessionId: string; pointer: string }) => void | Promise<void>;
}

interface SessionUsage {
	bytes: number;
	occurrences: number;
}

let rootOverride: string | undefined;
let sessionQuotaOverride: number | undefined;
let sessionOccurrenceLimitOverride: number | undefined;
let testHooks: UploadedAttachmentStoreTestHooks | undefined;
const sessionUsage = new Map<string, SessionUsage>();
const purgedSessionKeys = new Set<string>();
const sessionOperationTails = new Map<string, Promise<unknown>>();
let uploadedAttachmentSnapshotReadReservedBytes = 0;

/**
 * Fail-fast process-wide ownership for the full verified snapshots retained by
 * range reads. Each owner reserves the maximum possible allocation before it
 * enters a per-session operation tail; no waiter queue is created.
 */
function acquireUploadedAttachmentSnapshotReadReservation(): () => void {
	if (uploadedAttachmentSnapshotReadReservedBytes
		> MAX_UPLOADED_ATTACHMENT_SNAPSHOT_READ_RESERVED_BYTES - MAX_UPLOADED_ATTACHMENT_BYTES) {
		throw new UploadedAttachmentStoreError(
			429,
			"UPLOADED_ATTACHMENT_BUSY",
			"Uploaded attachment reads are busy; retry later",
			true,
		);
	}
	uploadedAttachmentSnapshotReadReservedBytes += MAX_UPLOADED_ATTACHMENT_BYTES;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		uploadedAttachmentSnapshotReadReservedBytes -= MAX_UPLOADED_ATTACHMENT_BYTES;
	};
}

function withSessionOperation<T>(sessionKey: string, operation: () => Promise<T>): Promise<T> {
	const previous = (sessionOperationTails.get(sessionKey) ?? Promise.resolve()).then(
		() => undefined,
		() => undefined,
	);
	const running = previous.then(operation);
	const settled = running.then(
		() => undefined,
		() => undefined,
	);
	sessionOperationTails.set(sessionKey, settled);
	void settled.then(() => {
		if (sessionOperationTails.get(sessionKey) === settled) sessionOperationTails.delete(sessionKey);
	});
	return running;
}

export function setUploadedAttachmentRootForTesting(root: string | undefined): void {
	rootOverride = root;
	sessionQuotaOverride = undefined;
	sessionOccurrenceLimitOverride = undefined;
	testHooks = undefined;
	sessionUsage.clear();
	purgedSessionKeys.clear();
	sessionOperationTails.clear();
}

/** Narrow test seam for exercising the cumulative quota without large fixtures. */
export function setUploadedAttachmentSessionQuotaForTesting(bytes: number | undefined): void {
	if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0)) invalid("Invalid uploaded attachment session quota");
	sessionQuotaOverride = bytes;
}

/** Narrow test seam for exercising the committed occurrence cap. */
export function setUploadedAttachmentSessionOccurrenceLimitForTesting(limit: number | undefined): void {
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) invalid("Invalid uploaded attachment occurrence limit");
	sessionOccurrenceLimitOverride = limit;
}

/** Simulate process-local accounting loss; committed manifests remain authoritative. */
export function resetUploadedAttachmentUsageForTesting(): void {
	sessionUsage.clear();
}

export function setUploadedAttachmentStoreHooksForTesting(hooks: UploadedAttachmentStoreTestHooks | undefined): void {
	testHooks = hooks;
}

export function uploadedAttachmentRoot(): string {
	return rootOverride ?? path.join(bobbitStateDir(), "uploaded-attachments");
}

function invalid(message = "Uploaded attachment data is invalid"): never {
	throw new UploadedAttachmentStoreError(400, "UPLOADED_ATTACHMENT_INVALID", message);
}

function unavailable(message = "Uploaded attachment is unavailable"): never {
	throw new UploadedAttachmentStoreError(404, "UPLOADED_ATTACHMENT_NOT_FOUND", message);
}

function validateSessionId(sessionId: unknown): asserts sessionId is string {
	if (typeof sessionId !== "string" || !VALID_SESSION_ID.test(sessionId)) invalid("Invalid session identity");
}

function validateOccurrenceId(occurrenceId: unknown): asserts occurrenceId is string {
	if (typeof occurrenceId !== "string" || occurrenceId.length === 0 || Buffer.byteLength(occurrenceId, "utf8") > 1024) {
		invalid("Invalid attachment occurrence identity");
	}
}

function boundedMetadata(value: unknown, name: string, maxBytes: number): string {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes || INVALID_METADATA_CHARACTERS.test(value)) {
		invalid(`Invalid attachment ${name}`);
	}
	return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function hash(parts: string[]): string {
	const digest = createHash("sha256");
	for (const part of parts) digest.update(part, "utf8").update("\0", "utf8");
	return digest.digest("hex");
}

function keys(sessionId: string, occurrenceId: string): { sessionKey: string; occurrenceKey: string } {
	const sessionKey = hash(["uploaded-attachment-session-v1", sessionId]);
	return {
		sessionKey,
		occurrenceKey: hash(["uploaded-attachment-occurrence-v1", sessionKey, occurrenceId]),
	};
}

function pointerFor(sessionKey: string, occurrenceKey: string, fileKey: string): string {
	return `bobbit-attachment:v1:${sessionKey}:${occurrenceKey}:${fileKey}`;
}

function parsePointer(pointer: unknown): { sessionKey: string; occurrenceKey: string; fileKey: string } {
	if (typeof pointer !== "string" || pointer.length > 256) invalid("Invalid attachment pointer");
	const match = POINTER_PATTERN.exec(pointer);
	if (!match) invalid("Invalid attachment pointer");
	return { sessionKey: match[1], occurrenceKey: match[2], fileKey: match[3] };
}

function secureEqualHex(left: string, right: string): boolean {
	if (!VALID_HASH.test(left) || !VALID_HASH.test(right)) return false;
	return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isBase64Character(code: number): boolean {
	return (code >= 0x41 && code <= 0x5a)
		|| (code >= 0x61 && code <= 0x7a)
		|| (code >= 0x30 && code <= 0x39)
		|| code === 0x2b
		|| code === 0x2f;
}

function hasValidBase64Shape(value: string): boolean {
	if (value.length % 4 !== 0) return false;
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	const contentLength = value.length - padding;
	for (let index = 0; index < contentLength; index++) {
		if (!isBase64Character(value.charCodeAt(index))) return false;
	}
	return padding === 0 || contentLength >= 2;
}

function decodeBase64(value: unknown, declaredSize: unknown): Buffer {
	// Avoid a repeated-group regexp here: V8 can exhaust its regexp stack on a
	// valid attachment near the 20 MiB admission limit. This bounded linear scan
	// enforces the same alphabet/padding shape without another large allocation.
	if (typeof value !== "string" || !hasValidBase64Shape(value)) invalid("Invalid attachment base64 content");
	if (typeof declaredSize !== "number" || !Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_UPLOADED_ATTACHMENT_BYTES) {
		invalid("Invalid attachment size");
	}
	const bytes = Buffer.from(value, "base64");
	if (bytes.length !== declaredSize) invalid("Attachment size does not match its exact bytes");
	return bytes;
}

/**
 * Measure the canonical browser prompt frame covered by the existing composer
 * guard, including the send-time intent fields added by RemoteAgent. Admission
 * calls this before persistence so direct WS clients cannot bypass the same
 * serialized payload ceiling. The optional limit is a narrow
 * test seam that avoids allocating a production-sized fixture.
 */
export function assertUploadedAttachmentSerializedSendWithinLimit(input: {
	text: string;
	intentId?: string;
	images?: unknown[];
	attachments: unknown[];
	suppressTitleGen?: boolean;
}, limitBytes = MAX_UPLOADED_ATTACHMENT_SERIALIZED_SEND_BYTES): void {
	if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) invalid("Invalid serialized attachment send limit");
	let serialized: string;
	try {
		serialized = JSON.stringify({
			type: "prompt",
			...(input.intentId ? { intentId: input.intentId } : {}),
			text: input.text,
			...(input.images?.length ? { images: input.images } : {}),
			...(input.attachments.length ? { attachments: input.attachments } : {}),
			...(input.suppressTitleGen ? { suppressTitleGen: true } : {}),
		});
	} catch {
		invalid("Uploaded attachment prompt frame is not serializable");
	}
	if (Buffer.byteLength(serialized, "utf8") > limitBytes) {
		invalid("Uploaded attachment prompt exceeds the serialized send limit");
	}
}

async function canonicalInputs(raw: unknown): Promise<CanonicalInput[]> {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_UPLOADED_ATTACHMENTS_PER_OCCURRENCE) {
		invalid(`Uploaded attachment occurrence must contain 1-${MAX_UPLOADED_ATTACHMENTS_PER_OCCURRENCE} documents`);
	}
	const seenIds = new Set<string>();
	const inputs: CanonicalInput[] = [];
	let totalBytes = 0;
	for (let index = 0; index < raw.length; index++) {
		const candidate = raw[index];
		if (!isPlainObject(candidate)) invalid(`Invalid uploaded attachment ${index + 1}`);
		const allowed = new Set(["id", "type", "fileName", "mimeType", "size", "content", "extractedText", "preview"]);
		if (Object.keys(candidate).some((key) => !allowed.has(key))) invalid(`Invalid uploaded attachment ${index + 1} fields`);
		if (candidate.type !== "document") invalid("Only document attachments are stored by this mechanism");
		const id = boundedMetadata(candidate.id, "identity", 512);
		if (seenIds.has(id)) invalid("Duplicate attachment identity");
		seenIds.add(id);
		const fileName = boundedMetadata(candidate.fileName, "filename", 1024);
		const mimeType = boundedMetadata(candidate.mimeType, "MIME type", 512);
		if (candidate.extractedText !== undefined && typeof candidate.extractedText !== "string") invalid("Invalid extracted attachment text");
		const previewBytes = candidate.preview === undefined
			? undefined
			: decodeAttachmentDisplayPreview(candidate.preview);
		if (candidate.preview !== undefined && previewBytes === undefined) invalid("Invalid attachment preview");
		const bytes = decodeBase64(candidate.content, candidate.size);
		totalBytes += bytes.length;
		if (totalBytes > MAX_UPLOADED_ATTACHMENT_AGGREGATE_BYTES) invalid("Uploaded attachments exceed the aggregate byte limit");

		const specialized = await deriveSpecializedDocumentText({ fileName, mimeType, bytes });
		const decodedText = specialized.recognized ? specialized.text : decodeLikelyUtf8Text(bytes);
		const trustedExtractedText = decodedText === undefined ? undefined : boundServerDerivedDocumentText(decodedText);
		inputs.push({
			id,
			fileName,
			mimeType,
			size: bytes.length,
			bytes,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			...(trustedExtractedText === undefined ? {} : { trustedExtractedText }),
			...(previewBytes === undefined ? {} : {
				preview: candidate.preview as string,
				previewSize: previewBytes.length,
				previewSha256: createHash("sha256").update(previewBytes).digest("hex"),
			}),
		});
	}
	return inputs;
}

function contentDigest(sessionId: string, occurrenceId: string, attachments: CanonicalInput[]): string {
	return createHash("sha256").update(JSON.stringify({
		sessionId,
		occurrenceId,
		attachments: attachments.map(({ id, fileName, mimeType, size, sha256, previewSize, previewSha256 }) => ({
			id,
			fileName,
			mimeType,
			size,
			sha256,
			...(previewSize === undefined ? {} : { previewSize, previewSha256 }),
		})),
	}), "utf8").digest("hex");
}

function sessionDir(sessionKey: string): string {
	if (!VALID_HASH.test(sessionKey)) invalid("Invalid attachment session key");
	return path.join(uploadedAttachmentRoot(), sessionKey);
}

function occurrenceDir(sessionKey: string, occurrenceKey: string): string {
	if (!VALID_HASH.test(occurrenceKey)) invalid("Invalid attachment occurrence key");
	return path.join(sessionDir(sessionKey), occurrenceKey);
}

function sessionQuotaBytes(): number {
	return sessionQuotaOverride ?? MAX_UPLOADED_ATTACHMENT_SESSION_BYTES;
}

function sessionOccurrenceLimit(): number {
	return sessionOccurrenceLimitOverride ?? MAX_UPLOADED_ATTACHMENT_OCCURRENCES_PER_SESSION;
}

function coerceManifest(value: unknown): Manifest | null {
	if (!isPlainObject(value)
		|| value.version !== VERSION
		|| typeof value.sessionId !== "string"
		|| typeof value.occurrenceId !== "string"
		|| typeof value.sessionKey !== "string" || !VALID_HASH.test(value.sessionKey)
		|| typeof value.occurrenceKey !== "string" || !VALID_HASH.test(value.occurrenceKey)
		|| typeof value.contentDigest !== "string" || !VALID_HASH.test(value.contentDigest)
		|| typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0
		|| !Array.isArray(value.attachments)
		|| value.attachments.length === 0 || value.attachments.length > MAX_UPLOADED_ATTACHMENTS_PER_OCCURRENCE) return null;
	try {
		validateSessionId(value.sessionId);
		validateOccurrenceId(value.occurrenceId);
	} catch {
		return null;
	}
	const seenKeys = new Set<string>();
	const seenPointers = new Set<string>();
	const attachments: ManifestAttachment[] = [];
	for (const candidate of value.attachments) {
		if (!isPlainObject(candidate)
			|| typeof candidate.id !== "string"
			|| typeof candidate.pointer !== "string"
			|| typeof candidate.fileKey !== "string" || !VALID_FILE_KEY.test(candidate.fileKey)
			|| typeof candidate.fileName !== "string"
			|| typeof candidate.mimeType !== "string"
			|| typeof candidate.size !== "number" || !Number.isSafeInteger(candidate.size) || candidate.size < 0 || candidate.size > MAX_UPLOADED_ATTACHMENT_BYTES
			|| typeof candidate.sha256 !== "string" || !VALID_HASH.test(candidate.sha256)
			|| ((candidate.previewSize === undefined) !== (candidate.previewSha256 === undefined))
			|| (candidate.previewSize !== undefined
				&& (typeof candidate.previewSize !== "number"
					|| !Number.isSafeInteger(candidate.previewSize)
					|| candidate.previewSize < 0
					|| candidate.previewSize > MAX_UPLOADED_ATTACHMENT_BYTES
					|| typeof candidate.previewSha256 !== "string"
					|| !VALID_HASH.test(candidate.previewSha256)))
			|| (candidate.trustedExtractedText !== undefined
				&& (typeof candidate.trustedExtractedText !== "string"
					|| Buffer.byteLength(candidate.trustedExtractedText, "utf8") > MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES
					|| boundServerDerivedDocumentText(candidate.trustedExtractedText) !== candidate.trustedExtractedText))
			|| seenKeys.has(candidate.fileKey) || seenPointers.has(candidate.pointer)
			|| candidate.pointer !== pointerFor(value.sessionKey, value.occurrenceKey, candidate.fileKey)) return null;
		try {
			boundedMetadata(candidate.id, "identity", 512);
			boundedMetadata(candidate.fileName, "filename", 1024);
			boundedMetadata(candidate.mimeType, "MIME type", 512);
		} catch {
			return null;
		}
		seenKeys.add(candidate.fileKey);
		seenPointers.add(candidate.pointer);
		attachments.push(candidate as unknown as ManifestAttachment);
	}
	return { ...(value as unknown as Manifest), attachments };
}

async function loadManifest(sessionId: string, parsed: { sessionKey: string; occurrenceKey: string }): Promise<Manifest> {
	validateSessionId(sessionId);
	const expectedSessionKey = keys(sessionId, "placeholder").sessionKey;
	if (!secureEqualHex(parsed.sessionKey, expectedSessionKey)) unavailable();
	const dir = occurrenceDir(parsed.sessionKey, parsed.occurrenceKey);
	const manifestPath = path.join(dir, MANIFEST_FILE);
	try {
		const [dirStat, manifestStat] = await Promise.all([fs.promises.lstat(dir), fs.promises.lstat(manifestPath)]);
		if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) unavailable();
		const manifest = coerceManifest(JSON.parse(await fs.promises.readFile(manifestPath, "utf8")));
		if (!manifest
			|| manifest.sessionId !== sessionId
			|| !secureEqualHex(manifest.sessionKey, parsed.sessionKey)
			|| !secureEqualHex(manifest.occurrenceKey, parsed.occurrenceKey)
			|| keys(sessionId, manifest.occurrenceId).occurrenceKey !== parsed.occurrenceKey) unavailable();
		const byteStats = await Promise.all(manifest.attachments.map((attachment) =>
			fs.promises.lstat(path.join(dir, `${attachment.fileKey}.bin`)),
		));
		if (byteStats.some((stat, index) => !stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.attachments[index].size)) unavailable();
		return manifest;
	} catch (error) {
		if (error instanceof UploadedAttachmentStoreError) throw error;
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") unavailable();
		throw new UploadedAttachmentStoreError(500, "UPLOADED_ATTACHMENT_READ_FAILED", "Uploaded attachment could not be loaded", true);
	}
}

const SATURATED_SESSION_USAGE: Readonly<SessionUsage> = {
	bytes: Number.POSITIVE_INFINITY,
	occurrences: Number.POSITIVE_INFINITY,
};

async function rebuildSessionUsage(sessionId: string, sessionKey: string): Promise<SessionUsage> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(sessionDir(sessionKey), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { bytes: 0, occurrences: 0 };
		throw error;
	}
	let bytes = 0;
	let occurrences = 0;
	for (const entry of entries) {
		if (!VALID_HASH.test(entry.name)) continue;
		// A committed-looking record that is incomplete or corrupt remains
		// unreadable and saturates admission until session purge. Ignoring it would
		// let damaged records grant fresh capacity after an accounting rebuild.
		if (!entry.isDirectory() || entry.isSymbolicLink()) return { ...SATURATED_SESSION_USAGE };
		try {
			const manifest = await loadManifest(sessionId, { sessionKey, occurrenceKey: entry.name });
			if (occurrences === Number.MAX_SAFE_INTEGER) return { ...SATURATED_SESSION_USAGE };
			occurrences += 1;
			if (bytes > Number.MAX_SAFE_INTEGER - UPLOADED_ATTACHMENT_OCCURRENCE_RECORD_BYTES) {
				return { ...SATURATED_SESSION_USAGE };
			}
			bytes += UPLOADED_ATTACHMENT_OCCURRENCE_RECORD_BYTES;
			for (const attachment of manifest.attachments) {
				const ownedBytes = attachment.size + (attachment.previewSize ?? 0);
				if (!Number.isSafeInteger(ownedBytes) || bytes > Number.MAX_SAFE_INTEGER - ownedBytes) {
					return { ...SATURATED_SESSION_USAGE };
				}
				bytes += ownedBytes;
			}
		} catch (error) {
			if (error instanceof UploadedAttachmentStoreError && error.statusCode === 404) {
				return { ...SATURATED_SESSION_USAGE };
			}
			throw error;
		}
	}
	return { bytes, occurrences };
}

async function currentSessionUsage(sessionId: string, sessionKey: string): Promise<SessionUsage> {
	const cached = sessionUsage.get(sessionKey);
	if (cached !== undefined) return cached;
	const rebuilt = await rebuildSessionUsage(sessionId, sessionKey);
	sessionUsage.set(sessionKey, rebuilt);
	return rebuilt;
}

function publicOccurrence(manifest: Manifest): {
	occurrenceId: string;
	attachments: StoredUploadedAttachmentMetadata[];
} {
	return {
		occurrenceId: manifest.occurrenceId,
		attachments: manifest.attachments.map(({ pointer, fileName, mimeType, size, sha256 }) => ({ pointer, fileName, mimeType, size, sha256 })),
	};
}

function admittedOccurrence(manifest: Manifest, inputs: CanonicalInput[]): StoredUploadedAttachmentOccurrence {
	const occurrence = publicOccurrence(manifest);
	return {
		...occurrence,
		attachments: occurrence.attachments.map((attachment, index) => ({
			...attachment,
			...(manifest.attachments[index].trustedExtractedText === undefined
				? {}
				: { trustedExtractedText: manifest.attachments[index].trustedExtractedText }),
		})),
		displayAttachments: inputs.map(({ id, fileName, mimeType, size, preview }) => ({
			id,
			type: "document",
			fileName,
			mimeType,
			size,
			...(preview === undefined ? {} : { preview }),
		})),
	};
}

export async function persistUploadedAttachmentOccurrence(
	sessionId: string,
	occurrenceId: string,
	rawAttachments: unknown,
): Promise<StoredUploadedAttachmentOccurrence> {
	validateSessionId(sessionId);
	validateOccurrenceId(occurrenceId);
	const { sessionKey, occurrenceKey } = keys(sessionId, occurrenceId);
	return withSessionOperation(sessionKey, async () => {
		if (purgedSessionKeys.has(sessionKey)) unavailable();
		const inputs = await canonicalInputs(rawAttachments);
		const snapshotAndPreviewBytes = inputs.reduce((total, input) => total + input.size + (input.previewSize ?? 0), 0);
		const occurrenceBytes = snapshotAndPreviewBytes + UPLOADED_ATTACHMENT_OCCURRENCE_RECORD_BYTES;
		const digest = contentDigest(sessionId, occurrenceId, inputs);
		const finalDir = occurrenceDir(sessionKey, occurrenceKey);
		const ownerDir = sessionDir(sessionKey);

		const loadExisting = async (): Promise<StoredUploadedAttachmentOccurrence> => {
			const existing = await loadManifest(sessionId, { sessionKey, occurrenceKey });
			if (existing.contentDigest !== digest) {
				throw new UploadedAttachmentStoreError(409, "UPLOADED_ATTACHMENT_OCCURRENCE_CONFLICT", "Attachment occurrence was already accepted with different content");
			}
			return admittedOccurrence(existing, inputs);
		};

		try {
			await fs.promises.access(finalDir);
			return await loadExisting();
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				if (error instanceof UploadedAttachmentStoreError) throw error;
				throw new UploadedAttachmentStoreError(500, "UPLOADED_ATTACHMENT_PERSISTENCE_FAILED", "Uploaded attachment could not be saved", true);
			}
		}

		let usage: SessionUsage;
		try {
			usage = await currentSessionUsage(sessionId, sessionKey);
		} catch (error) {
			if (error instanceof UploadedAttachmentStoreError) throw error;
			throw new UploadedAttachmentStoreError(500, "UPLOADED_ATTACHMENT_PERSISTENCE_FAILED", "Uploaded attachment could not be saved", true);
		}
		if (!Number.isFinite(usage.bytes)
			|| !Number.isFinite(usage.occurrences)
			|| usage.occurrences >= sessionOccurrenceLimit()
			|| occurrenceBytes > sessionQuotaBytes() - usage.bytes) {
			throw new UploadedAttachmentStoreError(
				413,
				"UPLOADED_ATTACHMENT_QUOTA_EXCEEDED",
				"Uploaded attachment session storage quota exceeded",
			);
		}
		const committedUsage: SessionUsage = {
			bytes: usage.bytes + occurrenceBytes,
			occurrences: usage.occurrences + 1,
		};
		const fileKeys = inputs.map(() => randomBytes(18).toString("base64url"));
		const manifest: Manifest = {
			version: VERSION,
			sessionId,
			occurrenceId,
			sessionKey,
			occurrenceKey,
			contentDigest: digest,
			createdAt: Date.now(),
			attachments: inputs.map((input, index) => ({
				id: input.id,
				fileKey: fileKeys[index],
				pointer: pointerFor(sessionKey, occurrenceKey, fileKeys[index]),
				fileName: input.fileName,
				mimeType: input.mimeType,
				size: input.size,
				sha256: input.sha256,
				...(input.trustedExtractedText === undefined ? {} : { trustedExtractedText: input.trustedExtractedText }),
				...(input.previewSize === undefined ? {} : {
					previewSize: input.previewSize,
					previewSha256: input.previewSha256,
				}),
			})),
		};
		// Excerpts are best-effort context, while exact bytes and their pointer are
		// authoritative. Extremely escape-heavy metadata must never produce a
		// manifest the loader will reject, so shed excerpts from the end if needed.
		let serializedManifest = JSON.stringify(manifest);
		for (let index = manifest.attachments.length - 1; Buffer.byteLength(serializedManifest, "utf8") > MAX_MANIFEST_BYTES && index >= 0; index--) {
			delete manifest.attachments[index].trustedExtractedText;
			serializedManifest = JSON.stringify(manifest);
		}
		if (Buffer.byteLength(serializedManifest, "utf8") > MAX_MANIFEST_BYTES) invalid("Uploaded attachment metadata exceeds the manifest limit");

		const tmpDir = path.join(ownerDir, `.tmp-${occurrenceKey}-${process.pid}-${randomBytes(8).toString("hex")}`);
		try {
			await fs.promises.mkdir(ownerDir, { recursive: true, mode: 0o700 });
			await fs.promises.mkdir(tmpDir, { recursive: false, mode: 0o700 });
			for (let index = 0; index < inputs.length; index++) {
				await fs.promises.writeFile(path.join(tmpDir, `${fileKeys[index]}.bin`), inputs[index].bytes, { flag: "wx", mode: 0o600 });
			}
			await fs.promises.writeFile(path.join(tmpDir, MANIFEST_FILE), serializedManifest, { encoding: "utf8", flag: "wx", mode: 0o600 });
			await testHooks?.beforeCommit?.({ sessionId, occurrenceId });
			await fs.promises.rename(tmpDir, finalDir);
			sessionUsage.set(sessionKey, committedUsage);
			return admittedOccurrence(manifest, inputs);
		} catch (error) {
			await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
			await fs.promises.rmdir(ownerDir).catch(() => undefined);
			if ((error as NodeJS.ErrnoException)?.code === "EEXIST" || (error as NodeJS.ErrnoException)?.code === "ENOTEMPTY") {
				sessionUsage.delete(sessionKey);
				return loadExisting();
			}
			if (error instanceof UploadedAttachmentStoreError) throw error;
			throw new UploadedAttachmentStoreError(500, "UPLOADED_ATTACHMENT_PERSISTENCE_FAILED", "Uploaded attachment could not be saved", true);
		}
	});
}

export async function listUploadedAttachments(
	sessionId: string,
	pointer: string,
	expectedOccurrenceId?: string,
): Promise<StoredUploadedAttachmentMetadata[]> {
	const parsed = parsePointer(pointer);
	const manifest = await loadManifest(sessionId, parsed);
	if (expectedOccurrenceId !== undefined && manifest.occurrenceId !== expectedOccurrenceId) unavailable();
	if (!manifest.attachments.some((attachment) => attachment.fileKey === parsed.fileKey)) unavailable();
	return publicOccurrence(manifest).attachments;
}

export async function readUploadedAttachmentRange(input: {
	sessionId: string;
	pointer: string;
	offset?: number;
	length?: number;
	expectedOccurrenceId?: string;
}): Promise<UploadedAttachmentRange> {
	validateSessionId(input.sessionId);
	const parsed = parsePointer(input.pointer);
	const offset = input.offset ?? 0;
	const length = input.length ?? MAX_UPLOADED_ATTACHMENT_READ_BYTES;
	if (!Number.isSafeInteger(offset) || offset < 0) invalid("Attachment read offset must be a nonnegative integer");
	if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_UPLOADED_ATTACHMENT_READ_BYTES) {
		invalid(`Attachment read length must be an integer from 1 to ${MAX_UPLOADED_ATTACHMENT_READ_BYTES}`);
	}

	// Lock order is always global reservation then session tail. Persistence and
	// purge never need a global read reservation, so they cannot form a cycle.
	const releaseReservation = acquireUploadedAttachmentSnapshotReadReservation();
	const { sessionKey } = keys(input.sessionId, "placeholder");
	try {
		return await withSessionOperation(sessionKey, async () => {
			// Purge installs this process-lifetime fence while owning the same tail.
			// A read is therefore wholly before purge or fails wholly after it.
			if (purgedSessionKeys.has(sessionKey)) unavailable();
			const manifest = await loadManifest(input.sessionId, parsed);
			if (input.expectedOccurrenceId !== undefined && manifest.occurrenceId !== input.expectedOccurrenceId) unavailable();
			const attachment = manifest.attachments.find((candidate) => candidate.fileKey === parsed.fileKey);
			if (!attachment) unavailable();
			if (offset > attachment.size) throw new UploadedAttachmentStoreError(416, "UPLOADED_ATTACHMENT_RANGE_INVALID", "Attachment read offset is beyond the end of the snapshot");

			const file = path.join(occurrenceDir(parsed.sessionKey, parsed.occurrenceKey), `${parsed.fileKey}.bin`);
			let handle: fs.promises.FileHandle | undefined;
			try {
				const fileStat = await fs.promises.lstat(file);
				if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== attachment.size) unavailable();
				handle = await fs.promises.open(file, "r");
				const openedStat = await handle.stat();
				if (!openedStat.isFile() || openedStat.size !== attachment.size) unavailable();

				// Files are admission-bounded to 20 MiB. Read that bounded immutable view
				// once, verify the persisted digest, then slice the in-memory snapshot. A
				// path replacement after open cannot redirect the handle, and a same-inode
				// mutation during the read either fails the exact-length checks or digest.
				const snapshot = Buffer.alloc(attachment.size);
				let snapshotBytesRead = 0;
				while (snapshotBytesRead < snapshot.length) {
					const result = await handle.read(snapshot, snapshotBytesRead, snapshot.length - snapshotBytesRead, snapshotBytesRead);
					if (result.bytesRead === 0) unavailable();
					snapshotBytesRead += result.bytesRead;
				}
				const verifiedStat = await handle.stat();
				if (!verifiedStat.isFile() || verifiedStat.size !== attachment.size) unavailable();
				const snapshotSha256 = createHash("sha256").update(snapshot).digest("hex");
				if (!secureEqualHex(snapshotSha256, attachment.sha256)) unavailable();
				await testHooks?.afterReadIntegrityVerified?.({ sessionId: input.sessionId, pointer: input.pointer });

				const requested = Math.min(length, attachment.size - offset);
				const range = snapshot.subarray(offset, offset + requested);
				const nextOffset = offset + range.length;
				return {
					pointer: attachment.pointer,
					fileName: attachment.fileName,
					mimeType: attachment.mimeType,
					size: attachment.size,
					offset,
					length,
					bytesRead: range.length,
					nextOffset,
					eof: nextOffset === attachment.size,
					encoding: "base64",
					data: range.toString("base64"),
				};
			} catch (error) {
				if (error instanceof UploadedAttachmentStoreError) throw error;
				if ((error as NodeJS.ErrnoException)?.code === "ENOENT") unavailable();
				throw new UploadedAttachmentStoreError(500, "UPLOADED_ATTACHMENT_READ_FAILED", "Uploaded attachment could not be read", true);
			} finally {
				await handle?.close().catch(() => undefined);
			}
		});
	} finally {
		releaseReservation();
	}
}

export async function purgeUploadedAttachments(sessionId: string): Promise<void> {
	if (!VALID_SESSION_ID.test(sessionId)) return;
	const { sessionKey } = keys(sessionId, "placeholder");
	await withSessionOperation(sessionKey, async () => {
		// The permanent process-lifetime fence is installed before deletion so a
		// persist already queued behind this purge cannot recreate the owner dir.
		purgedSessionKeys.add(sessionKey);
		await fs.promises.rm(sessionDir(sessionKey), { recursive: true, force: true });
		sessionUsage.delete(sessionKey);
	});
}

export async function sweepUploadedAttachments(knownSessionIds: Iterable<string>): Promise<{ removed: string[]; kept: string[] }> {
	const knownByKey = new Map(
		[...knownSessionIds]
			.filter((id) => VALID_SESSION_ID.test(id))
			.map((id) => [keys(id, "placeholder").sessionKey, id] as const),
	);
	const removed: string[] = [];
	const kept: string[] = [];
	let entries: fs.Dirent[];
	try { entries = await fs.promises.readdir(uploadedAttachmentRoot(), { withFileTypes: true }); } catch { return { removed, kept }; }
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const candidate = path.join(uploadedAttachmentRoot(), entry.name);
		const knownSessionId = knownByKey.get(entry.name);
		if (!VALID_HASH.test(entry.name) || !knownSessionId) {
			const remove = async () => {
				if (VALID_HASH.test(entry.name)) purgedSessionKeys.add(entry.name);
				await fs.promises.rm(candidate, { recursive: true, force: true });
				sessionUsage.delete(entry.name);
			};
			if (VALID_HASH.test(entry.name)) await withSessionOperation(entry.name, remove);
			else await remove();
			removed.push(entry.name);
			continue;
		}
		await withSessionOperation(entry.name, async () => {
			if (purgedSessionKeys.has(entry.name)) {
				await fs.promises.rm(candidate, { recursive: true, force: true });
				sessionUsage.delete(entry.name);
				removed.push(entry.name);
				return;
			}
			const children = await fs.promises.readdir(candidate, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
			for (const child of children) {
				if (child.name.startsWith(".tmp-") && child.isDirectory() && !child.isSymbolicLink()) {
					await fs.promises.rm(path.join(candidate, child.name), { recursive: true, force: true });
				}
			}
			sessionUsage.set(entry.name, await rebuildSessionUsage(knownSessionId, entry.name));
			kept.push(entry.name);
		});
	}
	return { removed: removed.sort(), kept: kept.sort() };
}
