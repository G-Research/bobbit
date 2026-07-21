import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
	scanOrphanedTranscriptsAsync,
	type AsyncOrphanDirectory,
	type AsyncOrphanScanFs,
} from "../../src/server/agent/orphan-cleanup.ts";
import { createMemFs, type MemFs } from "../harness/mem-fs.ts";

const root = path.resolve("/memfs/orphan-async-walk/agent-sessions");
let memfs: MemFs;
let mtimes: Map<string, number>;

function writeFile(relativePath: string, mtimeMs = Date.now()): string {
	const fullPath = path.join(root, relativePath);
	memfs.mkdirSync(path.dirname(fullPath), { recursive: true });
	memfs.writeFileSync(fullPath, "{}\n", "utf8");
	mtimes.set(path.resolve(fullPath), mtimeMs);
	return fullPath;
}

function scannerFs(options: {
	statFailures?: Set<string>;
	readdirFailures?: Set<string>;
	measure?: <T>(operation: () => Promise<T>) => Promise<T>;
	beforeLstat?: (target: string) => Promise<void> | void;
	onDirectoryRead?: (target: string) => Promise<void> | void;
	onDirectoryOpen?: (target: string) => void;
	onDirectoryClose?: (target: string) => void;
} = {}): AsyncOrphanScanFs {
	const statFailures = options.statFailures ?? new Set<string>();
	const readdirFailures = options.readdirFailures ?? new Set<string>();
	const measure = options.measure ?? (async <T>(operation: () => Promise<T>) => operation());
	return {
		lstat: target => measure(async () => {
			const resolved = path.resolve(String(target));
			if (statFailures.has(resolved)) throw new Error("injected stat failure");
			await options.beforeLstat?.(resolved);
			const stat = await memfs.promises.lstat(target);
			return {
				...stat,
				mtimeMs: mtimes.get(resolved) ?? stat.mtimeMs,
				isSymbolicLink: () => false,
			};
		}),
		opendir: target => measure(async () => {
			const resolved = path.resolve(String(target));
			if (readdirFailures.has(resolved)) throw new Error("injected readdir failure");
			const entries = await memfs.promises.readdir(target, { withFileTypes: true }) as Dirent[];
			let cursor = 0;
			let closed = false;
			options.onDirectoryOpen?.(resolved);
			const directory: AsyncOrphanDirectory = {
				read: () => measure(async () => {
					if (closed) throw new Error("directory is closed");
					await options.onDirectoryRead?.(resolved);
					return entries[cursor++] ?? null;
				}),
				close: () => measure(async () => {
					if (!closed) {
						closed = true;
						options.onDirectoryClose?.(resolved);
					}
				}),
			};
			return directory;
		}),
	};
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>(settle => { resolve = settle; });
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	assert.equal(predicate(), true, "condition did not become true");
}

function sortedResolved(paths: string[]): string[] {
	return paths.map((entry) => path.resolve(entry)).sort();
}

beforeEach(() => {
	memfs = createMemFs();
	memfs.mkdirSync(root, { recursive: true });
	mtimes = new Map();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("scanOrphanedTranscriptsAsync", () => {
	it("finds the expected nested set while excluding tracked, old, and non-jsonl files", async () => {
		const now = Date.now();
		const tracked = writeFile("project/tracked.jsonl", now);
		const expected = [
			writeFile("project/orphan.jsonl", now),
			writeFile("deep/nested/orphan.jsonl", now),
			writeFile("other/orphan.jsonl", now),
		];
		writeFile("project/old.jsonl", now - 48 * 60 * 60 * 1_000);
		writeFile("project/not-a-transcript.txt", now);
		const trackedFiles = new Set([tracked]);
		const floor = now - 24 * 60 * 60 * 1_000;
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const result = await scanOrphanedTranscriptsAsync(root, trackedFiles, floor, { fsImpl: scannerFs() });

		assert.equal(result.count, expected.length);
		assert.deepEqual(sortedResolved(result.paths), sortedResolved(expected));
		assert.deepEqual([...trackedFiles], [tracked], "the tracked-path set must not be mutated");
		for (const file of [tracked, ...expected]) assert.equal(memfs.readFileSync(file, "utf8"), "{}\n");
	});

	it("returns empty for missing and non-directory roots", async () => {
		const missing = await scanOrphanedTranscriptsAsync(path.join(root, "missing"), new Set(), 0, { fsImpl: scannerFs() });
		const fileRoot = writeFile("root.jsonl");
		const notDirectory = await scanOrphanedTranscriptsAsync(fileRoot, new Set(), 0, { fsImpl: scannerFs() });

		assert.deepEqual(missing, { count: 0, paths: [] });
		assert.deepEqual(notDirectory, { count: 0, paths: [] });
	});

	it("keeps counting after the default caps and returns a deterministic sorted sample", async () => {
		const allPaths = Array.from({ length: 75 }, (_, index) => writeFile(`wide/orphan-${index}.jsonl`));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const result = await scanOrphanedTranscriptsAsync(root, new Set(), 0, { fsImpl: scannerFs() });

		assert.equal(result.count, 75);
		assert.deepEqual(result.paths, [...allPaths].sort().slice(0, 50));
		assert.deepEqual(
			warn.mock.calls.map(call => String(call[0]).replace("[session-store] WARN: orphaned transcript: ", "")),
			[...allPaths].sort().slice(0, 20),
		);
	});

	it("tolerates individual directory and file I/O failures without mutating the tree", async () => {
		const good = writeFile("good/kept.jsonl");
		const badStat = writeFile("good/stat-fails.jsonl");
		const hiddenByReadError = writeFile("unreadable/hidden.jsonl");
		const unreadableDir = path.dirname(hiddenByReadError);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const fsImpl = scannerFs({
			statFailures: new Set([path.resolve(badStat)]),
			readdirFailures: new Set([path.resolve(unreadableDir)]),
		});

		const result = await scanOrphanedTranscriptsAsync(root, new Set(), 0, { concurrency: 2, fsImpl });

		assert.equal(result.count, 1);
		assert.deepEqual(result.paths, [good]);
		for (const file of [good, badStat, hiddenByReadError]) assert.equal(memfs.existsSync(file), true);
	});

	it("shares one global concurrency bound across directory reads and file stats", async () => {
		for (let directory = 0; directory < 12; directory++) {
			for (let file = 0; file < 4; file++) writeFile(`dir-${directory}/orphan-${file}.jsonl`);
		}
		let active = 0;
		let maxActive = 0;
		const measured = async <T>(operation: () => Promise<T>): Promise<T> => {
			active++;
			maxActive = Math.max(maxActive, active);
			try {
				await new Promise<void>(resolve => setImmediate(resolve));
				return await operation();
			} finally {
				active--;
			}
		};
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const result = await scanOrphanedTranscriptsAsync(root, new Set(), 0, {
			concurrency: 3,
			maxLogLines: 0,
			fsImpl: scannerFs({ measure: measured }),
		});

		assert.equal(result.count, 48);
		assert.ok(maxActive > 1, `expected parallel filesystem work, saw ${maxActive}`);
		assert.ok(maxActive <= 3, `filesystem concurrency exceeded bound: ${maxActive}`);
	});

	it("supports a single worker across a wide tree without deferring entries", async () => {
		for (let directory = 0; directory < 20; directory++) {
			writeFile(`dir-${directory}/nested/orphan.jsonl`);
		}
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const result = await scanOrphanedTranscriptsAsync(root, new Set(), 0, {
			concurrency: 1,
			maxPaths: 5,
			maxLogLines: 0,
			fsImpl: scannerFs(),
		});

		assert.equal(result.count, 20);
		assert.equal(result.paths.length, 5);
	});

	it("backpressures a wide streamed directory at the candidate ceiling", async () => {
		for (let index = 0; index < 600; index++) writeFile(`wide/entry-${index}.jsonl`);
		const wideDirectory = path.resolve(root, "wide");
		const releaseStats = deferred();
		let candidateStats = 0;
		let wideReads = 0;
		let settled = false;
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const scan = scanOrphanedTranscriptsAsync(root, new Set(), 0, {
			concurrency: 3,
			maxLogLines: 0,
			fsImpl: scannerFs({
				beforeLstat: async target => {
					if (!target.endsWith(".jsonl")) return;
					candidateStats++;
					await releaseStats.promise;
				},
				onDirectoryRead: target => { if (target === wideDirectory) wideReads++; },
			}),
		}).finally(() => { settled = true; });

		await waitFor(() => candidateStats === 3);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(wideReads, 3, "scanner read past its fixed pending-candidate capacity");
		assert.equal(settled, false, "scan should remain pending behind deferred file stats");

		releaseStats.resolve();
		const result = await scan;
		assert.equal(result.count, 600);
	});

	it("does not read ahead through a deep tree while candidate slots are full", async () => {
		const depth = 300;
		let relativeDirectory = "deep";
		for (let level = 0; level < depth; level++) {
			writeFile(`${relativeDirectory}/orphan-${level}.jsonl`);
			relativeDirectory = `${relativeDirectory}/level-${level}`;
		}
		const releaseStats = deferred();
		let candidateStats = 0;
		let opened = 0;
		let closed = 0;
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const scan = scanOrphanedTranscriptsAsync(root, new Set(), 0, {
			concurrency: 2,
			maxLogLines: 0,
			fsImpl: scannerFs({
				beforeLstat: async target => {
					if (!target.endsWith(".jsonl")) return;
					candidateStats++;
					await releaseStats.promise;
				},
				onDirectoryOpen: () => { opened++; },
				onDirectoryClose: () => { closed++; },
			}),
		});

		await waitFor(() => candidateStats === 2);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.ok(opened <= 3, `deep traversal opened ${opened} directories past backpressure`);
		assert.equal(closed, 0, "deferred frontier should retain only its active depth frames");

		releaseStats.resolve();
		const result = await scan;
		assert.equal(result.count, depth);
		assert.equal(closed, opened, "all streamed directory handles must close");
	});
});
