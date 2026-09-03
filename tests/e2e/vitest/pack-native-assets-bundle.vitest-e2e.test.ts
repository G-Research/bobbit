// v2-e2e-vitest real-process owner: npm launches real platform processes, so
// release-package fidelity remains outside tier 1. The compiled pack consumed
// here is the current command's fingerprint-validated ensure-dist artifact.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { OnResolveResult, Plugin, PluginBuild } from "esbuild";
import { makeTmpDir } from "../../helpers/tmp.ts";

type NativeAssetRuntime = {
	platform: string;
	arch: string;
	glibcVersionRuntime?: string | null;
};

type BuildApi = {
	packNativeAssetsPlugin(options: { projectRoot: string; platform: string }): Plugin;
};

type DistApi = {
	computeDistBuildKey(repoRoot: string): string;
	validateDistBuild(repoRoot: string, key: string): boolean;
};

type RuntimeApi = {
	resolvePackNativeAsset(familyDirectory: string | URL, runtime?: NativeAssetRuntime): string;
};

type NpmLoadResult = {
	exec: boolean;
	command?: string;
	args: string[];
};

type NpmInstance = {
	load(): Promise<NpmLoadResult>;
	exec(command: string, args: string[]): Promise<void>;
	unload(): void;
};

type NpmConstructor = new(options: {
	stdout: NodeJS.WritableStream;
	stderr: NodeJS.WritableStream;
	argv: string[];
}) => NpmInstance;

type NpmPackEntry = {
	filename: string;
	files: Array<{ path: string; size: number; mode: number }>;
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const BUILD_MODULE = pathToFileURL(path.join(REPO_ROOT, "scripts", "pack-native-assets.mjs")).href;
const DIST_MODULE = pathToFileURL(path.join(REPO_ROOT, "scripts", "testing-v2", "ensure-dist.mjs")).href;
const RUNTIME_MODULE = pathToFileURL(path.join(REPO_ROOT, "src", "server", "extension-host", "native-assets.ts")).href;
const PACK_NAME = "performance-optimisation";
const FAMILY_ID = "database-driver";
const PACKAGE_NAME = "better-sqlite3";
const SOURCE_PACK = path.join(REPO_ROOT, "market-packs", PACK_NAME);
const SOURCE_ENTRY = path.join(SOURCE_PACK, "src", "performance-routes-entry.ts");
const COMPILED_DIST_PACK = path.join(REPO_ROOT, "dist", "server", "builtin-packs", "market-packs", PACK_NAME);
const COMPILED_ENTRY_RELATIVE = path.join("lib", "performance-routes.mjs");
const CANONICAL_TARGETS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-glibc-arm64",
	"linux-glibc-x64",
	"linux-musl-arm64",
	"linux-musl-x64",
	"win32-arm64",
	"win32-x64",
] as const;
type CanonicalTarget = (typeof CANONICAL_TARGETS)[number];

const TARGET_RUNTIMES: ReadonlyArray<[CanonicalTarget, NativeAssetRuntime]> = [
	["darwin-arm64", { platform: "darwin", arch: "arm64" }],
	["darwin-x64", { platform: "darwin", arch: "x64" }],
	["linux-glibc-arm64", { platform: "linux", arch: "arm64", glibcVersionRuntime: "2.39" }],
	["linux-glibc-x64", { platform: "linux", arch: "x64", glibcVersionRuntime: "2.39" }],
	["linux-musl-arm64", { platform: "linux", arch: "arm64", glibcVersionRuntime: null }],
	["linux-musl-x64", { platform: "linux", arch: "x64", glibcVersionRuntime: null }],
	["win32-arm64", { platform: "win32", arch: "arm64" }],
	["win32-x64", { platform: "win32", arch: "x64" }],
];

// Full E2E shares Windows process capacity with the browser lanes: a valid
// release attempt crossed 120 seconds under contention, while focused runs are
// normally far shorter. Keep bounded headroom without retrying torn-down work.
const REAL_PROCESS_TEST_TIMEOUT_MS = 180_000;
const temporaryRoots = new Set<string>();

async function loadBuildApi(): Promise<BuildApi> {
	return await import(/* @vite-ignore */ BUILD_MODULE) as unknown as BuildApi;
}

async function loadDistApi(): Promise<DistApi> {
	return await import(/* @vite-ignore */ DIST_MODULE) as unknown as DistApi;
}

async function loadRuntimeApi(): Promise<RuntimeApi> {
	return await import(/* @vite-ignore */ RUNTIME_MODULE) as unknown as RuntimeApi;
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function restoreWritable(root: string): void {
	if (process.platform === "win32" || !fs.existsSync(root)) return;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) restoreWritable(absolute);
		try { fs.chmodSync(absolute, entry.isDirectory() ? 0o755 : 0o644); } catch { /* best effort cleanup */ }
	}
	try { fs.chmodSync(root, 0o755); } catch { /* best effort cleanup */ }
}

function makeReadOnly(root: string): void {
	if (process.platform === "win32") return;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) makeReadOnly(absolute);
		fs.chmodSync(absolute, entry.isDirectory() ? 0o555 : 0o444);
	}
	fs.chmodSync(root, 0o555);
}

function assertCompiledEntry(source: string): void {
	assert.doesNotMatch(source, /bobbit:pack-native-assets/);
	assert.doesNotMatch(source, /src[\\/]server[\\/]extension-host[\\/]native-assets\.ts/);
	assert.doesNotMatch(source, /node_modules[\\/]/);
	assert.equal(source.includes(REPO_ROOT), false, "compiled entry must not embed its checkout path");
}

async function resolveBuildAlias(api: BuildApi, platform: string, specifier: string): Promise<OnResolveResult> {
	let resolver: Parameters<PluginBuild["onResolve"]>[1] | undefined;
	let resolverFilter: RegExp | undefined;
	const plugin = api.packNativeAssetsPlugin({ projectRoot: REPO_ROOT, platform });
	plugin.setup({
		onResolve(
			options: Parameters<PluginBuild["onResolve"]>[0],
			callback: Parameters<PluginBuild["onResolve"]>[1],
		) {
			resolverFilter = options.filter;
			resolver = callback;
		},
	} as never);
	assert.ok(resolver, "native asset plugin must register its resolver");
	assert.ok(resolverFilter?.test(specifier), `native asset plugin filter did not match ${specifier}`);
	const result = await resolver({
		path: specifier,
		importer: "",
		namespace: "file",
		resolveDir: REPO_ROOT,
		kind: "import-statement",
		pluginData: undefined,
		with: {},
	});
	assert.ok(result, `native asset plugin did not resolve ${specifier}`);
	return result;
}


function loadNpmConstructor(): NpmConstructor {
	const npmCli = process.env.npm_execpath;
	if (!npmCli || !fs.existsSync(npmCli)) {
		throw new Error("release packaging test requires npm_execpath from the npm test runner");
	}
	const npmModule = path.resolve(path.dirname(npmCli), "..", "lib", "npm.js");
	if (!fs.existsSync(npmModule)) {
		throw new Error(`release packaging test cannot locate npm's in-process API: ${npmModule}`);
	}
	return createRequire(import.meta.url)(npmModule) as NpmConstructor;
}

async function runNpm(cwd: string, argv: string[]): Promise<{ stdout: string; stderr: string }> {
	const Npm = loadNpmConstructor();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let stdoutText = "";
	let stderrText = "";
	stdout.setEncoding("utf8");
	stderr.setEncoding("utf8");
	stdout.on("data", chunk => { stdoutText += String(chunk); });
	stderr.on("data", chunk => { stderrText += String(chunk); });

	const previousCwd = process.cwd();
	process.chdir(cwd);
	const npm = new Npm({ stdout, stderr, argv });
	try {
		const loaded = await npm.load();
		if (!loaded.exec || !loaded.command) throw new Error(`npm did not load command: ${argv.join(" ")}`);
		await npm.exec(loaded.command, loaded.args);
		await new Promise<void>(resolve => setImmediate(resolve));
		return { stdout: stdoutText, stderr: stderrText };
	} finally {
		npm.unload();
		process.chdir(previousCwd);
	}
}

afterEach(() => {
	for (const root of temporaryRoots) {
		restoreWritable(root);
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		assert.equal(fs.existsSync(root), false, `temporary root survived cleanup: ${root}`);
	}
	temporaryRoots.clear();
}, REAL_PROCESS_TEST_TIMEOUT_MS);

describe("bobbit:pack-native-assets build-only alias", () => {
	it("validates the command-owned compiled native pack through a read-only release install", async () => {
		const distApi = await loadDistApi();
		const currentBuildKey = distApi.computeDistBuildKey(REPO_ROOT);
		expect(distApi.validateDistBuild(REPO_ROOT, currentBuildKey), "run ensure-dist before this focused E2E so compiled artifacts match the current build fingerprint").toBe(true);

		const root = makeTmpDir("pack-native-assets-release-");
		temporaryRoots.add(root);
		const releaseRoot = path.join(root, "release");
		const releasePack = path.join(releaseRoot, "dist", "server", "builtin-packs", "market-packs", PACK_NAME);
		const tarballRoot = path.join(root, "tarballs");
		const consumerRoot = path.join(root, "consumer");
		const npmCache = path.join(root, "npm-cache");
		const sourceFamily = path.join(SOURCE_PACK, "lib", "native", FAMILY_ID);
		const compiledFamily = path.join(COMPILED_DIST_PACK, "lib", "native", FAMILY_ID);
		const compiledEntry = path.join(COMPILED_DIST_PACK, COMPILED_ENTRY_RELATIVE);

		expect(fs.readFileSync(SOURCE_ENTRY, "utf8")).toContain('from "bobbit:pack-native-assets"');
		const compiledEntryBytes = fs.readFileSync(compiledEntry);
		assertCompiledEntry(compiledEntryBytes.toString("utf8"));
		const manifestText = fs.readFileSync(path.join(sourceFamily, "manifest.json"), "utf8");
		expect(fs.readFileSync(path.join(compiledFamily, "manifest.json"), "utf8")).toBe(manifestText);
		const expectedBytes = new Map<CanonicalTarget, Buffer>();
		const manifest = JSON.parse(manifestText) as {
			schema: number;
			package: string;
			version: string;
			targets: Record<CanonicalTarget, { file: string; size: number; sha256: string }>;
		};
		expect(manifest.schema).toBe(1);
		expect(manifest.package).toBe(PACKAGE_NAME);
		expect(typeof manifest.version).toBe("string");
		expect(manifest.version.length).toBeGreaterThan(0);
		expect(Object.keys(manifest.targets)).toEqual([...CANONICAL_TARGETS]);
		for (const target of CANONICAL_TARGETS) {
			const bytes = fs.readFileSync(path.join(sourceFamily, `${target}.node`));
			expectedBytes.set(target, bytes);
			expect(manifest.targets[target]).toEqual({
				file: `${target}.node`,
				size: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			});
			expect(fs.readFileSync(path.join(compiledFamily, `${target}.node`)).equals(bytes)).toBe(true);
		}

		fs.cpSync(COMPILED_DIST_PACK, releasePack, { recursive: true, errorOnExist: true, force: false });
		expect(fs.readFileSync(path.join(releasePack, COMPILED_ENTRY_RELATIVE)).equals(compiledEntryBytes)).toBe(true);
		expect(fs.readFileSync(path.join(releasePack, "lib", "native", FAMILY_ID, "manifest.json"), "utf8")).toBe(manifestText);
		writeJson(path.join(releaseRoot, "package.json"), {
			name: "@fixture/bobbit-native-release",
			version: "1.0.0",
			files: ["dist/"],
		});
		expect(fs.existsSync(path.join(releasePack, "src"))).toBe(false);
		expect(fs.existsSync(path.join(releasePack, "node_modules"))).toBe(false);

		fs.mkdirSync(tarballRoot, { recursive: true });
		const packed = await runNpm(releaseRoot, [
			"pack", "--ignore-scripts", "--json", "--pack-destination", tarballRoot, "--cache", npmCache,
		]);
		const packEntries = JSON.parse(packed.stdout) as NpmPackEntry[];
		expect(packEntries).toHaveLength(1);
		const packEntry = packEntries[0];
		const listed = packEntry.files.map(file => file.path.replaceAll("\\", "/"));
		const familyPrefix = `dist/server/builtin-packs/market-packs/${PACK_NAME}/lib/native/${FAMILY_ID}`;
		expect(listed.filter(file => file.startsWith(`${familyPrefix}/`) && file.endsWith(".node")).sort())
			.toEqual(CANONICAL_TARGETS.map(target => `${familyPrefix}/${target}.node`).sort());
		expect(listed).toContain(`${familyPrefix}/manifest.json`);
		expect(listed).toContain(`dist/server/builtin-packs/market-packs/${PACK_NAME}/lib/performance-routes.mjs`);
		expect(listed.some(file => file.includes("/src/") || file.includes("/node_modules/"))).toBe(false);

		const tarball = path.join(tarballRoot, packEntry.filename);
		expect(fs.statSync(tarball).isFile()).toBe(true);
		fs.mkdirSync(consumerRoot, { recursive: true });
		writeJson(path.join(consumerRoot, "package.json"), {
			name: "native-release-clean-consumer",
			version: "1.0.0",
			private: true,
		});
		await runNpm(consumerRoot, [
			"install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "--package-lock=false",
			"--offline", "--json", "--cache", npmCache, tarball,
		]);

		const installedRelease = path.join(consumerRoot, "node_modules", "@fixture", "bobbit-native-release");
		const installedPack = path.join(installedRelease, "dist", "server", "builtin-packs", "market-packs", PACK_NAME);
		const installedFamily = path.join(installedPack, "lib", "native", FAMILY_ID);
		expect(fs.existsSync(path.join(consumerRoot, "package-lock.json"))).toBe(false);
		expect(fs.existsSync(path.join(installedRelease, "node_modules"))).toBe(false);
		expect(fs.readFileSync(path.join(installedFamily, "manifest.json"), "utf8")).toBe(manifestText);
		makeReadOnly(installedRelease);
		if (process.platform !== "win32") expect(fs.statSync(installedRelease).mode & 0o222).toBe(0);

		const installedEntry = path.join(installedPack, COMPILED_ENTRY_RELATIVE);
		const installedEntryBefore = fs.readFileSync(installedEntry);
		expect(installedEntryBefore.equals(compiledEntryBytes)).toBe(true);
		const installedModule = await import(`${pathToFileURL(installedEntry).href}?release=${Date.now()}`) as {
			routes?: Record<string, unknown>;
		};
		expect(installedModule.routes).toHaveProperty("performance-snapshot");
		const runtimeApi = await loadRuntimeApi();
		for (const [target, runtime] of TARGET_RUNTIMES) {
			const resolved = runtimeApi.resolvePackNativeAsset(installedFamily, runtime);
			expect(resolved).toBe(path.join(installedFamily, `${target}.node`));
			const relative = path.relative(installedPack, resolved);
			expect(path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)).toBe(false);
			const installedBytes = fs.readFileSync(resolved);
			expect(installedBytes.equals(expectedBytes.get(target)!)).toBe(true);
			expect(installedBytes.equals(fs.readFileSync(path.join(sourceFamily, `${target}.node`)))).toBe(true);
			expect(installedBytes.equals(fs.readFileSync(path.join(compiledFamily, `${target}.node`)))).toBe(true);
			expect(installedBytes.equals(fs.readFileSync(path.join(releasePack, "lib", "native", FAMILY_ID, `${target}.node`)))).toBe(true);
		}
		expect(fs.readFileSync(installedEntry).equals(installedEntryBefore)).toBe(true);
	}, REAL_PROCESS_TEST_TIMEOUT_MS);

	it("rejects the helper alias for browser builds and rejects unknown bobbit aliases", async () => {
		const api = await loadBuildApi();
		const browserResult = await resolveBuildAlias(api, "browser", "bobbit:pack-native-assets");
		const unknownResult = await resolveBuildAlias(api, "node", "bobbit:anything-else");
		const diagnostic = [...(browserResult.errors ?? []), ...(unknownResult.errors ?? [])]
			.map(error => error.text)
			.join("\n");
		expect(diagnostic).toMatch(/bobbit:pack-native-assets/i);
		expect(diagnostic).toMatch(/available only to Node pack entries/i);
		expect(diagnostic).toMatch(/bobbit:anything-else/i);
		expect(diagnostic).toMatch(/unsupported Bobbit build-time specifier/i);
	}, 60_000);
});
