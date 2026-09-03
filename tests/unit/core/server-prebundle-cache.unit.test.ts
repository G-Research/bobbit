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
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
	computeE2EDistServerPrebundleKey,
	computeServerPrebundleKey,
	ensureE2EDistServerPrebundle,
	ensureServerTestPrebundle,
	serverPrebundleResolver,
	validateE2EDistServerPrebundle,
	validateE2EDistServerPrebundleManifest,
	validateServerPrebundle,
	validateServerPrebundleManifest,
} from "../../../scripts/testing-v2/server-prebundle.mjs";
import {
	bundledRepoSourceFiles,
	resolveBundledSource,
	serverRuntimeRepoSourceFiles,
} from "../../../scripts/testing-v2/repo-source-closure.mjs";

const ACTUAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BASE_SERVER = "export { sharedValue as value } from '../shared/value.js';\n";
const BASE_SHARED = "import { foundationValue } from '../foundation/value.js';\nexport const sharedValue = foundationValue;\n";
const BASE_FOUNDATION = "export const foundationValue = 1;\n";
const BASE_UI = "export const unrelated = 1;\n";
const E2E_RUNTIME_ENTRY = "tests/support/harnesses/e2e/dist-server-runtime-entry.ts";
const E2E_NAMESPACES = {
	server: "dist/server/server.js",
	bobbitDir: "dist/server/bobbit-dir.js",
	scaffold: "dist/server/scaffold.js",
	authToken: "dist/server/auth/token.js",
	rpcBridge: "dist/server/agent/rpc-bridge.js",
	bgProcessManager: "dist/server/agent/bg-process-manager.js",
	modelRegistry: "dist/server/agent/model-registry.js",
	modelCompletion: "dist/server/agent/model-completion.js",
	preferencesStore: "dist/server/agent/preferences-store.js",
	hostTokens: "dist/server/agent/host-tokens.js",
	sessionManager: "dist/server/agent/session-manager.js",
	credentialStore: "dist/server/auth/credential-store.js",
	serverHostApi: "dist/server/extension-host/server-host-api.js",
	moduleHostWorker: "dist/server/extension-host/module-host-worker.js",
	packStore: "dist/server/extension-host/pack-store.js",
	toolActivation: "dist/server/agent/tool-activation.js",
	providerBridgeExtension: "dist/server/agent/provider-bridge-extension.js",
	dockerArgs: "dist/server/agent/docker-args.js",
	projectSandbox: "dist/server/agent/project-sandbox.js",
	git: "dist/server/skills/git.js",
	worktreePaths: "dist/server/skills/worktree-paths.js",
} as const;

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const graphSha256 = (manifest: Record<string, unknown>): string => sha256(JSON.stringify({
	runtime: manifest.runtime,
	namespaces: manifest.namespaces,
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
	mkdirSync(join(root, "tests", "support", "harnesses", "shared"), { recursive: true });
	writeFileSync(join(root, "src", "server", "server.ts"), BASE_SERVER);
	writeFileSync(join(root, "src", "shared", "value.ts"), BASE_SHARED);
	writeFileSync(join(root, "src", "foundation", "value.ts"), BASE_FOUNDATION);
	writeFileSync(join(root, "src", "ui", "unrelated.ts"), BASE_UI);
	writeFileSync(join(root, "tests", "support", "harnesses", "shared", "server-runtime-entry.ts"), "export * as server from '../../../../src/server/server.js';\n");
	writeFileSync(join(root, "tsconfig.server.json"), "{}\n");
	writeFileSync(join(root, "package-lock.json"), "{}\n");
}

function resetFakeRepo(root: string): void {
	writeFileSync(join(root, "src", "server", "server.ts"), BASE_SERVER);
	writeFileSync(join(root, "src", "shared", "value.ts"), BASE_SHARED);
	writeFileSync(join(root, "src", "foundation", "value.ts"), BASE_FOUNDATION);
	writeFileSync(join(root, "src", "ui", "unrelated.ts"), BASE_UI);
}

function writeFakeE2ERepo(root: string): void {
	mkdirSync(join(root, "tests", "support", "harnesses", "e2e"), { recursive: true });
	writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
	writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
	writeFileSync(
		join(root, ...E2E_RUNTIME_ENTRY.split("/")),
		Object.entries(E2E_NAMESPACES)
			.map(([namespace, source]) => `export * as ${namespace} from "../../../../${source}";`)
			.join("\n") + "\n",
	);
	for (const [namespace, source] of Object.entries(E2E_NAMESPACES)) {
		const file = join(root, ...source.split("/"));
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `export const namespace = ${JSON.stringify(namespace)};\n`);
	}
	writeFileSync(join(root, "dist", "server", "shared.js"), "export const sharedIdentity = {};\n");
	writeFileSync(join(root, "dist", "server", "server.js"), [
		'import { sharedIdentity } from "./shared.js";',
		"export function createGateway() { return sharedIdentity; }",
		"export const realCommandRunner = { execFile() {} };",
		"export function __setGitStatusFake() {}",
		"export function invalidateGitStatusCache() {}",
		"",
	].join("\n"));
	writeFileSync(join(root, "dist", "server", "bobbit-dir.js"), "export const originalUrl = import.meta.url;\n");
	writeFileSync(join(root, "dist", "server", "agent", "tool-helper.js"), "export const toolVersion = 1;\n");
	writeFileSync(join(root, "dist", "server", "agent", "tool-activation.js"), [
		'import { condition } from "conditional-pkg";',
		'import { createRequire } from "node:module";',
		'import { toolVersion } from "./tool-helper.js";',
		"const require = createRequire(import.meta.url);",
		'export const nativePath = require.resolve("fake-native");',
		"export const generatedChildSource = `const require = createRequire(import.meta.url);`;",
		"export { condition, toolVersion };",
		"",
	].join("\n"));
	const conditional = join(root, "node_modules", "conditional-pkg");
	mkdirSync(conditional, { recursive: true });
	writeFileSync(join(conditional, "package.json"), '{"type":"module","exports":{"import":"./import.mjs","require":"./require.cjs"}}\n');
	writeFileSync(join(conditional, "import.mjs"), 'export const condition = "import";\n');
	writeFileSync(join(conditional, "require.cjs"), 'exports.condition = "require";\n');
	const native = join(root, "node_modules", "fake-native");
	mkdirSync(native, { recursive: true });
	writeFileSync(join(native, "package.json"), '{"main":"addon.node"}\n');
	writeFileSync(join(native, "addon.node"), "not loaded by the bundle\n");
}

function schema3Fixture(key: string): ArtifactFixture {
	const contents: Record<string, string> = {
		"entries/runtime.mjs": "r".repeat(2048),
		"entries/server.mjs": "e".repeat(256),
		"entries/dom-setup.mjs": "d".repeat(256),
		"chunks/shared.mjs": "c".repeat(256),
		"entries/runtime.mjs.map": "{\"version\":3,\"sources\":[\"runtime.ts\"]}\n",
		"entries/server.mjs.map": "{\"version\":3,\"sources\":[\"server.ts\"]}\n",
		"entries/dom-setup.mjs.map": "{\"version\":3,\"sources\":[\"custom-elements.ts\"]}\n",
		"chunks/shared.mjs.map": "{\"version\":3,\"sources\":[\"shared.ts\"]}\n",
	};
	const entries = {
		"tests/support/harnesses/shared/server-runtime-entry.ts": "entries/runtime.mjs",
		"tests/support/helpers/dom/setup/custom-elements.ts": "entries/dom-setup.mjs",
		"src/server/server.ts": "entries/server.mjs",
	};
	const files = Object.fromEntries(Object.keys(contents).sort().map((relativeFile) => [
		relativeFile,
		{ bytes: Buffer.byteLength(contents[relativeFile]), sha256: sha256(contents[relativeFile]) },
	]));
	const manifest: Record<string, any> = {
		schema: 3,
		key,
		runtime: entries["tests/support/harnesses/shared/server-runtime-entry.ts"],
		entries,
		files,
		entryCount: Object.keys(entries).length,
		fileCount: Object.keys(files).length,
	};
	manifest.graphSha256 = graphSha256(manifest);
	return { manifest, contents };
}

function schema1E2EFixture(key: string): ArtifactFixture {
	const contents: Record<string, string> = {
		"entries/runtime.mjs": "r".repeat(2048),
		"entries/server.mjs": "s".repeat(256),
		"entries/runtime.mjs.map": '{"version":3,"sources":["dist-server-runtime-entry.ts"]}\n',
		"entries/server.mjs.map": '{"version":3,"sources":["server.js"]}\n',
	};
	const entries = {
		[E2E_RUNTIME_ENTRY]: "entries/runtime.mjs",
		[E2E_NAMESPACES.server]: "entries/server.mjs",
	};
	const files = Object.fromEntries(Object.keys(contents).sort().map(relativeFile => [
		relativeFile,
		{ bytes: Buffer.byteLength(contents[relativeFile]), sha256: sha256(contents[relativeFile]) },
	]));
	const manifest: Record<string, any> = {
		schema: 1,
		key,
		runtime: entries[E2E_RUNTIME_ENTRY],
		namespaces: E2E_NAMESPACES,
		entries,
		files,
		entryCount: Object.keys(entries).length,
		fileCount: Object.keys(files).length,
	};
	manifest.graphSha256 = graphSha256(manifest);
	return { manifest, contents };
}

function writeArtifact(dir: string, fixture: ArtifactFixture): void {
	mkdirSync(dir, { recursive: true });
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
let e2eRepoRoot: string;
let e2eRunRoot: string;
let key: string;
let fixture: ArtifactFixture;

beforeAll(() => {
	workspace = mkdtempSync(join(tmpdir(), "bobbit-prebundle-cache-"));
	repoRoot = join(workspace, "repo");
	cacheRoot = join(workspace, "cache");
	artifactDir = join(workspace, "artifact");
	e2eRepoRoot = join(workspace, "e2e-repo");
	e2eRunRoot = join(workspace, "e2e-run");
	writeFakeRepo(repoRoot);
	writeFakeE2ERepo(e2eRepoRoot);
	mkdirSync(e2eRunRoot);
	key = computeServerPrebundleKey(repoRoot);
	fixture = schema3Fixture(key);
	writeArtifact(artifactDir, fixture);
	mkdirSync(cacheRoot);
});

afterAll(() => {
	rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
});

describe.sequential("server test prebundle cache", () => {
	it("shares the runtime-only repository source closure resolver", () => {
		const runtimeEntry = join(repoRoot, "tests", "support", "harnesses", "shared", "server-runtime-entry.ts");
		const serverEntry = join(repoRoot, "src", "server", "server.ts");
		assert.equal(resolveBundledSource("../../../../src/server/server.js", runtimeEntry, repoRoot), serverEntry);
		assert.deepEqual(
			serverRuntimeRepoSourceFiles(repoRoot),
			bundledRepoSourceFiles(repoRoot, [runtimeEntry]),
			"the runtime helper must add no prebundle entry roots",
		);
	});

	it("includes actual transitive shared runtime sources without unrelated server or UI sources", () => {
		const closure = serverRuntimeRepoSourceFiles(ACTUAL_REPO_ROOT);
		assert.equal(closure.every(isAbsolute), true, "the reusable closure must return absolute paths");
		const files = new Set(closure.map((file: string) => relative(ACTUAL_REPO_ROOT, file).replace(/\\/g, "/")));
		assert.equal(files.has("tests/support/harnesses/shared/server-runtime-entry.ts"), true);
		assert.equal(existsSync(join(ACTUAL_REPO_ROOT, "tests", "support", "helpers", "dom", "setup", "custom-elements.ts")), true);
		assert.equal(existsSync(join(ACTUAL_REPO_ROOT, "tests", "support", "data", "dom", "quarantine", "README.md")), true);
		assert.equal(existsSync(join(ACTUAL_REPO_ROOT, "tests2", "dom", "_setup", "custom-elements.ts")), false);
		assert.equal(files.has("src/server/server.ts"), true);
		assert.equal(files.has("src/shared/base-path.ts"), true, "a transitive src/shared runtime dependency must be included");
		assert.equal(files.has("src/server/cli.ts"), false, "an unrelated server entry must not enter the runtime closure");
		assert.equal(files.has("src/ui/components/GitStatusWidget.ts"), false, "unrelated UI must not enter the runtime closure");
	});

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
		assert.equal(manifest.runtime, entries["tests/support/harnesses/shared/server-runtime-entry.ts"]);
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

		const domSetup = plugin.resolveId(String.raw`C:\Users\Case\Repo\tests\support\helpers\dom\setup\custom-elements.js`, undefined);
		assert.ok(domSetup && typeof domSetup === "object");
		assert.equal(domSetup.external, false);
		assert.match(domSetup.id, /\/entries\/dom-setup\.mjs$/i);
	});

	it("pins the exact compiled-dist namespace and shared server identity contract", () => {
		const runtimeEntry = readFileSync(join(ACTUAL_REPO_ROOT, ...E2E_RUNTIME_ENTRY.split("/")), "utf8");
		const exported = Object.fromEntries([...runtimeEntry.matchAll(/^export \* as (\w+) from "\.\.\/\.\.\/\.\.\/\.\.\/(dist\/server\/[^\"]+)";/gm)]
			.map(match => [match[1], match[2]]));
		assert.deepEqual(exported, E2E_NAMESPACES);
		const serverBundle = readFileSync(join(ACTUAL_REPO_ROOT, "scripts", "testing-v2", "server-prebundle.mjs"), "utf8");
		assert.match(serverBundle, /\["createGateway", "realCommandRunner", "__setGitStatusFake", "invalidateGitStatusCache"\]/);
		assert.match(serverBundle, /loaded\.server\?\.\[symbol\] !== directServer\[symbol\]/);
	});

	it("uses a separate compiled-dist schema and invalidates the exact closure, tools, lockfile, and builder contract", () => {
		const baseline = computeE2EDistServerPrebundleKey(e2eRepoRoot);
		assert.notEqual(baseline, computeServerPrebundleKey(repoRoot), "source and compiled-dist keys must remain separate");
		const helper = join(e2eRepoRoot, "dist", "server", "agent", "tool-helper.js");
		writeFileSync(helper, "export const toolVersion = 2;\n");
		const toolChanged = computeE2EDistServerPrebundleKey(e2eRepoRoot);
		assert.notEqual(toolChanged, baseline, "a transitive tool-resolution module must invalidate the key");
		writeFileSync(helper, "export const toolVersion = 1;\n");
		writeFileSync(join(e2eRepoRoot, "package-lock.json"), '{"lockfileVersion":3,"packages":{"node_modules/conditional-pkg":{}}}\n');
		assert.notEqual(computeE2EDistServerPrebundleKey(e2eRepoRoot), baseline, "external dependency resolution must be lock-keyed");
		writeFileSync(join(e2eRepoRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
		assert.equal(computeE2EDistServerPrebundleKey(e2eRepoRoot), baseline);
	});

	it("lets concurrent compiled-dist consumers reuse one atomically published run-owned graph", async () => {
		const e2eKey = computeE2EDistServerPrebundleKey(e2eRepoRoot);
		const e2eCacheRoot = join(e2eRunRoot, "e2e-dist-server-prebundle");
		const finalDir = join(e2eCacheRoot, e2eKey);
		mkdirSync(e2eCacheRoot, { recursive: true });
		const lockDir = join(e2eCacheRoot, `.lock-${e2eKey}`);
		mkdirSync(lockDir);
		const consumers = Promise.all([
			ensureE2EDistServerPrebundle({ repoRoot: e2eRepoRoot, runRoot: e2eRunRoot }),
			ensureE2EDistServerPrebundle({ repoRoot: e2eRepoRoot, runRoot: e2eRunRoot }),
		]);
		await new Promise<void>((resolvePublish, rejectPublish) => setTimeout(() => {
			try {
				writeArtifact(finalDir, schema1E2EFixture(e2eKey));
				rmSync(lockDir, { recursive: true, force: true });
				resolvePublish();
			} catch (error) { rejectPublish(error); }
		}, 10));
		const [first, second] = await consumers;
		assert.deepEqual([first.cacheHit, second.cacheHit], [true, true]);
		assert.equal(first.key, second.key);
		assert.equal(first.bundlePath, second.bundlePath);
		assert.equal(relative(e2eRunRoot, first.cacheDir).replace(/\\/g, "/").startsWith("e2e-dist-server-prebundle/"), true);
		assert.equal(validateE2EDistServerPrebundle(first.cacheDir, first.key), true);
		assert.equal(readdirSync(e2eCacheRoot).some(name => /^\.(?:tmp|lock)-/.test(name)), false);

		const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8"));
		assert.equal(manifest.schema, 1);
		assert.deepEqual(manifest.namespaces, E2E_NAMESPACES);
		assert.equal(manifest.entryCount, Object.keys(manifest.entries).length);
		assert.equal(manifest.fileCount, Object.keys(manifest.files).length);
		for (const [output, metadata] of Object.entries(manifest.files) as Array<[string, { bytes: number; sha256: string }]>) {
			const bytes = readFileSync(join(first.cacheDir, ...output.split("/")));
			assert.equal(metadata.bytes, bytes.byteLength, `${output} byte count`);
			assert.equal(metadata.sha256, sha256(bytes), `${output} SHA-256`);
			if (output.endsWith(".mjs")) assert.ok(manifest.files[`${output}.map`], `${output} source map`);
		}
	});

	it("pins conditional/native externals, original-dist import.meta.url, generated strings, and atomic winner reuse", () => {
		const source = readFileSync(join(ACTUAL_REPO_ROOT, "scripts", "testing-v2", "server-prebundle.mjs"), "utf8");
		assert.match(source, /const requireFromCheckout = createRequire\(join\(repoRoot, "package\.json"\)\)/);
		assert.match(source, /args\.kind === "require-call" \? resolved\.path : pathToFileURL\(resolved\.path\)\.href/);
		assert.match(source, /if \(isBuiltin\(args\.path\)\) return \{ path: args\.path, external: true \}/);
		assert.match(source, /sourceUrlPlugin\(absoluteRepoRoot, \{ sourceRoots: \[distServerRoot\], webSourceRoots: \[\] \}\)/);
		assert.match(source, /define: \{ "import\.meta\.url": JSON\.stringify\(pathToFileURL\(args\.path\)\.href\) \}/);
		assert.match(source, /includes\("createRequire\(import\.meta\.url\)"\)/);
		assert.match(source, /catch \(error\) \{\s*if \(!validateE2EDistServerPrebundle\(finalDir, key\)\) throw error;/);
	});

	it("rejects corrupt outputs, stale schemas, traversal, and symlink escapes", async () => {
		const built = await ensureE2EDistServerPrebundle({ repoRoot: e2eRepoRoot, runRoot: e2eRunRoot });
		const manifest = JSON.parse(readFileSync(built.manifestPath, "utf8"));
		const stale = structuredClone(manifest);
		stale.schema = 3;
		assert.equal(validateE2EDistServerPrebundleManifest(stale, built.key, () => undefined), false);
		const traversal = structuredClone(manifest);
		traversal.files["../escape.mjs"] = traversal.files[traversal.runtime];
		traversal.fileCount++;
		traversal.graphSha256 = graphSha256(traversal);
		assert.equal(validateE2EDistServerPrebundleManifest(traversal, built.key, (relativeFile: string) => {
			if (relativeFile === "../escape.mjs") return undefined;
			return traversal.files[relativeFile];
		}), false);

		const corruptTarget = Object.keys(manifest.files).find(file => file.endsWith(".mjs"))!;
		const corruptFile = join(built.cacheDir, ...corruptTarget.split("/"));
		const original = readFileSync(corruptFile);
		writeFileSync(corruptFile, Buffer.concat([original, Buffer.from("corrupt")]));
		assert.equal(validateE2EDistServerPrebundle(built.cacheDir, built.key), false);
		writeFileSync(corruptFile, original);

		const escapedRunRoot = join(workspace, "escaped-run");
		const outside = join(workspace, "outside-cache");
		mkdirSync(escapedRunRoot);
		mkdirSync(outside);
		symlinkSync(outside, join(escapedRunRoot, "e2e-dist-server-prebundle"), process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(
			ensureE2EDistServerPrebundle({ repoRoot: e2eRepoRoot, runRoot: escapedRunRoot }),
			/cache root escaped run root/,
		);
		await assert.rejects(
			ensureE2EDistServerPrebundle({ repoRoot: e2eRepoRoot, runRoot: join(workspace, "missing-run-root") }),
			/runRoot must be an existing directory/,
		);
	});
});
