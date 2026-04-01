/**
 * Unified config directory discovery and management.
 *
 * Collects built-in + custom directories scanned for skills, MCP servers, and tools.
 * Custom directories are stored in `config_directories` in project.yaml,
 * with backward compatibility for the legacy `skill_directories` key.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ConfigType = "skills" | "mcp" | "tools" | "agents";

export interface ConfigDirectory {
	path: string;
	types: ConfigType[];
	scope: "built-in" | "user" | "project" | "custom";
	exists: boolean;
	isRemovable: boolean;
}

export interface CustomDirEntry {
	path: string;
	types: ConfigType[];
}

/** Minimal interface for reading project config values. */
export interface ProjectConfigReader {
	get(key: string): string | undefined;
}

/** Extended interface that also supports writing. */
export interface ProjectConfigWriter extends ProjectConfigReader {
	set(key: string, value: string): void;
	remove(key: string): void;
}

/** Expand ~ to home directory and resolve the path. */
function expandPath(p: string): string {
	if (p.startsWith("~")) {
		return path.resolve(path.join(os.homedir(), p.slice(1)));
	}
	return path.resolve(p);
}

/**
 * Parse the list of removed built-in directory paths from project config.
 * Returns normalized absolute paths.
 */
export function parseRemovedDirectories(
	projectConfigStore: ProjectConfigReader,
): string[] {
	const raw = projectConfigStore.get("removed_config_directories");
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed
				.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
				.map((p) => expandPath(p));
		}
	} catch (err) {
		console.warn("[config-directories] Invalid removed_config_directories JSON, ignoring:", err);
	}
	return [];
}

/**
 * Parse custom directories from project config, merging both
 * `config_directories` and legacy `skill_directories` keys.
 *
 * Deduplicates by normalized path. If the same path exists in both,
 * `config_directories` wins (it may have broader types).
 */
export function parseCustomDirectories(
	projectConfigStore: ProjectConfigReader,
): CustomDirEntry[] {
	const byPath = new Map<string, CustomDirEntry>();

	// 1. Parse skill_directories (legacy) — types: ["skills"]
	const skillDirsRaw = projectConfigStore.get("skill_directories");
	if (skillDirsRaw) {
		try {
			const parsed = JSON.parse(skillDirsRaw);
			if (Array.isArray(parsed)) {
				for (const entry of parsed) {
					if (
						typeof entry === "object" && entry !== null &&
						typeof entry.path === "string" && entry.path.trim().length > 0
					) {
						const resolved = expandPath(entry.path);
						byPath.set(resolved, { path: resolved, types: ["skills"] });
					}
				}
			}
		} catch (err) {
			console.warn("[config-directories] Invalid skill_directories JSON, ignoring:", err);
		}
	}

	// 2. Parse config_directories (new unified key) — overwrites on conflict
	const configDirsRaw = projectConfigStore.get("config_directories");
	if (configDirsRaw) {
		try {
			const parsed = JSON.parse(configDirsRaw);
			if (Array.isArray(parsed)) {
				for (const entry of parsed) {
					if (
						typeof entry === "object" && entry !== null &&
						typeof entry.path === "string" && entry.path.trim().length > 0 &&
						Array.isArray(entry.types) && entry.types.length > 0
					) {
						const resolved = expandPath(entry.path);
						const types = entry.types.filter(
							(t: unknown): t is ConfigType =>
								t === "skills" || t === "mcp" || t === "tools" || t === "agents",
						);
						if (types.length > 0) {
							byPath.set(resolved, { path: resolved, types });
						}
					}
				}
			}
		} catch (err) {
			console.warn("[config-directories] Invalid config_directories JSON, ignoring:", err);
		}
	}

	return Array.from(byPath.values());
}

/**
 * Get all config directories (built-in + custom) with existence checks.
 */
export function getAllConfigDirectories(
	cwd: string,
	projectConfigStore: ProjectConfigReader,
): ConfigDirectory[] {
	const dirs: ConfigDirectory[] = [];
	const removedSet = new Set(parseRemovedDirectories(projectConfigStore));

	// ── Skills (5 built-in) ──
	const skillDirs: Array<{ p: string; scope: "project" | "user" }> = [
		{ p: path.join(cwd, ".claude", "skills"), scope: "project" },
		{ p: path.join(cwd, ".bobbit", "skills"), scope: "project" },
		{ p: path.join(os.homedir(), ".claude", "skills"), scope: "user" },
		{ p: path.join(os.homedir(), ".bobbit", "skills"), scope: "user" },
		{ p: path.join(cwd, ".claude", "commands"), scope: "project" },
	];
	for (const { p, scope } of skillDirs) {
		const resolved = path.resolve(p);
		if (removedSet.has(resolved)) continue;
		dirs.push({
			path: resolved,
			types: ["skills"],
			scope,
			exists: fs.existsSync(resolved),
			isRemovable: true,
		});
	}

	// ── MCP (6 built-in) ──
	const mcpDirs: Array<{ p: string; scope: "project" | "user" }> = [
		{ p: path.join(os.homedir(), ".claude.json"), scope: "user" },
		{ p: path.join(os.homedir(), ".claude", ".mcp.json"), scope: "user" },
		{ p: path.join(os.homedir(), ".bobbit", ".mcp.json"), scope: "user" },
		{ p: path.join(cwd, ".mcp.json"), scope: "project" },
		{ p: path.join(cwd, ".claude", ".mcp.json"), scope: "project" },
		{ p: path.join(cwd, ".bobbit", "config", "mcp.json"), scope: "project" },
	];
	for (const { p, scope } of mcpDirs) {
		const resolved = path.resolve(p);
		if (removedSet.has(resolved)) continue;
		dirs.push({
			path: resolved,
			types: ["mcp"],
			scope,
			exists: fs.existsSync(resolved),
			isRemovable: true,
		});
	}

	// ── Tools (1 built-in) ──
	const toolsDir = path.resolve(path.join(cwd, ".bobbit", "config", "tools"));
	if (!removedSet.has(toolsDir)) {
		dirs.push({
			path: toolsDir,
			types: ["tools"],
			scope: "project",
			exists: fs.existsSync(toolsDir),
			isRemovable: true,
		});
	}

	// ── Agents (1 built-in — file path, not directory) ──
	const agentsMdPath = path.resolve(path.join(cwd, "AGENTS.md"));
	const claudeMdPath = path.resolve(path.join(cwd, "CLAUDE.md"));
	const agentsMdExists = fs.existsSync(agentsMdPath);
	const claudeMdExists = !agentsMdExists && fs.existsSync(claudeMdPath);
	const builtinAgentPath = agentsMdExists ? agentsMdPath : claudeMdExists ? claudeMdPath : agentsMdPath;
	if (!removedSet.has(builtinAgentPath)) {
		dirs.push({
			path: builtinAgentPath,
			types: ["agents"],
			scope: "project",
			exists: agentsMdExists || claudeMdExists,
			isRemovable: true,
		});
	}

	// ── Custom directories ──
	const customDirs = parseCustomDirectories(projectConfigStore);
	for (const entry of customDirs) {
		dirs.push({
			path: entry.path,
			types: entry.types,
			scope: "custom",
			exists: fs.existsSync(entry.path),
			isRemovable: true,
		});
	}

	return dirs;
}

/**
 * Remove a built-in directory from scanning by adding it to a suppress list.
 * The directory won't appear in `getAllConfigDirectories()` on subsequent calls.
 */
export function removeBuiltinDirectory(
	projectConfigStore: ProjectConfigWriter,
	dirPath: string,
): void {
	const suppressedRaw = projectConfigStore.get("suppressed_config_directories");
	let suppressed: string[] = [];
	if (suppressedRaw) {
		try { suppressed = JSON.parse(suppressedRaw); } catch {}
	}
	const resolved = path.resolve(dirPath.startsWith("~") ? path.join(os.homedir(), dirPath.slice(1)) : dirPath);
	if (!suppressed.includes(resolved)) {
		suppressed.push(resolved);
		projectConfigStore.set("suppressed_config_directories", JSON.stringify(suppressed));
	}
}

/**
 * Reset config directories to defaults by clearing custom and suppressed lists.
 */
export function resetConfigDirectories(
	projectConfigStore: ProjectConfigWriter,
): void {
	projectConfigStore.remove("config_directories");
	projectConfigStore.remove("skill_directories");
	projectConfigStore.remove("suppressed_config_directories");
}

/**
 * Save custom directories to project config via the `config_directories` key.
 * Also removes the legacy `skill_directories` key to prevent stale entries
 * from reappearing on next read (migrate forward).
 *
 * When `removedBuiltinPaths` is provided, saves it as `removed_config_directories`.
 * When not provided, the existing `removed_config_directories` key is left untouched.
 */
export function saveCustomDirectories(
	projectConfigStore: ProjectConfigWriter,
	dirs: CustomDirEntry[],
	removedBuiltinPaths?: string[],
): void {
	const serializable = dirs.map((d) => ({
		path: d.path,
		types: d.types,
	}));
	projectConfigStore.set("config_directories", JSON.stringify(serializable));
	projectConfigStore.remove("skill_directories");

	if (removedBuiltinPaths !== undefined) {
		projectConfigStore.set(
			"removed_config_directories",
			JSON.stringify(removedBuiltinPaths),
		);
	}
}

/**
 * Reset all config directory settings to defaults by removing all three keys.
 * After reset, only built-in directories will appear (none removed, none custom).
 */
export function resetConfigDirectories(
	projectConfigStore: ProjectConfigWriter,
): void {
	projectConfigStore.remove("config_directories");
	projectConfigStore.remove("skill_directories");
	projectConfigStore.remove("removed_config_directories");
}

/**
 * Add a built-in directory to the removed list so it is excluded from
 * `getAllConfigDirectories`. Idempotent — duplicate paths are ignored.
 */
export function removeBuiltinDirectory(
	projectConfigStore: ProjectConfigWriter,
	dirPath: string,
): void {
	const normalized = expandPath(dirPath);
	const current = parseRemovedDirectories(projectConfigStore);
	if (current.includes(normalized)) return;
	current.push(normalized);
	projectConfigStore.set(
		"removed_config_directories",
		JSON.stringify(current),
	);
}

/**
 * Remove a custom directory by path from the project config.
 * Only removes custom (user-added) directories, not built-in ones.
 */
export function removeBuiltinDirectory(
	projectConfigStore: ProjectConfigWriter,
	dirPath: string,
): void {
	const resolved = path.resolve(dirPath);
	const existing = parseCustomDirectories(projectConfigStore);
	const filtered = existing.filter((d) => path.resolve(d.path) !== resolved);
	if (filtered.length !== existing.length) {
		saveCustomDirectories(projectConfigStore, filtered);
	}
}

/**
 * Reset config directories to defaults by clearing all custom entries.
 */
export function resetConfigDirectories(
	projectConfigStore: ProjectConfigWriter,
): void {
	saveCustomDirectories(projectConfigStore, []);
}
