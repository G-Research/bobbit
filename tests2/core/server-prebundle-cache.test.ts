import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
	computeServerPrebundleKey,
	ensureServerTestPrebundle,
	serverPrebundleResolver,
	validateServerPrebundle,
	validateServerPrebundleManifest,
} from "../../scripts/testing-v2/server-prebundle.mjs";

const BASE_SERVER = "export { sharedValue as value } from '../shared/value.js';\n";
const BASE_SHARED = "import { foundationValue } from '../foundation/value.js';\nexport const sharedValue = foundationValue;\n";
const BASE_FOUNDATION = "export const foundationValue = 1;\n";
const BASE_UI = "export const unrelated = 1;\n";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const graphSha256 = (manifest: Record<string, unknown>): string => sha256(JSON.stringify({
	runtime: manifest.runtime,
	entries: manifest.entries,
	files: manifest.files,
}));

type ArtifactFixture = {
	manifest: Record<string, any>;
	contents: Record<string, string>;
};

function writeFakeRepo(root: string): void {
	mkdirSync(join(root, "src", "server"), { recursive: true });
	mkdirSync(join(root, "src", "shared"), { recursive: true });
	mkdirSync(join(root, "src", "foundation"), { recursive: true });
	mkdirSync(join(root, "src", "ui"), { recursive: true });
	mkdirSync(join(root, "tests2", "harness"), { recursive: true });
	writeFileSync(join(root, "src", "server", "server.ts"), BASE_SERVER);
	writeFileSync(join(root, "src", "shared", "value.ts"), BASE_SHARED);
	writeFileSync(join(root, "src", "foundation", "value.ts"), BASE_FOUNDATION);
	writeFileSync(join(root, "src", "ui", "unrelated.ts"), BASE_UI);
	writeFileSync(join(root, "tests2", "harness", "server-runtime-entry.ts"), "export * as server from '../../src/server/server.js';\n");
	writeFileSync(join(root, "tsconfig.server.json"), "{}\n");
	writeFileSync(join(root, "package-lock.json"), "{}\n");
}

function resetFakeRepo(root: string): void {
	writeFileSync(join(root, "src", "server", "server.ts"), BASE_SERVER);
	writeFileSync(join(root, "src", "shared", "value.ts"), BASE_SHARED);
	writeFileSync(join(root, "src", "foundation", "value.ts"), BASE_FOUNDATION);
	writeFileSync(join(root, "src", "ui", "unrelated.ts"), BASE_UI);
}

function schema3Fixture(key: string): ArtifactFixture {
	const contents: Record<string, string> = {
		"entries/runtime.mjs": "r".repeat(2048),
		"entries/server.mjs": "e".repeat(256),
		"chunks/shared.mjs": "c".repeat(256),
		"entries/runtime.mjs.map": "{\"version\":3,\"sources\":[\"runtime.ts\"]}\n",
		"entries/server.mjs.map": "{\"version\":3,\"sources\":[\"server.ts\"]}\n",
		"chunks/shared.mjs.map": "{\"version\":3,\"sources\":[\"shared.ts\"]}\n",
	};
	const entries = {
		"tests2/harness/server-runtime-entry.ts": "entries/runtime.mjs",
		"src/server/server.ts": "entries/server.mjs",
	};
	const files = Object.fromEntries(Object.keys(contents).sort().map((relativeFile) => [
		relativeFile,
		{ bytes: Buffer.byteLength(contents[relativeFile]), sha256: sha256(contents[relativeFile]) },
	]));
	const manifest: Record<string, any> = {
		schema: 3,
		key,
		runtime: entries["tests2/harness/server-runtime-entry.ts"],
		entries,
		files,
		entryCount: Object.keys(entries).length,
		fileCount: Object.keys(files).length,
	};
	manifest.graphSha256 = graphSha256(manifest);
	return { manifest, contents };
}

function writeArtifact(dir: string, fixture: ArtifactFixture): void {
	for (const [relativeFile, content] of Object.entries(fixture.contents)) {
		const file = join(dir, ...relativeFile.split("/"));
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(fixture.manifest, null, 2)}\n`);
}

function validatesFixture(fixture: ArtifactFixture, key = fixture.manifest.key): boolean {
	return validateServerPrebundleManifest(fixture.manifest, key, (relativeFile: string) => {
		const content = fixture.contents[relativeFile];
		return content === undefined
			? undefined
			: { bytes: Buffer.byteLength(content), sha256: sha256(content) };
	});
}

function cloneFixture(fixture: ArtifactFixture): ArtifactFixture {
	return structuredClone(fixture);
}

function refreshGraph(fixture: ArtifactFixture): void {
	fixture.manifest.graphSha256 = graphSha256(fixture.manifest);
}

let workspace: string;
let repoRoot: string;
let cacheRoot: string;
let artifactDir: string;
let key: string;
let fixture: ArtifactFixture;

beforeAll(() => {
	workspace = mkdtempSync(join(tmpdir(), "bobbit-prebundle-cache-"));
	repoRoot = join(workspace, "repo");
	cacheRoot = join(workspace, "cache");
	artifactDir = join(workspace, "artifact");
	writeFakeRepo(repoRoot);
	key = computeServerPrebundleKey(repoRoot);
	fixture = schema3Fixture(key);
	writeArtifact(artifactDir, fixture);
	mkdirSync(cacheRoot);
});

afterAll(() => {
	rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
});

describe.sequential("server test prebundle cache", () => {
	it("keys the exact bundled source closure by content", () => {
		try {
			const baseline = computeServerPrebundleKey(repoRoot);

			writeFileSync(join(repoRoot, "src", "server", "server.ts"), "export const value = 2;\n");
			assert.notEqual(computeServerPrebundleKey(repoRoot), baseline, "server source changes must change the key");
			writeFileSync(join(repoRoot, "src", "server", "server.ts"), BASE_SERVER);

			writeFileSync(join(repoRoot, "src", "shared", "value.ts"), "import { foundationValue } from '../foundation/value.js';\nexport const sharedValue = foundationValue + 1;\n");
			const afterShared = computeServerPrebundleKey(repoRoot);
			assert.notEqual(afterShared, baseline, "bundled src/shared changes must produce a new cache key");

			writeFileSync(join(repoRoot, "src", "foundation", "value.ts"), "export const foundationValue = 2;\n");
			const afterTransitive = computeServerPrebundleKey(repoRoot);
			assert.notEqual(afterTransitive, afterShared, "transitive repo source families must be part of the key");

			writeFileSync(join(repoRoot, "src", "ui", "unrelated.ts"), "export const unrelated = 2;\n");
			assert.equal(computeServerPrebundleKey(repoRoot), afterTransitive, "unrelated source families must not balloon the content key");
		} finally {
			resetFakeRepo(repoRoot);
		}
	});

	it("requires a complete schema 3 entry graph with source maps and hashes", () => {
		assert.equal(validateServerPrebundle(join(workspace, "missing"), key), false, "missing artifacts must not be reused");
		assert.equal(validatesFixture(fixture), true);
		assert.equal(validatesFixture(fixture, "stale-key"), false, "stale keys must not be reused");

		const truncated = cloneFixture(fixture);
		truncated.contents[truncated.manifest.runtime] = "x";
		truncated.manifest.files[truncated.manifest.runtime] = { bytes: 1, sha256: sha256("x") };
		refreshGraph(truncated);
		assert.equal(validatesFixture(truncated), false, "truncated runtime entries must not be reused");

		const oldSchema = cloneFixture(fixture);
		oldSchema.manifest.schema = 2;
		assert.equal(validatesFixture(oldSchema), false, "schema 2 artifacts must not be reused");

		const missingMap = cloneFixture(fixture);
		delete missingMap.manifest.files["entries/server.mjs.map"];
		missingMap.manifest.fileCount = Object.keys(missingMap.manifest.files).length;
		refreshGraph(missingMap);
		assert.equal(validatesFixture(missingMap), false, "every emitted entry must declare its source map");

		const missingHash = cloneFixture(fixture);
		delete missingHash.manifest.files["entries/server.mjs"].sha256;
		refreshGraph(missingHash);
		assert.equal(validatesFixture(missingHash), false, "every emitted file must declare its hash");
	});

	it("rejects corrupted entry, chunk, and source-map artifacts", () => {
		for (const relativeFile of ["entries/server.mjs", "chunks/shared.mjs", "chunks/shared.mjs.map"]) {
			const corrupted = cloneFixture(fixture);
			corrupted.contents[relativeFile] = `!${corrupted.contents[relativeFile].slice(1)}`;
			assert.equal(validatesFixture(corrupted), false, `${relativeFile} hash corruption must be rejected`);
		}
	});

	it("lets concurrent consumers reuse one atomically published cache", async () => {
		const finalDir = join(cacheRoot, key);
		let results;
		if (!existsSync(finalDir)) {
			const lockDir = join(cacheRoot, `.lock-${key}`);
			mkdirSync(lockDir);
			const consumers = Promise.all([
				ensureServerTestPrebundle({ repoRoot, cacheRoot }),
				ensureServerTestPrebundle({ repoRoot, cacheRoot }),
			]);
			await new Promise<void>((resolve, reject) => {
				setTimeout(() => {
					try {
						renameSync(artifactDir, finalDir);
						artifactDir = finalDir;
						rmSync(lockDir, { recursive: true, force: true });
						resolve();
					} catch (error) { reject(error); }
				}, 10);
			});
			results = await consumers;
		} else {
			results = await Promise.all([
				ensureServerTestPrebundle({ repoRoot, cacheRoot }),
				ensureServerTestPrebundle({ repoRoot, cacheRoot }),
			]);
		}
		assert.deepEqual(results.map((result) => result.cacheHit), [true, true]);
		assert.equal(results[0].key, results[1].key);
		assert.equal(results[0].bundlePath, results[1].bundlePath);
		assert.equal(validateServerPrebundle(results[0].cacheDir, key), true);
		assert.equal(readdirSync(cacheRoot).some((name) => name.startsWith(".tmp-") || name.startsWith(".lock-")), false);
	});

	it("records each entry, shared chunk, source map, byte count, and SHA-256", () => {
		const { manifest, contents } = fixture;
		const entries = manifest.entries as Record<string, string>;
		const files = manifest.files as Record<string, { bytes: number; sha256: string }>;
		assert.equal(manifest.schema, 3);
		assert.equal(manifest.runtime, entries["tests2/harness/server-runtime-entry.ts"]);
		assert.equal(typeof entries["src/server/server.ts"], "string");
		assert.equal(manifest.entryCount, Object.keys(entries).length);
		assert.equal(manifest.fileCount, Object.keys(files).length);
		assert.equal(manifest.graphSha256, graphSha256(manifest));
		for (const [relativeFile, metadata] of Object.entries(files)) {
			assert.equal(metadata.bytes, Buffer.byteLength(contents[relativeFile]), `${relativeFile} byte count`);
			assert.equal(metadata.sha256, sha256(contents[relativeFile]), `${relativeFile} SHA-256`);
			if (relativeFile.endsWith(".mjs")) assert.ok(files[`${relativeFile}.map`], `${relativeFile} source map`);
		}
		assert.ok(Object.keys(files).some((file) => file.startsWith("chunks/") && file.endsWith(".mjs")));
	});

	it("normalizes case, slashes, and a .js request to the Windows .ts manifest entry", () => {
		assert.equal(readFileSync(join(artifactDir, "manifest.json"), "utf8").length > 0, true);
		const plugin = serverPrebundleResolver(join(artifactDir, "manifest.json"), { repoRoot: String.raw`C:\Users\Case\Repo` });
		const resolved = plugin.resolveId(String.raw`c:\USERS\CASE\REPO\SRC\SERVER\SERVER.js`, undefined);
		assert.ok(resolved && typeof resolved === "object");
		assert.equal(resolved.external, true);
		assert.match(resolved.id, /\/entries\/server\.mjs$/i);
	});
});
