import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, it, vi } from "vitest";
import {
	scanOrphanedTranscripts,
	scanOrphanedTranscriptsAsync,
} from "../../src/server/agent/orphan-cleanup.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-async-walk-"));
const root = path.join(tmpRoot, "agent-sessions");

function writeFile(relativePath: string, mtimeMs = Date.now()): string {
	const fullPath = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, "{}\n", "utf8");
	fs.utimesSync(fullPath, mtimeMs / 1_000, mtimeMs / 1_000);
	return fullPath;
}

function sortedResolved(paths: string[]): string[] {
	return paths.map((entry) => path.resolve(entry)).sort();
}

beforeEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("scanOrphanedTranscriptsAsync", () => {
	it("matches the synchronous qualifying set for nested, tracked, old, and non-jsonl files", async () => {
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

		const syncResult = scanOrphanedTranscripts(root, trackedFiles, floor);
		const asyncResult = await scanOrphanedTranscriptsAsync(root, trackedFiles, floor);

		assert.equal(asyncResult.count, syncResult.count);
		assert.equal(asyncResult.count, expected.length);
		assert.deepEqual(sortedResolved(asyncResult.paths), sortedResolved(syncResult.paths));
		assert.deepEqual(sortedResolved(asyncResult.paths), sortedResolved(expected));
		assert.deepEqual([...trackedFiles], [tracked], "the tracked-path set must not be mutated");
		for (const file of [tracked, ...expected]) assert.equal(fs.readFileSync(file, "utf8"), "{}\n");
	});

	it("returns empty for missing and non-directory roots", async () => {
		const missing = await scanOrphanedTranscriptsAsync(path.join(tmpRoot, "missing"), new Set(), 0);
		const fileRoot = writeFile("root.jsonl");
		const notDirectory = await scanOrphanedTranscriptsAsync(fileRoot, new Set(), 0);

		assert.deepEqual(missing, { count: 0, paths: [] });
		assert.deepEqual(notDirectory, { count: 0, paths: [] });
	});

	it("keeps counting after the default path and warning caps", async () => {
		for (let index = 0; index < 75; index++) writeFile(`wide/orphan-${index}.jsonl`);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const result = await scanOrphanedTranscriptsAsync(root, new Set(), 0);

		assert.equal(result.count, 75);
		assert.equal(result.paths.length, 50);
		assert.equal(warn.mock.calls.length, 20);
	});

	it("tolerates individual directory and file I/O failures without mutating the tree", async () => {
		const good = writeFile("good/kept.jsonl");
		const badStat = writeFile("good/stat-fails.jsonl");
		const hiddenByReadError = writeFile("unreadable/hidden.jsonl");
		const unreadableDir = path.dirname(hiddenByReadError);
		const originalStat = fs.promises.stat.bind(fs.promises);
		const originalReaddir = fs.promises.readdir.bind(fs.promises);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(fs.promises, "stat").mockImplementation(async (target, options) => {
			if (path.resolve(String(target)) === path.resolve(badStat)) throw new Error("injected stat failure");
			return originalStat(target, options as never);
		});
		vi.spyOn(fs.promises, "readdir").mockImplementation(async (target, options) => {
			if (path.resolve(String(target)) === path.resolve(unreadableDir)) throw new Error("injected readdir failure");
			return originalReaddir(target, options as never) as never;
		});

		const result = await scanOrphanedTranscriptsAsync(root, new Set(), 0, { concurrency: 2 });

		assert.equal(result.count, 1);
		assert.deepEqual(result.paths, [good]);
		for (const file of [good, badStat, hiddenByReadError]) assert.equal(fs.existsSync(file), true);
	});

	it("shares one global concurrency bound across directory reads and file stats", async () => {
		for (let directory = 0; directory < 12; directory++) {
			for (let file = 0; file < 4; file++) writeFile(`dir-${directory}/orphan-${file}.jsonl`);
		}
		const originalStat = fs.promises.stat.bind(fs.promises);
		const originalReaddir = fs.promises.readdir.bind(fs.promises);
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
		vi.spyOn(fs.promises, "stat").mockImplementation((target, options) =>
			measured(() => originalStat(target, options as never)));
		vi.spyOn(fs.promises, "readdir").mockImplementation((target, options) =>
			measured(() => originalReaddir(target, options as never) as never) as never);

		const result = await scanOrphanedTranscriptsAsync(root, new Set(), 0, {
			concurrency: 3,
			maxLogLines: 0,
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
		});

		assert.equal(result.count, 20);
		assert.equal(result.paths.length, 5);
	});
});
