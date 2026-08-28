import { afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTmpDir } from "../../tests/helpers/tmp.ts";

type NativeAssetRuntime = {
	platform: string;
	arch: string;
	glibcVersionRuntime?: string | null;
};

type NativeAssetApi = {
	currentNativeAssetRuntime(): NativeAssetRuntime;
	selectNativeAssetTarget(runtime: NativeAssetRuntime): string;
	resolvePackNativeAsset(familyDirectory: string | URL, runtime?: NativeAssetRuntime): string;
};

type MaterializeOptions = {
	projectRoot: string;
	packRoot: string;
	resolvePackageRoot?: (packageName: string) => string | Promise<string>;
};

type BuildApi = {
	readPackBuildMetadata(packRoot: string): unknown | Promise<unknown>;
	materializePackNativeAssets(options: MaterializeOptions): unknown | Promise<unknown>;
};

type JsonObject = Record<string, any>;

type Fixture = {
	root: string;
	projectRoot: string;
	packRoot: string;
	packageRoot: string;
	metadata: JsonObject;
	markers: Record<string, Buffer>;
	resolvePackageRoot: (packageName: string) => string;
};

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BUILD_MODULE = pathToFileURL(path.join(REPO_ROOT, "scripts", "pack-native-assets.mjs")).href;
const RUNTIME_MODULE = pathToFileURL(path.join(REPO_ROOT, "src", "server", "extension-host", "native-assets.ts")).href;

const TARGETS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-glibc-arm64",
	"linux-glibc-x64",
	"linux-musl-arm64",
	"linux-musl-x64",
	"win32-arm64",
	"win32-x64",
] as const;

const runtimes: Array<[NativeAssetRuntime, (typeof TARGETS)[number]]> = [
	[{ platform: "darwin", arch: "arm64" }, "darwin-arm64"],
	[{ platform: "darwin", arch: "x64" }, "darwin-x64"],
	[{ platform: "linux", arch: "arm64", glibcVersionRuntime: "2.39" }, "linux-glibc-arm64"],
	[{ platform: "linux", arch: "x64", glibcVersionRuntime: "2.17" }, "linux-glibc-x64"],
	[{ platform: "linux", arch: "arm64", glibcVersionRuntime: null }, "linux-musl-arm64"],
	[{ platform: "linux", arch: "x64" }, "linux-musl-x64"],
	[{ platform: "win32", arch: "arm64" }, "win32-arm64"],
	[{ platform: "win32", arch: "x64" }, "win32-x64"],
];

const temporaryRoots = new Set<string>();

async function loadBuildApi(): Promise<BuildApi> {
	return await import(/* @vite-ignore */ BUILD_MODULE) as unknown as BuildApi;
}

async function loadRuntimeApi(): Promise<NativeAssetApi> {
	return await import(/* @vite-ignore */ RUNTIME_MODULE) as unknown as NativeAssetApi;
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createFixture(options: {
	dependencyKind?: "dependencies" | "devDependencies" | "missing";
	dependencyVersion?: string;
	installedName?: string;
	installedVersion?: string;
} = {}): Fixture {
	const root = makeTmpDir("pack-native-assets-");
	temporaryRoots.add(root);
	const projectRoot = path.join(root, "project");
	const packRoot = path.join(projectRoot, "market-packs", "fixture-pack");
	const packageRoot = path.join(projectRoot, "node_modules", "fixture-native");
	const packageName = "fixture-native";
	const installedVersion = options.installedVersion ?? "1.2.3";
	const dependencyKind = options.dependencyKind ?? "dependencies";
	const projectPackage: JsonObject = { name: "fixture-project", private: true };
	if (dependencyKind !== "missing") projectPackage[dependencyKind] = { [packageName]: options.dependencyVersion ?? installedVersion };
	writeJson(path.join(projectRoot, "package.json"), projectPackage);
	writeJson(path.join(packageRoot, "package.json"), {
		name: options.installedName ?? packageName,
		version: installedVersion,
		main: "index.js",
	});
	fs.writeFileSync(path.join(packageRoot, "index.js"), "module.exports = {};\n", "utf8");

	const markers: Record<string, Buffer> = {};
	const declaredTargets: Record<string, string> = {};
	// Deliberately declare in reverse order: output and manifest order are canonical.
	for (const [index, target] of [...TARGETS].reverse().entries()) {
		const relativeSource = path.posix.join("prebuilds", target, "binding.node");
		const bytes = Buffer.from(`fixture-native:${target}:${index}\n`, "utf8");
		markers[target] = bytes;
		declaredTargets[target] = relativeSource;
		const source = path.join(packageRoot, ...relativeSource.split("/"));
		fs.mkdirSync(path.dirname(source), { recursive: true });
		fs.writeFileSync(source, bytes);
	}
	const metadata = {
		schema: 1,
		nativeAssets: [{
			id: "database-driver",
			package: packageName,
			targets: declaredTargets,
		}],
	};
	fs.mkdirSync(packRoot, { recursive: true });
	writeJson(path.join(packRoot, "pack.build.json"), metadata);
	return {
		root,
		projectRoot,
		packRoot,
		packageRoot,
		metadata,
		markers,
		resolvePackageRoot(packageToResolve: string): string {
			assert.equal(packageToResolve, packageName);
			return packageRoot;
		},
	};
}

function familyDirectory(fixture: Fixture): string {
	return path.join(fixture.packRoot, "lib", "native", "database-driver");
}

function snapshotTree(root: string): Record<string, string> {
	const snapshot: Record<string, string> = {};
	function visit(directory: string): void {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const absolute = path.join(directory, entry.name);
			const relative = path.relative(root, absolute).split(path.sep).join("/");
			if (entry.isDirectory()) visit(absolute);
			else snapshot[relative] = fs.readFileSync(absolute).toString("base64");
		}
	}
	if (fs.existsSync(root)) visit(root);
	return snapshot;
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function manifestRecord(manifest: JsonObject, target: string): { file: string; size: number; hash: string } {
	const targetValue = manifest.targets?.[target];
	if (typeof targetValue === "string") {
		return {
			file: targetValue,
			size: manifest.sizes?.[target],
			hash: manifest.hashes?.[target] ?? manifest.sha256?.[target],
		};
	}
	return {
		file: targetValue?.file ?? targetValue?.filename,
		size: targetValue?.size ?? targetValue?.bytes,
		hash: targetValue?.hash ?? targetValue?.sha256,
	};
}

async function materialize(fixture: Fixture): Promise<void> {
	const api = await loadBuildApi();
	await api.materializePackNativeAssets({
		projectRoot: fixture.projectRoot,
		packRoot: fixture.packRoot,
		resolvePackageRoot: fixture.resolvePackageRoot,
	});
}

function mutateMetadata(fixture: Fixture, mutate: (metadata: JsonObject) => void): void {
	const metadata = structuredClone(fixture.metadata);
	mutate(metadata);
	writeJson(path.join(fixture.packRoot, "pack.build.json"), metadata);
}

function restoreWritable(root: string): void {
	if (process.platform === "win32" || !fs.existsSync(root)) return;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const absolute = path.join(root, entry.name);
		// Cleanup must not follow fixture symlinks and mutate their targets.
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) restoreWritable(absolute);
		try { fs.chmodSync(absolute, entry.isDirectory() ? 0o755 : 0o644); } catch { /* best effort cleanup */ }
	}
	try { fs.chmodSync(root, 0o755); } catch { /* best effort cleanup */ }
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of temporaryRoots) {
		restoreWritable(root);
		fs.rmSync(root, { recursive: true, force: true });
	}
	temporaryRoots.clear();
});

describe("first-party pack native asset materialization", () => {
	it("reads adjacent metadata and treats a missing declaration as no opt-in", async () => {
		const fixture = createFixture();
		const api = await loadBuildApi();
		assert.deepEqual(await api.readPackBuildMetadata(fixture.packRoot), fixture.metadata);
		fs.rmSync(path.join(fixture.packRoot, "pack.build.json"));
		const absent = await api.readPackBuildMetadata(fixture.packRoot);
		assert.ok(absent === null || absent === undefined);
	});

	it("copies all eight canonical targets and writes a deterministic versioned hash manifest", async () => {
		const fixture = createFixture();
		await materialize(fixture);
		const family = familyDirectory(fixture);
		assert.deepEqual(fs.readdirSync(family).sort(), [...TARGETS.map(target => `${target}.node`), "manifest.json"].sort());
		for (const target of TARGETS) {
			assert.deepEqual(fs.readFileSync(path.join(family, `${target}.node`)), fixture.markers[target]);
		}

		const manifestText = fs.readFileSync(path.join(family, "manifest.json"), "utf8");
		const manifest = JSON.parse(manifestText) as JsonObject;
		assert.equal(manifest.schema, 1);
		assert.equal(manifest.package, "fixture-native");
		assert.equal(manifest.version ?? manifest.packageVersion, "1.2.3");
		assert.deepEqual(Object.keys(manifest.targets), [...TARGETS]);
		for (const target of TARGETS) {
			assert.deepEqual(manifestRecord(manifest, target), {
				file: `${target}.node`,
				size: fixture.markers[target].byteLength,
				hash: sha256(fixture.markers[target]),
			});
		}
	});

	it("is byte-idempotent and atomically replaces a family while removing stale outputs", async () => {
		const fixture = createFixture();
		await materialize(fixture);
		const family = familyDirectory(fixture);
		const first = snapshotTree(family);
		await materialize(fixture);
		assert.deepEqual(snapshotTree(family), first);

		fs.writeFileSync(path.join(family, "stale-target.node"), "stale", "utf8");
		const changedTarget = "linux-glibc-x64";
		const changedSource = path.join(fixture.packageRoot, "prebuilds", changedTarget, "binding.node");
		const replacement = Buffer.from("replacement-linux-binding\n", "utf8");
		fs.writeFileSync(changedSource, replacement);
		fixture.markers[changedTarget] = replacement;
		await materialize(fixture);
		assert.equal(fs.existsSync(path.join(family, "stale-target.node")), false);
		assert.deepEqual(fs.readFileSync(path.join(family, `${changedTarget}.node`)), replacement);
	});

	it("removes generated families that are no longer declared or whose metadata was removed", async () => {
		const fixture = createFixture();
		const second = structuredClone(fixture.metadata.nativeAssets[0]);
		second.id = "second-driver";
		fixture.metadata.nativeAssets.push(second);
		writeJson(path.join(fixture.packRoot, "pack.build.json"), fixture.metadata);
		await materialize(fixture);
		const nativeRoot = path.join(fixture.packRoot, "lib", "native");
		assert.equal(fs.existsSync(path.join(nativeRoot, "database-driver")), true);
		assert.equal(fs.existsSync(path.join(nativeRoot, "second-driver")), true);

		fixture.metadata.nativeAssets.pop();
		writeJson(path.join(fixture.packRoot, "pack.build.json"), fixture.metadata);
		await materialize(fixture);
		assert.equal(fs.existsSync(path.join(nativeRoot, "database-driver")), true);
		assert.equal(fs.existsSync(path.join(nativeRoot, "second-driver")), false);

		fs.rmSync(path.join(fixture.packRoot, "pack.build.json"));
		await materialize(fixture);
		assert.equal(fs.existsSync(path.join(nativeRoot, "database-driver")), false);
	});

	it("validates every source before mutation and preserves the previous family on failure", async () => {
		const fixture = createFixture();
		await materialize(fixture);
		const family = familyDirectory(fixture);
		fs.writeFileSync(path.join(family, "preexisting-extra.node"), "must-survive", "utf8");
		const beforeFailure = snapshotTree(family);
		const missingTarget = "win32-arm64";
		const source = path.join(fixture.packageRoot, "prebuilds", missingTarget, "binding.node");
		fs.rmSync(source);
		await assert.rejects(
			() => materialize(fixture),
			(error: Error) => /fixture-native/i.test(error.message)
				&& /1\.2\.3/.test(error.message)
				&& /win32-arm64/i.test(error.message)
				&& /binding\.node/i.test(error.message),
		);
		assert.deepEqual(snapshotTree(family), beforeFailure);
	});

	it("rejects a symlink or junction native root without deleting its external generated family", async (context) => {
		const fixture = createFixture();
		await materialize(fixture);
		const nativeRoot = path.join(fixture.packRoot, "lib", "native");
		const outside = path.join(fixture.root, "outside-native");
		fs.renameSync(nativeRoot, outside);
		fs.writeFileSync(path.join(outside, "outside-sentinel"), "unchanged", "utf8");
		try {
			fs.symlinkSync(outside, nativeRoot, process.platform === "win32" ? "junction" : "dir");
		} catch (error: any) {
			if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
				context.skip();
				return;
			}
			throw error;
		}

		await assert.rejects(() => materialize(fixture), /stable real directory|alias|symlink/i);
		assert.equal(fs.readFileSync(path.join(outside, "outside-sentinel"), "utf8"), "unchanged");
		assert.equal(fs.existsSync(path.join(outside, "database-driver", "darwin-arm64.node")), true);
	});

	it("restores the exact previous family when destination publication rename fails", async () => {
		const fixture = createFixture();
		await materialize(fixture);
		const family = familyDirectory(fixture);
		const before = snapshotTree(family);
		const changedSource = path.join(fixture.packageRoot, "prebuilds", "darwin-arm64", "binding.node");
		fs.writeFileSync(changedSource, "must-not-publish", "utf8");
		const realRename = fs.renameSync.bind(fs);
		const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (path.basename(String(from)) === "staging" && String(to) === family) {
				throw Object.assign(new Error("injected publication rename failure"), { code: "EIO" });
			}
			return realRename(from, to);
		});

		await assert.rejects(() => materialize(fixture), /injected publication rename failure/);
		renameSpy.mockRestore();
		assert.deepEqual(snapshotTree(family), before);
		assert.equal(fs.readdirSync(fixture.packRoot).some((name) => name.includes("native-assets")), false);
	});

	it("treats destination publication as committed when old-tree cleanup fails", async () => {
		const fixture = createFixture();
		await materialize(fixture);
		const changedTarget = "darwin-arm64";
		const changedSource = path.join(fixture.packageRoot, "prebuilds", changedTarget, "binding.node");
		const replacement = Buffer.from("committed-replacement", "utf8");
		fs.writeFileSync(changedSource, replacement);
		const realUnlink = fs.unlinkSync.bind(fs);
		let injected = false;
		const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
			if (!injected && String(file).includes(`${path.sep}backup${path.sep}`)) {
				injected = true;
				throw Object.assign(new Error("injected post-commit cleanup failure"), { code: "EIO" });
			}
			return realUnlink(file);
		});

		await materialize(fixture);
		unlinkSpy.mockRestore();
		assert.equal(injected, true);
		assert.deepEqual(fs.readFileSync(path.join(familyDirectory(fixture), `${changedTarget}.node`)), replacement);
		assert.equal(fs.readdirSync(fixture.packRoot).some((name) => name.includes("stage-") || name.includes("backup-")), false);
	});

	it.each([
		["unknown schema", (metadata: JsonObject) => { metadata.schema = 2; }, /schema|version/i],
		["unknown root key", (metadata: JsonObject) => { metadata.unexpected = true; }, /unknown|unexpected/i],
		["unknown asset key", (metadata: JsonObject) => { metadata.nativeAssets[0].destination = "elsewhere"; }, /unknown|destination/i],
		["unknown target", (metadata: JsonObject) => { metadata.nativeAssets[0].targets["freebsd-x64"] = "prebuilds/freebsd.node"; }, /target|freebsd/i],
		["incomplete target matrix", (metadata: JsonObject) => { delete metadata.nativeAssets[0].targets["linux-musl-arm64"]; }, /target|linux-musl-arm64|complete/i],
		["duplicate family id", (metadata: JsonObject) => { metadata.nativeAssets.push(structuredClone(metadata.nativeAssets[0])); }, /duplicate|database-driver/i],
		["unsafe family id", (metadata: JsonObject) => { metadata.nativeAssets[0].id = "../escape"; }, /id|escape|safe/i],
		["invalid package name", (metadata: JsonObject) => { metadata.nativeAssets[0].package = "../fixture-native"; }, /package|fixture-native/i],
		["absolute source", (metadata: JsonObject) => { metadata.nativeAssets[0].targets["darwin-arm64"] = path.resolve("outside.node"); }, /darwin-arm64|relative|source/i],
		["non-node source", (metadata: JsonObject) => { metadata.nativeAssets[0].targets["darwin-arm64"] = "prebuilds/file.txt"; }, /darwin-arm64|\.node|source/i],
	] as const)("rejects %s", async (_label, mutate, expected) => {
		const fixture = createFixture();
		mutateMetadata(fixture, mutate);
		await assert.rejects(() => materialize(fixture), expected);
		assert.equal(fs.existsSync(familyDirectory(fixture)), false);
	});

	it("rejects lexical traversal outside the exact package root", async () => {
		const fixture = createFixture();
		const outside = path.join(fixture.projectRoot, "outside.node");
		fs.writeFileSync(outside, "outside", "utf8");
		mutateMetadata(fixture, metadata => {
			metadata.nativeAssets[0].targets["darwin-arm64"] = "../../outside.node";
		});
		await assert.rejects(() => materialize(fixture), /darwin-arm64|travers|contain|outside/i);
		assert.equal(fs.existsSync(familyDirectory(fixture)), false);
	});

	it("rejects a symlink whose real path escapes the exact package root", async (context) => {
		const fixture = createFixture();
		const outside = path.join(fixture.projectRoot, "outside.node");
		const link = path.join(fixture.packageRoot, "prebuilds", "escaped.node");
		fs.writeFileSync(outside, "outside", "utf8");
		try {
			fs.symlinkSync(outside, link, process.platform === "win32" ? "file" : undefined);
		} catch (error: any) {
			if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
				context.skip();
				return;
			}
			throw error;
		}
		mutateMetadata(fixture, metadata => {
			metadata.nativeAssets[0].targets["darwin-arm64"] = "prebuilds/escaped.node";
		});
		await assert.rejects(() => materialize(fixture), /darwin-arm64|symlink|contain|escape/i);
		assert.equal(fs.existsSync(familyDirectory(fixture)), false);
	});

	it("rejects non-regular declared sources", async () => {
		const fixture = createFixture();
		const declaredDirectory = path.join(fixture.packageRoot, "prebuilds", "directory.node");
		fs.mkdirSync(declaredDirectory);
		mutateMetadata(fixture, metadata => {
			metadata.nativeAssets[0].targets["darwin-arm64"] = "prebuilds/directory.node";
		});
		await assert.rejects(() => materialize(fixture), /darwin-arm64|regular|file/i);
		assert.equal(fs.existsSync(familyDirectory(fixture)), false);
	});

	it.each(["devDependencies", "missing"] as const)("rejects a package declared only in %s", async dependencyKind => {
		const fixture = createFixture({ dependencyKind });
		await assert.rejects(() => materialize(fixture), /fixture-native|direct|production|dependenc/i);
		assert.equal(fs.existsSync(familyDirectory(fixture)), false);
	});

	it("rejects a resolver result whose package manifest has a different name", async () => {
		const fixture = createFixture({ installedName: "lookalike-native" });
		await assert.rejects(() => materialize(fixture), /fixture-native|lookalike-native|package|mismatch/i);
		assert.equal(fs.existsSync(familyDirectory(fixture)), false);
	});

	it("rejects an installed package version that disagrees with the locked direct dependency", async () => {
		const fixture = createFixture({ dependencyVersion: "9.9.9", installedVersion: "1.2.3" });
		await assert.rejects(() => materialize(fixture), /fixture-native|1\.2\.3|9\.9\.9|version|mismatch/i);
		assert.equal(fs.existsSync(familyDirectory(fixture)), false);
	});
});

describe("native asset runtime selection and resolution", () => {
	it("detects the current Node platform, architecture, and Linux libc fact", async () => {
		const api = await loadRuntimeApi();
		const runtime = api.currentNativeAssetRuntime();
		assert.equal(runtime.platform, process.platform);
		assert.equal(runtime.arch, process.arch);
		if (process.platform === "linux") {
			const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
			const glibc = report?.header?.glibcVersionRuntime;
			assert.equal(runtime.glibcVersionRuntime ?? undefined, glibc ?? undefined);
		}
	});

	it.each(runtimes)("maps $0 to %s", async (runtime, expectedTarget) => {
		const api = await loadRuntimeApi();
		assert.equal(api.selectNativeAssetTarget(runtime), expectedTarget);
	});

	it.each([
		[{ platform: "freebsd", arch: "x64" }, /freebsd|supported/i],
		[{ platform: "darwin", arch: "ia32" }, /darwin|ia32|supported/i],
		[{ platform: "linux", arch: "riscv64", glibcVersionRuntime: "2.39" }, /linux|glibc|riscv64|supported/i],
		[{ platform: "win32", arch: "ia32" }, /win32|ia32|supported/i],
	] as const)("fails explicitly for unsupported runtime %j", async (runtime, expected) => {
		const api = await loadRuntimeApi();
		assert.throws(() => api.selectNativeAssetTarget(runtime), expected);
	});

	it("resolves all selected files beneath the supplied family for injected non-host runtimes", async () => {
		const fixture = createFixture();
		await materialize(fixture);
		const api = await loadRuntimeApi();
		const family = familyDirectory(fixture);
		for (const [runtime, target] of runtimes) {
			const resolved = api.resolvePackNativeAsset(pathToFileURL(`${family}${path.sep}`), runtime);
			assert.equal(resolved, path.join(family, `${target}.node`));
			assert.equal(path.relative(family, resolved).startsWith(".."), false);
		}
	});

	it("reports corrupt, missing-family, unavailable-target, escaped-file, and missing-file errors with context", async () => {
		const fixture = createFixture();
		await materialize(fixture);
		const api = await loadRuntimeApi();
		const family = familyDirectory(fixture);
		const manifestFile = path.join(family, "manifest.json");
		const originalManifest = fs.readFileSync(manifestFile, "utf8");
		const runtime = { platform: "linux", arch: "x64", glibcVersionRuntime: "2.39" };

		fs.writeFileSync(manifestFile, "{not-json", "utf8");
		assert.throws(() => api.resolvePackNativeAsset(family, runtime), /manifest|corrupt|json/i);
		fs.writeFileSync(manifestFile, originalManifest, "utf8");
		assert.throws(() => api.resolvePackNativeAsset(path.join(fixture.root, "missing-family"), runtime), /family|manifest|missing|enoent/i);

		const manifest = JSON.parse(originalManifest) as JsonObject;
		delete manifest.targets["linux-glibc-x64"];
		if (manifest.sizes) delete manifest.sizes["linux-glibc-x64"];
		if (manifest.hashes) delete manifest.hashes["linux-glibc-x64"];
		if (manifest.sha256) delete manifest.sha256["linux-glibc-x64"];
		writeJson(manifestFile, manifest);
		assert.throws(
			() => api.resolvePackNativeAsset(family, runtime),
			(error: Error) => /fixture-native/i.test(error.message) && /1\.2\.3/.test(error.message) && /linux-glibc-x64/i.test(error.message),
		);

		const escaped = JSON.parse(originalManifest) as JsonObject;
		if (typeof escaped.targets["linux-glibc-x64"] === "string") escaped.targets["linux-glibc-x64"] = "../../outside.node";
		else if ("file" in escaped.targets["linux-glibc-x64"]) escaped.targets["linux-glibc-x64"].file = "../../outside.node";
		else escaped.targets["linux-glibc-x64"].filename = "../../outside.node";
		writeJson(manifestFile, escaped);
		assert.throws(() => api.resolvePackNativeAsset(family, runtime), /linux-glibc-x64|contain|escape|filename/i);

		fs.writeFileSync(manifestFile, originalManifest, "utf8");
		fs.rmSync(path.join(family, "linux-glibc-x64.node"));
		assert.throws(
			() => api.resolvePackNativeAsset(family, runtime),
			(error: Error) => /fixture-native/i.test(error.message) && /1\.2\.3/.test(error.message) && /linux-glibc-x64/i.test(error.message) && /file|missing|regular/i.test(error.message),
		);
	});
});
