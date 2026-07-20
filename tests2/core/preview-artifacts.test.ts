import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createFsFromVolume, Volume } from "memfs";
import {
	contentHashForMount,
	createPreviewAsyncFs,
	mountPath,
	removeMount,
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
	await removeMount(sessionId);
	// memfs retains an empty directory after replacing the same entry via rename;
	// discard that test-double quirk so each artifact fixture starts clean.
	try { memoryFs.rmSync(mountPath(sessionId), { recursive: true, force: true }); } catch { /* ignore */ }
	await removeArtifacts(sessionId);
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

	it("cleanup yields while deletion is deferred, is idempotent, and isolates sweep failures", async () => {
		await resetSession(SID);
		await resetSession(SID_B);
		await persistPreviewArtifact(SID, await writeInline(SID, "a", "a.html"));
		await persistPreviewArtifact(SID_B, await writeInline(SID_B, "b", "b.html"));

		const gate = deferred();
		let held = false;
		const deferredFs: PreviewAsyncFs = {
			...baseAsyncFs,
			unlink: async filePath => {
				if (!held && String(filePath).includes(SID)) {
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

		const failingFs: PreviewAsyncFs = {
			...baseAsyncFs,
			rmdir: async filePath => {
				if (String(filePath) === path.join(artifactRoot, SID_B)) {
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
