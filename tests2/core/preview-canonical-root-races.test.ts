import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { createFsFromVolume, Volume } from "memfs";
import {
	openRegularFileNoFollow,
	type AsyncTreeFileHandle,
	type AsyncTreeStats,
} from "../../src/server/agent/bounded-async-work.ts";
import {
	acquirePreviewDirectoryRead,
	bindPreviewDirectoryRoot,
	copyPreviewDirectory,
	createPreviewAsyncFs,
	hashMountDirectory,
	isPreviewDirectoryAvailable,
	listMountFiles,
	markPreviewDirectoryVerified,
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

function stableStats(kind: "file" | "directory", ino: number): AsyncTreeStats {
	return {
		dev: 7,
		ino,
		mode: 0o644,
		isDirectory: () => kind === "directory",
		isFile: () => kind === "file",
		isSymbolicLink: () => false,
	};
}

function memfsAt(root: string): { memoryFs: typeof fs; asyncFs: PreviewAsyncFs } {
	const memoryFs = createFsFromVolume(new Volume()) as unknown as typeof fs;
	const drive = path.parse(process.cwd()).root.slice(0, 2);
	const normalizeRealpath = (value: string): string => {
		const canonical = value.replace(/\//g, path.sep);
		return path.resolve(`${drive}${canonical}`);
	};
	const rawRealpath = memoryFs.promises.realpath.bind(memoryFs.promises);
	memoryFs.promises.realpath = (async (value: fs.PathLike) =>
		normalizeRealpath(String(await rawRealpath(value)))) as typeof memoryFs.promises.realpath;
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

afterEach(() => {
	setPreviewArtifactRootForTesting(undefined);
	setPreviewArtifactFsForTesting(undefined);
});

describe("preview canonical root and install races", () => {
	it("binds a contained canonical file target to the opened descriptor before reading", async () => {
		const requested = path.resolve("/trusted/requested.txt");
		const canonical = path.resolve("/trusted/canonical.txt");
		const descriptorStats = stableStats("file", 11);
		const differentCanonicalStats = stableStats("file", 12);
		let reads = 0;
		let closes = 0;
		const handle: AsyncTreeFileHandle = {
			read: async () => { reads++; return { bytesRead: 0 }; },
			write: async () => ({ bytesWritten: 0 }),
			stat: async () => descriptorStats,
			chmod: async () => undefined,
			close: async () => { closes++; },
		};
		const raceFs = {
			open: async () => handle,
			realpath: async () => canonical,
			lstat: async (filePath: string) => resolved(filePath) === canonical
				? differentCanonicalStats
				: descriptorStats,
		};

		await assert.rejects(
			openRegularFileNoFollow(requested, raceFs, path.dirname(canonical)),
			/Canonical source does not match/,
		);
		assert.equal(reads, 0);
		assert.equal(closes, 1);
	});

	it("fails closed when an expected file identity is unavailable", async () => {
		const requested = path.resolve("/trusted/no-identity.txt");
		const descriptorStats = stableStats("file", 21);
		const expectedWithoutIdentity = stableStats("file", 21);
		delete expectedWithoutIdentity.dev;
		delete expectedWithoutIdentity.ino;
		let reads = 0;
		let pathnameStats = 0;
		const handle: AsyncTreeFileHandle = {
			read: async () => { reads++; return { bytesRead: 0 }; },
			write: async () => ({ bytesWritten: 0 }),
			stat: async () => descriptorStats,
			chmod: async () => undefined,
			close: async () => undefined,
		};
		const raceFs = {
			open: async () => handle,
			realpath: async () => requested,
			lstat: async () => { pathnameStats++; return descriptorStats; },
		};

		await assert.rejects(
			openRegularFileNoFollow(requested, raceFs, undefined, expectedWithoutIdentity),
			/expected regular file identity/,
		);
		assert.equal(pathnameStats, 0, "the absent expected identity must fail immediately after descriptor stat");
		assert.equal(reads, 0);
	});

	it("rejects a spoofed canonical preview root before enumeration or file reads", async () => {
		const root = path.resolve("/memfs/canonical-target-spoof");
		const { memoryFs, asyncFs } = memfsAt(root);
		const store = path.join(root, "store");
		const candidate = path.join(store, "candidate");
		const outside = path.join(root, "outside");
		memoryFs.mkdirSync(candidate, { recursive: true });
		memoryFs.writeFileSync(path.join(candidate, "inside.txt"), "inside");
		memoryFs.mkdirSync(outside);
		memoryFs.writeFileSync(path.join(outside, "EXTERNAL.txt"), "external-sentinel");
		let opens = 0;
		let directoryOpens = 0;
		const spoofedFs: PreviewAsyncFs = {
			...asyncFs,
			realpath: async filePath => resolved(filePath) === resolved(candidate)
				? resolved(outside)
				: asyncFs.realpath(filePath),
			open: async (filePath, flags, mode) => {
				opens++;
				return asyncFs.open(filePath, flags, mode);
			},
			opendir: async filePath => {
				directoryOpens++;
				return asyncFs.opendir(filePath);
			},
		};

		await assert.rejects(
			hashMountDirectory(candidate, { fs: spoofedFs, trustedRoot: store }),
			/canonical target changed/,
		);
		assert.equal(directoryOpens, 0);
		assert.equal(opens, 0);
		assert.equal(memoryFs.readFileSync(path.join(outside, "EXTERNAL.txt"), "utf8"), "external-sentinel");
	});

	it("rejects a deferred symlink root replacement before traversal can adopt it", async () => {
		const root = path.resolve("/memfs/deferred-symlink-root-race");
		const { memoryFs, asyncFs } = memfsAt(root);
		const store = path.join(root, "store");
		const candidate = path.join(store, "candidate");
		const detached = path.join(root, "detached-candidate");
		const outside = path.join(root, "outside");
		memoryFs.mkdirSync(candidate, { recursive: true });
		memoryFs.writeFileSync(path.join(candidate, "inside.txt"), "inside");
		memoryFs.mkdirSync(outside);
		memoryFs.writeFileSync(path.join(outside, "EXTERNAL.txt"), "external-sentinel");

		let boundaryReleased = false;
		let replacementRootStats = 0;
		let replacementDirectoryOpens = 0;
		let replacementDirectoryReads = 0;
		const observedFs: PreviewAsyncFs = {
			...asyncFs,
			lstat: async filePath => {
				if (boundaryReleased && resolved(filePath) === resolved(candidate)) replacementRootStats++;
				return asyncFs.lstat(filePath);
			},
			opendir: async dirPath => {
				const directory = await asyncFs.opendir(dirPath);
				if (resolved(dirPath) !== resolved(candidate)) return directory;
				replacementDirectoryOpens++;
				return {
					async read() {
						replacementDirectoryReads++;
						return directory.read();
					},
					close: () => directory.close(),
				} as unknown as fs.Dir;
			},
		};
		const bound = await bindPreviewDirectoryRoot(candidate, { fs: observedFs, trustedRoot: store });
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

		const listing = listMountFiles(candidate, {
			fs: observedFs,
			boundRoot: racedBound,
			concurrency: 1,
		});
		await boundaryReached.promise;
		memoryFs.renameSync(candidate, detached);
		memoryFs.symlinkSync(outside, candidate);
		boundaryReleased = true;
		replacementInstalled.resolve();

		await assert.rejects(
			listing,
			(error: unknown) => (error as NodeJS.ErrnoException).code === "ESTALE",
		);
		assert.equal(replacementRootStats, 1, "the first traversal lstat must stop in its bound-root precheck");
		assert.equal(replacementDirectoryOpens, 0, "the replacement symlink target must not be opened");
		assert.equal(replacementDirectoryReads, 0, "the replacement symlink target must not be read");
		assert.equal(memoryFs.readFileSync(path.join(outside, "EXTERNAL.txt"), "utf8"), "external-sentinel");
		assert.equal(memoryFs.readFileSync(path.join(detached, "inside.txt"), "utf8"), "inside");
	});

	it("keeps preview list, hash, and copy candidates inside the canonical trusted store", async () => {
		const root = path.resolve("/memfs/trusted-store-escape");
		const { memoryFs, asyncFs } = memfsAt(root);
		const store = path.join(root, "store");
		const outside = path.join(root, "outside");
		const outsideCandidate = path.join(outside, "candidate");
		const alias = path.join(store, "alias");
		const candidate = path.join(alias, "candidate");
		memoryFs.mkdirSync(store, { recursive: true });
		memoryFs.mkdirSync(outsideCandidate, { recursive: true });
		memoryFs.writeFileSync(path.join(outsideCandidate, "EXTERNAL.txt"), "external-sentinel");
		memoryFs.symlinkSync(outside, alias);
		let opens = 0;
		let directoryOpens = 0;
		const observedFs: PreviewAsyncFs = {
			...asyncFs,
			open: async (filePath, flags, mode) => {
				opens++;
				return asyncFs.open(filePath, flags, mode);
			},
			opendir: async filePath => {
				directoryOpens++;
				return asyncFs.opendir(filePath);
			},
		};
		const operations = [
			() => listMountFiles(candidate, { fs: observedFs, trustedRoot: store }),
			() => hashMountDirectory(candidate, { fs: observedFs, trustedRoot: store }),
			() => copyPreviewDirectory(candidate, path.join(root, "copy"), { fs: observedFs, trustedRoot: store }),
		];
		for (const operation of operations) {
			await assert.rejects(operation(), /trusted canonical store/);
		}
		assert.equal(directoryOpens, 0);
		assert.equal(opens, 0);
		assert.equal(memoryFs.readFileSync(path.join(outsideCandidate, "EXTERNAL.txt"), "utf8"), "external-sentinel");
	});

	it("binds artifact metadata directories to the canonical artifact store before opening", async () => {
		const root = path.resolve("/memfs/artifact-canonical-spoof");
		const { memoryFs, asyncFs } = memfsAt(root);
		const store = path.join(root, "store");
		const artifactId = "raceaa";
		setPreviewArtifactRootForTesting(store);
		const directory = artifactDir(SID, artifactId);
		const outside = path.join(root, "outside");
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
		memoryFs.writeFileSync(path.join(directory, "artifact.json"), JSON.stringify(record));
		memoryFs.mkdirSync(outside);
		memoryFs.writeFileSync(path.join(outside, "EXTERNAL.json"), JSON.stringify({ ...record, createdAt: 999 }));
		let opens = 0;
		let reads = 0;
		const spoofedFs: PreviewAsyncFs = {
			...asyncFs,
			realpath: async filePath => resolved(filePath) === resolved(directory)
				? resolved(outside)
				: asyncFs.realpath(filePath),
			open: async (filePath, flags, mode) => {
				opens++;
				const handle = await asyncFs.open(filePath, flags, mode);
				return {
					read: async (...args: Parameters<typeof handle.read>) => {
						reads++;
						return handle.read(...args);
					},
					write: (...args: Parameters<typeof handle.write>) => handle.write(...args),
					stat: (...args: Parameters<typeof handle.stat>) => handle.stat(...args),
					chmod: (mode: number) => handle.chmod(mode),
					close: () => handle.close(),
				} as unknown as fs.promises.FileHandle;
			},
		};
		setPreviewArtifactFsForTesting(spoofedFs);

		await assert.rejects(
			readPreviewArtifact(SID, artifactId),
			(error: unknown) => error instanceof PreviewArtifactError && error.statusCode === 500,
		);
		assert.equal(opens, 0);
		assert.equal(reads, 0);
		assert.equal(JSON.parse(memoryFs.readFileSync(path.join(outside, "EXTERNAL.json"), "utf8")).createdAt, 999);
	});

	it("waits for an acquired content read before exposing a replacement root", async () => {
		const root = path.resolve("/memfs/preview-read-lease");
		const { memoryFs, asyncFs } = memfsAt(root);
		const source = path.join(root, "staging");
		const destination = path.join(root, SID);
		memoryFs.mkdirSync(source);
		memoryFs.writeFileSync(path.join(source, "inside.html"), "inside");
		const releaseRead = acquirePreviewDirectoryRead(destination);
		assert.ok(releaseRead);
		const expectedRootStats = await asyncFs.lstat(source);
		let settled = false;
		const install = movePreviewDirectoryContents(source, destination, { fs: asyncFs, expectedRootStats })
			.finally(() => { settled = true; });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(settled, false);
		assert.equal(memoryFs.existsSync(destination), false);
		assert.equal(isPreviewDirectoryAvailable(destination), false);
		releaseRead();
		await install;
		assert.equal(memoryFs.readFileSync(path.join(destination, "inside.html"), "utf8"), "inside");
		assert.equal(isPreviewDirectoryAvailable(destination), false, "identity alone cannot publish an un-hashed install");
		markPreviewDirectoryVerified(destination);
		assert.equal(isPreviewDirectoryAvailable(destination), true);
	});

	it("atomically quarantines a substituted staging root without traversing it", async () => {
		const root = path.resolve("/memfs/atomic-preview-install");
		const { memoryFs, asyncFs } = memfsAt(root);
		const parent = path.join(root, "preview");
		const source = path.join(parent, "staging");
		const destination = path.join(parent, SID);
		const outside = path.join(root, "outside");
		const detached = path.join(root, "detached-original");
		memoryFs.mkdirSync(source, { recursive: true });
		memoryFs.writeFileSync(path.join(source, "inside.html"), "inside");
		memoryFs.mkdirSync(outside);
		memoryFs.writeFileSync(path.join(outside, "EXTERNAL.txt"), "external-sentinel");
		let installed = false;
		let unavailableObserved = false;
		let quarantine = "";
		let directoryOpens = 0;
		let unlinks = 0;
		let directoryRemovals = 0;
		const expectedRootStats = await asyncFs.lstat(source);
		const raceFs: PreviewAsyncFs = {
			...asyncFs,
			rename: async (oldPath, newPath) => {
				const oldResolved = resolved(oldPath);
				const newResolved = resolved(newPath);
				if (oldResolved === resolved(source) && newResolved === resolved(destination)) {
					memoryFs.renameSync(source, detached);
					memoryFs.renameSync(outside, source);
					await asyncFs.rename(source, destination);
					installed = true;
					return;
				}
				if (oldResolved === resolved(destination)) quarantine = newResolved;
				await asyncFs.rename(oldPath, newPath);
			},
			lstat: async filePath => {
				if (installed && resolved(filePath) === resolved(destination)) {
					unavailableObserved ||= !isPreviewDirectoryAvailable(destination);
				}
				return asyncFs.lstat(filePath);
			},
			opendir: async filePath => {
				directoryOpens++;
				return asyncFs.opendir(filePath);
			},
			unlink: async filePath => {
				unlinks++;
				return asyncFs.unlink(filePath);
			},
			rmdir: async filePath => {
				directoryRemovals++;
				return asyncFs.rmdir(filePath);
			},
		};

		await assert.rejects(
			movePreviewDirectoryContents(source, destination, { fs: raceFs, expectedRootStats }),
			(error: unknown) => error instanceof PreviewMountError && error.statusCode === 500,
		);
		assert.equal(unavailableObserved, true, "content must stay fenced until destination identity verification");
		assert.equal(directoryOpens, 0, "the substituted staging directory must never be enumerated");
		assert.equal(unlinks, 0, "the substituted staging directory must never be unlinked");
		assert.equal(directoryRemovals, 0, "the substituted staging directory must never be recursively removed");
		assert.equal(memoryFs.existsSync(destination), false);
		assert.ok(quarantine, "the mismatched installed root must be quarantined by rename");
		assert.equal(memoryFs.readFileSync(path.join(quarantine, "EXTERNAL.txt"), "utf8"), "external-sentinel");
		assert.equal(memoryFs.readFileSync(path.join(detached, "inside.html"), "utf8"), "inside");
		assert.equal(isPreviewDirectoryAvailable(destination), false, "failed installs remain persistently fenced");
		markPreviewDirectoryVerified(destination);
		assert.equal(isPreviewDirectoryAvailable(destination), true, "explicitly verified absence may clear the fence");
	});
});
