/**
 * Marketplace MVP — entity-type handler registry (§8.1).
 *
 * Each entity type (role / tool / skill, and future panel/workflow/staff)
 * provides one handler. The scanner, install engine, and the "executable
 * code" check all iterate `ENTITY_HANDLERS` rather than hardcoding types, so
 * adding a new entity type is one new handler + one registry entry — no
 * changes to the scan/install/uninstall control flow.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
	parseCustomDirectories,
	saveCustomDirectories,
	type ProjectConfigWriter,
} from "../agent/config-directories.js";
import type { EntityType, InstallCtx, InstalledEntity } from "./types.js";

export interface ValidationResult {
	ok: boolean;
	error?: string;
}

/**
 * Safe entity-name grammar. Entity names from a pack manifest are joined into
 * filesystem paths, so they must never contain path separators, `..`, drive
 * letters, or leading dots. Anything outside this grammar makes the declaring
 * pack invalid and is rejected during scan — it must never reach `path.join`.
 */
export const ENTITY_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function isSafeEntityName(name: unknown): name is string {
	return typeof name === "string" && ENTITY_NAME_PATTERN.test(name);
}

/**
 * Defence-in-depth: assert that a resolved path stays under `root`. The scanner
 * already rejects unsafe names, but install/uninstall re-check so a future
 * code path that bypasses the scanner can never write/delete outside scope.
 */
export function assertWithin(root: string, target: string): void {
	if (!isWithin(root, target)) {
		throw new Error(`marketplace: path escapes ${root}: ${target}`);
	}
}

/** Non-throwing containment check used by uninstall before any delete. */
export function isWithin(root: string, target: string): boolean {
	const r = path.resolve(root);
	const t = path.resolve(target);
	return t === r || t.startsWith(r + path.sep);
}

/**
 * Delete each path only if it is contained within `root` (the entity type's
 * destination dir for the resolved scope). A path that escapes `root` — e.g.
 * from a hand-edited / tampered provenance file — is refused and surfaced, so
 * uninstall can never delete arbitrary host files.
 */
export function removeContainedPaths(root: string, paths: string[], recursive: boolean): void {
	for (const p of paths) {
		if (!isWithin(root, p)) {
			console.error(`marketplace: refusing to delete path outside ${root}: ${p}`);
			continue;
		}
		try { fs.rmSync(p, { recursive, force: true }); } catch { /* best-effort */ }
	}
}

/**
 * Recursively detect a symlink anywhere in a pack payload (the path itself or
 * any descendant), using lstat so symlinks are not followed. A marketplace
 * pack containing a symlink under roles/tools/skills is invalid: copying or
 * hashing it could read/exfiltrate host files the symlink points at. Returns
 * the offending path, or null if the subtree is symlink-free.
 */
export function findSymlink(p: string): string | null {
	let st: fs.Stats;
	try { st = fs.lstatSync(p); } catch { return null; }
	if (st.isSymbolicLink()) return p;
	if (st.isDirectory()) {
		for (const name of fs.readdirSync(p)) {
			const hit = findSymlink(path.join(p, name));
			if (hit) return hit;
		}
	}
	return null;
}

/**
 * Marketplace-local recursive copy that refuses to follow symlinks. Unlike the
 * shared tool-manager copyDirRecursive (which copyFileSync-follows links), this
 * lstat-checks every node and throws on a symlink or any non-regular file, so a
 * malicious pack cannot exfiltrate host files into a config layer.
 */
export function copyNoSymlinks(src: string, dest: string): void {
	const st = fs.lstatSync(src);
	if (st.isSymbolicLink()) {
		throw new Error(`marketplace: refusing to copy symlink: ${src}`);
	}
	if (st.isDirectory()) {
		fs.mkdirSync(dest, { recursive: true });
		for (const name of fs.readdirSync(src)) {
			copyNoSymlinks(path.join(src, name), path.join(dest, name));
		}
	} else if (st.isFile()) {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(src, dest);
	} else {
		throw new Error(`marketplace: refusing to copy non-regular file: ${src}`);
	}
}

export interface EntityTypeHandler {
	type: EntityType;
	/** key under pack.yaml `contents`. */
	manifestKey: string;
	/** does this type carry executable code? drives the §9 warning. */
	carriesCode: boolean;
	/** absolute payload path within a pack dir (file for role, dir for tool/skill). */
	payloadPath(packDir: string, name: string): string;
	/** verify the declared entity exists / parses in a pack dir. */
	validate(packDir: string, name: string): ValidationResult;
	/** primary destination path used for conflict detection. */
	destPath(ctx: InstallCtx, name: string): string;
	/** resolve the destination for a scope and copy; returns installedPaths + side-effects. */
	install(ctx: InstallCtx, packDir: string, name: string): InstalledEntity;
	/** remove exactly what install wrote (given the provenance entity). */
	uninstall(ctx: InstallCtx, entity: InstalledEntity): void;
}

function roleConfigDir(ctx: InstallCtx): string {
	return path.join(ctx.configDir, "roles");
}

function toolConfigDir(ctx: InstallCtx): string {
	return path.join(ctx.configDir, "tools");
}

/** Idempotently add `dir` to the project's config_directories (type "skills"). */
function ensureCustomSkillDir(store: ProjectConfigWriter, dir: string): void {
	const resolved = path.resolve(dir);
	const dirs = parseCustomDirectories(store);
	const existing = dirs.find((d) => path.resolve(d.path) === resolved);
	if (existing) {
		if (!existing.types.includes("skills")) {
			existing.types = [...existing.types, "skills"];
			saveCustomDirectories(store, dirs);
		}
		return;
	}
	dirs.push({ path: resolved, types: ["skills"] });
	saveCustomDirectories(store, dirs);
}

/**
 * Drop only the "skills" type registration for `dir` from config_directories,
 * preserving any other types (mcp/tools/agents) configured on the same path.
 * The dir entry is removed entirely only when "skills" was its sole type.
 * Returns whether `dir` is still referenced by config_directories afterwards.
 */
function removeCustomSkillType(store: ProjectConfigWriter, dir: string): boolean {
	const resolved = path.resolve(dir);
	const dirs = parseCustomDirectories(store);
	let changed = false;
	const next = [];
	for (const d of dirs) {
		if (path.resolve(d.path) !== resolved) {
			next.push(d);
			continue;
		}
		const types = d.types.filter((t) => t !== "skills");
		changed = changed || types.length !== d.types.length;
		if (types.length > 0) next.push({ ...d, types });
		// else: drop the entry — "skills" was its only type.
	}
	if (changed) saveCustomDirectories(store, next);
	return next.some((d) => path.resolve(d.path) === resolved);
}

const roleHandler: EntityTypeHandler = {
	type: "role",
	manifestKey: "roles",
	carriesCode: false,
	payloadPath: (packDir, name) => path.join(packDir, "roles", `${name}.yaml`),
	validate(packDir, name) {
		const p = this.payloadPath(packDir, name);
		if (!fs.existsSync(p)) return { ok: false, error: `role file missing: roles/${name}.yaml` };
		const link = findSymlink(p);
		if (link) return { ok: false, error: `role roles/${name}.yaml is a symlink (not allowed in packs)` };
		try {
			const parsed = YAML.parse(fs.readFileSync(p, "utf-8"));
			if (!parsed || typeof parsed !== "object" || typeof parsed.name !== "string" || !parsed.name.trim()) {
				return { ok: false, error: `role roles/${name}.yaml has no valid name field` };
			}
		} catch (err) {
			return { ok: false, error: `role roles/${name}.yaml failed to parse: ${(err as Error).message}` };
		}
		return { ok: true };
	},
	destPath: (ctx, name) => path.join(roleConfigDir(ctx), `${name}.yaml`),
	install(ctx, packDir, name) {
		if (!isSafeEntityName(name)) throw new Error(`marketplace: unsafe role name: ${name}`);
		const src = this.payloadPath(packDir, name);
		const dest = this.destPath(ctx, name);
		assertWithin(path.join(packDir, "roles"), src);
		assertWithin(roleConfigDir(ctx), dest);
		copyNoSymlinks(src, dest);
		ctx.invalidateRoles?.();
		return { type: "role", name, installedPaths: [dest] };
	},
	uninstall(ctx, entity) {
		removeContainedPaths(roleConfigDir(ctx), entity.installedPaths, false);
		ctx.invalidateRoles?.();
	},
};

const toolHandler: EntityTypeHandler = {
	type: "tool",
	manifestKey: "tools",
	carriesCode: true,
	payloadPath: (packDir, name) => path.join(packDir, "tools", name),
	validate(packDir, name) {
		const dir = this.payloadPath(packDir, name);
		let stat: fs.Stats;
		try { stat = fs.statSync(dir); } catch { return { ok: false, error: `tool group missing: tools/${name}/` }; }
		if (!stat.isDirectory()) return { ok: false, error: `tools/${name} is not a directory` };
		const link = findSymlink(dir);
		if (link) return { ok: false, error: `tool group tools/${name}/ contains a symlink (not allowed in packs)` };
		let yamlWithName = 0;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
			try {
				const parsed = YAML.parse(fs.readFileSync(path.join(dir, entry.name), "utf-8"));
				if (parsed && typeof parsed === "object" && typeof parsed.name === "string" && parsed.name.trim()) {
					yamlWithName++;
				}
			} catch { /* skip unparseable */ }
		}
		if (yamlWithName === 0) return { ok: false, error: `tool group tools/${name}/ has no *.yaml with a name field` };
		return { ok: true };
	},
	destPath: (ctx, name) => path.join(toolConfigDir(ctx), name),
	install(ctx, packDir, name) {
		if (!isSafeEntityName(name)) throw new Error(`marketplace: unsafe tool group name: ${name}`);
		const src = this.payloadPath(packDir, name);
		const dest = this.destPath(ctx, name);
		assertWithin(path.join(packDir, "tools"), src);
		assertWithin(toolConfigDir(ctx), dest);
		copyNoSymlinks(src, dest);
		ctx.invalidateTools?.();
		return { type: "tool", name, installedPaths: [dest] };
	},
	uninstall(ctx, entity) {
		removeContainedPaths(toolConfigDir(ctx), entity.installedPaths, true);
		ctx.invalidateTools?.();
	},
};

const skillHandler: EntityTypeHandler = {
	type: "skill",
	manifestKey: "skills",
	carriesCode: false,
	payloadPath: (packDir, name) => path.join(packDir, "skills", name),
	validate(packDir, name) {
		const dir = this.payloadPath(packDir, name);
		const skillFile = path.join(dir, "SKILL.md");
		if (!fs.existsSync(skillFile)) return { ok: false, error: `skill missing: skills/${name}/SKILL.md` };
		const link = findSymlink(dir);
		if (link) return { ok: false, error: `skill skills/${name}/ contains a symlink (not allowed in packs)` };
		return { ok: true };
	},
	destPath: (ctx, name) => path.join(ctx.skillInstallDir, name),
	install(ctx, packDir, name) {
		if (!isSafeEntityName(name)) throw new Error(`marketplace: unsafe skill name: ${name}`);
		const src = this.payloadPath(packDir, name);
		const dest = this.destPath(ctx, name);
		assertWithin(path.join(packDir, "skills"), src);
		assertWithin(ctx.skillInstallDir, dest);
		copyNoSymlinks(src, dest);
		const entity: InstalledEntity = { type: "skill", name, installedPaths: [dest] };
		// Project scope: register the (absolute) skills dir so discoverSlashSkills
		// resolves it cross-worktree. System scope (~/.bobbit/skills) is always scanned.
		if (ctx.scope === "project" && ctx.projectConfigStore) {
			ensureCustomSkillDir(ctx.projectConfigStore, ctx.skillInstallDir);
			entity.customDirRegistered = path.resolve(ctx.skillInstallDir);
		}
		return entity;
	},
	uninstall(ctx, entity) {
		removeContainedPaths(ctx.skillInstallDir, entity.installedPaths, true);
		// Drop only the "skills" registration for this dir, preserving any other
		// config types registered on the same path. Delete the dir only if it is
		// now empty AND no longer referenced by config_directories.
		if (ctx.scope === "project" && ctx.projectConfigStore && entity.customDirRegistered) {
			const dir = entity.customDirRegistered;
			const stillReferenced = removeCustomSkillType(ctx.projectConfigStore, dir);
			let empty = true;
			try { empty = fs.readdirSync(dir).length === 0; } catch { empty = true; }
			if (empty && !stillReferenced) {
				try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
			}
		}
	},
};

/** The entity-type registry. Adding a type = one handler + one entry here. */
export const ENTITY_HANDLERS: Record<EntityType, EntityTypeHandler> = {
	role: roleHandler,
	tool: toolHandler,
	skill: skillHandler,
};

/** Look up a handler by manifest key (e.g. "roles" → roleHandler). */
export function handlerForManifestKey(key: string): EntityTypeHandler | undefined {
	return Object.values(ENTITY_HANDLERS).find((h) => h.manifestKey === key);
}
