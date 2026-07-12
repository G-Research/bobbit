import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PackManifest, PackScope } from "./pack-types.js";
import { readMeta } from "./pack-manifest.js";
import { PackContributionError, packIdFromRoot } from "./pack-contributions.js";
import { isPackPathWithinRoot } from "../extension-host/path-guard.js";
import { discoverPiExtensionToolsSync } from "./pi-extension-discovery.js";

export interface ResolvedPiExtensionContribution {
	/** Manifest contents.pi-extensions[] key and DisabledRefs key. */
	listName: string;
	/** Absolute host path passed to --extension when safely resolved. */
	entryPath?: string;
	/** Stable path relative to packRoot for diagnostics/cache. */
	entryRelativePath?: string;
	packRoot: string;
	origin: PiExtensionOrigin;
	diagnostic: PiExtensionDiagnostic;
	discovery: PiExtensionDiscoveryResult;
}

export interface PiExtensionOrigin {
	scope: "server" | "global-user" | "project" | "builtin";
	packName: string;
	packId: string;
	sourceUrl?: string;
}

export interface PiExtensionDiagnostic {
	status: "ok" | "disabled" | "unresolved" | "discovery-failed" | "runtime-load-failed" | "remap-failed";
	code: string;
	message: string;
	updatedAt: string;
	stale?: boolean;
}

export interface PiExtensionDiscoveryResult {
	status: "ok" | "failed" | "skipped";
	tools: PiExtensionToolInfo[];
	diagnostic?: PiExtensionDiagnostic;
	cacheKey?: string;
}

export interface PiExtensionToolInfo {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface LoadPiExtensionContributionsOptions {
	origin?: Partial<PiExtensionOrigin>;
	/** Mark refs disabled by activation while preserving catalogue rows. */
	disabledRefs?: Iterable<string>;
	/** Optional cache-key salt for tests/future probe harness versioning. */
	cacheSalt?: string;
}

export interface LoadPiExtensionContributionsWithDiscoveryOptions extends LoadPiExtensionContributionsOptions {
	trustAccepted: boolean;
	discoveryTimeoutMs?: number;
	discoveryCwd?: string;
}

const PI_EXTENSION_LIST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WINDOWS_DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const EXTENSION_ENTRY_FILES = ["extension.ts", "extension.js", "index.ts", "index.js", "index.mjs", "index.cjs"] as const;
const FILE_ENTRY_EXTS = [".ts", ".js", ".mjs", ".cjs"] as const;
const HASHED_SOURCE_EXTS = new Set([".ts", ".js", ".mjs", ".cjs", ".json"]);
const HASHED_LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"]);
export const PI_EXTENSION_PROBE_HARNESS_VERSION = "1";

function hasPathSyntax(value: string): boolean {
	return value.includes("\0") || value.includes("/") || value.includes("\\") || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

/** Strict pack-local basename guard for contents.pi-extensions refs. */
export function isSafePiExtensionListName(name: unknown): name is string {
	if (typeof name !== "string") return false;
	if (!PI_EXTENSION_LIST_NAME_RE.test(name)) return false;
	if (name.includes("..") || name.startsWith(".") || hasPathSyntax(name)) return false;
	if (WINDOWS_DEVICE_NAME_RE.test(name)) return false;
	return true;
}

export function makePiExtensionDiagnostic(
	status: PiExtensionDiagnostic["status"],
	code: string,
	message: string,
	updatedAt = new Date().toISOString(),
): PiExtensionDiagnostic {
	return { status, code, message, updatedAt };
}

function skippedDiscovery(cacheKey?: string): PiExtensionDiscoveryResult {
	return {
		status: "skipped",
		tools: [],
		...(cacheKey ? { cacheKey } : {}),
		diagnostic: makePiExtensionDiagnostic("ok", "discovery_skipped", "Executable pi-extension discovery has not run."),
	};
}

function originFor(packRoot: string, manifest: PackManifest, opts: LoadPiExtensionContributionsOptions): PiExtensionOrigin {
	const meta = readMeta(packRoot);
	const scope = opts.origin?.scope ?? meta?.scope ?? "project";
	return {
		scope: scope as PackScope,
		packName: opts.origin?.packName ?? manifest.name,
		packId: opts.origin?.packId ?? packIdFromRoot(packRoot),
		...(opts.origin?.sourceUrl || meta?.sourceUrl ? { sourceUrl: opts.origin?.sourceUrl ?? meta?.sourceUrl } : {}),
	};
}

function relativeToPack(packRoot: string, target: string): string {
	return path.relative(packRoot, target).split(path.sep).join("/");
}

function statIfExists(file: string): fs.Stats | null {
	try {
		return fs.statSync(file);
	} catch {
		return null;
	}
}

function readJson(file: string): unknown {
	return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function packageExportStrings(raw: unknown): string[] {
	if (typeof raw === "string") return [raw];
	if (!isPlainObject(raw)) return [];
	const dot = raw["."];
	if (typeof dot === "string") return [dot];
	if (isPlainObject(dot)) {
		const out: string[] = [];
		for (const key of ["import", "default", "require", "node"] as const) {
			const value = dot[key];
			if (typeof value === "string") out.push(value);
		}
		if (out.length > 0) return out;
	}
	const out: string[] = [];
	for (const key of ["import", "default", "require", "node"] as const) {
		const value = raw[key];
		if (typeof value === "string") out.push(value);
	}
	return out;
}

function resolveExistingFileInside(root: string, candidate: string): string | null {
	if (!isPackPathWithinRoot(root, candidate)) return null;
	const st = statIfExists(candidate);
	if (st?.isFile()) return candidate;
	if (path.extname(candidate) === "") {
		for (const ext of FILE_ENTRY_EXTS) {
			const withExt = `${candidate}${ext}`;
			if (!isPackPathWithinRoot(root, withExt)) continue;
			const extStat = statIfExists(withExt);
			if (extStat?.isFile()) return withExt;
		}
		for (const name of ["index.ts", "index.js", "index.mjs", "index.cjs"]) {
			const nested = path.join(candidate, name);
			if (!isPackPathWithinRoot(root, nested)) continue;
			const nestedStat = statIfExists(nested);
			if (nestedStat?.isFile()) return nested;
		}
	}
	return null;
}

function resolvePackageJsonEntry(dir: string): string | null {
	const pkgPath = path.join(dir, "package.json");
	if (!isPackPathWithinRoot(dir, pkgPath) || !statIfExists(pkgPath)?.isFile()) return null;
	let data: unknown;
	try {
		data = readJson(pkgPath);
	} catch {
		return null;
	}
	if (!isPlainObject(data)) return null;
	const candidates: string[] = [];
	candidates.push(...packageExportStrings(data.exports));
	for (const field of ["module", "main"] as const) {
		const value = data[field];
		if (typeof value === "string") candidates.push(value);
	}
	for (const rel of candidates) {
		if (!rel || rel.includes("\0") || path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) continue;
		const resolved = resolveExistingFileInside(dir, path.resolve(dir, rel));
		if (resolved) return resolved;
	}
	return null;
}

export interface PiExtensionEntryResolution {
	entryPath?: string;
	entryRelativePath?: string;
	diagnostic: PiExtensionDiagnostic;
	cacheKey?: string;
	cacheDiagnostic?: PiExtensionDiagnostic;
}

export interface PiExtensionDiscoveryCacheKeyResult {
	cacheKey?: string;
	diagnostic?: PiExtensionDiagnostic;
}

export const PI_EXTENSION_DISCOVERY_HASH_LIMITS = {
	maxDepth: 12,
	maxFiles: 1000,
	maxFileBytes: 1024 * 1024,
	maxTotalBytes: 8 * 1024 * 1024,
} as const;

export type PiExtensionDiscoveryHashLimits = {
	maxDepth: number;
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
};

/**
 * Test-only seam: resolve effective hash limits, letting tests exercise limit
 * diagnostics (e.g. `hash_file_count_limit`) with tiny values instead of
 * materializing thousands of files. Production callers never pass an override,
 * so the defaults above remain exactly unchanged.
 */
function resolveHashLimits(override?: Partial<PiExtensionDiscoveryHashLimits>): PiExtensionDiscoveryHashLimits {
	return override ? { ...PI_EXTENSION_DISCOVERY_HASH_LIMITS, ...override } : { ...PI_EXTENSION_DISCOVERY_HASH_LIMITS };
}

/** Resolve one contents.pi-extensions ref to a safe runtime entry path, preserving source layout. */
export function resolvePiExtensionEntry(packRoot: string, listName: string, manifest?: PackManifest, opts?: { cacheSalt?: string }): PiExtensionEntryResolution {
	const absPackRoot = path.resolve(packRoot);
	if (!isSafePiExtensionListName(listName)) {
		return { diagnostic: makePiExtensionDiagnostic("unresolved", "invalid_list_name", `Pi extension ref ${JSON.stringify(listName)} is not a safe basename.`) };
	}
	const dir = path.join(absPackRoot, "pi-extensions");
	if (!isPackPathWithinRoot(absPackRoot, dir)) {
		return { diagnostic: makePiExtensionDiagnostic("unresolved", "pi_extensions_dir_escapes", `pi-extensions directory resolves outside pack root for ${listName}.`) };
	}

	const extensionDir = path.join(dir, listName);
	if (!isPackPathWithinRoot(absPackRoot, extensionDir)) {
		return { diagnostic: makePiExtensionDiagnostic("unresolved", "entry_path_escapes", `Pi extension ${listName} resolves outside pi-extensions/.`) };
	}
	const dirStat = statIfExists(extensionDir);
	if (dirStat?.isDirectory()) {
		const packageEntry = resolvePackageJsonEntry(extensionDir);
		const candidates = packageEntry ? [packageEntry] : EXTENSION_ENTRY_FILES.map((name) => path.join(extensionDir, name));
		for (const candidate of candidates) {
			if (!isPackPathWithinRoot(extensionDir, candidate)) {
				return { diagnostic: makePiExtensionDiagnostic("unresolved", "entry_path_escapes", `Pi extension ${listName} entry resolves outside its extension directory.`) };
			}
			const st = statIfExists(candidate);
			if (st?.isFile()) {
				const cache = computePiExtensionDiscoveryCacheKeyWithDiagnostics(candidate, { packRoot: absPackRoot, manifest, cacheSalt: opts?.cacheSalt });
				return {
					entryPath: candidate,
					entryRelativePath: relativeToPack(absPackRoot, candidate),
					diagnostic: cache.diagnostic ?? makePiExtensionDiagnostic("ok", "resolved", `Pi extension ${listName} resolved to ${relativeToPack(absPackRoot, candidate)}.`),
					...(cache.cacheKey ? { cacheKey: cache.cacheKey } : {}),
					...(cache.diagnostic ? { cacheDiagnostic: cache.diagnostic } : {}),
				};
			}
		}
		return { diagnostic: makePiExtensionDiagnostic("unresolved", "entry_not_found", `Pi extension ${listName} has no package entry, extension.ts/js, or index.ts/js/mjs/cjs entry file.`) };
	}
	if (dirStat && !dirStat.isDirectory()) {
		return { diagnostic: makePiExtensionDiagnostic("unresolved", "entry_not_directory", `Pi extension ${listName} directory path exists but is not a directory.`) };
	}

	for (const ext of FILE_ENTRY_EXTS) {
		const file = path.join(dir, `${listName}${ext}`);
		if (!isPackPathWithinRoot(absPackRoot, file)) {
			return { diagnostic: makePiExtensionDiagnostic("unresolved", "entry_path_escapes", `Pi extension ${listName} file resolves outside pi-extensions/.`) };
		}
		const st = statIfExists(file);
		if (st?.isFile()) {
			const cache = computePiExtensionDiscoveryCacheKeyWithDiagnostics(file, { packRoot: absPackRoot, manifest, cacheSalt: opts?.cacheSalt });
			return {
				entryPath: file,
				entryRelativePath: relativeToPack(absPackRoot, file),
				diagnostic: cache.diagnostic ?? makePiExtensionDiagnostic("ok", "resolved", `Pi extension ${listName} resolved to ${relativeToPack(absPackRoot, file)}.`),
				...(cache.cacheKey ? { cacheKey: cache.cacheKey } : {}),
				...(cache.diagnostic ? { cacheDiagnostic: cache.diagnostic } : {}),
			};
		}
	}
	return { diagnostic: makePiExtensionDiagnostic("unresolved", "entry_not_found", `Pi extension ${listName} was declared but no matching pi-extensions/${listName}/ or pi-extensions/${listName}.{ts,js,mjs,cjs} entry exists.`) };
}

export function loadPiExtensionContributions(
	packRoot: string,
	manifest: PackManifest,
	opts: LoadPiExtensionContributionsOptions = {},
): ResolvedPiExtensionContribution[] {
	if ((manifest.schema ?? 1) < 2) return [];
	const refs = manifest.contents.piExtensions ?? [];
	const disabled = new Set(opts.disabledRefs ?? []);
	const seen = new Set<string>();
	const origin = originFor(path.resolve(packRoot), manifest, opts);
	const out: ResolvedPiExtensionContribution[] = [];
	for (const listName of refs) {
		if (seen.has(listName)) {
			throw new PackContributionError(`pack "${packIdFromRoot(packRoot)}" declares pi-extension listName "${listName}" more than once; pi-extension listNames must be unique within a pack`);
		}
		seen.add(listName);
		const resolved = resolvePiExtensionEntry(packRoot, listName, manifest, { cacheSalt: opts.cacheSalt });
		const isDisabled = disabled.has(listName);
		const diagnostic = isDisabled
			? makePiExtensionDiagnostic("disabled", "activation_disabled", `Pi extension ${listName} is disabled by marketplace activation.`)
			: resolved.diagnostic;
		const discovery = resolved.cacheDiagnostic
			? { status: "failed" as const, tools: [], diagnostic: resolved.cacheDiagnostic }
			: skippedDiscovery(resolved.cacheKey);
		out.push({
			listName,
			...(resolved.entryPath ? { entryPath: resolved.entryPath } : {}),
			...(resolved.entryRelativePath ? { entryRelativePath: resolved.entryRelativePath } : {}),
			packRoot: path.resolve(packRoot),
			origin,
			diagnostic,
			discovery,
		});
	}
	return out;
}

/** Static loader plus best-effort executable discovery for enabled, resolved refs. */
export async function loadPiExtensionContributionsWithDiscovery(
	packRoot: string,
	manifest: PackManifest,
	opts: LoadPiExtensionContributionsWithDiscoveryOptions,
): Promise<ResolvedPiExtensionContribution[]> {
	const rows = loadPiExtensionContributions(packRoot, manifest, opts);
	const { discoverPiExtensionTools } = await import("./pi-extension-discovery.js");
	for (const row of rows) {
		if (!row.entryPath || row.diagnostic.status === "disabled" || row.discovery.status === "failed") continue;
		row.discovery = await discoverPiExtensionTools(row.entryPath, {
			trustAccepted: opts.trustAccepted,
			...(opts.discoveryTimeoutMs !== undefined ? { timeoutMs: opts.discoveryTimeoutMs } : {}),
			...(opts.discoveryCwd ? { cwd: opts.discoveryCwd } : {}),
		});
		if (row.discovery.status === "failed" && row.discovery.diagnostic) {
			row.diagnostic = row.discovery.diagnostic;
		}
	}
	return rows;
}

/** Static loader plus bounded synchronous discovery for sync session-start paths. */
export function loadPiExtensionContributionsWithDiscoverySync(
	packRoot: string,
	manifest: PackManifest,
	opts: LoadPiExtensionContributionsWithDiscoveryOptions,
): ResolvedPiExtensionContribution[] {
	const rows = loadPiExtensionContributions(packRoot, manifest, opts);
	for (const row of rows) {
		if (!row.entryPath || row.diagnostic.status === "disabled" || row.discovery.status === "failed") continue;
		row.discovery = discoverPiExtensionToolsSync(row.entryPath, {
			trustAccepted: opts.trustAccepted,
			...(opts.discoveryTimeoutMs !== undefined ? { timeoutMs: opts.discoveryTimeoutMs } : {}),
			...(opts.discoveryCwd ? { cwd: opts.discoveryCwd } : {}),
		});
		if (row.discovery.status === "failed" && row.discovery.diagnostic) {
			row.diagnostic = row.discovery.diagnostic;
		}
	}
	return rows;
}

function shouldHashFile(name: string): boolean {
	return HASHED_SOURCE_EXTS.has(path.extname(name)) || HASHED_LOCKFILES.has(path.basename(name));
}

function hashLimitDiagnostic(code: string, message: string): PiExtensionDiagnostic {
	return makePiExtensionDiagnostic("discovery-failed", code, message);
}

function collectHashFiles(root: string, limits: PiExtensionDiscoveryHashLimits): { files: string[]; diagnostic?: PiExtensionDiagnostic } {
	const out: string[] = [];
	let visitedEntries = 0;
	let diagnostic: PiExtensionDiagnostic | undefined;
	const walk = (dir: string, depth: number): void => {
		if (diagnostic) return;
		if (depth > limits.maxDepth) {
			diagnostic = hashLimitDiagnostic("hash_depth_limit", `Pi extension discovery cache key exceeded maximum directory depth of ${limits.maxDepth}.`);
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (diagnostic) return;
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			visitedEntries++;
			if (visitedEntries > limits.maxFiles) {
				diagnostic = hashLimitDiagnostic("hash_file_count_limit", `Pi extension discovery cache key exceeded maximum visited entry count of ${limits.maxFiles}.`);
				return;
			}
			const full = path.join(dir, entry.name);
			if (!isPackPathWithinRoot(root, full)) continue;
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.isFile() && shouldHashFile(entry.name)) {
				out.push(full);
			}
		}
	};
	walk(root, 0);
	return diagnostic ? { files: out, diagnostic } : { files: out };
}

export function computePiExtensionDiscoveryCacheKeyWithDiagnostics(
	entryPath: string,
	opts: { packRoot?: string; manifest?: PackManifest; cacheSalt?: string; hashLimits?: Partial<PiExtensionDiscoveryHashLimits> } = {},
): PiExtensionDiscoveryCacheKeyResult {
	let st: fs.Stats;
	try {
		st = fs.statSync(entryPath);
	} catch {
		return {};
	}
	const limits = resolveHashLimits(opts.hashLimits);
	const hash = createHash("sha256");
	const packRoot = opts.packRoot ? path.resolve(opts.packRoot) : undefined;
	const root = st.isDirectory() ? entryPath : path.dirname(entryPath);
	hash.update(JSON.stringify({
		harness: PI_EXTENSION_PROBE_HARNESS_VERSION,
		cacheSalt: opts.cacheSalt ?? "",
		entryRelativePath: packRoot ? relativeToPack(packRoot, entryPath) : path.basename(entryPath),
		manifest: opts.manifest ? { name: opts.manifest.name, version: opts.manifest.version, schema: opts.manifest.schema ?? 1, piExtensions: opts.manifest.contents.piExtensions ?? [] } : undefined,
	}));
	if (packRoot) {
		try {
			const metaPath = path.join(packRoot, ".pack-meta.yaml");
			if (fs.existsSync(metaPath)) {
				const metaStat = fs.statSync(metaPath);
				if (metaStat.size > limits.maxFileBytes) {
					return { diagnostic: hashLimitDiagnostic("hash_file_size_limit", `.pack-meta.yaml exceeds maximum hashed file size of ${limits.maxFileBytes} bytes.`) };
				}
				hash.update(fs.readFileSync(metaPath));
			}
		} catch { /* best-effort metadata salt */ }
	}
	const collected = collectHashFiles(root, limits);
	if (collected.diagnostic) return { diagnostic: collected.diagnostic };
	let totalBytes = 0;
	for (const file of collected.files) {
		let fileStat: fs.Stats;
		try {
			fileStat = fs.statSync(file);
		} catch {
			continue;
		}
		const rel = path.relative(root, file).split(path.sep).join("/");
		hash.update(JSON.stringify({ rel, size: fileStat.size, mtimeMs: Math.trunc(fileStat.mtimeMs) }));
		if (fileStat.size > limits.maxFileBytes) {
			return { diagnostic: hashLimitDiagnostic("hash_file_size_limit", `Pi extension discovery cache key refused to hash ${rel}: file size ${fileStat.size} exceeds ${limits.maxFileBytes} bytes.`) };
		}
		if (totalBytes + fileStat.size > limits.maxTotalBytes) {
			return { diagnostic: hashLimitDiagnostic("hash_total_size_limit", `Pi extension discovery cache key exceeded maximum total hashed bytes of ${limits.maxTotalBytes}.`) };
		}
		totalBytes += fileStat.size;
		try {
			hash.update(createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
		} catch { /* ignore unreadable files; stat data remains */ }
	}
	return { cacheKey: hash.digest("hex") };
}

export function computePiExtensionDiscoveryCacheKey(
	entryPath: string,
	opts: { packRoot?: string; manifest?: PackManifest; cacheSalt?: string; hashLimits?: Partial<PiExtensionDiscoveryHashLimits> } = {},
): string | undefined {
	return computePiExtensionDiscoveryCacheKeyWithDiagnostics(entryPath, opts).cacheKey;
}
