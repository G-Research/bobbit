/**
 * Bobbit-owned author persistence for Pi user-role prompt echoes.
 *
 * The v2 ledger is private server state at
 * `<serverSecretsDir>/author-sidecar/<sessionId>.jsonl`. Prompt text is never
 * persisted: correlation uses a domain-separated keyed HMAC. Pi transcripts
 * remain untouched. Runtime reads/appends degrade safely; startup migration of
 * reachable v1 plaintext fails closed if the plaintext source cannot be removed.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMessageAuthor, type MessageAuthor } from "../../shared/message-author.js";
import { isPromptSource, type PromptSource } from "../../shared/prompt-source.js";
import { serverSecretsDir } from "../bobbit-dir.js";
import { loadOrCreateCookieSigningKey } from "../auth/cookie-signing-key.js";
import {
	isToolResultOnlyMessage,
	normalizeVisibleMessages,
	type NormalizeVisibleMessageContext,
} from "./message-author.js";

export interface PromptAuthorDispatchRecord {
	schemaVersion: 2;
	type: "prompt-author";
	promptId: string;
	dispatchedAt: number;
	modelTextDigest: string;
	source: PromptSource;
	author: MessageAuthor;
}

export interface PromptAuthorSettlementRecord {
	schemaVersion: 2;
	type: "prompt-author-settlement";
	promptId: string;
	settledAt: number;
	outcome: "echoed" | "cancelled";
	messageId?: string;
	messageTimestamp?: number;
}

export type AuthorSidecarRecord = PromptAuthorDispatchRecord | PromptAuthorSettlementRecord;

/** Callers still provide exact prompt text in memory; append immediately hashes it. */
export interface PromptAuthorDispatchInput {
	schemaVersion?: 1 | 2;
	type?: "prompt-author";
	promptId: string;
	dispatchedAt: number;
	modelText: string;
	source: PromptSource;
	author: MessageAuthor;
}

export interface PromptAuthorSettlementInput {
	schemaVersion?: 1 | 2;
	type?: "prompt-author-settlement";
	promptId: string;
	settledAt: number;
	outcome: "echoed" | "cancelled";
	messageId?: string;
	messageTimestamp?: number;
}

/**
 * Folded runtime binding. `modelText` exists only on legacy/in-memory test
 * bindings; v2 disk reads expose only `modelTextDigest`.
 */
export interface PromptAuthorBinding {
	schemaVersion: 1 | 2;
	type: "prompt-author";
	promptId: string;
	dispatchedAt: number;
	modelText?: string;
	modelTextDigest?: string;
	source: PromptSource;
	author: MessageAuthor;
	settlement?: {
		schemaVersion: 1 | 2;
		type: "prompt-author-settlement";
		promptId: string;
		settledAt: number;
		outcome: "echoed" | "cancelled";
		messageId?: string;
		messageTimestamp?: number;
	};
}

export interface InitAuthorSidecarOptions {
	/** Private server-owned root. Defaults to the canonical server secrets dir. */
	secretsDir?: string;
	/** Stable server key material. Defaults to the cookie-signing key. */
	hmacKey?: Buffer;
	/** Permission test seam. */
	platform?: NodeJS.Platform;
}

export interface CopyAuthorSidecarOptions {
	/** Exact cloned Pi JSONL. When supplied, only transcript-confirmed bindings copy. */
	transcript?: string | null;
}

interface LegacyPromptAuthorDispatchRecord {
	schemaVersion: 1;
	type: "prompt-author";
	promptId: string;
	dispatchedAt: number;
	modelText: string;
	source: PromptSource;
	author: MessageAuthor;
}

interface LegacyPromptAuthorSettlementRecord {
	schemaVersion: 1;
	type: "prompt-author-settlement";
	promptId: string;
	settledAt: number;
	outcome: "echoed" | "cancelled";
	messageId?: string;
	messageTimestamp?: number;
}

const CORRELATION_TOLERANCE_MS = 2_000;
const MAX_KEY_LENGTH = 256;
const MAX_DIAGNOSTIC_VALUE_LENGTH = 512;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIDECAR_KEY_DOMAIN = "bobbit/author-sidecar/v2/key\0";
const PROMPT_DIGEST_DOMAIN = "bobbit/author-sidecar/v2/prompt-text\0";
let sidecarDir: string | undefined;
let promptDigestKey: Buffer | undefined;
let sidecarPlatform: NodeJS.Platform = process.platform;

function validKey(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_KEY_LENGTH;
}

function validTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validDigest(value: unknown): value is string {
	return typeof value === "string" && DIGEST_PATTERN.test(value);
}

/** Quote, control-character escape, and bound values before plain-text logging. */
function diagnosticValue(value: unknown): string {
	const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
	return JSON.stringify(text).slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH);
}

function isDispatchRecord(value: unknown): value is PromptAuthorDispatchRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.schemaVersion === 2
		&& record.type === "prompt-author"
		&& validKey(record.promptId)
		&& validTimestamp(record.dispatchedAt)
		&& validDigest(record.modelTextDigest)
		&& isPromptSource(record.source)
		&& isMessageAuthor(record.author);
}

function isSettlementRecord(value: unknown): value is PromptAuthorSettlementRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.schemaVersion === 2
		&& record.type === "prompt-author-settlement"
		&& validKey(record.promptId)
		&& validTimestamp(record.settledAt)
		&& (record.outcome === "echoed" || record.outcome === "cancelled")
		&& (record.messageId === undefined || validKey(record.messageId))
		&& (record.messageTimestamp === undefined || validTimestamp(record.messageTimestamp));
}

function isLegacyDispatchRecord(value: unknown): value is LegacyPromptAuthorDispatchRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.schemaVersion === 1
		&& record.type === "prompt-author"
		&& validKey(record.promptId)
		&& validTimestamp(record.dispatchedAt)
		&& typeof record.modelText === "string"
		&& isPromptSource(record.source)
		&& isMessageAuthor(record.author);
}

function isLegacySettlementRecord(value: unknown): value is LegacyPromptAuthorSettlementRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.schemaVersion === 1
		&& record.type === "prompt-author-settlement"
		&& validKey(record.promptId)
		&& validTimestamp(record.settledAt)
		&& (record.outcome === "echoed" || record.outcome === "cancelled")
		&& (record.messageId === undefined || validKey(record.messageId))
		&& (record.messageTimestamp === undefined || validTimestamp(record.messageTimestamp));
}

/** Reconstruct accepted rows so unknown properties can never carry plaintext. */
function canonicalAuthor(author: MessageAuthor): MessageAuthor {
	return { kind: author.kind, id: author.id, label: author.label };
}

function canonicalDispatchRecord(record: PromptAuthorDispatchRecord): PromptAuthorDispatchRecord {
	return {
		schemaVersion: 2,
		type: "prompt-author",
		promptId: record.promptId,
		dispatchedAt: record.dispatchedAt,
		modelTextDigest: record.modelTextDigest,
		source: record.source,
		author: canonicalAuthor(record.author),
	};
}

function canonicalSettlementRecord(record: PromptAuthorSettlementRecord): PromptAuthorSettlementRecord {
	return {
		schemaVersion: 2,
		type: "prompt-author-settlement",
		promptId: record.promptId,
		settledAt: record.settledAt,
		outcome: record.outcome,
		...(record.messageId === undefined ? {} : { messageId: record.messageId }),
		...(record.messageTimestamp === undefined ? {} : { messageTimestamp: record.messageTimestamp }),
	};
}

function canonicalRecord(record: AuthorSidecarRecord): AuthorSidecarRecord {
	return record.type === "prompt-author"
		? canonicalDispatchRecord(record)
		: canonicalSettlementRecord(record);
}

function isPromptAuthorBinding(value: unknown): value is PromptAuthorBinding {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if ((record.schemaVersion !== 1 && record.schemaVersion !== 2)
		|| record.type !== "prompt-author"
		|| !validKey(record.promptId)
		|| !validTimestamp(record.dispatchedAt)
		|| !isPromptSource(record.source)
		|| !isMessageAuthor(record.author)) return false;
	const hasLegacyText = typeof record.modelText === "string";
	const hasDigest = validDigest(record.modelTextDigest);
	return hasLegacyText || hasDigest;
}

function derivePromptDigestKey(keyMaterial: Buffer): Buffer {
	if (!Buffer.isBuffer(keyMaterial) || keyMaterial.length < 32) {
		throw new Error("Author-sidecar HMAC key must contain at least 32 bytes");
	}
	return crypto.createHmac("sha256", keyMaterial).update(SIDECAR_KEY_DOMAIN, "utf8").digest();
}

/** Stable keyed digest of the exact prompt text. Undefined before initialization. */
export function digestPromptModelText(modelText: string): string | undefined {
	if (!promptDigestKey) return undefined;
	return crypto.createHmac("sha256", promptDigestKey)
		.update(PROMPT_DIGEST_DOMAIN, "utf8")
		.update(modelText, "utf8")
		.digest("base64url");
}

/** Compare exact in-memory legacy text or a v2 HMAC without revealing disk text. */
export function promptAuthorBindingMatchesText(
	binding: Pick<PromptAuthorBinding, "modelText" | "modelTextDigest">,
	modelText: string,
): boolean {
	if (validDigest(binding.modelTextDigest)) {
		const candidate = digestPromptModelText(modelText);
		if (!candidate) return false;
		const left = Buffer.from(binding.modelTextDigest, "base64url");
		const right = Buffer.from(candidate, "base64url");
		return left.length === right.length && crypto.timingSafeEqual(left, right);
	}
	return typeof binding.modelText === "string" && binding.modelText === modelText;
}

function enforceDirectoryMode(target: string): void {
	const stat = fs.lstatSync(target);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error("Author-sidecar path must be a real directory");
	}
	if (sidecarPlatform === "win32") return;
	fs.chmodSync(target, 0o700);
	const mode = fs.lstatSync(target).mode & 0o777;
	if (mode !== 0o700) throw new Error(`Author-sidecar directory mode is ${mode.toString(8)}, expected 700`);
}

function ensurePrivateDirectory(target: string): void {
	fs.mkdirSync(target, { recursive: true, mode: 0o700 });
	enforceDirectoryMode(target);
}

function getSidecarDir(): string | undefined {
	if (!sidecarDir || !promptDigestKey) return undefined;
	try {
		ensurePrivateDirectory(sidecarDir);
		return sidecarDir;
	} catch (error) {
		console.warn(`[author-sidecar] Private sidecar directory is unavailable at ${sidecarDir}:`, error);
		return undefined;
	}
}

function filePath(sessionId: string): string | undefined {
	const dir = getSidecarDir();
	if (!dir) return undefined;
	const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160) || "unknown";
	return path.join(dir, `${safe}.jsonl`);
}

function secureOpenFlags(baseFlags: number): number {
	if (sidecarPlatform === "win32") return baseFlags;
	return baseFlags | (fs.constants.O_NOFOLLOW ?? 0);
}

function secureFileDescriptor(fd: number): void {
	const stat = fs.fstatSync(fd);
	if (!stat.isFile()) throw new Error("Author-sidecar ledger must be a regular file");
	if (sidecarPlatform === "win32") return;
	fs.fchmodSync(fd, 0o600);
	const mode = fs.fstatSync(fd).mode & 0o777;
	if (mode !== 0o600) throw new Error(`Author-sidecar file mode is ${mode.toString(8)}, expected 600`);
}

function writeAll(fd: number, value: Buffer): void {
	let offset = 0;
	while (offset < value.length) {
		// Only canonical v2 ledger JSON reaches this private, non-executable file;
		// paths are server-rooted and prompt bodies have already become keyed HMACs.
		// codeql[js/http-to-file-access] Intentional bounded metadata ledger write, not an arbitrary upload.
		const written = fs.writeSync(fd, value, offset, value.length - offset, null);
		if (!Number.isSafeInteger(written) || written <= 0) throw new Error("Author-sidecar write was incomplete");
		offset += written;
	}
}

function appendLineSecure(target: string, line: string): void {
	let fd: number | undefined;
	try {
		fd = fs.openSync(
			target,
			secureOpenFlags(fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY),
			0o600,
		);
		secureFileDescriptor(fd);
		writeAll(fd, Buffer.from(line, "utf8"));
		fs.fsyncSync(fd);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function fsyncDirectory(target: string): void {
	if (sidecarPlatform === "win32") return;
	let fd: number | undefined;
	try {
		// O_RDONLY cannot create a temporary file; this directory descriptor only
		// makes the preceding rename/unlink durable.
		// codeql[js/insecure-temporary-file] Non-creating directory fsync open.
		fd = fs.openSync(target, fs.constants.O_RDONLY);
		fs.fsyncSync(fd);
	} catch (error) {
		if (!["EACCES", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"].includes(
			(error as NodeJS.ErrnoException)?.code ?? "",
		)) throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function readSecureText(target: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(target, secureOpenFlags(fs.constants.O_RDONLY));
		secureFileDescriptor(fd);
		return fs.readFileSync(fd, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function writeSecureReplacement(target: string, text: string): void {
	const suffix = crypto.randomBytes(9).toString("base64url");
	const temp = `${target}.${process.pid}.${suffix}.tmp`;
	let fd: number | undefined;
	let tempCreated = false;
	try {
		fd = fs.openSync(temp, secureOpenFlags(fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY), 0o600);
		tempCreated = true;
		secureFileDescriptor(fd);
		writeAll(fd, Buffer.from(text, "utf8"));
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		if (sidecarPlatform === "win32") {
			// Windows rename does not replace an existing destination atomically.
			try { fs.unlinkSync(target); } catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
			}
		}
		// POSIX rename atomically replaces the prior ledger, preserving it until
		// the fully written/fsynced replacement is publishable.
		fs.renameSync(temp, target);
		tempCreated = false;
		fsyncDirectory(path.dirname(target));
		const stat = fs.lstatSync(target);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Author-sidecar replacement is not a regular file");
		if (sidecarPlatform !== "win32") {
			fs.chmodSync(target, 0o600);
			if ((fs.lstatSync(target).mode & 0o777) !== 0o600) throw new Error("Author-sidecar replacement mode is not 600");
		}
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		if (tempCreated) {
			try { fs.unlinkSync(temp); } catch { /* best-effort temporary cleanup */ }
		}
	}
}

function appendRecord(sessionId: string, record: AuthorSidecarRecord): boolean {
	const target = filePath(sessionId);
	if (!target) return false;
	try {
		appendLineSecure(target, `${JSON.stringify(record)}\n`);
		return true;
	} catch (error) {
		console.warn(`[author-sidecar] Append failed for session ${sessionId}:`, error);
		return false;
	}
}

function recordsFromText(text: string): AuthorSidecarRecord[] {
	const records: AuthorSidecarRecord[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isDispatchRecord(parsed) || isSettlementRecord(parsed)) records.push(canonicalRecord(parsed));
		} catch { /* a partial final line is expected after some crashes */ }
	}
	return records;
}

function replaceSessionRecords(sessionId: string, records: AuthorSidecarRecord[]): boolean {
	const target = filePath(sessionId);
	if (!target) return false;
	try {
		if (records.length === 0) {
			try { fs.unlinkSync(target); } catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
			}
			return true;
		}
		writeSecureReplacement(target, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		return true;
	} catch (error) {
		console.warn(`[author-sidecar] Replacement failed for session ${sessionId}:`, error);
		return false;
	}
}

interface LegacyFileSnapshot {
	text: string;
	stat: fs.Stats;
}

function readClaimedLegacyFile(legacyFile: string): LegacyFileSnapshot {
	let fd: number | undefined;
	try {
		// O_RDONLY cannot create a temporary file; O_NOFOLLOW additionally rejects
		// a raced symlink before this claimed legacy inode is read and unlinked.
		// codeql[js/insecure-temporary-file] Non-creating, no-follow migration read.
		fd = fs.openSync(legacyFile, secureOpenFlags(fs.constants.O_RDONLY));
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) throw new Error("Claimed legacy author sidecar is not a regular file");
		return { text: fs.readFileSync(fd, "utf8"), stat };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function migrateLegacyFile(legacyFile: string, sessionId: string, legacyDir: string): void {
	const snapshot = readClaimedLegacyFile(legacyFile);
	const migrated: AuthorSidecarRecord[] = [];
	for (const line of snapshot.text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isLegacyDispatchRecord(parsed)) {
				const modelTextDigest = digestPromptModelText(parsed.modelText);
				if (!modelTextDigest) throw new Error("Author-sidecar digest key is unavailable");
				migrated.push({
					schemaVersion: 2,
					type: "prompt-author",
					promptId: parsed.promptId,
					dispatchedAt: parsed.dispatchedAt,
					modelTextDigest,
					source: parsed.source,
					author: canonicalAuthor(parsed.author),
				});
			} else if (isLegacySettlementRecord(parsed)) {
				migrated.push({
					schemaVersion: 2,
					type: "prompt-author-settlement",
					promptId: parsed.promptId,
					settledAt: parsed.settledAt,
					outcome: parsed.outcome,
					...(parsed.messageId === undefined ? {} : { messageId: parsed.messageId }),
					...(parsed.messageTimestamp === undefined ? {} : { messageTimestamp: parsed.messageTimestamp }),
				});
			} else if (isDispatchRecord(parsed) || isSettlementRecord(parsed)) {
				migrated.push(canonicalRecord(parsed));
			}
		} catch { /* malformed/future rows safely degrade to inference */ }
	}

	if (migrated.length > 0) {
		const destination = filePath(sessionId);
		if (!destination) throw new Error("Author-sidecar private destination is unavailable");
		const existing = readSecureText(destination);
		const combined = [...(existing === undefined ? [] : recordsFromText(existing)), ...migrated];
		if (!replaceSessionRecords(sessionId, combined)) {
			throw new Error(`Failed to preserve legacy author sidecar ${legacyFile}`);
		}
	}

	// The path was atomically claimed before it was read. Verify that no process
	// swapped or appended to that claimed inode before removing plaintext.
	const current = fs.lstatSync(legacyFile);
	if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(snapshot.stat, current)) {
		throw new Error(`Legacy author sidecar changed during migration: ${legacyFile}`);
	}
	fs.unlinkSync(legacyFile);
	fsyncDirectory(legacyDir);
}

function claimedLegacyName(name: string): string {
	return `.${name}.migrating`;
}

function claimedLegacySessionId(name: string): string | undefined {
	if (!name.startsWith(".") || !name.endsWith(".jsonl.migrating")) return undefined;
	return name.slice(1, -".jsonl.migrating".length);
}

function migrateLegacyAuthorSidecars(legacyStateDir: string): void {
	const legacyDir = path.join(legacyStateDir, "author-sidecar");
	if (!sidecarDir || path.resolve(legacyDir) === path.resolve(sidecarDir)) return;
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(legacyDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
		throw error;
	}
	if (stat.isSymbolicLink()) {
		fs.unlinkSync(legacyDir);
		return;
	}
	if (!stat.isDirectory()) throw new Error("Legacy author-sidecar path is not a directory");

	// Resume crash-left claimed files first, then atomically claim ordinary v1
	// files before reading. A concurrent replacement remains at the original name
	// and is caught by the final reachable-ledger scan below.
	const initialNames = fs.readdirSync(legacyDir).sort((left, right) =>
		Number(claimedLegacySessionId(right) !== undefined) - Number(claimedLegacySessionId(left) !== undefined),
	);
	for (const name of initialNames) {
		const recoveredSessionId = claimedLegacySessionId(name);
		if (!recoveredSessionId && !name.endsWith(".jsonl")) continue;
		const original = path.join(legacyDir, name);
		let claimed = original;
		let sessionId = recoveredSessionId;
		const entryStat = fs.lstatSync(original);
		if (entryStat.isSymbolicLink()) {
			fs.unlinkSync(original);
			fsyncDirectory(legacyDir);
			continue;
		}
		if (!entryStat.isFile()) continue;
		if (!sessionId) {
			sessionId = name.slice(0, -".jsonl".length);
			claimed = path.join(legacyDir, claimedLegacyName(name));
			fs.renameSync(original, claimed);
			fsyncDirectory(legacyDir);
		}
		migrateLegacyFile(claimed, sessionId, legacyDir);
	}

	const remainingReachableLedgers = fs.readdirSync(legacyDir).filter((name) =>
		name.endsWith(".jsonl") || claimedLegacySessionId(name) !== undefined,
	);
	if (remainingReachableLedgers.length > 0) {
		throw new Error(`Legacy author sidecars appeared during migration: ${remainingReachableLedgers.join(", ")}`);
	}
	try {
		fs.rmdirSync(legacyDir);
		fsyncDirectory(path.dirname(legacyDir));
	} catch (error) {
		// ENOTEMPTY proves a ledger or other reachable file appeared after the
		// final scan. Failing closed prevents startup with newly exposed plaintext.
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
	}
}

/**
 * Initialize private v2 storage and migrate reachable v1 plaintext ledgers.
 * Migration failures throw so the gateway never continues with readable prompt
 * plaintext under a project root.
 */
export function initAuthorSidecarDir(
	legacyStateDir: string,
	options: InitAuthorSidecarOptions = {},
): void {
	const secretsRoot = path.resolve(options.secretsDir ?? serverSecretsDir());
	const keyMaterial = options.hmacKey ?? loadOrCreateCookieSigningKey(secretsRoot);
	const nextDir = path.join(secretsRoot, "author-sidecar");
	const previousPlatform = sidecarPlatform;
	sidecarPlatform = options.platform ?? process.platform;
	try {
		ensurePrivateDirectory(nextDir);
		sidecarDir = nextDir;
		promptDigestKey = derivePromptDigestKey(keyMaterial);
		migrateLegacyAuthorSidecars(legacyStateDir);
	} catch (error) {
		sidecarDir = undefined;
		promptDigestKey = undefined;
		sidecarPlatform = previousPlatform;
		throw error;
	}
}

export function appendPromptAuthorDispatch(
	sessionId: string,
	input: PromptAuthorDispatchInput,
): boolean {
	const modelTextDigest = typeof input.modelText === "string" ? digestPromptModelText(input.modelText) : undefined;
	const record: PromptAuthorDispatchRecord = {
		schemaVersion: 2,
		type: "prompt-author",
		promptId: input.promptId,
		dispatchedAt: input.dispatchedAt,
		modelTextDigest: modelTextDigest ?? "",
		source: input.source,
		author: isMessageAuthor(input.author) ? canonicalAuthor(input.author) : input.author,
	};
	if (!isDispatchRecord(record)) return false;
	return appendRecord(sessionId, record);
}

export function appendPromptAuthorSettlement(
	sessionId: string,
	input: PromptAuthorSettlementInput,
): boolean {
	const record: PromptAuthorSettlementRecord = {
		schemaVersion: 2,
		type: "prompt-author-settlement",
		promptId: input.promptId,
		settledAt: input.settledAt,
		outcome: input.outcome,
		...(input.messageId === undefined ? {} : { messageId: input.messageId }),
		...(input.messageTimestamp === undefined ? {} : { messageTimestamp: input.messageTimestamp }),
	};
	if (!isSettlementRecord(record)) return false;
	return appendRecord(sessionId, record);
}

/** Fold redispatches by prompt id. The latest dispatch resets prior settlement. */
export function foldAuthorSidecarRecords(records: AuthorSidecarRecord[]): PromptAuthorBinding[] {
	const bindings = new Map<string, PromptAuthorBinding>();
	for (const record of records) {
		if (isDispatchRecord(record)) {
			bindings.set(record.promptId, { ...record });
			continue;
		}
		if (!isSettlementRecord(record)) continue;
		const binding = bindings.get(record.promptId);
		if (!binding) continue;
		binding.settlement = record;
	}
	return [...bindings.values()].sort((left, right) => left.dispatchedAt - right.dispatchedAt);
}

/** Missing, corrupt, partial, and future-version sidecars safely read as absent rows. */
export function readAuthorSidecar(sessionId: string): PromptAuthorBinding[] {
	const target = filePath(sessionId);
	if (!target) return [];
	try {
		const text = readSecureText(target);
		return text === undefined ? [] : foldAuthorSidecarRecords(recordsFromText(text));
	} catch (error) {
		console.warn(
			"[author-sidecar] Read failed for session %s: %s",
			diagnosticValue(sessionId),
			diagnosticValue(error),
		);
		return [];
	}
}

export function extractPromptModelText(message: Record<string, unknown>): string | undefined {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return undefined;
	const parts: string[] = [];
	for (const block of message.content) {
		if (!block || typeof block !== "object" || Array.isArray(block)) continue;
		const candidate = block as Record<string, unknown>;
		if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
	}
	// Pi 0.80.6 represents user content as an ordered TextContent/ImageContent
	// sequence. Adjacent text blocks are consecutive fragments; inserting a
	// separator here would change the exact text whose digest was dispatched.
	return parts.length > 0 ? parts.join("") : undefined;
}

function messageId(message: Record<string, unknown>): string | undefined {
	for (const key of ["id", "entryId", "_entryId", "_bobbitEntryId"]) {
		const value = message[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function epochMilliseconds(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function messageTimestamp(message: Record<string, unknown>): number | undefined {
	return epochMilliseconds(message.timestamp) ?? epochMilliseconds(message.ts);
}

function eligiblePromptMessage(message: Record<string, unknown>): boolean {
	return (message.role === "user" || message.role === "user-with-attachments")
		&& !isToolResultOnlyMessage(message);
}

function sameAuthor(left: unknown, right: MessageAuthor): boolean {
	return isMessageAuthor(left)
		&& left.kind === right.kind
		&& left.id === right.id
		&& left.label === right.label;
}

const DEFAULT_STREAM_CORRELATION_BINDINGS = 10_000;
const DEFAULT_STREAM_CORRELATION_BYTES = 8 * 1024 * 1024;

export interface PromptAuthorStreamCorrelationOptions {
	/** Maximum compact sidecar bindings retained for one streamed transcript. */
	maxBindings?: number;
	/** Maximum estimated UTF-8 bytes retained by compact binding state. */
	maxBindingBytes?: number;
}

export interface PromptAuthorStreamCorrelation {
	/** True when sidecar state exceeded a cap and correlation safely fell back. */
	readonly degraded: boolean;
	/** Number of compact sidecar bindings retained by this resolver. */
	readonly retainedBindings: number;
	/** First-pass reservation of exact id/timestamp matches. */
	reserve(message: Record<string, unknown>, rowIndex: number): void;
	/** Second-pass resolution, including deterministic FIFO fallback. */
	resolve(message: Record<string, unknown>, rowIndex: number): MessageAuthor | undefined;
}

interface StreamBindingRef {
	binding: PromptAuthorBinding;
	order: number;
	consumed: boolean;
}

interface StreamBindingBuckets {
	byDigest: Map<string, StreamBindingRef[]>;
	byText: Map<string, StreamBindingRef[]>;
}

interface StreamReservation {
	ref: StreamBindingRef;
	kind: "id" | "timestamp";
	messageId?: string;
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function utf8Length(value: unknown): number {
	return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

/** Estimate compact resolver state without serializing or retaining transcript content. */
function streamBindingBytes(binding: PromptAuthorBinding): number {
	return 128
		+ utf8Length(binding.promptId)
		+ utf8Length(binding.modelTextDigest)
		+ utf8Length(binding.modelText)
		+ utf8Length(binding.source)
		+ utf8Length(binding.author.id)
		+ utf8Length(binding.author.label)
		+ utf8Length(binding.settlement?.messageId);
}

function createBuckets(): StreamBindingBuckets {
	return { byDigest: new Map(), byText: new Map() };
}

function appendBucket(map: Map<string, StreamBindingRef[]>, key: string, ref: StreamBindingRef): void {
	const bucket = map.get(key);
	if (bucket) bucket.push(ref);
	else map.set(key, [ref]);
}

function addBindingToBuckets(buckets: StreamBindingBuckets, ref: StreamBindingRef): void {
	if (validDigest(ref.binding.modelTextDigest)) {
		appendBucket(buckets.byDigest, ref.binding.modelTextDigest, ref);
	} else if (typeof ref.binding.modelText === "string") {
		appendBucket(buckets.byText, ref.binding.modelText, ref);
	}
}

function earlierRef(left: StreamBindingRef | undefined, right: StreamBindingRef): StreamBindingRef {
	if (!left) return right;
	if (right.binding.dispatchedAt < left.binding.dispatchedAt) return right;
	if (right.binding.dispatchedAt === left.binding.dispatchedAt && right.order < left.order) return right;
	return left;
}

function firstMatchingRef(
	buckets: StreamBindingBuckets,
	modelText: string,
	predicate: (ref: StreamBindingRef) => boolean = () => true,
): StreamBindingRef | undefined {
	let match: StreamBindingRef | undefined;
	const digest = digestPromptModelText(modelText);
	const candidates = [
		...(digest ? [buckets.byDigest.get(digest)] : []),
		buckets.byText.get(modelText),
	];
	for (const bucket of candidates) {
		if (!bucket) continue;
		for (const ref of bucket) {
			if (ref.consumed || !predicate(ref)) continue;
			match = earlierRef(match, ref);
			// Buckets are dispatch ordered, so only the first eligible row in each
			// representation can beat the other representation's candidate.
			break;
		}
	}
	return match;
}

function firstUnconsumed(refs: StreamBindingRef[] | undefined): StreamBindingRef | undefined {
	return refs?.find((ref) => !ref.consumed);
}

function emptyStreamCorrelation(degraded: boolean): PromptAuthorStreamCorrelation {
	return {
		degraded,
		retainedBindings: 0,
		reserve: () => undefined,
		resolve: () => undefined,
	};
}

/**
 * Build bounded two-pass correlation state for transcript streams.
 *
 * Pass one reserves exact settled ids and timestamp+digest matches globally.
 * Pass two can therefore consume remaining same-text occurrences FIFO without
 * letting an older duplicate steal a later exact binding. Only compact sidecar
 * refs and at most one reservation per binding are retained; message bodies,
 * images, attachments, and tool payloads are never retained here.
 */
export function createPromptAuthorStreamCorrelation(
	entries: PromptAuthorBinding[],
	options: PromptAuthorStreamCorrelationOptions = {},
): PromptAuthorStreamCorrelation {
	if (!Array.isArray(entries) || entries.length === 0) return emptyStreamCorrelation(false);
	const maxBindings = positiveLimit(options.maxBindings, DEFAULT_STREAM_CORRELATION_BINDINGS);
	const maxBindingBytes = positiveLimit(options.maxBindingBytes, DEFAULT_STREAM_CORRELATION_BYTES);
	if (entries.length > maxBindings) return emptyStreamCorrelation(true);

	let retainedBytes = 0;
	const bindings = entries
		.filter(isPromptAuthorBinding)
		.sort((left, right) => left.dispatchedAt - right.dispatchedAt);
	for (const binding of bindings) {
		retainedBytes += streamBindingBytes(binding);
		if (retainedBytes > maxBindingBytes) return emptyStreamCorrelation(true);
	}
	if (bindings.length > maxBindings) return emptyStreamCorrelation(true);

	const exactMessageIds = new Map<string, StreamBindingRef[]>();
	const exactPromptIds = new Map<string, StreamBindingRef[]>();
	const timestampBindings = createBuckets();
	const fifoBindings = createBuckets();
	const refs: StreamBindingRef[] = [];

	for (const binding of bindings) {
		if (binding.settlement?.outcome === "cancelled") continue;
		const ref: StreamBindingRef = { binding, order: refs.length, consumed: false };
		refs.push(ref);
		appendBucket(exactPromptIds, binding.promptId, ref);
		if (binding.settlement?.outcome !== "echoed") continue;
		const settledMessageId = binding.settlement.messageId;
		if (settledMessageId) {
			// Exact ids remain reserved even if the transcript changes between passes;
			// an earlier same-text FIFO row must never steal their author.
			appendBucket(exactMessageIds, settledMessageId, ref);
			continue;
		}
		addBindingToBuckets(timestampBindings, ref);
		if (binding.settlement.messageTimestamp === undefined) {
			// Keyless settlements retain deterministic FIFO fallback after the first
			// pass has had a chance to reserve the settledAt timestamp heuristic.
			addBindingToBuckets(fifoBindings, ref);
		}
	}

	const reservations = new Map<number, StreamReservation>();
	const reserve = (message: Record<string, unknown>, rowIndex: number): void => {
		if (!eligiblePromptMessage(message) || reservations.has(rowIndex)) return;
		const id = messageId(message);
		const exact = id ? firstUnconsumed(exactMessageIds.get(id)) : undefined;
		if (exact) {
			exact.consumed = true;
			reservations.set(rowIndex, { ref: exact, kind: "id", messageId: id });
			return;
		}
		const text = extractPromptModelText(message);
		const timestamp = messageTimestamp(message);
		if (text === undefined || timestamp === undefined) return;
		const timed = firstMatchingRef(timestampBindings, text, (ref) => {
			const settlement = ref.binding.settlement;
			const settledTimestamp = settlement?.messageTimestamp ?? settlement?.settledAt;
			return settledTimestamp !== undefined
				&& Math.abs(timestamp - settledTimestamp) <= CORRELATION_TOLERANCE_MS;
		});
		if (!timed) return;
		timed.consumed = true;
		reservations.set(rowIndex, { ref: timed, kind: "timestamp" });
	};

	const resolve = (message: Record<string, unknown>, rowIndex: number): MessageAuthor | undefined => {
		if (!eligiblePromptMessage(message)) return undefined;
		const reservation = reservations.get(rowIndex);
		if (reservation) {
			if (reservation.kind === "id") {
				return messageId(message) === reservation.messageId
					? reservation.ref.binding.author
					: undefined;
			}
			const text = extractPromptModelText(message);
			const timestamp = messageTimestamp(message);
			const settlement = reservation.ref.binding.settlement;
			const settledTimestamp = settlement?.messageTimestamp ?? settlement?.settledAt;
			return text !== undefined
				&& timestamp !== undefined
				&& settledTimestamp !== undefined
				&& Math.abs(timestamp - settledTimestamp) <= CORRELATION_TOLERANCE_MS
				&& promptAuthorBindingMatchesText(reservation.ref.binding, text)
				? reservation.ref.binding.author
				: undefined;
		}

		// Unresolved dispatches are never allowed into digest/FIFO matching. The
		// sole supported occurrence is Bobbit's exact synthetic in-flight steer id.
		const id = messageId(message);
		if (message._inFlightSteer === true && id?.startsWith("inflight-steer:")) {
			const promptId = id.slice("inflight-steer:".length);
			const direct = firstUnconsumed(exactPromptIds.get(promptId));
			if (direct) {
				direct.consumed = true;
				return direct.binding.author;
			}
		}

		const text = extractPromptModelText(message);
		if (text === undefined) return undefined;
		const fifo = firstMatchingRef(fifoBindings, text);
		if (!fifo) return undefined;
		fifo.consumed = true;
		return fifo.binding.author;
	};

	return {
		degraded: false,
		retainedBindings: refs.length,
		reserve,
		resolve,
	};
}

/**
 * Correlate sidecar bindings before inference. Matching is global by phase so
 * an early legacy duplicate cannot consume a later row's exact id binding.
 */
export function mergeAuthorSidecarIntoMessages<T extends object>(
	entries: PromptAuthorBinding[],
	messages: T[],
	context: NormalizeVisibleMessageContext = {},
): Array<T & { author?: MessageAuthor }> {
	if (!Array.isArray(messages)) return messages;
	const directPromptBindings = entries
		.filter((entry) => isPromptAuthorBinding(entry) && entry.settlement?.outcome !== "cancelled")
		.sort((left, right) => left.dispatchedAt - right.dispatchedAt);
	// Persisted transcript rows exist only after Pi echoes a prompt. An unresolved
	// same-text dispatch may match only Bobbit's synthetic row by its prompt id;
	// letting it enter weaker transcript phases can relabel older human history.
	const echoedTranscriptBindings = directPromptBindings
		.filter((entry) => entry.settlement?.outcome === "echoed");
	const consumed = new Set<PromptAuthorBinding>();
	const assignments = new Map<number, MessageAuthor>();
	const rows = messages as Array<T & Record<string, unknown>>;

	// Phase 0: Bobbit's synthetic in-flight steer row encodes the dispatch id.
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		if (!eligiblePromptMessage(row) || row._inFlightSteer !== true) continue;
		const id = messageId(row);
		if (!id?.startsWith("inflight-steer:")) continue;
		const promptId = id.slice("inflight-steer:".length);
		const binding = directPromptBindings.find((candidate) => !consumed.has(candidate) && candidate.promptId === promptId);
		if (!binding) continue;
		assignments.set(index, binding.author);
		consumed.add(binding);
	}

	// Phase 1: exact settled Pi/session entry id.
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		if (!eligiblePromptMessage(row)) continue;
		const id = messageId(row);
		if (!id) continue;
		const binding = echoedTranscriptBindings.find((candidate) =>
			!consumed.has(candidate) && candidate.settlement?.messageId === id,
		);
		if (!binding) continue;
		assignments.set(index, binding.author);
		consumed.add(binding);
	}

	// Phase 2: exact keyed text digest and settled timestamp within two seconds.
	for (let index = 0; index < rows.length; index++) {
		if (assignments.has(index)) continue;
		const row = rows[index];
		if (!eligiblePromptMessage(row)) continue;
		const text = extractPromptModelText(row);
		const timestamp = messageTimestamp(row);
		if (text === undefined || timestamp === undefined) continue;
		const binding = echoedTranscriptBindings.find((candidate) => {
			if (consumed.has(candidate) || !promptAuthorBindingMatchesText(candidate, text)) return false;
			const settledTimestamp = candidate.settlement?.messageTimestamp ?? candidate.settlement?.settledAt;
			return settledTimestamp !== undefined
				&& Math.abs(timestamp - settledTimestamp) <= CORRELATION_TOLERANCE_MS;
		});
		if (!binding) continue;
		assignments.set(index, binding.author);
		consumed.add(binding);
	}

	// Phase 3: FIFO exact keyed digest, consuming duplicate dispatches individually.
	for (let index = 0; index < rows.length; index++) {
		if (assignments.has(index)) continue;
		const row = rows[index];
		if (!eligiblePromptMessage(row)) continue;
		const text = extractPromptModelText(row);
		if (text === undefined) continue;
		const binding = echoedTranscriptBindings.find((candidate) =>
			!consumed.has(candidate) && promptAuthorBindingMatchesText(candidate, text),
		);
		if (!binding) continue;
		assignments.set(index, binding.author);
		consumed.add(binding);
	}

	let authored: T[] = messages;
	if (assignments.size > 0) {
		let changed = false;
		authored = messages.map((row, index) => {
			const author = assignments.get(index);
			if (!author || sameAuthor((row as T & { author?: unknown }).author, author)) return row;
			changed = true;
			return { ...row, author };
		});
		if (!changed) authored = messages;
	}
	return normalizeVisibleMessages(authored, { ...context, existingAuthorIsTrusted: true });
}

interface TranscriptPromptCandidate {
	ids: Set<string>;
	timestamp?: number;
	modelText: string;
	consumed: boolean;
}

function transcriptPromptCandidates(transcript: string): TranscriptPromptCandidate[] {
	const candidates: TranscriptPromptCandidate[] = [];
	for (const line of transcript.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const envelope = JSON.parse(line) as Record<string, unknown>;
			const message = envelope.message && typeof envelope.message === "object" && !Array.isArray(envelope.message)
				? envelope.message as Record<string, unknown>
				: envelope;
			if (!eligiblePromptMessage(message)) continue;
			const modelText = extractPromptModelText(message);
			if (modelText === undefined) continue;
			const ids = new Set<string>();
			for (const candidate of [messageId(envelope), messageId(message)]) if (candidate) ids.add(candidate);
			candidates.push({
				ids,
				modelText,
				timestamp: messageTimestamp(envelope) ?? messageTimestamp(message),
				consumed: false,
			});
		} catch { /* malformed transcript rows are ignored like Pi */ }
	}
	return candidates;
}

function transcriptConfirmedBindings(
	bindings: PromptAuthorBinding[],
	transcript: string,
): PromptAuthorBinding[] {
	const candidates = transcriptPromptCandidates(transcript);
	const confirmed = new Set<PromptAuthorBinding>();

	// Reserve exact message ids before weaker duplicate matching.
	for (const binding of bindings) {
		const id = binding.settlement?.messageId;
		if (!id) continue;
		const candidate = candidates.find((row) =>
			!row.consumed && row.ids.has(id) && promptAuthorBindingMatchesText(binding, row.modelText),
		);
		if (!candidate) continue;
		candidate.consumed = true;
		confirmed.add(binding);
	}
	for (const binding of bindings) {
		if (confirmed.has(binding) || binding.settlement?.messageId) continue;
		const settledTimestamp = binding.settlement?.messageTimestamp;
		if (settledTimestamp === undefined) continue;
		const candidate = candidates.find((row) =>
			!row.consumed
			&& row.timestamp !== undefined
			&& Math.abs(row.timestamp - settledTimestamp) <= CORRELATION_TOLERANCE_MS
			&& promptAuthorBindingMatchesText(binding, row.modelText),
		);
		if (!candidate) continue;
		candidate.consumed = true;
		confirmed.add(binding);
	}
	for (const binding of bindings) {
		if (confirmed.has(binding)
			|| binding.settlement?.messageId
			|| binding.settlement?.messageTimestamp !== undefined) continue;
		const candidate = candidates.find((row) =>
			!row.consumed && promptAuthorBindingMatchesText(binding, row.modelText),
		);
		if (!candidate) continue;
		candidate.consumed = true;
		confirmed.add(binding);
	}
	return bindings.filter((binding) => confirmed.has(binding));
}

/**
 * Copy only echoed source bindings. Fork/continue callers additionally provide
 * the cloned transcript, which excludes unresolved live dispatches and proves
 * every copied binding is represented by an eligible transcript row.
 */
export function copyAuthorSidecar(
	fromSessionId: string,
	toSessionId: string,
	options: CopyAuthorSidecarOptions = {},
): boolean {
	try {
		let bindings = readAuthorSidecar(fromSessionId)
			.filter((binding) => binding.settlement?.outcome === "echoed");
		if (options.transcript !== undefined) {
			bindings = transcriptConfirmedBindings(bindings, options.transcript ?? "");
		}
		const records: AuthorSidecarRecord[] = [];
		for (const binding of bindings) {
			if (!validDigest(binding.modelTextDigest) || !binding.settlement) continue;
			records.push({
				schemaVersion: 2,
				type: "prompt-author",
				promptId: binding.promptId,
				dispatchedAt: binding.dispatchedAt,
				modelTextDigest: binding.modelTextDigest,
				source: binding.source,
				author: binding.author,
			});
			records.push({
				schemaVersion: 2,
				type: "prompt-author-settlement",
				promptId: binding.promptId,
				settledAt: binding.settlement.settledAt,
				outcome: "echoed",
				...(binding.settlement.messageId === undefined ? {} : { messageId: binding.settlement.messageId }),
				...(binding.settlement.messageTimestamp === undefined ? {} : { messageTimestamp: binding.settlement.messageTimestamp }),
			});
		}
		return replaceSessionRecords(toSessionId, records);
	} catch (error) {
		console.warn(`[author-sidecar] Copy failed from ${fromSessionId} to ${toSessionId}:`, error);
		return false;
	}
}

export function purgeAuthorSidecar(sessionId: string): void {
	const target = filePath(sessionId);
	if (!target) return;
	try {
		fs.unlinkSync(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			console.warn(`[author-sidecar] Purge failed for session ${sessionId}:`, error);
		}
	}
}
