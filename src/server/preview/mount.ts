/**
 * Per-session preview mount lifecycle.
 *
 * Single source of truth for `<bobbitStateDir>/preview/<sid>/`. Owned by
 * the gateway: agent extension POSTs HTML / file paths to a mount endpoint
 * (WP-D), the route handler calls `writeInline` / `mountFile` here, and
 * the content-origin route (WP-B) serves files back out of `mountDir(sid)`.
 *
 * Asset inclusion contract (post opt-in):
 *   - `writeInline(sid, html, entry?)` writes only the entry — no siblings.
 *   - `mountFile(sid, srcFile, assets?)` copies only `srcFile` plus the
 *     declared assets (literals or single-segment globs). Sibling files in
 *     the source dir that are NOT declared are NOT copied.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { bobbitStateDir } from "../bobbit-dir.js";
import {
	copyRegularFileNoFollow,
	hasStableFileIdentity,
	mapWithConcurrency,
	readRegularFileNoFollowInChunks,
	RECOVERY_IO_CONCURRENCY,
	sameFileIdentity,
	removeTree,
	walkTree,
	type AsyncTreeDirectory,
	type AsyncTreeStats,
} from "../agent/bounded-async-work.js";
import { realClock, type Clock, type TimerHandle } from "../gateway-deps.js";

const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH_READ_BUFFER_BYTES = 64 * 1024;

/**
 * @deprecated The 100 MiB mount ceiling was removed when asset inclusion
 * became explicit. Kept for backwards-compatible imports.
 */
export const MAX_MOUNT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_INLINE_ENTRY = "inline.html";

export interface MountResult {
	url: string;
	path: string;
	relPath: string;
	entry: string;
	mtime: number;
	contentHash: string;
}

export interface MountFileResult extends MountResult {
	assets: string[];
}

export class PreviewMountError extends Error {
	statusCode: number;
	constructor(statusCode: number, message: string) {
		super(message);
		this.name = "PreviewMountError";
		this.statusCode = statusCode;
	}
}

/** Promise-only filesystem seam used by preview scans, copies, and cleanup. */
export interface PreviewAsyncFs {
	mkdir(filePath: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }): Promise<string | undefined>;
	writeFile(filePath: fs.PathLike, data: string | Uint8Array, options?: BufferEncoding | fs.ObjectEncodingOptions): Promise<void>;
	readFile(filePath: fs.PathLike, encoding: BufferEncoding): Promise<string>;
	rename(oldPath: fs.PathLike, newPath: fs.PathLike): Promise<void>;
	unlink(filePath: fs.PathLike): Promise<void>;
	rmdir(filePath: fs.PathLike): Promise<void>;
	stat(filePath: fs.PathLike): Promise<fs.Stats>;
	lstat(filePath: fs.PathLike): Promise<fs.Stats>;
	realpath(filePath: fs.PathLike): Promise<string>;
	readdir(filePath: fs.PathLike, options: { withFileTypes: true }): Promise<fs.Dirent[]>;
	opendir(filePath: fs.PathLike): Promise<fs.Dir>;
	open(filePath: fs.PathLike, flags: string | number, mode?: number): Promise<fs.promises.FileHandle>;
	copyFile(src: fs.PathLike, dest: fs.PathLike, mode?: number): Promise<void>;
	link(existingPath: fs.PathLike, newPath: fs.PathLike): Promise<void>;
	utimes(filePath: fs.PathLike, atime: string | number | Date, mtime: string | number | Date): Promise<void>;
}

export function createPreviewAsyncFs(fsImpl: typeof fs | PreviewAsyncFs): PreviewAsyncFs {
	const candidate = "promises" in fsImpl ? fsImpl.promises : fsImpl;
	return {
		mkdir: (filePath, options) => candidate.mkdir(filePath, options as never) as Promise<string | undefined>,
		writeFile: (filePath, data, options) => candidate.writeFile(filePath, data, options as never),
		readFile: (filePath, encoding) => candidate.readFile(filePath, encoding) as Promise<string>,
		rename: (oldPath, newPath) => candidate.rename(oldPath, newPath),
		unlink: filePath => candidate.unlink(filePath),
		rmdir: filePath => candidate.rmdir(filePath),
		stat: filePath => candidate.stat(filePath) as Promise<fs.Stats>,
		lstat: filePath => candidate.lstat(filePath) as Promise<fs.Stats>,
		realpath: filePath => candidate.realpath(filePath) as Promise<string>,
		readdir: (filePath, options) => candidate.readdir(filePath, options) as Promise<fs.Dirent[]>,
		opendir: filePath => candidate.opendir(filePath) as Promise<fs.Dir>,
		open: (filePath, flags, mode) => candidate.open(filePath, flags, mode) as Promise<fs.promises.FileHandle>,
		copyFile: (src, dest, mode) => candidate.copyFile(src, dest, mode),
		link: (existingPath, newPath) => candidate.link(existingPath, newPath),
		utimes: (filePath, atime, mtime) => candidate.utimes(filePath, atime, mtime),
	};
}

let _previewRootOverride: string | undefined;
let mountSyncFs: typeof fs = fs;
let mountAsyncFs: PreviewAsyncFs = createPreviewAsyncFs(fs);

export function setPreviewRootForTesting(dir: string | undefined): void {
	_previewRootOverride = dir;
}

/** Swap both mount filesystems for a test double. Always reset after the test. */
export function setPreviewFsForTesting(fsImpl: typeof fs | PreviewAsyncFs | undefined): void {
	mountSyncFs = fsImpl && "promises" in fsImpl ? fsImpl : fs;
	mountAsyncFs = fsImpl ? createPreviewAsyncFs(fsImpl) : createPreviewAsyncFs(fs);
}

function previewRoot(): string {
	return _previewRootOverride ?? path.join(bobbitStateDir(), "preview");
}

/** Path to the per-session mount without creating it. */
export function mountPath(sessionId: string): string {
	validateSessionId(sessionId);
	return path.join(previewRoot(), sessionId);
}

function validateSessionId(sessionId: string): void {
	if (!sessionId || !VALID_SESSION_ID.test(sessionId)) {
		throw new PreviewMountError(400, "Invalid sessionId");
	}
}

function validateEntry(entry: string): string {
	if (!entry || typeof entry !== "string") throw new PreviewMountError(400, "Invalid entry");
	if (entry.includes("\0") || entry === "." || entry === ".." || entry.includes("/") || entry.includes("\\") || entry.includes("..")) {
		throw new PreviewMountError(400, "Invalid entry");
	}
	return entry;
}

function validateAssetSpec(asset: unknown): string {
	if (typeof asset !== "string") throw new PreviewMountError(400, "Asset must be a string");
	const trimmed = asset.trim();
	if (!trimmed) throw new PreviewMountError(400, "Asset must be a non-empty string");
	if (trimmed.includes("\0")) throw new PreviewMountError(400, `Invalid asset path: ${asset}`);
	if (trimmed.includes("\\")) throw new PreviewMountError(400, `Invalid asset path (use forward slashes): ${asset}`);
	if (path.isAbsolute(trimmed) || /^[a-zA-Z]:\//.test(trimmed)) {
		throw new PreviewMountError(400, `Asset path must be relative: ${asset}`);
	}
	if (trimmed.split("/").includes("..")) throw new PreviewMountError(400, `Asset path may not contain '..': ${asset}`);
	if (trimmed.includes("**")) throw new PreviewMountError(400, `Glob '**' is not supported: ${asset}`);
	if (trimmed.includes("[") || trimmed.includes("]")) {
		throw new PreviewMountError(400, `Glob character class '[...]' is not supported: ${asset}`);
	}
	if (trimmed.includes("{") || trimmed.includes("}")) {
		throw new PreviewMountError(400, `Glob brace expansion '{a,b}' is not supported: ${asset}`);
	}
	return trimmed;
}

function isGlob(spec: string): boolean {
	return spec.includes("*") || spec.includes("?");
}

function compileGlobSegment(segment: string): RegExp {
	let re = "^";
	for (const ch of segment) {
		if (ch === "*") re += "[^/]*";
		else if (ch === "?") re += "[^/]";
		else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
	}
	return new RegExp(`${re}$`);
}

/**
 * Legacy creating path helper used by the synchronous content/watch surface.
 * Async mutation and background-cleanup paths use mountPath plus promise I/O.
 */
export function mountDir(sessionId: string): string {
	const dir = mountPath(sessionId);
	mountSyncFs.mkdirSync(dir, { recursive: true });
	return dir;
}

export async function writeInline(sessionId: string, html: string, entry?: string): Promise<MountResult> {
	validateSessionId(sessionId);
	const safeEntry = validateEntry(entry ?? DEFAULT_INLINE_ENTRY);
	if (typeof html !== "string") throw new PreviewMountError(400, "html must be a string");

	const dir = mountPath(sessionId);
	return withPreviewDirectoryUnavailable(dir, async fence => {
		if (fence.wasBlocked) {
			const detached = await quarantinePreviewDirectory(dir);
			await assertPreviewDirectoryAbsent(dir, mountAsyncFs);
			if (detached) await cleanupOwnedPreviewDirectory(detached, mountAsyncFs, "blocked inline mount");
		}
		await mountAsyncFs.mkdir(dir, { recursive: true });
		const target = path.join(dir, safeEntry);
		const tmp = path.join(dir, `.${safeEntry}.tmp-${process.pid}-${Date.now()}`);
		await mountAsyncFs.writeFile(tmp, html, "utf-8");
		try {
			await mountAsyncFs.rename(tmp, target);
		} catch (err) {
			try { await mountAsyncFs.unlink(tmp); } catch { /* ignore cleanup */ }
			throw err;
		}

		const stat = await mountAsyncFs.lstat(target);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new PreviewMountError(500, "Inline preview entry is not a regular file");
		// The entry and full content hash are both checked while the writer fence
		// is held. Only this explicit verification makes the pathname servable.
		const contentHash = await hashMountDirectory(dir, { trustedRoot: previewRoot() });
		markPreviewDirectoryVerified(dir);
		return {
			url: `/preview/${sessionId}/${safeEntry}`,
			path: target,
			relPath: path.posix.join(sessionId, safeEntry),
			entry: safeEntry,
			mtime: Math.floor(stat.mtimeMs),
			contentHash,
		};
	});
}

export async function mountFile(
	sessionId: string,
	srcFile: string,
	assets?: string[],
): Promise<MountFileResult> {
	validateSessionId(sessionId);
	if (!srcFile || typeof srcFile !== "string") throw new PreviewMountError(400, "srcFile required");
	if (!path.isAbsolute(srcFile)) throw new PreviewMountError(400, "srcFile must be absolute");

	const srcDir = path.dirname(srcFile);
	let srcRoot: string;
	try { srcRoot = await mountAsyncFs.realpath(srcDir); }
	catch { throw new PreviewMountError(404, "srcFile parent not found"); }

	let entryStat: fs.Stats;
	try { entryStat = await mountAsyncFs.stat(srcFile); }
	catch { throw new PreviewMountError(404, "srcFile not found"); }
	if (!entryStat.isFile()) throw new PreviewMountError(404, "srcFile not a regular file");

	const entry = validateEntry(path.basename(srcFile));
	const destRoot = mountPath(sessionId);
	await mountAsyncFs.mkdir(previewRoot(), { recursive: true });
	const specs = (Array.isArray(assets) ? assets : []).map(validateAssetSpec);

	let entryReal: string;
	try { entryReal = await mountAsyncFs.realpath(srcFile); }
	catch { entryReal = srcFile; }
	if (!isContained(entryReal, srcRoot) && entryReal !== path.join(srcRoot, entry)) {
		throw new PreviewMountError(403, "Entry symlink escapes source tree");
	}

	const tmpName = `.${sessionId}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
	const tmpRoot = path.join(previewRoot(), tmpName);
	await mountAsyncFs.mkdir(tmpRoot, { recursive: true });
	let stagingExpectedRootStats: fs.Stats | undefined;
	let stagingBound: BoundPreviewDirectoryRoot;
	try {
		stagingExpectedRootStats = await mountAsyncFs.lstat(tmpRoot);
		assertStablePreviewDirectory(stagingExpectedRootStats, "Preview staging root");
		stagingBound = await bindPreviewDirectoryRoot(tmpRoot, {
			fs: mountAsyncFs,
			trustedRoot: previewRoot(),
		});
		if (!matchesDirectoryIdentity(stagingExpectedRootStats, stagingBound.stats)) {
			throw new PreviewMountError(500, "Preview staging root changed while it was bound");
		}
	} catch (error) {
		// A filesystem without stable directory identity cannot participate in an
		// atomic install. The live mount has not been fenced or mutated yet. A
		// direct rmdir is safe for the just-created empty root and never traverses.
		try { await mountAsyncFs.rmdir(tmpRoot); } catch { /* preserve the identity error */ }
		throw new PreviewMountError(500, `Preview staging root is not stable: ${errorMessage(error)}`);
	}

	const resolvedAssets = new Set<string>();
	const copiedDestinations = new Set<string>();
	const copyIntoStaging = async (source: string, destination: string): Promise<void> => {
		const key = previewInstallKey(destination);
		if (copiedDestinations.has(key)) return;
		await copyOneFile(source, destination, srcRoot, stagingBound);
		copiedDestinations.add(key);
	};
	try {
		await copyIntoStaging(entryReal, path.join(tmpRoot, entry));
		for (const spec of specs) {
			if (isGlob(spec)) {
				const matches = await expandGlob(srcRoot, spec);
				for (const rel of matches) {
					const abs = path.join(srcRoot, rel);
					let real: string;
					try { real = await mountAsyncFs.realpath(abs); } catch { continue; }
					if (!isContained(real, srcRoot)) throw new PreviewMountError(403, `Asset escapes source tree: ${rel}`);
					let st: fs.Stats;
					try { st = await mountAsyncFs.stat(real); } catch { continue; }
					if (!st.isFile()) continue;
					const dst = path.join(tmpRoot, rel);
					await stagingBound.fs.mkdir(path.dirname(dst), { recursive: true });
					await stagingBound.assertCurrent();
					await copyIntoStaging(real, dst);
					resolvedAssets.add(rel.split(path.sep).join("/"));
				}
			} else {
				const rel = spec;
				const abs = path.resolve(srcRoot, rel);
				if (!isContained(abs, srcRoot)) throw new PreviewMountError(400, `Asset escapes source tree: ${rel}`);
				let real: string;
				try { real = await mountAsyncFs.realpath(abs); }
				catch { throw new PreviewMountError(404, `Asset '${rel}' not found`); }
				if (!isContained(real, srcRoot)) throw new PreviewMountError(403, `Asset symlink escapes source tree: ${rel}`);
				let st: fs.Stats;
				try { st = await mountAsyncFs.stat(real); }
				catch { throw new PreviewMountError(404, `Asset '${rel}' not found`); }
				if (!st.isFile()) throw new PreviewMountError(404, `Asset '${rel}' is not a regular file`);
				const dst = path.join(tmpRoot, rel);
				await stagingBound.fs.mkdir(path.dirname(dst), { recursive: true });
				await stagingBound.assertCurrent();
				await copyIntoStaging(real, dst);
				resolvedAssets.add(rel);
			}
		}

		const installed = await installPreviewDirectoryTransaction(tmpRoot, destRoot, {
			fs: mountAsyncFs,
			entry,
			stagingExpectedRootStats,
		});
		const target = path.join(destRoot, entry);
		return {
			url: `/preview/${sessionId}/${entry}`,
			path: target,
			relPath: path.posix.join(sessionId, entry),
			entry,
			mtime: Math.floor(installed.entryStats.mtimeMs),
			contentHash: installed.contentHash,
			assets: Array.from(resolvedAssets).sort(),
		};
	} finally {
		// The transaction's move primitive never consumes the source on a
		// pre-rename error. This staging owner may remove only the inode it created.
		try {
			await removePreviewTree(tmpRoot, {
				fs: mountAsyncFs,
				expectedRootStats: stagingExpectedRootStats,
			});
		} catch (error) {
			console.error(`[preview/mount] failed to clean owned staging root ${tmpRoot}`, error);
		}
	}
}

export async function contentHashForMount(sessionId: string): Promise<string> {
	validateSessionId(sessionId);
	return hashMountDirectory(mountPath(sessionId), { trustedRoot: previewRoot() });
}

export async function removeMount(sessionId: string): Promise<void> {
	if (!sessionId || !VALID_SESSION_ID.test(sessionId)) return;
	const root = path.join(previewRoot(), sessionId);
	await withPreviewDirectoryUnavailable(root, async fence => {
		if (fence.wasBlocked) {
			// A failed writer leaves an untrusted live pathname. Detach it with one
			// no-follow rename, verify live absence, then clean only the detached
			// identity under the serialized ownership lane.
			const detached = await quarantinePreviewDirectory(root);
			await assertPreviewDirectoryAbsent(root, mountAsyncFs);
			markPreviewDirectoryVerified(root);
			if (detached) await cleanupOwnedPreviewDirectory(detached, mountAsyncFs, "blocked mount purge");
			return;
		}

		let expectedRootStats: fs.Stats;
		try { expectedRootStats = await mountAsyncFs.lstat(root); }
		catch (error) {
			if (!isEnoent(error)) throw error;
			markPreviewDirectoryVerified(root);
			return;
		}
		if (!hasStableFileIdentity(expectedRootStats)) {
			throw new PreviewMountError(500, "Preview mount root has no stable identity");
		}
		await removePreviewTree(root, { fs: mountAsyncFs, expectedRootStats });
		await assertPreviewDirectoryAbsent(root, mountAsyncFs);
		markPreviewDirectoryVerified(root);
	});
}

// ──────────────────────────────────────────────────────────────────────────
// Watcher (content serving is intentionally outside the async cleanup slice)
// ──────────────────────────────────────────────────────────────────────────

interface WatcherEntry {
	subscribers: Set<() => void>;
	close: () => void;
}
const _watchers = new Map<string, WatcherEntry>();

export interface WatchMountOptions {
	clock?: Clock;
	onFsEvent?: () => void;
}

export function watchMount(sessionId: string, onChange: () => void, options?: WatchMountOptions): () => void {
	validateSessionId(sessionId);
	const dir = mountDir(sessionId);
	let entry = _watchers.get(sessionId);
	if (!entry) {
		const subscribers = new Set<() => void>();
		const clock = options?.clock ?? realClock;
		let timer: TimerHandle | undefined;
		const fire = () => {
			timer = undefined;
			for (const fn of subscribers) {
				try { fn(); } catch (err) { console.error("[preview/mount] subscriber threw", err); }
			}
		};
		const debounced = () => {
			options?.onFsEvent?.();
			if (timer !== undefined) return;
			timer = clock.setTimeout(fire, 50);
		};
		const watcher = mountSyncFs.watch(dir, { recursive: true }, debounced);
		watcher.on("error", err => console.warn(`[preview/mount] watch error for ${sessionId}: ${err}`));
		entry = {
			subscribers,
			close: () => {
				try { watcher.close(); } catch { /* ignore */ }
				if (timer !== undefined) { clock.clearTimeout(timer); timer = undefined; }
			},
		};
		_watchers.set(sessionId, entry);
	}
	entry.subscribers.add(onChange);
	return () => {
		const current = _watchers.get(sessionId);
		if (!current) return;
		current.subscribers.delete(onChange);
		if (current.subscribers.size === 0) {
			current.close();
			_watchers.delete(sessionId);
		}
	};
}

// ──────────────────────────────────────────────────────────────────────────
// Shared bounded tree helpers
// ──────────────────────────────────────────────────────────────────────────

export interface PreviewTreeOptions {
	fs?: PreviewAsyncFs;
	concurrency?: number;
	/** Prior no-follow identity claim for a single traversal/removal root. */
	expectedRootStats?: AsyncTreeStats;
	/** Store root whose canonical directory must contain the traversed source. */
	trustedRoot?: string;
}

const UNREADABLE_TREE_STATS: AsyncTreeStats = {
	isDirectory: () => false,
	isFile: () => false,
	isSymbolicLink: () => false,
};

/**
 * Adapt the preview seam to the canonical streaming walker while retaining the
 * legacy list semantics: an unreadable directory contributes no descendants.
 */
function skippablePreviewTraversalFs(io: PreviewAsyncFs): {
	lstat(filePath: string): Promise<AsyncTreeStats>;
	opendir(dirPath: string): Promise<AsyncTreeDirectory>;
} {
	return {
		async lstat(filePath) {
			try { return await io.lstat(filePath); }
			catch { return UNREADABLE_TREE_STATS; }
		},
		async opendir(dirPath) {
			let directory: fs.Dir;
			try { directory = await io.opendir(dirPath); }
			catch {
				return { read: async () => null, close: async () => undefined };
			}
			return {
				async read() {
					try { return await directory.read(); }
					catch { return null; }
				},
				async close() {
					try { await directory.close(); } catch { /* read failure may close the handle */ }
				},
			};
		},
	};
}

function identityGuardedTraversalFs(
	io: PreviewAsyncFs,
	root: string,
	expectedRootStats: AsyncTreeStats,
	delegate: { lstat(filePath: string): Promise<AsyncTreeStats>; opendir(dirPath: string): Promise<AsyncTreeDirectory> },
): { lstat(filePath: string): Promise<AsyncTreeStats>; opendir(dirPath: string): Promise<AsyncTreeDirectory> } {
	const resolvedRoot = path.resolve(root);
	const assertRoot = async (): Promise<AsyncTreeStats> => {
		const current = await io.lstat(resolvedRoot);
		if (!matchesDirectoryIdentity(expectedRootStats, current)) {
			throw new PreviewMountError(500, "Preview traversal root changed");
		}
		return current;
	};
	return {
		async lstat(filePath) {
			const before = await assertRoot();
			const result = path.resolve(filePath) === resolvedRoot
				? before
				: await delegate.lstat(filePath);
			await assertRoot();
			return result;
		},
		async opendir(dirPath) {
			await assertRoot();
			const directory = await delegate.opendir(dirPath);
			try { await assertRoot(); }
			catch (error) {
				try { await directory.close(); } catch { /* preserve identity error */ }
				throw error;
			}
			return directory;
		},
	};
}

export interface BoundPreviewDirectoryRoot {
	path: string;
	canonicalPath: string;
	stats: AsyncTreeStats;
	/** Revalidate the candidate and trusted-store identities after an await. */
	assertCurrent(): Promise<void>;
	/** Source-reading filesystem that brackets path operations with root checks. */
	fs: PreviewAsyncFs;
}

interface BoundDirectoryIdentity {
	path: string;
	canonicalPath: string;
	stats: AsyncTreeStats;
}

async function bindOneDirectoryIdentity(
	root: string,
	io: PreviewAsyncFs,
	label: string,
): Promise<BoundDirectoryIdentity> {
	const resolvedRoot = path.resolve(root);
	const rootStats = await io.lstat(resolvedRoot);
	if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !hasStableFileIdentity(rootStats)) {
		throw new PreviewMountError(500, `${label} is not a stable directory`);
	}
	const canonicalPath = path.resolve(await io.realpath(resolvedRoot));
	// A realpath string is not authority. The returned target must identify the
	// same inode as the no-follow pathname that was originally authorized.
	const canonicalStats = await io.lstat(canonicalPath);
	if (!matchesDirectoryIdentity(rootStats, canonicalStats)) {
		throw new PreviewMountError(500, `${label} canonical target changed`);
	}
	const currentStats = await io.lstat(resolvedRoot);
	if (!matchesDirectoryIdentity(rootStats, currentStats)) {
		throw new PreviewMountError(500, `${label} changed while it was validated`);
	}
	return { path: resolvedRoot, canonicalPath, stats: rootStats };
}

function canonicalPathIsWithin(candidate: string, trustedRoot: string): boolean {
	const relative = path.relative(path.resolve(trustedRoot), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function guardPreviewSourceFs(
	io: PreviewAsyncFs,
	assertCurrent: () => Promise<void>,
): PreviewAsyncFs {
	return {
		...io,
		async lstat(filePath) {
			await assertCurrent();
			const result = await io.lstat(filePath);
			await assertCurrent();
			return result;
		},
		async realpath(filePath) {
			await assertCurrent();
			const result = await io.realpath(filePath);
			await assertCurrent();
			return result;
		},
		async opendir(filePath) {
			await assertCurrent();
			const directory = await io.opendir(filePath);
			try { await assertCurrent(); }
			catch (error) {
				try { await directory.close(); } catch { /* preserve identity error */ }
				throw error;
			}
			return directory;
		},
		async open(filePath, flags, mode) {
			await assertCurrent();
			const handle = await io.open(filePath, flags, mode);
			try { await assertCurrent(); }
			catch (error) {
				try { await handle.close(); } catch { /* preserve identity error */ }
				throw error;
			}
			return handle;
		},
	};
}

/**
 * Bind a preview/artifact candidate to stable canonical directory identities.
 * When supplied, the trusted store is canonicalized independently and the
 * candidate's canonical path must remain inside it.
 */
export async function bindPreviewDirectoryRoot(
	root: string,
	options: Pick<PreviewTreeOptions, "fs" | "trustedRoot"> = {},
): Promise<BoundPreviewDirectoryRoot> {
	const io = options.fs ?? mountAsyncFs;
	const candidate = await bindOneDirectoryIdentity(root, io, "Preview root");
	const trusted = options.trustedRoot === undefined
		? undefined
		: path.resolve(options.trustedRoot) === candidate.path
			? candidate
			: await bindOneDirectoryIdentity(options.trustedRoot, io, "Trusted preview store root");
	if (trusted && !canonicalPathIsWithin(candidate.canonicalPath, trusted.canonicalPath)) {
		throw new PreviewMountError(500, "Preview root escapes its trusted canonical store");
	}

	const identities = trusted && trusted.path !== candidate.path
		? [candidate, trusted]
		: [candidate];
	const assertCurrent = async (): Promise<void> => {
		for (const identity of identities) {
			const pathnameStats = await io.lstat(identity.path);
			if (!matchesDirectoryIdentity(identity.stats, pathnameStats)) {
				throw new PreviewMountError(500, "Preview root changed during traversal");
			}
			const canonicalStats = await io.lstat(identity.canonicalPath);
			if (!matchesDirectoryIdentity(identity.stats, canonicalStats)) {
				throw new PreviewMountError(500, "Preview canonical root changed during traversal");
			}
		}
	};
	await assertCurrent();
	return {
		path: candidate.path,
		canonicalPath: candidate.canonicalPath,
		stats: candidate.stats,
		assertCurrent,
		fs: guardPreviewSourceFs(io, assertCurrent),
	};
}

/** Sorted POSIX relative regular-file paths. Directory read failures are skipped. */
export async function listMountFiles(root: string, options: PreviewTreeOptions = {}): Promise<string[]> {
	const io = options.fs ?? mountAsyncFs;
	let expectedRootStats = options.expectedRootStats;
	let traversalIo = io;
	if (options.trustedRoot !== undefined) {
		const bound = await bindPreviewDirectoryRoot(root, options);
		if (expectedRootStats !== undefined && !matchesDirectoryIdentity(expectedRootStats, bound.stats)) {
			throw new PreviewMountError(500, "Preview traversal root changed from its expected identity");
		}
		expectedRootStats = bound.stats;
		traversalIo = bound.fs;
	} else if (expectedRootStats !== undefined && !hasStableFileIdentity(expectedRootStats)) {
		throw new PreviewMountError(500, "Preview traversal root has no stable identity");
	}

	const out: string[] = [];
	const skippableFs = skippablePreviewTraversalFs(traversalIo);
	const traversalFs = expectedRootStats === undefined
		? skippableFs
		: identityGuardedTraversalFs(traversalIo, root, expectedRootStats, skippableFs);
	await walkTree(root, (entry) => {
		if (entry.kind === "file" && entry.relativePath) out.push(entry.relativePath);
	}, {
		concurrency: options.concurrency ?? RECOVERY_IO_CONCURRENCY,
		fs: traversalFs,
	});
	return out.sort();
}

/** Stable SHA-256 of sorted path + NUL + streamed bytes + NUL records. */
export async function hashMountDirectory(root: string, options: PreviewTreeOptions = {}): Promise<string> {
	const bound = await bindPreviewDirectoryRoot(root, options);
	const files = await listMountFiles(bound.path, {
		fs: bound.fs,
		concurrency: options.concurrency,
		expectedRootStats: bound.stats,
	});
	const hash = crypto.createHash("sha256");
	for (const rel of files) {
		hash.update(rel, "utf-8");
		hash.update("\0");
		const absolute = path.join(bound.path, ...rel.split("/"));
		await bound.assertCurrent();
		const expectedStats = await bound.fs.lstat(absolute);
		await readRegularFileNoFollowInChunks(absolute, chunk => { hash.update(chunk); }, {
			fs: bound.fs,
			chunkSize: HASH_READ_BUFFER_BYTES,
			containedWithin: bound.canonicalPath,
			expectedStats,
		});
		await bound.assertCurrent();
		hash.update("\0");
	}
	await bound.assertCurrent();
	return hash.digest("hex");
}

function matchesDirectoryIdentity(expected: AsyncTreeStats, current: AsyncTreeStats): boolean {
	return expected.isDirectory()
		&& !expected.isSymbolicLink()
		&& current.isDirectory()
		&& !current.isSymbolicLink()
		&& sameFileIdentity(expected, current);
}

/** Copy regular files through the shared bounded streaming walker. */
export async function copyPreviewDirectory(src: string, dst: string, options: PreviewTreeOptions = {}): Promise<void> {
	const io = options.fs ?? mountAsyncFs;
	const limit = options.concurrency ?? RECOVERY_IO_CONCURRENCY;
	const destinationRoot = path.resolve(dst);
	const bound = await bindPreviewDirectoryRoot(src, options);
	const sourceRoot = bound.path;

	const traversalFs = identityGuardedTraversalFs(bound.fs, sourceRoot, bound.stats, {
		lstat: filePath => bound.fs.lstat(filePath),
		opendir: dirPath => bound.fs.opendir(dirPath),
	});

	await io.mkdir(path.dirname(destinationRoot), { recursive: true });
	await io.mkdir(destinationRoot, { recursive: true });
	const destinationBound = await bindPreviewDirectoryRoot(destinationRoot, { fs: io });
	const assertTransferRootsCurrent = async (): Promise<void> => {
		await bound.assertCurrent();
		await destinationBound.assertCurrent();
	};
	const transferFs = guardPreviewSourceFs(bound.fs, assertTransferRootsCurrent);
	await walkTree(sourceRoot, async (entry) => {
		const target = entry.relativePath
			? path.join(destinationRoot, ...entry.relativePath.split("/"))
			: destinationRoot;
		if (entry.kind === "directory") {
			if (entry.relativePath) {
				await assertTransferRootsCurrent();
				await transferFs.mkdir(target, { recursive: false });
				await assertTransferRootsCurrent();
			}
			return;
		}
		if (entry.kind !== "file") {
			if (!entry.relativePath) throw new Error("Preview copy source is not a directory");
			return;
		}
		// Validate both descriptor-anchored endpoints and both bound roots before
		// the first source byte can be read or written.
		await assertTransferRootsCurrent();
		const current = await copyRegularFileNoFollow(entry.absolutePath, target, {
			fs: transferFs,
			exclusive: true,
			chunkSize: HASH_READ_BUFFER_BYTES,
			containedWithin: bound.canonicalPath,
			expectedStats: entry.stats,
			destinationContainedWithin: destinationBound.canonicalPath,
			destinationRoot: destinationBound.path,
			expectedDestinationRootStats: destinationBound.stats,
		});
		await assertTransferRootsCurrent();
		if (current.atime && current.mtime) await transferFs.utimes(target, current.atime, current.mtime);
	}, {
		concurrency: limit,
		fs: traversalFs,
	});
	await assertTransferRootsCurrent();
}

/**
 * Delete independent roots with bounded lanes. Each lane uses the canonical
 * iterative streaming remover, so no per-node queue or recursive promise tree
 * is materialised. Results retain root order.
 */
export async function removePreviewTrees(
	roots: readonly string[],
	options: PreviewTreeOptions = {},
): Promise<Array<unknown | null>> {
	const io = options.fs ?? mountAsyncFs;
	const limit = options.concurrency ?? RECOVERY_IO_CONCURRENCY;
	return mapWithConcurrency(roots, limit, async root => {
		try {
			await removeTree(root, { fs: io, force: true });
			return null;
		} catch (error) {
			return isEnoent(error) ? null : error;
		}
	});
}

export async function removePreviewTree(root: string, options: PreviewTreeOptions = {}): Promise<void> {
	const io = options.fs ?? mountAsyncFs;
	try {
		await removeTree(root, {
			fs: io,
			force: true,
			expectedRootStats: options.expectedRootStats,
		});
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

/** Async directory enumeration seam used by content-route pickEntry. */
export async function readMountDirectory(dir: string): Promise<fs.Dirent[]> {
	return mountAsyncFs.readdir(dir, { withFileTypes: true });
}

export async function wipePreviewDirectory(
	dir: string,
	options: PreviewTreeOptions = {},
	suppressErrors = false,
): Promise<void> {
	const io = options.fs ?? mountAsyncFs;
	try {
		await removeTree(dir, { fs: io, force: true, preserveRoot: true });
	} catch (error) {
		if (!suppressErrors) throw error;
	}
}

const activePreviewInstalls = new Map<string, Set<symbol>>();
const blockedPreviewInstalls = new Set<string>();
const activePreviewReads = new Map<string, number>();
const previewReadWaiters = new Map<string, Set<() => void>>();
const previewWriterTails = new Map<string, Promise<void>>();
let ownedPreviewCleanupTail: Promise<void> = Promise.resolve();

function previewInstallKey(directory: string): string {
	const resolved = path.resolve(directory);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Synchronous content-route fence for a destination awaiting verification. */
export function isPreviewDirectoryAvailable(directory: string): boolean {
	const key = previewInstallKey(directory);
	return !blockedPreviewInstalls.has(key) && (activePreviewInstalls.get(key)?.size ?? 0) === 0;
}

/** Acquire a synchronous serving lease, or fail if an install is already fenced. */
export function acquirePreviewDirectoryRead(directory: string): (() => void) | null {
	const key = previewInstallKey(directory);
	if (!isPreviewDirectoryAvailable(directory)) return null;
	activePreviewReads.set(key, (activePreviewReads.get(key) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const remaining = (activePreviewReads.get(key) ?? 1) - 1;
		if (remaining > 0) {
			activePreviewReads.set(key, remaining);
			return;
		}
		activePreviewReads.delete(key);
		const waiters = previewReadWaiters.get(key);
		previewReadWaiters.delete(key);
		for (const resolve of waiters ?? []) resolve();
	};
}

async function waitForPreviewDirectoryReads(key: string): Promise<void> {
	if ((activePreviewReads.get(key) ?? 0) === 0) return;
	await new Promise<void>(resolve => {
		let waiters = previewReadWaiters.get(key);
		if (!waiters) {
			waiters = new Set();
			previewReadWaiters.set(key, waiters);
		}
		waiters.add(resolve);
	});
}

async function acquirePreviewWriter(key: string): Promise<() => void> {
	const prior = previewWriterTails.get(key) ?? Promise.resolve();
	let releaseCurrent!: () => void;
	const current = new Promise<void>(resolve => { releaseCurrent = resolve; });
	previewWriterTails.set(key, current);
	void current.finally(() => {
		if (previewWriterTails.get(key) === current) previewWriterTails.delete(key);
	});
	await prior;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		releaseCurrent();
	};
}

export interface PreviewDirectoryFence {
	/** The previous serialized writer failed without verifying this pathname. */
	wasBlocked: boolean;
}

/**
 * Serialize writers by normalized destination and fence readers for the whole
 * worker. Beginning a fence persistently blocks the path; finishing never makes
 * it available. Only markPreviewDirectoryVerified may do that after validation.
 */
export async function withPreviewDirectoryUnavailable<T>(
	directory: string,
	worker: (fence: PreviewDirectoryFence) => Promise<T>,
): Promise<T> {
	const key = previewInstallKey(directory);
	const releaseWriter = await acquirePreviewWriter(key);
	const install = beginPreviewInstall(directory);
	try {
		await waitForPreviewDirectoryReads(install.key);
		return await worker({ wasBlocked: install.wasBlocked });
	} finally {
		finishPreviewInstall(install);
		releaseWriter();
	}
}

export interface QuarantinedPreviewDirectory {
	path: string;
	stats: fs.Stats;
}

export interface QuarantinePreviewDirectoryOptions extends Pick<PreviewTreeOptions, "fs"> {
	/** Internal transaction hook invoked immediately after the live rename. */
	onRename?: () => void;
}

/** Remove an unknown live root from its serving pathname by rename only. */
export async function quarantinePreviewDirectory(
	directory: string,
	options: QuarantinePreviewDirectoryOptions = {},
): Promise<QuarantinedPreviewDirectory | null> {
	const io = options.fs ?? mountAsyncFs;
	const root = path.resolve(directory);
	const parent = path.dirname(root);
	let parentBound: BoundPreviewDirectoryRoot;
	try { parentBound = await bindPreviewDirectoryRoot(parent, { fs: io }); }
	catch (error) {
		// If the containing namespace itself is absent then the live pathname is
		// necessarily absent too. The caller still verifies absence under its fence.
		if (isEnoent(error)) return null;
		throw error;
	}
	const quarantine = path.join(
		parent,
		`.preview-quarantine-${process.pid}-${crypto.randomBytes(12).toString("hex")}`,
	);
	await parentBound.assertCurrent();
	try { await io.rename(root, quarantine); }
	catch (error) {
		if (!isEnoent(error)) throw error;
		await parentBound.assertCurrent();
		return null;
	}
	options.onRename?.();
	try {
		await parentBound.assertCurrent();
		const stats = await io.lstat(quarantine);
		await parentBound.assertCurrent();
		return { path: quarantine, stats };
	} catch (error) {
		// The rename already detached the live pathname. Never guess at identity or
		// recursively clean it after validation fails; retain a concrete path for
		// operators and rollback diagnostics.
		console.error(`[preview/mount] detached preview root preserved at ${quarantine}`, error);
		if (error instanceof Error) {
			Object.defineProperty(error, "preservedPreviewPath", { value: quarantine, configurable: true });
			throw error;
		}
		const failure = new PreviewMountError(500, "Detached preview root could not be identity-validated");
		Object.defineProperty(failure, "preservedPreviewPath", { value: quarantine, configurable: true });
		throw failure;
	}
}

/** Explicitly publish a fully validated directory, or a verified absence. */
export function markPreviewDirectoryVerified(directory: string): void {
	blockedPreviewInstalls.delete(previewInstallKey(directory));
}

function beginPreviewInstall(directory: string): { key: string; token: symbol; wasBlocked: boolean } {
	const key = previewInstallKey(directory);
	const token = Symbol("preview-install");
	const wasBlocked = blockedPreviewInstalls.has(key);
	blockedPreviewInstalls.add(key);
	let tokens = activePreviewInstalls.get(key);
	if (!tokens) {
		tokens = new Set();
		activePreviewInstalls.set(key, tokens);
	}
	tokens.add(token);
	return { key, token, wasBlocked };
}

function finishPreviewInstall(install: { key: string; token: symbol }): void {
	const tokens = activePreviewInstalls.get(install.key);
	tokens?.delete(install.token);
	if (tokens?.size === 0) activePreviewInstalls.delete(install.key);
}

function isStablePreviewDirectory(stats: AsyncTreeStats): boolean {
	return stats.isDirectory() && !stats.isSymbolicLink() && hasStableFileIdentity(stats);
}

function assertStablePreviewDirectory(stats: AsyncTreeStats, label: string): void {
	if (!isStablePreviewDirectory(stats)) {
		throw new PreviewMountError(500, `${label} is not a stable directory`);
	}
}

async function assertPreviewDirectoryAbsent(directory: string, io: PreviewAsyncFs): Promise<void> {
	try {
		await io.lstat(directory);
		throw new PreviewMountError(500, "Preview directory still exists after cleanup");
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

async function runOwnedPreviewCleanup(worker: () => Promise<void>): Promise<void> {
	const run = ownedPreviewCleanupTail.then(worker, worker);
	ownedPreviewCleanupTail = run.catch(() => undefined);
	await run;
}

/**
 * Recursively remove only a whole root detached and identified by this owner.
 * The global lane prevents independent quarantine/backup cleanups from
 * multiplying traversal concurrency. Failures are logged and the path remains.
 */
async function cleanupOwnedPreviewDirectory(
	detached: QuarantinedPreviewDirectory,
	io: PreviewAsyncFs,
	label: string,
): Promise<void> {
	await runOwnedPreviewCleanup(async () => {
		if (!isStablePreviewDirectory(detached.stats)) {
			// Node exposes no identity-bound unlinkat operation. The serving pathname
			// is already repaired; preserve and name this detached non-directory or
			// unstable identity rather than risk unlinking a raced replacement.
			console.error(`[preview/mount] preserving ${label} at ${detached.path}: detached root is not a stable directory`);
			return;
		}
		try {
			await withPreviewDirectoryUnavailable(detached.path, async () => {
				const current = await io.lstat(detached.path);
				if (!hasStableFileIdentity(current) || !sameFileIdentity(detached.stats, current)) {
					throw new PreviewMountError(500, "Detached preview identity changed before cleanup");
				}
				await removePreviewTree(detached.path, { fs: io, expectedRootStats: detached.stats });
				await assertPreviewDirectoryAbsent(detached.path, io);
				markPreviewDirectoryVerified(detached.path);
			});
		} catch (error) {
			console.error(`[preview/mount] failed to clean ${label} ${detached.path}`, error);
		}
	});
}

export interface MovePreviewDirectoryOptions extends PreviewTreeOptions {
	/** Stable no-follow identity captured by the caller before installation. */
	expectedRootStats: AsyncTreeStats;
	/** Internal transaction escape hatch: destination fence is already held. */
	alreadyFenced?: boolean;
	/** Internal transaction hook invoked immediately after the root rename. */
	onRename?: () => void;
}

async function movePreviewDirectoryContentsCore(
	srcDir: string,
	dstDir: string,
	options: MovePreviewDirectoryOptions,
): Promise<fs.Stats> {
	const io = options.fs ?? mountAsyncFs;
	const sourceRoot = path.resolve(srcDir);
	const destinationRoot = path.resolve(dstDir);
	const parent = path.dirname(sourceRoot);
	if (sourceRoot === destinationRoot || parent !== path.dirname(destinationRoot)) {
		throw new PreviewMountError(500, "Preview staging install requires distinct roots with the same parent");
	}
	assertStablePreviewDirectory(options.expectedRootStats, "Expected preview source root");

	// The parent is the trusted rename namespace. Bind its pathname and canonical
	// identities once, then revalidate them around every source/destination check
	// and the rename itself.
	const parentBound = await bindPreviewDirectoryRoot(parent, { fs: io });
	await parentBound.assertCurrent();
	const sourceStats = await io.lstat(sourceRoot); // ENOENT is a hard failure.
	if (!matchesDirectoryIdentity(options.expectedRootStats, sourceStats)) {
		throw new PreviewMountError(500, "Preview source root changed before install");
	}
	await parentBound.assertCurrent();
	try {
		await io.lstat(destinationRoot);
		throw new PreviewMountError(500, "Preview install destination already exists");
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	await parentBound.assertCurrent();
	const currentSourceStats = await io.lstat(sourceRoot); // Missing is never success.
	if (!matchesDirectoryIdentity(options.expectedRootStats, currentSourceStats)) {
		throw new PreviewMountError(500, "Preview source root changed before rename");
	}
	await parentBound.assertCurrent();
	await io.rename(sourceRoot, destinationRoot);
	options.onRename?.();
	await parentBound.assertCurrent();
	let installedStats: fs.Stats;
	try { installedStats = await io.lstat(destinationRoot); }
	catch (error) {
		if (isEnoent(error)) throw new PreviewMountError(500, "Preview install disappeared before verification");
		throw error;
	}
	if (!hasStableFileIdentity(installedStats)
		|| !matchesDirectoryIdentity(options.expectedRootStats, installedStats)) {
		// The installed pathname is now untrusted. Detach it with one whole-root
		// rename, but never recursively inspect or delete that unknown identity.
		try {
			const quarantined = await quarantinePreviewDirectory(destinationRoot, { fs: io });
			if (quarantined) {
				console.error(`[preview/mount] mismatched preview install preserved at ${quarantined.path}`);
			}
		} catch (error) {
			console.error("[preview/mount] failed to detach preview install with mismatched identity", error);
		}
		throw new PreviewMountError(500, "Preview install identity verification failed");
	}
	await parentBound.assertCurrent();
	return installedStats;
}

/**
 * Move one caller-identified source root into an absent same-parent destination.
 * Pre-rename failures never consume or quarantine the caller's source. The
 * destination remains blocked until a higher-level owner validates entry/hash
 * and calls markPreviewDirectoryVerified.
 */
export async function movePreviewDirectoryContents(
	srcDir: string,
	dstDir: string,
	options: MovePreviewDirectoryOptions,
): Promise<fs.Stats> {
	const destinationRoot = path.resolve(dstDir);
	if (options?.expectedRootStats === undefined) {
		throw new PreviewMountError(500, "Preview move requires expectedRootStats");
	}
	if (options.alreadyFenced) {
		if ((activePreviewInstalls.get(previewInstallKey(destinationRoot))?.size ?? 0) === 0) {
			throw new PreviewMountError(500, "Preview move declared alreadyFenced without an active destination fence");
		}
		return movePreviewDirectoryContentsCore(srcDir, destinationRoot, options);
	}
	return withPreviewDirectoryUnavailable(destinationRoot, async () =>
		movePreviewDirectoryContentsCore(srcDir, destinationRoot, options));
}

export interface InstallPreviewDirectoryOptions {
	fs?: PreviewAsyncFs;
	entry: string;
	/** Identity captured immediately after the staging root was created. */
	stagingExpectedRootStats: AsyncTreeStats;
	/** Immutable restore record hash; omitted for a newly staged mount. */
	expectedContentHash?: string;
}

export interface InstalledPreviewDirectory {
	entryStats: fs.Stats;
	contentHash: string;
}

async function regularPreviewEntryStats(root: string, entry: string, io: PreviewAsyncFs): Promise<fs.Stats> {
	const stats = await io.lstat(path.join(root, entry));
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new PreviewMountError(500, "Preview entry is missing after install");
	}
	return stats;
}

async function currentMatchingStats(
	root: string,
	expected: AsyncTreeStats,
	io: PreviewAsyncFs,
): Promise<fs.Stats | null> {
	try {
		const stats = await io.lstat(root);
		return matchesDirectoryIdentity(expected, stats) ? stats : null;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

/**
 * Transactionally replace a live preview root with a fully staged root. The old
 * root is moved intact to backup, every installed tree is checked inside the
 * destination fence, and any failed install rolls the exact backup identity
 * back into place. Failed rollback backups are preserved and logged.
 */
export async function installPreviewDirectoryTransaction(
	stagingDir: string,
	destinationDir: string,
	options: InstallPreviewDirectoryOptions,
): Promise<InstalledPreviewDirectory> {
	const io = options.fs ?? mountAsyncFs;
	const stagingRoot = path.resolve(stagingDir);
	const destinationRoot = path.resolve(destinationDir);
	const parent = path.dirname(destinationRoot);
	if (path.dirname(stagingRoot) !== parent || stagingRoot === destinationRoot) {
		throw new PreviewMountError(500, "Preview transaction requires same-parent staging and destination roots");
	}
	assertStablePreviewDirectory(options.stagingExpectedRootStats, "Preview staging root");

	// Bind and hash the exact staging identity before the old live root is even
	// inspected. An unsupported or raced identity therefore cannot mutate live.
	const stagedBound = await bindPreviewDirectoryRoot(stagingRoot, { fs: io, trustedRoot: parent });
	if (!matchesDirectoryIdentity(options.stagingExpectedRootStats, stagedBound.stats)) {
		throw new PreviewMountError(500, "Preview staging root changed before preflight");
	}
	await regularPreviewEntryStats(stagingRoot, options.entry, stagedBound.fs);
	const preInstallHash = await hashMountDirectory(stagingRoot, {
		fs: stagedBound.fs,
		trustedRoot: parent,
		expectedRootStats: options.stagingExpectedRootStats,
	});
	if (options.expectedContentHash !== undefined && preInstallHash !== options.expectedContentHash) {
		throw new PreviewMountError(500, "Preview staged content hash mismatch");
	}
	await stagedBound.assertCurrent();

	let backupDir = "";
	let backupStats: fs.Stats | undefined;
	let backupHash: string | undefined;
	let backupReady = false;
	let fenceWasBlocked = false;
	let liveRenameOccurred = false;
	let originalLiveStats: fs.Stats | undefined;
	let originalLiveWasAbsent = false;
	let installed: InstalledPreviewDirectory | undefined;
	const noteLiveRename = (): void => { liveRenameOccurred = true; };

	await withPreviewDirectoryUnavailable(destinationRoot, async fence => {
		fenceWasBlocked = fence.wasBlocked;
		try {
			try {
				originalLiveStats = await io.lstat(destinationRoot);
			} catch (error) {
				if (!isEnoent(error)) throw error;
				originalLiveWasAbsent = true;
			}

			// Close the final preflight-to-mutation gap while holding the same-key
			// writer fence. These checks must not strand a previously verified root.
			await stagedBound.assertCurrent();
			const currentStaging = await io.lstat(stagingRoot);
			if (!matchesDirectoryIdentity(options.stagingExpectedRootStats, currentStaging)) {
				throw new PreviewMountError(500, "Preview staging root changed before live mutation");
			}

			if (fence.wasBlocked) {
				// A blocked pathname is untrusted regardless of its current type. Rename
				// the entry itself first; only the detached post-rename identity can
				// authorize hashing or rollback.
				const detached = await quarantinePreviewDirectory(destinationRoot, {
					fs: io,
					onRename: noteLiveRename,
				});
				await assertPreviewDirectoryAbsent(destinationRoot, io);
				if (detached && isStablePreviewDirectory(detached.stats)) {
					backupDir = detached.path;
					backupStats = detached.stats;
					backupReady = true;
					backupHash = await hashMountDirectory(backupDir, {
						fs: io,
						trustedRoot: parent,
						expectedRootStats: backupStats,
					});
					markPreviewDirectoryVerified(backupDir);
				} else if (detached) {
					// Non-directories and identity-unstable roots are never traversed or
					// restored. Consume the quarantine as a detached cleanup owner.
					await cleanupOwnedPreviewDirectory(detached, io, "blocked preview replacement");
				}
			} else if (originalLiveStats !== undefined) {
				const oldStats = originalLiveStats;
				assertStablePreviewDirectory(oldStats, "Existing live preview root");
				const oldBound = await bindPreviewDirectoryRoot(destinationRoot, { fs: io, trustedRoot: parent });
				if (!matchesDirectoryIdentity(oldStats, oldBound.stats)) {
					throw new PreviewMountError(500, "Existing live preview root changed before backup");
				}
				backupHash = await hashMountDirectory(destinationRoot, {
					fs: oldBound.fs,
					trustedRoot: parent,
					expectedRootStats: oldStats,
				});
				await stagedBound.assertCurrent();
				await oldBound.assertCurrent();
				backupDir = path.join(parent, `.preview-backup-${process.pid}-${crypto.randomBytes(12).toString("hex")}`);
				try {
					backupStats = await movePreviewDirectoryContents(destinationRoot, backupDir, {
						fs: io,
						expectedRootStats: oldStats,
						onRename: noteLiveRename,
					});
					backupReady = true;
				} catch (error) {
					// A post-rename failure may still have moved the exact old inode. Claim
					// it only by identity so rollback can recover it.
					const moved = await currentMatchingStats(backupDir, oldStats, io);
					if (moved) {
						backupStats = moved;
						backupReady = true;
					}
					throw error;
				}
				const movedBackupHash = await hashMountDirectory(backupDir, {
					fs: io,
					trustedRoot: parent,
					expectedRootStats: backupStats,
				});
				if (movedBackupHash !== backupHash) {
					throw new PreviewMountError(500, "Preview backup content changed during detach");
				}
				markPreviewDirectoryVerified(backupDir);
			}

			await movePreviewDirectoryContents(stagingRoot, destinationRoot, {
				fs: io,
				expectedRootStats: options.stagingExpectedRootStats,
				alreadyFenced: true,
				onRename: noteLiveRename,
			});
			const entryStats = await regularPreviewEntryStats(destinationRoot, options.entry, io);
			const installedHash = await hashMountDirectory(destinationRoot, {
				fs: io,
				trustedRoot: parent,
				expectedRootStats: options.stagingExpectedRootStats,
			});
			if (installedHash !== preInstallHash
				|| (options.expectedContentHash !== undefined && installedHash !== options.expectedContentHash)) {
				throw new PreviewMountError(500, "Preview installed content hash mismatch");
			}
			markPreviewDirectoryVerified(destinationRoot);
			installed = { entryStats, contentHash: installedHash };
		} catch (operationError) {
			// The fence itself is not a mutation. If this path was available before
			// entry and its exact original root (or verified absence) still remains,
			// explicitly republish it after any preflight/hash/identity failure.
			if (!fenceWasBlocked && !liveRenameOccurred) {
				try {
					if (originalLiveStats !== undefined) {
						if (await currentMatchingStats(destinationRoot, originalLiveStats, io)) {
							markPreviewDirectoryVerified(destinationRoot);
						}
					} else if (originalLiveWasAbsent) {
						await assertPreviewDirectoryAbsent(destinationRoot, io);
						markPreviewDirectoryVerified(destinationRoot);
					}
				} catch { /* retain the operation error and leave an uncertain path blocked */ }
			}

			let failedLive: QuarantinedPreviewDirectory | null = null;
			if (liveRenameOccurred) {
				try { failedLive = await quarantinePreviewDirectory(destinationRoot, { fs: io }); }
				catch (error) {
					console.error("[preview/mount] failed to detach invalid live preview before rollback", error);
				}
			}

			if (backupReady && backupStats) {
				try {
					await movePreviewDirectoryContents(backupDir, destinationRoot, {
						fs: io,
						expectedRootStats: backupStats,
						alreadyFenced: true,
						onRename: noteLiveRename,
					});
					if (backupHash !== undefined) {
						const restoredHash = await hashMountDirectory(destinationRoot, {
							fs: io,
							trustedRoot: parent,
							expectedRootStats: backupStats,
						});
						if (restoredHash !== backupHash) {
							throw new PreviewMountError(500, "Rolled-back preview content hash mismatch");
						}
						markPreviewDirectoryVerified(destinationRoot);
					} else {
						// A blocked root whose detached hash failed can still be restored by
						// exact inode identity, but must remain unavailable until a later
						// writer verifies replacement or purge verifies absence.
						console.error("[preview/mount] restored exact unverified backup; live preview remains blocked");
					}
					backupReady = false;
				} catch (rollbackError) {
					let preservedPath = backupDir;
					try {
						if (!(await currentMatchingStats(backupDir, backupStats, io))) {
							const preserved = await quarantinePreviewDirectory(destinationRoot, { fs: io });
							if (preserved && matchesDirectoryIdentity(backupStats, preserved.stats)) {
								preservedPath = preserved.path;
							} else if (preserved) {
								console.error(`[preview/mount] mismatched rollback quarantine preserved at ${preserved.path}`);
							}
						}
					} catch { /* retain the original rollback error and backup path */ }
					console.error(
						`[preview/mount] failed to roll back live preview; preserving backup at ${preservedPath}`,
						rollbackError,
					);
				}
			}

			if (failedLive) {
				if (matchesDirectoryIdentity(options.stagingExpectedRootStats, failedLive.stats)) {
					await cleanupOwnedPreviewDirectory(failedLive, io, "failed preview install");
				} else {
					console.error(`[preview/mount] mismatched failed preview preserved at ${failedLive.path}`);
				}
			}
			throw operationError;
		}
	});

	if (!installed) throw new PreviewMountError(500, "Preview install did not complete");
	if (backupReady && backupStats) {
		await cleanupOwnedPreviewDirectory(
			{ path: backupDir, stats: backupStats },
			io,
			"successful preview backup",
		);
	}
	return installed;
}

async function copyOneFile(
	src: string,
	dst: string,
	canonicalSourceRoot: string,
	destinationBound: BoundPreviewDirectoryRoot,
): Promise<void> {
	try {
		await destinationBound.assertCurrent();
		await copyRegularFileNoFollow(src, dst, {
			fs: destinationBound.fs,
			exclusive: true,
			chunkSize: HASH_READ_BUFFER_BYTES,
			containedWithin: canonicalSourceRoot,
			destinationContainedWithin: destinationBound.canonicalPath,
			destinationRoot: destinationBound.path,
			expectedDestinationRootStats: destinationBound.stats,
		});
		await destinationBound.assertCurrent();
	} catch (error) {
		throw new PreviewMountError(500, `Copy failed: ${(error as Error).message}`);
	}
}

async function expandGlob(srcRoot: string, spec: string): Promise<string[]> {
	const segments = spec.split("/");
	let candidates = [""];
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const next: string[] = [];
		const wildcard = isGlob(seg);
		const re = wildcard ? compileGlobSegment(seg) : null;
		const final = i === segments.length - 1;
		for (const cand of candidates) {
			const candAbs = cand ? path.join(srcRoot, cand) : srcRoot;
			if (wildcard) {
				let candidateStats: fs.Stats;
				let entries: fs.Dirent[];
				try {
					candidateStats = await mountAsyncFs.lstat(candAbs);
					if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) continue;
					entries = await mountAsyncFs.readdir(candAbs, { withFileTypes: true });
				} catch { continue; }
				for (const ent of entries) {
					if (!re!.test(ent.name)) continue;
					const childAbs = path.join(candAbs, ent.name);
					let childStats: fs.Stats;
					try { childStats = await mountAsyncFs.lstat(childAbs); }
					catch { continue; }
					const rel = cand ? `${cand}/${ent.name}` : ent.name;
					if (final
						? (childStats.isFile() || childStats.isSymbolicLink())
						: (childStats.isDirectory() && !childStats.isSymbolicLink())) next.push(rel);
				}
			} else {
				const childAbs = path.join(candAbs, seg);
				let st: fs.Stats;
				try { st = await mountAsyncFs.lstat(childAbs); } catch { continue; }
				const rel = cand ? `${cand}/${seg}` : seg;
				if (final ? st.isFile() : (st.isDirectory() && !st.isSymbolicLink())) next.push(rel);
			}
		}
		candidates = next;
		if (candidates.length === 0) break;
	}
	return candidates;
}

function isContained(child: string, parent: string): boolean {
	if (child === parent) return true;
	const parentWithSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
	return child.startsWith(parentWithSep);
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
