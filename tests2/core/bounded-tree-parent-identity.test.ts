import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	copyTree,
	realAsyncTreeFs,
	walkTree,
	type AsyncTreeDirectory,
	type AsyncTreeFs,
	type AsyncTreeStats,
} from "../../src/server/agent/bounded-async-work.ts";
import {
	createPreviewAsyncFs,
	hashMountDirectory,
	type PreviewAsyncFs,
} from "../../src/server/preview/mount.ts";

const cleanupRoots: string[] = [];

interface ParentRaceFixture {
	parent: string;
	root: string;
	nested: string;
	detached: string;
	replacement: string;
	sentinel: string;
	swapToReplacement(): void;
	swapToSymlink(): void;
}

function makeFixture(childName: string, childIsDirectory = false): ParentRaceFixture {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-tree-parent-"));
	cleanupRoots.push(parent);
	const root = path.join(parent, "source");
	const nested = path.join(root, "nested");
	const detached = path.join(parent, "detached-original");
	const replacement = path.join(parent, "external-replacement");
	const externalChild = path.join(replacement, childName);
	const sentinel = childIsDirectory
		? path.join(externalChild, "EXTERNAL.txt")
		: externalChild;
	fs.mkdirSync(nested, { recursive: true });
	fs.mkdirSync(replacement, { recursive: true });
	if (childIsDirectory) {
		fs.mkdirSync(path.join(nested, childName));
		fs.writeFileSync(path.join(nested, childName, "inside.txt"), "inside");
		fs.mkdirSync(externalChild);
		fs.writeFileSync(sentinel, "external-sentinel");
	} else {
		fs.writeFileSync(path.join(nested, childName), "inside");
		fs.writeFileSync(sentinel, "external-sentinel");
	}
	let swapped = false;
	const detach = (): void => {
		assert.equal(swapped, false, "fixture parent must be swapped once");
		swapped = true;
		fs.renameSync(nested, detached);
	};
	return {
		parent,
		root,
		nested,
		detached,
		replacement,
		sentinel,
		swapToReplacement(): void {
			detach();
			fs.renameSync(replacement, nested);
		},
		swapToSymlink(): void {
			detach();
			fs.symlinkSync(replacement, nested, process.platform === "win32" ? "junction" : "dir");
		},
	};
}

function resolved(filePath: fs.PathLike): string {
	return path.resolve(String(filePath));
}

function expectStale(error: unknown): boolean {
	assert.equal((error as NodeJS.ErrnoException).code, "ESTALE");
	return true;
}

/**
 * Swap the nested directory only after its open handle emitted a Dirent and
 * the walker's after-read frame/parent checks observed the original identities.
 * The next operation is the queued child's parent check (or, in the vulnerable
 * implementation, the child lstat through the replacement).
 */
function swapAfterEmittedFrameValidation(
	base: AsyncTreeFs,
	fixture: ParentRaceFixture,
	triggerEmission = 1,
): AsyncTreeFs & { readonly swapped: boolean } {
	let emittedCount = 0;
	let sawNestedValidation = false;
	let swapQueued = false;
	let swapped = false;
	return {
		...base,
		get swapped() { return swapped; },
		async lstat(filePath: string): Promise<AsyncTreeStats> {
			const stats = await base.lstat(filePath);
			const absolute = resolved(filePath);
			if (emittedCount >= triggerEmission && absolute === resolved(fixture.nested)) {
				sawNestedValidation = true;
			} else if (emittedCount >= triggerEmission
				&& sawNestedValidation
				&& absolute === resolved(fixture.root)
				&& !swapQueued) {
				swapQueued = true;
				queueMicrotask(() => {
					fixture.swapToReplacement();
					swapped = true;
				});
			}
			return stats;
		},
		async opendir(dirPath: string): Promise<AsyncTreeDirectory> {
			const directory = await base.opendir(dirPath);
			if (resolved(dirPath) !== resolved(fixture.nested)) return directory;
			return {
				read: async () => {
					const entry = await directory.read();
					if (entry) emittedCount++;
					return entry;
				},
				close: () => directory.close(),
			};
		},
	} as AsyncTreeFs & { readonly swapped: boolean };
}

function realTreeFs(): AsyncTreeFs {
	return realAsyncTreeFs;
}

afterEach(() => {
	for (const root of cleanupRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("bounded tree parent identity", () => {
	it("rejects queued child work when the Dirent-producing parent is replaced", async () => {
		const fixture = makeFixture("EXTERNAL.txt");
		const io = swapAfterEmittedFrameValidation(realTreeFs(), fixture);
		const visited: string[] = [];

		await assert.rejects(
			walkTree(fixture.root, entry => { visited.push(entry.relativePath); }, { fs: io, concurrency: 2 }),
			expectStale,
		);

		assert.equal(io.swapped, true);
		assert.equal(visited.includes("nested/EXTERNAL.txt"), false, "replacement entries must never reach visitors");
		assert.equal(fs.readFileSync(path.join(fixture.nested, "EXTERNAL.txt"), "utf8"), "external-sentinel");
	});

	it("retains the producing-parent claim through copy queue overflow", async () => {
		const fixture = makeFixture("EXTERNAL.txt");
		fs.writeFileSync(path.join(fixture.nested, "overflow.txt"), "inside-overflow");
		fs.writeFileSync(path.join(fixture.replacement, "overflow.txt"), "external-overflow");
		// With one worker and one queue slot, the first file remains queued while
		// the second file is retained as the worker's local DFS overflow item.
		const io = swapAfterEmittedFrameValidation(realTreeFs(), fixture, 2);
		const destination = path.join(fixture.parent, "copy");

		await assert.rejects(
			copyTree(fixture.root, destination, { fs: io, concurrency: 1 }),
			expectStale,
		);

		assert.equal(io.swapped, true);
		assert.equal(fs.existsSync(path.join(destination, "nested", "EXTERNAL.txt")), false, "queued external bytes must not be copied");
		assert.equal(fs.existsSync(path.join(destination, "nested", "overflow.txt")), false, "local-DFS external bytes must not be copied");
		assert.equal(fs.readFileSync(path.join(fixture.nested, "EXTERNAL.txt"), "utf8"), "external-sentinel");
		assert.equal(fs.readFileSync(path.join(fixture.nested, "overflow.txt"), "utf8"), "external-overflow");
	});

	it("rejects a replaced parent before preview hashing opens its child", async () => {
		const fixture = makeFixture("EXTERNAL.txt");
		const base = createPreviewAsyncFs(fs);
		const raced = swapAfterEmittedFrameValidation(realTreeFs(), fixture);
		let externalOpens = 0;
		const io: PreviewAsyncFs = {
			...base,
			lstat: filePath => raced.lstat(String(filePath)) as Promise<fs.Stats>,
			opendir: filePath => raced.opendir(String(filePath)) as Promise<fs.Dir>,
			open: async (filePath, flags, mode) => {
				if (raced.swapped && resolved(filePath) === resolved(path.join(fixture.nested, "EXTERNAL.txt"))) {
					externalOpens++;
				}
				return base.open(filePath, flags, mode);
			},
		};

		await assert.rejects(
			hashMountDirectory(fixture.root, { fs: io, concurrency: 2 }),
			expectStale,
		);

		assert.equal(raced.swapped, true);
		assert.equal(externalOpens, 0, "replacement bytes must never be opened or hashed");
		assert.equal(fs.readFileSync(path.join(fixture.nested, "EXTERNAL.txt"), "utf8"), "external-sentinel");
	});

	it("does not open descendants after a visited directory's parent becomes a symlink", async () => {
		const fixture = makeFixture("child", true);
		const base = realTreeFs();
		const openedAfterSwap: string[] = [];
		let swapped = false;
		const io: AsyncTreeFs = {
			...base,
			opendir: async (dirPath) => {
				if (swapped) openedAfterSwap.push(resolved(dirPath));
				return base.opendir(dirPath);
			},
		};

		await assert.rejects(
			walkTree(fixture.root, entry => {
				if (entry.relativePath === "nested/child") {
					fixture.swapToSymlink();
					swapped = true;
				}
			}, { fs: io, concurrency: 1 }),
			expectStale,
		);

		assert.equal(
			openedAfterSwap.includes(resolved(path.join(fixture.nested, "child"))),
			false,
			"a child below the substituted symlink must never be opened",
		);
		assert.equal(fs.readFileSync(fixture.sentinel, "utf8"), "external-sentinel");
	});

});
