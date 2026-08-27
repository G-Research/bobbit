#!/usr/bin/env node
/**
 * Marketplace-pack bundler and development watcher.
 *
 * Production (`npm run build:packs`) still bundles every declared entry into its
 * authored pack. Development (`npm run dev:pack -- <pack>`) rebuilds one exact
 * declaration, mirrors only its declared outputs, and notifies the local Vite
 * server after a complete successful publish.
 */
import { constants as fsConstants, watch as watchFs } from "node:fs";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { build } from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const require = createRequire(import.meta.url);
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_VITE_URL = "http://127.0.0.1:5173";
const DEV_RELOAD_PATH = "/__bobbit_dev/pack-rebuilt";

/** The sole source of truth for authored bundle inputs and serving outputs. */
export const PACKS = [
	{
		pack: "artifacts",
		authorRoot: "market-packs/artifacts",
		defaultServingRoot: "dist/server/builtin-packs/market-packs/artifacts",
		entries: [
			{ in: "ArtifactRenderer.ts", out: "tools/artifact_demo/ArtifactRenderer.js" },
			{ in: "ArtifactViewerPanel.ts", out: "lib/ArtifactViewerPanel.js" },
		],
	},
	{
		pack: "pr-walkthrough",
		authorRoot: "market-packs/pr-walkthrough",
		defaultServingRoot: "dist/server/builtin-packs/market-packs/pr-walkthrough",
		entries: [
			{ in: "panel.js", out: "lib/panel.js" },
			{ in: "yaml-to-cards.js", out: "lib/yaml-to-cards.mjs", platform: "node" },
		],
	},
	{
		pack: "hindsight",
		authorRoot: "market-packs/hindsight",
		defaultServingRoot: "dist/server/builtin-packs/market-packs/hindsight",
		entries: [
			{ in: "hindsight-client.ts", out: "lib/hindsight-client.mjs", platform: "node" },
			{ in: "provider.ts", out: "lib/provider.mjs", platform: "node" },
			{ in: "routes.ts", out: "lib/routes.mjs", platform: "node" },
		],
	},
	{
		pack: "terminal",
		authorRoot: "market-packs/terminal",
		defaultServingRoot: "dist/server/builtin-packs/market-packs/terminal",
		entries: [
			{ in: "terminal-panel.ts", out: "lib/terminal-panel.js" },
			{ in: "terminal-channel.ts", out: "lib/terminal-channel.mjs", platform: "node" },
		],
	},
	{
		pack: "file-explorer",
		authorRoot: "market-packs/file-explorer",
		defaultServingRoot: "dist/server/builtin-packs/market-packs/file-explorer",
		entries: [
			{ in: "file-explorer-panel.ts", out: "lib/file-explorer-panel.js" },
			{ in: "explorer-routes.ts", out: "lib/explorer-routes.mjs", platform: "node" },
		],
	},
];

function normalizeRepoRelative(value, label) {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new Error(`${label} must be a non-empty repository-relative path`);
	}
	if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
		throw new Error(`${label} must be repository-relative: ${value}`);
	}
	const normalized = value.replaceAll("\\", "/");
	const segments = normalized.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error(`${label} contains an unsafe path segment: ${value}`);
	}
	return segments.join("/");
}

function validateDeclaration(declaration) {
	if (!declaration || !PACK_ID.test(declaration.pack)) throw new Error(`Invalid pack declaration id: ${declaration?.pack ?? ""}`);
	const authorRoot = normalizeRepoRelative(declaration.authorRoot, `${declaration.pack} authorRoot`);
	const defaultServingRoot = normalizeRepoRelative(declaration.defaultServingRoot, `${declaration.pack} defaultServingRoot`);
	if (!Array.isArray(declaration.entries) || declaration.entries.length === 0) {
		throw new Error(`${declaration.pack} must declare at least one bundle entry`);
	}
	const entries = declaration.entries.map((entry) => {
		const input = normalizeRepoRelative(entry.in, `${declaration.pack} entry input`);
		const output = normalizeRepoRelative(entry.out, `${declaration.pack} entry output`);
		if (entry.platform !== undefined && entry.platform !== "browser" && entry.platform !== "node") {
			throw new Error(`${declaration.pack} entry platform must be browser or node`);
		}
		return { ...entry, in: input, out: output };
	});
	return { ...declaration, authorRoot, defaultServingRoot, entries };
}

for (const declaration of PACKS) validateDeclaration(declaration);

export function parseArgs(argv) {
	const result = { watch: false, pack: undefined, targets: [], viteUrl: DEFAULT_VITE_URL, help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--watch") {
			if (result.watch) throw new Error("Duplicate option: --watch");
			result.watch = true;
			continue;
		}
		if (argument === "--help" || argument === "-h") {
			result.help = true;
			continue;
		}
		if (argument === "--target" || argument === "--vite-url") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
			index += 1;
			if (argument === "--target") result.targets.push(normalizeRepoRelative(value, "--target"));
			else {
				let parsed;
				try {
					parsed = new URL(value);
				} catch {
					throw new Error(`--vite-url must be an HTTP(S) URL: ${value}`);
				}
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					throw new Error(`--vite-url must be an HTTP(S) URL: ${value}`);
				}
				result.viteUrl = parsed.href;
			}
			continue;
		}
		if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
		if (result.pack !== undefined) throw new Error(`Unexpected extra pack argument: ${argument}`);
		if (!PACK_ID.test(argument)) throw new Error(`Pack id must be a safe structural id: ${argument}`);
		result.pack = argument;
	}
	if (!result.help && result.watch && !result.pack) throw new Error("Missing pack id for --watch");
	if (!result.help && !result.watch && (result.pack || result.targets.length > 0 || result.viteUrl !== DEFAULT_VITE_URL)) {
		throw new Error("Pack selection, --target, and --vite-url require --watch");
	}
	return result;
}

export function resolvePackBuild(packName) {
	if (typeof packName !== "string" || !PACK_ID.test(packName)) throw new Error(`Invalid pack id: ${packName ?? ""}`);
	const declaration = PACKS.find((candidate) => candidate.pack === packName);
	if (declaration) return validateDeclaration(declaration);
	throw new Error(`Unknown pack "${packName}". Declared packs: ${PACKS.map(({ pack }) => pack).sort().join(", ")}`);
}

function isWithin(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function stableIdentity(stats) {
	if (stats.dev === undefined || stats.ino === undefined || String(stats.ino) === "0") return undefined;
	return `${String(stats.dev)}:${String(stats.ino)}`;
}

function sameStableIdentity(expected, current) {
	const expectedIdentity = stableIdentity(expected);
	return expectedIdentity !== undefined && expectedIdentity === stableIdentity(current);
}

function staleTargetError(targetPath) {
	const error = new Error(`Serving target changed or is unsafe: ${targetPath}`);
	error.code = "ESTALE";
	return error;
}

function assertStableDirectory(stats, targetPath) {
	if (!stats.isDirectory() || stats.isSymbolicLink() || stableIdentity(stats) === undefined) {
		throw staleTargetError(targetPath);
	}
}

async function assertDirectoryClaimCurrent(claim, fsImpl) {
	const current = await fsImpl.lstat(claim.path);
	assertStableDirectory(current, claim.path);
	if (claim.identity !== stableIdentity(current)) throw staleTargetError(claim.path);
}

async function captureDirectoryClaim(directoryPath, canonicalRoot, fsImpl) {
	const stats = await fsImpl.lstat(directoryPath);
	assertStableDirectory(stats, directoryPath);
	const canonical = await fsImpl.realpath(directoryPath);
	if (!isWithin(canonicalRoot, canonical)) throw new Error(`Mirror destination escapes its serving target: ${directoryPath}`);
	const canonicalStats = await fsImpl.lstat(canonical);
	assertStableDirectory(canonicalStats, canonical);
	if (!sameStableIdentity(stats, canonicalStats)) throw staleTargetError(directoryPath);
	return { path: directoryPath, identity: stableIdentity(stats) };
}

const realMirrorFs = { copyFile, lstat, mkdir, realpath, rename, unlink };

/** Resolve, validate and deterministically order already-existing served pack roots. */
export async function servingTargets(declaration, explicitTargets = [], options = {}) {
	const validated = validateDeclaration(declaration);
	const root = path.resolve(options.projectRoot ?? projectRoot);
	const canonicalRoot = await realpath(root);
	const authorPath = path.resolve(root, validated.authorRoot);
	const canonicalAuthor = await realpath(authorPath);
	const requested = explicitTargets.length > 0 ? explicitTargets : [validated.defaultServingRoot];
	const usingDefault = explicitTargets.length === 0;
	const targets = [];
	for (const supplied of requested) {
		const relative = normalizeRepoRelative(supplied, "Serving target");
		const lexical = path.resolve(root, relative);
		let canonical;
		let stats;
		try {
			canonical = await realpath(lexical);
			stats = await lstat(canonical);
		} catch {
			if (usingDefault) {
				throw new Error(`Default serving target "${relative}" does not exist; run npm run build:server or pass --target <served-pack-root>`);
			}
			throw new Error(`Serving target "${relative}" does not exist`);
		}
		if (!stats.isDirectory()) throw new Error(`Serving target "${relative}" is not a directory`);
		if (stats.isSymbolicLink() || stableIdentity(stats) === undefined) {
			throw new Error(`Serving target "${relative}" is not a stable directory`);
		}
		if (!isWithin(canonicalRoot, canonical)) throw new Error(`Serving target "${relative}" escapes the repository root`);
		if (canonical === canonicalAuthor) throw new Error(`Serving target "${relative}" aliases the authored pack root`);
		const claim = Object.freeze({ path: canonical, canonicalPath: canonical, identity: stableIdentity(stats) });
		let manifest;
		try {
			await assertDirectoryClaimCurrent(claim, realMirrorFs);
			manifest = parseYaml(await readFile(path.join(canonical, "pack.yaml"), "utf8"));
			await assertDirectoryClaimCurrent(claim, realMirrorFs);
		} catch (error) {
			if (error?.code === "ESTALE") throw error;
			throw new Error(`Serving target "${relative}" has no readable pack.yaml`);
		}
		if (!manifest || manifest.name !== validated.pack) {
			throw new Error(`Serving target "${relative}" manifest name must be "${validated.pack}"`);
		}
		targets.push(claim);
	}
	const caseInsensitive = options.caseInsensitive ?? process.platform === "win32";
	const unique = new Map();
	for (const target of targets) unique.set(caseInsensitive ? target.path.toLowerCase() : target.path, target);
	return [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function resolveDep(spec) {
	return require.resolve(spec, { paths: [projectRoot] });
}

async function bundlePdfWorker(buildImpl = build) {
	const result = await buildImpl({
		entryPoints: [resolveDep("pdfjs-dist/build/pdf.worker.min.mjs")],
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		minify: true,
		legalComments: "none",
		write: false,
	});
	return result.outputFiles[0].text;
}

function pdfWorkerPlugin(workerSource) {
	return {
		name: "virtual-pdf-worker",
		setup(builder) {
			builder.onResolve({ filter: /^virtual:pdf-worker$/ }, () => ({ path: "virtual:pdf-worker", namespace: "pdf-worker" }));
			builder.onLoad({ filter: /.*/, namespace: "pdf-worker" }, () => ({
				contents: `export default ${JSON.stringify(workerSource)};`,
				loader: "js",
			}));
		},
	};
}

/** Build every declared entry for one pack, sequentially. */
export async function buildSelectedPack(declaration, options = {}) {
	const validated = validateDeclaration(declaration);
	const root = path.resolve(options.projectRoot ?? projectRoot);
	const buildImpl = options.build ?? build;
	const plugin = options.plugin ?? pdfWorkerPlugin(await bundlePdfWorker(buildImpl));
	const log = options.log ?? ((message) => console.log(message));
	for (const entry of validated.entries) {
		const inFile = path.join(root, validated.authorRoot, "src", entry.in);
		const outFile = path.join(root, validated.authorRoot, entry.out);
		await buildImpl({
			entryPoints: [inFile],
			outfile: outFile,
			bundle: true,
			format: "esm",
			platform: entry.platform ?? "browser",
			target: "es2022",
			minify: true,
			legalComments: "none",
			external: ["lit", "lit/*"],
			splitting: false,
			define: { "process.env.NODE_ENV": '"production"' },
			...(entry.platform === "node"
				? { banner: { js: "import { createRequire as __bbCreateRequire } from 'node:module';\nconst require = __bbCreateRequire(import.meta.url);" } }
				: {}),
			plugins: [plugin],
			logLevel: "info",
		});
		log(`[build:packs] ${validated.pack}/src/${entry.in} → ${validated.pack}/${entry.out}`);
	}
}

function isMissing(error) {
	return error?.code === "ENOENT";
}

async function lstatIfPresent(filePath, fsImpl) {
	try {
		return await fsImpl.lstat(filePath);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

async function assertClaimsCurrent(claims, fsImpl) {
	for (const claim of claims) await assertDirectoryClaimCurrent(claim, fsImpl);
}

async function prepareDestinationParent(target, output, fsImpl) {
	if (!target || typeof target.path !== "string" || typeof target.canonicalPath !== "string" || typeof target.identity !== "string") {
		throw new Error("Mirror target must be a validated serving target claim");
	}
	const rootClaim = { path: target.path, identity: target.identity };
	await assertDirectoryClaimCurrent(rootClaim, fsImpl);
	const claims = [rootClaim];
	const parentSegments = path.posix.dirname(output) === "." ? [] : path.posix.dirname(output).split("/");
	let currentPath = target.path;
	for (const segment of parentSegments) {
		currentPath = path.join(currentPath, segment);
		await assertClaimsCurrent(claims, fsImpl);
		let stats = await lstatIfPresent(currentPath, fsImpl);
		if (stats === undefined) {
			await fsImpl.mkdir(currentPath, { recursive: false });
			stats = await fsImpl.lstat(currentPath);
		}
		assertStableDirectory(stats, currentPath);
		const claim = await captureDirectoryClaim(currentPath, target.canonicalPath, fsImpl);
		claims.push(claim);
		await assertClaimsCurrent(claims, fsImpl);
	}
	return claims;
}

async function captureDestinationFile(destination, target, claims, fsImpl) {
	await assertClaimsCurrent(claims, fsImpl);
	const stats = await lstatIfPresent(destination, fsImpl);
	if (stats === undefined) return undefined;
	if (!stats.isFile() || stats.isSymbolicLink() || stableIdentity(stats) === undefined) {
		throw new Error(`Mirror destination is not a stable regular file: ${destination}`);
	}
	const canonical = await fsImpl.realpath(destination);
	if (!isWithin(target.canonicalPath, canonical)) {
		throw new Error(`Mirror destination escapes its serving target: ${destination}`);
	}
	const canonicalStats = await fsImpl.lstat(canonical);
	if (!canonicalStats.isFile() || canonicalStats.isSymbolicLink() || !sameStableIdentity(stats, canonicalStats)) {
		throw staleTargetError(destination);
	}
	await assertClaimsCurrent(claims, fsImpl);
	return stats;
}

async function assertDestinationUnchanged(destination, expected, target, claims, fsImpl) {
	const current = await captureDestinationFile(destination, target, claims, fsImpl);
	if (expected === undefined) {
		if (current !== undefined) throw staleTargetError(destination);
		return;
	}
	if (current === undefined || !sameStableIdentity(expected, current)) throw staleTargetError(destination);
}

async function cleanupOwnedTemporary(tempPath, tempStats, fsImpl) {
	try {
		const current = await fsImpl.lstat(tempPath);
		if (current.isFile() && !current.isSymbolicLink() && sameStableIdentity(tempStats, current)) {
			await fsImpl.unlink(tempPath);
		}
	} catch {
		// Preserve the publication error. Never unlink an identity we do not own.
	}
}

function isWindowsReplacementCollision(error) {
	return process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EEXIST");
}

async function publishDeclaredOutput(source, destination, target, claims, fsImpl) {
	const expectedDestination = await captureDestinationFile(destination, target, claims, fsImpl);
	const tempPath = path.join(path.dirname(destination), `.bobbit-pack-publish-${randomUUID()}`);
	let tempStats;
	try {
		await assertClaimsCurrent(claims, fsImpl);
		await fsImpl.copyFile(source, tempPath, fsConstants.COPYFILE_EXCL);
		tempStats = await fsImpl.lstat(tempPath);
		if (!tempStats.isFile() || tempStats.isSymbolicLink() || stableIdentity(tempStats) === undefined) {
			throw new Error(`Mirror temporary output is not a stable regular file: ${tempPath}`);
		}
		const canonicalTemp = await fsImpl.realpath(tempPath);
		if (!isWithin(target.canonicalPath, canonicalTemp)) {
			throw new Error(`Mirror temporary output escapes its serving target: ${tempPath}`);
		}
		const canonicalTempStats = await fsImpl.lstat(canonicalTemp);
		if (!canonicalTempStats.isFile() || !sameStableIdentity(tempStats, canonicalTempStats)) {
			throw staleTargetError(tempPath);
		}
		await assertClaimsCurrent(claims, fsImpl);
		await assertDestinationUnchanged(destination, expectedDestination, target, claims, fsImpl);
		try {
			await fsImpl.rename(tempPath, destination);
		} catch (error) {
			// Windows rename can report EPERM or EEXIST when it cannot replace an
			// existing file. Never remove the previous output for unrelated failures.
			if (expectedDestination === undefined || !isWindowsReplacementCollision(error)) throw error;
			await assertDestinationUnchanged(destination, expectedDestination, target, claims, fsImpl);
			await fsImpl.unlink(destination);
			if (await lstatIfPresent(destination, fsImpl) !== undefined) throw staleTargetError(destination);
			await assertClaimsCurrent(claims, fsImpl);
			await fsImpl.rename(tempPath, destination);
		}
		const published = await fsImpl.lstat(destination);
		if (!published.isFile() || published.isSymbolicLink() || !sameStableIdentity(tempStats, published)) {
			throw staleTargetError(destination);
		}
		const canonicalPublished = await fsImpl.realpath(destination);
		if (!isWithin(target.canonicalPath, canonicalPublished)) throw staleTargetError(destination);
		const canonicalPublishedStats = await fsImpl.lstat(canonicalPublished);
		if (!sameStableIdentity(tempStats, canonicalPublishedStats)) throw staleTargetError(destination);
		await assertClaimsCurrent(claims, fsImpl);
		tempStats = undefined;
	} catch (error) {
		if (tempStats) await cleanupOwnedTemporary(tempPath, tempStats, fsImpl);
		throw error;
	}
}

/** Mirror only declared outputs, retaining their pack-relative nested paths. */
export async function mirrorDeclaredOutputs(declaration, targets, options = {}) {
	const validated = validateDeclaration(declaration);
	const root = path.resolve(options.projectRoot ?? projectRoot);
	const fsImpl = options.fs ?? realMirrorFs;
	for (const target of targets) {
		for (const entry of validated.entries) {
			const source = path.join(root, validated.authorRoot, entry.out);
			const destination = path.join(target.path, ...entry.out.split("/"));
			const claims = await prepareDestinationParent(target, entry.out, fsImpl);
			await publishDeclaredOutput(source, destination, target, claims, fsImpl);
		}
	}
}

/** Notify Vite after a complete mirror. Only HTTP 204 is success. */
export async function notifyVite(viteUrl, payload, options = {}) {
	if (!PACK_ID.test(payload?.pack) || !Number.isSafeInteger(payload?.reloadToken) || payload.reloadToken <= 0) {
		throw new Error("Invalid pack rebuild notification payload");
	}
	const controller = new AbortController();
	const timeoutMs = options.timeoutMs ?? 2_000;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const endpoint = new URL(DEV_RELOAD_PATH, viteUrl);
		const response = await (options.fetch ?? fetch)(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (response.status !== 204) throw new Error(`Vite pack reload endpoint returned HTTP ${response.status}`);
	} catch (error) {
		if (controller.signal.aborted) throw new Error(`Vite pack reload notification timed out after ${timeoutMs}ms`, { cause: error });
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Serialize pack-level build/mirror/notify cycles. File events debounce while
 * idle and coalesce to exactly one trailing cycle while work is active.
 */
export function createSerializedRebuilder(options) {
	const debounceMs = options.debounceMs ?? 60;
	const reportError = options.onError ?? ((error) => console.error("[dev:pack] rebuild failed:", error));
	let running = null;
	let dirty = false;
	let closed = false;
	let debounceTimer = null;
	let watcher = null;
	let nextReloadToken = 1;
	let lastError = null;
	let lastFailure = null;
	let failureCount = 0;
	const signalSource = options.signalSource ?? process;

	const cycle = async () => {
		await options.build();
		await options.mirror();
		const reloadToken = nextReloadToken;
		nextReloadToken += 1;
		await options.notify({ pack: options.pack, reloadToken });
	};

	const drain = () => {
		if (running || closed || !dirty) return running ?? Promise.resolve();
		running = (async () => {
			while (dirty && !closed) {
				dirty = false;
				try {
					await cycle();
					lastError = null;
				} catch (error) {
					lastError = error;
					lastFailure = error;
					failureCount += 1;
					reportError(error);
				}
			}
		})().finally(() => {
			running = null;
			if (dirty && !closed) drain();
		});
		return running;
	};

	const flush = async ({ throwOnError = false } = {}) => {
		const startingFailureCount = failureCount;
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		if (dirty && !running) drain();
		while (running) await running;
		if (throwOnError && failureCount > startingFailureCount) throw lastFailure;
	};

	const schedule = (immediate = false) => {
		if (closed) return;
		dirty = true;
		if (running) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		if (immediate) {
			debounceTimer = null;
			drain();
		} else {
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				drain();
			}, debounceMs);
		}
	};

	const onSignal = () => { void dispose(); };
	const attachWatcher = (nextWatcher) => {
		if (closed) {
			nextWatcher.close();
			return;
		}
		if (watcher) throw new Error("A watcher is already attached");
		watcher = nextWatcher;
		signalSource.on?.("SIGINT", onSignal);
		signalSource.on?.("SIGTERM", onSignal);
	};
	const dispose = async () => {
		if (!closed) {
			closed = true;
			dirty = false;
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = null;
			watcher?.close();
			watcher = null;
			signalSource.removeListener?.("SIGINT", onSignal);
			signalSource.removeListener?.("SIGTERM", onSignal);
		}
		if (running) await running;
	};

	return {
		schedule,
		flush,
		attachWatcher,
		dispose,
		get state() { return { running: running !== null, dirty, closed, nextReloadToken, lastError }; },
	};
}

async function buildAllPacks() {
	const plugin = pdfWorkerPlugin(await bundlePdfWorker());
	for (const declaration of PACKS) await buildSelectedPack(declaration, { plugin });
}

export async function runWatcher(parsed, options = {}) {
	const root = path.resolve(options.projectRoot ?? projectRoot);
	const declaration = resolvePackBuild(parsed.pack);
	const targets = await servingTargets(declaration, parsed.targets, { projectRoot: root });
	const plugin = options.plugin ?? (options.build ? undefined : pdfWorkerPlugin(await bundlePdfWorker()));
	const rebuilder = createSerializedRebuilder({
		pack: declaration.pack,
		build: options.build ?? (() => buildSelectedPack(declaration, { projectRoot: root, plugin })),
		mirror: options.mirror ?? (() => mirrorDeclaredOutputs(declaration, targets, { projectRoot: root })),
		notify: options.notify ?? ((payload) => notifyVite(parsed.viteUrl, payload)),
		signalSource: options.signalSource,
		onError: options.onError,
	});
	const sourceRoot = path.join(root, declaration.authorRoot, "src");
	const watcher = (options.watch ?? watchFs)(sourceRoot, { recursive: true }, () => rebuilder.schedule());
	rebuilder.attachWatcher(watcher);
	try {
		rebuilder.schedule(true);
		await rebuilder.flush({ throwOnError: true });
	} catch (error) {
		await rebuilder.dispose();
		throw error;
	}
	(options.log ?? console.log)(`[dev:pack] watching ${declaration.pack} at ${sourceRoot}`);
	return rebuilder;
}

function printHelp() {
	console.log("Usage: npm run dev:pack -- <pack> [--target <served-pack-root>]... [--vite-url <http(s)-url>]");
}

async function main(argv = process.argv.slice(2)) {
	const parsed = parseArgs(argv);
	if (parsed.help) {
		printHelp();
		return;
	}
	if (parsed.watch) await runWatcher(parsed);
	else await buildAllPacks();
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
	main().catch((error) => {
		console.error(`[${process.argv.includes("--watch") ? "dev:pack" : "build:packs"}] failed:`, error);
		process.exitCode = 1;
	});
}
