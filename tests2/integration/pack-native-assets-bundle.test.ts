// v2-e2e-vitest real-process owner: esbuild's JavaScript API launches its
// platform binary, so real bundle fidelity must remain outside subprocess-free tier 1.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
	packNativeAssetsPlugin(options: { projectRoot: string; platform: string }): Plugin;
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const BUILD_MODULE = pathToFileURL(path.join(REPO_ROOT, "scripts", "pack-native-assets.mjs")).href;
const temporaryRoots = new Set<string>();

async function loadBuildApi(): Promise<BuildApi> {
	return await import(/* @vite-ignore */ BUILD_MODULE) as unknown as BuildApi;
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

function createFixturePack(): { root: string; packRoot: string; sourceFile: string } {
	const root = makeTmpDir("pack-native-assets-bundle-");
	temporaryRoots.add(root);
	const packRoot = path.join(root, "source", "fixture-pack");
	const sourceFile = path.join(packRoot, "src", "resolver.ts");
	fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
	fs.writeFileSync(sourceFile, [
		'import { resolvePackNativeAsset } from "bobbit:pack-native-assets";',
		"export const resolveFixtureBinding = (familyDirectory: string, runtime: { platform: string; arch: string; glibcVersionRuntime?: string | null }) =>",
		"  resolvePackNativeAsset(familyDirectory, runtime);",
		"",
	].join("\n"), "utf8");

	const family = path.join(packRoot, "lib", "native", "database-driver");
	const target = "linux-musl-arm64";
	const filename = `${target}.node`;
	const bytes = Buffer.from("fixture-native:linux-musl-arm64\n", "utf8");
	fs.mkdirSync(family, { recursive: true });
	fs.writeFileSync(path.join(family, filename), bytes);
	fs.writeFileSync(path.join(family, "manifest.json"), `${JSON.stringify({
		schema: 1,
		package: "fixture-native",
		version: "1.2.3",
		targets: {
			[target]: {
				file: filename,
				size: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
		},
	}, null, 2)}\n`, "utf8");
	return { root, packRoot, sourceFile };
}

afterEach(() => {
	for (const root of temporaryRoots) {
		restoreWritable(root);
		fs.rmSync(root, { recursive: true, force: true });
	}
	temporaryRoots.clear();
});

describe("bobbit:pack-native-assets build-only alias", () => {
	it("inlines the Node helper and runs from an installed read-only pack without runtime host edges", async () => {
		const fixture = createFixturePack();
		const api = await loadBuildApi();
		const result = await build({
			absWorkingDir: fixture.packRoot,
			entryPoints: [fixture.sourceFile],
			outfile: path.join(fixture.packRoot, "lib", "resolver.mjs"),
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
		assert.ok(result.outputFiles);
		assert.equal(result.outputFiles.length, 1);
		const bundle = result.outputFiles[0].text;
		const metafile = result.metafile as Metafile;
		const normalizedInputs = Object.keys(metafile.inputs).map(input => input.replaceAll("\\", "/"));
		assert.equal(normalizedInputs.some(input => input.endsWith("/src/server/extension-host/native-assets.ts")), true, "production helper must be bundled");
		const outputImports = Object.values(metafile.outputs).flatMap(output => output.imports);
		assert.ok(outputImports.every(edge => edge.external && edge.path.startsWith("node:")), `unexpected runtime edge: ${JSON.stringify(outputImports)}`);
		assert.doesNotMatch(bundle, /bobbit:pack-native-assets/);
		assert.doesNotMatch(bundle, /src[\\/]server[\\/]extension-host[\\/]native-assets\.ts/);
		assert.doesNotMatch(bundle, /node_modules[\\/]/);
		assert.equal(bundle.includes(REPO_ROOT), false, "bundle must not embed its checkout path");

		const installedPack = path.join(fixture.root, "installed", "fixture-pack");
		fs.cpSync(fixture.packRoot, installedPack, { recursive: true });
		const installedBundle = path.join(installedPack, "lib", "resolver.mjs");
		fs.writeFileSync(installedBundle, bundle, "utf8");
		makeReadOnly(installedPack);
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
	}, 60_000);

	it("rejects the helper alias in browser bundles and rejects unknown bobbit aliases", async () => {
		const fixture = createFixturePack();
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
