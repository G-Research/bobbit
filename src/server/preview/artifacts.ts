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
	hasStableFileIdentity,
	mapWithConcurrency,
	readRegularFileNoFollowInChunks,
	sameFileIdentity,
	RECOVERY_IO_CONCURRENCY,
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

const PREVIEW_ARTIFACT_CATALOG_SESSION_LIMIT = 64;
const PREVIEW_ARTIFACT_CATALOG_CANDIDATE_LIMIT = 256;

interface PreviewArtifactPathStamp {
	dev: string;
	ino: string;
	type: number;
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	nlink: number;
}

interface PreviewArtifactCatalogEntry {
	artifactId: string;
	contentHash?: string;
	/** Exact no-follow artifact.json stamp, or null when verified metadata could not be read. */
	metadataStamp: PreviewArtifactPathStamp | null;
}

type PreviewArtifactSessionRootStamp = PreviewArtifactPathStamp;

interface PreviewArtifactCatalog {
	stamp: PreviewArtifactSessionRootStamp;
	/** Every syntactically valid candidate ID, in filesystem enumeration order. */
	entries: readonly PreviewArtifactCatalogEntry[];
	/** Ordered entry indexes; total indexes across the map never exceeds 256. */
	byHash: ReadonlyMap<string, readonly number[]>;
}

interface PreviewArtifactCatalogOperation {
	generation: bigint;
	io: previewMount.PreviewAsyncFs;
}

let _artifactRootOverride: string | undefined;
let artifactFs: previewMount.PreviewAsyncFs = previewMount.createPreviewAsyncFs(fs);
const previewArtifactCatalogs = new Map<string, PreviewArtifactCatalog>();
let previewArtifactCatalogGeneration = 0n;

export function setPreviewArtifactRootForTesting(dir: string | undefined): void {
	_artifactRootOverride = dir;
	clearPreviewArtifactCatalogs();
}

/** Install a promise-only filesystem test double for metadata and artifact trees. */
export function setPreviewArtifactFsForTesting(
	fsImpl: typeof fs | previewMount.PreviewAsyncFs | undefined,
): void {
	artifactFs = previewMount.createPreviewAsyncFs(fsImpl ?? fs);
	clearPreviewArtifactCatalogs();
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
	const liveStoreRoot = path.dirname(liveMount);
	const liveEntry = path.join(liveMount, mountResult.entry);
	const entryStat = await safeLstat(liveEntry);
	if (!entryStat?.isFile() || entryStat.isSymbolicLink()) {
		throw new PreviewArtifactError(500, "Preview entry missing before artifact capture");
	}

	const liveHash = await hashDirectory(liveMount, liveStoreRoot);
	if (liveHash !== mountResult.contentHash) {
		throw new PreviewArtifactError(500, "Preview mount changed before artifact capture");
	}

	const existing = await findPreviewArtifactByHash(sessionId, mountResult.contentHash);
	if (existing) return existing;

	const sessionDir = artifactSessionDir(sessionId);
	try {
		await artifactFs.mkdir(sessionDir, { recursive: true });
	} catch (error) {
		invalidatePreviewArtifactCatalog(sessionId);
		throw error;
	}
	for (let attempt = 0; attempt < 5; attempt++) {
		const artifactId = createArtifactId();
		const finalDir = path.join(sessionDir, artifactId);
		const tmpDir = path.join(sessionDir, `.tmp-${artifactId}-${process.pid}-${Date.now()}-${attempt}`);
		try {
			await artifactFs.mkdir(tmpDir, { recursive: false });
			const tmpMount = path.join(tmpDir, "mount");
			await copyDirectory(liveMount, tmpMount, liveStoreRoot);
			const copiedHash = await hashDirectory(tmpMount, artifactRoot());
			if (copiedHash !== mountResult.contentHash) {
				throw new PreviewArtifactError(500, "Preview artifact copy hash mismatch");
			}
			const files = await listFiles(tmpMount, artifactRoot());
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
			const priorCatalog = peekPreviewArtifactCatalog(sessionId);
			// Fence every lookup or cold scan captured before this candidate becomes
			// visible. The refresh below captures the first post-install operation;
			// its prior snapshot is revalidated rather than touched in place.
			invalidatePreviewArtifactCatalog(sessionId);
			await artifactFs.rename(tmpDir, finalDir);
			await refreshPreviewArtifactCatalogAfterInstall(sessionId, record, priorCatalog);
			return record;
		} catch (err) {
			invalidatePreviewArtifactCatalog(sessionId);
			try { await previewMount.removePreviewTree(tmpDir, { fs: artifactFs }); } catch { /* ignore cleanup */ }
			if (err instanceof PreviewArtifactError) throw err;
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === "EEXIST" || code === "ENOTEMPTY") continue;
			throw new PreviewArtifactError(500, `Preview artifact capture failed: ${errorMessage(err)}`);
		}
	}
	throw new PreviewArtifactError(500, "Preview artifact id collision");
}

interface BoundPreviewArtifactRecord {
	record: PreviewArtifactRecord;
	bound: previewMount.BoundPreviewDirectoryRoot;
	metadataStamp: PreviewArtifactPathStamp;
}

/** Read and validate one artifact record. */
export async function readPreviewArtifact(sessionId: string, artifactId: string): Promise<PreviewArtifactRecord> {
	return (await readPreviewArtifactWithFs(sessionId, artifactId, artifactFs)).record;
}

async function readPreviewArtifactWithFs(
	sessionId: string,
	artifactId: string,
	io: previewMount.PreviewAsyncFs,
	parentRoot?: previewMount.BoundPreviewDirectoryRoot,
): Promise<BoundPreviewArtifactRecord> {
	validateSessionId(sessionId);
	validateArtifactId(artifactId);
	const directory = artifactDir(sessionId, artifactId);
	const file = path.join(directory, "artifact.json");
	let parsed: unknown;
	let bound: previewMount.BoundPreviewDirectoryRoot;
	let metadataStats!: fs.Stats;
	try {
		// Carry candidate + session parent + trusted store identities as one flat
		// claim set over the raw filesystem. No guarded filesystem is rebound.
		const sessionBound = parentRoot ?? await previewMount.bindPreviewDirectoryRoot(
			artifactSessionDir(sessionId),
			{ fs: io, trustedRoot: artifactRoot() },
		);
		bound = await previewMount.bindPreviewDirectoryRoot(directory, {
			fs: io,
			parentRoot: sessionBound,
			trustedRoot: artifactRoot(),
		});
		metadataStats = await bound.fs.lstat(file);
		if (!metadataStats.isFile() || metadataStats.isSymbolicLink()) {
			throw new PreviewArtifactError(500, "Preview artifact metadata is invalid");
		}

		// The expected no-follow metadata identity is checked immediately after
		// open/handle.stat, before the first descriptor read or onChunk callback.
		const decoder = new StringDecoder("utf8");
		const textParts: string[] = [];
		await readRegularFileNoFollowInChunks(file, chunk => {
			textParts.push(decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
		}, {
			fs: bound.descriptorFs,
			containedWithin: bound.canonicalPath,
			expectedStats: metadataStats,
		});
		await bound.assertCurrent();
		textParts.push(decoder.end());
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
	await bound.assertCurrent();
	const metadataStamp = artifactMetadataStamp(metadataStats);
	if (!metadataStamp) throw new PreviewArtifactError(500, "Preview artifact metadata has no stable identity");
	return { record, bound, metadataStamp };
}

/** Restore a validated immutable artifact, rolling back a failed live swap. */
export async function restorePreviewArtifact(
	sessionId: string,
	artifactId: string,
): Promise<PreviewArtifactMountResult> {
	validateSessionId(sessionId);
	validateArtifactId(artifactId);

	const artifact = await readPreviewArtifactWithFs(sessionId, artifactId, artifactFs);
	const record = artifact.record;
	const sourceMount = artifactMountDir(sessionId, artifactId);
	await validateArtifactMount(record, sourceMount, artifactFs, artifact.bound);

	const liveMount = previewMount.mountPath(sessionId);
	const previewParent = path.dirname(liveMount);
	const tmpRestore = path.join(previewParent, `.restore-${sessionId}-${process.pid}-${Date.now()}-${randomSuffix()}`);
	let stagingCreated = false;
	let stagingExpectedRootStats: fs.Stats | undefined;
	try {
		await artifactFs.mkdir(previewParent, { recursive: true });
		await artifactFs.mkdir(tmpRestore, { recursive: false });
		stagingCreated = true;
		stagingExpectedRootStats = await artifactFs.lstat(tmpRestore);
		if (!stagingExpectedRootStats.isDirectory()
			|| stagingExpectedRootStats.isSymbolicLink()
			|| !hasStableFileIdentity(stagingExpectedRootStats)) {
			throw new PreviewArtifactError(500, "Preview artifact staging root has no stable identity");
		}
		await copyDirectory(sourceMount, tmpRestore, artifactRoot());
		const installed = await previewMount.installPreviewDirectoryTransaction(tmpRestore, liveMount, {
			fs: artifactFs,
			entry: record.entry,
			stagingExpectedRootStats,
			expectedContentHash: record.contentHash,
		});
		const entryPath = path.join(liveMount, record.entry);
		return {
			url: `/preview/${sessionId}/${record.entry}`,
			path: entryPath,
			relPath: path.posix.join(sessionId, record.entry),
			entry: record.entry,
			mtime: Math.floor(installed.entryStats.mtimeMs),
			contentHash: installed.contentHash,
			artifactId: record.artifactId,
		};
	} catch (err) {
		if (err instanceof PreviewArtifactError) throw err;
		throw new PreviewArtifactError(500, `Preview artifact restore failed: ${errorMessage(err)}`);
	} finally {
		if (stagingCreated) {
			try {
				if (stagingExpectedRootStats && hasStableFileIdentity(stagingExpectedRootStats)) {
					await previewMount.removePreviewTree(tmpRestore, {
						fs: artifactFs,
						expectedRootStats: stagingExpectedRootStats,
					});
				} else {
					// Stable identity failed before copy; rmdir cannot traverse anything.
					await artifactFs.rmdir(tmpRestore);
				}
			} catch (error) {
				if (!isEnoent(error)) {
					console.error(`[preview/artifacts] failed to clean owned restore staging root ${tmpRestore}`, error);
				}
			}
		}
	}
}

/** Delete all artifacts for a session. Invalid IDs and missing roots are no-ops. */
export async function removeArtifacts(sessionId: string): Promise<void> {
	if (!VALID_SESSION_ID.test(sessionId || "")) return;
	invalidatePreviewArtifactCatalog(sessionId);
	await previewMount.removePreviewTree(path.join(artifactRoot(), sessionId), { fs: artifactFs });
}

/** Remove artifact directories for sessions absent from the supplied set. */
export async function sweepOrphanArtifacts(
	knownSessionIds: Iterable<string>,
): Promise<{ removed: string[]; kept: string[] }> {
	// Fence catalogs being assembled while the maintenance namespace is scanned.
	advancePreviewArtifactCatalogGeneration();
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
		// A failed recursive removal may still have changed descendants. Invalidate
		// every attempted session before deletion, not only successful outcomes.
		for (const id of batch) invalidatePreviewArtifactCatalog(id);
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

type PreviewArtifactReadOutcome =
	| { ok: true; artifact: BoundPreviewArtifactRecord }
	| { ok: false; error: unknown };

/** Return the first valid matching artifact in filesystem enumeration order. */
export async function findPreviewArtifactByHash(
	sessionId: string,
	contentHash: string,
): Promise<PreviewArtifactRecord | null> {
	validateSessionId(sessionId);
	validateContentHash(contentHash);

	const operation = capturePreviewArtifactCatalogOperation();
	const sessionBound = await bindArtifactSessionRoot(sessionId, operation.io);
	if (!sessionBound) return null;
	const stamp = await currentArtifactSessionStamp(sessionId, sessionBound);
	if (!stamp) {
		invalidatePreviewArtifactCatalog(sessionId);
		return scanPreviewArtifactsByHash(sessionId, contentHash);
	}

	const catalog = peekPreviewArtifactCatalog(sessionId);
	if (catalog && sameArtifactSessionStamp(catalog.stamp, stamp)) {
		const metadataCurrent = await revalidatePreviewArtifactCatalogMetadata(
			sessionId,
			catalog,
			sessionBound,
			operation.io,
		);
		const revalidatedStamp = metadataCurrent
			? await currentArtifactSessionStamp(sessionId, sessionBound)
			: null;
		if (!revalidatedStamp
			|| !sameArtifactSessionStamp(catalog.stamp, revalidatedStamp)
			|| !previewArtifactCatalogOperationIsCurrent(operation)) {
			invalidatePreviewArtifactCatalog(sessionId);
			return scanPreviewArtifactsByHash(sessionId, contentHash);
		}

		const matchingIndexes = catalog.byHash.get(contentHash);
		if (!matchingIndexes) {
			// A complete negative is a successful catalog use and therefore refreshes
			// this session's actual LRU position only after every stamp was checked.
			touchPreviewArtifactCatalog(sessionId, catalog);
			return null;
		}

		for (const index of matchingIndexes) {
			const entry = catalog.entries[index]!;
			try {
				// Cached metadata is only an index. Positive reuse always reopens the
				// no-follow metadata descriptor and validates the immutable tree.
				const artifact = await readPreviewArtifactWithFs(
					sessionId,
					entry.artifactId,
					operation.io,
					sessionBound,
				);
				if (artifact.record.contentHash !== contentHash) throw staleArtifactCatalogError();
				await validateArtifactMount(
					artifact.record,
					artifactMountDir(sessionId, entry.artifactId),
					operation.io,
					artifact.bound,
				);
				const finalStamp = await currentArtifactSessionStamp(sessionId, sessionBound);
				if (!finalStamp
					|| !sameArtifactSessionStamp(catalog.stamp, finalStamp)
					|| !previewArtifactCatalogOperationIsCurrent(operation)) {
					throw staleArtifactCatalogError();
				}
				touchPreviewArtifactCatalog(sessionId, catalog);
				return artifact.record;
			} catch {
				// Any stale/corrupt positive invalidates the complete claim. A single
				// canonical rescan then skips it and can find the next exact candidate.
				invalidatePreviewArtifactCatalog(sessionId);
				return scanPreviewArtifactsByHash(sessionId, contentHash);
			}
		}
	}

	// A cold lookup has no cache state to invalidate. Avoid advancing the global
	// publish generation so unrelated cold session scans can populate in parallel.
	if (catalog) invalidatePreviewArtifactCatalog(sessionId);
	return scanPreviewArtifactsByHash(sessionId, contentHash, sessionBound, stamp, operation.io);
}

async function bindArtifactSessionRoot(
	sessionId: string,
	io: previewMount.PreviewAsyncFs = artifactFs,
): Promise<previewMount.BoundPreviewDirectoryRoot | null> {
	try {
		return await previewMount.bindPreviewDirectoryRoot(artifactSessionDir(sessionId), {
			fs: io,
			trustedRoot: artifactRoot(),
		});
	} catch {
		invalidatePreviewArtifactCatalog(sessionId);
		return null;
	}
}

async function currentArtifactSessionStamp(
	sessionId: string,
	sessionBound: previewMount.BoundPreviewDirectoryRoot,
): Promise<PreviewArtifactSessionRootStamp | null> {
	try {
		await sessionBound.assertCurrent();
		const current = await sessionBound.rawFs.lstat(artifactSessionDir(sessionId));
		await sessionBound.assertCurrent();
		if (!current.isDirectory()
			|| current.isSymbolicLink()
			|| !sameFileIdentity(sessionBound.stats, current)) {
			return null;
		}
		return artifactSessionStamp(current);
	} catch {
		return null;
	}
}

async function revalidatePreviewArtifactCatalogMetadata(
	sessionId: string,
	catalog: PreviewArtifactCatalog,
	sessionBound: previewMount.BoundPreviewDirectoryRoot,
	io: previewMount.PreviewAsyncFs,
): Promise<boolean> {
	try {
		await sessionBound.assertCurrent();
		const matches = await mapWithConcurrency(
			catalog.entries,
			RECOVERY_IO_CONCURRENCY,
			async entry => {
				if (!entry.metadataStamp) return false;
				try {
					// Intentionally use the operation's raw seam. The shared session
					// binding brackets the bounded batch without nesting guard wrappers.
					const current = await io.lstat(path.join(artifactDir(sessionId, entry.artifactId), "artifact.json"));
					const currentStamp = artifactMetadataStamp(current);
					return currentStamp !== null && sameArtifactPathStamp(entry.metadataStamp, currentStamp);
				} catch {
					return false;
				}
			},
		);
		await sessionBound.assertCurrent();
		return matches.every(Boolean);
	} catch {
		return false;
	}
}

function artifactPathStamp(stats: fs.Stats): PreviewArtifactPathStamp | null {
	if (!hasStableFileIdentity(stats)
		|| !Number.isFinite(stats.mode)
		|| !Number.isFinite(stats.mtimeMs)
		|| !Number.isFinite(stats.ctimeMs)
		|| !Number.isFinite(stats.size)
		|| !Number.isFinite(stats.nlink)) {
		return null;
	}
	return {
		dev: String(stats.dev),
		ino: String(stats.ino),
		type: stats.mode & 0o170000,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
		size: stats.size,
		nlink: stats.nlink,
	};
}

function artifactSessionStamp(stats: fs.Stats): PreviewArtifactSessionRootStamp | null {
	if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
	return artifactPathStamp(stats);
}

function artifactMetadataStamp(stats: fs.Stats): PreviewArtifactPathStamp | null {
	if (!stats.isFile() || stats.isSymbolicLink()) return null;
	return artifactPathStamp(stats);
}

function sameArtifactSessionIdentity(
	left: PreviewArtifactSessionRootStamp,
	right: PreviewArtifactSessionRootStamp,
): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.type === right.type;
}

function sameArtifactPathStamp(
	left: PreviewArtifactPathStamp,
	right: PreviewArtifactPathStamp,
): boolean {
	return sameArtifactSessionIdentity(left, right)
		&& left.mtimeMs === right.mtimeMs
		&& left.ctimeMs === right.ctimeMs
		&& left.size === right.size
		&& left.nlink === right.nlink;
}

const sameArtifactSessionStamp = sameArtifactPathStamp;

async function readPreviewArtifactBatch(
	sessionId: string,
	artifactIds: readonly string[],
	sessionBound: previewMount.BoundPreviewDirectoryRoot,
	io: previewMount.PreviewAsyncFs,
): Promise<PreviewArtifactReadOutcome[]> {
	await sessionBound.assertCurrent();
	const outcomes = await mapWithConcurrency(
		artifactIds,
		RECOVERY_IO_CONCURRENCY,
		async (artifactId): Promise<PreviewArtifactReadOutcome> => {
			try {
				await sessionBound.assertCurrent();
				const artifact = await readPreviewArtifactWithFs(
					sessionId,
					artifactId,
					io,
					sessionBound,
				);
				await sessionBound.assertCurrent();
				return { ok: true, artifact };
			} catch (error) {
				// One corrupt candidate must not reject the ordered batch. Recheck the
				// shared parent so a replaced root still aborts at the batch boundary.
				try {
					await sessionBound.assertCurrent();
				} catch (rootError) {
					return { ok: false, error: rootError };
				}
				return { ok: false, error };
			}
		},
	);
	await sessionBound.assertCurrent();
	return outcomes;
}

async function scanPreviewArtifactsByHash(
	sessionId: string,
	contentHash: string,
	existingBound?: previewMount.BoundPreviewDirectoryRoot,
	existingStamp?: PreviewArtifactSessionRootStamp,
	io: previewMount.PreviewAsyncFs = artifactFs,
): Promise<PreviewArtifactRecord | null> {
	const operation = capturePreviewArtifactCatalogOperation(io);
	const sessionBound = existingBound ?? await bindArtifactSessionRoot(sessionId, io);
	if (!sessionBound) return null;
	const scanStamp = existingStamp ?? await currentArtifactSessionStamp(sessionId, sessionBound) ?? undefined;
	const sessionDir = artifactSessionDir(sessionId);
	let directory: fs.Dir;
	try {
		directory = await sessionBound.fs.opendir(sessionDir);
	} catch {
		invalidatePreviewArtifactCatalog(sessionId);
		return null;
	}

	let catalogEntries: PreviewArtifactCatalogEntry[] | undefined = scanStamp ? [] : undefined;
	let candidateCount = 0;
	const inspectBatch = async (artifactIds: readonly string[]): Promise<PreviewArtifactRecord | null> => {
		const outcomes = await readPreviewArtifactBatch(sessionId, artifactIds, sessionBound, io);
		if (catalogEntries) {
			for (let index = 0; index < artifactIds.length; index++) {
				const outcome = outcomes[index]!;
				catalogEntries.push({
					artifactId: artifactIds[index]!,
					metadataStamp: outcome.ok ? outcome.artifact.metadataStamp : null,
					...(outcome.ok ? { contentHash: outcome.artifact.record.contentHash } : {}),
				});
			}
		}

		// Metadata may finish out of order, but exact tree validation remains
		// sequential. No later directory batch is prefetched during validation.
		for (const outcome of outcomes) {
			await sessionBound.assertCurrent();
			if (!outcome.ok || outcome.artifact.record.contentHash !== contentHash) continue;
			try {
				await validateArtifactMount(
					outcome.artifact.record,
					artifactMountDir(sessionId, outcome.artifact.record.artifactId),
					io,
					outcome.artifact.bound,
				);
				await sessionBound.assertCurrent();
				return outcome.artifact.record;
			} catch {
				// Corrupt/mismatched entries remain in place for maintenance.
				await sessionBound.assertCurrent();
			}
		}
		return null;
	};

	try {
		let artifactIds: string[] = [];
		for (;;) {
			await sessionBound.assertCurrent();
			const ent = await directory.read();
			await sessionBound.assertCurrent();
			if (!ent) {
				const exact = artifactIds.length > 0 ? await inspectBatch(artifactIds) : null;
				if (catalogEntries && scanStamp) {
					await installPreviewArtifactCatalogIfStable(
						sessionId,
						sessionBound,
						scanStamp,
						catalogEntries,
						operation,
					);
				}
				return exact;
			}
			if (!VALID_ARTIFACT_ID.test(ent.name)) continue;
			candidateCount++;
			if (candidateCount > PREVIEW_ARTIFACT_CATALOG_CANDIDATE_LIMIT) {
				// Release bounded metadata immediately. The canonical batch scan keeps
				// streaming, but this oversized session is deliberately left uncached.
				catalogEntries = undefined;
			}
			artifactIds.push(ent.name);
			if (artifactIds.length < RECOVERY_IO_CONCURRENCY) continue;
			const batch = artifactIds;
			artifactIds = [];
			const exact = await inspectBatch(batch);
			if (exact) return exact;
		}
	} catch (error) {
		invalidatePreviewArtifactCatalog(sessionId);
		throw error;
	} finally {
		try { await directory.close(); } catch { /* read failure may close the handle */ }
	}
}

async function installPreviewArtifactCatalogIfStable(
	sessionId: string,
	sessionBound: previewMount.BoundPreviewDirectoryRoot,
	scanStamp: PreviewArtifactSessionRootStamp,
	entries: readonly PreviewArtifactCatalogEntry[],
	operation: PreviewArtifactCatalogOperation,
): Promise<void> {
	if (entries.length > PREVIEW_ARTIFACT_CATALOG_CANDIDATE_LIMIT) return;
	const finalStamp = await currentArtifactSessionStamp(sessionId, sessionBound);
	if (!finalStamp || !sameArtifactSessionStamp(scanStamp, finalStamp)) {
		invalidatePreviewArtifactCatalog(sessionId);
		return;
	}
	if (!previewArtifactCatalogOperationIsCurrent(operation)) return;
	setPreviewArtifactCatalog(sessionId, createPreviewArtifactCatalog(finalStamp, entries));
}

function createPreviewArtifactCatalog(
	stamp: PreviewArtifactSessionRootStamp,
	entries: readonly PreviewArtifactCatalogEntry[],
): PreviewArtifactCatalog {
	const ownedEntries = entries.map(entry => ({
		...entry,
		metadataStamp: entry.metadataStamp ? { ...entry.metadataStamp } : null,
	}));
	const byHash = new Map<string, number[]>();
	for (let index = 0; index < ownedEntries.length; index++) {
		const hash = ownedEntries[index]!.contentHash;
		if (!hash) continue;
		const indexes = byHash.get(hash);
		if (indexes) indexes.push(index);
		else byHash.set(hash, [index]);
	}
	return { stamp, entries: ownedEntries, byHash };
}

function artifactCatalogKey(sessionId: string): string {
	const resolved = path.resolve(artifactSessionDir(sessionId));
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function peekPreviewArtifactCatalog(sessionId: string): PreviewArtifactCatalog | undefined {
	return previewArtifactCatalogs.get(artifactCatalogKey(sessionId));
}

function touchPreviewArtifactCatalog(sessionId: string, catalog: PreviewArtifactCatalog): void {
	const key = artifactCatalogKey(sessionId);
	previewArtifactCatalogs.delete(key);
	previewArtifactCatalogs.set(key, catalog);
}

function setPreviewArtifactCatalog(sessionId: string, catalog: PreviewArtifactCatalog): void {
	touchPreviewArtifactCatalog(sessionId, catalog);
	while (previewArtifactCatalogs.size > PREVIEW_ARTIFACT_CATALOG_SESSION_LIMIT) {
		const oldest = previewArtifactCatalogs.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		previewArtifactCatalogs.delete(oldest);
		advancePreviewArtifactCatalogGeneration();
	}
}

function advancePreviewArtifactCatalogGeneration(): void {
	previewArtifactCatalogGeneration++;
}

function clearPreviewArtifactCatalogs(): void {
	advancePreviewArtifactCatalogGeneration();
	previewArtifactCatalogs.clear();
}

function invalidatePreviewArtifactCatalog(sessionId: string): void {
	if (!VALID_SESSION_ID.test(sessionId || "")) return;
	advancePreviewArtifactCatalogGeneration();
	previewArtifactCatalogs.delete(artifactCatalogKey(sessionId));
}

function capturePreviewArtifactCatalogOperation(
	io: previewMount.PreviewAsyncFs = artifactFs,
): PreviewArtifactCatalogOperation {
	return { generation: previewArtifactCatalogGeneration, io };
}

function previewArtifactCatalogOperationIsCurrent(operation: PreviewArtifactCatalogOperation): boolean {
	return operation.generation === previewArtifactCatalogGeneration && operation.io === artifactFs;
}

async function refreshPreviewArtifactCatalogAfterInstall(
	sessionId: string,
	record: PreviewArtifactRecord,
	prior: PreviewArtifactCatalog | undefined,
): Promise<void> {
	const operation = capturePreviewArtifactCatalogOperation();
	try {
		const sessionBound = await bindArtifactSessionRoot(sessionId, operation.io);
		if (!sessionBound) return;
		const startStamp = await currentArtifactSessionStamp(sessionId, sessionBound);
		if (!startStamp) {
			invalidatePreviewArtifactCatalog(sessionId);
			return;
		}
		const artifactIds = await enumerateArtifactCandidateIds(sessionBound);
		if (!artifactIds) {
			invalidatePreviewArtifactCatalog(sessionId);
			return;
		}

		const installed = await readPreviewArtifactWithFs(
			sessionId,
			record.artifactId,
			operation.io,
			sessionBound,
		);
		if (installed.record.contentHash !== record.contentHash) {
			invalidatePreviewArtifactCatalog(sessionId);
			return;
		}
		const installedEntry: PreviewArtifactCatalogEntry = {
			artifactId: record.artifactId,
			contentHash: record.contentHash,
			metadataStamp: installed.metadataStamp,
		};

		let entries: PreviewArtifactCatalogEntry[];
		if (prior && sameArtifactSessionIdentity(prior.stamp, startStamp)) {
			const priorById = new Map(prior.entries.map(entry => [entry.artifactId, entry]));
			if (priorById.has(record.artifactId)
				|| artifactIds.length !== prior.entries.length + 1
				|| !artifactIds.includes(record.artifactId)
				|| artifactIds.some(id => id !== record.artifactId && !priorById.has(id))
				|| !await revalidatePreviewArtifactCatalogMetadata(sessionId, prior, sessionBound, operation.io)
				|| !previewArtifactCatalogOperationIsCurrent(operation)) {
				invalidatePreviewArtifactCatalog(sessionId);
				return;
			}
			// Rebuild from the current enumeration so an owned different-hash install
			// cannot move ahead of retained candidates or otherwise reorder reuse.
			entries = artifactIds.map(artifactId => artifactId === record.artifactId
				? installedEntry
				: { ...priorById.get(artifactId)! });
		} else if (artifactIds.length === 1 && artifactIds[0] === record.artifactId) {
			// A newly-created session proves the only candidate is the owned install.
			entries = [installedEntry];
		} else {
			invalidatePreviewArtifactCatalog(sessionId);
			return;
		}

		await installPreviewArtifactCatalogIfStable(
			sessionId,
			sessionBound,
			startStamp,
			entries,
			operation,
		);
	} catch {
		// Artifact installation has already committed. Cache ambiguity must not
		// turn that durable success into an API failure.
		invalidatePreviewArtifactCatalog(sessionId);
	}
}

async function enumerateArtifactCandidateIds(
	sessionBound: previewMount.BoundPreviewDirectoryRoot,
): Promise<string[] | null> {
	let directory: fs.Dir;
	try {
		directory = await sessionBound.fs.opendir(sessionBound.path);
	} catch {
		return null;
	}
	const artifactIds: string[] = [];
	try {
		for (;;) {
			await sessionBound.assertCurrent();
			const ent = await directory.read();
			await sessionBound.assertCurrent();
			if (!ent) return artifactIds;
			if (!VALID_ARTIFACT_ID.test(ent.name)) continue;
			artifactIds.push(ent.name);
			if (artifactIds.length > PREVIEW_ARTIFACT_CATALOG_CANDIDATE_LIMIT) return null;
		}
	} finally {
		try { await directory.close(); } catch { /* read failure may close the handle */ }
	}
}

function staleArtifactCatalogError(): Error {
	const error = new Error("Preview artifact catalog is stale") as NodeJS.ErrnoException;
	error.code = "ESTALE";
	return error;
}

async function validateArtifactMount(
	record: PreviewArtifactRecord,
	mountDir: string,
	io: previewMount.PreviewAsyncFs = artifactFs,
	parentRoot?: previewMount.BoundPreviewDirectoryRoot,
): Promise<void> {
	let bound: previewMount.BoundPreviewDirectoryRoot;
	try {
		bound = await previewMount.bindPreviewDirectoryRoot(mountDir, {
			fs: io,
			parentRoot,
			trustedRoot: artifactRoot(),
		});
	} catch (error) {
		if (isEnoent(error)) throw new PreviewArtifactError(500, "Preview artifact mount is missing");
		throw error;
	}
	const files = await listFiles(mountDir, artifactRoot(), io, bound);
	if (!files.includes(record.entry)) throw new PreviewArtifactError(500, "Preview artifact entry is missing");
	const recorded = new Set(record.files);
	if (files.length !== record.files.length || files.some(rel => !recorded.has(rel))) {
		throw new PreviewArtifactError(500, "Preview artifact file list mismatch");
	}
	if (await hashDirectory(mountDir, artifactRoot(), io, bound) !== record.contentHash) {
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

async function copyDirectory(src: string, dst: string, trustedRoot: string): Promise<void> {
	await previewMount.copyPreviewDirectory(src, dst, {
		fs: artifactFs,
		concurrency: RECOVERY_IO_CONCURRENCY,
		trustedRoot,
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

async function hashDirectory(
	root: string,
	trustedRoot: string,
	io: previewMount.PreviewAsyncFs = artifactFs,
	boundRoot?: previewMount.BoundPreviewDirectoryRoot,
): Promise<string> {
	return previewMount.hashMountDirectory(root, {
		fs: io,
		concurrency: RECOVERY_IO_CONCURRENCY,
		trustedRoot,
		boundRoot,
	});
}

async function listFiles(
	root: string,
	trustedRoot: string,
	io: previewMount.PreviewAsyncFs = artifactFs,
	boundRoot?: previewMount.BoundPreviewDirectoryRoot,
): Promise<string[]> {
	return previewMount.listMountFiles(root, {
		fs: io,
		concurrency: RECOVERY_IO_CONCURRENCY,
		trustedRoot,
		boundRoot,
	});
}

function isSafeRelativeFile(rel: string): boolean {
	if (!rel || rel.includes("\0") || rel.includes("\\")) return false;
	if (rel.startsWith("/") || path.isAbsolute(rel) || /^[a-zA-Z]:\//.test(rel)) return false;
	return rel.split("/").every(seg => seg.length > 0 && seg !== "." && seg !== "..");
}

async function safeLstat(
	file: string,
	io: previewMount.PreviewAsyncFs = artifactFs,
): Promise<fs.Stats | null> {
	try { return await io.lstat(file); } catch { return null; }
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
