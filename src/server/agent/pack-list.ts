/**
 * buildPackList — the legacy → unified-list mapping (the CRUX).
 *
 * Produces the ONE ordered list of {@link PackEntry} packs (low→high
 * priority) that the single {@link PackResolver} walks. It encodes today's
 * resolution behavior so that, with zero market packs installed, resolution
 * is byte-for-byte identical to the legacy `ConfigCascade` (roles/tools) and
 * `slash-skills.ts` (skills) — see `docs/design/pack-based-marketplace.md` §6.
 *
 * Hard ordering constraints (do not "simplify" by naive per-scope
 * segmentation — the legacy skill order interleaves scopes):
 *   - roles/tools-bearing entries (builtin, market, user packs) are
 *     scope-segmented: builtin < server < global-user < project.
 *   - skills follow the EXACT legacy order (§6.2 rows 2–8). The legacy skill
 *     dirs are `onlyTypes:["skills"]`, so they never affect role/tool
 *     resolution regardless of position; user-pack/market entries contribute
 *     no skills today (their `skills/` subdir is empty), so their position
 *     among skill entries is inert for byte-identical resolution.
 *
 * The legacy keys `config_directories` / `disabled_config_directories` are
 * read here ONLY to build this list. After construction, no roles/tools/skills
 * code path scans directories independently of the resolver.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PackEntry, PackScope } from "./pack-types.js";
import { scopePaths } from "./pack-types.js";
import { parseCustomDirectories, type ProjectConfigReader } from "./config-directories.js";
import { readManifest, readMeta } from "./pack-manifest.js";

export interface BuildPackListOptions {
	/** dist/server/defaults — the builtin pack root. */
	builtinsDir: string;
	/** <server-cwd> — base for the server scope. */
	serverBase: string;
	/** os.homedir() — base for the global-user scope. */
	globalUserBase: string;
	/** <project root> — base for the project scope (omitted in system scope). */
	projectBase?: string;
	/** Project rootPath, for legacy .claude/* and .bobbit/* skill dirs. */
	cwd: string;
	/** Reads pack_order.{server,global-user} + legacy keys (server scope). */
	serverConfigStore?: ProjectConfigReader;
	/** Reads pack_order.project + legacy keys (project scope). */
	projectConfigStore?: ProjectConfigReader;
}

/** Expand ~ and resolve to an absolute path (mirrors config-directories.ts). */
function expandPath(p: string): string {
	if (p.startsWith("~")) return path.resolve(path.join(os.homedir(), p.slice(1)));
	return path.resolve(p);
}

/** Parse the disabled-directory list (resolved absolute paths) from a store. */
function readDisabledDirs(store?: ProjectConfigReader): Set<string> {
	const out = new Set<string>();
	if (!store) return out;
	const raw = store.get("disabled_config_directories");
	if (!raw) return out;
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			for (const p of parsed) if (typeof p === "string") out.add(path.resolve(expandPath(p)));
		}
	} catch { /* ignore malformed */ }
	return out;
}

/**
 * Scan a scope's `market-packs/` for installed packs. A dir counts as a pack
 * only if it has BOTH a valid `pack.yaml` AND a valid `.pack-meta.yaml`
 * (corrupt-guard, §8.1). `.tmp-*` staging dirs are skipped. Ordered by
 * `orderHint` (highest priority LAST); unlisted-on-disk dirs sort first.
 */
function scanMarketPacks(
	marketPacksRoot: string,
	scope: PackScope,
	orderHint: string[],
): PackEntry[] {
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(marketPacksRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const found = new Map<string, PackEntry>();
	for (const d of dirents) {
		if (!d.isDirectory() || d.name.startsWith(".tmp-") || d.name.startsWith(".")) continue;
		const dir = path.join(marketPacksRoot, d.name);
		const manifest = readManifest(dir);
		if (!manifest) continue;
		const meta = readMeta(dir);
		if (!meta) continue; // corrupt / partial install ⇒ ignored for resolution
		found.set(d.name, {
			id: `market:${scope}:${manifest.name}`,
			kind: "market",
			scope,
			path: dir,
			readOnly: true,
			manifest,
			meta,
			layout: "defaults-tree",
			skillSource: "project",
		});
	}
	// Order: on-disk-but-unlisted first (install order ≈ readdir order), then
	// listed names in orderHint order (highest priority last).
	const listed = new Set(orderHint);
	const unlisted = [...found.keys()].filter((n) => !listed.has(n));
	const ordered = [...unlisted, ...orderHint.filter((n) => found.has(n))];
	return ordered.map((n) => found.get(n)!).filter(Boolean);
}

/** Read a scope's market-pack order hint from a store, if present. */
function readPackOrder(store: ProjectConfigReader | undefined, scope: PackScope): string[] {
	if (!store) return [];
	const raw = store.get("pack_order");
	if (!raw) return [];
	try {
		const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
		const scoped = parsed?.[scope];
		if (Array.isArray(scoped)) return scoped.filter((x: unknown): x is string => typeof x === "string");
	} catch { /* ignore */ }
	return [];
}

/**
 * Build the single ordered pack list for a resolution context (low→high).
 */
export function buildPackList(opts: BuildPackListOptions): PackEntry[] {
	const entries: PackEntry[] = [];
	const disabled = readDisabledDirs(opts.projectConfigStore);

	// A skills-flat legacy-implicit entry, omitted if disabled (§6.3).
	const legacySkillDir = (
		id: string,
		dir: string,
		scope: PackScope,
		skillSource: PackEntry["skillSource"],
	): void => {
		if (disabled.has(path.resolve(dir))) return; // deliberate enforcement (§6.3)
		entries.push({
			id,
			kind: "legacy-implicit",
			scope,
			path: dir,
			readOnly: true,
			onlyTypes: ["skills"],
			layout: "skills-flat",
			skillSource,
		});
	};

	// 1. Builtin pack (roles + tools + skills, defaults-tree, lowest).
	entries.push({
		id: "builtin",
		kind: "builtin",
		scope: "builtin",
		path: opts.builtinsDir,
		readOnly: true,
		layout: "defaults-tree",
		skillSource: "built-in",
		manifest: {
			name: "builtin",
			description: "Bobbit built-ins",
			version: "0.0.0",
			contents: { roles: [], tools: [], skills: [] },
		},
	});

	// 2. Custom config_directories skill entries (§6.2 row 3). Read legacy key
	//    via the existing helper; only to build the list.
	if (opts.projectConfigStore) {
		for (const entry of parseCustomDirectories(opts.projectConfigStore)) {
			if (!entry.types.includes("skills")) continue;
			legacySkillDir(`legacy:custom:${entry.path}`, entry.path, "project", "custom");
		}
	}

	// 3. .claude/commands (§6.2 row 4, commands-flat).
	{
		const dir = path.join(opts.cwd, ".claude", "commands");
		if (!disabled.has(path.resolve(dir))) {
			entries.push({
				id: "legacy:.claude/commands",
				kind: "legacy-implicit",
				scope: "project",
				path: dir,
				readOnly: true,
				onlyTypes: ["skills"],
				layout: "commands-flat",
				skillSource: "legacy",
			});
		}
	}

	// 4. Server scope (roles/tools): market packs, then the user pack.
	{
		const { userPackRoot, marketPacksRoot } = scopePaths("server", opts.serverBase);
		entries.push(...scanMarketPacks(marketPacksRoot, "server", readPackOrder(opts.serverConfigStore, "server")));
		entries.push(userPackEntry("server", userPackRoot));
	}

	// 5. Global-user legacy personal skill dirs (§6.2 rows 5–6) — placed
	//    between server and project segments to reproduce legacy precedence.
	legacySkillDir("legacy:~/.bobbit/skills", path.join(os.homedir(), ".bobbit", "skills"), "global-user", "personal");
	legacySkillDir("legacy:~/.claude/skills", path.join(os.homedir(), ".claude", "skills"), "global-user", "personal");

	// 6. Global-user scope (roles/tools): market packs, then the user pack.
	{
		const { userPackRoot, marketPacksRoot } = scopePaths("global-user", opts.globalUserBase);
		entries.push(...scanMarketPacks(marketPacksRoot, "global-user", readPackOrder(opts.serverConfigStore, "global-user")));
		entries.push(userPackEntry("global-user", userPackRoot));
	}

	// 7. Project scope (roles/tools): market packs, then the user pack.
	if (opts.projectBase) {
		const { userPackRoot, marketPacksRoot } = scopePaths("project", opts.projectBase);
		entries.push(...scanMarketPacks(marketPacksRoot, "project", readPackOrder(opts.projectConfigStore, "project")));
		entries.push(userPackEntry("project", userPackRoot));
	}

	// 8. Project legacy skill dirs (§6.2 rows 7–8, highest skill priority).
	legacySkillDir("legacy:.bobbit/skills", path.join(opts.cwd, ".bobbit", "skills"), "project", "project");
	legacySkillDir("legacy:.claude/skills", path.join(opts.cwd, ".claude", "skills"), "project", "project");

	return entries;
}

function userPackEntry(scope: PackScope, userPackRoot: string): PackEntry {
	return {
		id: `user:${scope}`,
		kind: "user",
		scope,
		path: userPackRoot,
		readOnly: false,
		layout: "defaults-tree",
		skillSource: scope === "global-user" ? "personal" : "project",
	};
}
