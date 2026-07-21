import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { createFsFromVolume, Volume } from "memfs";
import {
	removeTree,
	walkTree,
} from "../../src/server/agent/bounded-async-work.ts";
import {
	bindPreviewDirectoryRoot,
	copyPreviewDirectory,
	createPreviewAsyncFs,
	movePreviewDirectoryContents,
	PreviewMountError,
	type BoundPreviewDirectoryRoot,
	type PreviewAsyncFs,
} from "../../src/server/preview/mount.ts";
import {
	artifactDir,
	PreviewArtifactError,
	readPreviewArtifact,
	setPreviewArtifactFsForTesting,
	setPreviewArtifactRootForTesting,
	type PreviewArtifactRecord,
} from "../../src/server/preview/artifacts.ts";

const SID = "11111111-2222-3333-4444-555555555555";

function memfsAt(root: string): { memoryFs: typeof fs; asyncFs: PreviewAsyncFs } {
	const memoryFs = createFsFromVolume(new Volume()) as unknown as typeof fs;
	memoryFs.mkdirSync(root, { recursive: true });
	return { memoryFs, asyncFs: createPreviewAsyncFs(memoryFs) };
}

function resolved(value: fs.PathLike): string {
	return path.resolve(String(value));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>(settle => { resolve = settle; });
	return { promise, resolve };
}

function isWithin(candidate: fs.PathLike, root: string): boolean {
	const relative = path.relative(root, resolved(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

afterEach(() => {
	setPreviewArtifactRootForTesting(undefined);
	setPreviewArtifactFsForTesting(undefined);
});

describe("preview root identity races", () => {
	it("walkTree aborts when a visited real directory is replaced before it is opened", async () => {
		const root = path.resolve("/memfs/walk-identity");
		const { memoryFs, asyncFs } = memfsAt(root);
		const child = path.join(root, "child");
		const detached = path.join(root, "detached-child");
		const replacement = path.join(root, "replacement-child");
		memoryFs.mkdirSync(child);
		memoryFs.writeFileSync(path.join(child, "inside.txt"), "inside");
		memoryFs.mkdirSync(replacement);
		memoryFs.writeFileSync(path.join(replacement, "EXTERNAL.txt"), "external-sentinel");
		const visited: string[] = [];

		await assert.rejects(
			walkTree(root, entry => {
				visited.push(entry.relativePath);
				if (entry.relativePath === "child") {
					memoryFs.renameSync(child, detached);
					memoryFs.renameSync(replacement, child);
				}
			}, { fs: asyncFs, concurrency: 1 }),
			/Directory changed during traversal/,
		);

		assert.equal(memoryFs.readFileSync(path.join(child, "EXTERNAL.txt"), "utf8"), "external-sentinel");
		assert.equal(visited.includes("child/EXTERNAL.txt"), false);
	});

	it("expected root identity prevents native cleanup from opening a replacement directory", async () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-preview-root-identity-"));
		const root = path.join(parent, "claimed");
		const detached = path.join(parent, "detached");
		const replacement = path.join(parent, "replacement");
		const sentinel = path.join(replacement, "EXTERNAL.txt");
		fs.mkdirSync(root);
		fs.writeFileSync(path.join(root, "inside.txt"), "inside");
		fs.mkdirSync(replacement);
		fs.writeFileSync(sentinel, "external-sentinel");
		const expectedRootStats = await fs.promises.lstat(root);
		const nativeFs = createPreviewAsyncFs(fs);
		let swapped = false;
		const raceFs: PreviewAsyncFs = {
			...nativeFs,
			lstat: async filePath => {
				if (!swapped && resolved(filePath) === resolved(root)) {
					swapped = true;
					await fs.promises.rename(root, detached);
					await fs.promises.rename(replacement, root);
				}
				return nativeFs.lstat(filePath);
			},
		};
		try {
			await assert.rejects(
				removeTree(root, { fs: raceFs, expectedRootStats }),
				/Directory changed during traversal/,
			);
			assert.equal(swapped, true);
			assert.equal(fs.readFileSync(path.join(root, "EXTERNAL.txt"), "utf8"), "external-sentinel");
		} finally {
			fs.rmSync(parent, { recursive: true, force: true });
		}
	});

	it("fences a deferred real-directory replacement before the first traversal lstat", async () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-preview-bound-root-race-"));
		const store = path.join(parent, "store");
		const source = path.join(store, "source");
		const detached = path.join(parent, "detached-source");
		const replacement = path.join(parent, "replacement");
		const destination = path.join(parent, "destination");
		const sentinel = path.join(replacement, "EXTERNAL.txt");
		fs.mkdirSync(source, { recursive: true });
		fs.writeFileSync(path.join(source, "inside.txt"), "inside");
		fs.mkdirSync(replacement);
		fs.writeFileSync(sentinel, "external-sentinel");

		const nativeFs = createPreviewAsyncFs(fs);
		let replacementDirectoryOpens = 0;
		let replacementDirectoryReads = 0;
		let replacementSourceOpens = 0;
		let replacementSourceByteReads = 0;
		const observedFs: PreviewAsyncFs = {
			...nativeFs,
			opendir: async dirPath => {
				const directory = await nativeFs.opendir(dirPath);
				if (resolved(dirPath) !== resolved(source)) return directory;
				replacementDirectoryOpens++;
				return {
					async read() {
						replacementDirectoryReads++;
						return directory.read();
					},
					close: () => directory.close(),
				} as unknown as fs.Dir;
			},
			open: async (filePath, flags, mode) => {
				const handle = await nativeFs.open(filePath, flags, mode);
				if (!isWithin(filePath, source)) return handle;
				replacementSourceOpens++;
				return {
					async read(...args: Parameters<typeof handle.read>) {
						replacementSourceByteReads++;
						return handle.read(...args);
					},
					write: (...args: Parameters<typeof handle.write>) => handle.write(...args),
					stat: () => handle.stat(),
					chmod: (mode: number) => handle.chmod(mode),
					close: () => handle.close(),
				} as unknown as fs.promises.FileHandle;
			},
		};

		try {
			const bound = await bindPreviewDirectoryRoot(source, { fs: observedFs, trustedRoot: store });
			const boundaryReached = deferred();
			const replacementInstalled = deferred();
			let heldResolveAssertion = false;
			const racedBound: BoundPreviewDirectoryRoot = {
				...bound,
				async assertCurrent() {
					await bound.assertCurrent();
					if (heldResolveAssertion) return;
					heldResolveAssertion = true;
					boundaryReached.resolve();
					await replacementInstalled.promise;
				},
			};

			const copying = copyPreviewDirectory(source, destination, {
				fs: observedFs,
				boundRoot: racedBound,
				concurrency: 1,
			});
			await boundaryReached.promise;
			await fs.promises.rename(source, detached);
			await fs.promises.rename(replacement, source);
			replacementInstalled.resolve();

			await assert.rejects(
				copying,
				(error: unknown) => (error as NodeJS.ErrnoException).code === "ESTALE",
			);
			assert.equal(replacementDirectoryOpens, 0, "the replacement root must not be opened");
			assert.equal(replacementDirectoryReads, 0, "the replacement directory must not be read");
			assert.equal(replacementSourceOpens, 0, "no replacement visitor may open a source descriptor");
			assert.equal(replacementSourceByteReads, 0, "no replacement source bytes may be read");
			assert.equal(await fs.promises.readFile(path.join(source, "EXTERNAL.txt"), "utf8"), "external-sentinel");
			assert.equal(await fs.promises.readFile(path.join(detached, "inside.txt"), "utf8"), "inside");
		} finally {
			fs.rmSync(parent, { recursive: true, force: true });
		}
	});

	it("whole-root rename quarantines a raced staging replacement without external traversal", async () => {
		const parent = path.resolve("/memfs/whole-root-install");
		const { memoryFs, asyncFs } = memfsAt(parent);
		const staging = path.join(parent, "staging");
		const destination = path.join(parent, "destination");
		const detached = path.join(parent, "detached-original");
		const replacement = path.join(parent, "replacement");
		memoryFs.mkdirSync(staging);
		memoryFs.writeFileSync(path.join(staging, "inside.html"), "inside");
		memoryFs.mkdirSync(replacement);
		memoryFs.writeFileSync(path.join(replacement, "EXTERNAL.txt"), "external-sentinel");
		const expectedRootStats = await asyncFs.lstat(staging);
		const renames: Array<[string, string]> = [];
		let quarantine = "";
		let directoryOpens = 0;
		let unlinks = 0;
		let directoryRemovals = 0;
		const raceFs: PreviewAsyncFs = {
			...asyncFs,
			rename: async (oldPath, newPath) => {
				const oldResolved = resolved(oldPath);
				const newResolved = resolved(newPath);
				renames.push([oldResolved, newResolved]);
				await asyncFs.rename(oldPath, newPath);
				if (oldResolved === resolved(staging) && newResolved === resolved(destination)) {
					memoryFs.renameSync(destination, detached);
					memoryFs.renameSync(replacement, destination);
				}
				if (oldResolved === resolved(destination)) quarantine = newResolved;
			},
			opendir: async dirPath => {
				directoryOpens++;
				return asyncFs.opendir(dirPath);
			},
			unlink: async filePath => {
				unlinks++;
				return asyncFs.unlink(filePath);
			},
			rmdir: async dirPath => {
				directoryRemovals++;
				return asyncFs.rmdir(dirPath);
			},
		};

		await assert.rejects(
			movePreviewDirectoryContents(staging, destination, { fs: raceFs, concurrency: 1, expectedRootStats }),
			(error: unknown) => error instanceof PreviewMountError && error.statusCode === 500,
		);
		assert.deepEqual(renames[0], [resolved(staging), resolved(destination)]);
		assert.deepEqual(renames[1], [resolved(destination), quarantine]);
		assert.equal(renames.length, 2, "installation and quarantine must each be one whole-root rename");
		assert.equal(directoryOpens, 0, "the external replacement must never be enumerated");
		assert.equal(unlinks, 0, "the external replacement must never be unlinked");
		assert.equal(directoryRemovals, 0, "the external replacement must never be recursively removed");
		assert.ok(quarantine, "the mismatched installed root must be quarantined");
		assert.equal(memoryFs.readFileSync(path.join(quarantine, "EXTERNAL.txt"), "utf8"), "external-sentinel");
		assert.equal(memoryFs.readFileSync(path.join(detached, "inside.html"), "utf8"), "inside");
		assert.equal(memoryFs.existsSync(path.join(destination, "EXTERNAL.txt")), false);
	});

	it("rejects regular artifact metadata replacement before reading its descriptor", async () => {
		const root = path.resolve("/memfs/artifact-file-identity");
		const { memoryFs, asyncFs } = memfsAt(root);
		const artifactRoot = path.join(root, "artifacts");
		const artifactId = "raceaa";
		setPreviewArtifactRootForTesting(artifactRoot);
		const directory = artifactDir(SID, artifactId);
		const metadataFile = path.join(directory, "artifact.json");
		const replacementFile = path.join(root, "replacement.json");
		const detachedFile = path.join(root, "original.json");
		const record: PreviewArtifactRecord = {
			artifactId,
			sessionId: SID,
			entry: "inline.html",
			contentHash: "0".repeat(64),
			createdAt: 1,
			mtime: 1,
			files: ["inline.html"],
		};
		memoryFs.mkdirSync(directory, { recursive: true });
		memoryFs.writeFileSync(metadataFile, JSON.stringify(record));
		memoryFs.writeFileSync(replacementFile, JSON.stringify({ ...record, createdAt: 999 }));
		let replaced = false;
		let replacementReads = 0;
		const raceFs: PreviewAsyncFs = {
			...asyncFs,
			open: async (filePath, flags, mode) => {
				if (!replaced && resolved(filePath) === resolved(metadataFile)) {
					replaced = true;
					memoryFs.renameSync(metadataFile, detachedFile);
					memoryFs.renameSync(replacementFile, metadataFile);
				}
				const handle = await asyncFs.open(filePath, flags, mode);
				return {
					read: async (...args: Parameters<typeof handle.read>) => {
						replacementReads++;
						return handle.read(...args);
					},
					write: (...args: Parameters<typeof handle.write>) => handle.write(...args),
					stat: (...args: Parameters<typeof handle.stat>) => handle.stat(...args),
					chmod: (newMode: number) => handle.chmod(newMode),
					close: () => handle.close(),
				} as unknown as fs.promises.FileHandle;
			},
		};
		setPreviewArtifactFsForTesting(raceFs);

		await assert.rejects(
			readPreviewArtifact(SID, artifactId),
			(error: unknown) => error instanceof PreviewArtifactError && error.statusCode === 500,
		);
		assert.equal(replaced, true);
		assert.equal(replacementReads, 0, "the replacement descriptor must be rejected immediately after stat");
		assert.equal(JSON.parse(memoryFs.readFileSync(metadataFile, "utf8")).createdAt, 999);
	});
});
