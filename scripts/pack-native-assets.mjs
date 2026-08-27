import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_ASSET_TARGETS = Object.freeze([
	"darwin-arm64",
	"darwin-x64",
	"linux-glibc-arm64",
	"linux-glibc-x64",
	"linux-musl-arm64",
	"linux-musl-x64",
	"win32-arm64",
	"win32-x64",
]);

const NATIVE_ASSET_TARGET_SET = new Set(NATIVE_ASSET_TARGETS);
const BUILD_METADATA_KEYS = new Set(["schema", "nativeAssets"]);
const NATIVE_ASSET_KEYS = new Set(["id", "package", "targets"]);
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function fail(message) {
	throw new Error(`[pack-native-assets] ${message}`);
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, allowed, context) {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) fail(`${context} has unknown field ${JSON.stringify(key)}`);
	}
	for (const key of allowed) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${context} is missing required field ${JSON.stringify(key)}`);
	}
}

function assertSafePackageName(packageName, context) {
	if (typeof packageName !== "string" || packageName.length > 214 || !SAFE_PACKAGE_NAME.test(packageName)) {
		fail(`${context} has invalid npm package name ${JSON.stringify(packageName)}`);
	}
}

function assertPortableSourcePath(source, context) {
	if (typeof source !== "string" || source.length === 0) fail(`${context} source must be a non-empty relative .node path`);
	if (source.includes("\\") || source.includes("\0") || path.posix.isAbsolute(source) || /^[A-Za-z]:/.test(source)) {
		fail(`${context} source ${JSON.stringify(source)} must be a portable relative .node path`);
	}
	const segments = source.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || !source.endsWith(".node")) {
		fail(`${context} source ${JSON.stringify(source)} must be a contained relative .node path`);
	}
}

function validateBuildMetadata(metadata, metadataPath) {
	if (!isPlainObject(metadata)) fail(`${metadataPath} must contain a JSON object`);
	assertExactKeys(metadata, BUILD_METADATA_KEYS, metadataPath);
	if (metadata.schema !== 1) fail(`${metadataPath} uses unsupported schema ${JSON.stringify(metadata.schema)}; expected 1`);
	if (!Array.isArray(metadata.nativeAssets)) fail(`${metadataPath} field "nativeAssets" must be an array`);

	const ids = new Set();
	for (const [index, asset] of metadata.nativeAssets.entries()) {
		const context = `${metadataPath} nativeAssets[${index}]`;
		if (!isPlainObject(asset)) fail(`${context} must be an object`);
		assertExactKeys(asset, NATIVE_ASSET_KEYS, context);
		if (typeof asset.id !== "string" || asset.id.length > 100 || !SAFE_ID.test(asset.id)) {
			fail(`${context} has unsafe id ${JSON.stringify(asset.id)}`);
		}
		if (ids.has(asset.id)) fail(`${context} duplicates native asset id ${JSON.stringify(asset.id)}`);
		ids.add(asset.id);
		assertSafePackageName(asset.package, context);
		if (!isPlainObject(asset.targets)) fail(`${context} field "targets" must be an object`);

		const declaredTargets = Object.keys(asset.targets);
		for (const target of declaredTargets) {
			if (!NATIVE_ASSET_TARGET_SET.has(target)) fail(`${context} declares unsupported target ${JSON.stringify(target)}`);
		}
		for (const target of NATIVE_ASSET_TARGETS) {
			if (!Object.prototype.hasOwnProperty.call(asset.targets, target)) fail(`${context} is missing required target ${target}`);
			assertPortableSourcePath(asset.targets[target], `${context} package=${asset.package} target=${target}`);
		}
		if (declaredTargets.length !== NATIVE_ASSET_TARGETS.length) fail(`${context} must declare exactly the eight supported targets`);
	}
	return metadata;
}

/** Read and validate repository-only build metadata adjacent to a first-party pack. */
export function readPackBuildMetadata(packRoot) {
	const metadataPath = path.join(path.resolve(packRoot), "pack.build.json");
	if (!fs.existsSync(metadataPath)) return null;
	let metadata;
	try {
		metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
	} catch (error) {
		fail(`could not parse ${metadataPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return validateBuildMetadata(metadata, metadataPath);
}

function isStrictlyInside(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readJsonFile(file, context) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		fail(`${context}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function defaultResolvePackageRoot(packageName, projectRoot) {
	const projectRequire = createRequire(path.join(projectRoot, "package.json"));
	let entry;
	try {
		entry = projectRequire.resolve(packageName);
	} catch (error) {
		fail(`could not resolve direct production dependency ${packageName} from ${projectRoot}: ${error instanceof Error ? error.message : String(error)}`);
	}

	let cursor = path.dirname(entry);
	while (true) {
		const manifestPath = path.join(cursor, "package.json");
		if (fs.existsSync(manifestPath)) {
			try {
				const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
				if (manifest?.name === packageName) return cursor;
			} catch {
				// Keep walking: only a readable manifest with the exact package name owns the entry.
			}
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	fail(`resolved entry ${entry} for ${packageName} has no matching package manifest`);
}

function replaceFamilyAtomically(destination, staging) {
	const parent = path.dirname(destination);
	const backup = path.join(parent, `.${path.basename(destination)}.backup-${randomUUID()}`);
	const hadDestination = fs.existsSync(destination);
	if (hadDestination) fs.renameSync(destination, backup);
	try {
		fs.renameSync(staging, destination);
	} catch (error) {
		fs.rmSync(staging, { recursive: true, force: true });
		if (hadDestination) {
			try {
				fs.renameSync(backup, destination);
			} catch (restoreError) {
				throw new AggregateError([error, restoreError], `failed to install and restore native asset family; previous family remains at ${backup}`);
			}
		}
		throw error;
	}
	if (hadDestination) fs.rmSync(backup, { recursive: true, force: true });
}

function isGeneratedFamily(directory, id) {
	if (!SAFE_ID.test(id)) return false;
	try {
		const directoryStats = fs.lstatSync(directory);
		if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return false;
		const manifestPath = path.join(directory, "manifest.json");
		const manifestStats = fs.lstatSync(manifestPath);
		if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) return false;
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		if (!isPlainObject(manifest) || Object.keys(manifest).sort().join(",") !== "package,schema,targets,version"
			|| manifest.schema !== 1 || typeof manifest.package !== "string" || manifest.package.length === 0
			|| typeof manifest.version !== "string" || manifest.version.length === 0 || !isPlainObject(manifest.targets)
			|| Object.keys(manifest.targets).length !== NATIVE_ASSET_TARGETS.length) return false;
		for (const target of NATIVE_ASSET_TARGETS) {
			const record = manifest.targets[target];
			if (!isPlainObject(record) || Object.keys(record).sort().join(",") !== "file,sha256,size"
				|| record.file !== `${target}.node` || !Number.isSafeInteger(record.size) || record.size < 0
				|| typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function removeStaleGeneratedFamilies(nativeRoot, currentIds) {
	if (!fs.existsSync(nativeRoot)) return;
	for (const entry of fs.readdirSync(nativeRoot, { withFileTypes: true })) {
		if (currentIds.has(entry.name)) continue;
		const directory = path.join(nativeRoot, entry.name);
		if (isGeneratedFamily(directory, entry.name)) fs.rmSync(directory, { recursive: true });
	}
}

/**
 * Materialize every declared native family beneath packRoot/lib/native.
 * All declarations and source bytes are validated before any existing family is changed.
 */
export function materializePackNativeAssets({ projectRoot, packRoot, resolvePackageRoot = defaultResolvePackageRoot }) {
	const resolvedProjectRoot = path.resolve(projectRoot);
	const resolvedPackRoot = path.resolve(packRoot);
	const metadata = readPackBuildMetadata(resolvedPackRoot);
	const nativeRoot = path.join(resolvedPackRoot, "lib", "native");
	if (metadata === null) {
		removeStaleGeneratedFamilies(nativeRoot, new Set());
		return [];
	}

	const projectManifest = readJsonFile(path.join(resolvedProjectRoot, "package.json"), `could not read project package.json for ${resolvedPackRoot}`);
	if (!isPlainObject(projectManifest.dependencies)) fail(`project package.json must declare production dependencies for ${resolvedPackRoot}`);

	const preparedFamilies = [];
	for (const asset of metadata.nativeAssets) {
		if (!Object.prototype.hasOwnProperty.call(projectManifest.dependencies, asset.package)) {
			fail(`native asset ${asset.id} package=${asset.package} is not a direct production dependency`);
		}
		const declaredVersion = projectManifest.dependencies[asset.package];

		let packageRoot;
		try {
			packageRoot = resolvePackageRoot(asset.package, resolvedProjectRoot);
		} catch (error) {
			fail(`native asset ${asset.id} package=${asset.package} could not resolve package root: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (packageRoot instanceof URL) packageRoot = fileURLToPath(packageRoot);
		if (typeof packageRoot !== "string" || packageRoot.length === 0) fail(`native asset ${asset.id} package=${asset.package} resolved an invalid package root`);

		let canonicalPackageRoot;
		try {
			canonicalPackageRoot = fs.realpathSync(path.resolve(packageRoot));
			if (!fs.statSync(canonicalPackageRoot).isDirectory()) fail(`resolved package root is not a directory`);
		} catch (error) {
			fail(`native asset ${asset.id} package=${asset.package} has unusable package root ${packageRoot}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const installedManifest = readJsonFile(path.join(canonicalPackageRoot, "package.json"), `native asset ${asset.id} package=${asset.package} has unreadable installed package manifest`);
		if (installedManifest.name !== asset.package) {
			fail(`native asset ${asset.id} package mismatch: expected ${asset.package}, found ${JSON.stringify(installedManifest.name)} at ${canonicalPackageRoot}`);
		}
		if (typeof installedManifest.version !== "string" || installedManifest.version.length === 0) {
			fail(`native asset ${asset.id} package=${asset.package} has invalid installed version ${JSON.stringify(installedManifest.version)}`);
		}
		if (installedManifest.version !== declaredVersion) {
			fail(`native asset ${asset.id} package=${asset.package} version mismatch: direct production dependency declares ${JSON.stringify(declaredVersion)}, installed package is ${installedManifest.version}`);
		}

		const targets = {};
		const files = [];
		for (const target of NATIVE_ASSET_TARGETS) {
			const source = asset.targets[target];
			const lexicalSource = path.resolve(canonicalPackageRoot, ...source.split("/"));
			const context = `native asset ${asset.id} package=${asset.package}@${installedManifest.version} target=${target} source=${source}`;
			if (!isStrictlyInside(canonicalPackageRoot, lexicalSource)) fail(`${context} escapes the package root lexically`);

			let canonicalSource;
			let stat;
			try {
				canonicalSource = fs.realpathSync(lexicalSource);
				if (!isStrictlyInside(canonicalPackageRoot, canonicalSource)) fail(`${context} escapes the package root through a symlink`);
				stat = fs.statSync(canonicalSource);
			} catch (error) {
				fail(`${context} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (!stat.isFile()) fail(`${context} must resolve to a regular file`);
			const bytes = fs.readFileSync(canonicalSource);
			const filename = `${target}.node`;
			targets[target] = {
				file: filename,
				size: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			};
			files.push({ filename, bytes });
		}
		preparedFamilies.push({
			id: asset.id,
			files,
			manifest: {
				schema: 1,
				package: asset.package,
				version: installedManifest.version,
				targets,
			},
		});
	}

	fs.mkdirSync(nativeRoot, { recursive: true });
	for (const family of preparedFamilies) {
		const destination = path.join(nativeRoot, family.id);
		const staging = path.join(nativeRoot, `.${family.id}.stage-${randomUUID()}`);
		try {
			fs.mkdirSync(staging);
			for (const file of family.files) fs.writeFileSync(path.join(staging, file.filename), file.bytes);
			fs.writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(family.manifest, null, 2)}\n`, "utf8");
			replaceFamilyAtomically(destination, staging);
		} catch (error) {
			fs.rmSync(staging, { recursive: true, force: true });
			fail(`could not materialize native asset ${family.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	removeStaleGeneratedFamilies(nativeRoot, new Set(preparedFamilies.map((family) => family.id)));
	return preparedFamilies.map((family) => path.join(nativeRoot, family.id));
}

/** Resolve the only supported build-time alias into Bobbit's Node-only helper. */
export function packNativeAssetsPlugin({ projectRoot, platform }) {
	const helperPath = path.resolve(projectRoot, "src", "server", "extension-host", "native-assets.ts");
	return {
		name: "bobbit-pack-native-assets",
		setup(build) {
			build.onResolve({ filter: /^bobbit:/ }, (args) => {
				if (args.path !== "bobbit:pack-native-assets") {
					return { errors: [{ text: `Unsupported Bobbit build-time specifier ${JSON.stringify(args.path)}` }] };
				}
				if (platform !== "node") {
					return { errors: [{ text: "bobbit:pack-native-assets is available only to Node pack entries" }] };
				}
				return { path: helperPath };
			});
		},
	};
}
