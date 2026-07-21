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
	openRegularFileNoFollow,
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
 * Async mutation and background-cleanup paths use mountPath + ensureMountDir.
 */
export function mountDir(sessionId: string): string {
	const dir = mountPath(sessionId);
	mountSyncFs.mkdirSync(dir, { recursive: true });
	return dir;
}

async function ensureMountDir(sessionId: string, io = mountAsyncFs): Promise<string> {
	const dir = mountPath(sessionId);
	await io.mkdir(dir, { recursive: true });
	return dir;
}

export async function writeInline(sessionId: string, html: string, entry?: string): Promise<MountResult> {
	validateSessionId(sessionId);
	const safeEntry = validateEntry(entry ?? DEFAULT_INLINE_ENTRY);
	if (typeof html !== "string") throw new PreviewMountError(400, "html must be a string");

	const dir = await ensureMountDir(sessionId);
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
	return {
		url: `/preview/${sessionId}/${safeEntry}`,
		path: target,
		relPath: path.posix.join(sessionId, safeEntry),
		entry: safeEntry,
		mtime: Math.floor(stat.mtimeMs),
		contentHash: await hashMountDirectory(dir),
	};
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
	const destRoot = await ensureMountDir(sessionId);
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
	const resolvedAssets = new Set<string>();

	try {
		await copyOneFile(entryReal, path.join(tmpRoot, entry), srcRoot);
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
					await mountAsyncFs.mkdir(path.dirname(dst), { recursive: true });
					await copyOneFile(real, dst, srcRoot);
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
				await mountAsyncFs.mkdir(path.dirname(dst), { recursive: true });
				await copyOneFile(real, dst, srcRoot);
				resolvedAssets.add(rel);
			}
		}

		await wipePreviewDirectory(destRoot, { fs: mountAsyncFs }, true);
		await movePreviewDirectoryContents(tmpRoot, destRoot, { fs: mountAsyncFs });
	} catch (err) {
		try { await removePreviewTree(tmpRoot, { fs: mountAsyncFs }); } catch { /* ignore cleanup */ }
		throw err;
	}
	try { await removePreviewTree(tmpRoot, { fs: mountAsyncFs }); } catch { /* ignore cleanup */ }

	const target = path.join(destRoot, entry);
	let stat: fs.Stats;
	try { stat = await mountAsyncFs.lstat(target); }
	catch { throw new PreviewMountError(500, "Entry file missing after swap"); }
	if (!stat.isFile() || stat.isSymbolicLink()) throw new PreviewMountError(500, "Entry file missing after swap");

	return {
		url: `/preview/${sessionId}/${entry}`,
		path: target,
		relPath: path.posix.join(sessionId, entry),
		entry,
		mtime: Math.floor(stat.mtimeMs),
		contentHash: await hashMountDirectory(destRoot),
		assets: Array.from(resolvedAssets).sort(),
	};
}

export async function contentHashForMount(sessionId: string): Promise<string> {
	validateSessionId(sessionId);
	return hashMountDirectory(mountPath(sessionId));
}

export async function removeMount(sessionId: string): Promise<void> {
	if (!sessionId || !VALID_SESSION_ID.test(sessionId)) return;
	try { await removePreviewTree(path.join(previewRoot(), sessionId), { fs: mountAsyncFs }); }
	catch { /* preserve cleanup-local idempotency */ }
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

/** Sorted POSIX relative regular-file paths. Directory read failures are skipped. */
export async function listMountFiles(root: string, options: PreviewTreeOptions = {}): Promise<string[]> {
	const io = options.fs ?? mountAsyncFs;
	const out: string[] = [];
	await walkTree(root, (entry) => {
		if (entry.kind === "file" && entry.relativePath) out.push(entry.relativePath);
	}, {
		concurrency: options.concurrency ?? RECOVERY_IO_CONCURRENCY,
		fs: skippablePreviewTraversalFs(io),
	});
	return out.sort();
}

/** Stable SHA-256 of sorted path + NUL + streamed bytes + NUL records. */
export async function hashMountDirectory(root: string, options: PreviewTreeOptions = {}): Promise<string> {
	const io = options.fs ?? mountAsyncFs;
	const canonicalRoot = await io.realpath(root);
	const files = await listMountFiles(root, options);
	const hash = crypto.createHash("sha256");
	for (const rel of files) {
		hash.update(rel, "utf-8");
		hash.update("\0");
		const absolute = path.join(root, ...rel.split("/"));
		await readRegularFileNoFollowInChunks(absolute, chunk => { hash.update(chunk); }, {
			fs: io,
			chunkSize: HASH_READ_BUFFER_BYTES,
			containedWithin: canonicalRoot,
		});
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** Copy regular files through the shared bounded streaming walker. */
export async function copyPreviewDirectory(src: string, dst: string, options: PreviewTreeOptions = {}): Promise<void> {
	const io = options.fs ?? mountAsyncFs;
	const limit = options.concurrency ?? RECOVERY_IO_CONCURRENCY;
	const canonicalSourceRoot = await io.realpath(src);
	await io.mkdir(path.dirname(dst), { recursive: true });
	await walkTree(src, async (entry) => {
		const target = entry.relativePath
			? path.join(dst, ...entry.relativePath.split("/"))
			: dst;
		if (entry.kind === "directory") {
			await io.mkdir(target, { recursive: false });
			return;
		}
		if (entry.kind !== "file") {
			if (!entry.relativePath) throw new Error("Preview copy source is not a directory");
			return;
		}
		// Open and validate the source descriptor after traversal. The pathname is
		// never read again, so a final-component symlink substitution cannot leak.
		const current = await copyRegularFileNoFollow(entry.absolutePath, target, {
			fs: io,
			exclusive: true,
			chunkSize: HASH_READ_BUFFER_BYTES,
			containedWithin: canonicalSourceRoot,
		});
		if (current.atime && current.mtime) await io.utimes(target, current.atime, current.mtime);
	}, {
		concurrency: limit,
		fs: {
			lstat: filePath => io.lstat(filePath),
			opendir: dirPath => io.opendir(dirPath),
		},
	});
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
	const [error] = await removePreviewTrees([root], options);
	if (error !== null) throw error;
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

export async function movePreviewDirectoryContents(
	srcDir: string,
	dstDir: string,
	options: PreviewTreeOptions = {},
): Promise<void> {
	const io = options.fs ?? mountAsyncFs;
	let directory: fs.Dir;
	let canonicalSourceRoot: string;
	try {
		const sourceStats = await io.lstat(srcDir);
		if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) return;
		canonicalSourceRoot = await io.realpath(srcDir);
		directory = await io.opendir(srcDir);
	} catch { return; }
	await io.mkdir(dstDir, { recursive: true });
	try {
		for (;;) {
			const ent = await directory.read();
			if (!ent) break;
			const from = path.join(srcDir, ent.name);
			const to = path.join(dstDir, ent.name);
			const current = await io.lstat(from);
			if ((!current.isDirectory() && !current.isFile()) || current.isSymbolicLink()) {
				throw new PreviewMountError(500, "Preview staging contains an unsupported filesystem entry");
			}
			try {
				await io.rename(from, to);
				const moved = await io.lstat(to);
				if (moved.isSymbolicLink() || moved.isDirectory() !== current.isDirectory() || moved.isFile() !== current.isFile()) {
					await removePreviewTree(to, { fs: io, concurrency: options.concurrency });
					throw new PreviewMountError(500, "Preview staging changed while it was moved");
				}
			} catch (renameError) {
				if (renameError instanceof PreviewMountError) throw renameError;
				await removePreviewTree(to, { fs: io, concurrency: options.concurrency });
				const fallbackStats = await io.lstat(from);
				if (fallbackStats.isSymbolicLink()) {
					throw new PreviewMountError(500, "Preview staging contains an unsupported filesystem entry");
				}
				if (fallbackStats.isDirectory()) {
					await copyPreviewDirectory(from, to, { fs: io, concurrency: options.concurrency });
				} else if (fallbackStats.isFile()) {
					await copyOneFile(from, to, canonicalSourceRoot, io);
				} else {
					throw new PreviewMountError(500, "Preview staging contains an unsupported filesystem entry");
				}
				await removePreviewTree(from, { fs: io, concurrency: options.concurrency });
			}
		}
	} finally {
		try { await directory.close(); } catch { /* read failure may already close the handle */ }
	}
}

async function copyOneFile(
	src: string,
	dst: string,
	canonicalSourceRoot: string,
	io = mountAsyncFs,
): Promise<void> {
	let opened: Awaited<ReturnType<typeof openRegularFileNoFollow>>;
	try { opened = await openRegularFileNoFollow(src, io, canonicalSourceRoot); }
	catch (error) { throw new PreviewMountError(500, `Copy failed: ${(error as Error).message}`); }

	try { await io.unlink(dst); }
	catch (error) {
		if (!isEnoent(error)) {
			try { await opened.handle.close(); } catch { /* preserve the unlink error */ }
			throw error;
		}
	}

	// Retain the same-filesystem hardlink fast path only when its result can be
	// proven to refer to the descriptor validated above. Otherwise stream-copy.
	let linkError: unknown;
	if (hasStableFileIdentity(opened.stats)) {
		try { await io.link(src, dst); }
		catch (error) { linkError = error; }
	} else {
		linkError = new Error("source filesystem has no stable file identity");
	}

	if (linkError === undefined) {
		let validationError: unknown;
		try {
			const copiedStats = await io.lstat(dst);
			if (!copiedStats.isFile() || copiedStats.isSymbolicLink() || !sameFileIdentity(opened.stats, copiedStats)) {
				throw new PreviewMountError(500, "Copy destination does not match the opened source file");
			}
		} catch (error) {
			validationError = error;
		}
		try { await opened.handle.close(); }
		catch (closeError) { validationError ??= closeError; }
		if (validationError === undefined) return;
		try { await io.unlink(dst); } catch { /* preserve the validation error */ }
		throw validationError;
	}

	try { await opened.handle.close(); }
	catch (error) { throw new PreviewMountError(500, `Copy failed: ${(error as Error).message}`); }
	try {
		await copyRegularFileNoFollow(src, dst, {
			fs: io,
			exclusive: true,
			chunkSize: HASH_READ_BUFFER_BYTES,
			containedWithin: canonicalSourceRoot,
		});
	} catch (error) {
		throw new PreviewMountError(500, `Copy failed: ${(error as Error).message}`);
	}

	try {
		const copiedStats = await io.lstat(dst);
		if (!copiedStats.isFile() || copiedStats.isSymbolicLink()) {
			throw new PreviewMountError(500, "Copy destination is not a regular file");
		}
	} catch (error) {
		try { await io.unlink(dst); } catch { /* preserve the validation error */ }
		throw error;
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
