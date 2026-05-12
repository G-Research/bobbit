/**
 * Bundled fd/rg binary resolution and staging.
 *
 * Bobbit ships fd and rg via per-platform optional npm sub-packages
 * (`@bobbit/binaries-<platform>-<arch>`) so agents always have them locally
 * with zero network calls at install or runtime.
 *
 * Resolution order (memoized per gateway lifetime):
 *   1. Bundled sub-package matching {process.platform, process.arch}.
 *   2. PATH fallback (`fd`, `fdfind`, `rg`) — confirmed by `<bin> --version`.
 *   3. null. Caller logs a clear warning naming what was attempted.
 *
 * Staging: `stageBundledBinaries()` copies/symlinks the resolved binaries into
 * pi-coding-agent's `getBinDir()` (`<agentDir>/bin`) at gateway boot so pi's
 * own `getToolPath()` finds them transparently — no changes inside pi, no
 * changes to per-agent spawn code, no Docker plumbing.
 *
 * See docs/releasing.md for how the sub-packages are built and published.
 */

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type Tool = "fd" | "rg";

/** What kind of resolution happened. */
export type BinarySource = "bundled" | "path" | "missing";

export interface BinaryResolution {
	source: BinarySource;
	path: string | null;
	/** Name of the sub-package we looked for (for error reporting). */
	expectedPackage: string;
	/** PATH candidates we probed (for error reporting). */
	pathProbes: string[];
}

const require_ = createRequire(import.meta.url);

/** Per-tool PATH candidates. fd is named `fdfind` on Debian/Ubuntu apt. */
const PATH_CANDIDATES: Record<Tool, string[]> = {
	fd: ["fd", "fdfind"],
	rg: ["rg"],
};

/** Module-level cache — probe each tool at most once per gateway lifetime. */
const cache = new Map<Tool, BinaryResolution>();

/**
 * Return the sub-package name we'd ship for the current platform/arch, or
 * null if this is a tuple we deliberately don't ship a binary for.
 */
export function expectedBinaryPackage(
	plat: NodeJS.Platform = process.platform,
	arch: NodeJS.Architecture = process.arch as NodeJS.Architecture,
): string | null {
	const key = `${plat}-${arch}`;
	switch (key) {
		case "darwin-arm64":
		case "darwin-x64":
		case "linux-x64":
		case "linux-arm64":
		case "win32-x64":
			return `@bobbit/binaries-${key}`;
		default:
			return null;
	}
}

/** Resolve via the bundled optional sub-package, if installed and usable. */
function resolveBundled(tool: Tool, pkgName: string | null): string | null {
	if (!pkgName) return null;
	let entry: string;
	try {
		entry = require_.resolve(`${pkgName}/index.js`);
	} catch {
		return null;
	}
	const ext = process.platform === "win32" ? ".exe" : "";
	const binPath = path.join(path.dirname(entry), "bin", `${tool}${ext}`);
	if (!fs.existsSync(binPath)) return null;
	// Defensive +x on POSIX in case the tarball lost the mode bits.
	if (process.platform !== "win32") {
		try {
			fs.chmodSync(binPath, 0o755);
		} catch {
			/* best effort */
		}
	}
	return binPath;
}

/** Probe PATH by trying `<candidate> --version`. */
function resolveFromPath(candidates: string[]): string | null {
	for (const cand of candidates) {
		const result = spawnSync(cand, ["--version"], { stdio: "ignore" });
		if (!result.error && result.status === 0) {
			return cand;
		}
	}
	return null;
}

function resolve(tool: Tool): BinaryResolution {
	const cached = cache.get(tool);
	if (cached) return cached;

	const pkgName = expectedBinaryPackage();
	const bundled = resolveBundled(tool, pkgName);
	if (bundled) {
		const res: BinaryResolution = {
			source: "bundled",
			path: bundled,
			expectedPackage: pkgName ?? "(none)",
			pathProbes: [],
		};
		cache.set(tool, res);
		return res;
	}

	const candidates = PATH_CANDIDATES[tool];
	const fromPath = resolveFromPath(candidates);
	if (fromPath) {
		const res: BinaryResolution = {
			source: "path",
			path: fromPath,
			expectedPackage: pkgName ?? "(unsupported platform)",
			pathProbes: candidates,
		};
		cache.set(tool, res);
		return res;
	}

	const res: BinaryResolution = {
		source: "missing",
		path: null,
		expectedPackage: pkgName ?? "(unsupported platform)",
		pathProbes: candidates,
	};
	cache.set(tool, res);
	return res;
}

/** Absolute path to bundled or PATH-resolved `fd`, or null. Memoized. */
export function getFdPath(): string | null {
	return resolve("fd").path;
}

/** Absolute path to bundled or PATH-resolved `rg`, or null. Memoized. */
export function getRgPath(): string | null {
	return resolve("rg").path;
}

/** Full resolution detail for diagnostics. Memoized. */
export function getFdResolution(): BinaryResolution {
	return resolve("fd");
}

export function getRgResolution(): BinaryResolution {
	return resolve("rg");
}

/** Test-only: clear the memoized cache so a fresh probe runs next call. */
export function _resetBinaryCacheForTests(): void {
	cache.clear();
}

export interface StagingResult {
	fd: BinaryResolution;
	rg: BinaryResolution;
	/** Directory we staged into, or null if staging was skipped. */
	binDir: string | null;
}

/**
 * Stage the resolved bundled binaries into `<agentDir>/bin` so pi-coding-agent
 * finds them via its existing `getToolPath()` lookup. Idempotent: existing
 * symlinks/files matching the bundled location are left alone.
 *
 * Only stages binaries whose `source === "bundled"`. PATH binaries are already
 * discoverable by pi via `commandExists()`, and staging them would duplicate
 * what's already on PATH.
 *
 * Failures emit a single clear warning but never throw — gateway boot continues.
 */
export async function stageBundledBinaries(agentDir: string): Promise<StagingResult> {
	const fd = getFdResolution();
	const rg = getRgResolution();

	const binDir = path.join(agentDir, "bin");
	try {
		fs.mkdirSync(binDir, { recursive: true });
	} catch (e) {
		console.warn(`[binaries] Failed to create ${binDir}: ${(e as Error).message}`);
		return { fd, rg, binDir: null };
	}

	const ext = process.platform === "win32" ? ".exe" : "";

	for (const [tool, res] of [
		["fd", fd],
		["rg", rg],
	] as Array<[Tool, BinaryResolution]>) {
		if (res.source !== "bundled" || !res.path) continue;
		const target = path.join(binDir, `${tool}${ext}`);

		// Skip if already correctly staged (symlink to bundled, or identical copy).
		try {
			const lstat = fs.lstatSync(target);
			if (lstat.isSymbolicLink()) {
				const current = fs.readlinkSync(target);
				if (path.resolve(path.dirname(target), current) === path.resolve(res.path)) continue;
			} else if (lstat.isFile()) {
				const a = fs.statSync(res.path);
				if (a.size === lstat.size && a.mtimeMs <= lstat.mtimeMs) continue;
			}
			fs.rmSync(target, { force: true });
		} catch {
			/* target doesn't exist — fall through and create */
		}

		try {
			fs.symlinkSync(res.path, target);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "EEXIST" || code === "EPERM" || code === "EACCES" || process.platform === "win32") {
				try {
					fs.copyFileSync(res.path, target);
				} catch (copyErr) {
					console.warn(
						`[binaries] Failed to stage ${tool} into ${target}: ${(copyErr as Error).message}`,
					);
					continue;
				}
			} else {
				console.warn(`[binaries] Failed to symlink ${tool} into ${target}: ${(e as Error).message}`);
				continue;
			}
		}
		if (process.platform !== "win32") {
			try {
				fs.chmodSync(target, 0o755);
			} catch {
				/* best effort */
			}
		}
	}

	// Single clear warning for tools we couldn't resolve at all.
	for (const [tool, res] of [
		["fd", fd],
		["rg", rg],
	] as Array<[Tool, BinaryResolution]>) {
		if (res.source === "missing") {
			console.warn(
				`[binaries] ${tool} unavailable — expected sub-package ${res.expectedPackage} not installed ` +
					`and none of [${res.pathProbes.join(", ")}] found on PATH. ` +
					`On a supported platform, reinstall without --no-optional. ` +
					`Otherwise install ${tool} via your system package manager.`,
			);
		}
	}

	return { fd, rg, binDir };
}
