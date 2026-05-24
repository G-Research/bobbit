import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	mountDir,
	mountFile,
	removeMount,
	setPreviewRootForTesting,
	writeInline,
} from "../src/server/preview/mount.ts";
import {
	artifactDir,
	artifactMountDir,
	persistPreviewArtifact,
	PreviewArtifactError,
	readPreviewArtifact,
	removeArtifacts,
	restorePreviewArtifact,
	setPreviewArtifactRootForTesting,
	sweepOrphanArtifacts,
} from "../src/server/preview/artifacts.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const SID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let root: string;
let previewRoot: string;
let artifactRoot: string;

before(() => {
	root = mkdtempSync(path.join(tmpdir(), "bobbit-preview-artifacts-"));
	previewRoot = path.join(root, "preview");
	artifactRoot = path.join(root, "preview-artifacts");
	setPreviewRootForTesting(previewRoot);
	setPreviewArtifactRootForTesting(artifactRoot);
});

after(() => {
	setPreviewRootForTesting(undefined);
	setPreviewArtifactRootForTesting(undefined);
	try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

function resetSession(sessionId = SID): void {
	removeMount(sessionId);
	removeArtifacts(sessionId);
}

function readLive(sessionId: string, rel: string): string {
	return readFileSync(path.join(mountDir(sessionId), ...rel.split("/")), "utf-8");
}

describe("preview artifacts", () => {
	it("stores exact mounted bytes and metadata", () => {
		resetSession();
		const mounted = writeInline(SID, "<h1>v1</h1>", "report.html");
		const artifact = persistPreviewArtifact(SID, mounted);

		assert.match(artifact.artifactId, /^[A-Za-z0-9_-]{6,64}$/);
		assert.equal(artifact.sessionId, SID);
		assert.equal(artifact.entry, "report.html");
		assert.equal(artifact.contentHash, mounted.contentHash);
		assert.deepEqual(artifact.files, ["report.html"]);
		assert.equal(readFileSync(path.join(artifactMountDir(SID, artifact.artifactId), "report.html"), "utf-8"), "<h1>v1</h1>");

		const record = readPreviewArtifact(SID, artifact.artifactId);
		assert.deepEqual(record, artifact);
		assert.equal(existsSync(path.join(artifactDir(SID, artifact.artifactId), "artifact.json")), true);
	});

	it("dedupes the same contentHash within a session", () => {
		resetSession();
		const firstMount = writeInline(SID, "<h1>same</h1>", "same.html");
		const first = persistPreviewArtifact(SID, firstMount);
		const secondMount = writeInline(SID, "<h1>same</h1>", "same.html");
		const second = persistPreviewArtifact(SID, secondMount);

		assert.equal(firstMount.contentHash, secondMount.contentHash);
		assert.equal(second.artifactId, first.artifactId);
	});

	it("restores immutable bytes without reading the original source path", () => {
		resetSession();
		const src = mkdtempSync(path.join(tmpdir(), "bobbit-preview-artifact-src-"));
		try {
			const entry = path.join(src, "report.html");
			writeFileSync(entry, `<!doctype html><body>original<img src="assets/a.txt"></body>`);
			mkdirSync(path.join(src, "assets"));
			writeFileSync(path.join(src, "assets", "a.txt"), "asset-v1");

			const mounted = mountFile(SID, entry, ["assets/a.txt"]);
			const artifact = persistPreviewArtifact(SID, mounted);

			writeFileSync(entry, `<!doctype html><body>mutated</body>`);
			writeFileSync(path.join(src, "assets", "a.txt"), "asset-v2");
			writeInline(SID, "<h1>current</h1>", "report.html");
			rmSync(src, { recursive: true, force: true });

			const restored = restorePreviewArtifact(SID, artifact.artifactId);
			assert.equal(restored.artifactId, artifact.artifactId);
			assert.equal(restored.contentHash, mounted.contentHash);
			assert.equal(restored.entry, "report.html");
			assert.equal(readLive(SID, "report.html"), `<!doctype html><body>original<img src="assets/a.txt"></body>`);
			assert.equal(readLive(SID, "assets/a.txt"), "asset-v1");
		} finally {
			rmSync(src, { recursive: true, force: true });
		}
	});

	it("missing, wrong-session, and corrupt artifacts fail without mutating the live mount", () => {
		resetSession(SID);
		resetSession(SID_B);
		const mounted = writeInline(SID, "<h1>artifact</h1>", "report.html");
		const artifact = persistPreviewArtifact(SID, mounted);
		writeInline(SID, "<h1>stable</h1>", "report.html");
		writeInline(SID_B, "<h1>other-stable</h1>", "report.html");

		assert.throws(
			() => restorePreviewArtifact(SID_B, artifact.artifactId),
			(err: any) => err instanceof PreviewArtifactError && err.statusCode === 404,
		);
		assert.equal(readLive(SID_B, "report.html"), "<h1>other-stable</h1>");

		assert.throws(
			() => restorePreviewArtifact(SID, "missing_artifact"),
			(err: any) => err instanceof PreviewArtifactError && err.statusCode === 404,
		);
		assert.equal(readLive(SID, "report.html"), "<h1>stable</h1>");

		writeFileSync(path.join(artifactMountDir(SID, artifact.artifactId), "report.html"), "corrupted");
		assert.throws(
			() => restorePreviewArtifact(SID, artifact.artifactId),
			(err: any) => err instanceof PreviewArtifactError && err.statusCode === 500,
		);
		assert.equal(readLive(SID, "report.html"), "<h1>stable</h1>");
	});

	it("removeArtifacts is idempotent", () => {
		resetSession();
		const mounted = writeInline(SID, "<h1>x</h1>", "x.html");
		const artifact = persistPreviewArtifact(SID, mounted);
		assert.equal(existsSync(artifactDir(SID, artifact.artifactId)), true);
		removeArtifacts(SID);
		removeArtifacts(SID);
		assert.equal(existsSync(path.join(artifactRoot, SID)), false);
	});

	it("sweeps only artifact directories for unknown sessions", () => {
		resetSession(SID);
		resetSession(SID_B);
		persistPreviewArtifact(SID, writeInline(SID, "<h1>a</h1>", "a.html"));
		persistPreviewArtifact(SID_B, writeInline(SID_B, "<h1>b</h1>", "b.html"));

		const result = sweepOrphanArtifacts([SID]);
		assert.deepEqual(result.kept, [SID]);
		assert.deepEqual(result.removed, [SID_B]);
		assert.equal(existsSync(path.join(artifactRoot, SID)), true);
		assert.equal(existsSync(path.join(artifactRoot, SID_B)), false);
	});
});
