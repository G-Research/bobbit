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

function stableIdentity(stats) {
	if (stats.dev === undefined || stats.ino === undefined || String(stats.ino) === "0") return undefined;
	return `${String(stats.dev)}:${String(stats.ino)}`;
}

function assertStableDirectory(stats, directory) {
	if (!stats.isDirectory() || stats.isSymbolicLink() || stableIdentity(stats) === undefined) {
		fail(`native asset directory is not a stable real directory: ${directory}`);
	}
}

function captureStableDirectory(directory, containmentRoot) {
	const stats = fs.lstatSync(directory);
	assertStableDirectory(stats, directory);
	const canonical = fs.realpathSync(directory);
	const canonicalStats = fs.lstatSync(canonical);
	assertStableDirectory(canonicalStats, canonical);
	if (stableIdentity(stats) !== stableIdentity(canonicalStats)) fail(`native asset directory changed while validating: ${directory}`);
	if (containmentRoot !== undefined && !isStrictlyInside(containmentRoot, canonical)) {
		fail(`native asset directory escapes its pack root: ${directory}`);
	}
	return { path: directory, canonical, identity: stableIdentity(stats) };
}

function assertDirectoryClaimCurrent(claim) {
	const current = fs.lstatSync(claim.path);
	assertStableDirectory(current, claim.path);
	if (stableIdentity(current) !== claim.identity) fail(`native asset directory changed while in use: ${claim.path}`);
}

function openNativeRoot(packRoot, create) {
	const packClaim = captureStableDirectory(packRoot);
	const claims = [packClaim];
	let current = packRoot;
	for (const segment of ["lib", "native"]) {
		for (const claim of claims) assertDirectoryClaimCurrent(claim);
		current = path.join(current, segment);
		if (!fs.existsSync(current)) {
			if (!create) return null;
			fs.mkdirSync(current);
		}
		const claim = captureStableDirectory(current, packClaim.canonical);
		claims.push(claim);
	}
	for (const claim of claims) assertDirectoryClaimCurrent(claim);
	return { path: current, claims };
}

function inspectGeneratedFamily(directory, id, nativeClaim) {
	if (!SAFE_ID.test(id)) return null;
	try {
		assertDirectoryClaimCurrent(nativeClaim);
		const familyClaim = captureStableDirectory(directory, nativeClaim.canonical);
		const manifestPath = path.join(directory, "manifest.json");
		const manifestStats = fs.lstatSync(manifestPath);
		if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || stableIdentity(manifestStats) === undefined) return null;
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		if (!isPlainObject(manifest) || Object.keys(manifest).sort().join(",") !== "package,schema,targets,version"
			|| manifest.schema !== 1 || typeof manifest.package !== "string" || manifest.package.length === 0
			|| typeof manifest.version !== "string" || manifest.version.length === 0 || !isPlainObject(manifest.targets)
			|| Object.keys(manifest.targets).length !== NATIVE_ASSET_TARGETS.length) return null;
		const expectedNames = new Set(["manifest.json"]);
		for (const target of NATIVE_ASSET_TARGETS) {
			const record = manifest.targets[target];
			if (!isPlainObject(record) || Object.keys(record).sort().join(",") !== "file,sha256,size"
				|| record.file !== `${target}.node` || !Number.isSafeInteger(record.size) || record.size < 0
				|| typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) return null;
			expectedNames.add(record.file);
		}
		const entries = fs.readdirSync(directory, { withFileTypes: true });
		if (entries.length !== expectedNames.size) return null;
		for (const entry of entries) {
			if (!expectedNames.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) return null;
			const stats = fs.lstatSync(path.join(directory, entry.name));
			if (!stats.isFile() || stats.isSymbolicLink() || stableIdentity(stats) === undefined) return null;
		}
		assertDirectoryClaimCurrent(familyClaim);
		assertDirectoryClaimCurrent(nativeClaim);
		return { ...familyClaim, files: [...expectedNames].sort() };
	} catch {
		return null;
	}
}

function removeFlatDirectory(directory, expectedIdentity, files) {
	const claim = captureStableDirectory(directory);
	if (expectedIdentity !== undefined && claim.identity !== expectedIdentity) fail(`refusing to remove replaced native asset directory: ${directory}`);
	const entries = fs.readdirSync(directory, { withFileTypes: true });
	const allowed = files === undefined ? null : new Set(files);
	if (allowed !== null && (entries.length !== allowed.size || entries.some((entry) => !allowed.has(entry.name)))) {
		fail(`refusing to remove native asset directory with unexpected contents: ${directory}`);
	}
	for (const entry of entries) {
		const file = path.join(directory, entry.name);
		const stats = fs.lstatSync(file);
		if (!entry.isFile() || entry.isSymbolicLink() || !stats.isFile() || stats.isSymbolicLink() || stableIdentity(stats) === undefined) {
			fail(`refusing to remove unsafe native asset output: ${file}`);
		}
		assertDirectoryClaimCurrent(claim);
		fs.unlinkSync(file);
	}
	assertDirectoryClaimCurrent(claim);
	fs.rmdirSync(directory);
}

function cleanupTransactionDirectory(transactionRoot) {
	if (!fs.existsSync(transactionRoot)) return;
	const transactionClaim = captureStableDirectory(transactionRoot);
	for (const entry of fs.readdirSync(transactionRoot, { withFileTypes: true })) {
		const child = path.join(transactionRoot, entry.name);
		if (!entry.isDirectory() || entry.isSymbolicLink()) fail(`unsafe native asset transaction output: ${child}`);
		removeFlatDirectory(child);
		assertDirectoryClaimCurrent(transactionClaim);
	}
	fs.rmdirSync(transactionRoot);
}

function cleanupFailedTransaction(transactionRoot) {
	if (!fs.existsSync(transactionRoot)) return;
	const transactionClaim = captureStableDirectory(transactionRoot);
	const staging = path.join(transactionRoot, "staging");
	if (fs.existsSync(staging)) removeFlatDirectory(staging);
	assertDirectoryClaimCurrent(transactionClaim);
	if (fs.readdirSync(transactionRoot).length === 0) fs.rmdirSync(transactionRoot);
}

function replaceFamilyAtomically(destination, staging, nativeClaim, transactionRoot) {
	assertDirectoryClaimCurrent(nativeClaim);
	const stagingClaim = captureStableDirectory(staging);
	const backup = path.join(transactionRoot, "backup");
	let previousClaim;
	if (fs.existsSync(destination)) {
		previousClaim = captureStableDirectory(destination, nativeClaim.canonical);
		assertDirectoryClaimCurrent(nativeClaim);
		fs.renameSync(destination, backup);
		const moved = captureStableDirectory(backup);
		if (moved.identity !== previousClaim.identity) {
			fs.renameSync(backup, destination);
			fail(`native asset family changed while moving it to transaction storage: ${destination}`);
		}
	}

	try {
		assertDirectoryClaimCurrent(nativeClaim);
		assertDirectoryClaimCurrent(stagingClaim);
		fs.renameSync(staging, destination);
	} catch (error) {
		try {
			if (previousClaim) fs.renameSync(backup, destination);
		} catch (restoreError) {
			throw new AggregateError([error, restoreError], `failed to install and restore native asset family ${destination}`);
		}
		throw error;
	}

	// The successful destination rename is the commit point. Cleanup cannot
	// turn that commit into a reported failure or expose the previous bytes.
	try {
		if (previousClaim && fs.existsSync(backup)) removeFlatDirectory(backup, previousClaim.identity);
		cleanupTransactionDirectory(transactionRoot);
	} catch {
		// Transaction state is outside the pack tree and is never a runtime input.
	}
}

function removeStaleGeneratedFamilies(nativeRootState, currentIds) {
	if (nativeRootState === null) return;
	const nativeClaim = nativeRootState.claims.at(-1);
	assertDirectoryClaimCurrent(nativeClaim);
	for (const entry of fs.readdirSync(nativeRootState.path, { withFileTypes: true })) {
		if (currentIds.has(entry.name)) continue;
		const directory = path.join(nativeRootState.path, entry.name);
		const generated = inspectGeneratedFamily(directory, entry.name, nativeClaim);
		if (generated !== null) removeFlatDirectory(directory, generated.identity, generated.files);
		assertDirectoryClaimCurrent(nativeClaim);
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
	if (metadata === null && !fs.existsSync(resolvedPackRoot)) return [];
	let nativeRootState = openNativeRoot(resolvedPackRoot, false);
	if (metadata === null) {
		removeStaleGeneratedFamilies(nativeRootState, new Set());
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

	nativeRootState = openNativeRoot(resolvedPackRoot, true);
	const nativeRoot = nativeRootState.path;
	const nativeClaim = nativeRootState.claims.at(-1);
	for (const family of preparedFamilies) {
		const destination = path.join(nativeRoot, family.id);
		const transactionRoot = path.join(path.dirname(resolvedPackRoot), `.${path.basename(resolvedPackRoot)}.native-assets-${randomUUID()}`);
		const staging = path.join(transactionRoot, "staging");
		try {
			fs.mkdirSync(transactionRoot);
			fs.mkdirSync(staging);
			for (const file of family.files) fs.writeFileSync(path.join(staging, file.filename), file.bytes, { flag: "wx" });
			fs.writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(family.manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
			replaceFamilyAtomically(destination, staging, nativeClaim, transactionRoot);
		} catch (error) {
			try { cleanupFailedTransaction(transactionRoot); } catch { /* Preserve the materialization failure and any recoverable backup. */ }
			fail(`could not materialize native asset ${family.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	removeStaleGeneratedFamilies(nativeRootState, new Set(preparedFamilies.map((family) => family.id)));
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
