import { randomUUID } from "node:crypto";
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
	rename(oldPath: string, newPath: string): Promise<void>;
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
	rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
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
	/** Revalidate the root-to-entry pathname claim before further pathname I/O. */
	assertCurrent(): Promise<void>;
	/**
	 * Fence one pathname operation with root-to-entry identity checks. Callers
	 * must use this around pathname reads whose result drives a later side effect.
	 */
	withCurrentClaim<T>(operation: () => Promise<T> | T): Promise<T>;
}

export interface WalkTreeOptions {
	concurrency?: number;
	fs?: Pick<AsyncTreeFs, "lstat" | "opendir">;
}

interface TreeClaim {
	absolutePath: string;
	authorizedStats: AsyncTreeStats;
	/** Immediate producing-directory claim. */
	parent?: TreeClaim;
	/** Stable operation root retained without copying an O(depth) claim array. */
	rootClaim?: TreeClaim;
}

interface TreeWork {
	absolutePath: string;
	relativePath: string;
	depth: number;
	/** Complete producing-directory claim, shared by queued/local DFS children. */
	parentClaim?: TreeClaim;
}

interface TreeFrame extends TreeWork {
	claim: TreeClaim;
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

/**
 * Validate the operation root, immediate producer, and current pathname. An
 * intermediate ancestor can resolve to the same immediate directory only by
 * reaching that exact authorized inode, so retaining more path claims adds
 * quadratic deep-tree I/O without strengthening the leaf authorization.
 */
async function assertTreeClaimCurrent(
	treeFs: Pick<AsyncTreeFs, "lstat">,
	claim: TreeClaim | undefined,
): Promise<void> {
	if (!claim) return;
	const claims = new Set<TreeClaim>();
	if (claim.rootClaim) claims.add(claim.rootClaim);
	if (claim.parent) claims.add(claim.parent);
	claims.add(claim);
	for (const currentClaim of claims) {
		const currentStats = await treeFs.lstat(currentClaim.absolutePath);
		if (entryKind(currentClaim.authorizedStats) !== entryKind(currentStats)
			|| !matchesIdentityWhenAvailable(currentClaim.authorizedStats, currentStats)) {
			throw staleDirectoryError(currentClaim.absolutePath);
		}
	}
}

async function withTreeClaim<T>(
	treeFs: Pick<AsyncTreeFs, "lstat">,
	claim: TreeClaim,
	operation: () => Promise<T> | T,
): Promise<T> {
	await assertTreeClaimCurrent(treeFs, claim);
	let result: T;
	try {
		result = await operation();
	} catch (operationError) {
		// Prefer the identity failure when the namespace changed during I/O.
		await assertTreeClaimCurrent(treeFs, claim);
		throw operationError;
	}
	await assertTreeClaimCurrent(treeFs, claim);
	return result;
}

async function openClaimedTreeDirectory(
	treeFs: Pick<AsyncTreeFs, "lstat" | "opendir">,
	claim: TreeClaim,
): Promise<AsyncTreeDirectory> {
	return withTreeClaim(treeFs, claim, () => treeFs.opendir(claim.absolutePath));
}

/**
 * Walk a tree through one bounded operation-level queue. Every entry is
 * classified with `lstat`; directory symlinks are reported as symlinks and are
 * never opened or traversed. Every queued entry retains a linked root-to-parent
 * claim, and visitor pathname I/O can use `withCurrentClaim` for bracketing.
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
						await assertTreeClaimCurrent(treeFs, current.parentClaim);
						const stats = await treeFs.lstat(current.absolutePath);
						await assertTreeClaimCurrent(treeFs, current.parentClaim);
						const claim: TreeClaim = {
							absolutePath: current.absolutePath,
							authorizedStats: stats,
							parent: current.parentClaim,
							rootClaim: current.parentClaim?.rootClaim ?? current.parentClaim,
						};
						const kind = entryKind(stats);
						const entry: AsyncTreeEntry = {
							absolutePath: current.absolutePath,
							relativePath: current.relativePath,
							depth: current.depth,
							kind,
							stats,
							assertCurrent: () => assertTreeClaimCurrent(treeFs, claim),
							withCurrentClaim: operation => withTreeClaim(treeFs, claim, operation),
						};
						// Fence even synchronous visitors. Async visitors that perform a
						// pathname read before a later side effect additionally bracket that
						// read with entry.withCurrentClaim().
						await withTreeClaim(treeFs, claim, () => visitor(entry));
						if (kind === "directory") {
							const directory = await openClaimedTreeDirectory(treeFs, claim);
							frames.push({ ...current, claim, directory });
						}
					} else {
						const frame = frames[frames.length - 1]!;
						const dirent = await frame.directory.read();
						await assertTreeClaimCurrent(treeFs, frame.claim);
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
								parentClaim: frame.claim,
							};
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
				// `readlink` is pathname-based. Do not let its result escape the
				// source claim when a parent changes while the read is pending.
				const linkTarget = await entry.withCurrentClaim(
					() => treeFs.readlink(entry.absolutePath),
				);
				await assertDestinationCurrent();
				await treeFs.symlink(linkTarget, target);
				await assertDestinationCurrent();
			}
			return;
		}
		throw new Error(`Unsupported tree entry: ${entry.absolutePath}`);
	}, { concurrency: options.concurrency, fs: treeFs });
}

type RemoveTreeFs = Pick<AsyncTreeFs, "lstat" | "opendir" | "rename" | "unlink" | "rmdir">;

export interface RemoveTreeOptions {
	fs?: RemoveTreeFs;
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

interface RemovalClaim {
	absolutePath: string;
	authorizedStats: AsyncTreeStats;
	parent?: RemovalClaim;
	rootClaim?: RemovalClaim;
}

interface DetachedRemovalClaim extends RemovalClaim {
	/** Caller-visible pathname from which this exact identity was detached. */
	originalPath: string;
	state: "detached" | "restored" | "removed";
}

interface RemovalFrame {
	claim: RemovalClaim;
	directory: AsyncTreeDirectory;
	removeAtEnd: boolean;
}

/**
 * Remove a tree without ever recursively deleting the caller-owned pathname.
 * A non-preserved root is first renamed to an unguessable same-parent sibling;
 * preserved roots detach each child the same way. Every moved identity is
 * verified before traversal or deletion, and a mismatched move is restored
 * best-effort and reported as ESTALE without being deleted.
 *
 * Portable Node exposes pathname-based rename/unlink/rmdir, not an openat-style
 * identity-bound operation. Random owner-only quarantine names plus exact
 * dev/ino/type checks immediately before and after every pathname mutation
 * bound that portability gap, but cannot provide within-syscall exclusion
 * against a malicious ABA rename. Do not weaken either side of that fence.
 */
export async function removeTree(root: string, options: RemoveTreeOptions = {}): Promise<void> {
	const treeFs = options.fs ?? realAsyncTreeFs;
	const rename = treeFs.rename?.bind(treeFs);
	const force = options.force ?? true;
	const preserveRoot = options.preserveRoot ?? false;
	const absoluteRoot = path.resolve(root);
	const quarantinePaths = new Set<string>();
	let stepsSinceYield = 0;

	const lstatIfPresent = async (
		filePath: string,
		allowMissing: boolean,
	): Promise<AsyncTreeStats | undefined> => {
		try { return await treeFs.lstat(filePath); }
		catch (error) {
			if (allowMissing && isMissing(error)) return undefined;
			throw error;
		}
	};

	const assertExactIdentity = (
		expected: AsyncTreeStats,
		current: AsyncTreeStats,
		filePath: string,
	): void => {
		if (!hasStableFileIdentity(expected)
			|| !hasStableFileIdentity(current)
			|| !sameFileIdentity(expected, current)
			|| entryKind(expected) !== entryKind(current)) {
			throw staleDirectoryError(filePath);
		}
	};

	const assertClaimCurrent = async (claim: RemovalClaim | undefined): Promise<boolean> => {
		if (!claim) return true;
		const claims = new Set<RemovalClaim>();
		if (claim.rootClaim) claims.add(claim.rootClaim);
		if (claim.parent) claims.add(claim.parent);
		claims.add(claim);
		for (const currentClaim of claims) {
			const current = await lstatIfPresent(currentClaim.absolutePath, force);
			if (current === undefined) return false;
			assertExactIdentity(currentClaim.authorizedStats, current, currentClaim.absolutePath);
		}
		return true;
	};

	const makeQuarantinePath = async (originalPath: string): Promise<string> => {
		for (let attempt = 0; attempt < 8; attempt++) {
			const candidate = path.join(path.dirname(originalPath), `.bobbit-remove-${randomUUID()}`);
			if (await lstatIfPresent(candidate, true) !== undefined) continue;
			quarantinePaths.add(candidate);
			return candidate;
		}
		throw new Error(`Could not allocate removal quarantine beside ${originalPath}`);
	};

	const errorQuarantinePath = (error: unknown): string | undefined => {
		if ((typeof error !== "object" && typeof error !== "function") || error === null) return undefined;
		const candidate = (error as { quarantinePath?: unknown }).quarantinePath;
		return typeof candidate === "string" ? candidate : undefined;
	};

	const attachQuarantineContext = (error: unknown, quarantinePath: string): void => {
		if ((typeof error !== "object" && typeof error !== "function") || error === null) {
			console.error(`[bounded-async-work] failed cleanup preserved quarantine at ${quarantinePath}`, error);
			return;
		}
		try {
			Object.defineProperty(error, "quarantinePath", {
				value: quarantinePath,
				writable: true,
				configurable: true,
				enumerable: true,
			});
		} catch {
			console.error(`[bounded-async-work] failed cleanup preserved quarantine at ${quarantinePath}`, error);
		}
	};

	const relocateQuarantineContext = (error: unknown, from: string, to: string): void => {
		const current = errorQuarantinePath(error);
		if (!current) return;
		const relative = path.relative(from, current);
		if (relative === "") {
			try { delete (error as { quarantinePath?: string }).quarantinePath; } catch { /* diagnostic only */ }
			return;
		}
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
		attachQuarantineContext(error, path.join(to, relative));
	};

	type RestoreOutcome = "restored" | "removed" | "unsafe";

	/**
	 * Restore one exact remaining quarantine identity without overwriting the
	 * original pathname. All authorization comes from the parent claim captured
	 * before detach; a replacement parent is never accepted after the fact.
	 */
	const restoreExactQuarantine = async (
		originalPath: string,
		quarantinePath: string,
		expectedStats: AsyncTreeStats,
		parentClaim: RemovalClaim | undefined,
	): Promise<RestoreOutcome> => {
		if (!hasStableFileIdentity(expectedStats)) return "unsafe";
		let renameIssued = false;
		try {
			if (!await assertClaimCurrent(parentClaim)) return "unsafe";
			const current = await lstatIfPresent(quarantinePath, true);
			if (current === undefined) return "removed";
			assertExactIdentity(expectedStats, current, quarantinePath);
			// Node rename replaces an existing destination on POSIX. The explicit
			// absence checks are therefore mandatory even though the random source
			// name and pre/post identity checks cannot emulate renameat2(RENAME_NOREPLACE).
			if (await lstatIfPresent(originalPath, true) !== undefined) return "unsafe";
			if (!await assertClaimCurrent(parentClaim)) return "unsafe";
			const beforeRestore = await lstatIfPresent(quarantinePath, true);
			if (beforeRestore === undefined) return "removed";
			assertExactIdentity(expectedStats, beforeRestore, quarantinePath);
			renameIssued = true;
			await rename(quarantinePath, originalPath);
			const restored = await lstatIfPresent(originalPath, true);
			if (restored === undefined) return "unsafe";
			assertExactIdentity(expectedStats, restored, originalPath);
			if (await lstatIfPresent(quarantinePath, true) !== undefined) return "unsafe";
			if (!await assertClaimCurrent(parentClaim)) return "unsafe";
			return "restored";
		} catch {
			// A test double or filesystem wrapper may complete rename and then reject.
			// Accept that restoration only after the same full post-identity fence.
			if (renameIssued) {
				try {
					const restored = await lstatIfPresent(originalPath, true);
					if (restored !== undefined) assertExactIdentity(expectedStats, restored, originalPath);
					if (restored !== undefined
						&& await lstatIfPresent(quarantinePath, true) === undefined
						&& await assertClaimCurrent(parentClaim)) return "restored";
				} catch { /* unsafe below */ }
			}
			// Restoration is deliberately best-effort. Never follow up with removal:
			// the pathname may now name a different identity.
			return "unsafe";
		}
	};

	const restoreDetachedAfterFailure = async (
		claim: DetachedRemovalClaim,
		error: unknown,
	): Promise<void> => {
		if (claim.state !== "detached") return;
		const quarantinePath = claim.absolutePath;
		const outcome = await restoreExactQuarantine(
			claim.originalPath,
			quarantinePath,
			claim.authorizedStats,
			claim.parent,
		);
		if (outcome === "restored") {
			claim.state = "restored";
			claim.absolutePath = claim.originalPath;
			relocateQuarantineContext(error, quarantinePath, claim.originalPath);
			return;
		}
		if (outcome === "removed") {
			claim.state = "removed";
			return;
		}
		attachQuarantineContext(error, quarantinePath);
	};

	const detachClaimed = async (claim: RemovalClaim): Promise<DetachedRemovalClaim | undefined> => {
		if (!await assertClaimCurrent(claim)) return undefined;
		const originalPath = claim.absolutePath;
		const quarantinePath = await makeQuarantinePath(originalPath);
		if (!await assertClaimCurrent(claim)) return undefined;
		const detached: DetachedRemovalClaim = {
			absolutePath: quarantinePath,
			originalPath,
			authorizedStats: claim.authorizedStats,
			parent: claim.parent,
			rootClaim: claim.rootClaim,
			state: "detached",
		};
		try {
			await rename(originalPath, quarantinePath);
		} catch (error) {
			// A pathname implementation may complete a move and still reject. Probe
			// only the random quarantine identity and restore it when exact.
			let moved: AsyncTreeStats | undefined;
			try { moved = await lstatIfPresent(quarantinePath, true); }
			catch { attachQuarantineContext(error, quarantinePath); throw error; }
			if (moved !== undefined) {
				let expected = claim.authorizedStats;
				try { assertExactIdentity(expected, moved, quarantinePath); }
				catch { expected = moved; }
				const outcome = await restoreExactQuarantine(originalPath, quarantinePath, expected, claim.parent);
				if (outcome === "unsafe") attachQuarantineContext(error, quarantinePath);
				else if (outcome === "restored") detached.state = "restored";
				else detached.state = "removed";
			}
			if (force && isMissing(error) && moved === undefined) return undefined;
			throw error;
		}

		let movedStats: AsyncTreeStats;
		try {
			const moved = await lstatIfPresent(quarantinePath, true);
			if (moved === undefined) throw staleDirectoryError(originalPath);
			movedStats = moved;
		} catch (error) {
			await restoreDetachedAfterFailure(detached, error);
			throw error;
		}
		try {
			assertExactIdentity(claim.authorizedStats, movedStats, quarantinePath);
		} catch {
			const stale = staleDirectoryError(originalPath);
			const outcome = await restoreExactQuarantine(
				originalPath,
				quarantinePath,
				movedStats,
				claim.parent,
			);
			if (outcome === "unsafe") attachQuarantineContext(stale, quarantinePath);
			throw stale;
		}
		try {
			if (!await assertClaimCurrent(claim.parent)) throw staleDirectoryError(originalPath);
			if (!await assertClaimCurrent(detached)) throw staleDirectoryError(originalPath);
		} catch (error) {
			await restoreDetachedAfterFailure(detached, error);
			throw error;
		}
		return detached;
	};

	const unlinkDetached = async (claim: DetachedRemovalClaim): Promise<void> => {
		try {
			if (!await assertClaimCurrent(claim)) return;
			try {
				await treeFs.unlink(claim.absolutePath);
			} catch (error) {
				try {
					const afterError = await lstatIfPresent(claim.absolutePath, true);
					if (afterError === undefined) claim.state = "removed";
					else assertExactIdentity(claim.authorizedStats, afterError, claim.absolutePath);
				} catch { /* preserve the unlink error; restoration revalidates again */ }
				if (!force || !isMissing(error)) throw error;
				return;
			}
			const after = await lstatIfPresent(claim.absolutePath, true);
			if (after !== undefined) throw staleDirectoryError(claim.absolutePath);
			claim.state = "removed";
			await assertClaimCurrent(claim.parent);
		} catch (error) {
			await restoreDetachedAfterFailure(claim, error);
			throw error;
		}
	};

	const rmdirDetached = async (claim: DetachedRemovalClaim): Promise<void> => {
		try {
			if (!await assertClaimCurrent(claim)) return;
			try {
				await treeFs.rmdir(claim.absolutePath);
			} catch (error) {
				try {
					const afterError = await lstatIfPresent(claim.absolutePath, true);
					if (afterError === undefined) claim.state = "removed";
					else assertExactIdentity(claim.authorizedStats, afterError, claim.absolutePath);
				} catch { /* preserve the rmdir error; restoration revalidates again */ }
				if (!force || !isMissing(error)) throw error;
				return;
			}
			const after = await lstatIfPresent(claim.absolutePath, true);
			if (after !== undefined) throw staleDirectoryError(claim.absolutePath);
			claim.state = "removed";
			await assertClaimCurrent(claim.parent);
		} catch (error) {
			await restoreDetachedAfterFailure(claim, error);
			throw error;
		}
	};

	const openClaimedDirectory = async (claim: RemovalClaim): Promise<AsyncTreeDirectory | undefined> => {
		if (!await assertClaimCurrent(claim)) return undefined;
		let directory: AsyncTreeDirectory;
		try {
			directory = await treeFs.opendir(claim.absolutePath);
		} catch (openError) {
			// Preserve the actual opendir failure. A failed ownership recheck is
			// relevant to restoration, but must not replace the public I/O error.
			try { await assertClaimCurrent(claim); } catch { /* preserve openError */ }
			if (force && isMissing(openError)) return undefined;
			throw openError;
		}
		try {
			if (!await assertClaimCurrent(claim)) {
				await directory.close();
				return undefined;
			}
		} catch (error) {
			try { await directory.close(); } catch { /* preserve the identity error */ }
			throw error;
		}
		return directory;
	};

	const isDetachedClaim = (claim: RemovalClaim): claim is DetachedRemovalClaim => (
		"originalPath" in claim && "state" in claim
	);

	const removeClaimedDirectory = async (
		rootClaim: RemovalClaim,
		removeRootAtEnd: boolean,
	): Promise<void> => {
		const frames: RemovalFrame[] = [];
		try {
			const rootDirectory = await openClaimedDirectory(rootClaim);
			if (!rootDirectory) return;
			frames.push({ claim: rootClaim, directory: rootDirectory, removeAtEnd: removeRootAtEnd });
			while (frames.length > 0) {
				const frame = frames[frames.length - 1]!;
				const dirent = await frame.directory.read();
				if (!await assertClaimCurrent(frame.claim)) {
					await frame.directory.close();
					frames.pop();
					continue;
				}
				if (!dirent) {
					await frame.directory.close();
					frames.pop();
					if (frame.removeAtEnd && isDetachedClaim(frame.claim)) {
						await rmdirDetached(frame.claim);
					}
				} else {
					const childPath = path.join(frame.claim.absolutePath, dirent.name);
					// Some directory implementations may return a quarantine name that
					// was created and removed after this handle opened. Never treat it as
					// fresh caller-owned work.
					if (quarantinePaths.has(childPath)) continue;
					const childStats = await lstatIfPresent(childPath, force);
					if (childStats === undefined) continue;
					if (!await assertClaimCurrent(frame.claim)) throw staleDirectoryError(frame.claim.absolutePath);
					const childClaim: RemovalClaim = {
						absolutePath: childPath,
						authorizedStats: childStats,
						parent: frame.claim,
						rootClaim: frame.claim.rootClaim ?? frame.claim,
					};
					const detached = await detachClaimed(childClaim);
					if (!detached) continue;
					if (detached.authorizedStats.isDirectory()
						&& !detached.authorizedStats.isSymbolicLink()) {
						try {
							const directory = await openClaimedDirectory(detached);
							if (directory) frames.push({ claim: detached, directory, removeAtEnd: true });
						} catch (error) {
							await restoreDetachedAfterFailure(detached, error);
							throw error;
						}
					} else {
						await unlinkDetached(detached);
					}
				}

				stepsSinceYield++;
				if (stepsSinceYield >= COOPERATIVE_YIELD_INTERVAL) {
					stepsSinceYield = 0;
					await yieldToEventLoop();
				}
			}
		} catch (error) {
			// These are the iterative equivalent of nested catch blocks: restore the
			// deepest failed child first, then each detached parent up to the root.
			const activeClaims = frames.map(frame => frame.claim);
			for (let index = frames.length - 1; index >= 0; index--) {
				try { await frames[index]!.directory.close(); } catch { /* preserve error */ }
			}
			frames.length = 0;
			if (!activeClaims.includes(rootClaim)) activeClaims.unshift(rootClaim);
			for (let index = activeClaims.length - 1; index >= 0; index--) {
				const claim = activeClaims[index]!;
				if (isDetachedClaim(claim)) await restoreDetachedAfterFailure(claim, error);
			}
			throw error;
		} finally {
			for (let index = frames.length - 1; index >= 0; index--) {
				try { await frames[index]!.directory.close(); } catch { /* preserve the removal error */ }
			}
		}
	};

	try {
		const initialRootStats = await lstatIfPresent(absoluteRoot, force);
		if (initialRootStats === undefined) return;
		if (options.expectedRootStats !== undefined) {
			assertExactIdentity(options.expectedRootStats, initialRootStats, absoluteRoot);
		}
		const parentPath = path.dirname(absoluteRoot);
		if (parentPath === absoluteRoot) throw new RangeError("refusing to remove a filesystem root");
		const parentStats = await lstatIfPresent(parentPath, force);
		if (parentStats === undefined) return;
		if (!parentStats.isDirectory()
			|| parentStats.isSymbolicLink()
			|| !hasStableFileIdentity(parentStats)) {
			throw staleDirectoryError(parentPath);
		}
		const parentClaim: RemovalClaim = {
			absolutePath: parentPath,
			authorizedStats: parentStats,
		};
		const rootClaim: RemovalClaim = {
			absolutePath: absoluteRoot,
			authorizedStats: initialRootStats,
			parent: parentClaim,
			rootClaim: parentClaim,
		};
		if (!await assertClaimCurrent(rootClaim)) return;

		if (!initialRootStats.isDirectory() || initialRootStats.isSymbolicLink()) {
			const detached = await detachClaimed(rootClaim);
			if (detached) await unlinkDetached(detached);
			return;
		}
		if (preserveRoot) {
			await removeClaimedDirectory(rootClaim, false);
			return;
		}
		const detachedRoot = await detachClaimed(rootClaim);
		if (detachedRoot) await removeClaimedDirectory(detachedRoot, true);
	} catch (error) {
		const quarantinePath = errorQuarantinePath(error);
		if (quarantinePath) {
			console.error(`[bounded-async-work] cleanup failed; quarantine remains at ${quarantinePath}`, error);
		}
		throw error;
	}
}
