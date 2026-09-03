import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
	buildStatusTreeModel,
	classifyFileBytes,
	DIFF_BYTE_LIMIT,
	ExplorerParseError,
	ExplorerPathError,
	FS_TIMEOUT_MS,
	GIT_TIMEOUT_MS,
	joinRelativePath,
	LIST_ENTRY_LIMIT,
	mergeCopyProvenance,
	normalizeRelativePath,
	normalizeRepoPrefix,
	parsePorcelainStatus,
	parseStagedNameStatus,
	READ_BYTE_LIMIT,
	SEARCH_CONCURRENCY_LIMIT,
	SEARCH_DEPTH_LIMIT,
	SEARCH_DIRECTORY_LIMIT,
	SEARCH_ENTRY_LIMIT,
	SEARCH_QUERY_LIMIT,
	SEARCH_RESULT_LIMIT,
	SEARCH_TIMEOUT_MS,
	sortExplorerEntries,
	sortExplorerPaths,
	stableLowercase,
	STATUS_BYTE_LIMIT,
	STATUS_RECORD_LIMIT,
	synthesizeAddedDiff,
	type ExplorerEntry,
	type ExplorerEntryKind,
	type ExplorerFileStatus,
	type FileContent,
	type StatusTreeModel,
} from "./explorer-model.js";

export type ExplorerErrorCode =
	| "INVALID_PATH"
	| "INVALID_QUERY"
	| "NOT_FOUND"
	| "NOT_DIRECTORY"
	| "NOT_FILE"
	| "UNSUPPORTED_FILE"
	| "READ_FAILED"
	| "SEARCH_FAILED"
	| "FS_TIMEOUT"
	| "PATH_CHANGED"
	| "OUTSIDE_ROOT"
	| "GIT_TIMEOUT"
	| "GIT_FAILED";

export type RouteResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: ExplorerErrorCode; message: string; retryable: boolean } };

export type GitSnapshot =
	| { kind: "none" }
	| ({ kind: "git"; head: "present" | "unborn" } & StatusTreeModel)
	| { kind: "unavailable"; error: { code: "GIT_TIMEOUT" | "GIT_FAILED"; message: string; retryable: boolean } };

export interface ListValue {
	path: string;
	rootPath: string;
	entries: ExplorerEntry[];
	truncated: boolean;
	status?: GitSnapshot;
}

export interface ResolveValue {
	path: string;
	rootPath?: string;
	kind: "root" | ExplorerEntryKind;
	chain: ExplorerEntry[];
}

export type SearchTruncationReason = "result-cap" | "entry-cap" | "directory-cap" | "depth-cap";

export interface SearchValue {
	query: string;
	results: ExplorerEntry[];
	count: number;
	limit: number;
	truncated: boolean;
	truncationReason?: SearchTruncationReason;
}

export type ReadValue = FileContent & { path: string; limit: number };

export type DiffValue =
	| { path: string; kind: "text" | "metadata-only" | "deleted"; text: string; bytes: number; limit: number }
	| { path: string; kind: "empty" | "empty-added"; text: string; bytes: 0; limit: number }
	| { path: string; kind: "binary"; bytes: number; limit: number }
	| { path: string; kind: "too-large"; bytes: number; limit: number };

export interface DirectoryEntryLike {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

export interface DirectoryHandleLike {
	read(): Promise<DirectoryEntryLike | null>;
	close(): Promise<void>;
}

export interface FileHandleLike {
	read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
	stat(): Promise<StatLike>;
	close(): Promise<void>;
}

export interface StatLike {
	size: number;
	dev?: number | bigint;
	ino?: number | bigint;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

export interface ExplorerFsAdapter {
	opendir(filePath: string): Promise<DirectoryHandleLike>;
	open(filePath: string, flags: string | number): Promise<FileHandleLike>;
	lstat(filePath: string): Promise<StatLike>;
	realpath(filePath: string): Promise<string>;
}

export type BoundedGitResult =
	| { ok: true; stdout: Buffer; stderr: Buffer }
	| { ok: false; reason: "exit" | "spawn" | "timeout" | "too-large"; stdout: Buffer; stderr: Buffer; code?: number | null; errorCode?: string };

export interface GitRunOptions {
	cwd: string;
	timeoutMs: number;
	maxStdoutBytes: number;
	maxStderrBytes?: number;
}

export interface ExplorerGitRunner {
	run(args: readonly string[], options: GitRunOptions): Promise<BoundedGitResult>;
}

export interface ExplorerDependencies {
	fs: ExplorerFsAdapter;
	git: ExplorerGitRunner;
	fsTimeoutMs: number;
	searchTimeoutMs: number;
	gitTimeoutMs: number;
	now: () => number;
}

type SnapshotStoreReadResult<T> =
	| { state: "absent" }
	| { state: "present"; value: T }
	| { state: "error" };

interface SnapshotStore {
	read<T = unknown>(key: string): Promise<SnapshotStoreReadResult<T>>;
	put<T = unknown>(key: string, value: T): Promise<void>;
}

const snapshotStoreMutationTails = new WeakMap<SnapshotStore, Promise<void>>();

async function serializeSnapshotStoreMutation(store: SnapshotStore, operation: () => Promise<void>): Promise<void> {
	const previous = snapshotStoreMutationTails.get(store) ?? Promise.resolve();
	const result = previous.then(operation);
	const settled = result.then(() => undefined, () => undefined);
	snapshotStoreMutationTails.set(store, settled);
	try {
		await result;
	} finally {
		if (snapshotStoreMutationTails.get(store) === settled) snapshotStoreMutationTails.delete(store);
	}
}

interface RouteContext {
	workingDir?: string;
	sessionId?: string;
	host?: {
		capabilities?: { store?: boolean };
		store?: SnapshotStore;
	};
}

interface RouteRequest {
	body?: unknown;
}

class FsDeadlineError extends Error {
	constructor() {
		super("filesystem operation timed out");
		this.name = "FsDeadlineError";
	}
}

class FsDeadline {
	private readonly expiresAt: number;
	constructor(timeoutMs: number) {
		this.expiresAt = Date.now() + timeoutMs;
	}

	async call<T>(operation: Promise<T>, onLateValue?: (value: T) => void): Promise<T> {
		const remaining = this.expiresAt - Date.now();
		if (remaining <= 0) {
			if (onLateValue) void operation.then(onLateValue, () => undefined);
			else void operation.catch(() => undefined);
			throw new FsDeadlineError();
		}
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				reject(new FsDeadlineError());
			}, remaining);
		});
		void operation.then((value) => {
			if (timedOut) onLateValue?.(value);
		}, () => undefined);
		try {
			return await Promise.race([operation, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

const nodeFsAdapter: ExplorerFsAdapter = {
	opendir: (filePath) => fs.opendir(filePath),
	open: (filePath, flags) => fs.open(filePath, flags),
	lstat: (filePath) => fs.lstat(filePath),
	realpath: (filePath) => fs.realpath(filePath),
};

const SAFE_STDERR_LIMIT = 16 * 1024;
const REV_PARSE_LIMIT = 64 * 1024;
const GIT_SNAPSHOT_CACHE_KEY = "file-explorer:git-snapshots:v1";
export const GIT_SNAPSHOT_CACHE_TTL_MS = 15_000;
export const GIT_SNAPSHOT_CACHE_ENTRY_LIMIT = 4;
export const GIT_SNAPSHOT_CACHE_BYTE_LIMIT = 3_750_000;

type ReusableGitSnapshot = Exclude<GitSnapshot, { kind: "unavailable" }>;

interface GitSnapshotCacheEntry {
	sessionId: string;
	rootPath: string;
	generation: number;
	expiresAt: number;
	snapshot: ReusableGitSnapshot;
}

interface GitSnapshotCacheRecord {
	version: 1;
	entries: GitSnapshotCacheEntry[];
}

export const nodeGitRunner: ExplorerGitRunner = {
	run: runBoundedGit,
};

export function runBoundedGit(args: readonly string[], options: GitRunOptions): Promise<BoundedGitResult> {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn("git", [...args], { cwd: options.cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ ok: false, reason: "spawn", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), errorCode: errno(error) });
			return;
		}
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let failure: "timeout" | "too-large" | undefined;
		let settled = false;
		const kill = () => {
			try { child.kill("SIGKILL"); } catch { /* child may already be gone */ }
		};
		const timer = setTimeout(() => {
			failure = "timeout";
			kill();
		}, options.timeoutMs);
		timer.unref?.();
		child.stdout.on("data", (chunk: Buffer | string) => {
			if (failure) return;
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			stdoutBytes += buffer.length;
			if (stdoutBytes > options.maxStdoutBytes) {
				failure = "too-large";
				kill();
				return;
			}
			stdoutChunks.push(buffer);
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			const remaining = Math.max(0, (options.maxStderrBytes ?? SAFE_STDERR_LIMIT) - stderrBytes);
			if (remaining > 0) stderrChunks.push(buffer.subarray(0, remaining));
			stderrBytes += buffer.length;
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok: false, reason: "spawn", stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks), errorCode: errno(error) });
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const stdout = Buffer.concat(stdoutChunks);
			const stderr = Buffer.concat(stderrChunks);
			if (failure) resolve({ ok: false, reason: failure, stdout, stderr, code });
			else if (code === 0) resolve({ ok: true, stdout, stderr });
			else resolve({ ok: false, reason: "exit", stdout, stderr, code });
		});
	});
}

function failure<T>(code: ExplorerErrorCode, message: string, retryable = false): RouteResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function bodyRecord(req: RouteRequest): Record<string, unknown> {
	return req?.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
}

function isGitMetadataSegment(segment: string): boolean {
	return process.platform === "win32" || process.platform === "darwin"
		? segment.toLowerCase() === ".git"
		: segment === ".git";
}

/** Route-boundary exclusion for repository internals. This intentionally stays
 * separate from the generic relative-path parser used for Git output. */
function normalizeRoutePath(value: unknown, options: { allowRoot?: boolean } = {}): string {
	const relativePath = normalizeRelativePath(value, options);
	if (relativePath !== "" && relativePath.split("/").some(isGitMetadataSegment)) throw new ExplorerPathError();
	return relativePath;
}

class RootedFsError extends Error {
	constructor(readonly code: "PATH_CHANGED" | "OUTSIDE_ROOT", message: string) {
		super(message);
		this.name = "RootedFsError";
	}
}

function routeCwd(ctx: RouteContext): string {
	if (typeof ctx?.workingDir !== "string" || ctx.workingDir.length === 0) throw new ExplorerPathError();
	return ctx.workingDir;
}

function routeRoot(ctx: RouteContext, body: Record<string, unknown>): string {
	if (body.rootPath === undefined) return routeCwd(ctx);
	if (typeof body.rootPath !== "string" || !path.isAbsolute(body.rootPath) || body.rootPath.includes("\0")) throw new ExplorerPathError("The explorer root must be an absolute path.");
	return path.resolve(body.rootPath);
}

function absolutePath(cwd: string, relativePath: string): string {
	return relativePath ? path.join(cwd, ...relativePath.split("/")) : cwd;
}

interface PathClaim {
	absolutePath: string;
	stats: StatLike;
	parent?: PathClaim;
	root: PathClaim;
}

function identityOf(stats: StatLike): string | undefined {
	if (stats.dev === undefined || stats.ino === undefined || String(stats.ino) === "0") return undefined;
	return `${String(stats.dev)}:${String(stats.ino)}`;
}

function sameIdentity(left: StatLike, right: StatLike): boolean {
	const identity = identityOf(left);
	return identity !== undefined && identity === identityOf(right);
}

function sameKind(left: StatLike, right: StatLike): boolean {
	return statKind(left) === statKind(right);
}

function requireStableIdentity(stats: StatLike): void {
	if (identityOf(stats) === undefined) throw new RootedFsError("PATH_CHANGED", "stable filesystem identity is unavailable");
}

function isContainedPath(candidate: string, root: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSameCanonicalPath(left: string, right: string): boolean {
	return path.relative(path.resolve(left), path.resolve(right)) === "";
}

// Some supported filesystems report zero or unavailable identity for their root.
// Only that root may use the exact-canonical-path fallback; descendants and
// opened file descriptors still require stable identity.
function matchesClaim(claim: PathClaim, stats: StatLike): boolean {
	if (!sameKind(claim.stats, stats)) return false;
	return identityOf(claim.stats) === undefined
		? claim === claim.root
		: sameIdentity(claim.stats, stats);
}

async function currentStats(claim: PathClaim, deadline: FsDeadline, deps: ExplorerDependencies): Promise<StatLike> {
	const stats = await deadline.call(deps.fs.lstat(claim.absolutePath));
	if (!matchesClaim(claim, stats)) {
		throw new RootedFsError("PATH_CHANGED", "filesystem identity changed during the operation");
	}
	if (identityOf(claim.stats) === undefined) {
		const canonical = await deadline.call(deps.fs.realpath(claim.absolutePath));
		if (!isContainedPath(canonical, claim.root.absolutePath)) {
			throw new RootedFsError("OUTSIDE_ROOT", "filesystem path escaped the session root");
		}
		if (!isSameCanonicalPath(canonical, claim.absolutePath)) {
			throw new RootedFsError("PATH_CHANGED", "canonical filesystem path changed during the operation");
		}
	}
	return stats;
}

async function assertClaimCurrent(claim: PathClaim | undefined, deadline: FsDeadline, deps: ExplorerDependencies): Promise<void> {
	if (!claim) return;
	const claims = new Set<PathClaim>([claim.root]);
	if (claim.parent) claims.add(claim.parent);
	claims.add(claim);
	for (const current of claims) await currentStats(current, deadline, deps);
}

async function assertCanonicalClaim(claim: PathClaim, deadline: FsDeadline, deps: ExplorerDependencies): Promise<void> {
	const canonical = await deadline.call(deps.fs.realpath(claim.absolutePath));
	if (!isContainedPath(canonical, claim.root.absolutePath)) {
		throw new RootedFsError("OUTSIDE_ROOT", "filesystem path escaped the session root");
	}
	if (claim === claim.root && !isSameCanonicalPath(canonical, claim.absolutePath)) {
		throw new RootedFsError("PATH_CHANGED", "canonical session root changed during the operation");
	}
	const canonicalStats = await deadline.call(deps.fs.lstat(canonical));
	if (!matchesClaim(claim, canonicalStats)) {
		throw new RootedFsError("PATH_CHANGED", "canonical filesystem identity changed during the operation");
	}
	await assertClaimCurrent(claim, deadline, deps);
}

async function bindRoot(cwd: string, deadline: FsDeadline, deps: ExplorerDependencies): Promise<PathClaim> {
	const canonical = await deadline.call(deps.fs.realpath(path.resolve(cwd)));
	const stats = await deadline.call(deps.fs.lstat(canonical));
	if (!stats.isDirectory() || stats.isSymbolicLink()) throw new RootedFsError("OUTSIDE_ROOT", "session root is not a real directory");
	const root = { absolutePath: canonical, stats } as PathClaim;
	root.root = root;
	await assertClaimCurrent(root, deadline, deps);
	return root;
}

async function claimPath(
	parent: PathClaim,
	relativePath: string,
	deadline: FsDeadline,
	deps: ExplorerDependencies,
	options: { canonicalizeFiles?: boolean } = {},
): Promise<PathClaim> {
	await assertClaimCurrent(parent, deadline, deps);
	const absolute = absolutePath(parent.root.absolutePath, relativePath);
	const stats = await deadline.call(deps.fs.lstat(absolute));
	requireStableIdentity(stats);
	await assertClaimCurrent(parent, deadline, deps);
	const claim: PathClaim = { absolutePath: absolute, stats, parent, root: parent.root };
	if (stats.isDirectory() || (stats.isFile() && options.canonicalizeFiles !== false)) await assertCanonicalClaim(claim, deadline, deps);
	else await assertClaimCurrent(claim, deadline, deps);
	return claim;
}

async function claimRelativePath(root: PathClaim, relativePath: string, deadline: FsDeadline, deps: ExplorerDependencies): Promise<PathClaim[]> {
	if (relativePath === "") return [];
	const segments = relativePath.split("/");
	const claims: PathClaim[] = [];
	let parent = root;
	for (let index = 0; index < segments.length; index++) {
		const entryPath = segments.slice(0, index + 1).join("/");
		const claim = await claimPath(parent, entryPath, deadline, deps);
		claims.push(claim);
		if (index < segments.length - 1 && !claim.stats.isDirectory()) {
			throw Object.assign(new Error("parent path is not a directory"), { code: "ENOTDIR" });
		}
		parent = claim;
	}
	return claims;
}

function errno(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
		? (error as { code: string }).code
		: undefined;
}

function fsFailure<T>(error: unknown, operation: "list" | "read"): RouteResult<T> {
	if (error instanceof ExplorerPathError) return failure("INVALID_PATH", error.message);
	if (error instanceof FsDeadlineError) return failure("FS_TIMEOUT", "The filesystem operation timed out.", true);
	if (error instanceof RootedFsError) return error.code === "OUTSIDE_ROOT"
		? failure("OUTSIDE_ROOT", "The requested path is outside the session files.")
		: failure("PATH_CHANGED", "Session files changed during the operation. Try again.", true);
	const code = errno(error);
	if (code === "ENOENT" || code === "ENOTDIR") return failure(code === "ENOTDIR" && operation === "list" ? "NOT_DIRECTORY" : "NOT_FOUND", "The requested path was not found.");
	if (code === "EISDIR") return failure(operation === "list" ? "NOT_DIRECTORY" : "NOT_FILE", "The requested path is not a regular file.");
	return failure("READ_FAILED", operation === "list" ? "The directory could not be read." : "The file could not be read.", code === "EBUSY" || code === "EMFILE" || code === "ENFILE");
}

function resolveFailure<T>(error: unknown): RouteResult<T> {
	if (errno(error) === "ENOTDIR") return failure("NOT_DIRECTORY", "A parent path is not a directory.");
	return fsFailure(error, "read");
}

class ExplorerSearchQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExplorerSearchQueryError";
	}
}

function searchFailure<T>(error: unknown): RouteResult<T> {
	if (error instanceof ExplorerSearchQueryError) return failure("INVALID_QUERY", error.message);
	if (error instanceof ExplorerPathError) return failure("INVALID_PATH", error.message);
	if (error instanceof FsDeadlineError) return failure("FS_TIMEOUT", "The search operation timed out.", true);
	if (error instanceof RootedFsError) return error.code === "OUTSIDE_ROOT"
		? failure("OUTSIDE_ROOT", "The requested path is outside the session files.")
		: failure("PATH_CHANGED", "Session files changed during the operation. Try again.", true);
	return failure("SEARCH_FAILED", "Session files could not be searched.", true);
}

function entryKind(entry: DirectoryEntryLike): ExplorerEntryKind {
	if (entry.isDirectory()) return "directory";
	if (entry.isFile()) return "file";
	if (entry.isSymbolicLink()) return "symlink";
	return "other";
}

async function closeLate(handle: { close(): Promise<void> }): Promise<void> {
	await handle.close().catch(() => undefined);
}

function makeHandleCloser(handle: { close(): Promise<void> }): () => Promise<void> {
	let closed = false;
	let inFlight: Promise<void> | undefined;
	return async () => {
		if (closed) return;
		if (inFlight) {
			await inFlight;
			if (closed) return;
		}
		const operation = handle.close();
		const observed = operation.then(() => { closed = true; }, () => undefined);
		inFlight = observed;
		try {
			await operation;
		} finally {
			if (inFlight === observed) inFlight = undefined;
		}
	};
}

async function openClaimedDirectory(claim: PathClaim, deadline: FsDeadline, deps: ExplorerDependencies): Promise<{ handle: DirectoryHandleLike; close: () => Promise<void> }> {
	await assertClaimCurrent(claim, deadline, deps);
	let handle: DirectoryHandleLike;
	try {
		handle = await deadline.call(deps.fs.opendir(claim.absolutePath), (late) => { void closeLate(late); });
	} catch (operationError) {
		// Prefer the safe identity failure when a namespace swap caused open to fail.
		await assertClaimCurrent(claim, deadline, deps);
		throw operationError;
	}
	const close = makeHandleCloser(handle);
	try {
		await assertCanonicalClaim(claim, deadline, deps);
	} catch (error) {
		await close();
		throw error;
	}
	return { handle, close };
}

async function listDirectory(cwd: string, relativePath: string, deps: ExplorerDependencies): Promise<{ root: PathClaim; entries: ExplorerEntry[]; truncated: boolean }> {
	const deadline = new FsDeadline(deps.fsTimeoutMs);
	const root = await bindRoot(cwd, deadline, deps);
	const claims = await claimRelativePath(root, relativePath, deadline, deps);
	const directory = claims.at(-1) ?? root;
	if (!directory.stats.isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
	let closeHandle: (() => Promise<void>) | undefined;
	try {
		const opened = await openClaimedDirectory(directory, deadline, deps);
		closeHandle = opened.close;
		const entries: ExplorerEntry[] = [];
		let truncated = false;
		while (true) {
			await assertClaimCurrent(directory, deadline, deps);
			const entry = await deadline.call(opened.handle.read(), () => { void closeHandle?.().catch(() => undefined); });
			await assertClaimCurrent(directory, deadline, deps);
			if (!entry) break;
			if (isGitMetadataSegment(entry.name)) continue;
			let entryPath: string;
			try { entryPath = joinRelativePath(relativePath, entry.name); }
			catch { continue; }
			if (entries.length === LIST_ENTRY_LIMIT) {
				truncated = true;
				break;
			}
			entries.push({ path: entryPath, name: entry.name, kind: entryKind(entry) });
		}
		return { root, entries: sortExplorerEntries(entries), truncated };
	} finally {
		if (closeHandle) await deadline.call(closeHandle());
	}
}

function statKind(stat: StatLike): ExplorerEntryKind {
	if (stat.isDirectory()) return "directory";
	if (stat.isFile()) return "file";
	if (stat.isSymbolicLink()) return "symlink";
	return "other";
}

async function resolvePath(cwd: string, relativePath: string, deps: ExplorerDependencies): Promise<ResolveValue> {
	const deadline = new FsDeadline(deps.fsTimeoutMs);
	const root = await bindRoot(cwd, deadline, deps);
	if (relativePath === "") return { path: "", rootPath: root.absolutePath, kind: "root", chain: [] };
	const claims = await claimRelativePath(root, relativePath, deadline, deps);
	const segments = relativePath.split("/");
	const chain = claims.map((claim, index): ExplorerEntry => ({
		path: segments.slice(0, index + 1).join("/"),
		name: segments[index],
		kind: statKind(claim.stats),
	}));
	return { path: relativePath, rootPath: root.absolutePath, kind: chain.at(-1)!.kind, chain };
}

async function resolveAbsolutePath(absolute: string, deps: ExplorerDependencies): Promise<ResolveValue> {
	if (!path.isAbsolute(absolute) || absolute.includes("\0")) throw new ExplorerPathError("Enter an absolute filesystem path.");
	const deadline = new FsDeadline(deps.fsTimeoutMs);
	const canonical = await deadline.call(deps.fs.realpath(path.resolve(absolute)));
	const stats = await deadline.call(deps.fs.lstat(canonical));
	if (stats.isDirectory() && !stats.isSymbolicLink()) {
		const root = await bindRoot(canonical, deadline, deps);
		return { path: "", rootPath: root.absolutePath, kind: "root", chain: [] };
	}
	const parent = path.dirname(canonical);
	const relativePath = normalizeRoutePath(path.basename(canonical));
	const resolved = await resolvePath(parent, relativePath, deps);
	return { ...resolved, rootPath: parent };
}

interface PendingSearchDirectory {
	path: string;
	depth: number;
	claim: PathClaim;
}

interface SearchTraversalState {
	inspectedEntries: number;
	matches: ExplorerEntry[];
	stop: boolean;
	truncationReason?: SearchTruncationReason;
}

function markSearchTruncated(state: SearchTraversalState, reason: SearchTruncationReason): void {
	state.truncationReason ??= reason;
}

async function scanSearchDirectory(
	directory: PendingSearchDirectory,
	foldedQuery: string,
	deadline: FsDeadline,
	deps: ExplorerDependencies,
	state: SearchTraversalState,
): Promise<PendingSearchDirectory[]> {
	let closeHandle: (() => Promise<void>) | undefined;
	const children: PendingSearchDirectory[] = [];
	try {
		const opened = await openClaimedDirectory(directory.claim, deadline, deps);
		closeHandle = opened.close;
		while (!state.stop) {
			if (state.inspectedEntries >= SEARCH_ENTRY_LIMIT) {
				markSearchTruncated(state, "entry-cap");
				state.stop = true;
				break;
			}
			state.inspectedEntries++;
			await assertClaimCurrent(directory.claim, deadline, deps);
			const rawEntry = await deadline.call(opened.handle.read(), () => { void closeHandle?.().catch(() => undefined); });
			await assertClaimCurrent(directory.claim, deadline, deps);
			if (!rawEntry) {
				state.inspectedEntries--;
				break;
			}
			if (isGitMetadataSegment(rawEntry.name)) continue;
			let entryPath: string;
			try { entryPath = joinRelativePath(directory.path, rawEntry.name); }
			catch { continue; }
			// Dirent kinds are only hints. Bind every candidate to a fresh lstat
			// before reporting or queueing it, then retain that claim until scan.
			const childClaim = await claimPath(directory.claim, entryPath, deadline, deps, { canonicalizeFiles: false });
			const kind = statKind(childClaim.stats);
			const explorerEntry: ExplorerEntry = { path: entryPath, name: rawEntry.name, kind };
			if (stableLowercase(entryPath).includes(foldedQuery)) {
				state.matches.push(explorerEntry);
				if (state.matches.length > SEARCH_RESULT_LIMIT) markSearchTruncated(state, "result-cap");
			}
			if (kind === "directory") {
				const childDepth = directory.depth + 1;
				if (childDepth >= SEARCH_DEPTH_LIMIT) markSearchTruncated(state, "depth-cap");
				else children.push({ path: entryPath, depth: childDepth, claim: childClaim });
			}
		}
		return children;
	} finally {
		if (closeHandle) await deadline.call(closeHandle());
	}
}

async function searchFiles(cwd: string, query: string, deps: ExplorerDependencies): Promise<SearchValue> {
	const foldedQuery = stableLowercase(query);
	const deadline = new FsDeadline(deps.searchTimeoutMs);
	const root = await bindRoot(cwd, deadline, deps);
	const state: SearchTraversalState = { inspectedEntries: 0, matches: [], stop: false };
	const queue: PendingSearchDirectory[] = [{ path: "", depth: 0, claim: root }];
	let cursor = 0;
	let claimedDirectories = 1;
	while (cursor < queue.length && !state.stop) {
		const depth = queue[cursor].depth;
		const batch: PendingSearchDirectory[] = [];
		while (cursor < queue.length && queue[cursor].depth === depth && batch.length < SEARCH_CONCURRENCY_LIMIT) {
			batch.push(queue[cursor++]);
		}
		const settled = await Promise.allSettled(batch.map((directory) =>
			scanSearchDirectory(directory, foldedQuery, deadline, deps, state),
		));
		const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
		if (rejected) throw rejected.reason;
		if (state.stop) break;
		for (const result of settled) {
			if (result.status !== "fulfilled") continue;
			for (const child of result.value) {
				if (claimedDirectories >= SEARCH_DIRECTORY_LIMIT) {
					markSearchTruncated(state, "directory-cap");
					continue;
				}
				claimedDirectories++;
				queue.push(child);
			}
		}
	}
	const results = sortExplorerPaths(state.matches).slice(0, SEARCH_RESULT_LIMIT);
	return {
		query,
		results,
		count: results.length,
		limit: SEARCH_RESULT_LIMIT,
		truncated: state.truncationReason !== undefined,
		...(state.truncationReason ? { truncationReason: state.truncationReason } : {}),
	};
}

function gitFailureSnapshot(result: BoundedGitResult): Extract<GitSnapshot, { kind: "unavailable" }> {
	if (!result.ok && result.reason === "timeout") {
		return { kind: "unavailable", error: { code: "GIT_TIMEOUT", message: "Git status timed out.", retryable: true } };
	}
	return { kind: "unavailable", error: { code: "GIT_FAILED", message: "Git status is unavailable.", retryable: false } };
}

function isNotRepository(result: BoundedGitResult): boolean {
	if (!result.ok && result.reason === "spawn") return result.errorCode === undefined || result.errorCode === "ENOENT";
	if (result.ok) return false;
	const message = result.stderr.toString("utf8").toLowerCase();
	return message.includes("not a git repository") || message.includes("not a git directory");
}

function decodeGitOutput(buffer: Buffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		throw new ExplorerParseError("Git returned non-UTF-8 path data.");
	}
}

export async function collectGitSnapshot(cwd: string, git: ExplorerGitRunner, timeoutMs = GIT_TIMEOUT_MS): Promise<GitSnapshot> {
	const common = { cwd, timeoutMs, maxStderrBytes: SAFE_STDERR_LIMIT };
	const prefixResult = await git.run(["rev-parse", "--show-prefix"], { ...common, maxStdoutBytes: REV_PARSE_LIMIT });
	if (!prefixResult.ok) return isNotRepository(prefixResult) ? { kind: "none" } : gitFailureSnapshot(prefixResult);
	let repoPrefix: string;
	try { repoPrefix = normalizeRepoPrefix(decodeGitOutput(prefixResult.stdout).replace(/[\r\n]+$/, "")); }
	catch { return { kind: "unavailable", error: { code: "GIT_FAILED", message: "Git status is unavailable.", retryable: false } }; }

	const headResult = await git.run(["rev-parse", "--verify", "HEAD"], { ...common, maxStdoutBytes: REV_PARSE_LIMIT });
	if (!headResult.ok && headResult.reason === "timeout") return gitFailureSnapshot(headResult);
	if (!headResult.ok && (headResult.reason === "spawn" || headResult.reason === "too-large")) return gitFailureSnapshot(headResult);
	const head: "present" | "unborn" = headResult.ok ? "present" : "unborn";

	const statusResult = await git.run(
		["-c", "status.renames=copies", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no", "--", "."],
		{ ...common, maxStdoutBytes: STATUS_BYTE_LIMIT },
	);
	if (!statusResult.ok) return gitFailureSnapshot(statusResult);
	try {
		let statuses = parsePorcelainStatus(decodeGitOutput(statusResult.stdout), repoPrefix, STATUS_RECORD_LIMIT);
		if (head === "present") {
			const stagedResult = await git.run(
				["diff", "--cached", "--name-status", "-z", "--find-copies", "--find-copies-harder", "HEAD", "--", "."],
				{ ...common, maxStdoutBytes: STATUS_BYTE_LIMIT },
			);
			if (!stagedResult.ok) return gitFailureSnapshot(stagedResult);
			statuses = mergeCopyProvenance(statuses, parseStagedNameStatus(decodeGitOutput(stagedResult.stdout), repoPrefix, STATUS_RECORD_LIMIT));
		}
		return { kind: "git", head, ...buildStatusTreeModel(statuses) };
	} catch {
		return { kind: "unavailable", error: { code: "GIT_FAILED", message: "Git status is unavailable.", retryable: false } };
	}
}

async function readRegularFile(cwd: string, relativePath: string, limit: number, deps: ExplorerDependencies): Promise<FileContent> {
	const deadline = new FsDeadline(deps.fsTimeoutMs);
	const root = await bindRoot(cwd, deadline, deps);
	const claims = await claimRelativePath(root, relativePath, deadline, deps);
	const target = claims.at(-1)!;
	if (!target.stats.isFile()) {
		if (target.stats.isDirectory()) throw Object.assign(new Error("not a file"), { code: "EISDIR" });
		throw Object.assign(new Error("unsupported file"), { code: "EUNSUPPORTED" });
	}
	let handle: FileHandleLike | undefined;
	let closeHandle: (() => Promise<void>) | undefined;
	try {
		await assertClaimCurrent(target, deadline, deps);
		const noFollow = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW;
		const flags = typeof noFollow === "number" && noFollow !== 0 ? fsConstants.O_RDONLY | noFollow : "r";
		try {
			handle = await deadline.call(deps.fs.open(target.absolutePath, flags), (late) => { void closeLate(late); });
		} catch (operationError) {
			await assertClaimCurrent(target, deadline, deps);
			throw operationError;
		}
		closeHandle = makeHandleCloser(handle);
		const descriptorStats = await deadline.call(handle.stat(), () => { void closeHandle?.().catch(() => undefined); });
		requireStableIdentity(descriptorStats);
		if (!descriptorStats.isFile() || descriptorStats.isSymbolicLink() || !sameIdentity(target.stats, descriptorStats)) {
			throw new RootedFsError("PATH_CHANGED", "opened file identity differs from the authorized target");
		}
		await assertCanonicalClaim(target, deadline, deps);
		const canonical = await deadline.call(deps.fs.realpath(target.absolutePath));
		if (!isContainedPath(canonical, root.absolutePath)) throw new RootedFsError("OUTSIDE_ROOT", "opened file escaped the session root");
		const canonicalStats = await deadline.call(deps.fs.lstat(canonical));
		if (!canonicalStats.isFile() || canonicalStats.isSymbolicLink() || !sameIdentity(descriptorStats, canonicalStats)) {
			throw new RootedFsError("PATH_CHANGED", "canonical file identity differs from the opened target");
		}
		const buffer = new Uint8Array(limit + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await deadline.call(handle.read(buffer, offset, buffer.length - offset, offset), () => { void closeHandle?.().catch(() => undefined); });
			if (bytesRead <= 0) break;
			offset += bytesRead;
		}
		return classifyFileBytes(buffer.subarray(0, offset), Math.max(descriptorStats.size, offset), limit);
	} finally {
		if (closeHandle) await deadline.call(closeHandle());
	}
}

function readFailure<T>(error: unknown): RouteResult<T> {
	if (errno(error) === "EUNSUPPORTED") return failure("UNSUPPORTED_FILE", "This file type cannot be previewed.");
	return fsFailure(error, "read");
}

function statusForPath(snapshot: Extract<GitSnapshot, { kind: "git" }>, relativePath: string): ExplorerFileStatus | undefined {
	return snapshot.files.find((status) => status.path === relativePath);
}

function snapshotGeneration(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function cacheStore(ctx: RouteContext): SnapshotStore | undefined {
	return typeof ctx.sessionId === "string" && ctx.sessionId.length > 0
		&& ctx.host?.capabilities?.store === true
		&& typeof ctx.host.store?.read === "function"
		&& typeof ctx.host.store?.put === "function"
		? ctx.host.store
		: undefined;
}

function canonicalCachedPath(value: unknown, options: { allowRoot?: boolean } = {}): value is string {
	if (typeof value !== "string") return false;
	try { return normalizeRelativePath(value, options) === value; }
	catch { return false; }
}

function reusableSnapshot(value: unknown): value is ReusableGitSnapshot {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as Record<string, unknown>;
	if (snapshot.kind === "none") return true;
	if (snapshot.kind !== "git" || (snapshot.head !== "present" && snapshot.head !== "unborn") || !Array.isArray(snapshot.files)) return false;
	if (snapshot.files.length > STATUS_RECORD_LIMIT) return false;
	return snapshot.files.every((candidate) => {
		if (!candidate || typeof candidate !== "object") return false;
		const status = candidate as Record<string, unknown>;
		return canonicalCachedPath(status.path)
			&& (status.oldPath === undefined || canonicalCachedPath(status.oldPath));
	});
}

function cachedEntries(value: unknown, now: number): GitSnapshotCacheEntry[] {
	if (!value || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || !Array.isArray(record.entries)) return [];
	return record.entries.flatMap((candidate): GitSnapshotCacheEntry[] => {
		if (!candidate || typeof candidate !== "object") return [];
		const entry = candidate as Record<string, unknown>;
		if (typeof entry.sessionId !== "string" || !entry.sessionId
			|| typeof entry.rootPath !== "string" || !path.isAbsolute(entry.rootPath)
			|| snapshotGeneration(entry.generation) === undefined
			|| typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now
			|| !reusableSnapshot(entry.snapshot)) return [];
		return [entry as unknown as GitSnapshotCacheEntry];
	});
}

async function readCachedSnapshot(
	ctx: RouteContext,
	rootPath: string,
	generation: number | undefined,
	deps: ExplorerDependencies,
): Promise<ReusableGitSnapshot | undefined> {
	const store = generation === undefined ? undefined : cacheStore(ctx);
	if (!store) return undefined;
	try {
		const result = await store.read<GitSnapshotCacheRecord>(GIT_SNAPSHOT_CACHE_KEY);
		if (result.state !== "present") return undefined;
		const entries = cachedEntries(result.value, deps.now());
		return entries.find((entry) => entry.sessionId === ctx.sessionId
			&& isSameCanonicalPath(entry.rootPath, rootPath)
			&& entry.generation === generation)?.snapshot;
	} catch {
		return undefined;
	}
}

async function writeCachedSnapshot(
	ctx: RouteContext,
	rootPath: string,
	generation: number | undefined,
	snapshot: GitSnapshot,
	deps: ExplorerDependencies,
): Promise<void> {
	if (generation === undefined || snapshot.kind === "unavailable") return;
	const store = cacheStore(ctx);
	if (!store) return;
	try {
		await serializeSnapshotStoreMutation(store, async () => {
			const now = deps.now();
			const result = await store.read<GitSnapshotCacheRecord>(GIT_SNAPSHOT_CACHE_KEY);
			let entries = result.state === "present" ? cachedEntries(result.value, now) : [];
			const currentGeneration = entries.reduce<number | undefined>((newest, entry) => entry.sessionId === ctx.sessionId
				&& (newest === undefined || entry.generation > newest) ? entry.generation : newest, undefined);
			if (currentGeneration !== undefined && generation < currentGeneration) return;
			// A root listing is the session's authoritative refresh boundary. Drop every
			// older root/generation for that session so replaying an old client generation
			// cannot revive stale status after refresh or root navigation.
			entries = entries.filter((entry) => entry.sessionId !== ctx.sessionId);
			entries.push({ sessionId: ctx.sessionId!, rootPath, generation, expiresAt: now + GIT_SNAPSHOT_CACHE_TTL_MS, snapshot });
			entries = entries.slice(-GIT_SNAPSHOT_CACHE_ENTRY_LIMIT);
			let record: GitSnapshotCacheRecord = { version: 1, entries };
			while (record.entries.length > 0 && Buffer.byteLength(JSON.stringify(record)) > GIT_SNAPSHOT_CACHE_BYTE_LIMIT) {
				record = { version: 1, entries: record.entries.slice(1) };
			}
			if (record.entries.length > 0) await store.put(GIT_SNAPSHOT_CACHE_KEY, record);
		});
	} catch {
		// Snapshot reuse is an optimization. Store errors degrade to a fresh Git read.
	}
}

function gitRouteFailure<T>(snapshot: Extract<GitSnapshot, { kind: "unavailable" }>): RouteResult<T> {
	return failure(snapshot.error.code, snapshot.error.message, snapshot.error.retryable);
}

function diffFromUntracked(pathValue: string, content: FileContent): DiffValue {
	if (content.kind === "too-large") return { path: pathValue, kind: "too-large", bytes: content.bytes, limit: DIFF_BYTE_LIMIT };
	if (content.kind === "binary") return { path: pathValue, kind: "binary", bytes: content.bytes, limit: DIFF_BYTE_LIMIT };
	if (content.kind === "empty") return { path: pathValue, kind: "empty-added", text: synthesizeAddedDiff(pathValue, ""), bytes: 0, limit: DIFF_BYTE_LIMIT };
	const text = synthesizeAddedDiff(pathValue, content.text);
	const bytes = Buffer.byteLength(text);
	if (bytes > DIFF_BYTE_LIMIT) return { path: pathValue, kind: "too-large", bytes, limit: DIFF_BYTE_LIMIT };
	return { path: pathValue, kind: "text", text, bytes, limit: DIFF_BYTE_LIMIT };
}

export function createExplorerRoutes(overrides: Partial<ExplorerDependencies> = {}) {
	const deps: ExplorerDependencies = {
		fs: overrides.fs ?? nodeFsAdapter,
		git: overrides.git ?? nodeGitRunner,
		fsTimeoutMs: overrides.fsTimeoutMs ?? FS_TIMEOUT_MS,
		searchTimeoutMs: overrides.searchTimeoutMs ?? SEARCH_TIMEOUT_MS,
		gitTimeoutMs: overrides.gitTimeoutMs ?? GIT_TIMEOUT_MS,
		now: overrides.now ?? Date.now,
	};
	return {
		list: async (ctx: RouteContext, req: RouteRequest): Promise<RouteResult<ListValue>> => {
			try {
				const body = bodyRecord(req);
				const relativePath = normalizeRoutePath(body.path, { allowRoot: true });
				const cwd = routeRoot(ctx, body);
				const listed = await listDirectory(cwd, relativePath, deps);
				const includeStatus = body.includeStatus === true && relativePath === "";
				const generation = snapshotGeneration(body.snapshotGeneration);
				const status = includeStatus ? await collectGitSnapshot(listed.root.absolutePath, deps.git, deps.gitTimeoutMs) : undefined;
				if (status) {
					await assertClaimCurrent(listed.root, new FsDeadline(deps.fsTimeoutMs), deps);
					await writeCachedSnapshot(ctx, listed.root.absolutePath, generation, status, deps);
				}
				return { ok: true, value: { path: relativePath, rootPath: listed.root.absolutePath, entries: listed.entries, truncated: listed.truncated, ...(status ? { status } : {}) } };
			} catch (error) {
				return fsFailure(error, "list");
			}
		},

		resolve: async (ctx: RouteContext, req: RouteRequest): Promise<RouteResult<ResolveValue>> => {
			try {
				const body = bodyRecord(req);
				if (typeof body.absolutePath === "string") return { ok: true, value: await resolveAbsolutePath(body.absolutePath, deps) };
				const relativePath = normalizeRoutePath(body.path, { allowRoot: true });
				return { ok: true, value: await resolvePath(routeRoot(ctx, body), relativePath, deps) };
			} catch (error) {
				return resolveFailure(error);
			}
		},

		search: async (ctx: RouteContext, req: RouteRequest): Promise<RouteResult<SearchValue>> => {
			try {
				const body = bodyRecord(req);
				const rawQuery = body.query;
				if (typeof rawQuery !== "string") throw new ExplorerSearchQueryError("A search query is required.");
				const query = rawQuery.trim();
				if (!query || query.includes("\0")) throw new ExplorerSearchQueryError("Enter a non-empty search query.");
				if (query.length > SEARCH_QUERY_LIMIT) throw new ExplorerSearchQueryError(`Search queries are limited to ${SEARCH_QUERY_LIMIT} characters.`);
				return { ok: true, value: await searchFiles(routeRoot(ctx, body), query, deps) };
			} catch (error) {
				return searchFailure(error);
			}
		},

		read: async (ctx: RouteContext, req: RouteRequest): Promise<RouteResult<ReadValue>> => {
			try {
				const body = bodyRecord(req);
				const relativePath = normalizeRoutePath(body.path);
				const content = await readRegularFile(routeRoot(ctx, body), relativePath, READ_BYTE_LIMIT, deps);
				return { ok: true, value: { path: relativePath, ...content, limit: READ_BYTE_LIMIT } };
			} catch (error) {
				return readFailure(error);
			}
		},

		diff: async (ctx: RouteContext, req: RouteRequest): Promise<RouteResult<DiffValue>> => {
			let relativePath: string;
			let root: PathClaim;
			try {
				const body = bodyRecord(req);
				relativePath = normalizeRoutePath(body.path);
				root = await bindRoot(routeRoot(ctx, body), new FsDeadline(deps.fsTimeoutMs), deps);
			} catch (error) { return fsFailure(error, "read"); }
			const cwd = root.absolutePath;
			const generation = snapshotGeneration(bodyRecord(req).snapshotGeneration);
			const snapshot = await readCachedSnapshot(ctx, cwd, generation, deps)
				?? await collectGitSnapshot(cwd, deps.git, deps.gitTimeoutMs);
			try { await assertClaimCurrent(root, new FsDeadline(deps.fsTimeoutMs), deps); }
			catch (error) { return fsFailure(error, "read"); }
			if (snapshot.kind === "none") return failure("GIT_FAILED", "A diff is unavailable outside a Git repository.");
			if (snapshot.kind === "unavailable") return gitRouteFailure(snapshot);
			const status = statusForPath(snapshot, relativePath);
			if (snapshot.head === "unborn" || status?.untracked) {
				try { return { ok: true, value: diffFromUntracked(relativePath, await readRegularFile(cwd, relativePath, DIFF_BYTE_LIMIT, deps)) }; }
				catch (error) { return readFailure(error); }
			}
			const pathspecs = status?.oldPath && (status.renamed || status.copied) ? [status.oldPath, relativePath] : [relativePath];
			const result = await deps.git.run(
				["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--find-copies", "--find-copies-harder", "--unified=3", "HEAD", "--", ...pathspecs],
				{ cwd, timeoutMs: deps.gitTimeoutMs, maxStdoutBytes: DIFF_BYTE_LIMIT, maxStderrBytes: SAFE_STDERR_LIMIT },
			);
			try { await assertClaimCurrent(root, new FsDeadline(deps.fsTimeoutMs), deps); }
			catch (error) { return fsFailure(error, "read"); }
			if (!result.ok) {
				if (result.reason === "too-large") return { ok: true, value: { path: relativePath, kind: "too-large", bytes: DIFF_BYTE_LIMIT + 1, limit: DIFF_BYTE_LIMIT } };
				if (result.reason === "timeout") return failure("GIT_TIMEOUT", "The diff operation timed out.", true);
				return failure("GIT_FAILED", "The diff could not be generated.");
			}
			let text: string;
			try { text = decodeGitOutput(result.stdout); }
			catch { return { ok: true, value: { path: relativePath, kind: "binary", bytes: result.stdout.length, limit: DIFF_BYTE_LIMIT } }; }
			const bytes = result.stdout.length;
			if (/^(?:Binary files |GIT binary patch)/m.test(text)) return { ok: true, value: { path: relativePath, kind: "binary", bytes, limit: DIFF_BYTE_LIMIT } };
			if (text.length === 0) return { ok: true, value: { path: relativePath, kind: "empty", text: "", bytes: 0, limit: DIFF_BYTE_LIMIT } };
			if (status?.summary === "deleted") return { ok: true, value: { path: relativePath, kind: "deleted", text, bytes, limit: DIFF_BYTE_LIMIT } };
			const kind = /^@@ /m.test(text) ? "text" as const : "metadata-only" as const;
			return { ok: true, value: { path: relativePath, kind, text, bytes, limit: DIFF_BYTE_LIMIT } };
		},
	};
}

export const routes = createExplorerRoutes();
