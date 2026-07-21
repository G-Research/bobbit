import fs from "node:fs";
import path from "node:path";

/** Small shared ceiling for gateway background filesystem work. */
export const BACKGROUND_IO_CONCURRENCY = 8;

/** Backwards-compatible name used by the boot recovery paths. */
export const RECOVERY_IO_CONCURRENCY = BACKGROUND_IO_CONCURRENCY;

const COOPERATIVE_YIELD_INTERVAL = 256;

function validateConcurrency(limit: number): void {
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new RangeError("concurrency limit must be a positive integer");
	}
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Map items with a fixed number of index-cursor workers. Results retain input
 * order even when individual operations complete out of order.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	validateConcurrency(limit);

	const results = new Array<R>(items.length);
	let cursor = 0;
	let completedSinceYield = 0;
	const workerCount = Math.min(limit, items.length);
	const workers = Array.from({ length: workerCount }, async () => {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await worker(items[index]!, index);
			completedSinceYield++;
			if (completedSinceYield >= COOPERATIVE_YIELD_INTERVAL) {
				completedSinceYield = 0;
				await yieldToEventLoop();
			}
		}
	});
	// The promise array contains at most `limit` long-lived workers, never one
	// promise per input item.
	await Promise.all(workers);
	return results;
}

export interface DynamicQueueController<T> {
	/**
	 * Offer more work to this operation. The queue has a small fixed capacity;
	 * false means the caller must retain/process the item itself rather than
	 * dropping it. This backpressure is what prevents a wide tree from being
	 * materialised in memory merely to schedule it.
	 */
	tryEnqueue(item: T): boolean;
}

export interface DynamicQueueOptions {
	/** Pending-item ceiling. Defaults to the worker concurrency. */
	maxQueued?: number;
}

/**
 * Process work that can discover more work without creating one promise per
 * item. Active workers and the pending queue are independently bounded.
 *
 * A worker that receives `false` from `tryEnqueue` must process the item in its
 * own iterative stack. In particular, it must not recursively call another
 * bounded helper: one operation owns one queue and therefore one ceiling.
 */
export async function processDynamicQueue<T>(
	initialItems: readonly T[],
	limit: number,
	worker: (item: T, queue: DynamicQueueController<T>) => Promise<void>,
	options: DynamicQueueOptions = {},
): Promise<void> {
	validateConcurrency(limit);
	const maxQueued = options.maxQueued ?? limit;
	if (!Number.isInteger(maxQueued) || maxQueued <= 0) {
		throw new RangeError("pending queue limit must be a positive integer");
	}
	if (initialItems.length === 0) return;

	await new Promise<void>((resolve, reject) => {
		let initialCursor = 0;
		let pending: T[] = [];
		let pendingCursor = 0;
		let active = 0;
		let stopped = false;
		let firstError: unknown;
		let completionsSinceYield = 0;
		let yieldScheduled = false;

		const pendingLength = (): number => pending.length - pendingCursor;
		const hasWork = (): boolean => pendingLength() > 0 || initialCursor < initialItems.length;
		const takeWork = (): T => {
			if (pendingCursor < pending.length) {
				const item = pending[pendingCursor++]!;
				if (pendingCursor >= COOPERATIVE_YIELD_INTERVAL && pendingCursor * 2 >= pending.length) {
					pending = pending.slice(pendingCursor);
					pendingCursor = 0;
				}
				return item;
			}
			return initialItems[initialCursor++]!;
		};

		let schedule: () => void;
		const controller: DynamicQueueController<T> = {
			tryEnqueue(item): boolean {
				if (stopped || pendingLength() >= maxQueued) return false;
				pending.push(item);
				schedule();
				return true;
			},
		};

		const settleIfDone = (): void => {
			if (active !== 0) return;
			if (stopped) {
				reject(firstError);
				return;
			}
			if (!hasWork()) resolve();
		};

		const afterWork = (failed: boolean, error?: unknown): void => {
			active--;
			if (failed && !stopped) {
				stopped = true;
				firstError = error;
				pending = [];
				pendingCursor = 0;
				initialCursor = initialItems.length;
			}
			completionsSinceYield++;
			if (!stopped && completionsSinceYield >= COOPERATIVE_YIELD_INTERVAL && hasWork()) {
				completionsSinceYield = 0;
				if (!yieldScheduled) {
					yieldScheduled = true;
					setImmediate(() => {
						yieldScheduled = false;
						schedule();
					});
				}
			} else {
				schedule();
			}
			settleIfDone();
		};

		schedule = (): void => {
			if (stopped || yieldScheduled) {
				settleIfDone();
				return;
			}
			while (active < limit && hasWork()) {
				const item = takeWork();
				active++;
				void Promise.resolve()
					.then(() => worker(item, controller))
					.then(() => afterWork(false), (error: unknown) => afterWork(true, error));
			}
			settleIfDone();
		};

		schedule();
	});
}

export interface RecoveryStats {
	size: number;
	mtime: Date;
	isDirectory(): boolean;
	isFile(): boolean;
}

export interface RecoveryFileHandle {
	read(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesRead: number }>;
	close(): Promise<void>;
}

/** Minimal injectable asynchronous filesystem used by boot recovery scans. */
export interface RecoveryFs {
	access(path: string): Promise<void>;
	readdir(path: string): Promise<string[]>;
	stat(path: string): Promise<RecoveryStats>;
	open(path: string, flags: "r"): Promise<RecoveryFileHandle>;
	readFile(path: string, encoding: "utf-8"): Promise<string>;
}

export const realRecoveryFs: RecoveryFs = {
	access: (filePath) => fs.promises.access(filePath),
	readdir: (dirPath) => fs.promises.readdir(dirPath),
	stat: (filePath) => fs.promises.stat(filePath),
	open: (filePath, flags) => fs.promises.open(filePath, flags),
	readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
};

export interface AsyncTreeStats {
	atime?: Date;
	mtime?: Date;
	/** File identity used by the portable no-follow fallback. */
	dev?: number | bigint;
	ino?: number | bigint;
	/** Permission bits copied when the filesystem exposes them. */
	mode?: number;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

export interface AsyncTreeDirent {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

export interface AsyncTreeDirectory {
	read(): Promise<AsyncTreeDirent | null>;
	close(): Promise<void>;
}

export interface AsyncTreeFileHandle {
	read(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesRead: number }>;
	write(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesWritten: number }>;
	stat(): Promise<AsyncTreeStats>;
	chmod(mode: number): Promise<void>;
	close(): Promise<void>;
}

/** Promise-only seam for bounded traversal/copy/delete and chunked reads. */
export interface AsyncTreeFs {
	lstat(filePath: string): Promise<AsyncTreeStats>;
	opendir(dirPath: string): Promise<AsyncTreeDirectory>;
	mkdir(dirPath: string, options: { recursive: boolean }): Promise<unknown>;
	copyFile(source: string, destination: string, mode?: number): Promise<void>;
	readlink(filePath: string): Promise<string>;
	symlink(target: string, filePath: string): Promise<void>;
	unlink(filePath: string): Promise<void>;
	rmdir(dirPath: string): Promise<void>;
	utimes(filePath: string, atime: Date, mtime: Date): Promise<void>;
	realpath(filePath: string): Promise<string>;
	open(filePath: string, flags: string | number, mode?: number): Promise<AsyncTreeFileHandle>;
}

export const realAsyncTreeFs: AsyncTreeFs = {
	lstat: (filePath) => fs.promises.lstat(filePath),
	opendir: (dirPath) => fs.promises.opendir(dirPath),
	mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
	copyFile: (source, destination, mode) => mode === undefined
		? fs.promises.copyFile(source, destination)
		: fs.promises.copyFile(source, destination, mode),
	readlink: (filePath) => fs.promises.readlink(filePath),
	symlink: (target, filePath) => fs.promises.symlink(target, filePath),
	unlink: (filePath) => fs.promises.unlink(filePath),
	rmdir: (dirPath) => fs.promises.rmdir(dirPath),
	utimes: (filePath, atime, mtime) => fs.promises.utimes(filePath, atime, mtime),
	realpath: filePath => fs.promises.realpath(filePath),
	open: (filePath, flags, mode) => fs.promises.open(filePath, flags, mode),
};

export type AsyncTreeEntryKind = "directory" | "file" | "symlink" | "other";

export interface AsyncTreeEntry {
	absolutePath: string;
	/** POSIX relative path; the root itself is represented by an empty string. */
	relativePath: string;
	depth: number;
	kind: AsyncTreeEntryKind;
	stats: AsyncTreeStats;
}

export interface WalkTreeOptions {
	concurrency?: number;
	fs?: Pick<AsyncTreeFs, "lstat" | "opendir">;
}

interface TreeWork {
	absolutePath: string;
	relativePath: string;
	depth: number;
	/** Directory pathname that produced this work item. Absent only for the root. */
	parentAbsolutePath?: string;
	/** Stable identity captured from the producing directory frame. */
	parentAuthorizedStats?: AsyncTreeStats;
}

interface TreeFrame extends TreeWork {
	/** The no-follow lstat identity that authorized opening this frame. */
	authorizedStats: AsyncTreeStats;
	directory: AsyncTreeDirectory;
}

function entryKind(stats: AsyncTreeStats): AsyncTreeEntryKind {
	if (stats.isSymbolicLink()) return "symlink";
	if (stats.isDirectory()) return "directory";
	if (stats.isFile()) return "file";
	return "other";
}

function staleDirectoryError(filePath: string): NodeJS.ErrnoException {
	const error = new Error(`Directory changed during traversal: ${filePath}`) as NodeJS.ErrnoException;
	error.code = "ESTALE";
	return error;
}

function assertAuthorizedDirectory(
	expected: AsyncTreeStats,
	current: AsyncTreeStats,
	filePath: string,
): void {
	if (!isAuthorizedDirectory(expected, current, filePath)) throw staleDirectoryError(filePath);
}

async function assertTreeParentCurrent(
	treeFs: Pick<AsyncTreeFs, "lstat">,
	work: TreeWork,
): Promise<void> {
	if (work.parentAbsolutePath === undefined && work.parentAuthorizedStats === undefined) return;
	if (work.parentAbsolutePath === undefined || work.parentAuthorizedStats === undefined) {
		throw new Error(`Incomplete traversal parent claim: ${work.absolutePath}`);
	}
	const parentStats = await treeFs.lstat(work.parentAbsolutePath);
	assertAuthorizedDirectory(work.parentAuthorizedStats, parentStats, work.parentAbsolutePath);
}

/**
 * Revalidate a directory together with the exact producing parent on both
 * sides of the pathname lstat. The repeated parent check makes a queued child
 * claim fail closed if its ancestor changes while another worker owns it.
 */
async function assertTreeDirectoryCurrent(
	treeFs: Pick<AsyncTreeFs, "lstat">,
	work: TreeWork,
	authorizedStats: AsyncTreeStats,
): Promise<void> {
	await assertTreeParentCurrent(treeFs, work);
	const currentStats = await treeFs.lstat(work.absolutePath);
	assertAuthorizedDirectory(authorizedStats, currentStats, work.absolutePath);
	await assertTreeParentCurrent(treeFs, work);
}

async function openClaimedTreeDirectory(
	treeFs: Pick<AsyncTreeFs, "lstat" | "opendir">,
	work: TreeWork,
	authorizedStats: AsyncTreeStats,
): Promise<AsyncTreeDirectory> {
	await assertTreeDirectoryCurrent(treeFs, work, authorizedStats);
	let directory: AsyncTreeDirectory;
	try {
		directory = await treeFs.opendir(work.absolutePath);
	} catch (openError) {
		// Prefer the identity failure when the pathname changed during open.
		await assertTreeDirectoryCurrent(treeFs, work, authorizedStats);
		throw openError;
	}
	try {
		await assertTreeDirectoryCurrent(treeFs, work, authorizedStats);
	} catch (error) {
		try { await directory.close(); } catch { /* preserve the identity error */ }
		throw error;
	}
	return directory;
}

/**
 * Walk a tree through one bounded operation-level queue. Every entry is
 * classified with `lstat`; directory symlinks are reported as symlinks and are
 * never opened or traversed. `opendir().read()` streams directory entries, and
 * overflow beyond the small pending queue is handled by an iterative local DFS
 * rather than an unbounded tree-node queue.
 */
export async function walkTree(
	root: string,
	visitor: (entry: AsyncTreeEntry) => Promise<void> | void,
	options: WalkTreeOptions = {},
): Promise<void> {
	const concurrency = options.concurrency ?? BACKGROUND_IO_CONCURRENCY;
	validateConcurrency(concurrency);
	const treeFs = options.fs ?? realAsyncTreeFs;
	let operationStepsSinceYield = 0;

	await processDynamicQueue<TreeWork>(
		[{ absolutePath: root, relativePath: "", depth: 0 }],
		concurrency,
		async (seed, queue) => {
			const frames: TreeFrame[] = [];
			let next: TreeWork | undefined = seed;
			try {
				while (next || frames.length > 0) {
					if (next) {
						const current = next;
						next = undefined;
						// A queued/local-DFS child remains authorized only while the frame
						// that emitted its Dirent is still the same directory.
						await assertTreeParentCurrent(treeFs, current);
						const stats = await treeFs.lstat(current.absolutePath);
						await assertTreeParentCurrent(treeFs, current);
						const kind = entryKind(stats);
						await visitor({
							absolutePath: current.absolutePath,
							relativePath: current.relativePath,
							depth: current.depth,
							kind,
							stats,
						});
						if (kind === "directory") {
							// Visitors may await destination I/O. Revalidate the directory and
							// its producing parent immediately before and after opendir. An open
							// handle obtained during a race is closed before any read occurs.
							const directory = await openClaimedTreeDirectory(treeFs, current, stats);
							frames.push({
								...current,
								authorizedStats: stats,
								directory,
							});
						}
					} else {
						const frame = frames[frames.length - 1]!;
						const dirent = await frame.directory.read();
						// The open handle may still enumerate the original directory after
						// its pathname or an ancestor has been replaced. Revalidate both the
						// frame and its producing parent before deriving child work.
						await assertTreeDirectoryCurrent(treeFs, frame, frame.authorizedStats);
						if (!dirent) {
							frames.pop();
							await frame.directory.close();
						} else {
							const child: TreeWork = {
								absolutePath: path.join(frame.absolutePath, dirent.name),
								relativePath: frame.relativePath
									? `${frame.relativePath}/${dirent.name}`
									: dirent.name,
								depth: frame.depth + 1,
								parentAbsolutePath: frame.absolutePath,
								parentAuthorizedStats: frame.authorizedStats,
							};
							// The complete parent claim stays on both queued work and overflow
							// retained for the worker's iterative local DFS.
							if (!queue.tryEnqueue(child)) next = child;
						}
					}

					operationStepsSinceYield++;
					if (operationStepsSinceYield >= COOPERATIVE_YIELD_INTERVAL) {
						operationStepsSinceYield = 0;
						await yieldToEventLoop();
					}
				}
			} finally {
				for (let index = frames.length - 1; index >= 0; index--) {
					try { await frames[index]!.directory.close(); } catch { /* preserve the traversal error */ }
				}
			}
		},
		{ maxQueued: concurrency },
	);
}

/** Collect the complete sorted relative file list required by preview metadata. */
export async function listTreeFiles(root: string, options: WalkTreeOptions = {}): Promise<string[]> {
	const files: string[] = [];
	await walkTree(root, (entry) => {
		if (entry.kind === "file" && entry.relativePath) files.push(entry.relativePath);
	}, options);
	return files.sort();
}

type RegularFileReadFs = Pick<AsyncTreeFs, "lstat" | "open" | "realpath">;
type RegularFileCopyFs = Pick<AsyncTreeFs, "lstat" | "open" | "realpath" | "unlink">;

export interface OpenedRegularFile {
	handle: AsyncTreeFileHandle;
	stats: AsyncTreeStats;
}

function noFollowUnsupported(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "EINVAL" || code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}

function identityOf(stats: AsyncTreeStats): string | undefined {
	if (stats.dev === undefined || stats.ino === undefined) return undefined;
	const ino = String(stats.ino);
	// Some filesystems expose a placeholder zero rather than a stable file ID.
	if (ino === "0") return undefined;
	return `${String(stats.dev)}:${ino}`;
}

function matchesIdentityWhenAvailable(expected: AsyncTreeStats, current: AsyncTreeStats): boolean {
	const expectedIdentity = identityOf(expected);
	const currentIdentity = identityOf(current);
	if (expectedIdentity === undefined && currentIdentity === undefined) return true;
	return expectedIdentity !== undefined && expectedIdentity === currentIdentity;
}

/**
 * Return false when the path is no longer a real directory. A different real
 * directory is an unsafe replacement and aborts the operation rather than
 * authorizing traversal from type alone.
 */
function isAuthorizedDirectory(
	expected: AsyncTreeStats,
	current: AsyncTreeStats,
	filePath: string,
): boolean {
	if (!current.isDirectory() || current.isSymbolicLink()) return false;
	if (matchesIdentityWhenAvailable(expected, current)) return true;
	throw staleDirectoryError(filePath);
}

function isExpectedRegularFile(expected: AsyncTreeStats, current: AsyncTreeStats): boolean {
	return expected.isFile()
		&& !expected.isSymbolicLink()
		&& current.isFile()
		&& !current.isSymbolicLink()
		&& sameFileIdentity(expected, current);
}

/** True when stats expose a stable descriptor identity usable for comparisons. */
export function hasStableFileIdentity(stats: AsyncTreeStats): boolean {
	return identityOf(stats) !== undefined;
}

/** True only when both stats expose the same stable descriptor identity. */
export function sameFileIdentity(left: AsyncTreeStats, right: AsyncTreeStats): boolean {
	const leftIdentity = identityOf(left);
	return leftIdentity !== undefined && leftIdentity === identityOf(right);
}

function isContainedPath(filePath: string, root: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(filePath));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function closeAfterError(handle: AsyncTreeFileHandle, operationError: unknown): Promise<never> {
	try { await handle.close(); } catch { /* preserve the validation error */ }
	throw operationError;
}

/**
 * Open a regular source file without following a substituted final-component
 * symlink. POSIX uses O_NOFOLLOW; every platform also compares descriptor and
 * pathname identities before any bytes are read. When a canonical root is
 * supplied, a post-open realpath check rejects ancestor-symlink substitution.
 * The descriptor anchors every later read.
 */
export async function openRegularFileNoFollow(
	filePath: string,
	fileSystem: RegularFileReadFs = realAsyncTreeFs,
	containedWithin?: string,
	expectedStats?: AsyncTreeStats,
): Promise<OpenedRegularFile> {
	const noFollow = (fs.constants as Record<string, number | undefined>).O_NOFOLLOW;
	let handle: AsyncTreeFileHandle;
	let noFollowEnforced = false;
	if (typeof noFollow === "number" && noFollow !== 0) {
		try {
			handle = await fileSystem.open(filePath, fs.constants.O_RDONLY | noFollow);
			noFollowEnforced = true;
		} catch (error) {
			if (!noFollowUnsupported(error)) throw error;
			handle = await fileSystem.open(filePath, "r");
		}
	} else {
		handle = await fileSystem.open(filePath, "r");
	}

	let descriptorStats: AsyncTreeStats;
	try {
		descriptorStats = await handle.stat();
	} catch (error) {
		return closeAfterError(handle, error);
	}
	if (!descriptorStats.isFile() || descriptorStats.isSymbolicLink()) {
		return closeAfterError(handle, new Error(`Source is not an opened regular file: ${filePath}`));
	}
	// Enforce a caller's prior claim immediately after handle.stat(). This must
	// precede pathname validation and, critically, every descriptor read.
	if (expectedStats !== undefined && !isExpectedRegularFile(expectedStats, descriptorStats)) {
		return closeAfterError(handle, new Error(`Source changed from its expected regular file identity: ${filePath}`));
	}

	let pathnameStats: AsyncTreeStats;
	try {
		pathnameStats = await fileSystem.lstat(filePath);
	} catch (error) {
		return closeAfterError(handle, error);
	}
	const descriptorIdentity = identityOf(descriptorStats);
	const pathnameIdentity = identityOf(pathnameStats);
	if (pathnameStats.isSymbolicLink()
		|| !pathnameStats.isFile()
		|| (descriptorIdentity !== undefined && descriptorIdentity !== pathnameIdentity)
		|| (!noFollowEnforced && (descriptorIdentity === undefined || pathnameIdentity === undefined))) {
		return closeAfterError(handle, new Error(`Source changed or is not a regular file: ${filePath}`));
	}
	if (containedWithin !== undefined) {
		let canonicalPath: string;
		try { canonicalPath = await fileSystem.realpath(filePath); }
		catch (error) { return closeAfterError(handle, error); }
		if (!isContainedPath(canonicalPath, containedWithin)) {
			return closeAfterError(handle, new Error(`Source escapes its expected root: ${filePath}`));
		}

		// `realpath()` returns another pathname, not a capability. Bind that
		// returned target back to the descriptor before any caller can read it;
		// otherwise a toggled ancestor can make containment validate one file
		// while the already-open descriptor identifies another.
		let canonicalStats: AsyncTreeStats;
		try { canonicalStats = await fileSystem.lstat(canonicalPath); }
		catch (error) { return closeAfterError(handle, error); }
		if (!canonicalStats.isFile()
			|| canonicalStats.isSymbolicLink()
			|| !sameFileIdentity(descriptorStats, canonicalStats)) {
			return closeAfterError(handle, new Error(`Canonical source does not match the opened regular file: ${filePath}`));
		}
	}
	return { handle, stats: descriptorStats };
}

export interface ReadRegularFileChunksOptions {
	fs?: RegularFileReadFs;
	chunkSize?: number;
	/** Canonical source root that the opened file must remain within. */
	containedWithin?: string;
	/** Prior no-follow lstat that the opened descriptor must still identify. */
	expectedStats?: AsyncTreeStats;
}

/** Stream bounded chunks from one validated, descriptor-anchored source. */
export async function readRegularFileNoFollowInChunks(
	filePath: string,
	onChunk: (chunk: Uint8Array) => Promise<void> | void,
	options: ReadRegularFileChunksOptions = {},
): Promise<AsyncTreeStats> {
	const chunkSize = options.chunkSize ?? 64 * 1024;
	if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
		throw new RangeError("chunk size must be a positive integer");
	}
	const opened = await openRegularFileNoFollow(
		filePath,
		options.fs,
		options.containedWithin,
		options.expectedStats,
	);
	const buffer = new Uint8Array(chunkSize);
	let position = 0;
	let chunksSinceYield = 0;
	let operationError: unknown;
	try {
		for (;;) {
			const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			await onChunk(buffer.subarray(0, bytesRead));
			position += bytesRead;
			chunksSinceYield++;
			if (chunksSinceYield >= COOPERATIVE_YIELD_INTERVAL) {
				chunksSinceYield = 0;
				await yieldToEventLoop();
			}
		}
	} catch (error) {
		operationError = error;
	}
	try { await opened.handle.close(); }
	catch (closeError) { operationError ??= closeError; }
	if (operationError !== undefined) throw operationError;
	return opened.stats;
}

export interface CopyRegularFileOptions {
	fs?: RegularFileCopyFs;
	chunkSize?: number;
	/** Canonical source root that the opened file must remain within. */
	containedWithin?: string;
	/** Prior no-follow lstat that the opened source must still identify. */
	expectedStats?: AsyncTreeStats;
	/** Fail if the destination exists (default true). */
	exclusive?: boolean;
	/** Destination create mode before the source mode is applied. */
	createMode?: number;
	/** Canonical destination root that must contain the created file. */
	destinationContainedWithin: string;
	/** No-follow pathname for the bound destination root. */
	destinationRoot: string;
	/** Stable identity captured while binding the destination root. */
	expectedDestinationRootStats: AsyncTreeStats;
}

async function assertCopyDestinationRootCurrent(
	fileSystem: RegularFileCopyFs,
	root: string,
	canonicalRoot: string,
	expected: AsyncTreeStats,
): Promise<void> {
	for (const candidate of new Set([path.resolve(root), path.resolve(canonicalRoot)])) {
		const current = await fileSystem.lstat(candidate);
		if (!current.isDirectory()
			|| current.isSymbolicLink()
			|| !hasStableFileIdentity(current)
			|| !sameFileIdentity(expected, current)) {
			throw new Error(`Copy destination root changed: ${root}`);
		}
	}
}

async function assertOpenedCopyDestinationCurrent(
	fileSystem: RegularFileCopyFs,
	destination: string,
	destinationStats: AsyncTreeStats,
	root: string,
	canonicalRoot: string,
	expectedRootStats: AsyncTreeStats,
): Promise<void> {
	await assertCopyDestinationRootCurrent(fileSystem, root, canonicalRoot, expectedRootStats);
	const pathnameStats = await fileSystem.lstat(destination);
	if (!pathnameStats.isFile()
		|| pathnameStats.isSymbolicLink()
		|| !sameFileIdentity(destinationStats, pathnameStats)) {
		throw new Error(`Copy destination changed after open: ${destination}`);
	}
	const canonicalDestination = await fileSystem.realpath(destination);
	if (!isContainedPath(canonicalDestination, canonicalRoot)) {
		throw new Error(`Copy destination escapes its expected root: ${destination}`);
	}
	const canonicalStats = await fileSystem.lstat(canonicalDestination);
	if (!canonicalStats.isFile()
		|| canonicalStats.isSymbolicLink()
		|| !sameFileIdentity(destinationStats, canonicalStats)) {
		throw new Error(`Canonical destination does not match the opened regular file: ${destination}`);
	}
	await assertCopyDestinationRootCurrent(fileSystem, root, canonicalRoot, expectedRootStats);
}

/**
 * Copy through bounded source/destination descriptors. The destination handle,
 * canonical containment, and bound root identity are all validated before the
 * first source read. Failed copies unlink only a validated owned destination.
 */
export async function copyRegularFileNoFollow(
	source: string,
	destination: string,
	options: CopyRegularFileOptions,
): Promise<AsyncTreeStats> {
	const fileSystem = options.fs ?? realAsyncTreeFs;
	const destinationRoot = path.resolve(options.destinationRoot);
	const canonicalDestinationRoot = path.resolve(options.destinationContainedWithin);
	if (!hasStableFileIdentity(options.expectedDestinationRootStats)
		|| !options.expectedDestinationRootStats.isDirectory()
		|| options.expectedDestinationRootStats.isSymbolicLink()) {
		throw new Error(`Copy destination root is not a stable directory: ${destinationRoot}`);
	}
	const chunkSize = options.chunkSize ?? 64 * 1024;
	if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
		throw new RangeError("chunk size must be a positive integer");
	}
	if (options.exclusive === false) {
		throw new RangeError("descriptor-anchored destination copies must be exclusive");
	}
	const opened = await openRegularFileNoFollow(
		source,
		fileSystem,
		options.containedWithin,
		options.expectedStats,
	);

	let destinationHandle: AsyncTreeFileHandle | undefined;
	let destinationStats: AsyncTreeStats | undefined;
	let destinationValidated = false;
	let operationError: unknown;
	try {
		await assertCopyDestinationRootCurrent(
			fileSystem,
			destinationRoot,
			canonicalDestinationRoot,
			options.expectedDestinationRootStats,
		);
		// The string form maps to native O_CREAT|O_EXCL without baking one
		// platform's numeric flag values into an injected/portable filesystem.
		destinationHandle = await fileSystem.open(destination, "wx", options.createMode ?? 0o666);
		destinationStats = await destinationHandle.stat();
		if (!destinationStats.isFile()
			|| destinationStats.isSymbolicLink()
			|| !hasStableFileIdentity(destinationStats)) {
			throw new Error(`Copy destination is not an opened stable regular file: ${destination}`);
		}
		await assertOpenedCopyDestinationCurrent(
			fileSystem,
			destination,
			destinationStats,
			destinationRoot,
			canonicalDestinationRoot,
			options.expectedDestinationRootStats,
		);
		destinationValidated = true;

		const buffer = new Uint8Array(chunkSize);
		let position = 0;
		let chunksSinceYield = 0;
		for (;;) {
			await assertOpenedCopyDestinationCurrent(
				fileSystem,
				destination,
				destinationStats,
				destinationRoot,
				canonicalDestinationRoot,
				options.expectedDestinationRootStats,
			);
			const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			// A destination-ancestor swap during the source read is rejected before
			// any of the buffered source bytes can reach the destination descriptor.
			await assertOpenedCopyDestinationCurrent(
				fileSystem,
				destination,
				destinationStats,
				destinationRoot,
				canonicalDestinationRoot,
				options.expectedDestinationRootStats,
			);
			let written = 0;
			while (written < bytesRead) {
				const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
				if (result.bytesWritten <= 0) throw new Error(`Copy made no write progress: ${destination}`);
				written += result.bytesWritten;
			}
			await assertOpenedCopyDestinationCurrent(
				fileSystem,
				destination,
				destinationStats,
				destinationRoot,
				canonicalDestinationRoot,
				options.expectedDestinationRootStats,
			);
			position += bytesRead;
			chunksSinceYield++;
			if (chunksSinceYield >= COOPERATIVE_YIELD_INTERVAL) {
				chunksSinceYield = 0;
				await yieldToEventLoop();
			}
		}
		if (opened.stats.mode !== undefined) {
			await destinationHandle.chmod(opened.stats.mode & 0o7777);
			await assertOpenedCopyDestinationCurrent(
				fileSystem,
				destination,
				destinationStats,
				destinationRoot,
				canonicalDestinationRoot,
				options.expectedDestinationRootStats,
			);
		}
	} catch (error) {
		operationError = error;
	}

	if (destinationHandle) {
		try { await destinationHandle.close(); }
		catch (closeError) { operationError ??= closeError; }
	}
	try { await opened.handle.close(); }
	catch (closeError) { operationError ??= closeError; }
	if (operationError !== undefined) {
		if (destinationValidated && destinationStats) {
			try {
				const current = await fileSystem.lstat(destination);
				if (current.isFile()
					&& !current.isSymbolicLink()
					&& sameFileIdentity(destinationStats, current)) {
					await fileSystem.unlink(destination);
				}
			} catch { /* preserve the copy error */ }
		}
		throw operationError;
	}
	return opened.stats;
}

export interface ReadFileChunksOptions {
	fs?: Pick<AsyncTreeFs, "open">;
	chunkSize?: number;
}

/**
 * Read a file through one reusable fixed-size buffer. The chunk view is valid
 * only until the callback resolves; callers that need to retain bytes must copy
 * that individual chunk explicitly.
 */
export async function readFileInChunks(
	filePath: string,
	onChunk: (chunk: Uint8Array) => Promise<void> | void,
	options: ReadFileChunksOptions = {},
): Promise<void> {
	const chunkSize = options.chunkSize ?? 64 * 1024;
	if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
		throw new RangeError("chunk size must be a positive integer");
	}
	const fileSystem = options.fs ?? realAsyncTreeFs;
	const handle = await fileSystem.open(filePath, "r");
	const buffer = new Uint8Array(chunkSize);
	let position = 0;
	let chunksSinceYield = 0;
	let operationError: unknown;
	try {
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			await onChunk(buffer.subarray(0, bytesRead));
			position += bytesRead;
			chunksSinceYield++;
			if (chunksSinceYield >= COOPERATIVE_YIELD_INTERVAL) {
				chunksSinceYield = 0;
				await yieldToEventLoop();
			}
		}
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		try {
			await handle.close();
		} catch (closeError) {
			if (operationError === undefined) throw closeError;
		}
	}
}

export interface CopyTreeOptions {
	concurrency?: number;
	fs?: AsyncTreeFs;
	/** Copy links as links (default) or omit them. Links are never followed. */
	symlinks?: "copy" | "skip";
	/** Preserve regular-file atime/mtime when available (default true). */
	preserveTimestamps?: boolean;
	/** Copy flag; defaults to COPYFILE_EXCL to retain error-on-exist semantics. */
	copyFileMode?: number;
}

/** Symlink-safe bounded tree copy. */
export async function copyTree(source: string, destination: string, options: CopyTreeOptions = {}): Promise<void> {
	const sourceRoot = path.resolve(source);
	const destinationRoot = path.resolve(destination);
	const relativeDestination = path.relative(sourceRoot, destinationRoot);
	if (relativeDestination === "" || (!relativeDestination.startsWith("..") && !path.isAbsolute(relativeDestination))) {
		throw new RangeError("copy destination must be outside the source tree");
	}

	const treeFs = options.fs ?? realAsyncTreeFs;
	const canonicalSourceRoot = await treeFs.realpath(sourceRoot);
	const symlinks = options.symlinks ?? "copy";
	const preserveTimestamps = options.preserveTimestamps ?? true;
	const copyFileMode = options.copyFileMode ?? fs.constants.COPYFILE_EXCL;
	if ((copyFileMode & fs.constants.COPYFILE_FICLONE_FORCE) !== 0) {
		const error = new Error("Descriptor-anchored copy cannot require copy-on-write cloning") as NodeJS.ErrnoException;
		error.code = "ENOTSUP";
		throw error;
	}
	if ((copyFileMode & fs.constants.COPYFILE_EXCL) === 0) {
		throw new RangeError("bounded tree copies require exclusive destinations");
	}
	await treeFs.mkdir(path.dirname(destinationRoot), { recursive: true });
	await treeFs.mkdir(destinationRoot, { recursive: false });
	const destinationRootStats = await treeFs.lstat(destinationRoot);
	if (!destinationRootStats.isDirectory()
		|| destinationRootStats.isSymbolicLink()
		|| !hasStableFileIdentity(destinationRootStats)) {
		throw new Error(`Copy destination root is not a stable directory: ${destinationRoot}`);
	}
	const canonicalDestinationRoot = await treeFs.realpath(destinationRoot);
	const canonicalDestinationRootStats = await treeFs.lstat(canonicalDestinationRoot);
	if (!canonicalDestinationRootStats.isDirectory()
		|| canonicalDestinationRootStats.isSymbolicLink()
		|| !sameFileIdentity(destinationRootStats, canonicalDestinationRootStats)) {
		throw new Error(`Copy destination canonical root changed: ${destinationRoot}`);
	}
	const assertDestinationCurrent = () => assertCopyDestinationRootCurrent(
		treeFs,
		destinationRoot,
		canonicalDestinationRoot,
		destinationRootStats,
	);

	await walkTree(sourceRoot, async (entry) => {
		const target = entry.relativePath
			? path.join(destinationRoot, ...entry.relativePath.split("/"))
			: destinationRoot;
		if (entry.kind === "directory") {
			if (entry.relativePath) {
				await assertDestinationCurrent();
				await treeFs.mkdir(target, { recursive: false });
				await assertDestinationCurrent();
			}
			return;
		}
		if (entry.kind === "file") {
			const sourceStats = await copyRegularFileNoFollow(entry.absolutePath, target, {
				fs: treeFs,
				containedWithin: canonicalSourceRoot,
				expectedStats: entry.stats,
				exclusive: true,
				destinationContainedWithin: canonicalDestinationRoot,
				destinationRoot,
				expectedDestinationRootStats: destinationRootStats,
			});
			if (preserveTimestamps && sourceStats.atime && sourceStats.mtime) {
				await assertDestinationCurrent();
				await treeFs.utimes(target, sourceStats.atime, sourceStats.mtime);
				await assertDestinationCurrent();
			}
			return;
		}
		if (entry.kind === "symlink") {
			if (symlinks === "copy") {
				const linkTarget = await treeFs.readlink(entry.absolutePath);
				await assertDestinationCurrent();
				await treeFs.symlink(linkTarget, target);
				await assertDestinationCurrent();
			}
			return;
		}
		throw new Error(`Unsupported tree entry: ${entry.absolutePath}`);
	}, { concurrency: options.concurrency, fs: treeFs });
}

export interface RemoveTreeOptions {
	fs?: Pick<AsyncTreeFs, "lstat" | "opendir" | "unlink" | "rmdir">;
	/** Ignore a missing root or entries removed concurrently (default true). */
	force?: boolean;
	/** Delete descendants while retaining the root directory (default false). */
	preserveRoot?: boolean;
	/** Prior no-follow lstat claim required before recursively opening the root. */
	expectedRootStats?: AsyncTreeStats;
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Remove a tree post-order without recursive rm. The iterative opendir walk
 * retains only active directory frames, never follows a symlink, and has at
 * most one filesystem promise pending. Use `mapWithConcurrency` around
 * independent roots when wider deletion is safe for the caller's policy.
 */
export async function removeTree(root: string, options: RemoveTreeOptions = {}): Promise<void> {
	const treeFs = options.fs ?? realAsyncTreeFs;
	const force = options.force ?? true;
	const preserveRoot = options.preserveRoot ?? false;

	type DirectoryClaimState =
		| { kind: "current"; stats: AsyncTreeStats }
		| { kind: "replacement"; stats: AsyncTreeStats }
		| { kind: "missing" };

	const lstatForRemoval = async (filePath: string): Promise<AsyncTreeStats | undefined> => {
		try { return await treeFs.lstat(filePath); }
		catch (error) {
			if (force && isMissing(error)) return undefined;
			throw error;
		}
	};

	const parentClaimCurrent = async (work: TreeWork): Promise<boolean> => {
		if (work.parentAbsolutePath === undefined && work.parentAuthorizedStats === undefined) return true;
		if (work.parentAbsolutePath === undefined || work.parentAuthorizedStats === undefined) {
			throw new Error(`Incomplete removal parent claim: ${work.absolutePath}`);
		}
		const parentStats = await lstatForRemoval(work.parentAbsolutePath);
		if (parentStats === undefined) return false;
		assertAuthorizedDirectory(work.parentAuthorizedStats, parentStats, work.parentAbsolutePath);
		return true;
	};

	const inspectDirectoryClaim = async (
		work: TreeWork,
		authorizedStats: AsyncTreeStats,
	): Promise<DirectoryClaimState> => {
		if (!await parentClaimCurrent(work)) return { kind: "missing" };
		const currentStats = await lstatForRemoval(work.absolutePath);
		if (currentStats === undefined) return { kind: "missing" };
		if (!await parentClaimCurrent(work)) return { kind: "missing" };
		return isAuthorizedDirectory(authorizedStats, currentStats, work.absolutePath)
			? { kind: "current", stats: currentStats }
			: { kind: "replacement", stats: currentStats };
	};

	const assertSameLeafClaim = (
		expected: AsyncTreeStats,
		current: AsyncTreeStats,
		filePath: string,
	): void => {
		if (current.isDirectory() && !current.isSymbolicLink()) throw staleDirectoryError(filePath);
		if (entryKind(expected) !== entryKind(current)
			|| !matchesIdentityWhenAvailable(expected, current)) {
			throw staleDirectoryError(filePath);
		}
	};

	/** Unlink only a revalidated leaf while its producing directory is current. */
	const unlinkClaimedLeaf = async (
		work: TreeWork,
		authorizedStats: AsyncTreeStats,
	): Promise<void> => {
		if (!await parentClaimCurrent(work)) return;
		let currentStats = await lstatForRemoval(work.absolutePath);
		if (currentStats === undefined) return;
		assertSameLeafClaim(authorizedStats, currentStats, work.absolutePath);
		if (!await parentClaimCurrent(work)) return;
		// Re-read the leaf immediately before unlink so an identity replacement
		// cannot inherit the earlier authorization.
		currentStats = await lstatForRemoval(work.absolutePath);
		if (currentStats === undefined) return;
		assertSameLeafClaim(authorizedStats, currentStats, work.absolutePath);
		if (!await parentClaimCurrent(work)) return;
		try { await treeFs.unlink(work.absolutePath); }
		catch (error) { if (!force || !isMissing(error)) throw error; }
	};

	const rootWork: TreeWork = { absolutePath: root, relativePath: "", depth: 0 };
	const initialRootStats = await lstatForRemoval(root);
	if (initialRootStats === undefined) return;

	if (!initialRootStats.isDirectory() || initialRootStats.isSymbolicLink()) {
		// Preserve direct-leaf rm semantics: lstat classified the requested root
		// itself, so unlink the final component rather than resolving a child path.
		try { await treeFs.unlink(root); }
		catch (error) { if (!force || !isMissing(error)) throw error; }
		return;
	}
	if (options.expectedRootStats !== undefined) {
		if (!hasStableFileIdentity(options.expectedRootStats)
			|| !hasStableFileIdentity(initialRootStats)
			|| !sameFileIdentity(options.expectedRootStats, initialRootStats)) {
			throw staleDirectoryError(root);
		}
		assertAuthorizedDirectory(options.expectedRootStats, initialRootStats, root);
	}

	// Bind the root immediately before and after open. A final-component symlink
	// replacement remains a directly-unlinked leaf; a different real directory
	// raises ESTALE and is never enumerated or removed.
	const preOpenRoot = await inspectDirectoryClaim(rootWork, initialRootStats);
	if (preOpenRoot.kind === "missing") return;
	if (preOpenRoot.kind === "replacement") {
		await unlinkClaimedLeaf(rootWork, preOpenRoot.stats);
		return;
	}

	let rootDirectory: AsyncTreeDirectory;
	try {
		rootDirectory = await treeFs.opendir(root);
	} catch (openError) {
		const failedOpenRoot = await inspectDirectoryClaim(rootWork, initialRootStats);
		if (failedOpenRoot.kind === "missing") return;
		if (failedOpenRoot.kind === "replacement") {
			await unlinkClaimedLeaf(rootWork, failedOpenRoot.stats);
			return;
		}
		throw openError;
	}
	let postOpenRoot: DirectoryClaimState;
	try {
		postOpenRoot = await inspectDirectoryClaim(rootWork, initialRootStats);
	} catch (error) {
		try { await rootDirectory.close(); } catch { /* preserve the identity error */ }
		throw error;
	}
	if (postOpenRoot.kind !== "current") {
		await rootDirectory.close();
		if (postOpenRoot.kind === "replacement") {
			await unlinkClaimedLeaf(rootWork, postOpenRoot.stats);
		}
		return;
	}

	const frames: TreeFrame[] = [{
		...rootWork,
		authorizedStats: initialRootStats,
		directory: rootDirectory,
	}];
	const detachTopFrame = async (
		frame: TreeFrame,
		state: Exclude<DirectoryClaimState, { kind: "current" }>,
	): Promise<void> => {
		if (frames[frames.length - 1] !== frame) throw new Error("Removal frame stack changed unexpectedly");
		frames.pop();
		await frame.directory.close();
		if (state.kind === "replacement") await unlinkClaimedLeaf(frame, state.stats);
	};
	let stepsSinceYield = 0;
	try {
		while (frames.length > 0) {
			const frame = frames[frames.length - 1]!;
			const dirent = await frame.directory.read();
			// A handle can keep reading a detached directory. Check both this frame
			// and the identity of the parent that produced it after every read.
			const afterRead = await inspectDirectoryClaim(frame, frame.authorizedStats);
			if (afterRead.kind !== "current") {
				await detachTopFrame(frame, afterRead);
				continue;
			}

			if (!dirent) {
				frames.pop();
				await frame.directory.close();
				if (!preserveRoot || frame.depth > 0) {
					// Closing the descriptor is another async race window. Revalidate the
					// frame and producing parent immediately before the final operation.
					const finalClaim = await inspectDirectoryClaim(frame, frame.authorizedStats);
					if (finalClaim.kind === "replacement") {
						await unlinkClaimedLeaf(frame, finalClaim.stats);
					} else if (finalClaim.kind === "current") {
						try { await treeFs.rmdir(frame.absolutePath); }
						catch (error) { if (!force || !isMissing(error)) throw error; }
					}
				}
			} else {
				const child: TreeWork = {
					absolutePath: path.join(frame.absolutePath, dirent.name),
					relativePath: "",
					depth: frame.depth + 1,
					parentAbsolutePath: frame.absolutePath,
					parentAuthorizedStats: frame.authorizedStats,
				};

				// Revalidate the frame and its own producing parent on both sides of
				// the child lstat. No child pathname is used after an ancestor swap.
				const beforeChild = await inspectDirectoryClaim(frame, frame.authorizedStats);
				if (beforeChild.kind !== "current") {
					await detachTopFrame(frame, beforeChild);
					continue;
				}
				const childStats = await lstatForRemoval(child.absolutePath);
				if (childStats === undefined) continue;
				const afterChild = await inspectDirectoryClaim(frame, frame.authorizedStats);
				if (afterChild.kind !== "current") {
					await detachTopFrame(frame, afterChild);
					continue;
				}

				if (childStats.isDirectory() && !childStats.isSymbolicLink()) {
					const beforeChildOpenParent = await inspectDirectoryClaim(frame, frame.authorizedStats);
					if (beforeChildOpenParent.kind !== "current") {
						await detachTopFrame(frame, beforeChildOpenParent);
						continue;
					}
					const beforeChildOpen = await inspectDirectoryClaim(child, childStats);
					if (beforeChildOpen.kind === "missing") continue;
					if (beforeChildOpen.kind === "replacement") {
						await unlinkClaimedLeaf(child, beforeChildOpen.stats);
						continue;
					}

					let childDirectory: AsyncTreeDirectory;
					try {
						childDirectory = await treeFs.opendir(child.absolutePath);
					} catch (openError) {
						const failedOpenParent = await inspectDirectoryClaim(frame, frame.authorizedStats);
						if (failedOpenParent.kind !== "current") {
							await detachTopFrame(frame, failedOpenParent);
							continue;
						}
						const failedOpenChild = await inspectDirectoryClaim(child, childStats);
						if (failedOpenChild.kind === "missing") continue;
						if (failedOpenChild.kind === "replacement") {
							await unlinkClaimedLeaf(child, failedOpenChild.stats);
							continue;
						}
						throw openError;
					}

					let postOpenParent: DirectoryClaimState;
					let postOpenChild: DirectoryClaimState;
					try {
						postOpenParent = await inspectDirectoryClaim(frame, frame.authorizedStats);
						postOpenChild = postOpenParent.kind === "current"
							? await inspectDirectoryClaim(child, childStats)
							: { kind: "missing" };
					} catch (error) {
						try { await childDirectory.close(); } catch { /* preserve the identity error */ }
						throw error;
					}
					if (postOpenParent.kind !== "current") {
						await childDirectory.close();
						await detachTopFrame(frame, postOpenParent);
						continue;
					}
					if (postOpenChild.kind !== "current") {
						await childDirectory.close();
						if (postOpenChild.kind === "replacement") {
							await unlinkClaimedLeaf(child, postOpenChild.stats);
						}
						continue;
					}
					frames.push({
						...child,
						authorizedStats: childStats,
						directory: childDirectory,
					});
				} else {
					// The frame/grandparent claim is checked immediately before the leaf
					// helper revalidates the immediate parent and child identity.
					const beforeUnlink = await inspectDirectoryClaim(frame, frame.authorizedStats);
					if (beforeUnlink.kind !== "current") {
						await detachTopFrame(frame, beforeUnlink);
						continue;
					}
					await unlinkClaimedLeaf(child, childStats);
				}
			}

			stepsSinceYield++;
			if (stepsSinceYield >= COOPERATIVE_YIELD_INTERVAL) {
				stepsSinceYield = 0;
				await yieldToEventLoop();
			}
		}
	} finally {
		for (let index = frames.length - 1; index >= 0; index--) {
			try { await frames[index]!.directory.close(); } catch { /* preserve the removal error */ }
		}
	}
}
