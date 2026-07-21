import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { createFsFromVolume, Volume } from "memfs";
import {
	artifactDir,
	artifactMountDir,
	findPreviewArtifactByHash,
	persistPreviewArtifact,
	setPreviewArtifactFsForTesting,
	setPreviewArtifactRootForTesting,
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
	it("keeps 50 unique persists to one cold metadata scan and bounded catalog lookup work", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-persists");
		writeRecord(memoryFs, SID, "initial_candidate", "0".repeat(64), ["report.html"]);
		const counts: CatalogOperationCounts = { metadataOpen: 0, sessionLstat: 0, sessionOpendir: 0 };
		setPreviewArtifactFsForTesting(catalogCountingFs(baseFs, artifactRoot, counts));

		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal(counts.metadataOpen, 1, "cold catalog construction must scan metadata once");
		for (let index = 0; index < 50; index++) {
			const mounted = await writeInline(SID, `unique-${index}`, "report.html");
			await persistPreviewArtifact(SID, mounted);
		}

		assert.equal(counts.metadataOpen, 1, "negative hash lookups must use the complete catalog");
		assert.ok(counts.sessionOpendir <= 52, `persist catalog unexpectedly rescanned metadata roots: ${counts.sessionOpendir}`);
		assert.ok(counts.sessionLstat <= 5_000, `catalog root checks multiplied: ${counts.sessionLstat}`);
	});

	it("keeps same-hash positive validation in stored filesystem order", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-order");
		const hash = writeValidArtifact(memoryFs, SID, "same_hash_a", "same");
		writeValidArtifact(memoryFs, SID, "same_hash_b", "same");
		const ordered = memoryFs.readdirSync(path.join(artifactRoot, SID), { withFileTypes: true })
			.filter(entry => entry.name.startsWith("same_hash_"))
			.map(entry => entry.name);
		const counts: CatalogOperationCounts = { metadataOpen: 0, sessionLstat: 0, sessionOpendir: 0 };
		setPreviewArtifactFsForTesting(catalogCountingFs(baseFs, artifactRoot, counts));

		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal(counts.metadataOpen, 2);
		const found = await findPreviewArtifactByHash(SID, hash);
		assert.equal(found?.artifactId, ordered[0]);
		assert.equal(counts.metadataOpen, 3, "a cached positive must reopen only the first matching metadata record");
	});

	it("invalidates on external candidate addition and preserves filesystem first-valid selection", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-external-add");
		writeRecord(memoryFs, SID, "prior_candidate", "0".repeat(64), ["report.html"]);
		const counts: CatalogOperationCounts = { metadataOpen: 0, sessionLstat: 0, sessionOpendir: 0 };
		setPreviewArtifactFsForTesting(catalogCountingFs(baseFs, artifactRoot, counts));
		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);

		const hash = writeValidArtifact(memoryFs, SID, "external_a", "external");
		writeValidArtifact(memoryFs, SID, "external_b", "external");
		const future = new Date(Date.now() + 60_000);
		memoryFs.utimesSync(path.join(artifactRoot, SID), future, future);
		const exactOrder = memoryFs.readdirSync(path.join(artifactRoot, SID), { withFileTypes: true })
			.filter(entry => entry.name.startsWith("external_"))
			.map(entry => entry.name);

		const found = await findPreviewArtifactByHash(SID, hash);
		assert.equal(found?.artifactId, exactOrder[0]);
		assert.equal(counts.sessionOpendir, 2, "the changed root stamp must force one canonical rescan");
	});

	it("invalidates a corrupt cached positive and rescans once to the later exact candidate", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-corrupt-positive");
		const hash = writeValidArtifact(memoryFs, SID, "cached_same_a", "stable");
		writeValidArtifact(memoryFs, SID, "cached_same_b", "stable");
		const ordered = memoryFs.readdirSync(path.join(artifactRoot, SID), { withFileTypes: true })
			.filter(entry => entry.name.startsWith("cached_same_"))
			.map(entry => entry.name);
		const counts: CatalogOperationCounts = { metadataOpen: 0, sessionLstat: 0, sessionOpendir: 0 };
		setPreviewArtifactFsForTesting(catalogCountingFs(baseFs, artifactRoot, counts));
		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		memoryFs.writeFileSync(path.join(artifactMountDir(SID, ordered[0]!), "report.html"), "corrupt");

		const found = await findPreviewArtifactByHash(SID, hash);
		assert.equal(found?.artifactId, ordered[1]);
		assert.equal(counts.sessionOpendir, 2, "stale positive must perform exactly one canonical rescan");
		assert.equal(counts.metadataOpen, 5, "rescan must reread both candidates after cached validation fails");
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
		const counts: CatalogOperationCounts = { metadataOpen: 0, sessionLstat: 0, sessionOpendir: 0 };
		setPreviewArtifactFsForTesting(catalogCountingFs(baseFs, artifactRoot, counts));

		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal(counts.metadataOpen, 514);
		assert.equal(counts.sessionOpendir, 2, "oversized catalogs must use the canonical scan again");
	});

	it("evicts the least-recently-used session above the 64-session cap", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-session-cap");
		const sessionIds = Array.from({ length: 65 }, (_, index) => generatedSessionId(index + 1));
		for (const sessionId of sessionIds) memoryFs.mkdirSync(path.join(artifactRoot, sessionId), { recursive: true });
		const counts: CatalogOperationCounts = { metadataOpen: 0, sessionLstat: 0, sessionOpendir: 0 };
		setPreviewArtifactFsForTesting(catalogCountingFs(baseFs, artifactRoot, counts));

		for (const sessionId of sessionIds) {
			assert.equal(await findPreviewArtifactByHash(sessionId, "f".repeat(64)), null);
		}
		assert.equal(counts.sessionOpendir, 65);
		assert.equal(await findPreviewArtifactByHash(sessionIds[0]!, "f".repeat(64)), null);
		assert.equal(counts.sessionOpendir, 66, "the oldest session must be cold after LRU eviction");
	});

	it("scans cold caches, answers complete negatives, and clears on filesystem seam reset", async () => {
		const { memoryFs, baseFs, artifactRoot } = fixture("catalog-seam-reset");
		writeRecord(memoryFs, SID, "cold_candidate", "0".repeat(64), ["report.html"]);
		const counts: CatalogOperationCounts = { metadataOpen: 0, sessionLstat: 0, sessionOpendir: 0 };
		const countedFs = catalogCountingFs(baseFs, artifactRoot, counts);
		setPreviewArtifactFsForTesting(countedFs);

		assert.equal(await findPreviewArtifactByHash(SID, "e".repeat(64)), null);
		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal(counts.metadataOpen, 1);
		assert.equal(counts.sessionOpendir, 1);

		setPreviewArtifactFsForTesting(countedFs);
		assert.equal(await findPreviewArtifactByHash(SID, "f".repeat(64)), null);
		assert.equal(counts.metadataOpen, 2);
		assert.equal(counts.sessionOpendir, 2);
	});
});
