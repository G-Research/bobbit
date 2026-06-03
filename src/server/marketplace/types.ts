/**
 * Marketplace MVP — shared types.
 *
 * See docs/design/marketplace-mvp.md for the authoritative design. These
 * types model the source registry (§3), pack manifests/scan output (§2, §5),
 * the install pipeline (§6), and provenance (§7).
 */

import type { ProjectConfigWriter } from "../agent/config-directories.js";

export type SourceKind = "git" | "local";
export type InstallScope = "system" | "project";
export type EntityType = "role" | "tool" | "skill";
export type ConflictMode = "fail" | "overwrite" | "skip";
/**
 * How a pack was installed, recorded in provenance so update() can apply the
 * right semantics: `pack` = whole pack (update adds newly-declared entities,
 * refreshes existing, removes dropped); `subset` = explicit entity subset
 * (update refreshes only tracked entities, never auto-adds new ones).
 */
export type InstallMode = "pack" | "subset";

/** A configured marketplace source (git repo or local dir). Persisted in sources.json (§3.2). */
export interface SourceRecord {
	id: string;
	kind: SourceKind;
	/** git sources only — token-stripped on read/surface. */
	url: string | null;
	/** OPTIONAL git ref/branch/tag; null = remote HEAD. */
	ref: string | null;
	/** local sources only — absolute dir path. */
	path: string | null;
	/** OPTIONAL display label; defaults to repo/dir basename. */
	label: string | null;
	addedAt: number;
	/** null until first successful sync. */
	lastSyncedAt: number | null;
	/** git sources: HEAD SHA after last sync; null for local. */
	lastSyncCommit: string | null;
	/** string when the last sync failed, else null. */
	lastSyncError: string | null;
}

/** Parsed pack.yaml manifest (§2.2). Unknown keys preserved for forward-compat. */
export interface PackManifest {
	apiVersion: number;
	id: string;
	name: string;
	description: string;
	version: string;
	author?: string;
	homepage?: string;
	license?: string;
	minBobbit?: string;
	contents: PackContents;
	/** Unknown top-level keys preserved verbatim. */
	[key: string]: unknown;
}

export interface PackContents {
	roles?: string[];
	tools?: string[];
	skills?: string[];
	/** Unknown contents keys (e.g. a future `panels`) preserved verbatim. */
	[key: string]: string[] | undefined;
}

/** A single entity declared by a pack and resolved on disk. */
export interface ScannedEntity {
	type: EntityType;
	/** role/skill name, or tool GROUP name. */
	name: string;
	/** absolute source path of the payload (file for role, dir for tool group / skill). */
	sourcePath: string;
}

/** A pack discovered in a synced source root (§5.1). */
export interface ScannedPack {
	sourceId: string;
	packId: string;
	/** absolute pack dir within the sync root. */
	dir: string;
	/** parsed pack.yaml; null when parsing failed. */
	manifest: PackManifest | null;
	entities: ScannedEntity[];
	/** any tool entity → drives the "executable code" warning (§9). */
	hasTools: boolean;
	valid: boolean;
	error?: string;
}

/** A single entity that install actually wrote (provenance leaf). */
export interface InstalledEntity {
	type: EntityType;
	name: string;
	/** exact paths install wrote — uninstall removes exactly these. */
	installedPaths: string[];
	/** project-scope skills only: the custom dir registered in config_directories. */
	customDirRegistered?: string;
}

/** Provenance record — one per (scope, projectId, sourceId, packId) (§7.1). */
export interface ProvenanceRecord {
	scope: InstallScope;
	projectId: string | null;
	sourceId: string;
	packId: string;
	packName: string;
	packVersion: string;
	sourceKind: SourceKind;
	sourceUrl: string | null;
	sourceCommit: string | null;
	sourceContentHash: string | null;
	installedAt: number;
	/** whole-pack vs subset install — drives update() semantics (§6). */
	installMode: InstallMode;
	entities: InstalledEntity[];
}

/**
 * Resolved install context for a (scope, projectId) pair. The install engine
 * and entity handlers derive every destination path from this — no module
 * reaches for server singletons directly, which keeps the pipeline testable
 * against temp dirs.
 */
export interface InstallCtx {
	scope: InstallScope;
	projectId: string | null;
	/** scope config root — roles/, tools/, marketplace/ live here. */
	configDir: string;
	/** where skill dirs are copied (project: <configDir>/skills; system: ~/.bobbit/skills). */
	skillInstallDir: string;
	/** project scope only — used to (de)register the custom skills dir in config_directories. */
	projectConfigStore?: ProjectConfigWriter;
	/** invalidate tool scan caches after a tool write/remove. */
	invalidateTools?: () => void;
	/** reload role stores after a role write/remove. */
	invalidateRoles?: () => void;
}

export interface EntityRef {
	type: EntityType;
	name: string;
}

export interface InstallEntityResult {
	type: EntityType;
	name: string;
	status: "installed" | "skipped" | "conflict";
	installedPaths?: string[];
}

export interface InstallOutcome {
	record: ProvenanceRecord | null;
	results: InstallEntityResult[];
	/** entities skipped due to conflict (skip mode). */
	skipped: EntityRef[];
}

export type InstallStatus = "not-installed" | "installed" | "update-available" | "drifted";
