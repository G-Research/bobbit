/**
 * Pack-Based Marketplace — core type definitions.
 *
 * A *pack* is a directory laid out like Bobbit's `defaults/` tree
 * (`roles/`, `tools/`, `skills/`, and a future `mcp/`). The single
 * {@link PackResolver} walks ONE ordered list of {@link PackEntry} packs
 * (low→high priority) and produces resolved entities, each tagged with the
 * pack it came from. Precedence = position in the list.
 *
 * These interfaces are the shared contract imported by every other wave
 * (resolver, install, REST, UI). See `docs/design/pack-based-marketplace.md`
 * §1, §2.
 */

import path from "node:path";

// ── Scopes & kinds ───────────────────────────────────────────────

/** Install scope. Base order: builtin < server < global-user < project. */
export type PackScope = "builtin" | "global-user" | "server" | "project";

/** What sort of pack an entry represents. */
export type PackKind = "builtin" | "user" | "market" | "legacy-implicit";

/** Entity types the resolver can load. `mcp`/`panels` are future seams. */
export type EntityType = "roles" | "tools" | "skills"; // + "mcp" | "panels" later

/**
 * Slash-skill provenance label, preserved for API/UI back-compat. Defined
 * here (rather than in slash-skills.ts) so pack-types stays dependency-free
 * and the resolver can stamp the right value from a {@link PackEntry}.
 */
export type SkillSource = "project" | "personal" | "legacy" | "built-in" | "custom";

// ── Manifests ────────────────────────────────────────────────────

/** A pack-level routes reference (pack.yaml `routes`). The pack contributes
 *  server routes from `module` (relative to pack.yaml, contained in the pack
 *  root), gated by the `names` allowlist. See pack-schema-v1-rationalisation §1.2. */
export interface PackRoutesRef {
	module?: string;
	names?: string[];
}

/** Parsed `pack.yaml`. `contents` is REQUIRED with all entity-list keys. */
export interface PackManifest {
	name: string;
	description: string;
	version: string;
	author?: string;
	homepage?: string;
	/**
	 * Authoritative advertised contents. All keys REQUIRED but each MAY be
	 * empty. NO `mcp` key in a publishable manifest (MVP boundary — packs may
	 * not ship/install MCP configs). `mcp` exists only as a reserved code-level
	 * {@link EntityType} for the future loader seam.
	 *
	 * `entrypoints` lists the basenames (no extension) of `entrypoints/<name>.yaml`
	 * files — the user-facing activation catalogue the Market UI toggles and the
	 * pack-contribution registry keys by (default-enabled). Panels are NOT listed
	 * here: they are auto-discovered support surfaces (pack-schema-v1 §1.2).
	 */
	contents: {
		roles: string[];
		tools: string[]; // tool group dir names
		skills: string[];
		entrypoints: string[]; // entrypoints/<name>.yaml basenames; toggleable
	};
	/** Optional top-level pack-level routes (module + allowlist). Support surface,
	 *  not toggleable. Absent ⇒ the pack contributes no server routes. */
	routes?: PackRoutesRef;
}

/** Generated `.pack-meta.yaml` — install provenance. Never authored by hand. */
export interface PackMeta {
	sourceUrl: string;
	sourceRef: string;
	commit: string;
	packName: string;
	version: string;
	installedAt: string; // ISO-8601
	updatedAt: string; // ISO-8601
	scope: PackScope;
}

// ── Ordered-list entry ───────────────────────────────────────────

/** Physical layout flavour of a pack dir — how the loaders read it. */
export type PackLayout = "defaults-tree" | "skills-flat" | "commands-flat";

/**
 * A loaded entity before precedence merge.
 *
 * `name` is the merge key (unique within a type); `item` is the parsed
 * entity (`Role | ToolInfo | SlashSkill | ...`).
 */
export interface LoadedEntity<T> {
	name: string;
	item: T;
}

/** One entry in the single ordered pack list (low→high priority). */
export interface PackEntry {
	/** Stable id: builtin | user:<scope> | market:<scope>:<name> | legacy:<...>. */
	id: string;
	kind: PackKind;
	scope: PackScope;
	/** Absolute dir whose roles/ tools/ skills/ subtree is loaded. */
	path: string;
	/** builtin + legacy-implicit + claude-compat dirs ⇒ true. */
	readOnly: boolean;
	/** Present for market packs (+ synthesised for builtin). */
	manifest?: PackManifest;
	/** Present for installed market packs. */
	meta?: PackMeta;
	/** Restrict which entity types this entry contributes (e.g. ["skills"]). */
	onlyTypes?: EntityType[];
	/** How to read this dir. */
	layout: PackLayout;
	/** Skill provenance stamped by the skill loader for this entry. */
	skillSource?: SkillSource;
	/**
	 * Adapter hook: pre-loaded entities by type. When present, the matching
	 * loader returns these directly instead of scanning `path`. Used by the
	 * ConfigCascade roles/tools adapter (its data lives in injected in-memory
	 * stores, not on a scannable directory) and for the in-code builtin skill.
	 */
	preloaded?: Partial<Record<EntityType, LoadedEntity<unknown>[]>>;
}

// ── Loader interface (pluggable, type-specific) ──────────────────

/**
 * Type-specific reader. Pure: (entry) → entities. NO precedence logic — the
 * pipeline ({@link PackResolver}) owns ordering/precedence/origin. Adding
 * `mcp/` or `panels/` is adding a loader, not touching the ordering core.
 */
export interface EntityLoader<T> {
	type: EntityType;
	/** Does this loader run for this entry's layout? */
	supports(entry: PackEntry): boolean;
	load(entry: PackEntry): LoadedEntity<T>[];
}

// ── Resolved output ──────────────────────────────────────────────

export interface ResolvedEntity<T> {
	/** Merge key (entity name), echoed so callers can build conflict reports. */
	name: string;
	item: T;
	/** The winning pack. */
	origin: PackEntry;
	/** Lower-priority packs that defined the same name (oldest→newest). */
	shadows: PackEntry[];
}

// ── Conflict surfacing (marketplace manager + /api/packs/conflicts) ──

/** A reference to one pack participating in a same-name conflict (wire shape). */
export interface ConflictPackRef {
	/** {@link PackEntry.id}, e.g. `market:project:research-pack`. */
	packEntryId: string;
	scope: string;
	/** Human label: market pack name, else the scope kind. */
	label: string;
}

/** One same-name conflict `(type, name)` with winner + shadowed packs. */
export interface ConflictWire {
	type: EntityType;
	name: string;
	winner: ConflictPackRef;
	shadowed: ConflictPackRef[];
}

/** Build a wire reference for a pack entry participating in a conflict. */
export function packEntryRef(entry: PackEntry): ConflictPackRef {
	const label = entry.kind === "market" ? (entry.manifest?.name ?? entry.id) : entry.scope;
	return { packEntryId: entry.id, scope: entry.scope, label };
}

/**
 * Derive the conflict list for one entity type's resolved entities.
 *
 * Only **market-pack-involved** shadows are reported (design §4): a plain
 * builtin→user customize/override is the normal flow and is NOT flagged.
 */
export function buildConflictsFor<T>(type: EntityType, resolved: ResolvedEntity<T>[]): ConflictWire[] {
	const out: ConflictWire[] = [];
	for (const r of resolved) {
		if (r.shadows.length === 0) continue;
		const involvesMarket = r.origin.kind === "market" || r.shadows.some((s) => s.kind === "market");
		if (!involvesMarket) continue;
		out.push({
			type,
			name: r.name,
			winner: packEntryRef(r.origin),
			shadowed: r.shadows.map(packEntryRef),
		});
	}
	return out;
}

// ── Scope path derivation (single source of truth) ───────────────

/**
 * Derive a scope's user-pack root and market-packs root from a single `base`.
 * BOTH `buildPackList()` and `installPack()`/`uninstallPack()` derive paths via
 * this helper so install and resolution can never diverge (design §1.3.1).
 *
 * `base` per scope: global-user = `os.homedir()`; server = `<server-cwd>`;
 * project = `<project root>`.
 */
export function scopePaths(
	_scope: PackScope,
	base: string,
): { userPackRoot: string; marketPacksRoot: string } {
	const cfg = path.join(base, ".bobbit", "config"); // = bobbit-dir.ts configDir(base)
	return { userPackRoot: cfg, marketPacksRoot: path.join(cfg, "market-packs") };
}
