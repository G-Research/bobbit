/**
 * Monorepo subproject detection for the project assistant.
 *
 * Detects workspace manifests at `rootPath` (pnpm/npm/yarn workspaces, Nx, Turbo,
 * Lerna, Cargo workspaces, Go workspaces, Gradle multi-module) and expands their
 * package globs (one level deep) into a list of candidate subprojects.
 *
 * Pure detection — no network, no shell. Output is capped at MAX_CANDIDATES with
 * an alphabetical truncation marker so the assistant prompt doesn't bloat.
 *
 * The result is consumed by:
 *   - POST /api/projects/scan (added to the JSON response so the Add-Project UI
 *     and the assistant can see monorepo signals).
 *   - The project-assistant prompt instructs the agent to look for these
 *     manifests during exploration and emit one component per workspace package
 *     with `repo: "."` + distinct `relative_path`.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type MonorepoFramework =
	| "pnpm"
	| "npm-yarn-workspaces"
	| "nx"
	| "turbo"
	| "lerna"
	| "cargo"
	| "go"
	| "gradle";

export interface MonorepoCandidate {
	/** Path relative to rootPath, forward-slash. */
	relativePath: string;
	/** Frameworks that surfaced this candidate. */
	frameworks: MonorepoFramework[];
	/** Package name (e.g. "@scope/api") if discoverable from the manifest. */
	packageName?: string;
}

export interface MonorepoScanResult {
	/** Frameworks detected at root, regardless of candidate count. */
	frameworks: MonorepoFramework[];
	/** Candidate subproject paths (relative to rootPath), capped + sorted alphabetically. */
	candidates: MonorepoCandidate[];
	/** True if the candidate list was truncated. */
	truncated: boolean;
	/** Total count before truncation. */
	totalCount: number;
}

export const MAX_CANDIDATES = 30;

const SKIP_NAMES = new Set(["node_modules", ".bobbit", "dist", "build", "target", "out", ".git"]);

function safeReadFile(p: string): string | undefined {
	try { return fs.readFileSync(p, "utf-8"); } catch { return undefined; }
}

function safeJson(text: string): any | undefined {
	try { return JSON.parse(text); } catch { return undefined; }
}

function safeYaml(text: string): any | undefined {
	try { return parseYaml(text); } catch { return undefined; }
}

/** Glob expansion limited to one wildcard level: `packages/*` → list dirs in `packages/`. */
function expandGlob(rootAbs: string, pattern: string): string[] {
	const norm = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	if (!norm) return [];
	// Only support `<dir>/*` patterns; literal paths pass through.
	const star = norm.indexOf("*");
	if (star < 0) {
		return [norm];
	}
	const prefix = norm.slice(0, star).replace(/\/$/, "");
	const after = norm.slice(star + 1);
	// Reject more complex patterns (e.g. `**`, `packages/*/foo`) — too risky to guess.
	if (after && after !== "" && after !== "/") return [];
	const baseAbs = prefix ? path.join(rootAbs, prefix) : rootAbs;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(baseAbs, { withFileTypes: true });
	} catch { return []; }
	const out: string[] = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		if (SKIP_NAMES.has(e.name)) continue;
		if (e.name.startsWith(".")) continue;
		out.push(prefix ? `${prefix}/${e.name}` : e.name);
	}
	return out;
}

interface CandidateMap {
	[relPath: string]: { frameworks: Set<MonorepoFramework>; packageName?: string };
}

function addCandidate(
	map: CandidateMap,
	relPath: string,
	framework: MonorepoFramework,
	packageName?: string,
): void {
	const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	if (!norm || norm === ".") return;
	if (!map[norm]) map[norm] = { frameworks: new Set() };
	map[norm].frameworks.add(framework);
	if (packageName && !map[norm].packageName) map[norm].packageName = packageName;
}

/**
 * For a list of glob patterns, expand each, then keep only dirs that look like
 * a workspace package for the given ecosystem.
 */
function collectFromGlobs(
	rootAbs: string,
	patterns: string[],
	framework: MonorepoFramework,
	manifestNames: string[],
	map: CandidateMap,
): void {
	for (const pat of patterns) {
		const expanded = expandGlob(rootAbs, pat);
		for (const rel of expanded) {
			const abs = path.join(rootAbs, rel);
			let stat: fs.Stats;
			try { stat = fs.statSync(abs); } catch { continue; }
			if (!stat.isDirectory()) continue;
			let pkgName: string | undefined;
			let matched = false;
			for (const m of manifestNames) {
				const mAbs = path.join(abs, m);
				if (fs.existsSync(mAbs)) {
					matched = true;
					if (m === "package.json") {
						const parsed = safeJson(safeReadFile(mAbs) ?? "");
						if (parsed && typeof parsed.name === "string") pkgName = parsed.name;
					}
					break;
				}
			}
			if (matched) addCandidate(map, rel, framework, pkgName);
		}
	}
}

/**
 * Detect monorepo workspace manifests at `rootPath` and produce the candidate
 * subproject list.
 */
export function scanMonorepo(rootPath: string): MonorepoScanResult {
	const rootAbs = path.resolve(rootPath);
	const empty: MonorepoScanResult = { frameworks: [], candidates: [], truncated: false, totalCount: 0 };
	if (!fs.existsSync(rootAbs)) return empty;

	const frameworks = new Set<MonorepoFramework>();
	const map: CandidateMap = {};

	// pnpm-workspace.yaml
	const pnpmFile = safeReadFile(path.join(rootAbs, "pnpm-workspace.yaml"));
	if (pnpmFile) {
		frameworks.add("pnpm");
		const parsed = safeYaml(pnpmFile);
		const pkgs = parsed?.packages;
		if (Array.isArray(pkgs)) {
			collectFromGlobs(rootAbs, pkgs.filter(p => typeof p === "string"), "pnpm", ["package.json"], map);
		}
	}

	// package.json `workspaces`
	const rootPkg = safeJson(safeReadFile(path.join(rootAbs, "package.json")) ?? "");
	if (rootPkg) {
		const ws = rootPkg.workspaces;
		let patterns: string[] | undefined;
		if (Array.isArray(ws)) {
			patterns = ws.filter((p: unknown) => typeof p === "string");
		} else if (ws && typeof ws === "object" && Array.isArray(ws.packages)) {
			patterns = ws.packages.filter((p: unknown) => typeof p === "string");
		}
		if (patterns && patterns.length > 0) {
			frameworks.add("npm-yarn-workspaces");
			collectFromGlobs(rootAbs, patterns, "npm-yarn-workspaces", ["package.json"], map);
		}
	}

	// nx.json — strong signal even if we don't enumerate.
	if (fs.existsSync(path.join(rootAbs, "nx.json"))) {
		frameworks.add("nx");
		// Conventional Nx layouts: apps/*, libs/*, packages/*.
		for (const dir of ["apps", "libs", "packages"]) {
			collectFromGlobs(rootAbs, [`${dir}/*`], "nx", ["package.json", "project.json"], map);
		}
	}

	// turbo.json
	if (fs.existsSync(path.join(rootAbs, "turbo.json"))) {
		frameworks.add("turbo");
		// Turbo relies on package.json `workspaces` — already handled above.
	}

	// lerna.json
	const lernaFile = safeReadFile(path.join(rootAbs, "lerna.json"));
	if (lernaFile) {
		frameworks.add("lerna");
		const parsed = safeJson(lernaFile);
		const patterns = Array.isArray(parsed?.packages)
			? parsed.packages.filter((p: unknown) => typeof p === "string")
			: ["packages/*"];
		collectFromGlobs(rootAbs, patterns, "lerna", ["package.json"], map);
	}

	// Cargo workspace
	const cargoText = safeReadFile(path.join(rootAbs, "Cargo.toml"));
	if (cargoText && /\[workspace\]/.test(cargoText)) {
		frameworks.add("cargo");
		const members = extractCargoMembers(cargoText);
		collectFromGlobs(rootAbs, members, "cargo", ["Cargo.toml"], map);
	}

	// Go workspace
	const goWork = safeReadFile(path.join(rootAbs, "go.work"));
	if (goWork) {
		frameworks.add("go");
		const useDirs = extractGoUseDirs(goWork);
		collectFromGlobs(rootAbs, useDirs, "go", ["go.mod"], map);
	}

	// Gradle multi-module
	for (const f of ["settings.gradle", "settings.gradle.kts"]) {
		const text = safeReadFile(path.join(rootAbs, f));
		if (!text) continue;
		const includes = extractGradleIncludes(text);
		if (includes.length === 0) continue;
		frameworks.add("gradle");
		for (const rel of includes) {
			const abs = path.join(rootAbs, rel);
			if (fs.existsSync(abs)) addCandidate(map, rel, "gradle");
		}
		break;
	}

	// Sort + cap.
	const all = Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
	const totalCount = all.length;
	const truncated = totalCount > MAX_CANDIDATES;
	const kept = truncated ? all.slice(0, MAX_CANDIDATES) : all;
	const candidates: MonorepoCandidate[] = kept.map(([relativePath, info]) => ({
		relativePath,
		frameworks: Array.from(info.frameworks).sort(),
		packageName: info.packageName,
	}));

	return {
		frameworks: Array.from(frameworks).sort(),
		candidates,
		truncated,
		totalCount,
	};
}

/** Extract `members = [ "a", "crates/*" ]` from a Cargo.toml `[workspace]` section. */
function extractCargoMembers(text: string): string[] {
	// Find `[workspace]` and the next `members = [...]` array (multi-line ok).
	const wsIdx = text.indexOf("[workspace]");
	if (wsIdx < 0) return [];
	const after = text.slice(wsIdx);
	// Stop at next top-level [section] header that isn't [workspace.*].
	const stopMatch = after.slice(11).search(/\n\[[^.\]]/);
	const region = stopMatch < 0 ? after : after.slice(0, 11 + stopMatch + 1);
	const m = region.match(/members\s*=\s*\[([\s\S]*?)\]/);
	if (!m) return [];
	const inner = m[1];
	const items: string[] = [];
	const re = /["']([^"']+)["']/g;
	let r;
	while ((r = re.exec(inner)) !== null) items.push(r[1]);
	return items;
}

/** Extract `use ./path` directives from go.work. */
function extractGoUseDirs(text: string): string[] {
	const out: string[] = [];
	// Single: `use ./path`
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^\s*use\s+([^\s(]+)\s*$/);
		if (m) out.push(m[1].replace(/^\.\//, ""));
	}
	// Block: `use (\n  ./a\n  ./b\n)`
	const blockMatch = text.match(/use\s*\(\s*([\s\S]*?)\s*\)/);
	if (blockMatch) {
		for (const line of blockMatch[1].split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("//")) continue;
			out.push(trimmed.replace(/^\.\//, ""));
		}
	}
	return out;
}

/** Extract `include 'a:b'` / `include(":a:b")` Gradle module IDs and convert to paths. */
function extractGradleIncludes(text: string): string[] {
	const out: string[] = [];
	// Match every `include` line (or include block) and pull every quoted arg.
	// Handles: `include ':a', ':b'`, `include(':a')`, multi-line includes.
	const lineRe = /^\s*include\b[^\n]*/gm;
	let line;
	while ((line = lineRe.exec(text)) !== null) {
		const argRe = /['"]([^'"]+)['"]/g;
		let arg;
		while ((arg = argRe.exec(line[0])) !== null) {
			const id = arg[1].replace(/^:/, "");
			const rel = id.replace(/:/g, "/");
			if (rel) out.push(rel);
		}
	}
	return out;
}
