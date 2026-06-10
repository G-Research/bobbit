/**
 * Slash-skill discovery and parsing.
 *
 * Discovers SKILL.md files from Claude Code-compatible locations:
 *   - .claude/skills/<name>/SKILL.md  (project)
 *   - ~/.claude/skills/<name>/SKILL.md (personal)
 *   - .claude/commands/<name>.md       (legacy)
 *
 * Skills provide slash-command autocomplete and can inject instructions
 * into the agent's prompt when invoked via `/skill-name`.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { parseCustomDirectories as parseCustomDirsFromConfig, type ProjectConfigReader } from "../agent/config-directories.js";
import { buildPackList } from "../agent/pack-list.js";
import { PackResolver, SkillLoader, type ActivationFilter } from "../agent/pack-resolver.js";
import type { PackEntry, LoadedEntity, ResolvedEntity } from "../agent/pack-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** The builtin pack root (dist/server/defaults). Its skills/ subtree is the builtin-file skill source. */
const BUILTINS_DIR = path.join(__dirname, "..", "defaults");

export interface SlashSkill {
	/** Slash command name (without leading /) */
	name: string;
	/** Human-readable description */
	description: string;
	/** Hint shown during autocomplete for expected arguments */
	argumentHint?: string;
	/** If true, Claude cannot auto-invoke this skill */
	disableModelInvocation?: boolean;
	/** If false, hidden from / menu (background knowledge only) */
	userInvocable?: boolean;
	/** Raw markdown content (instructions) */
	content: string;
	/** Source: "project", "personal", "legacy", "built-in", or "custom" */
	source: "project" | "personal" | "legacy" | "built-in" | "custom";
	/** Absolute path to the SKILL.md or command .md file */
	filePath: string;
	/** Optional allowed tools list */
	allowedTools?: string[];
	/** Optional context mode (e.g. "fork") */
	context?: string;
	/** Optional agent type for forked context */
	agent?: string;
	/** Market pack `name` when this skill resolved from a market pack; null otherwise (design §5.2). */
	originPackName?: string | null;
	/** Market {@link PackEntry.id} when this skill resolved from a market pack; null otherwise (design §5.2). Mirrors roles/tools. */
	originPackId?: string | null;
}

/**
 * Explicit market-scope wiring for skill discovery — mirrors the roles/tools
 * `marketScopeContext()` in `server.ts`. Threads each scope's on-disk base +
 * `pack_order` store so server-scope market skill packs resolve even when the
 * project root differs from the server cwd, and global-user `pack_order` is
 * read from the SERVER store (not the project store). When omitted, discovery
 * falls back to `cwd` for all scopes (back-compat; design §6.5, finding #3).
 */
export interface SkillMarketContext {
	/** `<server-cwd>` — base for the server scope. */
	serverBase: string;
	/** `os.homedir()` — base for the global-user scope. */
	globalUserBase: string;
	/** `<project root>` — base for the project scope. */
	projectBase?: string;
	/** Reads `pack_order.{server,global-user}` (server config store). */
	serverConfigStore?: ProjectConfigReader;
	/** Reads `pack_order.project` + legacy keys (project config store). */
	projectConfigStore?: ProjectConfigReader;
	/**
	 * pack-schema-v1 §7: per-scope disabled-skill lookup, pre-bound to the
	 * project at the call site. Mirrors the config-cascade's
	 * `PackActivationProvider.disabled` (same `pack_activation` store, single
	 * source of truth) but scoped to skills. When supplied, a market-pack skill
	 * named in `disabled.skills` is dropped from the resolved list BEFORE the
	 * precedence merge, so a lower-priority same-named shadow can reappear.
	 * Omitted ⇒ no activation filtering (back-compat).
	 */
	packActivation?: SkillActivationLookup;
}

/**
 * Per-scope disabled-entity lookup for skill activation filtering
 * (pack-schema-v1 §7). Returns the disabled-entity refs for one market pack at a
 * scope; missing ⇒ `{}` (all enabled). Pre-bound to the project at the call site
 * so skill discovery stays decoupled from store/projectId wiring — mirrors the
 * cascade's `PackActivationProvider.disabled` return shape.
 */
export type SkillActivationLookup = (
	scope: "server" | "global-user" | "project",
	packName: string,
) => { skills?: string[] };

interface FrontMatter {
	name?: string;
	description?: string;
	"argument-hint"?: string;
	"disable-model-invocation"?: boolean;
	"user-invocable"?: boolean;
	"allowed-tools"?: string | string[];
	allowed_tools?: string | string[];
	context?: string;
	agent?: string;
}

/** Normalize the allowed-tools / allowed_tools field into a string[] (or undefined). */
function normalizeAllowedTools(fm: FrontMatter): string[] | undefined {
	const raw = fm["allowed-tools"] ?? fm.allowed_tools;
	if (raw == null) return undefined;
	if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
	if (typeof raw === "string") return raw.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
	return undefined;
}

/** Parse YAML frontmatter from a SKILL.md or command .md file. */
export function parseFrontmatter(raw: string): { frontmatter: FrontMatter; content: string } {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) return { frontmatter: {}, content: raw };

	const yamlBlock = match[1];
	const content = match[2];

	try {
		const parsed = YAML.parse(yamlBlock);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { frontmatter: parsed as FrontMatter, content };
		}
		return { frontmatter: {}, content };
	} catch (err) {
		console.warn(`[slash-skills] Failed to parse YAML frontmatter:`, err);
		return { frontmatter: {}, content: raw };
	}
}

/** Apply $ARGUMENTS, $ARGUMENTS[N], and $N substitutions. */
export function applySubstitutions(content: string, args: string): string {
	// Split arguments by whitespace
	const argParts = args.trim() ? args.trim().split(/\s+/) : [];

	// Replace $ARGUMENTS[N] and $N (indexed)
	let result = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, idx) => argParts[parseInt(idx)] ?? "");
	result = result.replace(/\$(\d+)/g, (_, idx) => argParts[parseInt(idx)] ?? "");

	// Replace $ARGUMENTS (full string)
	result = result.replace(/\$ARGUMENTS/g, args);

	return result;
}

/**
 * Scan a directory for SKILL.md files (each in a subdirectory).
 * Exported so the pack resolver's SkillLoader reuses identical parse logic.
 */
export function scanSkillDir(dir: string, source: SlashSkill["source"]): SlashSkill[] {
	const skills: SlashSkill[] = [];
	if (!fs.existsSync(dir)) return skills;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return skills;
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skillFile = path.join(dir, entry.name, "SKILL.md");
		if (!fs.existsSync(skillFile)) continue;

		try {
			const raw = fs.readFileSync(skillFile, "utf-8");
			const { frontmatter, content: rawContent } = parseFrontmatter(raw);
			// Do NOT auto-inline @path/foo.md references. Claude Code uses Level-3
			// progressive disclosure — the agent reads referenced files on demand,
			// and the activation-header manifest tells it what's available.
			const content = rawContent;

			const name = frontmatter.name || entry.name;
			const description = frontmatter.description ||
				content.split("\n").find((l) => l.trim().length > 0)?.trim() || "";

			skills.push({
				name,
				description,
				argumentHint: frontmatter["argument-hint"],
				disableModelInvocation: frontmatter["disable-model-invocation"],
				userInvocable: frontmatter["user-invocable"],
				content,
				source,
				filePath: skillFile,
				allowedTools: normalizeAllowedTools(frontmatter),
				context: frontmatter.context,
				agent: frontmatter.agent,
			});
		} catch (err) {
			console.warn(`[slash-skills] Failed to parse ${skillFile}:`, err);
		}
	}

	return skills;
}

/**
 * Scan legacy .claude/commands/ directory for .md files.
 * Exported so the pack resolver's SkillLoader reuses identical parse logic.
 */
export function scanCommandsDir(dir: string): SlashSkill[] {
	const skills: SlashSkill[] = [];
	if (!fs.existsSync(dir)) return skills;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return skills;
	}

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const filePath = path.join(dir, entry.name);
		const baseName = entry.name.replace(/\.md$/, "");

		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const { frontmatter, content: rawContent } = parseFrontmatter(raw);
			// Do NOT auto-inline @path/foo.md references — Level-3 progressive
			// disclosure (agent reads on demand).
			const content = rawContent;

			const name = frontmatter.name || baseName;
			const description = frontmatter.description ||
				content.split("\n").find((l) => l.trim().length > 0)?.trim() || "";

			skills.push({
				name,
				description,
				argumentHint: frontmatter["argument-hint"],
				disableModelInvocation: frontmatter["disable-model-invocation"],
				userInvocable: frontmatter["user-invocable"],
				content,
				source: "legacy",
				filePath,
				allowedTools: normalizeAllowedTools(frontmatter),
				context: frontmatter.context,
				agent: frontmatter.agent,
			});
		} catch (err) {
			console.warn(`[slash-skills] Failed to parse command ${filePath}:`, err);
		}
	}

	return skills;
}

/** Built-in slash commands that are always available. */
const BUILTIN_SKILLS: SlashSkill[] = [
	{
		name: "compact",
		description: "Compact conversation context to reduce token usage",
		content: "",
		source: "built-in" as SlashSkill["source"],
		filePath: "(built-in)",
	},
];

/** Parse custom skill directories from project config store (delegates to shared config-directories module). */
function parseCustomSkillDirectories(projectConfigStore?: { get(key: string): string | undefined }): { path: string }[] {
	if (!projectConfigStore) return [];
	return parseCustomDirsFromConfig(projectConfigStore)
		.filter(d => d.types.includes("skills"))
		.map(d => ({ path: d.path }));
}

/**
 * Get the complete list of directories scanned for slash skills.
 * Returns both default (built-in) and custom directories.
 */
export function getSkillDirectories(
	cwd: string,
	projectConfigStore?: { get(key: string): string | undefined },
): { path: string; source: string; isCustom: boolean }[] {
	const dirs: { path: string; source: string; isCustom: boolean }[] = [
		{ path: path.join(cwd, ".claude", "skills"), source: "project", isCustom: false },
		{ path: path.join(cwd, ".bobbit", "skills"), source: "project", isCustom: false },
		{ path: path.join(os.homedir(), ".claude", "skills"), source: "personal", isCustom: false },
		{ path: path.join(os.homedir(), ".bobbit", "skills"), source: "personal", isCustom: false },
		{ path: path.join(cwd, ".claude", "commands"), source: "legacy", isCustom: false },
	];

	for (const entry of parseCustomSkillDirectories(projectConfigStore)) {
		dirs.push({ path: entry.path, source: "custom", isCustom: true });
	}

	return dirs;
}

// Simple TTL cache
let _cache: { skills: SlashSkill[]; cwd: string; configVal: string; ts: number } | null = null;
const CACHE_TTL_MS = 5_000;

/**
 * Drop the slash-skill discovery TTL cache. Called by the REST layer after a
 * marketplace install/uninstall/update/pack-order change so the next
 * `/api/slash-skills` reflects the new pack list synchronously (design §9.1).
 */
export function invalidateSlashSkillsCache(): void {
	_cache = null;
}

/**
 * The single ordered pack list for skill discovery: the in-code static skill
 * (lowest, §6.2 row 1) prepended to the unified pack list (§6.2 rows 2–8).
 */
function buildSkillPackList(
	cwd: string,
	projectConfigStore?: ProjectConfigReader,
	marketContext?: SkillMarketContext,
): PackEntry[] {
	const staticEntry: PackEntry = {
		id: "builtin-skills-static",
		kind: "builtin",
		scope: "builtin",
		path: "",
		readOnly: true,
		onlyTypes: ["skills"],
		layout: "defaults-tree",
		skillSource: "built-in",
		preloaded: {
			skills: BUILTIN_SKILLS.map((s): LoadedEntity<SlashSkill> => ({ name: s.name, item: s })),
		},
	};
	// With an explicit market context, thread each scope's real base + store
	// (finding #3) so server-scope market skill packs resolve when the project
	// root != server cwd, and global-user pack_order comes from the server
	// store. Without it, fall back to `cwd` for every scope (back-compat).
	const list = buildPackList({
		builtinsDir: BUILTINS_DIR,
		serverBase: marketContext?.serverBase ?? cwd,
		globalUserBase: marketContext?.globalUserBase ?? os.homedir(),
		projectBase: marketContext?.projectBase ?? cwd,
		cwd,
		serverConfigStore: marketContext?.serverConfigStore ?? projectConfigStore,
		projectConfigStore: marketContext?.projectConfigStore ?? projectConfigStore,
	});
	return [staticEntry, ...list];
}

/**
 * Discover all slash skills for a given working directory.
 *
 * Adapter over the single {@link PackResolver}: builds the unified pack list
 * (§6.2 order preserved) and resolves the `skills` type, then applies the
 * `userInvocable !== false` filter, alphabetical sort, and TTL cache exactly
 * as before. Resolution is byte-identical to the legacy merge with zero
 * market packs installed.
 */
export function discoverSlashSkills(
	cwd: string,
	projectConfigStore?: { get(key: string): string | undefined },
	marketContext?: SkillMarketContext,
): SlashSkill[] {
	const store = projectConfigStore as ProjectConfigReader | undefined;
	const configVal =
		(store?.get("skill_directories") ?? "") + "|" +
		(store?.get("config_directories") ?? "") + "|" +
		(store?.get("disabled_config_directories") ?? "") + "|" +
		// Server/global-user market packs depend on the market context's bases
		// + server pack_order — include them so the TTL cache can't serve a
		// stale list across differently-wired projects (finding #3).
		(marketContext?.serverBase ?? "") + "|" +
		(marketContext?.projectBase ?? "") + "|" +
		(marketContext?.serverConfigStore?.get("pack_order") ?? "");
	if (_cache && _cache.cwd === cwd && _cache.configVal === configVal && Date.now() - _cache.ts < CACHE_TTL_MS) {
		return _cache.skills;
	}

	const resolved = discoverSlashSkillsResolved(cwd, store, marketContext);

	// Stamp the origin pack id + name (market packs only) so config pages can
	// show the pack chip; filter to user-invocable skills only (default true).
	const skills = resolved
		.map((r) => {
			const item = r.item;
			const isMarket = r.origin.kind === "market";
			item.originPackName = isMarket ? (r.origin.manifest?.name ?? null) : null;
			item.originPackId = isMarket ? r.origin.id : null;
			return item;
		})
		.filter((s) => s.userInvocable !== false);

	// Sort alphabetically
	skills.sort((a, b) => a.name.localeCompare(b.name));

	_cache = { skills, cwd, configVal, ts: Date.now() };
	return skills;
}

/**
 * Resolve slash skills as raw {@link ResolvedEntity} records (winner + shadows),
 * unfiltered and unsorted. Used by the conflicts endpoint to surface same-name
 * shadows that the flat {@link discoverSlashSkills} list discards.
 */
export function discoverSlashSkillsResolved(
	cwd: string,
	projectConfigStore?: { get(key: string): string | undefined },
	marketContext?: SkillMarketContext,
): ResolvedEntity<SlashSkill>[] {
	const store = projectConfigStore as ProjectConfigReader | undefined;
	const entries = buildSkillPackList(cwd, store, marketContext);
	// pack-schema-v1 §7: drop disabled market-pack skills BEFORE precedence merge
	// (so a lower-priority shadow can reappear), keyed by pack name + scope exactly
	// like config-cascade.ts does for roles/tools. Reuses the SAME `pack_activation`
	// store via the injected lookup — no second source of truth. Non-market entries
	// are never filtered.
	const activation = marketContext?.packActivation;
	const filter: ActivationFilter | undefined = activation
		? (entry, type, name): boolean => {
			if (type !== "skills") return true;
			if (entry.kind !== "market" || !entry.manifest) return true;
			const scope = entry.scope;
			if (scope !== "server" && scope !== "global-user" && scope !== "project") return true;
			const disabled = activation(scope, entry.manifest.name).skills;
			return !disabled || !disabled.includes(name);
		}
		: undefined;
	return new PackResolver(entries, [new SkillLoader()], filter).resolve<SlashSkill>("skills");
}

/** Look up a single slash skill by name. */
export function getSlashSkill(
	cwd: string,
	name: string,
	projectConfigStore?: { get(key: string): string | undefined },
	marketContext?: SkillMarketContext,
): SlashSkill | undefined {
	return discoverSlashSkills(cwd, projectConfigStore, marketContext).find((s) => s.name === name);
}

/**
 * Build the prompt text to inject when a slash skill is invoked.
 * Applies argument substitutions and returns the processed content.
 * If $ARGUMENTS is not present in the content, appends "ARGUMENTS: <args>" at the end.
 */
export function buildSlashSkillPrompt(skill: SlashSkill, args: string): string {
	let content = skill.content;

	if (args.trim()) {
		const hasArgsPlaceholder = /\$ARGUMENTS|\$\d+/.test(content);
		content = applySubstitutions(content, args);
		if (!hasArgsPlaceholder) {
			content += `\n\nARGUMENTS: ${args}`;
		}
	}

	return content;
}
