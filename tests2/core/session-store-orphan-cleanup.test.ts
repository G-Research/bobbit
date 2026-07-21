/**
 * Orphan-cleanup regression tests backed by the FsLike seam.
 *
 * Real recursive filesystem traversal is pinned in
 * tests2/integration/session-store-real-fs.test.ts.
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";
import type { Dirent, PathLike, PathOrFileDescriptor, Stats, WriteFileOptions } from "node:fs";
import type { FsLike } from "../../src/server/gateway-deps.ts";
import { SessionStore, type PersistedSession } from "../../src/server/agent/session-store.ts";
import {
	scanOrphanedTranscriptsAsync,
	shouldKeepDespiteOrphan,
	type AsyncOrphanDirectory,
	type AsyncOrphanScanFs,
} from "../../src/server/agent/orphan-cleanup.ts";
import { createMemFs, type MemFs } from "../harness/mem-fs.js";

type SessionStoreMemFs = MemFs & {
	openSync(file: PathLike, flags: string): number;
	fsyncSync(fd: number): void;
	closeSync(fd: number): void;
};

function createSessionStoreMemFs(): SessionStoreMemFs {
	const memfs = createMemFs() as SessionStoreMemFs;
	const baseWriteFileSync = memfs.writeFileSync.bind(memfs) as (file: PathLike, data: string | NodeJS.ArrayBufferView, options?: WriteFileOptions) => void;
	const fdPaths = new Map<number, string>();
	let nextFd = 100;

	memfs.openSync = (file: PathLike, _flags: string): number => {
		const fd = nextFd++;
		const resolved = path.resolve(String(file));
		fdPaths.set(fd, resolved);
		baseWriteFileSync(resolved, "", "utf-8");
		return fd;
	};
	memfs.writeFileSync = ((file: PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: WriteFileOptions) => {
		if (typeof file === "number") {
			const target = fdPaths.get(file);
			if (!target) throw Object.assign(new Error(`EBADF: bad file descriptor, write '${file}'`), { code: "EBADF" });
			baseWriteFileSync(target, data, options);
			return;
		}
		baseWriteFileSync(file, data, options);
	}) as typeof memfs.writeFileSync;
	memfs.fsyncSync = () => { /* no-op for in-memory unit tests */ };
	memfs.closeSync = (fd: number) => {
		if (!fdPaths.delete(fd)) throw Object.assign(new Error(`EBADF: bad file descriptor, close '${fd}'`), { code: "EBADF" });
	};
	return memfs;
}

type OrphanFsFixture = {
	fs: SessionStoreMemFs;
	setMtime(file: string, mtimeMs: number): void;
};

function createOrphanFsFixture(): OrphanFsFixture {
	const memfs = createSessionStoreMemFs();
	const mtimes = new Map<string, number>();
	const baseStatSync = memfs.statSync.bind(memfs) as (file: PathLike) => Stats;
	const baseReaddirSync = memfs.readdirSync.bind(memfs) as (dir: PathLike) => string[];

	(memfs as unknown as { statSync: typeof memfs.statSync }).statSync = ((file: PathLike) => {
		const stats = baseStatSync(file);
		const resolved = path.resolve(String(file));
		const mtimeMs = mtimes.get(resolved) ?? stats.mtimeMs;
		return {
			...stats,
			mtimeMs,
			mtime: new Date(mtimeMs),
		} as Stats;
	}) as typeof memfs.statSync;

	(memfs as unknown as { readdirSync: typeof memfs.readdirSync }).readdirSync = ((dir: PathLike, options?: { withFileTypes?: boolean }) => {
		const names = baseReaddirSync(dir);
		if (!options?.withFileTypes) return names;
		const resolvedDir = path.resolve(String(dir));
		return names.map((name): Dirent => {
			const full = path.join(resolvedDir, name);
			const resolvedFull = path.resolve(full);
			return {
				name,
				isDirectory: () => memfs.dirs.has(resolvedFull),
				isFile: () => memfs.files.has(resolvedFull),
				isBlockDevice: () => false,
				isCharacterDevice: () => false,
				isSymbolicLink: () => false,
				isFIFO: () => false,
				isSocket: () => false,
				parentPath: resolvedDir,
				path: resolvedDir,
			} as Dirent;
		});
	}) as typeof memfs.readdirSync;

	return {
		fs: memfs,
		setMtime(file: string, mtimeMs: number): void {
			mtimes.set(path.resolve(file), mtimeMs);
		},
	};
}

const tmpRoot = path.resolve("/memfs/session-store-orphan");
const stateDir = path.join(tmpRoot, "state");
const transcriptsDir = path.join(tmpRoot, "agent-sessions");

let fixture: OrphanFsFixture;
let memfs: SessionStoreMemFs;

function resetFixture() {
	fixture = createOrphanFsFixture();
	memfs = fixture.fs;
	memfs.mkdirSync(stateDir, { recursive: true });
	memfs.mkdirSync(transcriptsDir, { recursive: true });
}

function writeJsonl(rel: string, mtimeMs: number): string {
	const full = path.join(transcriptsDir, rel);
	memfs.mkdirSync(path.dirname(full), { recursive: true });
	memfs.writeFileSync(full, '{"hello":"world"}\n', "utf-8");
	fixture.setMtime(full, mtimeMs);
	return full;
}

function tracked(id: string, agentSessionFile: string, lastActivity: number): PersistedSession {
	return {
		id,
		title: id,
		cwd: "/tmp/test",
		agentSessionFile,
		createdAt: lastActivity,
		lastActivity,
	};
}

function asyncOrphanFs(): Pick<FsLike, "promises"> & AsyncOrphanScanFs {
	return {
		promises: memfs.promises,
		async lstat(target) {
			const stats = await memfs.promises.lstat(target);
			return { ...stats, isSymbolicLink: () => false };
		},
		async opendir(target) {
			const entries = await memfs.promises.readdir(target, { withFileTypes: true }) as Dirent[];
			let cursor = 0;
			const directory: AsyncOrphanDirectory = {
				async read() { return entries[cursor++] ?? null; },
				async close() { /* no-op for in-memory unit tests */ },
			};
			return directory;
		},
	};
}

async function scanStoreSnapshot(
	store: SessionStore,
	agentSessionsRoot: string,
	options: { mostRecentLastActivity?: number; maxPaths?: number; maxLogLines?: number } = {},
): Promise<{ count: number; paths: string[] }> {
	const sessions = store.getAll();
	const trackedFiles = new Set(
		sessions.filter(session => session.agentSessionFile).map(session => path.resolve(session.agentSessionFile)),
	);
	const mostRecentLastActivity = options.mostRecentLastActivity
		?? sessions.reduce((latest, session) => Math.max(latest, session.lastActivity), 0);
	return scanOrphanedTranscriptsAsync(agentSessionsRoot, trackedFiles, mostRecentLastActivity, {
		fsImpl: asyncOrphanFs(),
		maxPaths: options.maxPaths,
		maxLogLines: options.maxLogLines,
	});
}

describe("shouldKeepDespiteOrphan predicate", () => {
	beforeEach(() => resetFixture());

	it("Case A — no worktree, no recent transcript → false (would archive)", async () => {
		const now = Date.now();
		const ps = tracked("missing-paths", "", now);
		assert.equal(await shouldKeepDespiteOrphan(ps, {
			fsImpl: asyncOrphanFs(),
			clock: { now: () => now },
		}), false);
	});

	it("Case A — worktree path missing on disk → false", async () => {
		const now = Date.now();
		const recent = writeJsonl("recent.jsonl", now);
		const ps = { ...tracked("missing-worktree", recent, now), worktreePath: path.join(tmpRoot, "does-not-exist") };
		assert.equal(await shouldKeepDespiteOrphan(ps, {
			fsImpl: asyncOrphanFs(),
			clock: { now: () => now },
		}), false);
	});

	it("Case B — worktree exists + transcript within 24h → true (keep live)", async () => {
		const now = Date.now();
		const wt = path.join(tmpRoot, "live-worktree");
		memfs.mkdirSync(wt, { recursive: true });
		const recent = writeJsonl("keep-me.jsonl", now - 60_000);
		const ps = { ...tracked("live", recent, now), worktreePath: wt };
		assert.equal(await shouldKeepDespiteOrphan(ps, {
			fsImpl: asyncOrphanFs(),
			clock: { now: () => now },
		}), true);
	});

	it("Case C — worktree exists but transcript older than 24h → false", async () => {
		const now = Date.now();
		const wt = path.join(tmpRoot, "live-worktree-stale");
		memfs.mkdirSync(wt, { recursive: true });
		const stale = writeJsonl("stale.jsonl", now - 25 * 60 * 60 * 1000);
		const ps = { ...tracked("stale", stale, now), worktreePath: wt };
		assert.equal(await shouldKeepDespiteOrphan(ps, {
			fsImpl: asyncOrphanFs(),
			clock: { now: () => now },
		}), false);
	});

	it("transcript path missing on disk → false even if worktree alive", async () => {
		const now = Date.now();
		const wt = path.join(tmpRoot, "alive-no-transcript");
		memfs.mkdirSync(wt, { recursive: true });
		const ps = {
			...tracked("missing-transcript", path.join(tmpRoot, "missing.jsonl"), now),
			worktreePath: wt,
		};
		assert.equal(await shouldKeepDespiteOrphan(ps, {
			fsImpl: asyncOrphanFs(),
			clock: { now: () => now },
		}), false);
	});
});

describe("scanOrphanedTranscriptsAsync with a SessionStore snapshot", () => {
	beforeEach(() => resetFixture());

	it("returns empty when every jsonl is tracked", async () => {
		const store = new SessionStore(stateDir, memfs);
		const now = Date.now();
		const a = writeJsonl("project/a.jsonl", now);
		const b = writeJsonl("project/b.jsonl", now);
		store.put(tracked("a", a, now));
		store.put(tracked("b", b, now));

		const result = await scanStoreSnapshot(store, transcriptsDir);
		assert.equal(result.count, 0);
		assert.deepEqual(result.paths, []);
	});

	it("flags untracked jsonl files newer than the most recent lastActivity", async () => {
		const store = new SessionStore(stateDir, memfs);
		const now = Date.now();
		const trackedFile = writeJsonl("project/tracked.jsonl", now - 60_000);
		const orphan = writeJsonl("project/orphan.jsonl", now);
		store.put(tracked("a", trackedFile, now - 60_000));

		const warns: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
		try {
			const result = await scanStoreSnapshot(store, transcriptsDir);
			assert.equal(result.count, 1, `expected 1 orphan, got ${result.count}`);
			assert.equal(result.paths.length, 1);
			assert.equal(path.resolve(result.paths[0]), path.resolve(orphan));
		} finally {
			console.warn = origWarn;
		}
		assert.ok(
			warns.some(w => /\[session-store\] WARN: orphaned transcript:/.test(w)),
			`expected an 'orphaned transcript' warn line, got: ${warns.join("\n")}`,
		);
	});

	it("ignores untracked jsonl files older than the most recent lastActivity", async () => {
		const store = new SessionStore(stateDir, memfs);
		const now = Date.now();
		const trackedFile = writeJsonl("project/tracked.jsonl", now);
		writeJsonl("project/old-orphan.jsonl", now - 7 * 24 * 60 * 60 * 1000);
		store.put(tracked("a", trackedFile, now));

		const result = await scanStoreSnapshot(store, transcriptsDir);
		assert.equal(result.count, 0, "old orphan should be ignored — pre-dates last activity");
	});

	it("walks subdirectories recursively", async () => {
		const store = new SessionStore(stateDir, memfs);
		const now = Date.now();
		store.put(tracked("a", "/nope/never.jsonl", now - 3600_000));
		writeJsonl("deep/nested/dir/lost.jsonl", now);
		writeJsonl("another/branch.jsonl", now);

		const result = await scanStoreSnapshot(store, transcriptsDir, { maxLogLines: 0 });
		assert.equal(result.count, 2);
	});

	it("respects maxPaths cap but still counts all", async () => {
		const store = new SessionStore(stateDir, memfs);
		const now = Date.now();
		store.put(tracked("a", "/nope/never.jsonl", now - 3600_000));
		for (let i = 0; i < 8; i++) writeJsonl(`bulk/orphan-${i}.jsonl`, now);

		const result = await scanStoreSnapshot(store, transcriptsDir, { maxPaths: 3, maxLogLines: 0 });
		assert.equal(result.count, 8);
		assert.equal(result.paths.length, 3);
	});

	it("caps log lines at maxLogLines", async () => {
		const store = new SessionStore(stateDir, memfs);
		const now = Date.now();
		store.put(tracked("a", "/nope/never.jsonl", now - 3600_000));
		for (let i = 0; i < 5; i++) writeJsonl(`bulk/orphan-${i}.jsonl`, now);

		const warns: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
		try {
			await scanStoreSnapshot(store, transcriptsDir, { maxLogLines: 2 });
		} finally {
			console.warn = origWarn;
		}
		const orphanWarns = warns.filter(w => /orphaned transcript:/.test(w));
		assert.equal(orphanWarns.length, 2, `expected 2 capped log lines, got ${orphanWarns.length}`);
	});

	it("returns count=0 when agentSessionsRoot does not exist", async () => {
		const store = new SessionStore(stateDir, memfs);
		const result = await scanStoreSnapshot(store, path.join(tmpRoot, "does-not-exist"));
		assert.equal(result.count, 0);
		assert.deepEqual(result.paths, []);
	});
});
