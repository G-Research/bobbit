/**
 * Immutable preview artifacts.
 *
 * A live preview mount (`state/preview/<sessionId>/`) is mutable: every
 * `preview_open` refresh rewrites it. This module captures the exact mounted
 * bytes after a successful mount into `state/preview-artifacts/<sessionId>/`
 * so historical preview cards can restore their original bytes without
 * re-reading the source file path.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";
import * as previewMount from "./mount.js";

const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const VALID_ARTIFACT_ID = /^[A-Za-z0-9_-]{6,64}$/;

export interface PreviewArtifactRecord {
	artifactId: string;
	sessionId: string;
	entry: string;
	contentHash: string;
	createdAt: number;
	mtime: number;
	files: string[];
}

export interface PreviewArtifactMountResult extends previewMount.MountResult {
	artifactId: string;
}

export class PreviewArtifactError extends Error {
	statusCode: number;
	constructor(statusCode: number, message: string) {
		super(message);
		this.name = "PreviewArtifactError";
		this.statusCode = statusCode;
	}
}

let _artifactRootOverride: string | undefined;

export function setPreviewArtifactRootForTesting(dir: string | undefined): void {
	_artifactRootOverride = dir;
}

function artifactRoot(): string {
	return _artifactRootOverride ?? path.join(bobbitStateDir(), "preview-artifacts");
}

export function artifactSessionDir(sessionId: string): string {
	validateSessionId(sessionId);
	return path.join(artifactRoot(), sessionId);
}

export function artifactDir(sessionId: string, artifactId: string): string {
	validateSessionId(sessionId);
	validateArtifactId(artifactId);
	return path.join(artifactSessionDir(sessionId), artifactId);
}

export function artifactMountDir(sessionId: string, artifactId: string): string {
	return path.join(artifactDir(sessionId, artifactId), "mount");
}

/**
 * Capture the exact current live preview mount as an immutable artifact.
 * Reuses an existing artifact when the same session already captured the same
 * contentHash.
 */
export function persistPreviewArtifact(
	sessionId: string,
	mountResult: previewMount.MountResult,
): PreviewArtifactRecord {
	validateSessionId(sessionId);
	validateEntry(mountResult.entry);
	validateContentHash(mountResult.contentHash);

	const liveMount = previewMount.mountDir(sessionId);
	const liveEntry = path.join(liveMount, mountResult.entry);
	if (!fs.existsSync(liveEntry) || !safeStat(liveEntry)?.isFile()) {
		throw new PreviewArtifactError(500, "Preview entry missing before artifact capture");
	}

	const liveHash = hashDirectory(liveMount);
	if (liveHash !== mountResult.contentHash) {
		throw new PreviewArtifactError(500, "Preview mount changed before artifact capture");
	}

	const existing = findPreviewArtifactByHash(sessionId, mountResult.contentHash);
	if (existing) return existing;

	const sessionDir = artifactSessionDir(sessionId);
	fs.mkdirSync(sessionDir, { recursive: true });

	for (let attempt = 0; attempt < 5; attempt++) {
		const artifactId = createArtifactId();
		const finalDir = path.join(sessionDir, artifactId);
		if (fs.existsSync(finalDir)) continue;
		const tmpDir = path.join(sessionDir, `.tmp-${artifactId}-${process.pid}-${Date.now()}`);
		try {
			fs.mkdirSync(tmpDir, { recursive: true });
			const tmpMount = path.join(tmpDir, "mount");
			copyDirectory(liveMount, tmpMount);
			const copiedHash = hashDirectory(tmpMount);
			if (copiedHash !== mountResult.contentHash) {
				throw new PreviewArtifactError(500, "Preview artifact copy hash mismatch");
			}
			const files = listFiles(tmpMount);
			if (!files.includes(mountResult.entry)) {
				throw new PreviewArtifactError(500, "Preview artifact copy missing entry");
			}
			const record: PreviewArtifactRecord = {
				artifactId,
				sessionId,
				entry: mountResult.entry,
				contentHash: mountResult.contentHash,
				createdAt: Date.now(),
				mtime: mountResult.mtime,
				files,
			};
			writeJsonAtomic(path.join(tmpDir, "artifact.json"), record);
			fs.renameSync(tmpDir, finalDir);
			return record;
		} catch (err) {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
			if (err instanceof PreviewArtifactError) throw err;
			if ((err as NodeJS.ErrnoException)?.code === "EEXIST") continue;
			throw new PreviewArtifactError(500, `Preview artifact capture failed: ${(err as Error)?.message ?? String(err)}`);
		}
	}

	throw new PreviewArtifactError(500, "Preview artifact id collision");
}

/** Read and validate one artifact record. */
export function readPreviewArtifact(sessionId: string, artifactId: string): PreviewArtifactRecord {
	validateSessionId(sessionId);
	validateArtifactId(artifactId);
	const dir = artifactDir(sessionId, artifactId);
	const file = path.join(dir, "artifact.json");
	if (!fs.existsSync(file)) {
		throw new PreviewArtifactError(404, "Preview artifact not found");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (err) {
		throw new PreviewArtifactError(500, `Preview artifact metadata is unreadable: ${(err as Error)?.message ?? String(err)}`);
	}
	const record = coerceRecord(parsed);
	if (!record || record.sessionId !== sessionId || record.artifactId !== artifactId) {
		throw new PreviewArtifactError(500, "Preview artifact metadata is invalid");
	}
	return record;
}

/**
 * Restore an immutable artifact into the single live preview mount.
 * Validation and staging happen before the live mount is touched, so missing,
 * wrong-session, and corrupt artifacts cannot alias to current content.
 */
export function restorePreviewArtifact(sessionId: string, artifactId: string): PreviewArtifactMountResult {
	validateSessionId(sessionId);
	validateArtifactId(artifactId);

	const record = readPreviewArtifact(sessionId, artifactId);
	const sourceMount = artifactMountDir(sessionId, artifactId);
	validateArtifactMount(record, sourceMount);

	let liveMount = "";
	let tmpRestore = "";
	let backupDir = "";
	let hadLiveMount = false;
	try {
		// Stage from the immutable artifact before touching the live mount.
		// Use mountPath() (which returns the path WITHOUT creating it) so that
		// `hadLiveMount = fs.existsSync(liveMount)` is honest for fresh sessions.
		// Previously this used `path.dirname(previewMount.mountDir(sessionId))`
		// whose mkdir side-effect made hadLiveMount always true and caused an
		// unnecessary backup copy of an empty directory.
		liveMount = previewMount.mountPath(sessionId);
		const previewParent = path.dirname(liveMount);
		tmpRestore = path.join(previewParent, `.restore-${sessionId}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
		copyDirectory(sourceMount, tmpRestore);
		if (hashDirectory(tmpRestore) !== record.contentHash) {
			throw new PreviewArtifactError(500, "Preview artifact staged hash mismatch");
		}
		if (!fs.existsSync(path.join(tmpRestore, record.entry))) {
			throw new PreviewArtifactError(500, "Preview artifact staged entry missing");
		}

		hadLiveMount = fs.existsSync(liveMount);
		backupDir = path.join(previewParent, `.restore-backup-${sessionId}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
		if (hadLiveMount) copyDirectory(liveMount, backupDir);

		try {
			fs.mkdirSync(liveMount, { recursive: true });
			wipeContents(liveMount);
			moveContents(tmpRestore, liveMount);
		} catch (err) {
			try {
				wipeContents(liveMount);
				if (hadLiveMount && fs.existsSync(backupDir)) moveContents(backupDir, liveMount);
			} catch (restoreErr) {
				console.error("[preview/artifacts] failed to roll back live preview mount after restore error", restoreErr);
			}
			throw err;
		}
	} catch (err) {
		if (err instanceof PreviewArtifactError) throw err;
		throw new PreviewArtifactError(500, `Preview artifact restore failed: ${(err as Error)?.message ?? String(err)}`);
	} finally {
		if (tmpRestore) { try { fs.rmSync(tmpRestore, { recursive: true, force: true }); } catch { /* ignore */ } }
		if (backupDir) { try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* ignore */ } }
	}

	const entryPath = path.join(liveMount, record.entry);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(entryPath);
	} catch (err) {
		throw new PreviewArtifactError(500, `Preview artifact restored entry missing: ${(err as Error)?.message ?? String(err)}`);
	}

	return {
		url: `/preview/${sessionId}/${record.entry}`,
		path: entryPath,
		relPath: path.posix.join(sessionId, record.entry),
		entry: record.entry,
		mtime: Math.floor(stat.mtimeMs),
		contentHash: record.contentHash,
		artifactId: record.artifactId,
	};
}

/** Delete all artifacts for a session. Idempotent. */
export function removeArtifacts(sessionId: string): void {
	if (!VALID_SESSION_ID.test(sessionId || "")) return;
	try {
		fs.rmSync(path.join(artifactRoot(), sessionId), { recursive: true, force: true });
	} catch {
		/* idempotent */
	}
}

/**
 * Explicit maintenance helper: remove artifact directories whose session id is
 * absent from the caller-provided live+archived session set.
 */
export function sweepOrphanArtifacts(knownSessionIds: Iterable<string>): { removed: string[]; kept: string[] } {
	const known = new Set<string>();
	for (const id of knownSessionIds) {
		if (VALID_SESSION_ID.test(id || "")) known.add(id.toLowerCase());
	}
	const removed: string[] = [];
	const kept: string[] = [];
	const root = artifactRoot();
	if (!fs.existsSync(root)) return { removed, kept };
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { removed, kept }; }
	for (const ent of entries) {
		if (!ent.isDirectory()) continue;
		const id = ent.name;
		if (VALID_SESSION_ID.test(id) && known.has(id.toLowerCase())) {
			kept.push(id);
			continue;
		}
		try {
			fs.rmSync(path.join(root, id), { recursive: true, force: true });
			removed.push(id);
		} catch {
			/* best-effort sweep */
		}
	}
	return { removed: removed.sort(), kept: kept.sort() };
}

export function findPreviewArtifactByHash(sessionId: string, contentHash: string): PreviewArtifactRecord | null {
	validateSessionId(sessionId);
	validateContentHash(contentHash);
	const sessionDir = artifactSessionDir(sessionId);
	if (!fs.existsSync(sessionDir)) return null;
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(sessionDir, { withFileTypes: true }); } catch { return null; }
	for (const ent of entries) {
		if (!ent.isDirectory() || !VALID_ARTIFACT_ID.test(ent.name)) continue;
		try {
			const record = readPreviewArtifact(sessionId, ent.name);
			if (record.contentHash !== contentHash) continue;
			validateArtifactMount(record, artifactMountDir(sessionId, record.artifactId));
			return record;
		} catch {
			// Corrupt/mismatched entries are not reusable; leave them for maintenance.
		}
	}
	return null;
}

function validateArtifactMount(record: PreviewArtifactRecord, mountDir: string): void {
	if (!fs.existsSync(mountDir) || !safeStat(mountDir)?.isDirectory()) {
		throw new PreviewArtifactError(500, "Preview artifact mount is missing");
	}
	const files = listFiles(mountDir);
	if (!files.includes(record.entry)) {
		throw new PreviewArtifactError(500, "Preview artifact entry is missing");
	}
	const recorded = new Set(record.files);
	for (const rel of files) {
		if (!recorded.has(rel)) {
			throw new PreviewArtifactError(500, "Preview artifact file list mismatch");
		}
	}
	if (files.length !== record.files.length) {
		throw new PreviewArtifactError(500, "Preview artifact file list mismatch");
	}
	const hash = hashDirectory(mountDir);
	if (hash !== record.contentHash) {
		throw new PreviewArtifactError(500, "Preview artifact hash mismatch");
	}
}

function coerceRecord(value: unknown): PreviewArtifactRecord | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (typeof v.artifactId !== "string" || !VALID_ARTIFACT_ID.test(v.artifactId)) return null;
	if (typeof v.sessionId !== "string" || !VALID_SESSION_ID.test(v.sessionId)) return null;
	if (typeof v.entry !== "string") return null;
	try { validateEntry(v.entry); } catch { return null; }
	if (typeof v.contentHash !== "string" || !/^[a-f0-9]{64}$/i.test(v.contentHash)) return null;
	if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt)) return null;
	if (typeof v.mtime !== "number" || !Number.isFinite(v.mtime)) return null;
	if (!Array.isArray(v.files) || !v.files.every(f => typeof f === "string" && isSafeRelativeFile(f))) return null;
	return {
		artifactId: v.artifactId,
		sessionId: v.sessionId,
		entry: v.entry,
		contentHash: v.contentHash.toLowerCase(),
		createdAt: Math.floor(v.createdAt),
		mtime: Math.floor(v.mtime),
		files: [...v.files].sort() as string[],
	};
}

function validateSessionId(sessionId: string): void {
	if (!sessionId || !VALID_SESSION_ID.test(sessionId)) {
		throw new PreviewArtifactError(400, "Invalid sessionId");
	}
}

function validateArtifactId(artifactId: string): void {
	if (!artifactId || !VALID_ARTIFACT_ID.test(artifactId)) {
		throw new PreviewArtifactError(400, "Invalid artifactId");
	}
}

function validateContentHash(contentHash: string): void {
	if (!contentHash || !/^[a-f0-9]{64}$/i.test(contentHash)) {
		throw new PreviewArtifactError(500, "Invalid preview contentHash");
	}
}

function validateEntry(entry: string): void {
	if (!entry || typeof entry !== "string") throw new PreviewArtifactError(400, "Invalid entry");
	// Entry is a single filename segment. `/` and `\` block path components;
	// `entry === ".."` blocks the bare parent segment. Substring `".."` was
	// previously rejected too but that is over-broad (e.g. `file..html` is a
	// legal filename and cannot escape because slashes are already blocked).
	if (entry.includes("\0") || entry === "." || entry === ".." || entry.includes("/") || entry.includes("\\")) {
		throw new PreviewArtifactError(400, "Invalid entry");
	}
}

function createArtifactId(): string {
	// 6 random bytes encode to 8 URL-safe chars. The short id keeps v3 preview
	// markers under their 250 B token budget while retaining 48 bits of entropy.
	return crypto.randomBytes(6).toString("base64url");
}

function copyDirectory(src: string, dst: string): void {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	fs.cpSync(src, dst, {
		recursive: true,
		preserveTimestamps: true,
		force: false,
		errorOnExist: true,
	});
}

function writeJsonAtomic(file: string, value: unknown): void {
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
	fs.renameSync(tmp, file);
}

function hashDirectory(root: string): string {
	const hash = crypto.createHash("sha256");
	for (const rel of listFiles(root)) {
		hash.update(rel, "utf-8");
		hash.update("\0");
		hash.update(fs.readFileSync(path.join(root, ...rel.split("/"))));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function listFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, prefix: string) => {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const ent of entries) {
			const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
			const abs = path.join(dir, ent.name);
			if (ent.isDirectory()) walk(abs, rel);
			else if (ent.isFile()) out.push(rel);
		}
	};
	walk(root, "");
	return out.sort();
}

function isSafeRelativeFile(rel: string): boolean {
	if (!rel || rel.includes("\0") || rel.includes("\\")) return false;
	if (rel.startsWith("/") || path.isAbsolute(rel) || /^[a-zA-Z]:\//.test(rel)) return false;
	return rel.split("/").every(seg => seg.length > 0 && seg !== "." && seg !== "..");
}

function safeStat(file: string): fs.Stats | null {
	try { return fs.statSync(file); } catch { return null; }
}

function wipeContents(dir: string): void {
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const ent of entries) {
		fs.rmSync(path.join(dir, ent.name), { recursive: true, force: true });
	}
}

function moveContents(srcDir: string, dstDir: string): void {
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }
	fs.mkdirSync(dstDir, { recursive: true });
	for (const ent of entries) {
		const from = path.join(srcDir, ent.name);
		const to = path.join(dstDir, ent.name);
		try {
			fs.renameSync(from, to);
		} catch {
			if (ent.isDirectory()) copyDirectory(from, to);
			else fs.copyFileSync(from, to);
			fs.rmSync(from, { recursive: true, force: true });
		}
	}
}
