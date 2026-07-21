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
	createPreviewAsyncFs,
	movePreviewDirectoryContents,
	PreviewMountError,
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

	it("removeTree aborts after an open frame read reveals a real-directory replacement", async () => {
		const parent = path.resolve("/memfs/remove-frame-identity");
		const { memoryFs, asyncFs } = memfsAt(parent);
		const root = path.join(parent, "claimed");
		const detached = path.join(parent, "detached");
		const replacement = path.join(parent, "replacement");
		const sentinel = path.join(replacement, "EXTERNAL.txt");
		memoryFs.mkdirSync(root);
		memoryFs.writeFileSync(path.join(root, "inside.txt"), "inside");
		memoryFs.mkdirSync(replacement);
		memoryFs.writeFileSync(sentinel, "external-sentinel");
		let swapped = false;
		const raceFs: PreviewAsyncFs = {
			...asyncFs,
			opendir: async dirPath => {
				const directory = await asyncFs.opendir(dirPath);
				if (resolved(dirPath) !== resolved(root)) return directory;
				return {
					read: async () => {
						const entry = await directory.read();
						if (!swapped) {
							swapped = true;
							memoryFs.renameSync(root, detached);
							memoryFs.renameSync(replacement, root);
						}
						return entry;
					},
					close: () => directory.close(),
				} as fs.Dir;
			},
		};

		await assert.rejects(removeTree(root, { fs: raceFs }), /Directory changed during traversal/);
		assert.equal(swapped, true);
		assert.equal(memoryFs.readFileSync(path.join(root, "EXTERNAL.txt"), "utf8"), "external-sentinel");
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
