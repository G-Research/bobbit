import * as nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectGitSnapshot,
	createExplorerRoutes,
	GIT_SNAPSHOT_CACHE_ENTRY_LIMIT,
	GIT_SNAPSHOT_CACHE_TTL_MS,
	type BoundedGitResult,
	type DirectoryEntryLike,
	type DirectoryHandleLike,
	type ExplorerFsAdapter,
	type ExplorerGitRunner,
	type FileHandleLike,
	type GitRunOptions,
	type StatLike,
} from "../../../market-packs/file-explorer/src/explorer-routes.ts";
import { createExplorerRoutes as createPackagedExplorerRoutes } from "../../../market-packs/file-explorer/lib/explorer-routes.mjs";
import {
	DIFF_BYTE_LIMIT,
	LIST_ENTRY_LIMIT,
	READ_BYTE_LIMIT,
	SEARCH_CONCURRENCY_LIMIT,
	SEARCH_DEPTH_LIMIT,
	SEARCH_DIRECTORY_LIMIT,
	SEARCH_ENTRY_LIMIT,
	SEARCH_QUERY_LIMIT,
	SEARCH_RESULT_LIMIT,
	STATUS_BYTE_LIMIT,
} from "../../../market-packs/file-explorer/src/explorer-model.ts";

const SESSION_ROOT = path.resolve("file-explorer-session-root");

function ok(stdout: string | Buffer = ""): BoundedGitResult {
	return { ok: true, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

function failed(
	reason: "exit" | "spawn" | "timeout" | "too-large",
	options: { stderr?: string; code?: number | null; errorCode?: string } = {},
): BoundedGitResult {
	return {
		ok: false,
		reason,
		stdout: Buffer.alloc(0),
		stderr: Buffer.from(options.stderr ?? ""),
		...(options.code === undefined ? {} : { code: options.code }),
		...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
	};
}

class ScriptedGit implements ExplorerGitRunner {
	readonly calls: Array<{ args: string[]; options: GitRunOptions }> = [];
	constructor(private readonly responses: Array<BoundedGitResult | ((args: readonly string[], options: GitRunOptions) => BoundedGitResult | Promise<BoundedGitResult>)>) {}

	async run(args: readonly string[], options: GitRunOptions): Promise<BoundedGitResult> {
		this.calls.push({ args: [...args], options: { ...options } });
		const response = this.responses.shift();
		if (!response) throw new Error(`Unexpected Git call: ${args.join(" ")}`);
		return typeof response === "function" ? response(args, options) : response;
	}
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
	return { promise, resolve };
}

class MemorySnapshotStore {
	value: unknown;
	reads = 0;
	writes = 0;
	failReads = false;
	failWrites = false;

	async read<T>(): Promise<{ state: "absent" } | { state: "present"; value: T }> {
		this.reads++;
		if (this.failReads) throw new Error("store read failed");
		return this.value === undefined ? { state: "absent" } : { state: "present", value: this.value as T };
	}

	async put<T>(_key: string, value: T): Promise<void> {
		this.writes++;
		if (this.failWrites) throw new Error("store write failed");
		this.value = value;
	}
}

class BlockingFirstReadSnapshotStore extends MemorySnapshotStore {
	readonly readStarted = deferred();
	readonly releaseRead = deferred();
	private blockFirstRead = true;

	override async read<T>(): Promise<{ state: "absent" } | { state: "present"; value: T }> {
		if (!this.blockFirstRead) return super.read<T>();
		this.blockFirstRead = false;
		this.reads++;
		const captured = this.value;
		this.readStarted.resolve();
		await this.releaseRead.promise;
		return captured === undefined ? { state: "absent" } : { state: "present", value: captured as T };
	}
}

class FailingFirstPutSnapshotStore extends MemorySnapshotStore {
	readonly putStarted = deferred();
	readonly releasePut = deferred();
	private failFirstPut = true;

	override async put<T>(_key: string, value: T): Promise<void> {
		this.writes++;
		if (this.failFirstPut) {
			this.failFirstPut = false;
			this.putStarted.resolve();
			await this.releasePut.promise;
			throw new Error("store write failed");
		}
		this.value = value;
	}
}

function cachedRouteContext(sessionId: string, store: MemorySnapshotStore, workingDir = SESSION_ROOT) {
	return {
		workingDir,
		sessionId,
		host: { capabilities: { store: true }, store },
	};
}

function rootOnlyFs(): ExplorerFsAdapter {
	return {
		realpath: async (target) => target,
		lstat: async (target) => directoryStat(identityFor(target)),
		opendir: async () => new ArrayDirectoryHandle([]),
		open: async () => { throw new Error("unused"); },
	};
}

function trackedGitResponses(diff = "diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new\n"): BoundedGitResult[] {
	return [ok(""), ok("head\n"), ok(" M file.ts\0"), ok(""), ok(diff)];
}

function entry(name: string, kind: "directory" | "file" | "symlink" | "other"): DirectoryEntryLike {
	return {
		name,
		isDirectory: () => kind === "directory",
		isFile: () => kind === "file",
		isSymbolicLink: () => kind === "symlink",
	};
}

class ArrayDirectoryHandle implements DirectoryHandleLike {
	closed = 0;
	private index = 0;
	constructor(private readonly entries: DirectoryEntryLike[]) {}
	async read(): Promise<DirectoryEntryLike | null> {
		return this.entries[this.index++] ?? null;
	}
	async close(): Promise<void> {
		this.closed++;
	}
}

function identityFor(value: string): number {
	let hash = 17;
	for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
	return hash || 1;
}

function fileStat(size: number, identity = 2): StatLike {
	return { size, dev: 1, ino: identity, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
}

function directoryStat(identity = 1): StatLike {
	return { size: 0, dev: 1, ino: identity, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
}

function symlinkStat(identity = 3): StatLike {
	return { size: 0, dev: 1, ino: identity, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
}

function otherStat(identity = 4): StatLike {
	return { size: 0, dev: 1, ino: identity, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false };
}

function statForEntry(relativePath: string, value: DirectoryEntryLike): StatLike {
	const identity = identityFor(relativePath);
	if (value.isDirectory()) return directoryStat(identity);
	if (value.isFile()) return fileStat(0, identity);
	if (value.isSymbolicLink()) return symlinkStat(identity);
	return otherStat(identity);
}

class SearchTreeFs implements ExplorerFsAdapter {
	readonly opened: string[] = [];
	active = 0;
	maxActive = 0;
	closed = 0;
	constructor(
		private readonly directories: ReadonlyMap<string, readonly DirectoryEntryLike[]>,
		private readonly failingDirectories = new Set<string>(),
	) {}

	private relative(target: string): string {
		return path.relative(SESSION_ROOT, target).split(path.sep).join("/");
	}

	async opendir(target: string): Promise<DirectoryHandleLike> {
		const relativePath = this.relative(target);
		this.opened.push(relativePath);
		if (this.failingDirectories.has(relativePath)) throw Object.assign(new Error("unavailable"), { code: "EACCES" });
		const entries = this.directories.get(relativePath);
		if (!entries) throw Object.assign(new Error("missing"), { code: "ENOENT" });
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		let index = 0;
		let closed = false;
		return {
			read: async () => entries[index++] ?? null,
			close: async () => {
				if (closed) return;
				closed = true;
				this.active--;
				this.closed++;
			},
		};
	}

	async open(): Promise<FileHandleLike> { throw new Error("unused"); }
	async realpath(target: string): Promise<string> { return target; }
	async lstat(target: string): Promise<StatLike> {
		const relativePath = this.relative(target);
		if (relativePath === "" || this.directories.has(relativePath)) return directoryStat(identityFor(relativePath || "root"));
		const slash = relativePath.lastIndexOf("/");
		const parent = slash < 0 ? "" : relativePath.slice(0, slash);
		const name = slash < 0 ? relativePath : relativePath.slice(slash + 1);
		const value = this.directories.get(parent)?.find((candidate) => candidate.name === name);
		if (!value) throw Object.assign(new Error("missing"), { code: "ENOENT" });
		return statForEntry(relativePath, value);
	}
}

class BytesFileHandle implements FileHandleLike {
	closed = 0;
	constructor(private readonly bytes: Uint8Array, private readonly stats = fileStat(bytes.byteLength)) {}
	async read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }> {
		const chunk = this.bytes.subarray(position, position + length);
		buffer.set(chunk, offset);
		return { bytesRead: chunk.byteLength };
	}
	async stat(): Promise<StatLike> { return this.stats; }
	async close(): Promise<void> {
		this.closed++;
	}
}

function fsForFile(relativePath: string, bytes: Uint8Array, observedPaths: string[] = []): ExplorerFsAdapter {
	const expected = path.join(SESSION_ROOT, ...relativePath.split("/"));
	const segments = relativePath.split("/");
	const parents = new Set(segments.slice(0, -1).map((_segment, index) => path.join(SESSION_ROOT, ...segments.slice(0, index + 1))));
	const stats = fileStat(bytes.byteLength, identityFor(relativePath));
	return {
		opendir: async () => { throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" }); },
		realpath: async (target) => target,
		lstat: async (target) => {
			if (target === SESSION_ROOT) return directoryStat(identityFor("root"));
			if (parents.has(target)) return directoryStat(identityFor(path.relative(SESSION_ROOT, target)));
			if (target !== expected) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			observedPaths.push(target);
			return stats;
		},
		open: async (target) => {
			observedPaths.push(target);
			if (target !== expected) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return new BytesFileHandle(bytes, stats);
		},
	};
}

function neverGit(): ExplorerGitRunner {
	return { run: async () => { throw new Error("Git must not be called"); } };
}

function failIfUsedFs(observed: string[]): ExplorerFsAdapter {
	return {
		opendir: async () => { observed.push("opendir"); throw new Error("Filesystem must not be called"); },
		lstat: async () => { observed.push("lstat"); throw new Error("Filesystem must not be called"); },
		open: async () => { observed.push("open"); throw new Error("Filesystem must not be called"); },
		realpath: async () => { observed.push("realpath"); throw new Error("Filesystem must not be called"); },
	};
}

function rootWithoutIdentity(missing = false): StatLike {
	return missing
		? { ...directoryStat(), dev: undefined, ino: undefined }
		: { ...directoryStat(), dev: 1, ino: 0 };
}

function zeroIdentityRootTreeFs(rootStats = rootWithoutIdentity()): ExplorerFsAdapter {
	const nestedStats = fileStat(5, identityFor("folder/nested.txt"));
	return {
		realpath: async (target) => target,
		lstat: async (target) => {
			const relative = path.relative(SESSION_ROOT, target).split(path.sep).join("/");
			if (relative === "") return rootStats;
			if (relative === "folder") return directoryStat(identityFor("folder"));
			if (relative === "folder/nested.txt") return nestedStats;
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		},
		opendir: async (target) => {
			const relative = path.relative(SESSION_ROOT, target).split(path.sep).join("/");
			if (relative === "") return new ArrayDirectoryHandle([entry("folder", "directory")]);
			if (relative === "folder") return new ArrayDirectoryHandle([entry("nested.txt", "file")]);
			throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
		},
		open: async (target) => {
			if (target !== path.join(SESSION_ROOT, "folder", "nested.txt")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return new BytesFileHandle(Buffer.from("hello"), nestedStats);
		},
	};
}

function presentGit(status: string, staged: string, finalDiff: BoundedGitResult): ScriptedGit {
	return new ScriptedGit([
		ok(""),
		ok("0123456789abcdef\n"),
		ok(status),
		ok(staged),
		finalDiff,
	]);
}

function unbornGit(status: string): ScriptedGit {
	return new ScriptedGit([
		ok(""),
		failed("exit", { code: 128 }),
		ok(status),
	]);
}

describe("file explorer list route", () => {
	it("hides exact .git, keeps dotfiles, sorts directory-first, and reports leaf kinds", async () => {
		const rawEntries = [
			entry("zeta.txt", "file"),
			entry(".git", "directory"),
			entry("beta", "directory"),
			entry(".env", "file"),
			entry("alpha", "directory"),
			entry("linked", "symlink"),
			entry("socket", "other"),
		];
		const handle = new ArrayDirectoryHandle(rawEntries);
		const listed = new Map(rawEntries.map((value) => [value.name, value]));
		const fs: ExplorerFsAdapter = {
			realpath: async (target) => target,
			opendir: async (target) => {
				expect(target).toBe(SESSION_ROOT);
				return handle;
			},
			open: async () => { throw new Error("unused"); },
			lstat: async (target) => {
				if (target === SESSION_ROOT) return directoryStat(identityFor("root"));
				const value = listed.get(path.basename(target));
				if (!value) throw Object.assign(new Error("missing"), { code: "ENOENT" });
				return statForEntry(path.basename(target), value);
			},
		};
		const result = await createExplorerRoutes({ fs, git: neverGit() }).list(
			{ workingDir: SESSION_ROOT },
			{ body: { path: "" } },
		);

		expect(result).toMatchObject({ ok: true, value: { path: "", rootPath: SESSION_ROOT, truncated: false } });
		if (!result.ok) throw new Error("expected list success");
		expect(result.value.entries).toEqual([
			{ path: "alpha", name: "alpha", kind: "directory" },
			{ path: "beta", name: "beta", kind: "directory" },
			{ path: ".env", name: ".env", kind: "file" },
			{ path: "linked", name: "linked", kind: "symlink" },
			{ path: "socket", name: "socket", kind: "other" },
			{ path: "zeta.txt", name: "zeta.txt", kind: "file" },
		]);
		expect(handle.closed).toBe(1);
	});

	it("blocks direct .git routes before filesystem or Git I/O in source and packaged handlers", async () => {
		for (const createRoutes of [createExplorerRoutes, createPackagedExplorerRoutes]) {
			const fsCalls: string[] = [];
			const git = new ScriptedGit([]);
			const routes = createRoutes({ fs: failIfUsedFs(fsCalls), git });
			const requests = [
				routes.list({ workingDir: SESSION_ROOT }, { body: { path: ".git" } }),
				routes.list({ workingDir: SESSION_ROOT }, { body: { path: "nested/.git/objects" } }),
				routes.read({ workingDir: SESSION_ROOT }, { body: { path: ".git/config" } }),
				routes.diff({ workingDir: SESSION_ROOT }, { body: { path: ".git/config" } }),
			];
			if (process.platform === "win32" || process.platform === "darwin") {
				requests.push(routes.read({ workingDir: SESSION_ROOT }, { body: { path: ".GIT/config" } }));
			}

			for (const result of await Promise.all(requests)) {
				expect(result).toEqual({
					ok: false,
					error: {
						code: "INVALID_PATH",
						message: "The requested path must be a canonical relative path.",
						retryable: false,
					},
				});
			}
			expect(fsCalls).toEqual([]);
			expect(git.calls).toEqual([]);
		}
	});

	it("keeps ordinary dotfiles and nested dotfolders browsable", async () => {
		const contents = new Map<string, Buffer>([
			[path.join(SESSION_ROOT, ".env"), Buffer.from("TOKEN=local\n")],
			[path.join(SESSION_ROOT, "nested", ".config", ".settings"), Buffer.from("enabled=true\n")],
			...(process.platform === "win32" || process.platform === "darwin"
				? []
				: [[path.join(SESSION_ROOT, ".GIT", "notes"), Buffer.from("ordinary dotfolder\n")] as [string, Buffer]]),
		]);
		const fs: ExplorerFsAdapter = {
			realpath: async (target) => target,
			opendir: async (target) => {
				expect(target).toBe(path.join(SESSION_ROOT, "nested", ".config"));
				return new ArrayDirectoryHandle([entry(".settings", "file")]);
			},
			lstat: async (target) => {
				if (target === SESSION_ROOT) return directoryStat(identityFor("root"));
				const bytes = contents.get(target);
				if (bytes) return fileStat(bytes.byteLength, identityFor(target));
				if (Array.from(contents.keys()).some((candidate) => candidate.startsWith(`${target}${path.sep}`))) return directoryStat(identityFor(target));
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			},
			open: async (target) => {
				const bytes = contents.get(target);
				if (!bytes) throw Object.assign(new Error("missing"), { code: "ENOENT" });
				return new BytesFileHandle(bytes, fileStat(bytes.byteLength, identityFor(target)));
			},
		};
		const routes = createExplorerRoutes({ fs, git: neverGit() });

		expect(await routes.list({ workingDir: SESSION_ROOT }, { body: { path: "nested/.config" } })).toMatchObject({
			ok: true,
			value: { entries: [{ path: "nested/.config/.settings", name: ".settings", kind: "file" }] },
		});
		expect(await routes.read({ workingDir: SESSION_ROOT }, { body: { path: ".env" } })).toMatchObject({
			ok: true,
			value: { kind: "text", text: "TOKEN=local\n" },
		});
		expect(await routes.read({ workingDir: SESSION_ROOT }, { body: { path: "nested/.config/.settings" } })).toMatchObject({
			ok: true,
			value: { kind: "text", text: "enabled=true\n" },
		});
		if (process.platform !== "win32" && process.platform !== "darwin") {
			expect(await routes.read({ workingDir: SESSION_ROOT }, { body: { path: ".GIT/notes" } })).toMatchObject({
				ok: true,
				value: { kind: "text", text: "ordinary dotfolder\n" },
			});
		}
	});

	it("returns at most 1,000 entries and marks additional output truncated", async () => {
		const handle = new ArrayDirectoryHandle(
			Array.from({ length: LIST_ENTRY_LIMIT + 1 }, (_, index) => entry(`file-${String(index).padStart(4, "0")}`, "file")),
		);
		const fs: ExplorerFsAdapter = {
			realpath: async (target) => target,
			opendir: async () => handle,
			open: async () => { throw new Error("unused"); },
			lstat: async (target) => target === SESSION_ROOT
				? directoryStat(identityFor("root"))
				: fileStat(0, identityFor(path.basename(target))),
		};
		const result = await createExplorerRoutes({ fs, git: neverGit() }).list(
			{ workingDir: SESSION_ROOT },
			{ body: { path: "" } },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected list success");
		expect(result.value.entries).toHaveLength(LIST_ENTRY_LIMIT);
		expect(result.value.truncated).toBe(true);
		expect(handle.closed).toBe(1);
	});

	it("only collects status for an explicit root refresh", async () => {
		const git = new ScriptedGit([failed("exit", { stderr: "fatal: not a git repository", code: 128 })]);
		const handles = [new ArrayDirectoryHandle([]), new ArrayDirectoryHandle([])];
		const fs: ExplorerFsAdapter = {
			realpath: async (target) => target,
			opendir: async () => handles.shift()!,
			open: async () => { throw new Error("unused"); },
			lstat: async (target) => directoryStat(identityFor(target)),
		};
		const routes = createExplorerRoutes({ fs, git });
		const child = await routes.list({ workingDir: SESSION_ROOT }, { body: { path: "src", includeStatus: true } });
		expect(child).toMatchObject({ ok: true, value: { path: "src" } });
		if (child.ok) expect(child.value.status).toBeUndefined();
		expect(git.calls).toHaveLength(0);

		const root = await routes.list({ workingDir: SESSION_ROOT }, { body: { path: "", includeStatus: true } });
		expect(root).toMatchObject({ ok: true, value: { status: { kind: "none" } } });
		expect(git.calls).toHaveLength(1);
	});
});

describe("file explorer resolve route", () => {
	it("resolves root, initially unloaded directories and files by lstatting only their canonical chain", async () => {
		const kinds = new Map<string, StatLike>([
			["deep", directoryStat()],
			["deep/nested", directoryStat()],
			["deep/nested/file.txt", fileStat(4)],
		]);
		const observed: string[] = [];
		const fs: ExplorerFsAdapter = {
			realpath: async (target) => target,
			opendir: async () => { throw new Error("resolve must not enumerate siblings"); },
			open: async () => { throw new Error("unused"); },
			lstat: async (target) => {
				const relativePath = path.relative(SESSION_ROOT, target).split(path.sep).join("/");
				if (relativePath === "") return directoryStat(identityFor("root"));
				observed.push(relativePath);
				const stat = kinds.get(relativePath);
				if (!stat) throw Object.assign(new Error(`missing ${target}`), { code: "ENOENT" });
				return stat;
			},
		};
		const routes = createExplorerRoutes({ fs, git: neverGit() });

		expect(await routes.resolve({ workingDir: SESSION_ROOT }, { body: { path: "" } })).toEqual({
			ok: true,
			value: { path: "", rootPath: SESSION_ROOT, kind: "root", chain: [] },
		});
		expect(await routes.resolve({ workingDir: SESSION_ROOT }, { body: { path: "deep/nested" } })).toEqual({
			ok: true,
			value: {
				path: "deep/nested",
				rootPath: SESSION_ROOT,
				kind: "directory",
				chain: [
					{ path: "deep", name: "deep", kind: "directory" },
					{ path: "deep/nested", name: "nested", kind: "directory" },
				],
			},
		});
		expect(await routes.resolve({ workingDir: SESSION_ROOT }, { body: { path: "deep/nested/file.txt" } })).toMatchObject({
			ok: true,
			value: {
				path: "deep/nested/file.txt",
				rootPath: SESSION_ROOT,
				kind: "file",
				chain: [{ path: "deep" }, { path: "deep/nested" }, { path: "deep/nested/file.txt", kind: "file" }],
			},
		});
		expect(new Set(observed)).toEqual(new Set(["deep", "deep/nested", "deep/nested/file.txt"]));
	});

	it("accepts an absolute directory as a new explorer root", async () => {
		const fs: ExplorerFsAdapter = {
			realpath: async (target) => path.resolve(target),
			opendir: async () => { throw new Error("unused"); },
			open: async () => { throw new Error("unused"); },
			lstat: async () => directoryStat(identityFor("absolute-root")),
		};
		const target = path.resolve(SESSION_ROOT, "..", "elsewhere");
		const result = await createExplorerRoutes({ fs, git: neverGit() }).resolve(
			{ workingDir: SESSION_ROOT },
			{ body: { absolutePath: target } },
		);
		expect(result).toEqual({ ok: true, value: { path: "", rootPath: target, kind: "root", chain: [] } });
	});

	it("rejects invalid and .git paths before I/O and distinguishes missing and non-directory parents", async () => {
		const observed: string[] = [];
		const fs: ExplorerFsAdapter = {
			realpath: async (target) => target,
			opendir: async () => { throw new Error("unused"); },
			open: async () => { throw new Error("unused"); },
			lstat: async (target) => {
				const relativePath = path.relative(SESSION_ROOT, target).split(path.sep).join("/");
				if (relativePath === "") return directoryStat(identityFor("root"));
				observed.push(relativePath);
				if (relativePath === "file") return fileStat(1, identityFor("file"));
				if (relativePath === "link") return symlinkStat(identityFor("link"));
				if (relativePath === "socket") return otherStat(identityFor("socket"));
				throw Object.assign(new Error(`missing ${target}`), { code: "ENOENT" });
			},
		};
		const routes = createExplorerRoutes({ fs, git: neverGit() });
		for (const candidate of ["/absolute", "../outside", "a//b", "a\\b", ".git/config"]) {
			expect(await routes.resolve({ workingDir: SESSION_ROOT }, { body: { path: candidate } })).toMatchObject({ ok: false, error: { code: "INVALID_PATH" } });
		}
		expect(observed).toEqual([]);
		expect(await routes.resolve({ workingDir: SESSION_ROOT }, { body: { path: "link" } })).toMatchObject({ ok: true, value: { path: "link", kind: "symlink" } });
		expect(await routes.resolve({ workingDir: SESSION_ROOT }, { body: { path: "socket" } })).toMatchObject({ ok: true, value: { path: "socket", kind: "other" } });
		expect(await routes.resolve({ workingDir: SESSION_ROOT }, { body: { path: "missing" } })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
		expect(await routes.resolve({ workingDir: SESSION_ROOT }, { body: { path: "file/child" } })).toMatchObject({ ok: false, error: { code: "NOT_DIRECTORY" } });
		expect(await routes.resolve({ workingDir: SESSION_ROOT }, { body: { path: "link/child" } })).toMatchObject({ ok: false, error: { code: "NOT_DIRECTORY" } });
		expect(JSON.stringify(await routes.resolve({ workingDir: SESSION_ROOT }, { body: { path: "missing" } }))).not.toContain(SESSION_ROOT);
	});
});

describe("file explorer recursive search route", () => {
	function discoveryTree(): Map<string, readonly DirectoryEntryLike[]> {
		return new Map([
			["", [entry("docs", "directory"), entry("api", "directory"), entry("web", "directory"), entry(".git", "directory"), entry("shortcut", "symlink"), entry("socket", "other")]],
			["docs", [entry("Report.md", "file")]],
			["api", [entry("index.ts", "file")]],
			["web", [entry("index.ts", "file")]],
		]);
	}

	it("matches case-insensitive substrings against full canonical relative paths and sorts duplicate names", async () => {
		const fs = new SearchTreeFs(discoveryTree());
		const routes = createExplorerRoutes({ fs, git: neverGit() });
		const searches = async (query: string) => {
			const result = await routes.search({ workingDir: SESSION_ROOT }, { body: { query } });
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("expected search success");
			return result.value;
		};

		expect((await searches("report")).results.map((result) => result.path)).toEqual(["docs/Report.md"]);
		expect((await searches("  DoCs/rEp  ")).results.map((result) => result.path)).toEqual(["docs/Report.md"]);
		expect((await searches("index")).results.map((result) => result.path)).toEqual(["api/index.ts", "web/index.ts"]);
		expect((await searches("web/ind")).results.map((result) => result.path)).toEqual(["web/index.ts"]);
		expect((await searches("shortcut")).results).toEqual([{ path: "shortcut", name: "shortcut", kind: "symlink" }]);
		expect((await searches("socket")).results).toEqual([{ path: "socket", name: "socket", kind: "other" }]);
		expect(fs.opened).not.toContain(".git");
	});

	it("rejects empty, NUL and overlong queries before filesystem I/O", async () => {
		const observed: string[] = [];
		const routes = createExplorerRoutes({ fs: failIfUsedFs(observed), git: neverGit() });
		for (const query of [undefined, "", "   ", "bad\0query", "x".repeat(SEARCH_QUERY_LIMIT + 1)]) {
			expect(await routes.search({ workingDir: SESSION_ROOT }, { body: { query } })).toMatchObject({ ok: false, error: { code: "INVALID_QUERY", retryable: false } });
		}
		expect(observed).toEqual([]);
	});

	it("caps returned results and inspected entries with explicit truncation reasons", async () => {
		const resultFs = new SearchTreeFs(new Map([["", Array.from({ length: SEARCH_RESULT_LIMIT + 1 }, (_, index) => entry(`match-${index}`, "file"))]]));
		const result = await createExplorerRoutes({ fs: resultFs, git: neverGit(), searchTimeoutMs: 30_000 }).search(
			{ workingDir: SESSION_ROOT },
			{ body: { query: "match" } },
		);
		expect(result).toMatchObject({ ok: true, value: { count: SEARCH_RESULT_LIMIT, limit: SEARCH_RESULT_LIMIT, truncated: true, truncationReason: "result-cap" } });
		if (result.ok) expect(result.value.results).toHaveLength(SEARCH_RESULT_LIMIT);
		expect(resultFs.closed).toBe(1);

		const entryFs = new SearchTreeFs(new Map([["", Array.from({ length: SEARCH_ENTRY_LIMIT }, (_, index) => entry(`file-${index}`, "file"))]]));
		const bounded = await createExplorerRoutes({ fs: entryFs, git: neverGit(), searchTimeoutMs: 30_000 }).search(
			{ workingDir: SESSION_ROOT },
			{ body: { query: "absent" } },
		);
		expect(bounded).toMatchObject({ ok: true, value: { count: 0, truncated: true, truncationReason: "entry-cap" } });
		expect(entryFs.closed).toBe(1);
	});

	it("globally selects the first results after scanning adversarial enumeration order", async () => {
		const reverseMatches = Array.from(
			{ length: SEARCH_RESULT_LIMIT + 1 },
			(_, index) => `match-z-${String(SEARCH_RESULT_LIMIT - index).padStart(4, "0")}`,
		);
		const expectedPaths = [
			"match-a-late",
			...Array.from({ length: SEARCH_RESULT_LIMIT - 1 }, (_, index) => `match-z-${String(index).padStart(4, "0")}`),
		];

		for (const createRoutes of [createExplorerRoutes, createPackagedExplorerRoutes]) {
			const resultFs = new SearchTreeFs(new Map([[
				"",
				[...reverseMatches.map((name) => entry(name, "file")), entry("match-a-late", "file")],
			]]));
			const result = await createRoutes({ fs: resultFs, git: neverGit(), searchTimeoutMs: 30_000 }).search(
				{ workingDir: SESSION_ROOT },
				{ body: { query: "match" } },
			);

			expect(result).toMatchObject({ ok: true, value: { count: SEARCH_RESULT_LIMIT, truncated: true, truncationReason: "result-cap" } });
			if (!result.ok) throw new Error("expected search success");
			expect(result.value.results.map((resultEntry: { path: string }) => resultEntry.path)).toEqual(expectedPaths);
			expect(resultFs.closed).toBe(1);
		}
	});

	it("bounds directory concurrency, total directories and traversal depth without traversing leaves", async () => {
		const concurrencyTree = new Map<string, readonly DirectoryEntryLike[]>([["", Array.from({ length: SEARCH_CONCURRENCY_LIMIT * 2 }, (_, index) => entry(`dir-${index}`, "directory"))]]);
		for (let index = 0; index < SEARCH_CONCURRENCY_LIMIT * 2; index++) concurrencyTree.set(`dir-${index}`, []);
		const concurrencyFs = new SearchTreeFs(concurrencyTree);
		await createExplorerRoutes({ fs: concurrencyFs, git: neverGit(), searchTimeoutMs: 30_000 }).search(
			{ workingDir: SESSION_ROOT },
			{ body: { query: "absent" } },
		);
		expect(concurrencyFs.maxActive).toBe(SEARCH_CONCURRENCY_LIMIT);
		expect(concurrencyFs.closed).toBe(concurrencyFs.opened.length);

		const directoryNames = Array.from({ length: SEARCH_DIRECTORY_LIMIT }, (_, index) => `dir-${index}`);
		const directoryTree = new Map<string, readonly DirectoryEntryLike[]>([["", directoryNames.map((name) => entry(name, "directory"))]]);
		for (const name of directoryNames) directoryTree.set(name, []);
		const directoryFs = new SearchTreeFs(directoryTree);
		const directoryBound = await createExplorerRoutes({ fs: directoryFs, git: neverGit(), searchTimeoutMs: 30_000 }).search(
			{ workingDir: SESSION_ROOT },
			{ body: { query: "absent" } },
		);
		expect(directoryBound).toMatchObject({ ok: true, value: { truncated: true, truncationReason: "directory-cap" } });
		expect(directoryFs.opened).toHaveLength(SEARCH_DIRECTORY_LIMIT);
		expect(directoryFs.closed).toBe(SEARCH_DIRECTORY_LIMIT);

		const depthTree = new Map<string, readonly DirectoryEntryLike[]>();
		let parent = "";
		for (let depth = 1; depth <= SEARCH_DEPTH_LIMIT; depth++) {
			depthTree.set(parent, [entry(`d${depth}`, "directory")]);
			parent = parent ? `${parent}/d${depth}` : `d${depth}`;
		}
		depthTree.set(parent, [entry("hidden-match", "file")]);
		const depthFs = new SearchTreeFs(depthTree);
		const depthBound = await createExplorerRoutes({ fs: depthFs, git: neverGit(), searchTimeoutMs: 30_000 }).search(
			{ workingDir: SESSION_ROOT },
			{ body: { query: "hidden-match" } },
		);
		expect(depthBound).toMatchObject({ ok: true, value: { count: 0, truncated: true, truncationReason: "depth-cap" } });
		expect(depthFs.opened).toHaveLength(SEARCH_DEPTH_LIMIT);
	});

	it("settles sibling workers, closes every handle, and returns retryable safe failures and timeouts", async () => {
		const failingFs = new SearchTreeFs(new Map([
			["", [entry("bad", "directory"), entry("good", "directory")]],
			["good", [entry("file.txt", "file")]],
		]), new Set(["bad"]));
		const failedResult = await createExplorerRoutes({ fs: failingFs, git: neverGit() }).search(
			{ workingDir: SESSION_ROOT },
			{ body: { query: "file" } },
		);
		expect(failedResult).toEqual({ ok: false, error: { code: "SEARCH_FAILED", message: "Session files could not be searched.", retryable: true } });
		expect(JSON.stringify(failedResult)).not.toContain(SESSION_ROOT);
		expect(failingFs.active).toBe(0);
		expect(failingFs.closed).toBe(2);

		let resolveOpen!: (handle: DirectoryHandleLike) => void;
		const delayedOpen = new Promise<DirectoryHandleLike>((resolve) => { resolveOpen = resolve; });
		const lateHandle = new ArrayDirectoryHandle([]);
		const timeoutFs: ExplorerFsAdapter = {
			realpath: async (target) => target,
			opendir: async () => delayedOpen,
			open: async () => { throw new Error("unused"); },
			lstat: async (target) => directoryStat(identityFor(target)),
		};
		const pending = createExplorerRoutes({ fs: timeoutFs, git: neverGit(), searchTimeoutMs: 10 }).search(
			{ workingDir: SESSION_ROOT },
			{ body: { query: "file" } },
		);
		expect(await pending).toEqual({ ok: false, error: { code: "FS_TIMEOUT", message: "The search operation timed out.", retryable: true } });
		resolveOpen(lateHandle);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(lateHandle.closed).toBe(1);

		let resolveRead!: (entry: DirectoryEntryLike | null) => void;
		const delayedRead = new Promise<DirectoryEntryLike | null>((resolve) => { resolveRead = resolve; });
		let readCloses = 0;
		const slowReadFs: ExplorerFsAdapter = {
			realpath: async (target) => target,
			opendir: async () => ({ read: async () => delayedRead, close: async () => { readCloses++; } }),
			open: async () => { throw new Error("unused"); },
			lstat: async (target) => directoryStat(identityFor(target)),
		};
		const slowRead = createExplorerRoutes({ fs: slowReadFs, git: neverGit(), searchTimeoutMs: 10 }).search(
			{ workingDir: SESSION_ROOT },
			{ body: { query: "file" } },
		);
		expect(await slowRead).toMatchObject({ ok: false, error: { code: "FS_TIMEOUT", retryable: true } });
		resolveRead(null);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(readCloses).toBe(1);
	});
});

describe("file explorer filesystem bounds and route errors", () => {
	it("returns retryable FS_TIMEOUT and closes a directory handle that arrives after timeout", async () => {
		let resolveOpen!: (handle: DirectoryHandleLike) => void;
		const delayedOpen = new Promise<DirectoryHandleLike>((resolve) => { resolveOpen = resolve; });
		const lateHandle = new ArrayDirectoryHandle([]);
		const fs: ExplorerFsAdapter = {
			realpath: async (target) => target,
			opendir: async () => delayedOpen,
			open: async () => { throw new Error("unused"); },
			lstat: async (target) => directoryStat(identityFor(target)),
		};
		const pending = createExplorerRoutes({ fs, git: neverGit(), fsTimeoutMs: 10 }).list(
			{ workingDir: SESSION_ROOT },
			{ body: { path: "" } },
		);
		expect(await pending).toEqual({
			ok: false,
			error: { code: "FS_TIMEOUT", message: "The filesystem operation timed out.", retryable: true },
		});
		resolveOpen(lateHandle);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(lateHandle.closed).toBe(1);
	});

	it("closes an acquired file handle when a read exceeds the shared filesystem deadline", async () => {
		let resolveRead!: (value: { bytesRead: number }) => void;
		const delayedRead = new Promise<{ bytesRead: number }>((resolve) => { resolveRead = resolve; });
		let closes = 0;
		const targetStats = fileStat(1, identityFor("slow.txt"));
		const handle: FileHandleLike = {
			read: async () => delayedRead,
			stat: async () => targetStats,
			close: async () => { closes++; },
		};
		const fs: ExplorerFsAdapter = {
			realpath: async (target) => target,
			opendir: async () => { throw new Error("unused"); },
			lstat: async (target) => target === SESSION_ROOT ? directoryStat(identityFor("root")) : targetStats,
			open: async () => handle,
		};
		const result = await createExplorerRoutes({ fs, git: neverGit(), fsTimeoutMs: 10 }).read(
			{ workingDir: SESSION_ROOT },
			{ body: { path: "slow.txt" } },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "FS_TIMEOUT", retryable: true } });
		resolveRead({ bytesRead: 0 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(closes).toBe(1);
	});

	it("maps invalid, missing, wrong-kind, unsupported and generic filesystem errors without leaking paths", async () => {
		const errors = {
			missing: Object.assign(new Error(`missing ${SESSION_ROOT}`), { code: "ENOENT" }),
			denied: Object.assign(new Error(`denied ${SESSION_ROOT}`), { code: "EACCES" }),
		};
		const routesForStat = (statOrError: StatLike | Error) => createExplorerRoutes({
			git: neverGit(),
			fs: {
				realpath: async (target) => target,
				opendir: async () => { throw errors.missing; },
				open: async () => { throw new Error("unused"); },
				lstat: async (target) => {
					if (target === SESSION_ROOT) return directoryStat(identityFor("root"));
					if (statOrError instanceof Error) throw statOrError;
					return statOrError;
				},
			},
		});

		expect(await routesForStat(fileStat(0)).read({ workingDir: SESSION_ROOT }, { body: { path: "../secret" } })).toMatchObject({ ok: false, error: { code: "INVALID_PATH" } });
		expect(await routesForStat(errors.missing).list({ workingDir: SESSION_ROOT }, { body: { path: "missing" } })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
		expect(await routesForStat(directoryStat()).read({ workingDir: SESSION_ROOT }, { body: { path: "folder" } })).toMatchObject({ ok: false, error: { code: "NOT_FILE" } });
		expect(await routesForStat(symlinkStat()).read({ workingDir: SESSION_ROOT }, { body: { path: "link" } })).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_FILE" } });
		const denied = await routesForStat(errors.denied).read({ workingDir: SESSION_ROOT }, { body: { path: "private" } });
		expect(denied).toEqual({ ok: false, error: { code: "READ_FAILED", message: "The file could not be read.", retryable: false } });
		expect(JSON.stringify(denied)).not.toContain(SESSION_ROOT);
	});

	it("uses only the session working directory and returns bounded empty, binary and oversized previews", async () => {
		const cases = [
			{ name: "empty.txt", bytes: Buffer.alloc(0), expected: { kind: "empty", bytes: 0 } },
			{ name: "binary.dat", bytes: Buffer.from([1, 0, 2]), expected: { kind: "binary", bytes: 3 } },
			{ name: "large.txt", bytes: Buffer.alloc(READ_BYTE_LIMIT + 1, 65), expected: { kind: "too-large", bytes: READ_BYTE_LIMIT + 1, limit: READ_BYTE_LIMIT } },
		];
		for (const testCase of cases) {
			const paths: string[] = [];
			const result = await createExplorerRoutes({ fs: fsForFile(testCase.name, testCase.bytes, paths), git: neverGit() }).read(
				{ workingDir: SESSION_ROOT },
				{ body: { path: testCase.name, root: path.resolve("caller-selected-root") } },
			);
			expect(result).toMatchObject({ ok: true, value: { path: testCase.name, ...testCase.expected } });
			const expectedPath = path.join(SESSION_ROOT, testCase.name);
			expect(paths.length).toBeGreaterThan(2);
			expect(paths.every((observed) => observed === expectedPath)).toBe(true);
			expect(JSON.stringify(result)).not.toContain("caller-selected-root");
		}
	});
});

describe("file explorer rooted filesystem hardening", () => {
	it("fails closed without a server-derived working directory before filesystem or Git I/O", async () => {
		for (const createRoutes of [createExplorerRoutes, createPackagedExplorerRoutes]) {
			const fsCalls: string[] = [];
			const git = new ScriptedGit([]);
			const routes = createRoutes({ fs: failIfUsedFs(fsCalls), git });
			for (const result of await Promise.all([
				routes.list({}, { body: { path: "" } }),
				routes.resolve({}, { body: { path: "" } }),
				routes.search({}, { body: { query: "file" } }),
				routes.read({}, { body: { path: "file.txt" } }),
				routes.diff({}, { body: { path: "file.txt" } }),
			])) expect(result).toMatchObject({ ok: false, error: { code: "INVALID_PATH", retryable: false } });
			expect(fsCalls).toEqual([]);
			expect(git.calls).toEqual([]);
		}
	});

	it("keeps stable contained browsing usable when the canonical root has no filesystem identity", async () => {
		for (const rootStats of [rootWithoutIdentity(), rootWithoutIdentity(true)]) {
			for (const createRoutes of [createExplorerRoutes, createPackagedExplorerRoutes]) {
				const routes = createRoutes({ fs: zeroIdentityRootTreeFs(rootStats), git: neverGit() });
				expect(await routes.list(
					{ workingDir: SESSION_ROOT },
					{ body: { path: "" } },
				)).toMatchObject({ ok: true, value: { entries: [{ path: "folder", kind: "directory" }] } });
				expect(await routes.resolve(
					{ workingDir: SESSION_ROOT },
					{ body: { path: "folder/nested.txt" } },
				)).toMatchObject({ ok: true, value: { path: "folder/nested.txt", kind: "file" } });
				expect(await routes.search(
					{ workingDir: SESSION_ROOT },
					{ body: { query: "nested" } },
				)).toMatchObject({ ok: true, value: { results: [{ path: "folder/nested.txt", kind: "file" }] } });
				expect(await routes.read(
					{ workingDir: SESSION_ROOT },
					{ body: { path: "folder/nested.txt" } },
				)).toMatchObject({ ok: true, value: { path: "folder/nested.txt", kind: "text", text: "hello" } });
			}
		}
	});

	it("rejects zero-identity canonical root changes and closes directory handles before reading names", async () => {
		for (const changedRoot of [
			{ path: path.resolve(SESSION_ROOT, "..", "outside"), code: "OUTSIDE_ROOT", retryable: false },
			{ path: path.join(SESSION_ROOT, "replacement"), code: "PATH_CHANGED", retryable: true },
		]) {
			for (const createRoutes of [createExplorerRoutes, createPackagedExplorerRoutes]) {
				let substituted = false;
				let reads = 0;
				let closes = 0;
				const fs: ExplorerFsAdapter = {
					realpath: async (target) => substituted && target === SESSION_ROOT ? changedRoot.path : target,
					lstat: async () => rootWithoutIdentity(),
					opendir: async () => {
						substituted = true;
						return {
							read: async () => { reads++; return entry("secret.txt", "file"); },
							close: async () => { closes++; },
						};
					},
					open: async () => { throw new Error("unused"); },
				};
				const result = await createRoutes({ fs, git: neverGit() }).list(
					{ workingDir: SESSION_ROOT },
					{ body: { path: "" } },
				);
				expect(result).toMatchObject({ ok: false, error: { code: changedRoot.code, retryable: changedRoot.retryable } });
				expect(reads).toBe(0);
				expect(closes).toBe(1);
			}
		}
	});

	it("rejects zero-identity root symlink and kind changes before reading names", async () => {
		for (const replacement of [symlinkStat(identityFor("replacement")), fileStat(0, identityFor("replacement"))]) {
			for (const createRoutes of [createExplorerRoutes, createPackagedExplorerRoutes]) {
				let substituted = false;
				let reads = 0;
				let closes = 0;
				const fs: ExplorerFsAdapter = {
					realpath: async (target) => target,
					lstat: async () => substituted ? replacement : rootWithoutIdentity(),
					opendir: async () => {
						substituted = true;
						return {
							read: async () => { reads++; return entry("secret.txt", "file"); },
							close: async () => { closes++; },
						};
					},
					open: async () => { throw new Error("unused"); },
				};
				const result = await createRoutes({ fs, git: neverGit() }).list(
					{ workingDir: SESSION_ROOT },
					{ body: { path: "" } },
				);
				expect(result).toMatchObject({ ok: false, error: { code: "PATH_CHANGED", retryable: true } });
				expect(reads).toBe(0);
				expect(closes).toBe(1);
			}
		}
	});

	it("rejects a canonical file escape under a zero-identity root before reading bytes", async () => {
		for (const createRoutes of [createExplorerRoutes, createPackagedExplorerRoutes]) {
			let substituted = false;
			let reads = 0;
			let closes = 0;
			const target = path.join(SESSION_ROOT, "secret.txt");
			const targetStats = fileStat(6, identityFor("inside"));
			const outside = path.resolve(SESSION_ROOT, "..", "outside", "secret.txt");
			const fs: ExplorerFsAdapter = {
				realpath: async (candidate) => substituted && candidate === target ? outside : candidate,
				lstat: async (candidate) => candidate === SESSION_ROOT ? rootWithoutIdentity() : targetStats,
				opendir: async () => { throw new Error("unused"); },
				open: async () => {
					substituted = true;
					return {
						stat: async () => targetStats,
						read: async () => { reads++; return { bytesRead: 0 }; },
						close: async () => { closes++; },
					};
				},
			};
			const result = await createRoutes({ fs, git: neverGit() }).read(
				{ workingDir: SESSION_ROOT },
				{ body: { path: "secret.txt" } },
			);
			expect(result).toMatchObject({ ok: false, error: { code: "OUTSIDE_ROOT", retryable: false } });
			expect(reads).toBe(0);
			expect(closes).toBe(1);
		}
	});

	it("closes an opened file without descriptor identity before reading bytes", async () => {
		let reads = 0;
		let closes = 0;
		const targetStats = fileStat(4, identityFor("target"));
		const fs: ExplorerFsAdapter = {
			realpath: async (target) => target,
			opendir: async () => { throw new Error("unused"); },
			lstat: async (target) => target === SESSION_ROOT ? directoryStat(identityFor("root")) : targetStats,
			open: async () => ({
				stat: async () => ({ ...targetStats, dev: undefined, ino: undefined }),
				read: async () => { reads++; return { bytesRead: 0 }; },
				close: async () => { closes++; },
			}),
		};
		const result = await createExplorerRoutes({ fs, git: neverGit() }).read(
			{ workingDir: SESSION_ROOT },
			{ body: { path: "file.txt" } },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "PATH_CHANGED", retryable: true } });
		expect(reads).toBe(0);
		expect(closes).toBe(1);
	});

	it("rejects parent replacement before resolve can inspect an external child", async () => {
		let pivotChecks = 0;
		let externalInspections = 0;
		const fs: ExplorerFsAdapter = {
			realpath: async (target) => target,
			opendir: async () => { throw new Error("unused"); },
			open: async () => { throw new Error("unused"); },
			lstat: async (target) => {
				const relative = path.relative(SESSION_ROOT, target).split(path.sep).join("/");
				if (!relative) return directoryStat(identityFor("root"));
				if (relative === "pivot") return ++pivotChecks <= 3
					? directoryStat(identityFor("pivot"))
					: symlinkStat(identityFor("replacement"));
				externalInspections++;
				return fileStat(6, identityFor("external-secret"));
			},
		};
		const result = await createExplorerRoutes({ fs, git: neverGit() }).resolve(
			{ workingDir: SESSION_ROOT },
			{ body: { path: "pivot/secret.txt" } },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "PATH_CHANGED", retryable: true } });
		expect(externalInspections).toBe(0);
	});

	it("revalidates a queued search directory before opening it and closes the parent handle", async () => {
		let pivotChecks = 0;
		let pivotOpens = 0;
		const rootHandle = new ArrayDirectoryHandle([entry("pivot", "directory")]);
		const fs: ExplorerFsAdapter = {
			realpath: async (target) => target,
			open: async () => { throw new Error("unused"); },
			opendir: async (target) => {
				if (target === SESSION_ROOT) return rootHandle;
				pivotOpens++;
				throw new Error("external directory must not be opened");
			},
			lstat: async (target) => {
				const relative = path.relative(SESSION_ROOT, target).split(path.sep).join("/");
				if (!relative) return directoryStat(identityFor("root"));
				return ++pivotChecks <= 3
					? directoryStat(identityFor("pivot"))
					: symlinkStat(identityFor("replacement"));
			},
		};
		const result = await createExplorerRoutes({ fs, git: neverGit() }).search(
			{ workingDir: SESSION_ROOT },
			{ body: { query: "secret" } },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "PATH_CHANGED", retryable: true } });
		expect(pivotOpens).toBe(0);
		expect(rootHandle.closed).toBe(1);
	});

	it("closes a substituted directory before reading any external names", async () => {
		let substituted = false;
		let reads = 0;
		let closes = 0;
		const fs: ExplorerFsAdapter = {
			realpath: async (target) => substituted && target.endsWith(`${path.sep}pivot`)
				? path.resolve(SESSION_ROOT, "..", "outside")
				: target,
			open: async () => { throw new Error("unused"); },
			opendir: async () => {
				substituted = true;
				return {
					read: async () => { reads++; return entry("secret.txt", "file"); },
					close: async () => { closes++; },
				};
			},
			lstat: async (target) => {
				if (target === SESSION_ROOT) return directoryStat(identityFor("root"));
				if (target.endsWith(`${path.sep}pivot`)) return directoryStat(identityFor("pivot"));
				return directoryStat(identityFor("outside"));
			},
		};
		const result = await createExplorerRoutes({ fs, git: neverGit() }).list(
			{ workingDir: SESSION_ROOT },
			{ body: { path: "pivot" } },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "OUTSIDE_ROOT", retryable: false } });
		expect(reads).toBe(0);
		expect(closes).toBe(1);
	});

	it("uses a no-follow open when available and rejects a substituted descriptor before reading bytes", async () => {
		let substituted = false;
		let reads = 0;
		let closes = 0;
		let flags: string | number | undefined;
		const expected = fileStat(6, identityFor("inside"));
		const external = fileStat(6, identityFor("outside"));
		const fs: ExplorerFsAdapter = {
			realpath: async (target) => target,
			opendir: async () => { throw new Error("unused"); },
			open: async (_target, usedFlags) => {
				flags = usedFlags;
				substituted = true;
				return {
					stat: async () => external,
					read: async () => { reads++; return { bytesRead: 0 }; },
					close: async () => { closes++; },
				};
			},
			lstat: async (target) => {
				if (target === SESSION_ROOT) return directoryStat(identityFor("root"));
				return substituted ? symlinkStat(identityFor("replacement")) : expected;
			},
		};
		const result = await createExplorerRoutes({ fs, git: neverGit() }).read(
			{ workingDir: SESSION_ROOT },
			{ body: { path: "secret.txt" } },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "PATH_CHANGED", retryable: true } });
		if (process.platform === "win32") expect(flags).toBe("r");
		else expect(typeof flags).toBe("number");
		expect(reads).toBe(0);
		expect(closes).toBe(1);
	});

	it.skipIf(process.platform === "win32")("rejects a real directory-to-symlink swap before reading the external directory", async () => {
		const base = await nodeFs.mkdtemp(path.join(os.tmpdir(), "bobbit-explorer-root-"));
		const root = path.join(base, "root");
		const outside = path.join(base, "outside");
		await nodeFs.mkdir(path.join(root, "pivot"), { recursive: true });
		await nodeFs.mkdir(outside);
		await nodeFs.writeFile(path.join(outside, "secret.txt"), "outside");
		let reads = 0;
		let closes = 0;
		const adapter: ExplorerFsAdapter = {
			realpath: (target) => nodeFs.realpath(target),
			lstat: (target) => nodeFs.lstat(target),
			open: (target, flags) => nodeFs.open(target, flags),
			opendir: async (target) => {
				if (target === path.join(root, "pivot")) {
					await nodeFs.rename(target, `${target}-old`);
					await nodeFs.symlink(outside, target, "dir");
				}
				const handle = await nodeFs.opendir(target);
				return {
					read: async () => { reads++; return handle.read(); },
					close: async () => { closes++; await handle.close(); },
				};
			},
		};
		try {
			const result = await createExplorerRoutes({ fs: adapter, git: neverGit() }).list(
				{ workingDir: root },
				{ body: { path: "pivot" } },
			);
			expect(result).toMatchObject({ ok: false, error: { code: "OUTSIDE_ROOT" } });
			expect(reads).toBe(0);
			expect(closes).toBe(1);
		} finally {
			await nodeFs.rm(base, { recursive: true, force: true });
		}
	});
});

describe("file explorer Git snapshot collection", () => {
	it("treats missing Git and non-repositories as normal non-Git browsing", async () => {
		for (const result of [
			failed("spawn", { errorCode: "ENOENT" }),
			failed("exit", { stderr: "fatal: not a git repository", code: 128 }),
		]) {
			const git = new ScriptedGit([result]);
			expect(await collectGitSnapshot(SESSION_ROOT, git, 1234)).toEqual({ kind: "none" });
			expect(git.calls[0]).toMatchObject({
				args: ["rev-parse", "--show-prefix"],
				options: { cwd: SESSION_ROOT, timeoutMs: 1234 },
			});
		}
	});

	it("handles an unborn HEAD without copy augmentation and preserves untracked files", async () => {
		const git = unbornGit("?? src/new.ts\0");
		const snapshot = await collectGitSnapshot(SESSION_ROOT, git);
		expect(snapshot).toMatchObject({
			kind: "git",
			head: "unborn",
			files: [{ path: "src/new.ts", untracked: true, summary: "untracked" }],
			ancestors: ["src"],
		});
		expect(git.calls).toHaveLength(3);
		expect(git.calls[2]?.args).toEqual([
			"-c", "status.renames=copies", "status", "--porcelain=v1", "-z",
			"--untracked-files=all", "--ignored=no", "--", ".",
		]);
		expect(git.calls[2]?.options.maxStdoutBytes).toBe(STATUS_BYTE_LIMIT);
	});

	it("merges retained-source copy-harder provenance under a nested repo prefix", async () => {
		const git = new ScriptedGit([
			ok("packages/app/\n"),
			ok("head\n"),
			ok("AM packages/app/copied.ts\0 M packages/other/outside.ts\0"),
			ok("C100\0packages/app/source.ts\0packages/app/copied.ts\0C100\0packages/other/source.ts\0packages/other/outside.ts\0"),
		]);
		const snapshot = await collectGitSnapshot(SESSION_ROOT, git);
		expect(snapshot).toMatchObject({
			kind: "git",
			head: "present",
			files: [{
				path: "copied.ts",
				oldPath: "source.ts",
				index: "A",
				worktree: "M",
				staged: true,
				unstaged: true,
				copied: true,
				modified: true,
				summary: "copied",
			}],
		});
		expect(git.calls[3]?.args).toEqual([
			"diff", "--cached", "--name-status", "-z", "--find-copies", "--find-copies-harder", "HEAD", "--", ".",
		]);
	});

	it("makes timeout, overflow and malformed copy augmentation non-blockingly unavailable", async () => {
		const timeout = new ScriptedGit([ok(""), ok("head"), failed("timeout")]);
		expect(await collectGitSnapshot(SESSION_ROOT, timeout)).toEqual({
			kind: "unavailable",
			error: { code: "GIT_TIMEOUT", message: "Git status timed out.", retryable: true },
		});

		const overflow = new ScriptedGit([ok(""), ok("head"), failed("too-large")]);
		expect(await collectGitSnapshot(SESSION_ROOT, overflow)).toMatchObject({ kind: "unavailable", error: { code: "GIT_FAILED" } });

		const malformedCopy = new ScriptedGit([ok(""), ok("head"), ok("A  copied.ts\0"), ok("C100\0source.ts\0")]);
		expect(await collectGitSnapshot(SESSION_ROOT, malformedCopy)).toMatchObject({ kind: "unavailable", error: { code: "GIT_FAILED" } });
	});
});

describe("file explorer Git snapshot reuse", () => {
	it("reuses only the server-stored root snapshot and still runs the live path-specific diff in source and packaged handlers", async () => {
		for (const createRoutes of [createExplorerRoutes, createPackagedExplorerRoutes]) {
			const store = new MemorySnapshotStore();
			const git = new ScriptedGit(trackedGitResponses());
			const routes = createRoutes({ fs: rootOnlyFs(), git, now: () => 1_000 });
			const ctx = cachedRouteContext("session-a", store);

			expect(await routes.list(ctx, { body: { path: "", includeStatus: true, snapshotGeneration: 7 } })).toMatchObject({
				ok: true,
				value: { rootPath: SESSION_ROOT, status: { kind: "git", files: [{ path: "file.ts" }] } },
			});
			expect(await routes.diff(ctx, { body: { path: "file.ts", snapshotGeneration: 7 } })).toMatchObject({
				ok: true,
				value: { path: "file.ts", kind: "text" },
			});
			expect(git.calls).toHaveLength(5);
			expect(git.calls.at(-1)?.args).toEqual([
				"diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--find-copies", "--find-copies-harder",
				"--unified=3", "HEAD", "--", "file.ts",
			]);
		}
	});

	it("ignores client-provided snapshot content", async () => {
		const store = new MemorySnapshotStore();
		const git = new ScriptedGit(trackedGitResponses());
		const routes = createExplorerRoutes({ fs: rootOnlyFs(), git, now: () => 1_000 });
		const result = await routes.diff(cachedRouteContext("session-a", store), {
			body: { path: "file.ts", snapshotGeneration: 1, snapshot: { kind: "none" } },
		});
		expect(result).toMatchObject({ ok: true, value: { kind: "text" } });
		expect(git.calls).toHaveLength(5);
	});

	it("isolates snapshots by trusted session, canonical root and refresh generation", async () => {
		const otherRoot = path.resolve("file-explorer-other-root");
		const cases = [
			{ name: "session", diffSession: "session-b", diffGeneration: 3, diffBody: {} },
			{ name: "root", diffSession: "session-a", diffGeneration: 3, diffBody: { rootPath: otherRoot } },
			{ name: "generation", diffSession: "session-a", diffGeneration: 4, diffBody: {} },
		];
		for (const testCase of cases) {
			const store = new MemorySnapshotStore();
			const listCtx = cachedRouteContext("session-a", store);
			const diffCtx = cachedRouteContext(testCase.diffSession, store);
			const git = new ScriptedGit([...trackedGitResponses().slice(0, 4), ...trackedGitResponses()]);
			const routes = createExplorerRoutes({ fs: rootOnlyFs(), git, now: () => 1_000 });
			await routes.list(listCtx, { body: { path: "", includeStatus: true, snapshotGeneration: 3 } });
			const result = await routes.diff(diffCtx, {
				body: { path: "file.ts", snapshotGeneration: testCase.diffGeneration, ...testCase.diffBody },
			});
			expect(result, testCase.name).toMatchObject({ ok: true, value: { kind: "text" } });
			expect(git.calls, testCase.name).toHaveLength(9);
		}
	});

	it("serializes concurrent cache updates without dropping either session", async () => {
		for (const createRoutes of [createExplorerRoutes, createPackagedExplorerRoutes]) {
			const store = new BlockingFirstReadSnapshotStore();
			const firstRoutes = createRoutes({ fs: rootOnlyFs(), git: new ScriptedGit(trackedGitResponses().slice(0, 4)), now: () => 1_000 });
			const secondRoutes = createRoutes({ fs: rootOnlyFs(), git: new ScriptedGit(trackedGitResponses().slice(0, 4)), now: () => 1_000 });
			const first = firstRoutes.list(cachedRouteContext("session-a", store), {
				body: { path: "", includeStatus: true, snapshotGeneration: 1 },
			});
			await store.readStarted.promise;
			const second = secondRoutes.list(cachedRouteContext("session-b", store), {
				body: { path: "", includeStatus: true, snapshotGeneration: 1 },
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			store.releaseRead.resolve();
			await Promise.all([first, second]);

			const stored = store.value as { entries: Array<{ sessionId: string }> };
			expect(stored.entries.map((entry) => entry.sessionId).sort()).toEqual(["session-a", "session-b"]);
		}
	});

	it("continues queued cache updates after a store failure", async () => {
		for (const createRoutes of [createExplorerRoutes, createPackagedExplorerRoutes]) {
			const store = new FailingFirstPutSnapshotStore();
			const firstRoutes = createRoutes({ fs: rootOnlyFs(), git: new ScriptedGit(trackedGitResponses().slice(0, 4)), now: () => 1_000 });
			const secondRoutes = createRoutes({ fs: rootOnlyFs(), git: new ScriptedGit(trackedGitResponses().slice(0, 4)), now: () => 1_000 });
			const first = firstRoutes.list(cachedRouteContext("session-a", store), {
				body: { path: "", includeStatus: true, snapshotGeneration: 1 },
			});
			await store.putStarted.promise;
			const second = secondRoutes.list(cachedRouteContext("session-b", store), {
				body: { path: "", includeStatus: true, snapshotGeneration: 1 },
			});
			store.releasePut.resolve();
			await Promise.all([first, second]);

			const stored = store.value as { entries: Array<{ sessionId: string }> };
			expect(store.writes).toBe(2);
			expect(stored.entries.map((entry) => entry.sessionId)).toEqual(["session-b"]);
		}
	});

	it("does not let an older concurrent generation replace a newer session snapshot", async () => {
		for (const createRoutes of [createExplorerRoutes, createPackagedExplorerRoutes]) {
			const oldGitStarted = deferred();
			const releaseOldGit = deferred();
			const oldGit = new ScriptedGit([
				async () => {
					oldGitStarted.resolve();
					await releaseOldGit.promise;
					return ok("");
				},
				ok("head\n"), ok(" M old.ts\0"), ok(""),
			]);
			const newGit = new ScriptedGit([ok(""), ok("head\n"), ok(" M new.ts\0"), ok("")]);
			const store = new MemorySnapshotStore();
			const oldRoutes = createRoutes({ fs: rootOnlyFs(), git: oldGit, now: () => 1_000 });
			const newRoutes = createRoutes({ fs: rootOnlyFs(), git: newGit, now: () => 1_000 });
			const ctx = cachedRouteContext("session-a", store);
			const oldList = oldRoutes.list(ctx, { body: { path: "", includeStatus: true, snapshotGeneration: 1 } });
			await oldGitStarted.promise;
			await newRoutes.list(ctx, { body: { path: "", includeStatus: true, snapshotGeneration: 2 } });
			releaseOldGit.resolve();
			await oldList;

			const stored = store.value as { entries: Array<{ generation: number; snapshot: { files: Array<{ path: string }> } }> };
			expect(stored.entries).toMatchObject([{ generation: 2, snapshot: { files: [{ path: "new.ts" }] } }]);
		}
	});

	it("expires entries, bounds retained snapshots, and never stores unavailable snapshots", async () => {
		let now = 1_000;
		const expiringStore = new MemorySnapshotStore();
		const expiringGit = new ScriptedGit([...trackedGitResponses().slice(0, 4), ...trackedGitResponses()]);
		const expiringRoutes = createExplorerRoutes({ fs: rootOnlyFs(), git: expiringGit, now: () => now });
		const expiringCtx = cachedRouteContext("session-expiry", expiringStore);
		await expiringRoutes.list(expiringCtx, { body: { path: "", includeStatus: true, snapshotGeneration: 1 } });
		now += GIT_SNAPSHOT_CACHE_TTL_MS + 1;
		expect(await expiringRoutes.diff(expiringCtx, { body: { path: "file.ts", snapshotGeneration: 1 } })).toMatchObject({ ok: true });
		expect(expiringGit.calls).toHaveLength(9);

		const boundedStore = new MemorySnapshotStore();
		const boundedGit = new ScriptedGit(Array.from(
			{ length: GIT_SNAPSHOT_CACHE_ENTRY_LIMIT + 2 },
			() => trackedGitResponses().slice(0, 4),
		).flat());
		const boundedRoutes = createExplorerRoutes({ fs: rootOnlyFs(), git: boundedGit, now: () => 2_000 });
		for (let generation = 0; generation < GIT_SNAPSHOT_CACHE_ENTRY_LIMIT + 2; generation++) {
			const boundedCtx = cachedRouteContext(`session-bound-${generation}`, boundedStore);
			await boundedRoutes.list(boundedCtx, { body: { path: "", includeStatus: true, snapshotGeneration: generation } });
		}
		const stored = boundedStore.value as { entries: Array<{ sessionId: string }> };
		expect(stored.entries).toHaveLength(GIT_SNAPSHOT_CACHE_ENTRY_LIMIT);
		expect(stored.entries.map((entry) => entry.sessionId)).toEqual([
			"session-bound-2", "session-bound-3", "session-bound-4", "session-bound-5",
		]);

		const failureStore = new MemorySnapshotStore();
		const failureGit = new ScriptedGit([
			ok(""), ok("head\n"), failed("timeout"),
			...trackedGitResponses(),
		]);
		const failureRoutes = createExplorerRoutes({ fs: rootOnlyFs(), git: failureGit, now: () => 3_000 });
		const failureCtx = cachedRouteContext("session-failure", failureStore);
		expect(await failureRoutes.list(failureCtx, { body: { path: "", includeStatus: true, snapshotGeneration: 9 } })).toMatchObject({
			ok: true,
			value: { status: { kind: "unavailable" } },
		});
		expect(failureStore.writes).toBe(0);
		expect(await failureRoutes.diff(failureCtx, { body: { path: "file.ts", snapshotGeneration: 9 } })).toMatchObject({ ok: true });
		expect(failureGit.calls).toHaveLength(8);
	});

	it("degrades to fresh Git collection when the server cache store fails", async () => {
		const store = new MemorySnapshotStore();
		store.failWrites = true;
		const git = new ScriptedGit([...trackedGitResponses().slice(0, 4), ...trackedGitResponses()]);
		const routes = createExplorerRoutes({ fs: rootOnlyFs(), git, now: () => 1_000 });
		const ctx = cachedRouteContext("session-a", store);
		expect(await routes.list(ctx, { body: { path: "", includeStatus: true, snapshotGeneration: 1 } })).toMatchObject({ ok: true });
		expect(await routes.diff(ctx, { body: { path: "file.ts", snapshotGeneration: 1 } })).toMatchObject({ ok: true });
		expect(git.calls).toHaveLength(9);
	});
});

describe("file explorer complete working-tree diff route", () => {
	it("runs one HEAD diff for staged plus unstaged changes with bounded argv-based execution", async () => {
		const diffText = "diff --git a/both.ts b/both.ts\n--- a/both.ts\n+++ b/both.ts\n@@ -1 +1 @@\n-old\n+working tree\n";
		const git = presentGit("MM both.ts\0", "M\0both.ts\0", ok(diffText));
		const result = await createExplorerRoutes({ fs: fsForFile("both.ts", Buffer.from("working tree\n")), git, gitTimeoutMs: 4321 }).diff(
			{ workingDir: SESSION_ROOT },
			{ body: { path: "both.ts" } },
		);

		expect(result).toMatchObject({ ok: true, value: { path: "both.ts", kind: "text", text: diffText } });
		expect(git.calls).toHaveLength(5);
		expect(git.calls[4]).toMatchObject({
			args: [
				"diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--find-copies", "--find-copies-harder",
				"--unified=3", "HEAD", "--", "both.ts",
			],
			options: { cwd: SESSION_ROOT, timeoutMs: 4321, maxStdoutBytes: DIFF_BYTE_LIMIT },
		});
	});

	it("passes both old and new pathspecs and preserves copy metadata returned by Git", async () => {
		const copyDiff = "diff --git a/source.ts b/copied.ts\nsimilarity index 100%\ncopy from source.ts\ncopy to copied.ts\n";
		const git = presentGit("A  copied.ts\0", "C100\0source.ts\0copied.ts\0", ok(copyDiff));
		const result = await createExplorerRoutes({ fs: fsForFile("copied.ts", Buffer.from("copy\n")), git }).diff(
			{ workingDir: SESSION_ROOT },
			{ body: { path: "copied.ts" } },
		);

		expect(result).toMatchObject({ ok: true, value: { kind: "metadata-only", text: copyDiff } });
		expect(git.calls.at(-1)?.args).toEqual([
			"diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--find-copies", "--find-copies-harder",
			"--unified=3", "HEAD", "--", "source.ts", "copied.ts",
		]);
	});

	it("classifies deleted, binary, empty, oversized and timed-out tracked diffs explicitly", async () => {
		const cases: Array<{
			status: string;
			path: string;
			diff: BoundedGitResult;
			expected: Record<string, unknown>;
		}> = [
			{
				status: " D deleted.ts\0",
				path: "deleted.ts",
				diff: ok("diff --git a/deleted.ts b/deleted.ts\n--- a/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n"),
				expected: { ok: true, value: { kind: "deleted" } },
			},
			{
				status: " M image.png\0",
				path: "image.png",
				diff: ok("Binary files a/image.png and b/image.png differ\n"),
				expected: { ok: true, value: { kind: "binary" } },
			},
			{ status: " M mode.sh\0", path: "mode.sh", diff: ok(""), expected: { ok: true, value: { kind: "empty", bytes: 0 } } },
			{ status: " M huge.ts\0", path: "huge.ts", diff: failed("too-large"), expected: { ok: true, value: { kind: "too-large", bytes: DIFF_BYTE_LIMIT + 1 } } },
			{ status: " M slow.ts\0", path: "slow.ts", diff: failed("timeout"), expected: { ok: false, error: { code: "GIT_TIMEOUT", retryable: true } } },
		];
		for (const testCase of cases) {
			const git = presentGit(testCase.status, "", testCase.diff);
			const result = await createExplorerRoutes({ fs: fsForFile(testCase.path, Buffer.from("file")), git }).diff(
				{ workingDir: SESSION_ROOT },
				{ body: { path: testCase.path } },
			);
			expect(result).toMatchObject(testCase.expected);
		}
	});

	it("synthesizes untracked/unborn text and reports empty, binary and oversized files", async () => {
		const cases = [
			{
				path: "new.txt",
				bytes: Buffer.from("hello\n"),
				expected: { kind: "text" },
				verify: (text: string) => expect(text).toContain("--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n"),
			},
			{ path: "empty.txt", bytes: Buffer.alloc(0), expected: { kind: "empty-added", bytes: 0 } },
			{ path: "binary.dat", bytes: Buffer.from([1, 0, 2]), expected: { kind: "binary", bytes: 3 } },
			{ path: "large.txt", bytes: Buffer.alloc(DIFF_BYTE_LIMIT + 1, 65), expected: { kind: "too-large", bytes: DIFF_BYTE_LIMIT + 1 } },
		];
		for (const testCase of cases) {
			const git = unbornGit(`?? ${testCase.path}\0`);
			const result = await createExplorerRoutes({ fs: fsForFile(testCase.path, testCase.bytes), git }).diff(
				{ workingDir: SESSION_ROOT },
				{ body: { path: testCase.path } },
			);
			expect(result).toMatchObject({ ok: true, value: { path: testCase.path, limit: DIFF_BYTE_LIMIT, ...testCase.expected } });
			if (result.ok && "verify" in testCase && testCase.verify && "text" in result.value) testCase.verify(result.value.text);
			expect(git.calls).toHaveLength(3);
		}
	});

	it("rejects absolute/caller-selected paths before Git and maps non-Git diff failure", async () => {
		const invalidGit = new ScriptedGit([]);
		const invalid = await createExplorerRoutes({ fs: fsForFile("x", Buffer.alloc(0)), git: invalidGit }).diff(
			{ workingDir: SESSION_ROOT },
			{ body: { path: "C:/caller/root/file", root: "C:/caller/root" } },
		);
		expect(invalid).toMatchObject({ ok: false, error: { code: "INVALID_PATH" } });
		expect(invalidGit.calls).toHaveLength(0);

		const nonGit = new ScriptedGit([failed("exit", { stderr: "fatal: not a git repository", code: 128 })]);
		expect(await createExplorerRoutes({ fs: fsForFile("x", Buffer.alloc(0)), git: nonGit }).diff(
			{ workingDir: SESSION_ROOT },
			{ body: { path: "x" } },
		)).toEqual({
			ok: false,
			error: { code: "GIT_FAILED", message: "A diff is unavailable outside a Git repository.", retryable: false },
		});
	});
});
