import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import {
	computeServerPrebundleKey,
	ensureServerTestPrebundle,
	serverPrebundleResolver,
	validateServerPrebundle,
} from "../../scripts/testing-v2/server-prebundle.mjs";

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const graphSha256 = (manifest: Record<string, unknown>): string => createHash("sha256").update(JSON.stringify({
	runtime: manifest.runtime,
	entries: manifest.entries,
	files: manifest.files,
})).digest("hex");

function fakeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "bobbit-prebundle-key-"));
	mkdirSync(join(root, "src", "server"), { recursive: true });
	mkdirSync(join(root, "src", "shared"), { recursive: true });
	mkdirSync(join(root, "src", "foundation"), { recursive: true });
	mkdirSync(join(root, "src", "ui"), { recursive: true });
	mkdirSync(join(root, "tests2", "harness"), { recursive: true });
	writeFileSync(join(root, "src", "server", "server.ts"), "export { sharedValue as value } from '../shared/value.js';\n");
	writeFileSync(join(root, "src", "shared", "value.ts"), "import { foundationValue } from '../foundation/value.js';\nexport const sharedValue = foundationValue;\n");
	writeFileSync(join(root, "src", "foundation", "value.ts"), "export const foundationValue = 1;\n");
	writeFileSync(join(root, "src", "ui", "unrelated.ts"), "export const unrelated = 1;\n");
	writeFileSync(join(root, "tests2", "harness", "server-runtime-entry.ts"), "export * as server from '../../src/server/server.js';\n");
	writeFileSync(join(root, "tsconfig.server.json"), "{}\n");
	writeFileSync(join(root, "package-lock.json"), "{}\n");
	return root;
}

function writeSchema3Artifact(dir: string, key = "key") {
	const contents: Record<string, string> = {
		"entries/runtime.mjs": "r".repeat(2048),
		"entries/server.mjs": "e".repeat(256),
		"chunks/shared.mjs": "c".repeat(256),
		"entries/runtime.mjs.map": "{\"version\":3,\"sources\":[\"runtime.ts\"]}\n",
		"entries/server.mjs.map": "{\"version\":3,\"sources\":[\"server.ts\"]}\n",
		"chunks/shared.mjs.map": "{\"version\":3,\"sources\":[\"shared.ts\"]}\n",
	};
	for (const [relativeFile, content] of Object.entries(contents)) {
		const file = join(dir, ...relativeFile.split("/"));
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
	const entries = {
		"tests2/harness/server-runtime-entry.ts": "entries/runtime.mjs",
		"src/server/server.ts": "entries/server.mjs",
	};
	const files = Object.fromEntries(Object.keys(contents).sort().map((relativeFile) => {
		const file = join(dir, ...relativeFile.split("/"));
		return [relativeFile, { bytes: statSync(file).size, sha256: sha256(file) }];
	}));
	const manifest: Record<string, unknown> = {
		schema: 3,
		key,
		runtime: entries["tests2/harness/server-runtime-entry.ts"],
		entries,
		files,
		entryCount: Object.keys(entries).length,
		fileCount: Object.keys(files).length,
	};
	manifest.graphSha256 = graphSha256(manifest);
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	return { manifest, contents };
}

function rewriteManifest(dir: string, update: (manifest: Record<string, any>) => void): void {
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	update(manifest);
	manifest.graphSha256 = graphSha256(manifest);
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function corruptWithoutResizing(file: string): void {
	const bytes = readFileSync(file);
	bytes[0] ^= 0xff;
	writeFileSync(file, bytes);
}

describe("server test prebundle cache", () => {
	it("changes the content key when server source changes", () => {
		const root = fakeRepo();
		try {
			const before = computeServerPrebundleKey(root);
			writeFileSync(join(root, "src", "server", "server.ts"), "export const value = 2;\n");
			const after = computeServerPrebundleKey(root);
			assert.notEqual(after, before);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("invalidates the key and existing cache when a bundled shared source changes", () => {
		const root = fakeRepo();
		const cacheRoot = mkdtempSync(join(tmpdir(), "bobbit-prebundle-shared-key-"));
		try {
			const before = computeServerPrebundleKey(root);
			const cached = join(cacheRoot, before);
			writeSchema3Artifact(cached, before);
			assert.equal(validateServerPrebundle(cached, before), true);

			writeFileSync(join(root, "src", "shared", "value.ts"), "import { foundationValue } from '../foundation/value.js';\nexport const sharedValue = foundationValue + 1;\n");
			const afterShared = computeServerPrebundleKey(root);
			assert.notEqual(afterShared, before, "bundled src/shared changes must produce a new cache key");
			assert.equal(validateServerPrebundle(cached, afterShared), false, "the old artifact must not validate for the new source graph");

			writeFileSync(join(root, "src", "foundation", "value.ts"), "export const foundationValue = 2;\n");
			const afterTransitive = computeServerPrebundleKey(root);
			assert.notEqual(afterTransitive, afterShared, "transitive repo source families must be part of the key");

			writeFileSync(join(root, "src", "ui", "unrelated.ts"), "export const unrelated = 2;\n");
			assert.equal(computeServerPrebundleKey(root), afterTransitive, "unrelated source families must not balloon the content key");
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(cacheRoot, { recursive: true, force: true });
		}
	});

	it("requires a complete schema 3 entry graph with source maps and hashes", () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-prebundle-schema3-"));
		try {
			assert.equal(validateServerPrebundle(root, "key"), false, "missing artifacts must not be reused");
			writeSchema3Artifact(root);
			assert.equal(validateServerPrebundle(root, "key"), true);
			assert.equal(validateServerPrebundle(root, "stale-key"), false, "stale keys must not be reused");

			writeFileSync(join(root, "entries", "runtime.mjs"), "x");
			rewriteManifest(root, (manifest) => {
				manifest.files["entries/runtime.mjs"] = {
					bytes: 1,
					sha256: sha256(join(root, "entries", "runtime.mjs")),
				};
			});
			assert.equal(validateServerPrebundle(root, "key"), false, "truncated runtime entries must not be reused");

			writeSchema3Artifact(root);
			rewriteManifest(root, (manifest) => { manifest.schema = 2; });
			assert.equal(validateServerPrebundle(root, "key"), false, "schema 2 artifacts must not be reused");

			writeSchema3Artifact(root);
			rewriteManifest(root, (manifest) => {
				delete manifest.files["entries/server.mjs.map"];
				manifest.fileCount = Object.keys(manifest.files).length;
			});
			assert.equal(validateServerPrebundle(root, "key"), false, "every emitted entry must declare its source map");

			writeSchema3Artifact(root);
			rewriteManifest(root, (manifest) => { delete manifest.files["entries/server.mjs"].sha256; });
			assert.equal(validateServerPrebundle(root, "key"), false, "every emitted file must declare its hash");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("rejects corrupted entry, chunk, and source-map artifacts", () => {
		for (const relativeFile of ["entries/server.mjs", "chunks/shared.mjs", "chunks/shared.mjs.map"]) {
			const root = mkdtempSync(join(tmpdir(), "bobbit-prebundle-corrupt-"));
			try {
				writeSchema3Artifact(root);
				corruptWithoutResizing(join(root, ...relativeFile.split("/")));
				assert.equal(validateServerPrebundle(root, "key"), false, `${relativeFile} hash corruption must be rejected`);
			} finally { rmSync(root, { recursive: true, force: true }); }
		}
	});
});

describe("server test prebundle split graph", () => {
	it("lets concurrent consumers reuse one atomically published cache", async () => {
		const repoRoot = fakeRepo();
		const cacheRoot = mkdtempSync(join(tmpdir(), "bobbit-prebundle-concurrent-"));
		const key = computeServerPrebundleKey(repoRoot);
		const lockDir = join(cacheRoot, `.lock-${key}`);
		mkdirSync(lockDir);
		try {
			const consumers = Promise.all([
				ensureServerTestPrebundle({ repoRoot, cacheRoot }),
				ensureServerTestPrebundle({ repoRoot, cacheRoot }),
			]);
			await new Promise<void>((resolve, reject) => {
				setTimeout(() => {
					try {
						const publicationDir = join(cacheRoot, `.publisher-${key}`);
						writeSchema3Artifact(publicationDir, key);
						renameSync(publicationDir, join(cacheRoot, key));
						rmSync(lockDir, { recursive: true, force: true });
						resolve();
					} catch (error) { reject(error); }
				}, 10);
			});
			const results = await consumers;
			assert.deepEqual(results.map((result) => result.cacheHit), [true, true]);
			assert.equal(results[0].key, results[1].key);
			assert.equal(results[0].bundlePath, results[1].bundlePath);
			assert.equal(validateServerPrebundle(results[0].cacheDir, key), true);
			assert.equal(readdirSync(cacheRoot).some((name) => name.startsWith(".tmp-") || name.startsWith(".lock-")), false);
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
			rmSync(cacheRoot, { recursive: true, force: true });
		}
	});

	it("records each entry, shared chunk, source map, byte count, and SHA-256", () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-prebundle-manifest-"));
		try {
			const { manifest } = writeSchema3Artifact(root);
			const entries = manifest.entries as Record<string, string>;
			const files = manifest.files as Record<string, { bytes: number; sha256: string }>;
			assert.equal(manifest.schema, 3);
			assert.equal(manifest.runtime, entries["tests2/harness/server-runtime-entry.ts"]);
			assert.equal(typeof entries["src/server/server.ts"], "string");
			assert.equal(manifest.entryCount, Object.keys(entries).length);
			assert.equal(manifest.fileCount, Object.keys(files).length);
			assert.equal(manifest.graphSha256, graphSha256(manifest));
			for (const [relativeFile, metadata] of Object.entries(files)) {
				const file = join(root, ...relativeFile.split("/"));
				assert.equal(metadata.bytes, statSync(file).size, `${relativeFile} byte count`);
				assert.equal(metadata.sha256, sha256(file), `${relativeFile} SHA-256`);
				if (relativeFile.endsWith(".mjs")) assert.ok(files[`${relativeFile}.map`], `${relativeFile} source map`);
			}
			assert.ok(Object.keys(files).some((file) => file.startsWith("chunks/") && file.endsWith(".mjs")));
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("normalizes case, slashes, and a .js request to the Windows .ts manifest entry", () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-prebundle-resolver-"));
		try {
			writeSchema3Artifact(root);
			const plugin = serverPrebundleResolver(join(root, "manifest.json"), { repoRoot: String.raw`C:\Users\Case\Repo` });
			const resolved = plugin.resolveId(String.raw`c:\USERS\CASE\REPO\SRC\SERVER\SERVER.js`, undefined);
			assert.ok(resolved && typeof resolved === "object");
			assert.equal(resolved.external, true);
			assert.match(resolved.id, /\/entries\/server\.mjs$/i);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});
