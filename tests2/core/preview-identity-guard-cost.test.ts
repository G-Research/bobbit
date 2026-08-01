import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { createFsFromVolume, Volume } from "memfs";
import { RECOVERY_IO_CONCURRENCY } from "../../src/server/agent/bounded-async-work.ts";
import {
	artifactDir,
	artifactMountDir,
	findPreviewArtifactByHash,
	persistPreviewArtifact,
	removeArtifacts,
	setPreviewArtifactFsForTesting,
	setPreviewArtifactRootForTesting,
	sweepOrphanArtifacts,
	type PreviewArtifactRecord,
} from "../../src/server/preview/artifacts.ts";
import {
	copyPreviewDirectory,
	createPreviewAsyncFs,
	hashMountDirectory,
	setPreviewFsForTesting,
	setPreviewRootForTesting,
	writeInline,
	type PreviewAsyncFs,
} from "../../src/server/preview/mount.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const SID_SCALE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

interface OperationCounts {
	lstat: number;
	realpath: number;
	open: number;
}

interface CatalogOperationCounts {
	metadataLstat: number;
	metadataOpen: number;
	sessionLstat: number;
	sessionOpendir: number;
}

function countingFs(base: PreviewAsyncFs, counts: OperationCounts): PreviewAsyncFs {
	return {
		...base,
		lstat: async filePath => {
			counts.lstat++;
			return base.lstat(filePath);
		},
		realpath: async filePath => {
			counts.realpath++;
			return base.realpath(filePath);
		},
		open: async (filePath, flags, mode) => {
			counts.open++;
			return base.open(filePath, flags, mode);
		},
	};
}

function catalogCountingFs(
	base: PreviewAsyncFs,
	artifactRoot: string,
	counts: CatalogOperationCounts,
): PreviewAsyncFs {
	const resolvedRoot = path.resolve(artifactRoot);
	const isSessionRoot = (filePath: fs.PathLike): boolean =>
		path.dirname(path.resolve(String(filePath))) === resolvedRoot;
	return {
		...base,
		lstat: async filePath => {
			if (isSessionRoot(filePath)) counts.sessionLstat++;
			if (path.basename(path.resolve(String(filePath))) === "artifact.json") counts.metadataLstat++;
			return base.lstat(filePath);
		},
		opendir: async filePath => {
			if (isSessionRoot(filePath)) counts.sessionOpendir++;
			return base.opendir(filePath);
		},
		open: async (filePath, flags, mode) => {
			if (path.basename(path.resolve(String(filePath))) === "artifact.json") counts.metadataOpen++;
			return base.open(filePath, flags, mode);
		},
	};
}

function freezeLstatStamps(base: PreviewAsyncFs, filePaths: readonly string[]): PreviewAsyncFs {
	const frozenPaths = new Set(filePaths.map(filePath => path.resolve(filePath)));
	const stableStamps = new Map<string, Pick<fs.Stats, "dev" | "ino" | "mode" | "mtimeMs" | "ctimeMs" | "size" | "nlink">>();
	return {
		...base,
		lstat: async filePath => {
			const stats = await base.lstat(filePath);
			const absolute = path.resolve(String(filePath));
			if (!frozenPaths.has(absolute)) return stats;
			let stamp = stableStamps.get(absolute);
			if (!stamp) {
				stamp = {
					dev: stats.dev,
					ino: stats.ino,
					mode: stats.mode,
					mtimeMs: stats.mtimeMs,
					ctimeMs: stats.ctimeMs,
					size: stats.size,
					nlink: stats.nlink,
				};
				stableStamps.set(absolute, stamp);
			}
			return new Proxy(stats, {
				get: (target, property) => {
					if (property in stamp!) return stamp![property as keyof typeof stamp];
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	};
}

function fixture(label: string): {
	memoryFs: typeof fs;
	baseFs: PreviewAsyncFs;
	root: string;
	previewRoot: string;
	artifactRoot: string;
} {
	const memoryFs = createFsFromVolume(new Volume()) as unknown as typeof fs;
	const root = path.resolve(`/memfs/preview-identity-cost-${label}`);
	const previewRoot = path.join(root, "preview");
	const artifactRoot = path.join(root, "artifacts");
	memoryFs.mkdirSync(previewRoot, { recursive: true });
	memoryFs.mkdirSync(artifactRoot, { recursive: true });
	const baseFs = createPreviewAsyncFs(memoryFs);
	setPreviewRootForTesting(previewRoot);
	setPreviewArtifactRootForTesting(artifactRoot);
	setPreviewFsForTesting(baseFs);
	setPreviewArtifactFsForTesting(baseFs);
	return { memoryFs, baseFs, root, previewRoot, artifactRoot };
}

function stableHash(memoryFs: typeof fs, root: string, files: readonly string[]): string {
	const hash = crypto.createHash("sha256");
	for (const rel of [...files].sort()) {
		hash.update(rel, "utf-8");
		hash.update("\0");
		hash.update(memoryFs.readFileSync(path.join(root, ...rel.split("/"))));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function writeRecord(
	memoryFs: typeof fs,
	sessionId: string,
	artifactId: string,
	contentHash: string,
	files: readonly string[],
): void {
	const directory = artifactDir(sessionId, artifactId);
	memoryFs.mkdirSync(directory, { recursive: true });
	const record: PreviewArtifactRecord = {
		artifactId,
		sessionId,
		entry: "report.html",
		contentHash,
		createdAt: 1,
		mtime: 1,
		files: [...files].sort(),
	};
	memoryFs.writeFileSync(path.join(directory, "artifact.json"), JSON.stringify(record));
}

function writeValidArtifact(
	memoryFs: typeof fs,
	sessionId: string,
	artifactId: string,
	body: string,
): string {
	const mount = artifactMountDir(sessionId, artifactId);
	memoryFs.mkdirSync(mount, { recursive: true });
	memoryFs.writeFileSync(path.join(mount, "report.html"), body);
	const hash = stableHash(memoryFs, mount, ["report.html"]);
	writeRecord(memoryFs, sessionId, artifactId, hash, ["report.html"]);
	return hash;
}

function generatedSessionId(index: number): string {
	return `${index.toString(16).padStart(8, "0")}-1111-2222-3333-${index.toString(16).padStart(12, "0")}`;
}

function emptyCatalogCounts(): CatalogOperationCounts {
	return { metadataLstat: 0, metadataOpen: 0, sessionLstat: 0, sessionOpendir: 0 };
}

function rewriteRecord(
	memoryFs: typeof fs,
	sessionId: string,
	artifactId: string,
	update: (record: PreviewArtifactRecord) => PreviewArtifactRecord,
): void {
	const metadataPath = path.join(artifactDir(sessionId, artifactId), "artifact.json");
	const record = JSON.parse(memoryFs.readFileSync(metadataPath, "utf-8")) as PreviewArtifactRecord;
	memoryFs.writeFileSync(metadataPath, JSON.stringify(update(record)));
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(r => { resolve = r; });
	return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, attempts = 1_000): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (predicate()) return;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	throw new Error("condition did not become true");
}

afterEach(() => {
	setPreviewFsForTesting(undefined);
	setPreviewArtifactFsForTesting(undefined);
	setPreviewRootForTesting(undefined);
	setPreviewArtifactRootForTesting(undefined);
});

describe("preview identity guard operation cost", () => {
	it("keeps multi-candidate metadata lookup and deep exact validation linear", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("candidates");
		const mismatchCount = 24;
		for (let index = 0; index < mismatchCount; index++) {
			writeRecord(memoryFs, SID, `miss_${String(index).padStart(4, "0")}`, index.toString(16).padStart(64, "0"), ["report.html"]);
		}

		const exactId = "exact_candidate";
		const mount = artifactMountDir(SID, exactId);
		memoryFs.mkdirSync(mount, { recursive: true });
		const files = ["report.html"];
		memoryFs.writeFileSync(path.join(mount, "report.html"), "exact");
		let directory = mount;
		for (let depth = 0; depth < 16; depth++) {
			directory = path.join(directory, `d${String(depth).padStart(2, "0")}`);
			memoryFs.mkdirSync(directory);
			const rel = path.relative(mount, path.join(directory, `f${String(depth).padStart(2, "0")}.txt`)).split(path.sep).join("/");
			files.push(rel);
			memoryFs.writeFileSync(path.join(directory, `f${String(depth).padStart(2, "0")}.txt`), `depth-${depth}`);
		}
		const contentHash = stableHash(memoryFs, mount, files);
		writeRecord(memoryFs, SID, exactId, contentHash, files);

		const counts: OperationCounts = { lstat: 0, realpath: 0, open: 0 };
		setPreviewArtifactFsForTesting(countingFs(baseFs, counts));
		const found = await findPreviewArtifactByHash(SID, contentHash);

		assert.equal(found?.artifactId, exactId);
		const candidateCount = mismatchCount + 1;
		assert.equal(counts.open, candidateCount + files.length, "each metadata/file descriptor must open once");
		assert.ok(counts.realpath <= candidateCount * 2 + files.length + 4, `realpath count multiplied: ${counts.realpath}`);
		assert.ok(counts.lstat <= candidateCount * 300 + files.length * 400 + 300, `lstat count multiplied: ${counts.lstat}`);
		assert.equal(memoryFs.existsSync(path.join(artifactRoot, SID, exactId)), true);

		// Compare two candidate widths so a nested/product lstat regression cannot
		// hide under a single absolute ceiling.
		const scaleTarget = "f".repeat(64);
		for (let index = 0; index < 12; index++) {
			writeRecord(memoryFs, SID_SCALE, `scale_${String(index).padStart(4, "0")}`, index.toString(16).padStart(64, "0"), ["report.html"]);
		}
		const narrowCounts: OperationCounts = { lstat: 0, realpath: 0, open: 0 };
		setPreviewArtifactFsForTesting(countingFs(baseFs, narrowCounts));
		assert.equal(await findPreviewArtifactByHash(SID_SCALE, scaleTarget), null);
		for (let index = 12; index < 24; index++) {
			writeRecord(memoryFs, SID_SCALE, `scale_${String(index).padStart(4, "0")}`, index.toString(16).padStart(64, "0"), ["report.html"]);
		}
		const wideCounts: OperationCounts = { lstat: 0, realpath: 0, open: 0 };
		setPreviewArtifactFsForTesting(countingFs(baseFs, wideCounts));
		assert.equal(await findPreviewArtifactByHash(SID_SCALE, scaleTarget), null);
		assert.equal(narrowCounts.open, 12);
		assert.equal(wideCounts.open, 24);
		assert.ok(wideCounts.realpath <= narrowCounts.realpath * 2 + 2);
		assert.ok(wideCounts.lstat <= narrowCounts.lstat * 2 + 20, `candidate scaling multiplied: ${narrowCounts.lstat} -> ${wideCounts.lstat}`);
	});

	it("keeps deep hash and guarded copy operation counts proportional to files", async () => {
		const { memoryFs, baseFs, root } = fixture("tree");
		const trustedRoot = path.join(root, "trusted");
		const source = path.join(trustedRoot, "source");
		const destination = path.join(root, "destination");
		memoryFs.mkdirSync(source, { recursive: true });
		const files: string[] = [];
		let directory = source;
		const appendUntil = (count: number): void => {
			while (files.length < count) {
				const depth = files.length;
				directory = path.join(directory, `d${String(depth).padStart(2, "0")}`);
				memoryFs.mkdirSync(directory);
				const name = `f${String(depth).padStart(2, "0")}.txt`;
				memoryFs.writeFileSync(path.join(directory, name), `value-${depth}`);
				files.push(path.relative(source, path.join(directory, name)).split(path.sep).join("/"));
			}
		};

		appendUntil(10);
		const narrowHashCounts: OperationCounts = { lstat: 0, realpath: 0, open: 0 };
		const narrowHash = await hashMountDirectory(source, {
			fs: countingFs(baseFs, narrowHashCounts),
			trustedRoot,
			concurrency: 2,
		});
		assert.equal(narrowHash, stableHash(memoryFs, source, files));

		appendUntil(20);
		const hashCounts: OperationCounts = { lstat: 0, realpath: 0, open: 0 };
		const hash = await hashMountDirectory(source, {
			fs: countingFs(baseFs, hashCounts),
			trustedRoot,
			concurrency: 2,
		});
		assert.equal(hash, stableHash(memoryFs, source, files));
		assert.equal(narrowHashCounts.open, 10);
		assert.equal(hashCounts.open, files.length);
		assert.ok(hashCounts.realpath <= narrowHashCounts.realpath * 2 + 2, `hash realpath scaling multiplied: ${narrowHashCounts.realpath} -> ${hashCounts.realpath}`);
		assert.ok(hashCounts.lstat <= narrowHashCounts.lstat * 2 + 60, `hash lstat scaling multiplied: ${narrowHashCounts.lstat} -> ${hashCounts.lstat}`);
		assert.ok(hashCounts.lstat <= files.length * 240 + 100, `hash lstat count multiplied: ${hashCounts.lstat}`);

		const copyCounts: OperationCounts = { lstat: 0, realpath: 0, open: 0 };
		await copyPreviewDirectory(source, destination, {
			fs: countingFs(baseFs, copyCounts),
			trustedRoot,
			concurrency: 2,
		});
		assert.deepEqual(
			files.map(rel => memoryFs.readFileSync(path.join(destination, ...rel.split("/")), "utf-8")),
			files.map((_, index) => `value-${index}`),
		);
		assert.equal(copyCounts.open, files.length * 2, "copy must open each source and destination exactly once");
		assert.ok(copyCounts.realpath <= files.length * 8 + 4, `copy realpath count multiplied: ${copyCounts.realpath}`);
		assert.ok(copyCounts.lstat <= files.length * 270 + 100, `copy lstat count multiplied: ${copyCounts.lstat}`);
	});
});

describe("bounded preview artifact catalog", () => {
	it("keeps 50 unique persists to one cold scan while revalidating retained metadata stamps", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-persists");
		writeRecord(memoryFs, SID, "initial_candidate", "0".repeat(64), ["report.html"]);
		const counts = emptyCatalogCounts();
		setPreviewArtifactFsForTesting(catalogCountingFs(baseFs, artifactRoot, counts));

		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal(counts.metadataOpen, 1, "cold catalog construction must scan metadata once");
		for (let index = 0; index < 50; index++) {
			const mounted = await writeInline(SID, `unique-${index}`, "report.html");
			await persistPreviewArtifact(SID, mounted);
		}

		assert.equal(counts.metadataOpen, 51, "each owned install must capture its verified metadata stamp once");
		assert.ok(counts.sessionOpendir <= 52, `persist catalog unexpectedly rescanned metadata roots: ${counts.sessionOpendir}`);
		assert.ok(counts.sessionLstat <= 8_000, `catalog root checks multiplied: ${counts.sessionLstat}`);
	});

	it("revalidates all metadata stamps with the shared concurrency ceiling", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-revalidation-bound");
		for (let index = 0; index < RECOVERY_IO_CONCURRENCY * 2 + 1; index++) {
			writeRecord(memoryFs, SID, `bounded_${String(index).padStart(3, "0")}`, "0".repeat(64), ["report.html"]);
		}
		let hold = false;
		let active = 0;
		let maximum = 0;
		let started = 0;
		const release = deferred();
		const heldFs: PreviewAsyncFs = {
			...baseFs,
			lstat: async filePath => {
				if (hold && path.basename(path.resolve(String(filePath))) === "artifact.json") {
					started++;
					active++;
					maximum = Math.max(maximum, active);
					try { await release.promise; }
					finally { active--; }
				}
				return baseFs.lstat(filePath);
			},
		};
		setPreviewArtifactFsForTesting(heldFs);
		assert.equal(await findPreviewArtifactByHash(SID, "e".repeat(64)), null);

		hold = true;
		const lookup = findPreviewArtifactByHash(SID, "f".repeat(64));
		await waitUntil(() => started === RECOVERY_IO_CONCURRENCY);
		assert.equal(active, RECOVERY_IO_CONCURRENCY);
		assert.equal(maximum, RECOVERY_IO_CONCURRENCY);
		release.resolve();
		assert.equal(await lookup, null);
		assert.equal(started, RECOVERY_IO_CONCURRENCY * 2 + 1);
		assert.ok(maximum <= RECOVERY_IO_CONCURRENCY);
		assert.equal(memoryFs.existsSync(path.join(artifactRoot, SID)), true);
	});

	it("rescans when a candidate is added while cached metadata stamps are being revalidated", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-revalidation-root-race");
		writeRecord(memoryFs, SID, "existing_candidate", "0".repeat(64), ["report.html"]);
		let hold = false;
		let held = false;
		const started = deferred();
		const release = deferred();
		const heldFs: PreviewAsyncFs = {
			...baseFs,
			lstat: async filePath => {
				if (hold && !held && path.basename(path.resolve(String(filePath))) === "artifact.json") {
					held = true;
					started.resolve();
					await release.promise;
				}
				return baseFs.lstat(filePath);
			},
		};
		setPreviewArtifactFsForTesting(heldFs);
		assert.equal(await findPreviewArtifactByHash(SID, "e".repeat(64)), null);
		const expectedHash = crypto.createHash("sha256")
			.update("report.html", "utf-8")
			.update("\0")
			.update("late")
			.update("\0")
			.digest("hex");

		hold = true;
		const lookup = findPreviewArtifactByHash(SID, expectedHash);
		await started.promise;
		assert.equal(writeValidArtifact(memoryFs, SID, "late_candidate", "late"), expectedHash);
		release.resolve();
		assert.equal((await lookup)?.artifactId, "late_candidate");
		assert.equal(memoryFs.existsSync(path.join(artifactRoot, SID, "late_candidate")), true);
	});

	it("rescans a complete negative when existing metadata changes without a parent mutation", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-descendant-negative");
		const artifactId = "metadata_candidate";
		writeRecord(memoryFs, SID, artifactId, "0".repeat(64), ["report.html"]);
		const counts = emptyCatalogCounts();
		setPreviewArtifactFsForTesting(catalogCountingFs(baseFs, artifactRoot, counts));
		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);

		// Rewrite only the existing descendant and deliberately leave the session
		// directory timestamp untouched.
		rewriteRecord(memoryFs, SID, artifactId, record => ({ ...record, contentHash: "e".repeat(64) }));
		const future = new Date(Date.now() + 60_000);
		memoryFs.utimesSync(path.join(artifactDir(SID, artifactId), "artifact.json"), future, future);

		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal(counts.sessionOpendir, 2, "a changed artifact.json stamp must force one canonical rescan");
		assert.equal(counts.metadataOpen, 2);
	});

	it("lets an earlier candidate changed to the cached later hash regain first-valid selection", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-descendant-order");
		const hash = writeValidArtifact(memoryFs, SID, "reorder_a", "same");
		writeValidArtifact(memoryFs, SID, "reorder_b", "same");
		const ordered = memoryFs.readdirSync(path.join(artifactRoot, SID), { withFileTypes: true })
			.filter(entry => entry.name.startsWith("reorder_"))
			.map(entry => entry.name);
		rewriteRecord(memoryFs, SID, ordered[0]!, record => ({ ...record, contentHash: "0".repeat(64) }));
		const counts = emptyCatalogCounts();
		setPreviewArtifactFsForTesting(catalogCountingFs(baseFs, artifactRoot, counts));

		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal((await findPreviewArtifactByHash(SID, hash))?.artifactId, ordered[1]);
		rewriteRecord(memoryFs, SID, ordered[0]!, record => ({ ...record, contentHash: hash }));
		const future = new Date(Date.now() + 60_000);
		memoryFs.utimesSync(path.join(artifactDir(SID, ordered[0]!), "artifact.json"), future, future);

		assert.equal((await findPreviewArtifactByHash(SID, hash))?.artifactId, ordered[0]);
		assert.equal(counts.sessionOpendir, 2, "metadata reorder must invalidate and canonically rescan once");
	});

	it("preserves exact candidate ordering when refreshing after an owned different-hash install", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-owned-order");
		const retainedHash = writeValidArtifact(memoryFs, SID, "retained_a", "retained");
		writeValidArtifact(memoryFs, SID, "retained_b", "retained");
		const retainedOrder = memoryFs.readdirSync(path.join(artifactRoot, SID), { withFileTypes: true })
			.filter(entry => entry.name.startsWith("retained_"))
			.map(entry => entry.name);
		const counts = emptyCatalogCounts();
		setPreviewArtifactFsForTesting(catalogCountingFs(baseFs, artifactRoot, counts));
		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);

		const different = await writeInline(SID, "owned-different", "report.html");
		await persistPreviewArtifact(SID, different);
		assert.equal((await findPreviewArtifactByHash(SID, retainedHash))?.artifactId, retainedOrder[0]);
		assert.equal(counts.sessionOpendir, 2, "owned refresh must carry verified entries without a canonical rescan");
	});

	it("keeps same-hash positive validation in stored order and observes mount-only repair", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-mount-repair");
		const hash = writeValidArtifact(memoryFs, SID, "cached_same_a", "stable");
		writeValidArtifact(memoryFs, SID, "cached_same_b", "stable");
		const ordered = memoryFs.readdirSync(path.join(artifactRoot, SID), { withFileTypes: true })
			.filter(entry => entry.name.startsWith("cached_same_"))
			.map(entry => entry.name);
		const counts = emptyCatalogCounts();
		setPreviewArtifactFsForTesting(catalogCountingFs(baseFs, artifactRoot, counts));
		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		memoryFs.writeFileSync(path.join(artifactMountDir(SID, ordered[0]!), "report.html"), "corrupt");

		assert.equal((await findPreviewArtifactByHash(SID, hash))?.artifactId, ordered[1]);
		assert.equal(counts.sessionOpendir, 2, "stale positive must perform exactly one canonical rescan");
		memoryFs.writeFileSync(path.join(artifactMountDir(SID, ordered[0]!), "report.html"), "stable");
		assert.equal((await findPreviewArtifactByHash(SID, hash))?.artifactId, ordered[0]);
		assert.equal(counts.sessionOpendir, 2, "mount-only repair must remain visible through exact positive validation");
	});

	it("fences a cached negative lookup captured before an owned install", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-install-cached-race");
		writeRecord(memoryFs, SID, "existing_candidate", "0".repeat(64), ["report.html"]);
		const sessionPath = path.join(artifactRoot, SID);
		const counts = emptyCatalogCounts();
		const counted = catalogCountingFs(baseFs, artifactRoot, counts);
		const frozen = freezeLstatStamps(counted, [sessionPath]);
		let holdMetadata = false;
		let held = false;
		const started = deferred();
		const release = deferred();
		const heldFs: PreviewAsyncFs = {
			...frozen,
			lstat: async filePath => {
				if (holdMetadata && !held && path.basename(path.resolve(String(filePath))) === "artifact.json") {
					held = true;
					started.resolve();
					await release.promise;
				}
				return frozen.lstat(filePath);
			},
		};
		setPreviewArtifactFsForTesting(heldFs);
		const missingHash = "f".repeat(64);
		assert.equal(await findPreviewArtifactByHash(SID, missingHash), null);
		assert.equal(counts.metadataOpen, 1);

		const mounted = await writeInline(SID, "installed-after-cached-lookup", "report.html");
		assert.notEqual(mounted.contentHash, missingHash);
		holdMetadata = true;
		const oldLookup = findPreviewArtifactByHash(SID, missingHash);
		await started.promise;
		const installed = await persistPreviewArtifact(SID, mounted);
		assert.equal(counts.metadataOpen, 2, "install refresh must open only its new metadata");
		assert.equal(counts.sessionOpendir, 2);

		release.resolve();
		assert.equal(await oldLookup, null);
		assert.equal(counts.metadataOpen, 4, "the invalidated old lookup must rebuild both metadata entries");
		assert.equal(counts.sessionOpendir, 3, "the old complete claim must not be touched back into the cache");

		assert.equal((await findPreviewArtifactByHash(SID, mounted.contentHash))?.artifactId, installed.artifactId);
		assert.equal(counts.metadataOpen, 5, "the rebuilt catalog must validate the selected installed artifact once");
		assert.equal(counts.sessionOpendir, 3, "the installed artifact must be selected from the rebuilt catalog");
	});

	it("fences a cold catalog scan captured before an owned install", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-install-cold-race");
		const sessionPath = path.join(artifactRoot, SID);
		memoryFs.mkdirSync(sessionPath, { recursive: true });
		const counts = emptyCatalogCounts();
		const counted = catalogCountingFs(baseFs, artifactRoot, counts);
		const frozen = freezeLstatStamps(counted, [sessionPath]);
		let claimedColdDirectory = false;
		let heldEof = false;
		const started = deferred();
		const release = deferred();
		const heldFs: PreviewAsyncFs = {
			...frozen,
			opendir: async filePath => {
				const directory = await frozen.opendir(filePath);
				if (claimedColdDirectory || path.resolve(String(filePath)) !== path.resolve(sessionPath)) return directory;
				claimedColdDirectory = true;
				return new Proxy(directory, {
					get: (target, property) => {
						if (property === "read") {
							return async () => {
								const entry = await target.read();
								if (!entry && !heldEof) {
									heldEof = true;
									started.resolve();
									await release.promise;
								}
								return entry;
							};
						}
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			},
		};
		setPreviewArtifactFsForTesting(heldFs);
		const oldScan = findPreviewArtifactByHash(SID, "f".repeat(64));
		await started.promise;

		const mounted = await writeInline(SID, "installed-after-cold-scan", "report.html");
		const installed = await persistPreviewArtifact(SID, mounted);
		assert.equal(counts.metadataOpen, 1, "post-install refresh must read the installed metadata once");
		assert.equal(counts.sessionOpendir, 3, "cold lookup, persist lookup, and install refresh must each enumerate once");

		release.resolve();
		assert.equal(await oldScan, null);
		assert.equal(counts.metadataOpen, 1, "the stale empty scan must not publish or reopen metadata");
		assert.equal(counts.sessionOpendir, 3);

		assert.equal((await findPreviewArtifactByHash(SID, mounted.contentHash))?.artifactId, installed.artifactId);
		assert.equal(counts.metadataOpen, 2, "the refreshed catalog must validate the selected installed artifact once");
		assert.equal(counts.sessionOpendir, 3, "the stale cold scan must not overwrite the refreshed catalog");
	});

	it("invalidates populated catalogs after removeArtifacts and successful sweep", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-cleanup-invalidation");
		const sessionPaths = [SID, SID_SCALE].map(sessionId => path.resolve(path.join(artifactRoot, sessionId)));
		for (const sessionPath of sessionPaths) memoryFs.mkdirSync(sessionPath, { recursive: true });
		const counts = emptyCatalogCounts();
		const counted = catalogCountingFs(baseFs, artifactRoot, counts);
		setPreviewArtifactFsForTesting(freezeLstatStamps(counted, sessionPaths));
		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal(await findPreviewArtifactByHash(SID_SCALE, "f".repeat(64)), null);

		await removeArtifacts(SID);
		memoryFs.mkdirSync(sessionPaths[0]!, { recursive: true });
		const afterRemove = counts.sessionOpendir;
		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal(counts.sessionOpendir, afterRemove + 1, "removeArtifacts must leave even a same-stamp recreation cold");
		const swept = await sweepOrphanArtifacts([SID]);
		assert.deepEqual(swept.removed, [SID_SCALE]);
		memoryFs.mkdirSync(sessionPaths[1]!, { recursive: true });
		const afterSweep = counts.sessionOpendir;
		assert.equal(await findPreviewArtifactByHash(SID_SCALE, "f".repeat(64)), null);
		assert.equal(counts.sessionOpendir, afterSweep + 1, "successful sweep must leave even a same-stamp recreation cold");
	});

	it("does not retain a catalog assembled before a failed persist", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-failed-persist");
		writeRecord(memoryFs, SID, "existing_candidate", "0".repeat(64), ["report.html"]);
		const mounted = await writeInline(SID, "persist-must-fail", "report.html");
		const counts = emptyCatalogCounts();
		const counted = catalogCountingFs(baseFs, artifactRoot, counts);
		const failingFs: PreviewAsyncFs = {
			...counted,
			mkdir: async (directory, options) => {
				if (path.basename(path.resolve(String(directory))).startsWith(".tmp-")) {
					throw Object.assign(new Error("injected persist failure"), { code: "EIO" });
				}
				return counted.mkdir(directory, options);
			},
		};
		setPreviewArtifactFsForTesting(failingFs);

		await assert.rejects(persistPreviewArtifact(SID, mounted), /injected persist failure/);
		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal(counts.sessionOpendir, 2, "the failed persist must invalidate its freshly populated catalog");
	});

	it("prevents an in-flight old-filesystem scan from publishing after a seam reset", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-inflight-seam");
		writeRecord(memoryFs, SID, "held_candidate", "0".repeat(64), ["report.html"]);
		const oldCounts = emptyCatalogCounts();
		const oldCounted = catalogCountingFs(baseFs, artifactRoot, oldCounts);
		const started = deferred();
		const release = deferred();
		let held = false;
		const oldFs: PreviewAsyncFs = {
			...oldCounted,
			lstat: async filePath => {
				if (!held && path.basename(path.resolve(String(filePath))) === "artifact.json") {
					held = true;
					started.resolve();
					await release.promise;
				}
				return oldCounted.lstat(filePath);
			},
		};
		setPreviewArtifactFsForTesting(oldFs);
		const oldScan = findPreviewArtifactByHash(SID, "f".repeat(64));
		await started.promise;

		const newCounts = emptyCatalogCounts();
		setPreviewArtifactFsForTesting(catalogCountingFs(baseFs, artifactRoot, newCounts));
		release.resolve();
		assert.equal(await oldScan, null);
		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal(newCounts.sessionOpendir, 1, "the old seam must not repopulate the cleared catalog");
		assert.equal(newCounts.metadataOpen, 1);
	});

	it("touches a hot old session and evicts the untouched LRU entry above 64 sessions", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-session-cap");
		const sessionIds = Array.from({ length: 65 }, (_, index) => generatedSessionId(index + 1));
		for (const sessionId of sessionIds) memoryFs.mkdirSync(path.join(artifactRoot, sessionId), { recursive: true });
		const counts = emptyCatalogCounts();
		setPreviewArtifactFsForTesting(catalogCountingFs(baseFs, artifactRoot, counts));

		for (const sessionId of sessionIds.slice(0, 64)) {
			assert.equal(await findPreviewArtifactByHash(sessionId, "f".repeat(64)), null);
		}
		const hot = sessionIds[0]!;
		const untouched = sessionIds[1]!;
		assert.equal(await findPreviewArtifactByHash(hot, "e".repeat(64)), null);
		assert.equal(counts.sessionOpendir, 64, "touching a complete negative must be a cache hit");
		assert.equal(await findPreviewArtifactByHash(sessionIds[64]!, "f".repeat(64)), null);
		assert.equal(await findPreviewArtifactByHash(hot, "d".repeat(64)), null);
		assert.equal(counts.sessionOpendir, 65, "the touched session must remain hot");
		assert.equal(await findPreviewArtifactByHash(untouched, "f".repeat(64)), null);
		assert.equal(counts.sessionOpendir, 66, "the untouched oldest session must be evicted");
	});

	it("leaves sessions above 256 candidates uncached and retains streaming scans", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-candidate-cap");
		for (let index = 0; index < 257; index++) {
			writeRecord(
				memoryFs,
				SID,
				`candidate_${String(index).padStart(4, "0")}`,
				index.toString(16).padStart(64, "0"),
				["report.html"],
			);
		}
		const counts = emptyCatalogCounts();
		setPreviewArtifactFsForTesting(catalogCountingFs(baseFs, artifactRoot, counts));

		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal(counts.metadataOpen, 514);
		assert.equal(counts.sessionOpendir, 2, "oversized catalogs must use the canonical scan again");
	});
});
