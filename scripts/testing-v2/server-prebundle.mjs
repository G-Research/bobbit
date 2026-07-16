import { build, transform } from "esbuild";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_CACHE_ROOT = join(REPO_ROOT, ".profiles", "testing-v2", "server-prebundle");
const BUNDLE_SCHEMA = 3;
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
export function normalizeServerSourcePath(file) {
	const withoutQuery = file.replace(/[?#].*$/, "");
	const normalized = toPosixPath(withoutQuery);
	return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

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

const BUNDLED_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const BUNDLED_IMPORT_RE = /(?:\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s*)?|\brequire\s*\(|\bimport\s*\()\s*(["'`])([^"'`]+)\1/gms;

function resolveBundledSource(specifier, importer, repoRoot) {
	if (!specifier.startsWith(".")) return undefined;
	const unresolved = resolve(dirname(importer), specifier.replace(/[?#].*$/, ""));
	const extension = extname(unresolved);
	const candidates = [unresolved];
	if (extension) {
		const stem = unresolved.slice(0, -extension.length);
		if (extension === ".js" || extension === ".jsx") candidates.push(`${stem}.ts`, `${stem}.tsx`);
		else if (extension === ".mjs") candidates.push(`${stem}.mts`);
		else if (extension === ".cjs") candidates.push(`${stem}.cts`);
	} else {
		for (const candidateExtension of BUNDLED_SOURCE_EXTENSIONS) candidates.push(`${unresolved}${candidateExtension}`);
		for (const candidateExtension of BUNDLED_SOURCE_EXTENSIONS) candidates.push(join(unresolved, `index${candidateExtension}`));
	}
	for (const candidate of candidates) {
		const repoRelative = relative(repoRoot, candidate);
		if (repoRelative.startsWith("..") || isAbsolute(repoRelative)) continue;
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch (error) {
			if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
		}
	}
	return undefined;
}

/**
 * Follow only repo-local imports that esbuild can bundle. This keeps the key
 * complete when server modules reach into src/shared (or a future source
 * family) without invalidating the cache for unrelated UI and test sources.
 */
function bundledRepoSourceFiles(repoRoot, roots) {
	const pending = [...roots];
	const discovered = new Map();
	while (pending.length > 0) {
		const file = pending.pop();
		const key = normalizeServerSourcePath(relative(repoRoot, file));
		if (discovered.has(key)) continue;
		discovered.set(key, file);
		if (extname(file) === ".json") continue;
		const source = readFileSync(file, "utf8");
		BUNDLED_IMPORT_RE.lastIndex = 0;
		for (const match of source.matchAll(BUNDLED_IMPORT_RE)) {
			const dependency = resolveBundledSource(match[2], file, repoRoot);
			if (dependency) pending.push(dependency);
		}
	}
	return [...discovered.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, file]) => file);
}

export function computeServerPrebundleKey(repoRoot = REPO_ROOT) {
	const hash = createHash("sha256");
	const runtimeEntry = join(repoRoot, "tests2", "harness", "server-runtime-entry.ts");
	const files = [
		...bundledRepoSourceFiles(repoRoot, [runtimeEntry, ...serverSourceFiles(repoRoot)]),
		join(repoRoot, "tsconfig.server.json"),
		join(repoRoot, "package-lock.json"),
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

function readManifest(dir) {
	return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}

function graphDigest(manifest) {
	return createHash("sha256").update(JSON.stringify({
		runtime: manifest.runtime,
		entries: manifest.entries,
		files: manifest.files,
	})).digest("hex");
}

export function validateServerPrebundle(dir, key) {
	try {
		const manifest = readManifest(dir);
		if (manifest.schema !== BUNDLE_SCHEMA || manifest.key !== key) return false;
		if (typeof manifest.runtime !== "string" || !manifest.entries || !manifest.files) return false;
		if (typeof manifest.entries["tests2/harness/server-runtime-entry.ts"] !== "string") return false;
		if (manifest.runtime !== manifest.entries["tests2/harness/server-runtime-entry.ts"]) return false;
		if ((manifest.files[manifest.runtime]?.bytes ?? 0) < 1024) return false;
		if (manifest.entryCount !== Object.keys(manifest.entries).length || manifest.entryCount < 2) return false;
		if (manifest.fileCount !== Object.keys(manifest.files).length || manifest.fileCount < manifest.entryCount * 2) return false;
		if (manifest.graphSha256 !== graphDigest(manifest)) return false;

		const entryOutputs = new Set(Object.values(manifest.entries));
		if (entryOutputs.size !== Object.keys(manifest.entries).length) return false;
		for (const output of entryOutputs) {
			if (typeof output !== "string" || !manifest.files[output]) return false;
		}

		for (const [relativeFile, metadata] of Object.entries(manifest.files)) {
			if (!metadata || typeof metadata.sha256 !== "string" || typeof metadata.bytes !== "number") return false;
			const artifact = join(dir, ...relativeFile.split("/"));
			if (!existsSync(artifact) || statSync(artifact).size !== metadata.bytes) return false;
			if (metadata.bytes < 0 || fileDigest(artifact) !== metadata.sha256) return false;
			if (/\.mjs$/.test(relativeFile)) {
				const mapFile = `${relativeFile}.map`;
				if (!manifest.files[mapFile]) return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

function sourceUrlPlugin() {
	return {
		name: "bobbit-source-import-meta-url",
		setup(buildApi) {
			buildApi.onLoad({ filter: /[\\/]src[\\/]server[\\/].*\.(?:ts|js)$/ }, async (args) => {
				const source = readFileSync(args.path, "utf8");
				const transformed = await transform(source, {
					loader: args.path.endsWith(".ts") ? "ts" : "js",
					format: "esm",
					target: "node22",
					sourcefile: args.path,
					sourcemap: "inline",
					define: { "import.meta.url": JSON.stringify(pathToFileURL(args.path).href) },
				});
				return { contents: transformed.code, loader: "js", resolveDir: dirname(args.path) };
			});
		},
	};
}

function runtimeEntryNamespaces(repoRoot) {
	const source = readFileSync(join(repoRoot, "tests2", "harness", "server-runtime-entry.ts"), "utf8");
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
	const generatedSourcePreserved = Object.keys(manifest.files)
		.filter((file) => file.endsWith(".mjs"))
		.some((file) => readFileSync(join(artifactDir, ...file.split("/")), "utf8").includes("createRequire(import.meta.url)"));
	if (!generatedSourcePreserved) {
		throw new Error("[server-prebundle] import.meta.url rewrite corrupted a generated child-module source string");
	}
}

function entryName(source, repoRoot) {
	const relativeSource = toPosixPath(relative(repoRoot, source));
	return relativeSource.replace(/\.(?:ts|js)$/, "");
}

function buildManifest({ key, repoRoot, tempDir, metafile, runtimeEntry }) {
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
		schema: BUNDLE_SCHEMA,
		key,
		createdAt: new Date().toISOString(),
		runtime,
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
			const runtimeEntry = join(repoRoot, "tests2", "harness", "server-runtime-entry.ts");
			const sourceEntries = serverSourceFiles(repoRoot);
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
				plugins: [sourceUrlPlugin()],
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

function resolveSourceCandidate(source, importer, repoRoot) {
	const request = source.replace(/[?#].*$/, "");
	if (request.startsWith("file:")) return fileURLToPath(request);
	if (/^[A-Za-z]:[\\/]/.test(request)) return request;
	if (isAbsolute(request)) return request;
	if (!request.startsWith(".")) return undefined;
	const importerPath = importer?.startsWith("file:") ? fileURLToPath(importer) : importer?.replace(/[?#].*$/, "");
	return resolve(importerPath ? dirname(importerPath) : repoRoot, request);
}

function manifestKeyForSource(sourcePath, repoRoot, entries) {
	const windowsPath = /^[A-Za-z]:[\\/]/.test(sourcePath) || /^[A-Za-z]:[\\/]/.test(repoRoot);
	let relativeSource;
	if (windowsPath) relativeSource = win32.relative(repoRoot, sourcePath);
	else relativeSource = relative(repoRoot, sourcePath);
	let key = normalizeServerSourcePath(relativeSource);
	if (windowsPath) key = key.toLowerCase();
	if (!key.startsWith("src/server/")) return undefined;
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
export function serverPrebundleResolver(prebundle, { repoRoot = REPO_ROOT } = {}) {
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
	return {
		name: "bobbit-server-prebundle-resolver",
		enforce: "pre",
		config() {
			return { test: { server: { deps: { external: [externalPattern] } } } };
		},
		resolveId(source, importer) {
			const sourcePath = resolveSourceCandidate(source, importer, repoRoot);
			if (!sourcePath) return null;
			const key = manifestKeyForSource(sourcePath, repoRoot, entries);
			if (!key) return null;
			const output = entries[key];
			return {
				id: pathToFileURL(join(cacheDir, ...output.split("/"))).href,
				external: true,
				moduleSideEffects: true,
			};
		},
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = await ensureServerTestPrebundle();
	console.log(JSON.stringify(result));
}
