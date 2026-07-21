import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createFsFromVolume, Volume } from "memfs";
import {
	contentHashForMount,
	copyPreviewDirectory,
	createPreviewAsyncFs,
	hashMountDirectory,
	listMountFiles,
	mountPath,
	removeMount,
	removePreviewTree,
	setPreviewFsForTesting,
	setPreviewRootForTesting,
	writeInline,
	type PreviewAsyncFs,
} from "../../src/server/preview/mount.ts";
import {
	artifactDir,
	artifactMountDir,
	findPreviewArtifactByHash,
	persistPreviewArtifact,
	PreviewArtifactError,
	readPreviewArtifact,
	removeArtifacts,
	restorePreviewArtifact,
	setPreviewArtifactFsForTesting,
	setPreviewArtifactRootForTesting,
	sweepOrphanArtifacts,
	type PreviewArtifactRecord,
} from "../../src/server/preview/artifacts.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const SID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const memoryFs = createFsFromVolume(new Volume()) as unknown as typeof fs;
const baseAsyncFs = createPreviewAsyncFs(memoryFs);
const root = path.resolve("/memfs/preview-artifacts");
const previewRoot = path.join(root, "preview");
const artifactRoot = path.join(root, "store");

beforeAll(() => {
	memoryFs.mkdirSync(root, { recursive: true });
	setPreviewFsForTesting(memoryFs);
	setPreviewArtifactFsForTesting(memoryFs);
	setPreviewRootForTesting(previewRoot);
	setPreviewArtifactRootForTesting(artifactRoot);
});

afterAll(() => {
	setPreviewRootForTesting(undefined);
	setPreviewArtifactRootForTesting(undefined);
	setPreviewFsForTesting(undefined);
	setPreviewArtifactFsForTesting(undefined);
});

async function resetSession(sessionId = SID): Promise<void> {
	try {
		await removeMount(sessionId);
	} catch (error) {
		// memfs both retains ghost entries and implements symlink rename as a
		// target move. Production cleanup must still propagate these failures, so
		// contain only this test-double reset incompatibility here.
		if (!["ENOTEMPTY", "ESTALE"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
	}
	memoryFs.rmSync(mountPath(sessionId), { recursive: true, force: true });
	try {
		await removeArtifacts(sessionId);
	} catch (error) {
		if (!["ENOTEMPTY", "ESTALE"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
	}
	memoryFs.rmSync(path.join(artifactRoot, sessionId), { recursive: true, force: true });
}

function readLive(sessionId: string, rel: string): string {
	return memoryFs.readFileSync(path.join(mountPath(sessionId), ...rel.split("/")), "utf-8");
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(r => { resolve = r; });
	return { promise, resolve };
}

async function nextTurn(): Promise<void> {
	await new Promise<void>(resolve => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, attempts = 1_000): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (predicate()) return;
		await nextTurn();
	}
	throw new Error("condition did not become true");
}

function substituteDirectoryAfterEnumeration(
	treeRoot: string,
	victim: string,
	outside: string,
	calls: string[],
): PreviewAsyncFs {
	let substituted = false;
	let currentTreeRoot = path.resolve(treeRoot);
	const victimRelative = path.relative(path.resolve(treeRoot), path.resolve(victim));
	const identityOverrides = new Map<string, { dev: number | bigint; ino: number | bigint }>();
	return {
		...baseAsyncFs,
		lstat: async filePath => {
			const absolute = path.resolve(String(filePath));
			const stats = await baseAsyncFs.lstat(filePath);
			const identity = identityOverrides.get(absolute);
			return identity
				? new Proxy(stats, {
					get: (target, property) => {
						if (property === "dev" || property === "ino") return identity[property];
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				})
				: stats;
		},
		rename: async (oldPath, newPath) => {
			const oldAbsolute = path.resolve(String(oldPath));
			const newAbsolute = path.resolve(String(newPath));
			const oldStats = await baseAsyncFs.lstat(oldPath);
			if (oldStats.isSymbolicLink()) {
				// memfs rename follows a symlink and moves its target, unlike Node. Keep
				// this injected race Node-faithful and retain the claimed link identity.
				const linkTarget = await memoryFs.promises.readlink(oldPath);
				await baseAsyncFs.unlink(oldPath);
				await memoryFs.promises.symlink(linkTarget, newPath);
				identityOverrides.set(newAbsolute, { dev: oldStats.dev, ino: oldStats.ino });
			} else {
				await baseAsyncFs.rename(oldPath, newPath);
			}
			if (oldAbsolute === currentTreeRoot) currentTreeRoot = newAbsolute;
		},
		opendir: async filePath => {
			const absolute = path.resolve(String(filePath));
			calls.push(`opendir:${absolute}`);
			const directory = await baseAsyncFs.opendir(filePath);
			if (absolute !== currentTreeRoot) return directory;
			return {
				read: async () => {
					const entry = await directory.read();
					if (!substituted && entry?.name === path.basename(victim)) {
						substituted = true;
						const currentVictim = path.join(currentTreeRoot, victimRelative);
						memoryFs.rmSync(currentVictim, { recursive: true, force: true });
						memoryFs.symlinkSync(outside, currentVictim);
					}
					return entry;
				},
				close: () => directory.close(),
			} as fs.Dir;
		},
		open: async (filePath, flags) => {
			calls.push(`open:${path.resolve(String(filePath))}`);
			return baseAsyncFs.open(filePath, flags);
		},
		copyFile: async (source, destination, mode) => {
			calls.push(`copy:${path.resolve(String(source))}`);
			await baseAsyncFs.copyFile(source, destination, mode);
		},
		unlink: async filePath => {
			calls.push(`unlink:${path.resolve(String(filePath))}`);
			await baseAsyncFs.unlink(filePath);
		},
	};
}

function substitutePathAtOpen(
	victim: string,
	calls: string[],
	substitute: () => void,
): PreviewAsyncFs {
	let substituted = false;
	return {
		...baseAsyncFs,
		open: async (filePath, flags, mode) => {
			const absolute = path.resolve(String(filePath));
			calls.push(`open:${absolute}`);
			if (!substituted && absolute === path.resolve(victim)) {
				substituted = true;
				substitute();
			}
			const handle = await baseAsyncFs.open(filePath, flags, mode);
			return {
				read: async (...args: Parameters<typeof handle.read>) => {
					calls.push(`read:${absolute}`);
					return handle.read(...args);
				},
				write: (...args: Parameters<typeof handle.write>) => handle.write(...args),
				stat: (...args: Parameters<typeof handle.stat>) => handle.stat(...args),
				chmod: (newMode: number) => handle.chmod(newMode),
				close: () => handle.close(),
			} as unknown as fs.promises.FileHandle;
		},
	};
}

function substituteFileAtOpen(victim: string, outsideFile: string, calls: string[]): PreviewAsyncFs {
	return substitutePathAtOpen(victim, calls, () => {
		memoryFs.unlinkSync(victim);
		memoryFs.symlinkSync(outsideFile, victim);
	});
}

function substituteArtifactMetadataAfterLstat(
	victim: string,
	outsideFile: string,
	calls: string[],
): PreviewAsyncFs {
	const atOpen = substituteFileAtOpen(victim, outsideFile, calls);
	let pathnameReadSubstituted = false;
	return {
		...atOpen,
		readFile: async (filePath, encoding) => {
			const absolute = path.resolve(String(filePath));
			if (!pathnameReadSubstituted && absolute === path.resolve(victim)) {
				pathnameReadSubstituted = true;
				memoryFs.unlinkSync(victim);
				memoryFs.symlinkSync(outsideFile, victim);
			}
			calls.push(`read:${absolute}`);
			return baseAsyncFs.readFile(filePath, encoding);
		},
	};
}

function candidateRecord(
	artifactId: string,
	mounted: Awaited<ReturnType<typeof writeInline>>,
	overrides: Partial<PreviewArtifactRecord> = {},
): PreviewArtifactRecord {
	return {
		artifactId,
		sessionId: SID,
		entry: mounted.entry,
		contentHash: mounted.contentHash,
		createdAt: 1,
		mtime: mounted.mtime,
		files: [mounted.entry],
		...overrides,
	};
}

function writeCandidate(
	artifactId: string,
	mounted: Awaited<ReturnType<typeof writeInline>>,
	opts: { metadata?: PreviewArtifactRecord | string; body?: string; omitEntry?: boolean } = {},
): void {
	const dir = artifactDir(SID, artifactId);
	const mount = artifactMountDir(SID, artifactId);
	memoryFs.mkdirSync(mount, { recursive: true });
	if (!opts.omitEntry) memoryFs.writeFileSync(path.join(mount, mounted.entry), opts.body ?? readLive(SID, mounted.entry));
	if (opts.metadata !== undefined) {
		memoryFs.writeFileSync(
			path.join(dir, "artifact.json"),
			typeof opts.metadata === "string" ? opts.metadata : JSON.stringify(opts.metadata),
		);
	}
}

describe("preview artifacts", () => {
	it("stores exact bytes, sorted POSIX files, and stable nested binary hashes", async () => {
		await resetSession();
		const mounted = await writeInline(SID, "<h1>v1</h1>", "report.html");
		const live = mountPath(SID);
		memoryFs.mkdirSync(path.join(live, "z", "deep"), { recursive: true });
		memoryFs.mkdirSync(path.join(live, "a"), { recursive: true });
		memoryFs.writeFileSync(path.join(live, "z", "deep", "bytes.bin"), Buffer.from([0, 255, 1, 128]));
		memoryFs.writeFileSync(path.join(live, "a", "first.txt"), "first");
		const outside = path.join(root, "outside-tree");
		memoryFs.mkdirSync(outside, { recursive: true });
		memoryFs.writeFileSync(path.join(outside, "secret.txt"), "must-not-be-followed");
		memoryFs.symlinkSync(outside, path.join(live, "linked-tree"));
		mounted.contentHash = await contentHashForMount(SID);
		const stableHash = await contentHashForMount(SID);
		const reference = crypto.createHash("sha256");
		for (const rel of ["a/first.txt", "report.html", "z/deep/bytes.bin"]) {
			reference.update(rel, "utf-8");
			reference.update("\0");
			reference.update(memoryFs.readFileSync(path.join(live, ...rel.split("/"))));
			reference.update("\0");
		}
		const artifact = await persistPreviewArtifact(SID, mounted);

		assert.equal(stableHash, reference.digest("hex"));
		assert.equal(artifact.contentHash, stableHash);
		assert.deepEqual(artifact.files, ["a/first.txt", "report.html", "z/deep/bytes.bin"]);
		assert.deepEqual(await readPreviewArtifact(SID, artifact.artifactId), artifact);
		assert.deepEqual(
			memoryFs.readFileSync(path.join(artifactMountDir(SID, artifact.artifactId), "z", "deep", "bytes.bin")),
			Buffer.from([0, 255, 1, 128]),
		);
		assert.equal(memoryFs.existsSync(path.join(artifactMountDir(SID, artifact.artifactId), "linked-tree")), false);
	});

	it("reuses the first exact candidate while skipping corrupt, missing, mismatched, and hash-invalid candidates", async () => {
		await resetSession();
		const mounted = await writeInline(SID, "exact", "report.html");
		memoryFs.mkdirSync(path.join(artifactRoot, SID), { recursive: true });
		writeCandidate("aaaaaa", mounted, { metadata: "{" });
		writeCandidate("bbbbbb", mounted);
		writeCandidate("cccccc", mounted, {
			metadata: candidateRecord("cccccc", mounted),
			body: "wrong bytes",
		});
		writeCandidate("dddddd", mounted, {
			metadata: candidateRecord("dddddd", mounted, { contentHash: "0".repeat(64) }),
		});
		writeCandidate("eeeeee", mounted, {
			metadata: candidateRecord("eeeeee", mounted),
			omitEntry: true,
		});
		writeCandidate("ffffff", mounted, { metadata: candidateRecord("ffffff", mounted) });
		writeCandidate("gggggg", mounted, { metadata: candidateRecord("gggggg", mounted) });

		const exactOrder = memoryFs.readdirSync(path.join(artifactRoot, SID), { withFileTypes: true })
			.filter(ent => ent.isDirectory() && (ent.name === "ffffff" || ent.name === "gggggg"))
			.map(ent => ent.name);
		const found = await findPreviewArtifactByHash(SID, mounted.contentHash);
		assert.equal(found?.artifactId, exactOrder[0]);
		const reused = await persistPreviewArtifact(SID, mounted);
		assert.equal(reused.artifactId, exactOrder[0]);
	});

	it("rejects artifact metadata replaced by an external symlink before descriptor reads", async () => {
		await resetSession();
		const artifactId = "metaaa";
		const mounted = await writeInline(SID, "inside", "report.html");
		const record = candidateRecord(artifactId, mounted);
		writeCandidate(artifactId, mounted, { metadata: record });

		const metadataFile = path.join(artifactDir(SID, artifactId), "artifact.json");
		const outsideDirectory = path.join(root, "metadata-race-outside");
		const outsideFile = path.join(outsideDirectory, "external.json");
		memoryFs.mkdirSync(outsideDirectory, { recursive: true });
		memoryFs.writeFileSync(outsideFile, JSON.stringify({ ...record, createdAt: 999 }));
		const calls: string[] = [];
		setPreviewArtifactFsForTesting(substituteArtifactMetadataAfterLstat(metadataFile, outsideFile, calls));
		try {
			await assert.rejects(
				readPreviewArtifact(SID, artifactId),
				(error: any) => error instanceof PreviewArtifactError && error.statusCode === 500,
			);
			assert.ok(calls.includes(`open:${path.resolve(metadataFile)}`), "metadata substitution did not run");
			assert.equal(calls.some(call => call.startsWith("read:")), false);
			assert.equal(memoryFs.readFileSync(outsideFile, "utf-8"), JSON.stringify({ ...record, createdAt: 999 }));
		} finally {
			setPreviewArtifactFsForTesting(memoryFs);
			memoryFs.rmSync(outsideDirectory, { recursive: true, force: true });
		}
	});

	it("restores immutable bytes and leaves live content unchanged on validation failures", async () => {
		await resetSession(SID);
		await resetSession(SID_B);
		const original = await writeInline(SID, "original", "report.html");
		memoryFs.mkdirSync(path.join(mountPath(SID), "assets"));
		memoryFs.writeFileSync(path.join(mountPath(SID), "assets", "a.txt"), "asset-v1");
		original.contentHash = await contentHashForMount(SID);
		const artifact = await persistPreviewArtifact(SID, original);
		await writeInline(SID, "stable", "report.html");
		await writeInline(SID_B, "other-stable", "report.html");

		await assert.rejects(
			restorePreviewArtifact(SID_B, artifact.artifactId),
			(error: any) => error instanceof PreviewArtifactError && error.statusCode === 404,
		);
		assert.equal(readLive(SID_B, "report.html"), "other-stable");

		memoryFs.writeFileSync(path.join(artifactMountDir(SID, artifact.artifactId), "report.html"), "corrupted");
		await assert.rejects(
			restorePreviewArtifact(SID, artifact.artifactId),
			(error: any) => error instanceof PreviewArtifactError && error.statusCode === 500,
		);
		assert.equal(readLive(SID, "report.html"), "stable");
	});

	it("restores a valid deep artifact", async () => {
		await resetSession();
		const mounted = await writeInline(SID, "original", "report.html");
		let dir = mountPath(SID);
		for (let depth = 0; depth < 80; depth++) dir = path.join(dir, `d${depth}`);
		memoryFs.mkdirSync(dir, { recursive: true });
		memoryFs.writeFileSync(path.join(dir, "tail.bin"), Buffer.from([4, 3, 2, 1]));
		mounted.contentHash = await contentHashForMount(SID);
		const artifact = await persistPreviewArtifact(SID, mounted);
		await writeInline(SID, "current", "report.html");
		const restored = await restorePreviewArtifact(SID, artifact.artifactId);
		assert.equal(restored.contentHash, mounted.contentHash);
		assert.equal(readLive(SID, "report.html"), "original");
		assert.deepEqual(memoryFs.readFileSync(path.join(dir, "tail.bin")), Buffer.from([4, 3, 2, 1]));
	});

	it("keeps scans asynchronous and caps wide directory opens at the shared ceiling", async () => {
		await resetSession();
		const mounted = await writeInline(SID, "wide", "report.html");
		for (let index = 0; index < 32; index++) {
			const dir = path.join(mountPath(SID), `wide-${index}`);
			memoryFs.mkdirSync(dir);
			memoryFs.writeFileSync(path.join(dir, "value.txt"), String(index));
		}
		mounted.contentHash = await contentHashForMount(SID);

		const gate = deferred();
		let active = 0;
		let maximum = 0;
		const deferredFs: PreviewAsyncFs = {
			...baseAsyncFs,
			opendir: async filePath => {
				if (String(filePath) !== mountPath(SID)) {
					active++;
					maximum = Math.max(maximum, active);
					await gate.promise;
					active--;
				}
				return baseAsyncFs.opendir(filePath);
			},
		};
		setPreviewArtifactFsForTesting(deferredFs);
		let settled = false;
		const pending = persistPreviewArtifact(SID, mounted).finally(() => { settled = true; });
		await nextTurn();
		await nextTurn();
		assert.equal(settled, false);
		assert.ok(maximum > 1, `expected concurrent directory opens, got ${maximum}`);
		assert.ok(maximum <= 8, `directory-open concurrency exceeded ceiling: ${maximum}`);
		gate.resolve();
		await pending;
		setPreviewArtifactFsForTesting(memoryFs);
	});

	it("backpressures wide scans and walks deep mounts without recursive scheduling", async () => {
		const wideRoot = path.join(root, "bounded-wide");
		memoryFs.mkdirSync(wideRoot, { recursive: true });
		const width = 512;
		for (let index = 0; index < width; index++) {
			const child = path.join(wideRoot, `child-${String(index).padStart(4, "0")}`);
			memoryFs.mkdirSync(child);
			memoryFs.writeFileSync(path.join(child, "value.txt"), String(index));
		}

		const gate = deferred();
		let rootReads = 0;
		let active = 0;
		let maximum = 0;
		const isDirectChild = (filePath: fs.PathLike): boolean => {
			const relative = path.relative(wideRoot, path.resolve(String(filePath)));
			return relative.length > 0 && !relative.includes(path.sep);
		};
		const hold = async (): Promise<void> => {
			active++;
			maximum = Math.max(maximum, active);
			await gate.promise;
			active--;
		};
		const boundedFs: PreviewAsyncFs = {
			...baseAsyncFs,
			lstat: async filePath => {
				if (isDirectChild(filePath)) await hold();
				return baseAsyncFs.lstat(filePath);
			},
			opendir: async filePath => {
				if (isDirectChild(filePath)) await hold();
				const directory = await baseAsyncFs.opendir(filePath);
				if (path.resolve(String(filePath)) !== path.resolve(wideRoot)) return directory;
				return {
					read: async () => {
						rootReads++;
						return directory.read();
					},
					close: () => directory.close(),
				} as fs.Dir;
			},
		};
		const pending = listMountFiles(wideRoot, { fs: boundedFs, concurrency: 2 });
		await waitUntil(() => active === 2);
		assert.ok(rootReads <= 6, `wide directory read ahead was not backpressured: ${rootReads}`);
		assert.ok(maximum <= 2, `scan concurrency exceeded injected ceiling: ${maximum}`);
		gate.resolve();
		const wideFiles = await pending;
		assert.equal(wideFiles.length, width);
		assert.deepEqual(wideFiles, [...wideFiles].sort());

		const deepRoot = path.join(root, "bounded-deep");
		let leaf = deepRoot;
		for (let depth = 0; depth < 512; depth++) leaf = path.join(leaf, "d");
		memoryFs.mkdirSync(leaf, { recursive: true });
		memoryFs.writeFileSync(path.join(leaf, "tail.txt"), "tail");
		const deepFiles = await listMountFiles(deepRoot, { fs: baseAsyncFs, concurrency: 2 });
		assert.equal(deepFiles.length, 1);
		assert.equal(deepFiles[0]!.split("/").at(-1), "tail.txt");
		memoryFs.rmSync(wideRoot, { recursive: true, force: true });
		memoryFs.rmSync(deepRoot, { recursive: true, force: true });
	});

	it("does not hash or copy through a directory replaced by a symlink after enumeration", async () => {
		const outside = path.join(root, "race-outside-read");
		memoryFs.mkdirSync(outside, { recursive: true });
		memoryFs.writeFileSync(path.join(outside, "secret.txt"), "outside-secret");

		const makeTree = (label: string) => {
			const tree = path.join(root, label);
			const victim = path.join(tree, "switch");
			memoryFs.mkdirSync(victim, { recursive: true });
			memoryFs.writeFileSync(path.join(tree, "safe.txt"), "safe");
			memoryFs.writeFileSync(path.join(victim, "inside.txt"), "inside");
			return { tree, victim };
		};

		const hashTree = makeTree("race-hash");
		const hashCalls: string[] = [];
		const hashFs = substituteDirectoryAfterEnumeration(hashTree.tree, hashTree.victim, outside, hashCalls);
		const actualHash = await hashMountDirectory(hashTree.tree, { fs: hashFs, concurrency: 2 });
		const expectedHash = crypto.createHash("sha256")
			.update("safe.txt", "utf-8").update("\0").update("safe").update("\0").digest("hex");
		assert.equal(actualHash, expectedHash);
		assert.equal(hashCalls.includes(`opendir:${path.resolve(hashTree.victim)}`), false);
		assert.equal(hashCalls.some(call => call.includes("secret.txt")), false);

		const copyTree = makeTree("race-copy");
		const copyTarget = path.join(root, "race-copy-target");
		const copyCalls: string[] = [];
		const copyFs = substituteDirectoryAfterEnumeration(copyTree.tree, copyTree.victim, outside, copyCalls);
		await copyPreviewDirectory(copyTree.tree, copyTarget, { fs: copyFs, concurrency: 2 });
		assert.deepEqual(memoryFs.readdirSync(copyTarget), ["safe.txt"]);
		assert.equal(memoryFs.readFileSync(path.join(copyTarget, "safe.txt"), "utf-8"), "safe");
		assert.equal(copyCalls.includes(`opendir:${path.resolve(copyTree.victim)}`), false);
		assert.equal(copyCalls.some(call => call.includes("secret.txt")), false);
		assert.equal(memoryFs.readFileSync(path.join(outside, "secret.txt"), "utf-8"), "outside-secret");
		memoryFs.rmSync(hashTree.tree, { recursive: true, force: true });
		memoryFs.rmSync(copyTree.tree, { recursive: true, force: true });
		memoryFs.rmSync(copyTarget, { recursive: true, force: true });
		memoryFs.rmSync(outside, { recursive: true, force: true });
	});

	it("rejects file substitutions before hash or preview-directory copy can read external bytes", async () => {
		const outside = path.join(root, "race-file-outside");
		const hashTree = path.join(root, "race-file-hash");
		const copyTree = path.join(root, "race-file-copy");
		const copyTarget = path.join(root, "race-file-copy-target");
		const ancestorTree = path.join(root, "race-file-ancestor");
		for (const candidate of [outside, hashTree, copyTree, copyTarget, ancestorTree]) {
			memoryFs.rmSync(candidate, { recursive: true, force: true });
		}
		const outsideFile = path.join(outside, "secret.txt");
		memoryFs.mkdirSync(outside, { recursive: true });
		memoryFs.writeFileSync(outsideFile, "outside-secret");

		const hashVictim = path.join(hashTree, "victim.txt");
		memoryFs.mkdirSync(hashTree, { recursive: true });
		memoryFs.writeFileSync(hashVictim, "inside");
		const hashCalls: string[] = [];
		await assert.rejects(hashMountDirectory(hashTree, {
			fs: substituteFileAtOpen(hashVictim, outsideFile, hashCalls),
			concurrency: 1,
		}), /regular file|symbolic link|symlink|changed during traversal/i);
		assert.equal(hashCalls.some(call => call.startsWith("read:")), false);

		const copyVictim = path.join(copyTree, "victim.txt");
		memoryFs.mkdirSync(copyTree, { recursive: true });
		memoryFs.writeFileSync(copyVictim, "inside");
		const copyCalls: string[] = [];
		await assert.rejects(copyPreviewDirectory(copyTree, copyTarget, {
			fs: substituteFileAtOpen(copyVictim, outsideFile, copyCalls),
			concurrency: 1,
		}), /regular file|symbolic link|symlink|changed during traversal/i);
		assert.equal(copyCalls.some(call => call.startsWith("read:")), false);
		assert.equal(memoryFs.existsSync(path.join(copyTarget, "victim.txt")), false);
		assert.equal(memoryFs.readFileSync(outsideFile, "utf-8"), "outside-secret");

		const ancestorParent = path.join(ancestorTree, "nested");
		const ancestorVictim = path.join(ancestorParent, "victim.txt");
		const outsideVictim = path.join(outside, "victim.txt");
		memoryFs.mkdirSync(ancestorParent, { recursive: true });
		memoryFs.writeFileSync(ancestorVictim, "inside");
		memoryFs.writeFileSync(outsideVictim, "ancestor-secret");
		const ancestorCalls: string[] = [];
		await assert.rejects(hashMountDirectory(ancestorTree, {
			fs: substitutePathAtOpen(ancestorVictim, ancestorCalls, () => {
				memoryFs.rmSync(ancestorParent, { recursive: true, force: true });
				memoryFs.symlinkSync(outside, ancestorParent);
			}),
			concurrency: 1,
		}), /expected root|regular file|symbolic link|symlink/i);
		assert.equal(ancestorCalls.some(call => call.startsWith("read:")), false);
		assert.equal(memoryFs.readFileSync(outsideVictim, "utf-8"), "ancestor-secret");

		memoryFs.rmSync(hashTree, { recursive: true, force: true });
		memoryFs.rmSync(copyTree, { recursive: true, force: true });
		memoryFs.rmSync(copyTarget, { recursive: true, force: true });
		memoryFs.rmSync(ancestorTree, { recursive: true, force: true });
		memoryFs.rmSync(outside, { recursive: true, force: true });
	});

	it("unlinks a directory symlink substituted after enumeration without deleting its target", async () => {
		const tree = path.join(root, "race-delete");
		const victim = path.join(tree, "switch");
		const outside = path.join(root, "race-outside-delete");
		memoryFs.rmSync(tree, { recursive: true, force: true });
		memoryFs.rmSync(outside, { recursive: true, force: true });
		memoryFs.mkdirSync(victim, { recursive: true });
		memoryFs.writeFileSync(path.join(victim, "inside.txt"), "inside");
		memoryFs.mkdirSync(outside, { recursive: true });
		memoryFs.writeFileSync(path.join(outside, "secret.txt"), "outside-secret");
		const calls: string[] = [];
		const raceFs = substituteDirectoryAfterEnumeration(tree, victim, outside, calls);

		await removePreviewTree(tree, { fs: raceFs, concurrency: 2 });

		assert.equal(memoryFs.existsSync(tree), false);
		assert.equal(memoryFs.readFileSync(path.join(outside, "secret.txt"), "utf-8"), "outside-secret");
		assert.equal(calls.includes(`opendir:${path.resolve(victim)}`), false);
		assert.equal(calls.some(call => call.includes("secret.txt")), false);
		assert.equal(
			calls.some(call => call.startsWith("unlink:") && path.basename(call.slice("unlink:".length)).startsWith(".bobbit-remove-")),
			true,
			"the substituted link must be unlinked only after its own quarantine detach",
		);
		memoryFs.rmSync(outside, { recursive: true, force: true });
	});

	it("cleanup yields while deletion is deferred, is idempotent, and isolates sweep failures", async () => {
		await resetSession(SID);
		await resetSession(SID_B);
		await persistPreviewArtifact(SID, await writeInline(SID, "a", "a.html"));
		await persistPreviewArtifact(SID_B, await writeInline(SID_B, "b", "b.html"));

		const gate = deferred();
		let held = false;
		let sidQuarantine = "";
		const deferredFs: PreviewAsyncFs = {
			...baseAsyncFs,
			rename: async (oldPath, newPath) => {
				await baseAsyncFs.rename(oldPath, newPath);
				if (path.resolve(String(oldPath)) === path.resolve(path.join(artifactRoot, SID))) {
					sidQuarantine = path.resolve(String(newPath));
				}
			},
			unlink: async filePath => {
				const absolute = path.resolve(String(filePath));
				if (!held && sidQuarantine && absolute.startsWith(`${sidQuarantine}${path.sep}`)) {
					held = true;
					await gate.promise;
				}
				return baseAsyncFs.unlink(filePath);
			},
		};
		setPreviewArtifactFsForTesting(deferredFs);
		let progressed = false;
		setImmediate(() => { progressed = true; });
		const removal = removeArtifacts(SID);
		await nextTurn();
		assert.equal(progressed, true);
		gate.resolve();
		await removal;
		await removeArtifacts(SID);

		let failingQuarantine = "";
		const failingFs: PreviewAsyncFs = {
			...baseAsyncFs,
			rename: async (oldPath, newPath) => {
				await baseAsyncFs.rename(oldPath, newPath);
				if (path.resolve(String(oldPath)) === path.resolve(path.join(artifactRoot, SID_B))) {
					failingQuarantine = path.resolve(String(newPath));
				}
			},
			rmdir: async filePath => {
				if (failingQuarantine && path.resolve(String(filePath)) === failingQuarantine) {
					const error = new Error("denied") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				return baseAsyncFs.rmdir(filePath);
			},
		};
		const unknown = "99999999-8888-7777-6666-555555555555";
		memoryFs.mkdirSync(path.join(artifactRoot, unknown));
		memoryFs.writeFileSync(path.join(artifactRoot, unknown, "stale.txt"), "x");
		setPreviewArtifactFsForTesting(failingFs);
		const swept = await sweepOrphanArtifacts([]);
		assert.ok(swept.removed.includes(unknown));
		assert.ok(!swept.removed.includes(SID_B));
		assert.equal(memoryFs.existsSync(path.join(artifactRoot, unknown)), false);
		assert.equal(memoryFs.existsSync(path.join(artifactRoot, SID_B)), true);
		setPreviewArtifactFsForTesting(memoryFs);
	});
});
