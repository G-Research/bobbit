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
import { mapWithConcurrency, RECOVERY_IO_CONCURRENCY } from "../agent/bounded-async-work.js";
import { realClock, type Clock, type TimerHandle } from "../gateway-deps.js";

const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH_READ_BUFFER_BYTES = 64 * 1024;
const REMOVE_DIRECTORY_BATCH = 128;

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
	open(filePath: fs.PathLike, flags: "r"): Promise<fs.promises.FileHandle>;
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
		open: (filePath, flags) => candidate.open(filePath, flags) as Promise<fs.promises.FileHandle>,
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

	const stat = await mountAsyncFs.stat(target);
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
		await copyOneFile(entryReal, path.join(tmpRoot, entry));
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
					await copyOneFile(real, dst);
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
				await copyOneFile(real, dst);
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
	try { stat = await mountAsyncFs.stat(target); }
	catch { throw new PreviewMountError(500, "Entry file missing after swap"); }
	if (!stat.isFile()) throw new PreviewMountError(500, "Entry file missing after swap");

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

interface DynamicQueueOptions<T> {
	initial: T[];
	limit: number;
	worker: (item: T, enqueue: (item: T) => void) => Promise<void>;
}

async function runDynamicQueue<T>({ initial, limit, worker }: DynamicQueueOptions<T>): Promise<void> {
	if (!Number.isInteger(limit) || limit <= 0) throw new RangeError("concurrency limit must be a positive integer");
	if (initial.length === 0) return;
	await new Promise<void>((resolve, reject) => {
		const queue = [...initial];
		let active = 0;
		let firstError: unknown;
		let settled = false;
		const enqueue = (item: T) => {
			queue.push(item);
			pump();
		};
		const pump = () => {
			if (settled) return;
			while (active < limit && queue.length > 0) {
				const item = queue.shift()!;
				active++;
				void worker(item, enqueue)
					.catch(err => { firstError ??= err; })
					.finally(() => {
						active--;
						if (active === 0 && queue.length === 0) {
							settled = true;
							if (firstError !== undefined) reject(firstError);
							else resolve();
							return;
						}
						pump();
					});
			}
		};
		pump();
	});
}

export interface PreviewTreeOptions {
	fs?: PreviewAsyncFs;
	concurrency?: number;
}

interface DirectoryJob {
	absolute: string;
	prefix: string;
}

/** Sorted POSIX relative regular-file paths. Directory read failures are skipped. */
export async function listMountFiles(root: string, options: PreviewTreeOptions = {}): Promise<string[]> {
	const io = options.fs ?? mountAsyncFs;
	const limit = options.concurrency ?? RECOVERY_IO_CONCURRENCY;
	const out: string[] = [];
	await runDynamicQueue<DirectoryJob>({
		initial: [{ absolute: root, prefix: "" }],
		limit,
		worker: async (job, enqueue) => {
			let dir: fs.Dir;
			try { dir = await io.opendir(job.absolute); }
			catch { return; }
			const childDirectories: DirectoryJob[] = [];
			const childFiles: string[] = [];
			try {
				for (;;) {
					const ent = await dir.read();
					if (!ent) break;
					const rel = job.prefix ? `${job.prefix}/${ent.name}` : ent.name;
					if (ent.isDirectory()) childDirectories.push({ absolute: path.join(job.absolute, ent.name), prefix: rel });
					else if (ent.isFile()) childFiles.push(rel);
				}
			} catch {
				// Match the legacy scanner: an unreadable directory contributes no descendants.
				return;
			} finally {
				try { await dir.close(); } catch { /* a failed read may already close it */ }
			}
			for (const child of childDirectories) enqueue(child);
			out.push(...childFiles);
		},
	});
	return out.sort();
}

/** Stable SHA-256 of sorted path + NUL + streamed bytes + NUL records. */
export async function hashMountDirectory(root: string, options: PreviewTreeOptions = {}): Promise<string> {
	const io = options.fs ?? mountAsyncFs;
	const files = await listMountFiles(root, options);
	const hash = crypto.createHash("sha256");
	const buffer = Buffer.allocUnsafe(HASH_READ_BUFFER_BYTES);
	for (const rel of files) {
		hash.update(rel, "utf-8");
		hash.update("\0");
		const absolute = path.join(root, ...rel.split("/"));
		const current = await io.lstat(absolute);
		if (!current.isFile()) throw new Error(`Preview hash source is no longer a regular file: ${rel}`);
		const handle = await io.open(absolute, "r");
		try {
			let position = 0;
			for (;;) {
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
				if (bytesRead === 0) break;
				hash.update(buffer.subarray(0, bytesRead));
				position += bytesRead;
			}
		} finally {
			await handle.close();
		}
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** Copy regular files without traversing symlinks. */
export async function copyPreviewDirectory(src: string, dst: string, options: PreviewTreeOptions = {}): Promise<void> {
	const io = options.fs ?? mountAsyncFs;
	const limit = options.concurrency ?? RECOVERY_IO_CONCURRENCY;
	const files = await listMountFiles(src, { fs: io, concurrency: limit });
	await io.mkdir(path.dirname(dst), { recursive: true });
	await io.mkdir(dst, { recursive: false });
	await mapWithConcurrency(files, limit, async rel => {
		const from = path.join(src, ...rel.split("/"));
		const to = path.join(dst, ...rel.split("/"));
		await io.mkdir(path.dirname(to), { recursive: true });
		const stat = await io.lstat(from);
		if (!stat.isFile()) throw new Error(`Preview copy source is no longer a regular file: ${rel}`);
		await io.copyFile(from, to, fs.constants.COPYFILE_EXCL);
		await io.utimes(to, stat.atime, stat.mtime);
	});
}

interface RemovalNode {
	absolute: string;
	parent?: RemovalNode;
	rootIndex: number;
	pending: number;
	afterChildren: "scan" | "rmdir";
	retries?: number;
}

type RemovalJob =
	| { kind: "inspect"; absolute: string; rootIndex: number }
	| { kind: "scan"; node: RemovalNode }
	| { kind: "unlink"; absolute: string; parent?: RemovalNode; rootIndex: number }
	| { kind: "rmdir"; node: RemovalNode };

/**
 * Delete several independent trees through one operation-level queue. Each
 * result is null on success/missing, otherwise the first error for that root.
 */
export async function removePreviewTrees(
	roots: readonly string[],
	options: PreviewTreeOptions = {},
): Promise<Array<unknown | null>> {
	const io = options.fs ?? mountAsyncFs;
	const limit = options.concurrency ?? RECOVERY_IO_CONCURRENCY;
	const errors: Array<unknown | null> = roots.map(() => null);
	let enqueueJob: (job: RemovalJob) => void = () => undefined;
	const recordError = (rootIndex: number, error: unknown) => {
		if (!isEnoent(error) && errors[rootIndex] === null) errors[rootIndex] = error;
	};
	const completeNode = (node: RemovalNode) => {
		node.pending--;
		if (node.pending === 0) enqueueJob({ kind: node.afterChildren, node });
	};

	await runDynamicQueue<RemovalJob>({
		initial: roots.map((absolute, rootIndex) => ({ kind: "inspect" as const, absolute, rootIndex })),
		limit,
		worker: async (job, enqueue) => {
			enqueueJob = enqueue;
			if (job.kind === "inspect") {
				try {
					const stat = await io.lstat(job.absolute);
					if (stat.isDirectory()) {
						enqueue({
							kind: "scan",
							node: { absolute: job.absolute, rootIndex: job.rootIndex, pending: 1, afterChildren: "rmdir" },
						});
					} else {
						enqueue({ kind: "unlink", absolute: job.absolute, rootIndex: job.rootIndex });
					}
				} catch (err) { recordError(job.rootIndex, err); }
				return;
			}
			if (job.kind === "unlink") {
				try { await io.unlink(job.absolute); }
				catch (err) { recordError(job.rootIndex, err); }
				if (job.parent) completeNode(job.parent);
				return;
			}
			if (job.kind === "rmdir") {
				try {
					await io.rmdir(job.node.absolute);
				} catch (err) {
					const code = (err as NodeJS.ErrnoException | undefined)?.code;
					if ((code === "ENOTEMPTY" || code === "EEXIST") && (job.node.retries ?? 0) < 2) {
						// A sibling operation (or an external writer) may have populated the
						// directory after its scan. Re-scan rather than recursively deleting.
						job.node.pending = 1;
						job.node.retries = (job.node.retries ?? 0) + 1;
						enqueue({ kind: "scan", node: job.node });
						return;
					}
					recordError(job.node.rootIndex, err);
				}
				if (job.node.parent) completeNode(job.node.parent);
				return;
			}

			const node = job.node;
			let dir: fs.Dir | undefined;
			const entries: fs.Dirent[] = [];
			let exhausted = false;
			try {
				dir = await io.opendir(node.absolute);
				while (entries.length < REMOVE_DIRECTORY_BATCH) {
					const ent = await dir.read();
					if (!ent) { exhausted = true; break; }
					entries.push(ent);
				}
			} catch (err) {
				recordError(node.rootIndex, err);
				exhausted = true;
			} finally {
				if (dir) {
					try { await dir.close(); } catch { /* ignore close after read failure */ }
				}
			}
			node.afterChildren = exhausted ? "rmdir" : "scan";
			for (const ent of entries) {
				const absolute = path.join(node.absolute, ent.name);
				node.pending++;
				if (ent.isDirectory()) {
					enqueue({
						kind: "scan",
						node: {
							absolute,
							parent: node,
							rootIndex: node.rootIndex,
							pending: 1,
							afterChildren: "rmdir",
						},
					});
				} else {
					enqueue({ kind: "unlink", absolute, parent: node, rootIndex: node.rootIndex });
				}
			}
			completeNode(node);
		},
	});
	return errors;
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
	let entries: fs.Dirent[];
	try { entries = await io.readdir(dir, { withFileTypes: true }); }
	catch { return; }
	const errors = await removePreviewTrees(entries.map(ent => path.join(dir, ent.name)), {
		fs: io,
		concurrency: options.concurrency,
	});
	const error = errors.find(item => item !== null);
	if (!suppressErrors && error !== undefined) throw error;
}

export async function movePreviewDirectoryContents(
	srcDir: string,
	dstDir: string,
	options: PreviewTreeOptions = {},
): Promise<void> {
	const io = options.fs ?? mountAsyncFs;
	let entries: fs.Dirent[];
	try { entries = await io.readdir(srcDir, { withFileTypes: true }); }
	catch { return; }
	await io.mkdir(dstDir, { recursive: true });
	for (const ent of entries) {
		const from = path.join(srcDir, ent.name);
		const to = path.join(dstDir, ent.name);
		try {
			await io.rename(from, to);
		} catch {
			await removePreviewTree(to, { fs: io, concurrency: options.concurrency });
			if (ent.isDirectory()) await copyPreviewDirectory(from, to, { fs: io, concurrency: options.concurrency });
			else if (ent.isFile()) await copyOneFile(from, to, io);
			else throw new PreviewMountError(500, "Preview staging contains an unsupported filesystem entry");
			await removePreviewTree(from, { fs: io, concurrency: options.concurrency });
		}
	}
}

async function copyOneFile(src: string, dst: string, io = mountAsyncFs): Promise<void> {
	try { await io.unlink(dst); }
	catch (err) { if (!isEnoent(err)) throw err; }
	try {
		await io.link(src, dst);
	} catch {
		try { await io.copyFile(src, dst); }
		catch (err) { throw new PreviewMountError(500, `Copy failed: ${(err as Error).message}`); }
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
				let entries: fs.Dirent[];
				try { entries = await mountAsyncFs.readdir(candAbs, { withFileTypes: true }); }
				catch { continue; }
				for (const ent of entries) {
					if (!re!.test(ent.name)) continue;
					const rel = cand ? `${cand}/${ent.name}` : ent.name;
					if (final ? (ent.isFile() || ent.isSymbolicLink()) : ent.isDirectory()) next.push(rel);
				}
			} else {
				const childAbs = path.join(candAbs, seg);
				let st: fs.Stats;
				try { st = await mountAsyncFs.lstat(childAbs); } catch { continue; }
				const rel = cand ? `${cand}/${seg}` : seg;
				if (final ? st.isFile() : st.isDirectory()) next.push(rel);
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
