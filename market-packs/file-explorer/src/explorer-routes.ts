import { spawn } from "node:child_process";
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
	entries: ExplorerEntry[];
	truncated: boolean;
	status?: GitSnapshot;
}

export interface ResolveValue {
	path: string;
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
	close(): Promise<void>;
}

export interface StatLike {
	size: number;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

export interface ExplorerFsAdapter {
	opendir(filePath: string): Promise<DirectoryHandleLike>;
	open(filePath: string): Promise<FileHandleLike>;
	lstat(filePath: string): Promise<StatLike>;
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
}

interface RouteContext {
	workingDir?: string;
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
	open: (filePath) => fs.open(filePath, "r"),
	lstat: (filePath) => fs.lstat(filePath),
};

const SAFE_STDERR_LIMIT = 16 * 1024;
const REV_PARSE_LIMIT = 64 * 1024;

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

function routeCwd(ctx: RouteContext): string {
	return typeof ctx?.workingDir === "string" && ctx.workingDir.length > 0 ? ctx.workingDir : process.cwd();
}

function absolutePath(cwd: string, relativePath: string): string {
	return relativePath ? path.join(cwd, ...relativePath.split("/")) : cwd;
}

function errno(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
		? (error as { code: string }).code
		: undefined;
}

function fsFailure<T>(error: unknown, operation: "list" | "read"): RouteResult<T> {
	if (error instanceof ExplorerPathError) return failure("INVALID_PATH", error.message);
	if (error instanceof FsDeadlineError) return failure("FS_TIMEOUT", "The filesystem operation timed out.", true);
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
	if (error instanceof FsDeadlineError) return failure("FS_TIMEOUT", "The search operation timed out.", true);
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

async function listDirectory(cwd: string, relativePath: string, deps: ExplorerDependencies): Promise<{ entries: ExplorerEntry[]; truncated: boolean }> {
	const deadline = new FsDeadline(deps.fsTimeoutMs);
	let handle: DirectoryHandleLike | undefined;
	let closeHandle: (() => Promise<void>) | undefined;
	try {
		handle = await deadline.call(deps.fs.opendir(absolutePath(cwd, relativePath)), (late) => { void closeLate(late); });
		closeHandle = makeHandleCloser(handle);
		const entries: ExplorerEntry[] = [];
		let truncated = false;
		while (true) {
			const entry = await deadline.call(handle.read(), () => { void closeHandle?.().catch(() => undefined); });
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
		return { entries: sortExplorerEntries(entries), truncated };
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
	if (relativePath === "") return { path: "", kind: "root", chain: [] };
	const deadline = new FsDeadline(deps.fsTimeoutMs);
	const segments = relativePath.split("/");
	const chain: ExplorerEntry[] = [];
	for (let index = 0; index < segments.length; index++) {
		const entryPath = segments.slice(0, index + 1).join("/");
		const kind = statKind(await deadline.call(deps.fs.lstat(absolutePath(cwd, entryPath))));
		chain.push({ path: entryPath, name: segments[index], kind });
		if (index < segments.length - 1 && kind !== "directory") {
			throw Object.assign(new Error("parent path is not a directory"), { code: "ENOTDIR" });
		}
	}
	return { path: relativePath, kind: chain.at(-1)!.kind, chain };
}

interface PendingSearchDirectory {
	path: string;
	depth: number;
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
	cwd: string,
	directory: PendingSearchDirectory,
	foldedQuery: string,
	deadline: FsDeadline,
	deps: ExplorerDependencies,
	state: SearchTraversalState,
): Promise<PendingSearchDirectory[]> {
	let handle: DirectoryHandleLike | undefined;
	let closeHandle: (() => Promise<void>) | undefined;
	const children: PendingSearchDirectory[] = [];
	try {
		handle = await deadline.call(deps.fs.opendir(absolutePath(cwd, directory.path)), (late) => { void closeLate(late); });
		closeHandle = makeHandleCloser(handle);
		while (!state.stop) {
			if (state.inspectedEntries >= SEARCH_ENTRY_LIMIT) {
				markSearchTruncated(state, "entry-cap");
				state.stop = true;
				break;
			}
			// Reserve the shared inspection slot before starting an asynchronous read;
			// concurrent workers can therefore never exceed the global entry budget.
			state.inspectedEntries++;
			const rawEntry = await deadline.call(handle.read(), () => { void closeHandle?.().catch(() => undefined); });
			if (!rawEntry) {
				state.inspectedEntries--;
				break;
			}
			if (isGitMetadataSegment(rawEntry.name)) continue;
			let entryPath: string;
			try { entryPath = joinRelativePath(directory.path, rawEntry.name); }
			catch { continue; }
			const kind = entryKind(rawEntry);
			const explorerEntry: ExplorerEntry = { path: entryPath, name: rawEntry.name, kind };
			if (stableLowercase(entryPath).includes(foldedQuery)) {
				state.matches.push(explorerEntry);
				if (state.matches.length > SEARCH_RESULT_LIMIT) markSearchTruncated(state, "result-cap");
			}
			if (kind === "directory") {
				const childDepth = directory.depth + 1;
				if (childDepth >= SEARCH_DEPTH_LIMIT) markSearchTruncated(state, "depth-cap");
				else children.push({ path: entryPath, depth: childDepth });
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
	const state: SearchTraversalState = { inspectedEntries: 0, matches: [], stop: false };
	const queue: PendingSearchDirectory[] = [{ path: "", depth: 0 }];
	let cursor = 0;
	let claimedDirectories = 1;
	while (cursor < queue.length && !state.stop) {
		const depth = queue[cursor].depth;
		const batch: PendingSearchDirectory[] = [];
		while (cursor < queue.length && queue[cursor].depth === depth && batch.length < SEARCH_CONCURRENCY_LIMIT) {
			batch.push(queue[cursor++]);
		}
		const settled = await Promise.allSettled(batch.map((directory) =>
			scanSearchDirectory(cwd, directory, foldedQuery, deadline, deps, state),
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
	const target = absolutePath(cwd, relativePath);
	const stat = await deadline.call(deps.fs.lstat(target));
	if (!stat.isFile()) {
		if (stat.isDirectory()) throw Object.assign(new Error("not a file"), { code: "EISDIR" });
		throw Object.assign(new Error("unsupported file"), { code: "EUNSUPPORTED" });
	}
	let handle: FileHandleLike | undefined;
	let closeHandle: (() => Promise<void>) | undefined;
	try {
		handle = await deadline.call(deps.fs.open(target), (late) => { void closeLate(late); });
		closeHandle = makeHandleCloser(handle);
		const buffer = new Uint8Array(limit + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await deadline.call(handle.read(buffer, offset, buffer.length - offset, offset), () => { void closeHandle?.().catch(() => undefined); });
			if (bytesRead <= 0) break;
			offset += bytesRead;
		}
		return classifyFileBytes(buffer.subarray(0, offset), Math.max(stat.size, offset), limit);
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
	};
	return {
		list: async (ctx: RouteContext, req: RouteRequest): Promise<RouteResult<ListValue>> => {
			try {
				const body = bodyRecord(req);
				const relativePath = normalizeRoutePath(body.path, { allowRoot: true });
				const cwd = routeCwd(ctx);
				const listed = await listDirectory(cwd, relativePath, deps);
				const includeStatus = body.includeStatus === true && relativePath === "";
				const status = includeStatus ? await collectGitSnapshot(cwd, deps.git, deps.gitTimeoutMs) : undefined;
				return { ok: true, value: { path: relativePath, ...listed, ...(status ? { status } : {}) } };
			} catch (error) {
				return fsFailure(error, "list");
			}
		},

		resolve: async (ctx: RouteContext, req: RouteRequest): Promise<RouteResult<ResolveValue>> => {
			try {
				const relativePath = normalizeRoutePath(bodyRecord(req).path, { allowRoot: true });
				return { ok: true, value: await resolvePath(routeCwd(ctx), relativePath, deps) };
			} catch (error) {
				return resolveFailure(error);
			}
		},

		search: async (ctx: RouteContext, req: RouteRequest): Promise<RouteResult<SearchValue>> => {
			try {
				const rawQuery = bodyRecord(req).query;
				if (typeof rawQuery !== "string") throw new ExplorerSearchQueryError("A search query is required.");
				const query = rawQuery.trim();
				if (!query || query.includes("\0")) throw new ExplorerSearchQueryError("Enter a non-empty search query.");
				if (query.length > SEARCH_QUERY_LIMIT) throw new ExplorerSearchQueryError(`Search queries are limited to ${SEARCH_QUERY_LIMIT} characters.`);
				return { ok: true, value: await searchFiles(routeCwd(ctx), query, deps) };
			} catch (error) {
				return searchFailure(error);
			}
		},

		read: async (ctx: RouteContext, req: RouteRequest): Promise<RouteResult<ReadValue>> => {
			try {
				const relativePath = normalizeRoutePath(bodyRecord(req).path);
				const content = await readRegularFile(routeCwd(ctx), relativePath, READ_BYTE_LIMIT, deps);
				return { ok: true, value: { path: relativePath, ...content, limit: READ_BYTE_LIMIT } };
			} catch (error) {
				return readFailure(error);
			}
		},

		diff: async (ctx: RouteContext, req: RouteRequest): Promise<RouteResult<DiffValue>> => {
			let relativePath: string;
			try { relativePath = normalizeRoutePath(bodyRecord(req).path); }
			catch (error) { return fsFailure(error, "read"); }
			const cwd = routeCwd(ctx);
			const snapshot = await collectGitSnapshot(cwd, deps.git, deps.gitTimeoutMs);
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
