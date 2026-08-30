// v2-e2e-vitest real-process owner: esbuild and npm launch real platform
// processes, so bundle and release-package fidelity remain outside tier 1.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build, type Metafile, type Plugin } from "esbuild";
import { makeTmpDir } from "../../tests/helpers/tmp.ts";

type NativeAssetRuntime = {
	platform: string;
	arch: string;
	glibcVersionRuntime?: string | null;
};

type BuildApi = {
	materializePackNativeAssets(options: {
		projectRoot: string;
		packRoot: string;
		resolvePackageRoot: (packageName: string, projectRoot: string) => string;
	}): string[];
	packNativeAssetsPlugin(options: { projectRoot: string; platform: string }): Plugin;
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

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const BUILD_MODULE = pathToFileURL(path.join(REPO_ROOT, "scripts", "pack-native-assets.mjs")).href;
const COPY_BUILTIN_PACKS = path.join(REPO_ROOT, "scripts", "copy-builtin-packs.mjs");
const PACK_NAME = "file-explorer";
const FAMILY_ID = "fixture-addon";
const PACKAGE_NAME = "fixture-native-addon";
const PACKAGE_VERSION = "1.2.3";
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
const outstandingBuilds = new Set<Promise<Awaited<ReturnType<typeof build>>>>();

async function loadBuildApi(): Promise<BuildApi> {
	return await import(/* @vite-ignore */ BUILD_MODULE) as unknown as BuildApi;
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

function writeResolverSource(packRoot: string): string {
	const sourceFile = path.join(packRoot, "src", "resolver.ts");
	fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
	fs.writeFileSync(sourceFile, [
		'import { resolvePackNativeAsset } from "bobbit:pack-native-assets";',
		"export const resolveFixtureBinding = (familyDirectory: string, runtime: { platform: string; arch: string; glibcVersionRuntime?: string | null }) =>",
		"  resolvePackNativeAsset(familyDirectory, runtime);",
		"",
	].join("\n"), "utf8");
	return sourceFile;
}

function assertSelfContainedBundle(result: Awaited<ReturnType<typeof build>>, bundle: string): void {
	const metafile = result.metafile as Metafile;
	const normalizedInputs = Object.keys(metafile.inputs).map(input => input.replaceAll("\\", "/"));
	assert.equal(normalizedInputs.some(input => input.endsWith("/src/server/extension-host/native-assets.ts")), true, "production helper must be bundled");
	const outputImports = Object.values(metafile.outputs).flatMap(output => output.imports);
	assert.ok(outputImports.every(edge => edge.external && edge.path.startsWith("node:")), `unexpected runtime edge: ${JSON.stringify(outputImports)}`);
	assert.doesNotMatch(bundle, /bobbit:pack-native-assets/);
	assert.doesNotMatch(bundle, /src[\\/]server[\\/]extension-host[\\/]native-assets\.ts/);
	assert.doesNotMatch(bundle, /node_modules[\\/]/);
	assert.equal(bundle.includes(REPO_ROOT), false, "bundle must not embed its checkout path");
}

async function buildResolver(api: BuildApi, packRoot: string, sourceFile: string): Promise<string> {
	const outfile = path.join(packRoot, "lib", "resolver.mjs");
	const buildPromise = build({
		absWorkingDir: packRoot,
		entryPoints: [sourceFile],
		outfile,
		bundle: true,
		write: false,
		metafile: true,
		format: "esm",
		platform: "node",
		target: "es2022",
		minify: true,
		legalComments: "none",
		splitting: false,
		plugins: [api.packNativeAssetsPlugin({ projectRoot: REPO_ROOT, platform: "node" })],
	});
	outstandingBuilds.add(buildPromise);
	let result: Awaited<typeof buildPromise>;
	try {
		result = await buildPromise;
	} finally {
		outstandingBuilds.delete(buildPromise);
	}
	assert.ok(result.outputFiles);
	assert.equal(result.outputFiles.length, 1);
	const bundle = result.outputFiles[0].text;
	assertSelfContainedBundle(result, bundle);
	fs.mkdirSync(path.dirname(outfile), { recursive: true });
	fs.writeFileSync(outfile, bundle, "utf8");
	return outfile;
}

function createBundleFixture(): { root: string; packRoot: string; sourceFile: string } {
	const root = makeTmpDir("pack-native-assets-bundle-");
	temporaryRoots.add(root);
	const packRoot = path.join(root, "source", "fixture-pack");
	const sourceFile = writeResolverSource(packRoot);
	const family = path.join(packRoot, "lib", "native", "database-driver");
	const target = "linux-musl-arm64";
	const filename = `${target}.node`;
	const bytes = Buffer.from(`fixture-native:${target}\n`, "utf8");
	fs.mkdirSync(family, { recursive: true });
	fs.writeFileSync(path.join(family, filename), bytes);
	writeJson(path.join(family, "manifest.json"), {
		schema: 1,
		package: "fixture-native",
		version: PACKAGE_VERSION,
		targets: {
			[target]: {
				file: filename,
				size: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
		},
	});
	return { root, packRoot, sourceFile };
}

async function runBuiltinCopy(fixtureRoot: string, outputRoot: string): Promise<void> {
	for (const name of [PACK_NAME, "performance-optimisation", "pr-walkthrough", "terminal"]) {
		fs.mkdirSync(path.join(fixtureRoot, "market-packs", name), { recursive: true });
	}
	const previousCwd = process.cwd();
	const previousOutput = process.env.BOBBIT_SERVER_OUT_DIR;
	try {
		process.chdir(fixtureRoot);
		process.env.BOBBIT_SERVER_OUT_DIR = outputRoot;
		await import(`${pathToFileURL(COPY_BUILTIN_PACKS).href}?release-fixture=${Date.now()}`);
	} finally {
		process.chdir(previousCwd);
		if (previousOutput === undefined) delete process.env.BOBBIT_SERVER_OUT_DIR;
		else process.env.BOBBIT_SERVER_OUT_DIR = previousOutput;
	}
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

afterEach(async () => {
	// esbuild's build API has no cancellation handle, and a Vitest timeout does
	// not stop the pending promise. Keep fixture sources alive until every real
	// build settles so teardown and retries cannot race the same build lifecycle.
	await Promise.allSettled([...outstandingBuilds]);
	for (const root of temporaryRoots) {
		restoreWritable(root);
		fs.rmSync(root, { recursive: true, force: true });
	}
	temporaryRoots.clear();
}, REAL_PROCESS_TEST_TIMEOUT_MS);

describe("bobbit:pack-native-assets build-only alias", () => {
	it("inlines the Node helper and runs from an installed read-only pack without runtime host edges", async () => {
		const fixture = createBundleFixture();
		const api = await loadBuildApi();
		await buildResolver(api, fixture.packRoot, fixture.sourceFile);

		const installedPack = path.join(fixture.root, "installed", "fixture-pack");
		fs.cpSync(fixture.packRoot, installedPack, { recursive: true });
		makeReadOnly(installedPack);
		const installedBundle = path.join(installedPack, "lib", "resolver.mjs");
		const installedModule = await import(`${pathToFileURL(installedBundle).href}?fixture=${Date.now()}`) as {
			resolveFixtureBinding(family: string, runtime: NativeAssetRuntime): string;
		};
		const installedFamily = path.join(installedPack, "lib", "native", "database-driver");
		const resolved = installedModule.resolveFixtureBinding(installedFamily, {
			platform: "linux",
			arch: "arm64",
			glibcVersionRuntime: null,
		});
		assert.equal(resolved, path.join(installedFamily, "linux-musl-arm64.node"));
		assert.equal(path.relative(installedPack, resolved).startsWith(".."), false);
	}, REAL_PROCESS_TEST_TIMEOUT_MS);

	it("materializes, bundles, copies, packs, installs, and selects all eight assets read-only", async () => {
		const root = makeTmpDir("pack-native-assets-release-");
		temporaryRoots.add(root);
		const projectRoot = path.join(root, "project");
		const releaseRoot = path.join(projectRoot, "release");
		const packRoot = path.join(releaseRoot, "market-packs", PACK_NAME);
		const packageRoot = path.join(projectRoot, "node_modules", PACKAGE_NAME);
		const outputRoot = path.join(releaseRoot, "dist");
		const tarballRoot = path.join(root, "tarballs");
		const consumerRoot = path.join(root, "consumer");
		const npmCache = path.join(root, "npm-cache");
		const api = await loadBuildApi();

		writeJson(path.join(projectRoot, "package.json"), {
			name: "fixture-native-build-owner",
			private: true,
			dependencies: { [PACKAGE_NAME]: PACKAGE_VERSION },
		});
		writeJson(path.join(packageRoot, "package.json"), {
			name: PACKAGE_NAME,
			version: PACKAGE_VERSION,
		});
		const expectedBytes = new Map<CanonicalTarget, Buffer>();
		const declaredTargets: Record<CanonicalTarget, string> = {} as Record<CanonicalTarget, string>;
		for (const target of CANONICAL_TARGETS) {
			const source = `prebuilds/${target}.node`;
			const bytes = Buffer.from(`fixture-native:${target}\n`, "utf8");
			declaredTargets[target] = source;
			expectedBytes.set(target, bytes);
			fs.mkdirSync(path.dirname(path.join(packageRoot, source)), { recursive: true });
			fs.writeFileSync(path.join(packageRoot, source), bytes);
		}
		writeJson(path.join(packRoot, "pack.build.json"), {
			schema: 1,
			nativeAssets: [{ id: FAMILY_ID, package: PACKAGE_NAME, targets: declaredTargets }],
		});
		writeJson(path.join(packRoot, "pack.yaml"), { schema: 2, name: PACK_NAME, version: "1.0.0" });
		const sourceFile = writeResolverSource(packRoot);
		fs.mkdirSync(path.join(packRoot, "node_modules", "must-not-ship"), { recursive: true });
		fs.writeFileSync(path.join(packRoot, "node_modules", "must-not-ship", "index.js"), "export {};\n", "utf8");

		const materialized = api.materializePackNativeAssets({
			projectRoot,
			packRoot,
			resolvePackageRoot: packageName => {
				expect(packageName).toBe(PACKAGE_NAME);
				return packageRoot;
			},
		});
		const family = path.join(packRoot, "lib", "native", FAMILY_ID);
		expect(materialized).toEqual([family]);
		const manifestText = fs.readFileSync(path.join(family, "manifest.json"), "utf8");
		const manifest = JSON.parse(manifestText) as {
			schema: number;
			package: string;
			version: string;
			targets: Record<CanonicalTarget, { file: string; size: number; sha256: string }>;
		};
		expect(manifest.schema).toBe(1);
		expect(manifest.package).toBe(PACKAGE_NAME);
		expect(manifest.version).toBe(PACKAGE_VERSION);
		expect(Object.keys(manifest.targets)).toEqual([...CANONICAL_TARGETS]);
		for (const target of CANONICAL_TARGETS) {
			const bytes = expectedBytes.get(target)!;
			expect(manifest.targets[target]).toEqual({
				file: `${target}.node`,
				size: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			});
			expect(fs.readFileSync(path.join(family, `${target}.node`))).toEqual(bytes);
		}

		await buildResolver(api, packRoot, sourceFile);
		writeJson(path.join(releaseRoot, "package.json"), {
			name: "@fixture/bobbit-native-release",
			version: "1.0.0",
			files: ["dist/"],
		});
		await runBuiltinCopy(releaseRoot, outputRoot);
		const copiedPack = path.join(outputRoot, "server", "builtin-packs", "market-packs", PACK_NAME);
		const copiedFamily = path.join(copiedPack, "lib", "native", FAMILY_ID);
		expect(fs.readFileSync(path.join(copiedFamily, "manifest.json"), "utf8")).toBe(manifestText);
		expect(fs.existsSync(path.join(copiedPack, "src"))).toBe(false);
		expect(fs.existsSync(path.join(copiedPack, "node_modules"))).toBe(false);

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

		const resolverFile = path.join(installedPack, "lib", "resolver.mjs");
		const resolverBefore = fs.readFileSync(resolverFile);
		const installedModule = await import(`${pathToFileURL(resolverFile).href}?release=${Date.now()}`) as {
			resolveFixtureBinding(familyDirectory: string, runtime: NativeAssetRuntime): string;
		};
		for (const [target, runtime] of TARGET_RUNTIMES) {
			const resolved = installedModule.resolveFixtureBinding(installedFamily, runtime);
			expect(resolved).toBe(path.join(installedFamily, `${target}.node`));
			const relative = path.relative(installedPack, resolved);
			expect(path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)).toBe(false);
			expect(fs.readFileSync(resolved)).toEqual(expectedBytes.get(target));
			expect(fs.readFileSync(resolved)).toEqual(fs.readFileSync(path.join(family, `${target}.node`)));
		}
		expect(fs.readFileSync(resolverFile)).toEqual(resolverBefore);
	}, REAL_PROCESS_TEST_TIMEOUT_MS);

	it("rejects the helper alias in browser bundles and rejects unknown bobbit aliases", async () => {
		const fixture = createBundleFixture();
		const api = await loadBuildApi();
		const entry = path.join(fixture.packRoot, "entry.ts");
		fs.writeFileSync(entry, 'import "bobbit:pack-native-assets";\n', "utf8");
		await expect(build({
			entryPoints: [entry],
			bundle: true,
			write: false,
			platform: "browser",
			plugins: [api.packNativeAssetsPlugin({ projectRoot: REPO_ROOT, platform: "browser" })],
			logLevel: "silent",
		})).rejects.toThrow(/bobbit:pack-native-assets|node|browser|platform/i);

		fs.writeFileSync(entry, 'import "bobbit:anything-else";\n', "utf8");
		await expect(build({
			entryPoints: [entry],
			bundle: true,
			write: false,
			platform: "node",
			plugins: [api.packNativeAssetsPlugin({ projectRoot: REPO_ROOT, platform: "node" })],
			logLevel: "silent",
		})).rejects.toThrow(/bobbit:anything-else|unsupported|unknown/i);
	}, 60_000);
});
