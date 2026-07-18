import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { FsLike } from "../../src/server/gateway-deps.ts";
import { scanOrphanedTranscriptsAsync } from "../../src/server/agent/orphan-cleanup.ts";
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
} = {}): Pick<FsLike, "promises"> {
	const statFailures = options.statFailures ?? new Set<string>();
	const readdirFailures = options.readdirFailures ?? new Set<string>();
	const measure = options.measure ?? (async <T>(operation: () => Promise<T>) => operation());
	const promises: any = {
		...memfs.promises,
		stat: async (target: any, statOptions: any) => measure(async () => {
			const resolved = path.resolve(String(target));
			if (statFailures.has(resolved)) throw new Error("injected stat failure");
			const stat = await (memfs.promises.stat as any)(target, statOptions);
			return { ...stat, mtimeMs: mtimes.get(resolved) ?? stat.mtimeMs };
		}),
		readdir: async (target: any, readdirOptions: any) => measure(async () => {
			const resolved = path.resolve(String(target));
			if (readdirFailures.has(resolved)) throw new Error("injected readdir failure");
			return (memfs.promises.readdir as any)(target, readdirOptions);
		}),
	};
	return { promises } as Pick<FsLike, "promises">;
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

	it("keeps counting after the default path and warning caps", async () => {
		for (let index = 0; index < 75; index++) writeFile(`wide/orphan-${index}.jsonl`);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const result = await scanOrphanedTranscriptsAsync(root, new Set(), 0, { fsImpl: scannerFs() });

		assert.equal(result.count, 75);
		assert.equal(result.paths.length, 50);
		assert.equal(warn.mock.calls.length, 20);
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
				await new Promise((resolve) => setTimeout(resolve, 2));
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
});
