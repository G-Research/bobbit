import { build, transform } from "esbuild";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundledRepoSourceFiles, normalizeRepoSourcePath } from "./repo-source-closure.mjs";

export { bundledRepoSourceFiles, resolveBundledSource, serverRuntimeRepoSourceFiles } from "./repo-source-closure.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_CACHE_ROOT = join(REPO_ROOT, ".profiles", "testing-v2", "server-prebundle");
const BUNDLE_SCHEMA = 3;
const E2E_DIST_BUNDLE_SCHEMA = 1;
const E2E_DIST_RUNTIME_ENTRY = "tests/support/harnesses/e2e/dist-server-runtime-entry.ts";
const E2E_DIST_NAMESPACE_SOURCES = Object.freeze({
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
});
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_WAIT_MS = 5 * 60_000;

function fileDigest(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function toPosixPath(file) {
	return file.replace(/\\/g, "/");
}

/**
 * Normalize a source path for manifest lookup. Windows paths are compared
 * case-insensitively even when a config is inspected from a non-Windows host.
 */
export const normalizeServerSourcePath = normalizeRepoSourcePath;

function walkFiles(root, filter = /\.(?:ts|js|json)$/) {
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (filter.test(entry.name)) out.push(full);
		}
	};
	walk(root);
	return out.sort((a, b) => normalizeServerSourcePath(a).localeCompare(normalizeServerSourcePath(b)));
}

function serverSourceFiles(repoRoot) {
	return walkFiles(join(repoRoot, "src", "server"), /\.(?:ts|js)$/);
}

/**
 * Shared tier-1 support modules are imported by hundreds of test files. Making
 * them split entries avoids asking every Vitest project to transform the same
 * helper graph while keeping test files themselves under Vitest (for mock
 * hoisting, collection, and coverage).
 */
function testSupportSourceFiles(repoRoot) {
	const roots = [
		join(repoRoot, "tests", "helpers"),
		join(repoRoot, "tests", "e2e", "test-utils"),
		join(repoRoot, "tests", "support", "harnesses", "shared"),
		join(repoRoot, "tests", "support", "harnesses", "unit"),
		join(repoRoot, "tests", "support", "helpers", "unit"),
		join(repoRoot, "tests", "support", "helpers", "dom", "setup"),
		join(repoRoot, "tests", "support", "harnesses", "integration", "gateway"),
		join(repoRoot, "tests", "support", "helpers", "integration", "gateway"),
	];
	return roots.flatMap((root) => existsSync(root) ? walkFiles(root, /\.ts$/) : [])
		.filter((file) => !file.endsWith(".d.ts") && !/\.(?:test|spec)\.ts$/.test(file));
}

/**
 * Explicit high-fanout browser entries proven safe in the isolated DOM project.
 * Keep this narrow: the full web graph contains mock-sensitive modules and
 * Vite-only boundaries that must continue through Vitest's source runner.
 */
function webSourceFiles(repoRoot) {
	return [
		join(repoRoot, "src", "app", "state.ts"),
		join(repoRoot, "src", "ui", "lazy", "safe-markdown-block.ts"),
		join(repoRoot, "src", "ui", "components", "GitStatusWidget.ts"),
	].filter(existsSync);
}

/** Tool extension modules imported directly by tier-1 tests without module mocks. */
function toolSupportSourceFiles(repoRoot) {
	return [
		join(repoRoot, "defaults", "tools", "proposals", "extension.ts"),
		join(repoRoot, "defaults", "tools", "agent", "extension.ts"),
		join(repoRoot, "defaults", "tools", "html", "snapshot.ts"),
		join(repoRoot, "defaults", "tools", "skills", "extension.ts"),
		join(repoRoot, "defaults", "tools", "ask", "extension.ts"),
		join(repoRoot, "defaults", "tools", "browser", "extension.ts"),
		join(repoRoot, "defaults", "tools", "images", "extension.ts"),
		join(repoRoot, "defaults", "tools", "html", "extension.ts"),
		join(repoRoot, "defaults", "tools", "team", "extension.ts"),
		join(repoRoot, "defaults", "tools", "_shared", "gateway.ts"),
	].filter(existsSync);
}

function prebundleSourceEntries(repoRoot) {
	return [
		...serverSourceFiles(repoRoot),
		...webSourceFiles(repoRoot),
		...toolSupportSourceFiles(repoRoot),
		...testSupportSourceFiles(repoRoot),
	];
}

export function computeServerPrebundleKey(repoRoot = REPO_ROOT) {
	const hash = createHash("sha256");
	const runtimeEntry = join(repoRoot, "tests", "support", "harnesses", "shared", "server-runtime-entry.ts");
	const files = [
		...bundledRepoSourceFiles(repoRoot, [runtimeEntry, ...prebundleSourceEntries(repoRoot)]),
		join(repoRoot, "tsconfig.server.json"),
		join(repoRoot, "package-lock.json"),
		join(HERE, "repo-source-closure.mjs"),
		fileURLToPath(import.meta.url),
	];
	for (const file of files) {
		hash.update(toPosixPath(relative(repoRoot, file)));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 24);
}

export function computeE2EDistServerPrebundleKey(repoRoot = REPO_ROOT) {
	const hash = createHash("sha256");
	const runtimeEntry = join(repoRoot, ...E2E_DIST_RUNTIME_ENTRY.split("/"));
	const files = [
		...bundledRepoSourceFiles(repoRoot, [runtimeEntry]),
		join(repoRoot, "package-lock.json"),
		fileURLToPath(import.meta.url),
	];
	hash.update(`e2e-dist-server-prebundle-schema:${E2E_DIST_BUNDLE_SCHEMA}\0`);
	hash.update(JSON.stringify(E2E_DIST_NAMESPACE_SOURCES));
	hash.update("\0");
	for (const file of files) {
		hash.update(toPosixPath(relative(repoRoot, file)));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 24);
}

function readManifest(dir) {
	return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}

function graphDigest(manifest) {
	return createHash("sha256").update(JSON.stringify({
		runtime: manifest.runtime,
		namespaces: manifest.namespaces,
		entries: manifest.entries,
		files: manifest.files,
	})).digest("hex");
}

function validatePrebundleManifest(manifest, key, readArtifact, {
	schema,
	runtimeEntry,
	namespaces,
	minimumEntries = 2,
}) {
	try {
		if (manifest.schema !== schema || manifest.key !== key) return false;
		if (typeof manifest.runtime !== "string" || !manifest.entries || !manifest.files) return false;
		if (typeof manifest.entries[runtimeEntry] !== "string") return false;
		if (manifest.runtime !== manifest.entries[runtimeEntry]) return false;
		if (namespaces && JSON.stringify(manifest.namespaces) !== JSON.stringify(namespaces)) return false;
		if (!namespaces && manifest.namespaces !== undefined) return false;
		if ((manifest.files[manifest.runtime]?.bytes ?? 0) < 1024) return false;
		if (manifest.entryCount !== Object.keys(manifest.entries).length || manifest.entryCount < minimumEntries) return false;
		if (manifest.fileCount !== Object.keys(manifest.files).length || manifest.fileCount < manifest.entryCount * 2) return false;
		if (manifest.graphSha256 !== graphDigest(manifest)) return false;

		const entryOutputs = new Set(Object.values(manifest.entries));
		if (entryOutputs.size !== Object.keys(manifest.entries).length) return false;
		for (const output of entryOutputs) {
			if (typeof output !== "string" || !manifest.files[output]) return false;
		}

		for (const [relativeFile, metadata] of Object.entries(manifest.files)) {
			if (!metadata || typeof metadata.sha256 !== "string" || typeof metadata.bytes !== "number" || metadata.bytes < 0) return false;
			const artifact = readArtifact(relativeFile);
			if (!artifact || artifact.bytes !== metadata.bytes || artifact.sha256 !== metadata.sha256) return false;
			if (/\.mjs$/.test(relativeFile) && !manifest.files[`${relativeFile}.map`]) return false;
		}
		return true;
	} catch {
		return false;
	}
}

export function validateServerPrebundleManifest(manifest, key, readArtifact) {
	return validatePrebundleManifest(manifest, key, readArtifact, {
		schema: BUNDLE_SCHEMA,
		runtimeEntry: "tests/support/harnesses/shared/server-runtime-entry.ts",
	});
}

export function validateE2EDistServerPrebundleManifest(manifest, key, readArtifact) {
	return validatePrebundleManifest(manifest, key, readArtifact, {
		schema: E2E_DIST_BUNDLE_SCHEMA,
		runtimeEntry: E2E_DIST_RUNTIME_ENTRY,
		namespaces: E2E_DIST_NAMESPACE_SOURCES,
		minimumEntries: 2,
	});
}

export function validateServerPrebundle(dir, key) {
	try {
		return validateServerPrebundleManifest(readManifest(dir), key, (relativeFile) => {
			const artifact = join(dir, ...relativeFile.split("/"));
			if (!existsSync(artifact)) return undefined;
			return { bytes: statSync(artifact).size, sha256: fileDigest(artifact) };
		});
	} catch {
		return false;
	}
}

function isContainedPath(root, candidate, { allowRoot = false } = {}) {
	const rel = relative(resolve(root), resolve(candidate));
	if (allowRoot && rel === "") return true;
	return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${win32.sep}`) && !rel.startsWith("../") && !rel.startsWith("..\\");
}

export function validateE2EDistServerPrebundle(dir, key) {
	try {
		const canonicalDir = realpathSync(dir);
		return validateE2EDistServerPrebundleManifest(readManifest(canonicalDir), key, (relativeFile) => {
			if (typeof relativeFile !== "string" || isAbsolute(relativeFile) || relativeFile.split(/[\\/]/).includes("..")) return undefined;
			const artifact = join(canonicalDir, ...relativeFile.split("/"));
			if (!existsSync(artifact)) return undefined;
			const canonicalArtifact = realpathSync(artifact);
			if (!isContainedPath(canonicalDir, canonicalArtifact)) return undefined;
			return { bytes: statSync(canonicalArtifact).size, sha256: fileDigest(canonicalArtifact) };
		});
	} catch {
		return false;
	}
}

function sourceUrlPlugin(repoRoot, options = {}) {
	const webSourceRoots = options.webSourceRoots ?? [
		normalizeServerSourcePath(join(repoRoot, "src", "app")) + "/",
		normalizeServerSourcePath(join(repoRoot, "src", "ui")) + "/",
	];
	const sourceRoots = options.sourceRoots ?? [
		normalizeServerSourcePath(join(repoRoot, "src", "server")) + "/",
		...webSourceRoots,
		normalizeServerSourcePath(join(repoRoot, "defaults", "tools")) + "/",
		normalizeServerSourcePath(join(repoRoot, "tests", "helpers")) + "/",
		normalizeServerSourcePath(join(repoRoot, "tests", "e2e", "test-utils")) + "/",
		normalizeServerSourcePath(join(repoRoot, "tests", "support", "harnesses", "shared")) + "/",
		normalizeServerSourcePath(join(repoRoot, "tests", "support", "harnesses", "unit")) + "/",
		normalizeServerSourcePath(join(repoRoot, "tests", "support", "helpers", "unit")) + "/",
		normalizeServerSourcePath(join(repoRoot, "tests", "support", "helpers", "dom", "setup")) + "/",
		normalizeServerSourcePath(join(repoRoot, "tests", "support", "harnesses", "integration", "gateway")) + "/",
		normalizeServerSourcePath(join(repoRoot, "tests", "support", "helpers", "integration", "gateway")) + "/",
	];
	return {
		name: "bobbit-source-import-meta-url",
		setup(buildApi) {
			buildApi.onLoad({ filter: /\.(?:ts|js)$/ }, async (args) => {
				const normalized = normalizeServerSourcePath(args.path);
				if (!sourceRoots.some((root) => normalized.startsWith(root))) return undefined;
				const source = readFileSync(args.path, "utf8");
				const transformed = await transform(source, {
					loader: args.path.endsWith(".ts") ? "ts" : "js",
					format: "esm",
					target: "node22",
					sourcefile: args.path,
					sourcemap: "inline",
					define: { "import.meta.url": JSON.stringify(pathToFileURL(args.path).href) },
					...(webSourceRoots.some((root) => normalized.startsWith(root)) ? {
						tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
					} : {}),
				});
				return { contents: transformed.code, loader: "js", resolveDir: dirname(args.path) };
			});
		},
	};
}

function importMetaResolveExternalPlugin(repoRoot) {
	const distServerRoot = normalizeServerSourcePath(join(repoRoot, "dist", "server")) + "/";
	return {
		name: "bobbit-import-meta-resolve-external",
		setup(buildApi) {
			buildApi.onResolve({ filter: /^\./ }, (args) => {
				const candidate = resolve(args.resolveDir, args.path);
				const normalized = normalizeServerSourcePath(candidate);
				if (!normalized.startsWith(distServerRoot) || !existsSync(candidate)) return undefined;
				if (!/\bimport\.meta\.resolve\s*\(/.test(readFileSync(candidate, "utf8"))) return undefined;
				// Node must evaluate import.meta.resolve from the checkout so bare
				// package lookups retain the checkout's node_modules ancestry.
				return { path: pathToFileURL(candidate).href, external: true };
			});
		},
	};
}

function checkoutPackageExternalPlugin(repoRoot) {
	const requireFromCheckout = createRequire(join(repoRoot, "package.json"));
	const pluginMarker = Symbol("checkout-package-resolve");
	return {
		name: "bobbit-checkout-package-external",
		setup(buildApi) {
			buildApi.onResolve({ filter: /.*/ }, async (args) => {
				if (args.pluginData === pluginMarker || args.kind === "entry-point" || args.path.startsWith(".") || args.path.startsWith("/")
					|| args.path.startsWith("file:") || /^[A-Za-z]:[\\/]/.test(args.path)) return undefined;
				if (isBuiltin(args.path)) return { path: args.path, external: true };
				const resolved = await buildApi.resolve(args.path, {
					importer: args.importer,
					kind: args.kind,
					resolveDir: args.resolveDir || repoRoot,
					pluginData: pluginMarker,
				});
				if (resolved.errors.length === 0 && resolved.path) {
					return {
						path: args.kind === "require-call" ? resolved.path : pathToFileURL(resolved.path).href,
						external: true,
					};
				}
				// Some CommonJS-only dependencies deliberately lack import exports.
				// Resolve those with Node's checkout-anchored require semantics.
				try {
					const required = requireFromCheckout.resolve(args.path);
					return { path: args.kind === "require-call" ? required : pathToFileURL(required).href, external: true };
				} catch {
					return { errors: resolved.errors };
				}
			});
		},
	};
}

function runtimeEntryNamespaces(repoRoot) {
	const source = readFileSync(join(repoRoot, "tests", "support", "harnesses", "shared", "server-runtime-entry.ts"), "utf8");
	return [...source.matchAll(/^export \* as ([A-Za-z_$][\w$]*) from /gm)].map((match) => match[1]).sort();
}

async function assertBundleParity(bundlePath, directServerEntry, repoRoot, artifactDir, manifest) {
	const nonce = `validate-${process.pid}-${Date.now()}`;
	const loaded = await import(`${pathToFileURL(bundlePath).href}?${nonce}`);
	const directServer = await import(`${pathToFileURL(directServerEntry).href}?${nonce}`);
	const expected = runtimeEntryNamespaces(repoRoot);
	const actual = Object.keys(loaded).sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`[server-prebundle] export parity failed: expected [${expected.join(", ")}], got [${actual.join(", ")}]`);
	}
	if (typeof loaded?.server?.createGateway !== "function" || directServer.createGateway !== loaded.server.createGateway) {
		throw new Error("[server-prebundle] boot parity failed: direct and umbrella server entries do not share identity");
	}
	if (typeof loaded?.gatewayDeps?.realCommandRunner?.execFile !== "function"
		|| loaded.gatewayDeps.realCommandRunner !== loaded.server.realCommandRunner) {
		throw new Error("[server-prebundle] dependency parity failed: shared gatewayDeps.realCommandRunner is missing or duplicated");
	}
	assertGeneratedSourcePreserved(artifactDir, manifest);
}

function assertGeneratedSourcePreserved(artifactDir, manifest) {
	const generatedSourcePreserved = Object.keys(manifest.files)
		.filter((file) => file.endsWith(".mjs"))
		.some((file) => readFileSync(join(artifactDir, ...file.split("/")), "utf8").includes("createRequire(import.meta.url)"));
	if (!generatedSourcePreserved) {
		throw new Error("[server-prebundle] import.meta.url rewrite corrupted a generated child-module source string");
	}
}

export async function assertE2EDistBundleParity(bundlePath, directServerEntry, artifactDir, manifest) {
	const nonce = `validate-e2e-${process.pid}-${Date.now()}`;
	const loaded = await import(`${pathToFileURL(bundlePath).href}?${nonce}`);
	const directServer = await import(`${pathToFileURL(directServerEntry).href}?${nonce}`);
	const expected = Object.keys(E2E_DIST_NAMESPACE_SOURCES).sort();
	const actual = Object.keys(loaded).sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`[e2e-dist-server-prebundle] export parity failed: expected [${expected.join(", ")}], got [${actual.join(", ")}]`);
	}
	for (const symbol of ["createGateway", "realCommandRunner", "__setGitStatusFake", "invalidateGitStatusCache"]) {
		if (loaded.server?.[symbol] !== directServer[symbol]) {
			throw new Error(`[e2e-dist-server-prebundle] server identity failed for ${symbol}`);
		}
	}
	if (typeof loaded.server.realCommandRunner?.execFile !== "function") {
		throw new Error("[e2e-dist-server-prebundle] realCommandRunner is missing");
	}
	assertGeneratedSourcePreserved(artifactDir, manifest);
}

function entryName(source, repoRoot) {
	const relativeSource = toPosixPath(relative(repoRoot, source));
	return relativeSource.replace(/\.(?:ts|js)$/, "");
}

function buildManifest({ key, repoRoot, tempDir, metafile, runtimeEntry, schema = BUNDLE_SCHEMA, namespaces }) {
	const entries = {};
	const files = {};
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		const absoluteOutput = isAbsolute(outputPath) ? outputPath : resolve(repoRoot, outputPath);
		const relativeOutput = toPosixPath(relative(tempDir, absoluteOutput));
		if (relativeOutput.startsWith("../")) throw new Error(`[server-prebundle] output escaped cache directory: ${outputPath}`);
		files[relativeOutput] = { bytes: statSync(absoluteOutput).size, sha256: fileDigest(absoluteOutput) };
		if (output.entryPoint) {
			const absoluteEntry = isAbsolute(output.entryPoint) ? output.entryPoint : resolve(repoRoot, output.entryPoint);
			entries[toPosixPath(relative(repoRoot, absoluteEntry))] = relativeOutput;
		}
	}
	const runtimeKey = toPosixPath(relative(repoRoot, runtimeEntry));
	const runtime = entries[runtimeKey];
	if (!runtime) throw new Error("[server-prebundle] esbuild did not emit the umbrella runtime entry");
	const manifest = {
		schema,
		key,
		createdAt: new Date().toISOString(),
		runtime,
		...(namespaces ? { namespaces } : {}),
		entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))),
		files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
	};
	return {
		...manifest,
		entryCount: Object.keys(manifest.entries).length,
		fileCount: Object.keys(manifest.files).length,
		graphSha256: graphDigest(manifest),
	};
}

async function acquireBuildLock(cacheRoot, key) {
	const lockDir = join(cacheRoot, `.lock-${key}`);
	const startedAt = Date.now();
	for (;;) {
		try {
			mkdirSync(lockDir);
			writeFileSync(join(lockDir, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
			return () => rmSync(lockDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
					rmSync(lockDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
					continue;
				}
			} catch (statError) {
				if (statError?.code === "ENOENT") continue;
				throw statError;
			}
			if (Date.now() - startedAt > LOCK_WAIT_MS) throw new Error(`[server-prebundle] timed out waiting for cache lock: ${lockDir}`);
			await delay(40);
		}
	}
}

function resultFromCache(finalDir, key, cacheHit) {
	const manifestPath = join(finalDir, "manifest.json");
	const manifest = readManifest(finalDir);
	return {
		key,
		bundlePath: join(finalDir, ...manifest.runtime.split("/")),
		manifestPath,
		cacheDir: finalDir,
		cacheHit,
	};
}

export async function ensureServerTestPrebundle({ repoRoot = REPO_ROOT, cacheRoot = DEFAULT_CACHE_ROOT } = {}) {
	const key = computeServerPrebundleKey(repoRoot);
	const finalDir = join(cacheRoot, key);
	if (validateServerPrebundle(finalDir, key)) return resultFromCache(finalDir, key, true);

	mkdirSync(cacheRoot, { recursive: true });
	const releaseLock = await acquireBuildLock(cacheRoot, key);
	try {
		if (validateServerPrebundle(finalDir, key)) return resultFromCache(finalDir, key, true);
		const tempDir = join(cacheRoot, `.tmp-${key}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const runtimeEntry = join(repoRoot, "tests", "support", "harnesses", "shared", "server-runtime-entry.ts");
			const sourceEntries = prebundleSourceEntries(repoRoot);
			const entryPoints = Object.fromEntries(
				[runtimeEntry, ...sourceEntries].map((source) => [entryName(source, repoRoot), source]),
			);
			const buildResult = await build({
				entryPoints,
				outdir: tempDir,
				entryNames: "entries/[dir]/[name]-[hash]",
				chunkNames: "chunks/[name]-[hash]",
				assetNames: "assets/[name]-[hash]",
				outExtension: { ".js": ".mjs" },
				bundle: true,
				splitting: true,
				packages: "external",
				platform: "node",
				format: "esm",
				target: "node22",
				sourcemap: "external",
				sourcesContent: true,
				metafile: true,
				logLevel: "silent",
				plugins: [sourceUrlPlugin(repoRoot)],
			});
			const manifest = buildManifest({ key, repoRoot, tempDir, metafile: buildResult.metafile, runtimeEntry });
			const serverKey = "src/server/server.ts";
			const serverOutput = manifest.entries[serverKey];
			if (!serverOutput) throw new Error(`[server-prebundle] missing direct entry: ${serverKey}`);
			await assertBundleParity(
				join(tempDir, ...manifest.runtime.split("/")),
				join(tempDir, ...serverOutput.split("/")),
				repoRoot,
				tempDir,
				manifest,
			);
			writeFileSync(join(tempDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

			rmSync(finalDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
			renameSync(tempDir, finalDir);
		} catch (error) {
			rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
			throw error;
		}
	} finally {
		releaseLock();
	}
	if (!validateServerPrebundle(finalDir, key)) throw new Error(`[server-prebundle] invalid artifact after build: ${finalDir}`);
	return resultFromCache(finalDir, key, false);
}

function e2eDistCacheRoot(runRoot) {
	if (!runRoot || !existsSync(runRoot)) throw new Error("[e2e-dist-server-prebundle] runRoot must be an existing directory");
	const canonicalRunRoot = realpathSync(runRoot);
	const requestedCacheRoot = join(canonicalRunRoot, "e2e-dist-server-prebundle");
	mkdirSync(requestedCacheRoot, { recursive: true });
	const canonicalCacheRoot = realpathSync(requestedCacheRoot);
	if (!isContainedPath(canonicalRunRoot, canonicalCacheRoot)) {
		throw new Error(`[e2e-dist-server-prebundle] cache root escaped run root: ${canonicalCacheRoot}`);
	}
	return { canonicalRunRoot, cacheRoot: canonicalCacheRoot };
}

export async function ensureE2EDistServerPrebundle({ repoRoot = REPO_ROOT, runRoot } = {}) {
	const absoluteRepoRoot = realpathSync(repoRoot);
	const { canonicalRunRoot, cacheRoot } = e2eDistCacheRoot(runRoot);
	const key = computeE2EDistServerPrebundleKey(absoluteRepoRoot);
	const finalDir = join(cacheRoot, key);
	if (!isContainedPath(canonicalRunRoot, finalDir)) {
		throw new Error(`[e2e-dist-server-prebundle] artifact escaped run root: ${finalDir}`);
	}
	if (validateE2EDistServerPrebundle(finalDir, key)) return resultFromCache(finalDir, key, true);

	const releaseLock = await acquireBuildLock(cacheRoot, key);
	try {
		if (validateE2EDistServerPrebundle(finalDir, key)) return resultFromCache(finalDir, key, true);
		const tempDir = join(cacheRoot, `.tmp-${key}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
		if (!isContainedPath(canonicalRunRoot, tempDir)) {
			throw new Error(`[e2e-dist-server-prebundle] temporary artifact escaped run root: ${tempDir}`);
		}
		mkdirSync(tempDir, { recursive: true });
		try {
			const runtimeEntry = join(absoluteRepoRoot, ...E2E_DIST_RUNTIME_ENTRY.split("/"));
			const namespaceEntries = Object.values(E2E_DIST_NAMESPACE_SOURCES).map((source) => join(absoluteRepoRoot, ...source.split("/")));
			for (const source of [runtimeEntry, ...namespaceEntries]) {
				if (!existsSync(source)) throw new Error(`[e2e-dist-server-prebundle] missing compiled input: ${source}`);
			}
			const serverEntry = join(absoluteRepoRoot, ...E2E_DIST_NAMESPACE_SOURCES.server.split("/"));
			const entryPoints = Object.fromEntries(
				[runtimeEntry, serverEntry].map((source) => [entryName(source, absoluteRepoRoot), source]),
			);
			const distServerRoot = normalizeServerSourcePath(join(absoluteRepoRoot, "dist", "server")) + "/";
			const buildResult = await build({
				absWorkingDir: absoluteRepoRoot,
				entryPoints,
				outdir: tempDir,
				entryNames: "entries/[dir]/[name]-[hash]",
				chunkNames: "chunks/[name]-[hash]",
				assetNames: "assets/[name]-[hash]",
				outExtension: { ".js": ".mjs" },
				bundle: true,
				splitting: true,
				platform: "node",
				format: "esm",
				target: "node22",
				sourcemap: "external",
				sourcesContent: true,
				metafile: true,
				logLevel: "silent",
				plugins: [
					importMetaResolveExternalPlugin(absoluteRepoRoot),
					sourceUrlPlugin(absoluteRepoRoot, { sourceRoots: [distServerRoot], webSourceRoots: [] }),
					checkoutPackageExternalPlugin(absoluteRepoRoot),
				],
			});
			const manifest = buildManifest({
				key,
				repoRoot: absoluteRepoRoot,
				tempDir,
				metafile: buildResult.metafile,
				runtimeEntry,
				schema: E2E_DIST_BUNDLE_SCHEMA,
				namespaces: E2E_DIST_NAMESPACE_SOURCES,
			});
			const serverOutput = manifest.entries[E2E_DIST_NAMESPACE_SOURCES.server];
			if (!serverOutput) throw new Error(`[e2e-dist-server-prebundle] missing direct entry: ${E2E_DIST_NAMESPACE_SOURCES.server}`);
			// Runtime evaluation belongs to focused parity coverage. The exact E2E
			// command validates the immutable graph here without evaluating it twice;
			// a worker-side import failure remains fatal once bundle mode is observed.
			assertGeneratedSourcePreserved(tempDir, manifest);
			writeFileSync(join(tempDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

			rmSync(finalDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
			try {
				renameSync(tempDir, finalDir);
			} catch (error) {
				if (!validateE2EDistServerPrebundle(finalDir, key)) throw error;
				rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
			}
		} catch (error) {
			rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
			throw error;
		}
	} finally {
		releaseLock();
	}
	if (!validateE2EDistServerPrebundle(finalDir, key)) {
		throw new Error(`[e2e-dist-server-prebundle] invalid artifact after build: ${finalDir}`);
	}
	return resultFromCache(finalDir, key, false);
}

function resolveSourceCandidate(source, importer, repoRoot) {
	const request = source.replace(/[?#].*$/, "");
	if (request.startsWith("file:")) return fileURLToPath(request);
	const normalizedRequest = normalizeServerSourcePath(request);
	if (/^[A-Za-z]:\//.test(normalizedRequest)) return normalizedRequest;
	if (isAbsolute(request)) return request;
	if (!request.startsWith(".")) return undefined;
	const rawImporter = importer?.startsWith("file:") ? fileURLToPath(importer) : importer?.replace(/[?#].*$/, "");
	const importerPath = rawImporter ? normalizeServerSourcePath(rawImporter) : undefined;
	return resolve(importerPath ? dirname(importerPath) : repoRoot, request);
}

function manifestKeyForSource(sourcePath, repoRoot, entries) {
	const normalizedSourcePath = normalizeServerSourcePath(sourcePath);
	const normalizedRepoRoot = normalizeServerSourcePath(repoRoot);
	const windowsPath = /^[A-Za-z]:\//.test(normalizedSourcePath) || /^[A-Za-z]:\//.test(normalizedRepoRoot);
	let relativeSource;
	if (windowsPath) relativeSource = win32.relative(normalizedRepoRoot, normalizedSourcePath);
	else relativeSource = relative(normalizedRepoRoot, normalizedSourcePath);
	let key = normalizeServerSourcePath(relativeSource);
	if (windowsPath) key = key.toLowerCase();
	const supported = key.startsWith("src/server/")
		|| key.startsWith("src/app/")
		|| key.startsWith("src/ui/")
		|| key.startsWith("defaults/tools/")
		|| key.startsWith("tests/helpers/")
		|| key.startsWith("tests/e2e/test-utils/")
		|| key.startsWith("tests/support/harnesses/shared/")
		|| key.startsWith("tests/support/harnesses/unit/")
		|| key.startsWith("tests/support/helpers/unit/")
		|| key.startsWith("tests/support/helpers/dom/setup/")
		|| key.startsWith("tests/support/harnesses/integration/gateway/")
		|| key.startsWith("tests/support/helpers/integration/gateway/");
	if (!supported) return undefined;
	if (entries[key]) return key;
	if (extname(key) === ".js") {
		const tsKey = `${key.slice(0, -3)}.ts`;
		if (entries[tsKey]) return tsKey;
	}
	return undefined;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function serverPrebundleExternalPattern(prebundle) {
	const manifestPath = typeof prebundle === "string" ? prebundle : prebundle?.manifestPath;
	if (!manifestPath) throw new Error("[server-prebundle] external pattern requires a prebundle result or manifest path");
	return new RegExp(escapeRegExp(normalizeServerSourcePath(dirname(manifestPath))), "i");
}

/**
 * Vite/Vitest pre-resolver for direct imports under src/server. Pass the object
 * returned by ensureServerTestPrebundle(). The plugin also externalizes emitted
 * entries through Vitest so Node and loadServerTestRuntime share one ESM cache.
 */
export function serverPrebundleResolver(prebundle, { repoRoot = REPO_ROOT, webEntries = true } = {}) {
	const manifestPath = typeof prebundle === "string" ? prebundle : prebundle?.manifestPath;
	if (!manifestPath) throw new Error("[server-prebundle] resolver requires a prebundle result or manifest path");
	const cacheDir = dirname(manifestPath);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const windowsRoot = /^[A-Za-z]:[\\/]/.test(repoRoot);
	const entries = Object.fromEntries(
		Object.entries(manifest.entries ?? {}).map(([source, output]) => {
			const normalized = normalizeServerSourcePath(source);
			return [windowsRoot ? normalized.toLowerCase() : normalized, output];
		}),
	);
	const externalPattern = serverPrebundleExternalPattern(manifestPath);
	const resolverProfile = webEntries ? "dom" : "node";
	return {
		// Project-local plugins share the artifact but not transform semantics:
		// DOM resolves the narrow browser panel while Node must leave it to
		// Vitest so vi.mock hoisting and module-load globals remain effective.
		name: `bobbit-server-prebundle-resolver-${resolverProfile}`,
		enforce: "pre",
		config() {
			return { test: { server: { deps: { external: [externalPattern] } } } };
		},
		configureVitest(context) {
			// Vitest cannot see resolver closure options when hashing plugins. Keep
			// Node and DOM transforms in separate cache namespaces: reusing a DOM
			// transform in v2-core can rewrite state.ts to its eager browser bundle,
			// bypassing node-side mocks and evaluating window at module load.
			context.experimental_defineCacheKeyGenerator(
				() => `bobbit-server-prebundle:${manifest.key}:${resolverProfile}`,
			);
		},
		resolveId(source, importer) {
			const sourcePath = resolveSourceCandidate(source, importer, repoRoot);
			if (!sourcePath) return null;
			const key = manifestKeyForSource(sourcePath, repoRoot, entries);
			if (!key) return null;
			const webEntry = key.startsWith("src/app/") || key.startsWith("src/ui/");
			if (webEntry && !webEntries) return null;
			const output = entries[key];
			const isolatedModule = key.startsWith("tests/support/helpers/dom/setup/") || webEntry;
			return {
				id: pathToFileURL(join(cacheDir, ...output.split("/"))).href,
				// DOM setup and the narrow web graph must execute against every fresh
				// happy-dom environment. Worker-safe support entries share Node ESM
				// identity; node projects keep web sources mockable through Vitest.
				external: !isolatedModule,
				moduleSideEffects: true,
			};
		},
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = await ensureServerTestPrebundle();
	console.log(JSON.stringify(result));
}
