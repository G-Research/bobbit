import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_ASSET_TARGETS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-glibc-arm64",
	"linux-glibc-x64",
	"linux-musl-arm64",
	"linux-musl-x64",
	"win32-arm64",
	"win32-x64",
] as const;

export type NativeAssetTarget = (typeof NATIVE_ASSET_TARGETS)[number];

export interface NativeAssetRuntime {
	platform: string;
	arch: string;
	glibcVersionRuntime?: string | null;
}

interface NativeAssetManifestTarget {
	file: string;
	size: number;
	sha256: string;
}

interface NativeAssetManifest {
	schema: 1;
	package: string;
	version: string;
	targets: Partial<Record<NativeAssetTarget, NativeAssetManifestTarget>>;
}

const SUPPORTED_MATRIX = NATIVE_ASSET_TARGETS.join(", ");

function linuxLibc(glibcVersionRuntime: string | null | undefined): "glibc" | "musl" {
	return typeof glibcVersionRuntime === "string" && glibcVersionRuntime.trim().length > 0 ? "glibc" : "musl";
}

export function currentNativeAssetRuntime(): NativeAssetRuntime {
	let glibcVersionRuntime: string | null | undefined;
	if (process.platform === "linux") {
		try {
			const report = process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } };
			const reportedVersion = report.header?.glibcVersionRuntime;
			glibcVersionRuntime = typeof reportedVersion === "string" ? reportedVersion : undefined;
		} catch {
			glibcVersionRuntime = undefined;
		}
	}
	return { platform: process.platform, arch: process.arch, glibcVersionRuntime };
}

export function selectNativeAssetTarget(runtime: NativeAssetRuntime): NativeAssetTarget {
	const detectedLibc = runtime.platform === "linux" ? linuxLibc(runtime.glibcVersionRuntime) : "n/a";
	if ((runtime.arch === "x64" || runtime.arch === "arm64") && runtime.platform === "darwin") {
		return `darwin-${runtime.arch}`;
	}
	if ((runtime.arch === "x64" || runtime.arch === "arm64") && runtime.platform === "win32") {
		return `win32-${runtime.arch}`;
	}
	if ((runtime.arch === "x64" || runtime.arch === "arm64") && runtime.platform === "linux") {
		const libc = linuxLibc(runtime.glibcVersionRuntime);
		return `linux-${libc}-${runtime.arch}`;
	}
	throw new Error(
		`[pack-native-assets] Unsupported native asset runtime platform=${runtime.platform}, libc=${detectedLibc}, arch=${runtime.arch}. Supported targets: ${SUPPORTED_MATRIX}`,
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function context(packageName: string, version: string, target: NativeAssetTarget): string {
	return `package=${packageName}@${version} target=${target}`;
}

function manifestFailure(
	message: string,
	target: NativeAssetTarget,
	cause?: unknown,
	packageName = "unknown",
	version = "unknown",
): Error {
	const suffix = cause instanceof Error ? `: ${cause.message}` : cause === undefined ? "" : `: ${String(cause)}`;
	return new Error(`[pack-native-assets] ${message} (${context(packageName, version, target)})${suffix}`);
}

function parseManifest(value: unknown, target: NativeAssetTarget): NativeAssetManifest {
	const hasPackage = isPlainObject(value) && typeof value.package === "string" && value.package.length > 0;
	const hasVersion = isPlainObject(value) && typeof value.version === "string" && value.version.length > 0;
	const packageName = hasPackage ? (value.package as string) : "unknown";
	const version = hasVersion ? (value.version as string) : "unknown";
	if (!isPlainObject(value) || value.schema !== 1 || !hasPackage || !hasVersion || !isPlainObject(value.targets)) {
		throw manifestFailure("Native asset family has a corrupt manifest", target, undefined, packageName, version);
	}
	return value as unknown as NativeAssetManifest;
}

function strictlyInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve one deterministic pack-local native binding. No package or ancestor fallback is attempted. */
export function resolvePackNativeAsset(familyDirectory: string | URL, runtime: NativeAssetRuntime = currentNativeAssetRuntime()): string {
	const target = selectNativeAssetTarget(runtime);
	let familyPath: string;
	try {
		familyPath = familyDirectory instanceof URL ? fileURLToPath(familyDirectory) : path.resolve(familyDirectory);
	} catch (error) {
		throw manifestFailure("Native asset family directory is invalid", target, error);
	}

	let familyRoot: string;
	try {
		familyRoot = fs.realpathSync(familyPath);
		if (!fs.statSync(familyRoot).isDirectory()) throw new Error("path is not a directory");
	} catch (error) {
		throw manifestFailure(`Native asset family is missing or unreadable at ${familyPath}`, target, error);
	}

	const manifestPath = path.join(familyRoot, "manifest.json");
	let manifestValue: unknown;
	try {
		manifestValue = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw manifestFailure(`Native asset manifest is missing, unreadable, or corrupt at ${manifestPath}`, target, error);
	}
	const manifest = parseManifest(manifestValue, target);
	const manifestContext = context(manifest.package, manifest.version, target);
	const targetRecord = manifest.targets[target];
	if (!isPlainObject(targetRecord)) {
		throw new Error(`[pack-native-assets] Native asset target is unavailable (${manifestContext})`);
	}

	const expectedFilename = `${target}.node`;
	if (targetRecord.file !== expectedFilename || typeof targetRecord.size !== "number" || !Number.isSafeInteger(targetRecord.size)
		|| targetRecord.size < 0 || typeof targetRecord.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(targetRecord.sha256)) {
		throw new Error(`[pack-native-assets] Native asset target metadata is corrupt (${manifestContext})`);
	}

	const lexicalFile = path.resolve(familyRoot, targetRecord.file);
	if (!strictlyInside(familyRoot, lexicalFile)) {
		throw new Error(`[pack-native-assets] Native asset target filename escapes its family (${manifestContext})`);
	}
	let canonicalFile: string;
	let stat: fs.Stats;
	try {
		canonicalFile = fs.realpathSync(lexicalFile);
		if (!strictlyInside(familyRoot, canonicalFile)) {
			throw new Error("resolved path escapes its family");
		}
		stat = fs.statSync(canonicalFile);
	} catch (error) {
		throw new Error(`[pack-native-assets] Native asset file is missing or unsafe (${manifestContext}): ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!stat.isFile()) {
		throw new Error(`[pack-native-assets] Native asset path is not a regular file (${manifestContext})`);
	}
	return canonicalFile;
}
