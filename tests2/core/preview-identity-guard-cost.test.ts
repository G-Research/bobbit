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
	type PreviewAsyncFs,
} from "../../src/server/preview/mount.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const SID_SCALE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

interface OperationCounts {
	lstat: number;
	realpath: number;
	open: number;
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
		assert.ok(counts.lstat <= candidateCount * 55 + files.length * 140 + 100, `lstat count multiplied: ${counts.lstat}`);
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
		assert.ok(hashCounts.lstat <= narrowHashCounts.lstat * 2 + 40, `hash lstat scaling multiplied: ${narrowHashCounts.lstat} -> ${hashCounts.lstat}`);
		assert.ok(hashCounts.lstat <= files.length * 65 + 100, `hash lstat count multiplied: ${hashCounts.lstat}`);

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
		assert.ok(copyCounts.lstat <= files.length * 100 + 100, `copy lstat count multiplied: ${copyCounts.lstat}`);
	});
});
