/**
 * Immutable preview artifacts.
 *
 * A live preview mount is mutable. This module captures exact mounted bytes in
 * a per-session immutable store and validates every candidate before reuse.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { bobbitStateDir } from "../bobbit-dir.js";
import {
	readRegularFileNoFollowInChunks,
	RECOVERY_IO_CONCURRENCY,
	sameFileIdentity,
} from "../agent/bounded-async-work.js";
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
let artifactFs: previewMount.PreviewAsyncFs = previewMount.createPreviewAsyncFs(fs);

export function setPreviewArtifactRootForTesting(dir: string | undefined): void {
	_artifactRootOverride = dir;
}

/** Install a promise-only filesystem test double for metadata and artifact trees. */
export function setPreviewArtifactFsForTesting(
	fsImpl: typeof fs | previewMount.PreviewAsyncFs | undefined,
): void {
	artifactFs = previewMount.createPreviewAsyncFs(fsImpl ?? fs);
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

/** Capture the current live mount, reusing the first exact valid candidate. */
export async function persistPreviewArtifact(
	sessionId: string,
	mountResult: previewMount.MountResult,
): Promise<PreviewArtifactRecord> {
	validateSessionId(sessionId);
	validateEntry(mountResult.entry);
	validateContentHash(mountResult.contentHash);

	const liveMount = previewMount.mountPath(sessionId);
	const liveEntry = path.join(liveMount, mountResult.entry);
	const entryStat = await safeLstat(liveEntry);
	if (!entryStat?.isFile() || entryStat.isSymbolicLink()) {
		throw new PreviewArtifactError(500, "Preview entry missing before artifact capture");
	}

	const liveHash = await hashDirectory(liveMount);
	if (liveHash !== mountResult.contentHash) {
		throw new PreviewArtifactError(500, "Preview mount changed before artifact capture");
	}

	const existing = await findPreviewArtifactByHash(sessionId, mountResult.contentHash);
	if (existing) return existing;

	const sessionDir = artifactSessionDir(sessionId);
	await artifactFs.mkdir(sessionDir, { recursive: true });
	for (let attempt = 0; attempt < 5; attempt++) {
		const artifactId = createArtifactId();
		const finalDir = path.join(sessionDir, artifactId);
		const tmpDir = path.join(sessionDir, `.tmp-${artifactId}-${process.pid}-${Date.now()}-${attempt}`);
		try {
			await artifactFs.mkdir(tmpDir, { recursive: false });
			const tmpMount = path.join(tmpDir, "mount");
			await copyDirectory(liveMount, tmpMount);
			const copiedHash = await hashDirectory(tmpMount);
			if (copiedHash !== mountResult.contentHash) {
				throw new PreviewArtifactError(500, "Preview artifact copy hash mismatch");
			}
			const files = await listFiles(tmpMount);
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
			await writeJsonAtomic(path.join(tmpDir, "artifact.json"), record);
			await artifactFs.rename(tmpDir, finalDir);
			return record;
		} catch (err) {
			try { await previewMount.removePreviewTree(tmpDir, { fs: artifactFs }); } catch { /* ignore cleanup */ }
			if (err instanceof PreviewArtifactError) throw err;
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === "EEXIST" || code === "ENOTEMPTY") continue;
			throw new PreviewArtifactError(500, `Preview artifact capture failed: ${errorMessage(err)}`);
		}
	}
	throw new PreviewArtifactError(500, "Preview artifact id collision");
}

/** Read and validate one artifact record. */
export async function readPreviewArtifact(sessionId: string, artifactId: string): Promise<PreviewArtifactRecord> {
	validateSessionId(sessionId);
	validateArtifactId(artifactId);
	const directory = artifactDir(sessionId, artifactId);
	const file = path.join(directory, "artifact.json");
	let parsed: unknown;
	try {
		const directoryStats = await artifactFs.lstat(directory);
		const metadataStats = await artifactFs.lstat(file);
		if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()
			|| !metadataStats.isFile() || metadataStats.isSymbolicLink()) {
			throw new PreviewArtifactError(500, "Preview artifact metadata is invalid");
		}

		// Anchor containment to the directory identity validated above. The file
		// reader then opens artifact.json with no-follow semantics, compares the
		// opened descriptor to its pathname before reading, and reads only through
		// that descriptor in bounded chunks.
		const canonicalDirectory = await artifactFs.realpath(directory);
		const currentDirectoryStats = await artifactFs.stat(directory);
		if (!currentDirectoryStats.isDirectory() || currentDirectoryStats.isSymbolicLink()
			|| !sameFileIdentity(directoryStats, currentDirectoryStats)) {
			throw new PreviewArtifactError(500, "Preview artifact metadata is invalid");
		}
		const decoder = new StringDecoder("utf8");
		const textParts: string[] = [];
		const openedStats = await readRegularFileNoFollowInChunks(file, chunk => {
			textParts.push(decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
		}, {
			fs: artifactFs,
			containedWithin: canonicalDirectory,
		});
		textParts.push(decoder.end());
		if (!sameFileIdentity(metadataStats, openedStats)) {
			throw new PreviewArtifactError(500, "Preview artifact metadata is invalid");
		}
		parsed = JSON.parse(textParts.join(""));
	} catch (err) {
		if (err instanceof PreviewArtifactError) throw err;
		if (isEnoent(err)) throw new PreviewArtifactError(404, "Preview artifact not found");
		throw new PreviewArtifactError(500, `Preview artifact metadata is unreadable: ${errorMessage(err)}`);
	}
	const record = coerceRecord(parsed);
	if (!record || record.sessionId !== sessionId || record.artifactId !== artifactId) {
		throw new PreviewArtifactError(500, "Preview artifact metadata is invalid");
	}
	return record;
}

/** Restore a validated immutable artifact, rolling back a failed live swap. */
export async function restorePreviewArtifact(
	sessionId: string,
	artifactId: string,
): Promise<PreviewArtifactMountResult> {
	validateSessionId(sessionId);
	validateArtifactId(artifactId);

	const record = await readPreviewArtifact(sessionId, artifactId);
	const sourceMount = artifactMountDir(sessionId, artifactId);
	await validateArtifactMount(record, sourceMount);

	let liveMount = "";
	let tmpRestore = "";
	let backupDir = "";
	let hadLiveMount = false;
	try {
		liveMount = previewMount.mountPath(sessionId);
		const previewParent = path.dirname(liveMount);
		await artifactFs.mkdir(previewParent, { recursive: true });
		tmpRestore = path.join(previewParent, `.restore-${sessionId}-${process.pid}-${Date.now()}-${randomSuffix()}`);
		await copyDirectory(sourceMount, tmpRestore);
		if (await hashDirectory(tmpRestore) !== record.contentHash) {
			throw new PreviewArtifactError(500, "Preview artifact staged hash mismatch");
		}
		const stagedEntry = await safeLstat(path.join(tmpRestore, record.entry));
		if (!stagedEntry?.isFile() || stagedEntry.isSymbolicLink()) {
			throw new PreviewArtifactError(500, "Preview artifact staged entry missing");
		}

		// This check is a policy decision: only an existing live mount receives a backup.
		hadLiveMount = (await safeLstat(liveMount))?.isDirectory() === true;
		backupDir = path.join(previewParent, `.restore-backup-${sessionId}-${process.pid}-${Date.now()}-${randomSuffix()}`);
		if (hadLiveMount) await copyDirectory(liveMount, backupDir);

		try {
			await artifactFs.mkdir(liveMount, { recursive: true });
			await previewMount.wipePreviewDirectory(liveMount, { fs: artifactFs });
			await previewMount.movePreviewDirectoryContents(tmpRestore, liveMount, { fs: artifactFs });
		} catch (err) {
			try {
				await previewMount.wipePreviewDirectory(liveMount, { fs: artifactFs });
				if (hadLiveMount && (await safeLstat(backupDir))?.isDirectory()) {
					await previewMount.movePreviewDirectoryContents(backupDir, liveMount, { fs: artifactFs });
				}
			} catch (restoreErr) {
				console.error("[preview/artifacts] failed to roll back live preview mount after restore error", restoreErr);
			}
			throw err;
		}
	} catch (err) {
		if (err instanceof PreviewArtifactError) throw err;
		throw new PreviewArtifactError(500, `Preview artifact restore failed: ${errorMessage(err)}`);
	} finally {
		if (tmpRestore) {
			try { await previewMount.removePreviewTree(tmpRestore, { fs: artifactFs }); } catch { /* ignore cleanup */ }
		}
		if (backupDir) {
			try { await previewMount.removePreviewTree(backupDir, { fs: artifactFs }); } catch { /* ignore cleanup */ }
		}
	}

	const entryPath = path.join(liveMount, record.entry);
	let stat: fs.Stats;
	try {
		stat = await artifactFs.lstat(entryPath);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("restored entry is not a regular file");
	} catch (err) {
		throw new PreviewArtifactError(500, `Preview artifact restored entry missing: ${errorMessage(err)}`);
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

/** Delete all artifacts for a session. Invalid IDs and missing roots are no-ops. */
export async function removeArtifacts(sessionId: string): Promise<void> {
	if (!VALID_SESSION_ID.test(sessionId || "")) return;
	await previewMount.removePreviewTree(path.join(artifactRoot(), sessionId), { fs: artifactFs });
}

/** Remove artifact directories for sessions absent from the supplied set. */
export async function sweepOrphanArtifacts(
	knownSessionIds: Iterable<string>,
): Promise<{ removed: string[]; kept: string[] }> {
	const known = new Set<string>();
	for (const id of knownSessionIds) {
		if (VALID_SESSION_ID.test(id || "")) known.add(id.toLowerCase());
	}
	const removed: string[] = [];
	const kept: string[] = [];
	let directory: fs.Dir;
	try {
		const rootStats = await artifactFs.lstat(artifactRoot());
		if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return { removed, kept };
		directory = await artifactFs.opendir(artifactRoot());
	} catch { return { removed, kept }; }

	let candidates: string[] = [];
	const flushCandidates = async (): Promise<void> => {
		if (candidates.length === 0) return;
		const batch = candidates;
		candidates = [];
		const outcomes = await previewMount.removePreviewTrees(
			batch.map(id => path.join(artifactRoot(), id)),
			{ fs: artifactFs, concurrency: RECOVERY_IO_CONCURRENCY },
		);
		for (let index = 0; index < batch.length; index++) {
			if (outcomes[index] === null) removed.push(batch[index]!);
		}
	};
	try {
		for (;;) {
			const ent = await directory.read();
			if (!ent) break;
			const candidatePath = path.join(artifactRoot(), ent.name);
			let candidateStats: fs.Stats;
			try { candidateStats = await artifactFs.lstat(candidatePath); }
			catch { continue; }
			// Preserve the cleanup policy of ignoring non-directories. In
			// particular, a directory substituted with a symlink is not followed.
			if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) continue;
			if (VALID_SESSION_ID.test(ent.name) && known.has(ent.name.toLowerCase())) kept.push(ent.name);
			else candidates.push(ent.name);
			if (candidates.length >= RECOVERY_IO_CONCURRENCY) await flushCandidates();
		}
		await flushCandidates();
	} finally {
		try { await directory.close(); } catch { /* read failure may close the handle */ }
	}
	return { removed: removed.sort(), kept: kept.sort() };
}

/** Return the first valid matching artifact in filesystem enumeration order. */
export async function findPreviewArtifactByHash(
	sessionId: string,
	contentHash: string,
): Promise<PreviewArtifactRecord | null> {
	validateSessionId(sessionId);
	validateContentHash(contentHash);
	const sessionDir = artifactSessionDir(sessionId);
	let directory: fs.Dir;
	try {
		const sessionStats = await artifactFs.lstat(sessionDir);
		if (!sessionStats.isDirectory() || sessionStats.isSymbolicLink()) return null;
		directory = await artifactFs.opendir(sessionDir);
	} catch { return null; }
	try {
		for (;;) {
			const ent = await directory.read();
			if (!ent) break;
			if (!VALID_ARTIFACT_ID.test(ent.name)) continue;
			try {
				const candidateDir = artifactDir(sessionId, ent.name);
				const candidateStats = await artifactFs.lstat(candidateDir);
				if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) continue;
				const record = await readPreviewArtifact(sessionId, ent.name);
				if (record.contentHash !== contentHash) continue;
				await validateArtifactMount(record, artifactMountDir(sessionId, record.artifactId));
				return record;
			} catch {
				// Corrupt/mismatched entries are not reusable; leave them for maintenance.
			}
		}
		return null;
	} finally {
		try { await directory.close(); } catch { /* read failure may close the handle */ }
	}
}

async function validateArtifactMount(record: PreviewArtifactRecord, mountDir: string): Promise<void> {
	if (!(await safeLstat(mountDir))?.isDirectory()) {
		throw new PreviewArtifactError(500, "Preview artifact mount is missing");
	}
	const files = await listFiles(mountDir);
	if (!files.includes(record.entry)) throw new PreviewArtifactError(500, "Preview artifact entry is missing");
	const recorded = new Set(record.files);
	if (files.length !== record.files.length || files.some(rel => !recorded.has(rel))) {
		throw new PreviewArtifactError(500, "Preview artifact file list mismatch");
	}
	if (await hashDirectory(mountDir) !== record.contentHash) {
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
	if (!Array.isArray(v.files) || !v.files.every(file => typeof file === "string" && isSafeRelativeFile(file))) return null;
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
	if (!sessionId || !VALID_SESSION_ID.test(sessionId)) throw new PreviewArtifactError(400, "Invalid sessionId");
}

function validateArtifactId(artifactId: string): void {
	if (!artifactId || !VALID_ARTIFACT_ID.test(artifactId)) throw new PreviewArtifactError(400, "Invalid artifactId");
}

function validateContentHash(contentHash: string): void {
	if (!contentHash || !/^[a-f0-9]{64}$/i.test(contentHash)) {
		throw new PreviewArtifactError(500, "Invalid preview contentHash");
	}
}

function validateEntry(entry: string): void {
	if (!entry || typeof entry !== "string") throw new PreviewArtifactError(400, "Invalid entry");
	if (entry.includes("\0") || entry === "." || entry === ".." || entry.includes("/") || entry.includes("\\")) {
		throw new PreviewArtifactError(400, "Invalid entry");
	}
}

function createArtifactId(): string {
	return crypto.randomBytes(6).toString("base64url");
}

function randomSuffix(): string {
	return crypto.randomBytes(4).toString("hex");
}

async function copyDirectory(src: string, dst: string): Promise<void> {
	await previewMount.copyPreviewDirectory(src, dst, {
		fs: artifactFs,
		concurrency: RECOVERY_IO_CONCURRENCY,
	});
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomSuffix()}`;
	try {
		await artifactFs.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
		await artifactFs.rename(tmp, file);
	} catch (err) {
		try { await artifactFs.unlink(tmp); } catch { /* ignore cleanup */ }
		throw err;
	}
}

async function hashDirectory(root: string): Promise<string> {
	return previewMount.hashMountDirectory(root, {
		fs: artifactFs,
		concurrency: RECOVERY_IO_CONCURRENCY,
	});
}

async function listFiles(root: string): Promise<string[]> {
	return previewMount.listMountFiles(root, {
		fs: artifactFs,
		concurrency: RECOVERY_IO_CONCURRENCY,
	});
}

function isSafeRelativeFile(rel: string): boolean {
	if (!rel || rel.includes("\0") || rel.includes("\\")) return false;
	if (rel.startsWith("/") || path.isAbsolute(rel) || /^[a-zA-Z]:\//.test(rel)) return false;
	return rel.split("/").every(seg => seg.length > 0 && seg !== "." && seg !== "..");
}

async function safeLstat(file: string): Promise<fs.Stats | null> {
	try { return await artifactFs.lstat(file); } catch { return null; }
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
