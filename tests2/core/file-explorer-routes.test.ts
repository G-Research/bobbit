import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectGitSnapshot,
	createExplorerRoutes,
	type BoundedGitResult,
	type DirectoryEntryLike,
	type DirectoryHandleLike,
	type ExplorerFsAdapter,
	type ExplorerGitRunner,
	type FileHandleLike,
	type GitRunOptions,
	type StatLike,
} from "../../market-packs/file-explorer/src/explorer-routes.ts";
import { createExplorerRoutes as createPackagedExplorerRoutes } from "../../market-packs/file-explorer/lib/explorer-routes.mjs";
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
} from "../../market-packs/file-explorer/src/explorer-model.ts";

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
	constructor(private readonly responses: Array<BoundedGitResult | ((args: readonly string[], options: GitRunOptions) => BoundedGitResult)>) {}

	async run(args: readonly string[], options: GitRunOptions): Promise<BoundedGitResult> {
		this.calls.push({ args: [...args], options: { ...options } });
		const response = this.responses.shift();
		if (!response) throw new Error(`Unexpected Git call: ${args.join(" ")}`);
		return typeof response === "function" ? response(args, options) : response;
	}
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

class SearchTreeFs implements ExplorerFsAdapter {
	readonly opened: string[] = [];
	active = 0;
	maxActive = 0;
	closed = 0;
	constructor(
		private readonly directories: ReadonlyMap<string, readonly DirectoryEntryLike[]>,
		private readonly failingDirectories = new Set<string>(),
	) {}

	async opendir(target: string): Promise<DirectoryHandleLike> {
		const relativePath = path.relative(SESSION_ROOT, target).split(path.sep).join("/");
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
	async lstat(): Promise<StatLike> { throw new Error("unused"); }
}

class BytesFileHandle implements FileHandleLike {
	closed = 0;
	constructor(private readonly bytes: Uint8Array) {}
	async read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }> {
		const chunk = this.bytes.subarray(position, position + length);
		buffer.set(chunk, offset);
		return { bytesRead: chunk.byteLength };
	}
	async close(): Promise<void> {
		this.closed++;
	}
}

function fileStat(size: number): StatLike {
	return { size, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
}

function directoryStat(): StatLike {
	return { size: 0, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
}

function symlinkStat(): StatLike {
	return { size: 0, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
}

function otherStat(): StatLike {
	return { size: 0, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false };
}

function fsForFile(relativePath: string, bytes: Uint8Array, observedPaths: string[] = []): ExplorerFsAdapter {
	const expected = path.join(SESSION_ROOT, ...relativePath.split("/"));
	return {
		opendir: async () => { throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" }); },
		lstat: async (target) => {
			observedPaths.push(target);
			if (target !== expected) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return fileStat(bytes.byteLength);
		},
		open: async (target) => {
			observedPaths.push(target);
			if (target !== expected) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return new BytesFileHandle(bytes);
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
		const handle = new ArrayDirectoryHandle([
			entry("zeta.txt", "file"),
			entry(".git", "directory"),
			entry("beta", "directory"),
			entry(".env", "file"),
			entry("alpha", "directory"),
			entry("linked", "symlink"),
			entry("socket", "other"),
		]);
		const fs: ExplorerFsAdapter = {
			opendir: async (target) => {
				expect(target).toBe(SESSION_ROOT);
				return handle;
			},
			open: async () => { throw new Error("unused"); },
			lstat: async () => { throw new Error("unused"); },
		};
		const result = await createExplorerRoutes({ fs, git: neverGit() }).list(
			{ workingDir: SESSION_ROOT },
			{ body: { path: "" } },
		);

		expect(result).toMatchObject({ ok: true, value: { path: "", truncated: false } });
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
			opendir: async (target) => {
				expect(target).toBe(path.join(SESSION_ROOT, "nested", ".config"));
				return new ArrayDirectoryHandle([entry(".settings", "file")]);
			},
			lstat: async (target) => {
				const bytes = contents.get(target);
				if (!bytes) throw Object.assign(new Error("missing"), { code: "ENOENT" });
				return fileStat(bytes.byteLength);
			},
			open: async (target) => {
				const bytes = contents.get(target);
				if (!bytes) throw Object.assign(new Error("missing"), { code: "ENOENT" });
				return new BytesFileHandle(bytes);
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
			opendir: async () => handle,
			open: async () => { throw new Error("unused"); },
			lstat: async () => { throw new Error("unused"); },
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
			opendir: async () => handles.shift()!,
			open: async () => { throw new Error("unused"); },
			lstat: async () => { throw new Error("unused"); },
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
			opendir: async () => { throw new Error("resolve must not enumerate siblings"); },
			open: async () => { throw new Error("unused"); },
			lstat: async (target) => {
				const relativePath = path.relative(SESSION_ROOT, target).split(path.sep).join("/");
				observed.push(relativePath);
				const stat = kinds.get(relativePath);
				if (!stat) throw Object.assign(new Error(`missing ${target}`), { code: "ENOENT" });
				return stat;
			},
		};
		const routes = createExplorerRoutes({ fs, git: neverGit() });

		expect(await routes.resolve({ workingDir: SESSION_ROOT }, { body: { path: "" } })).toEqual({
			ok: true,
			value: { path: "", kind: "root", chain: [] },
		});
		expect(await routes.resolve({ workingDir: SESSION_ROOT }, { body: { path: "deep/nested" } })).toEqual({
			ok: true,
			value: {
				path: "deep/nested",
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
				kind: "file",
				chain: [{ path: "deep" }, { path: "deep/nested" }, { path: "deep/nested/file.txt", kind: "file" }],
			},
		});
		expect(observed).toEqual(["deep", "deep/nested", "deep", "deep/nested", "deep/nested/file.txt"]);
	});

	it("rejects invalid and .git paths before I/O and distinguishes missing and non-directory parents", async () => {
		const observed: string[] = [];
		const fs: ExplorerFsAdapter = {
			opendir: async () => { throw new Error("unused"); },
			open: async () => { throw new Error("unused"); },
			lstat: async (target) => {
				const relativePath = path.relative(SESSION_ROOT, target).split(path.sep).join("/");
				observed.push(relativePath);
				if (relativePath === "file") return fileStat(1);
				if (relativePath === "link") return symlinkStat();
				if (relativePath === "socket") return otherStat();
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
			opendir: async () => delayedOpen,
			open: async () => { throw new Error("unused"); },
			lstat: async () => { throw new Error("unused"); },
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
			opendir: async () => ({ read: async () => delayedRead, close: async () => { readCloses++; } }),
			open: async () => { throw new Error("unused"); },
			lstat: async () => { throw new Error("unused"); },
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
			opendir: async () => delayedOpen,
			open: async () => { throw new Error("unused"); },
			lstat: async () => { throw new Error("unused"); },
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
		const handle: FileHandleLike = {
			read: async () => delayedRead,
			close: async () => { closes++; },
		};
		const fs: ExplorerFsAdapter = {
			opendir: async () => { throw new Error("unused"); },
			lstat: async () => fileStat(1),
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
				opendir: async () => { throw errors.missing; },
				open: async () => { throw new Error("unused"); },
				lstat: async () => {
					if (statOrError instanceof Error) throw statOrError;
					return statOrError;
				},
			},
		});

		expect(await routesForStat(fileStat(0)).read({ workingDir: SESSION_ROOT }, { body: { path: "../secret" } })).toMatchObject({ ok: false, error: { code: "INVALID_PATH" } });
		expect(await routesForStat(fileStat(0)).list({ workingDir: SESSION_ROOT }, { body: { path: "missing" } })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
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
			expect(paths).toEqual([
				path.join(SESSION_ROOT, testCase.name),
				path.join(SESSION_ROOT, testCase.name),
			]);
			expect(JSON.stringify(result)).not.toContain("caller-selected-root");
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
