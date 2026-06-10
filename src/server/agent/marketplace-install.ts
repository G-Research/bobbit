/**
 * Marketplace install engine — git sync + atomic install / uninstall / update.
 *
 * Install copies a pack subtree verbatim into a scope's `market-packs/<name>/`
 * and writes a generated `.pack-meta.yaml`; uninstall deletes the dir; update
 * re-syncs and atomically replaces it. There is NO per-entity provenance
 * ledger — the pack dir + its meta file IS the install record.
 *
 * All destination paths derive from {@link scopePaths} (the same helper
 * `buildPackList()` uses) so install and resolution can never diverge.
 *
 * See `docs/design/pack-based-marketplace.md` §7, §8.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { PackManifest, PackMeta, PackScope } from "./pack-types.js";
import { scopePaths } from "./pack-types.js";
import { isValidPackName, isSafeBasename, readManifest, readMeta, writeMeta } from "./pack-manifest.js";
import { loadPackContributions } from "./pack-contributions.js";
import { isPackPathWithinRoot } from "../extension-host/path-guard.js";
import { parseFrontmatter } from "../skills/slash-skills.js";
import type { MarketplaceSource, MarketplaceSourceStore } from "./marketplace-source-store.js";

/** Install scopes — builtin is never an install target. */
export type InstallScope = "global-user" | "server" | "project";

/** Same string set the persisted `pack_order` map is keyed by. */
export type PackOrderScope = InstallScope;

/** Minimal pack_order surface the engine mutates (ProjectConfigStore satisfies it). */
export interface PackOrderStore {
	getPackOrder(scope: PackOrderScope): string[];
	setPackOrder(scope: PackOrderScope, order: string[]): void;
}

/**
 * One-line, per-entity descriptions sourced from a pack dir, keyed by the same
 * identity the activation catalogue / entity chips use (roles/skills by name,
 * tools by GROUP name, entrypoints by `listName`). Best-effort: a kind is
 * omitted entirely when no entity in it has a usable description, and an
 * individual entity is omitted when its description is missing/empty. This is
 * the SAME authoritative pack-dir source the activation catalogue reads from —
 * never `/api/tools` or `/api/ext/contributions`.
 */
export interface PackEntityDescriptions {
	roles?: Record<string, string>;
	tools?: Record<string, string>;
	skills?: Record<string, string>;
	entrypoints?: Record<string, string>;
}

/** Browse-payload pack shape (manifest + dirName + executable-code flag). */
export interface BrowsePack extends PackManifest {
	dirName: string;
	hasTools: boolean;
	/** One-line per-entity descriptions for the Browse disclosure (R3). */
	descriptions?: PackEntityDescriptions;
}

/** Installed-pack listing row for the REST layer. */
export interface InstalledPackWire {
	scope: InstallScope;
	packName: string;
	manifest: PackManifest;
	meta: PackMeta;
	status: "ok" | "corrupt";
	/** True iff the source's latest manifest version differs from the installed
	 *  `meta.version` AND the source could be checked from the local cache. */
	updateAvailable: boolean;
	/** `"unknown"` when the source can't be checked (removed / never-synced / no
	 *  version data) — disambiguates "up to date" from "source unknown". */
	sourceStatus: "ok" | "unknown";
}

/** Coded error so the REST layer can map to HTTP statuses. */
export type MarketplaceErrorCode =
	| "unknown_source" // 404
	| "unknown_pack" // 404
	| "invalid_pack" // 422
	| "already_installed" // 409
	| "not_installed" // 409 / 404
	| "unsafe_name" // 400
	| "git_failed"; // 502

export class MarketplaceError extends Error {
	constructor(public readonly code: MarketplaceErrorCode, message: string) {
		super(message);
		this.name = "MarketplaceError";
	}
}

// ── pure helpers (exported for unit tests) ───────────────────────

/** True iff `url` denotes a local directory source (absolute path), not a git remote. */
export function isLocalDirSource(url: string): boolean {
	const u = url.trim();
	if (!u) return false;
	if (u.startsWith("file://")) return true;
	// Reject obvious remote schemes / scp-style git URLs.
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return false; // http://, https://, ssh://, git://
	if (/^[^/\\]+@[^/\\]+:/.test(u)) return false; // git@host:org/repo.git
	return path.isAbsolute(u);
}

/** Resolve a `file://` or absolute path source url to a local dir path. */
export function localSourcePath(url: string): string {
	const u = url.trim();
	if (u.startsWith("file://")) {
		// `fileURLToPath` correctly maps `file:///C:/repo` → `C:\repo` on Windows;
		// the old `new URL(u).pathname` yielded `/C:/repo` → `C:\C:\repo`.
		try {
			return path.resolve(fileURLToPath(u));
		} catch {
			return path.resolve(u.slice("file://".length));
		}
	}
	return path.resolve(u);
}

/**
 * Guard a source subdir name used to locate a pack in a browsed source tree.
 * Unlike {@link isValidPackName} (which constrains the canonical INSTALLED
 * name), source dir names are arbitrary on disk — so this only rejects path
 * traversal and dot-dirs, not casing/underscores.
 */
export function isSafeDirName(name: unknown): name is string {
	return (
		typeof name === "string" &&
		name.length > 0 &&
		!name.startsWith(".") &&
		!name.includes("..") &&
		!name.includes("/") &&
		!name.includes("\\") &&
		!name.includes(":")
	);
}

/**
 * Find the source pack whose `manifest.name` equals `packName` within a synced
 * source root. Prefers a same-named subdir (the common case); otherwise scans
 * all subdirs (handles a source dir whose name differs from its manifest name).
 */
export function findSourcePackByName(root: string, packName: string): { dir: string; manifest: PackManifest } | null {
	const direct = path.join(root, packName);
	const directManifest = readManifest(direct);
	if (directManifest && directManifest.name === packName) return { dir: direct, manifest: directManifest };
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const d of dirents) {
		if (!d.isDirectory() || d.name === ".git" || d.name.startsWith(".")) continue;
		const dir = path.join(root, d.name);
		const manifest = readManifest(dir);
		if (manifest && manifest.name === packName) return { dir, manifest };
	}
	return null;
}

/**
 * Pure version-based change detection (exported for unit tests). A pack is
 * considered to have an update available iff the source's latest manifest
 * version differs from the installed version (string inequality — the confirmed
 * change-detection rule). Empty/absent source version ⇒ no update.
 */
export function packUpdateAvailable(installedVersion: string, sourceVersion: string): boolean {
	if (!sourceVersion) return false;
	return sourceVersion !== installedVersion;
}

/** Collapse whitespace + trim to a single line; `undefined` when empty/non-string. */
function oneLineDescription(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const t = value.replace(/\s+/g, " ").trim();
	return t.length > 0 ? t : undefined;
}

/** Read a YAML mapping file best-effort; `null` on any error / non-mapping. */
function readYamlMapping(file: string): Record<string, unknown> | null {
	try {
		const data = parseYaml(fs.readFileSync(file, "utf-8"));
		return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Best-effort one-line descriptions per declared entity, sourced from the pack
 * dir (the manifest stays the authoritative list of WHICH entities exist). Used
 * by BOTH the Installed activation catalogue and the Browse payload (R3) so the
 * disclosure can show descriptions for installed AND uninstalled packs.
 *
 *   - Roles: `roles/<name>.yaml|.yml` `description`, else `label` when it differs
 *     from the name, else omitted.
 *   - Tools: representative `tools/<group>/*.yaml|.yml` `description` (keyed by
 *     GROUP name — the manifest declares tools at group granularity).
 *   - Skills: `skills/<name>/SKILL.md` frontmatter `description`.
 *   - Entry points: entrypoint YAML `description`, else its `label`, keyed by
 *     `listName` (via {@link loadPackContributions}).
 *
 * Reads ONLY the pack dir — never the runtime-filtered tool/contribution APIs.
 *
 * SECURITY: `validateManifest` does NOT guard `contents.roles/tools/skills`
 * against `..` or path separators (only `contents.entrypoints` is basename-
 * checked), so a malicious source could declare `roles: ["../../etc/passwd"]`.
 * Since this helper runs on Browse (no install required) AND on the installed
 * catalogue, EVERY manifest-declared name turned into a path is guarded with
 * {@link isSafeBasename} AND a realpath-aware {@link isPackPathWithinRoot}
 * containment check before any read/readdir. A rejected name simply yields no
 * description row (best-effort contract preserved).
 */
export function readPackEntityDescriptions(packDir: string, manifest: PackManifest): PackEntityDescriptions {
	const out: PackEntityDescriptions = {};
	const c = manifest.contents;

	// Read a path ONLY if `name` is a safe basename AND the resolved path stays
	// within `baseDir` (which itself must stay within the pack dir). Returns null
	// for any unsafe/out-of-bounds name so the caller skips that entity.
	const safeJoin = (baseDir: string, name: string, ...rest: string[]): string | null => {
		if (!isSafeBasename(name)) return null;
		if (!isPackPathWithinRoot(packDir, baseDir)) return null;
		const resolved = path.join(baseDir, name, ...rest);
		return isPackPathWithinRoot(baseDir, resolved) ? resolved : null;
	};

	const roles: Record<string, string> = {};
	const rolesDir = path.join(packDir, "roles");
	for (const name of c.roles ?? []) {
		const yamlPath = safeJoin(rolesDir, `${name}.yaml`);
		const ymlPath = safeJoin(rolesDir, `${name}.yml`);
		if (!yamlPath && !ymlPath) continue; // unsafe name — skip entirely
		const data = (yamlPath ? readYamlMapping(yamlPath) : null) ?? (ymlPath ? readYamlMapping(ymlPath) : null);
		if (!data) continue;
		let desc = oneLineDescription(data.description);
		if (!desc) {
			const label = oneLineDescription(data.label);
			if (label && label !== name) desc = label;
		}
		if (desc) roles[name] = desc;
	}
	if (Object.keys(roles).length) out.roles = roles;

	const tools: Record<string, string> = {};
	const toolsDir = path.join(packDir, "tools");
	for (const group of c.tools ?? []) {
		const dir = safeJoin(toolsDir, group);
		if (!dir) continue; // unsafe group name — skip
		let files: string[];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
		} catch {
			continue;
		}
		for (const f of files) {
			// `f` comes from readdir of the (contained) group dir, so it is a real
			// basename; still join + read defensively.
			const desc = oneLineDescription(readYamlMapping(path.join(dir, f))?.description);
			if (desc) { tools[group] = desc; break; }
		}
	}
	if (Object.keys(tools).length) out.tools = tools;

	const skills: Record<string, string> = {};
	const skillsDir = path.join(packDir, "skills");
	for (const name of c.skills ?? []) {
		const skillFile = safeJoin(skillsDir, name, "SKILL.md");
		if (!skillFile) continue; // unsafe name — skip
		try {
			const { frontmatter } = parseFrontmatter(fs.readFileSync(skillFile, "utf-8"));
			const desc = oneLineDescription((frontmatter as Record<string, unknown>)?.description);
			if (desc) skills[name] = desc;
		} catch { /* best-effort */ }
	}
	if (Object.keys(skills).length) out.skills = skills;

	const entrypoints: Record<string, string> = {};
	try {
		for (const ep of loadPackContributions(packDir, manifest).entrypoints) {
			const desc = oneLineDescription(readYamlMapping(ep.sourceFile)?.description) ?? oneLineDescription(ep.label);
			if (desc) entrypoints[ep.listName] = desc;
		}
	} catch { /* best-effort — labels/descriptions are optional */ }
	if (Object.keys(entrypoints).length) out.entrypoints = entrypoints;

	return out;
}

/** Copy a directory subtree verbatim, skipping any `.git` directory. */
export function copyDirVerbatim(src: string, dest: string): void {
	fs.cpSync(src, dest, {
		recursive: true,
		filter: (s) => path.basename(s) !== ".git",
	});
}

/**
 * A `market-packs/<name>/` dir is a valid install ONLY if it has BOTH a valid
 * `pack.yaml` AND a valid `.pack-meta.yaml` (corrupt-guard, §8.1). `.tmp-*` and
 * dotfiles are never treated as packs.
 */
export function isInstalledPackDir(dir: string, dirName: string): boolean {
	if (dirName.startsWith(".tmp-") || dirName.startsWith(".")) return false;
	return readManifest(dir) !== null && readMeta(dir) !== null;
}

/** Base directory for an install scope. */
function scopeBase(scope: InstallScope, opts: { serverBase: string; globalUserBase: string; projectBase?: string }): string {
	switch (scope) {
		case "server":
			return opts.serverBase;
		case "global-user":
			return opts.globalUserBase;
		case "project":
			if (!opts.projectBase) throw new MarketplaceError("unsafe_name", "projectBase is required for project scope");
			return opts.projectBase;
	}
}

// ── installer ────────────────────────────────────────────────────

export interface MarketplaceInstallerOptions {
	sourceStore: MarketplaceSourceStore;
	/** `<server-cwd>/.bobbit/state/marketplace-cache` — git clone cache root. */
	cacheRoot: string;
	/** `<server-cwd>` — base for the server scope. */
	serverBase: string;
	/** `os.homedir()` — base for the global-user scope. */
	globalUserBase: string;
	/** Override git runner (tests). Returns stdout; throws on failure. */
	gitRunner?: (args: string[], cwd: string) => string;
}

interface ScopeContext {
	scope: InstallScope;
	projectBase?: string;
	/** Store holding this scope's `pack_order` (ProjectConfigStore). */
	packOrderStore?: PackOrderStore;
}

export class MarketplaceInstaller {
	constructor(private readonly opts: MarketplaceInstallerOptions) {}

	// ── git sync ─────────────────────────────────────────────────

	private git(args: string[], cwd: string): string {
		if (this.opts.gitRunner) return this.opts.gitRunner(args, cwd);
		try {
			return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8", timeout: 120_000 }) as string;
		} catch (err) {
			const e = err as { stderr?: Buffer | string; message?: string };
			const stderr = e.stderr ? (typeof e.stderr === "string" ? e.stderr : e.stderr.toString("utf-8")) : "";
			throw new MarketplaceError("git_failed", stderr.trim() || e.message || "git command failed");
		}
	}

	/** Cache dir for a source id (git sources only). */
	cacheDirFor(sourceId: string): string {
		return path.join(this.opts.cacheRoot, sourceId);
	}

	/**
	 * Sync a source into its local cache and return the readable root + commit.
	 * Local-dir sources are read in place (no clone, empty commit). Git sources
	 * are shallow-cloned (re-synced via fetch+reset, re-cloned on failure).
	 * Persists `lastSyncedAt`/`lastCommit`/`ref` back onto the source store.
	 */
	syncSource(sourceId: string): { root: string; commit: string; source: MarketplaceSource } {
		const source = this.opts.sourceStore.get(sourceId);
		if (!source) throw new MarketplaceError("unknown_source", `unknown source: ${sourceId}`);

		if (isLocalDirSource(source.url)) {
			const root = localSourcePath(source.url);
			if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
				throw new MarketplaceError("git_failed", `local source path is not a directory: ${root}`);
			}
			this.opts.sourceStore.update(sourceId, { lastSyncedAt: new Date().toISOString(), lastCommit: "" });
			return { root, commit: "", source: this.opts.sourceStore.get(sourceId)! };
		}

		const cacheDir = this.cacheDirFor(sourceId);
		const ref = source.ref;
		const isRepo = fs.existsSync(path.join(cacheDir, ".git"));
		if (isRepo) {
			try {
				this.git(["fetch", "--depth", "1", "origin", ref || "HEAD"], cacheDir);
				this.git(["reset", "--hard", "FETCH_HEAD"], cacheDir);
			} catch {
				// Re-clone on any fetch/reset failure (dirty/corrupt cache).
				fs.rmSync(cacheDir, { recursive: true, force: true });
				this.clone(source, cacheDir);
			}
		} else {
			fs.rmSync(cacheDir, { recursive: true, force: true });
			this.clone(source, cacheDir);
		}
		const commit = this.git(["rev-parse", "HEAD"], cacheDir).trim();
		this.opts.sourceStore.update(sourceId, { lastSyncedAt: new Date().toISOString(), lastCommit: commit });
		return { root: cacheDir, commit, source: this.opts.sourceStore.get(sourceId)! };
	}

	private clone(source: MarketplaceSource, cacheDir: string): void {
		fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
		const args = ["clone", "--depth", "1"];
		if (source.ref) args.push("--branch", source.ref);
		args.push(source.url, cacheDir);
		this.git(args, path.dirname(cacheDir));
	}

	// ── browse ───────────────────────────────────────────────────

	/** Sync (if needed) then list packs in the source's top level. */
	browsePacks(sourceId: string): BrowsePack[] {
		const { root } = this.syncSource(sourceId);
		let dirents: fs.Dirent[];
		try {
			dirents = fs.readdirSync(root, { withFileTypes: true });
		} catch {
			return [];
		}
		const packs: BrowsePack[] = [];
		for (const d of dirents) {
			if (!d.isDirectory() || d.name === ".git" || d.name.startsWith(".")) continue;
			const dir = path.join(root, d.name);
			const manifest = readManifest(dir);
			if (!manifest) continue; // dir without a valid pack.yaml ⇒ not a pack
			packs.push({
				...manifest,
				dirName: d.name,
				hasTools: manifest.contents.tools.length > 0,
				descriptions: readPackEntityDescriptions(dir, manifest),
			});
		}
		return packs;
	}

	/**
	 * Compute the source-update state for an installed pack WITHOUT any network
	 * sync (R2). Resolves the source's readable root from the EXISTING local
	 * cache only: a local-dir source is read at `localSourcePath(url)` if it
	 * exists; a git source is read at `cacheDirFor(source.id)` if already cloned.
	 * `syncSource()` is NEVER called here. Any miss (source removed, never
	 * synced, root absent, pack not found, no version) ⇒ `sourceStatus:"unknown"`.
	 */
	private computeSourceState(meta: PackMeta): { updateAvailable: boolean; sourceStatus: "ok" | "unknown" } {
		const unknown = { updateAvailable: false, sourceStatus: "unknown" as const };
		if (!meta.sourceUrl || !meta.packName) return unknown;
		const source = this.opts.sourceStore.getByUrl(meta.sourceUrl);
		if (!source) return unknown;
		const root = isLocalDirSource(source.url) ? localSourcePath(source.url) : this.cacheDirFor(source.id);
		try {
			if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return unknown;
		} catch {
			return unknown;
		}
		const found = findSourcePackByName(root, meta.packName);
		if (!found || !found.manifest.version) return unknown;
		return { updateAvailable: packUpdateAvailable(meta.version, found.manifest.version), sourceStatus: "ok" };
	}

	// ── install / uninstall / update ─────────────────────────────

	private marketPacksRoot(ctx: ScopeContext): string {
		// Merge the context's projectBase so project-scope install/uninstall/list
		// derive the right root (the installer options only carry server/global bases).
		const base = scopeBase(ctx.scope, { ...this.opts, projectBase: ctx.projectBase });
		return scopePaths(ctx.scope as PackScope, base).marketPacksRoot;
	}

	/**
	 * Atomic install: stage → write meta → rename. Appends to pack_order.
	 *
	 * The source is located by its physical browse `dirName`, but the canonical
	 * installed identity is `manifest.name` (design §1.4): the pack is installed
	 * into `market-packs/<manifest.name>/`, and `meta.packName` / the pack_order
	 * key / the resolver `PackEntry.id` all use `manifest.name`. This keeps a
	 * source dir whose name differs from its manifest name consistent end-to-end
	 * and prevents two differently-named source dirs with the same manifest name
	 * from colliding silently.
	 */
	installPack(args: {
		sourceId: string;
		/** Physical source subdir name (browse identity) to read the pack from. */
		dirName: string;
		scope: InstallScope;
		projectBase?: string;
		packOrderStore?: PackOrderStore;
	}): InstalledPackWire {
		const { sourceId, dirName, scope } = args;
		if (!isSafeDirName(dirName)) throw new MarketplaceError("unsafe_name", `unsafe source dir name: ${JSON.stringify(dirName)}`);
		const ctx: ScopeContext = { scope, projectBase: args.projectBase, packOrderStore: args.packOrderStore };

		const { root, commit, source } = this.syncSource(sourceId);
		const src = path.join(root, dirName);
		const manifest = readManifest(src);
		if (!manifest) throw new MarketplaceError(fs.existsSync(src) ? "invalid_pack" : "unknown_pack", `no valid pack.yaml at ${dirName}`);

		// Canonical installed identity = manifest.name (design §1.4). validateManifest
		// already enforces the pack-name format, but guard defensively.
		const packName = manifest.name;
		if (!isValidPackName(packName)) throw new MarketplaceError("unsafe_name", `unsafe pack name in manifest: ${JSON.stringify(packName)}`);

		const marketRoot = this.marketPacksRoot(ctx);
		const dest = path.join(marketRoot, packName);
		if (fs.existsSync(dest)) throw new MarketplaceError("already_installed", `pack already installed at ${scope}: ${packName}`);

		fs.mkdirSync(marketRoot, { recursive: true });
		const staging = path.join(marketRoot, `.tmp-${packName}-${Math.random().toString(36).slice(2, 10)}`);
		const now = new Date().toISOString();
		const meta: PackMeta = {
			sourceUrl: source.url,
			sourceRef: source.ref ?? "",
			commit,
			packName: manifest.name,
			version: manifest.version,
			installedAt: now,
			updatedAt: now,
			scope: scope as PackScope,
		};
		try {
			copyDirVerbatim(src, staging);
			writeMeta(staging, meta);
			fs.renameSync(staging, dest);
		} catch (err) {
			fs.rmSync(staging, { recursive: true, force: true });
			throw err;
		}

		this.appendOrder(ctx, packName);
		return { scope, packName, manifest, meta, status: "ok", ...this.computeSourceState(meta) };
	}

	/** Uninstall: delete the dir, drop from pack_order. */
	uninstallPack(args: { packName: string; scope: InstallScope; projectBase?: string; packOrderStore?: PackOrderStore }): void {
		const { packName, scope } = args;
		if (!isValidPackName(packName)) throw new MarketplaceError("unsafe_name", `unsafe pack name: ${JSON.stringify(packName)}`);
		const ctx: ScopeContext = { scope, projectBase: args.projectBase, packOrderStore: args.packOrderStore };
		const dest = path.join(this.marketPacksRoot(ctx), packName);
		if (!fs.existsSync(dest)) throw new MarketplaceError("not_installed", `not installed at ${scope}: ${packName}`);
		fs.rmSync(dest, { recursive: true, force: true });
		this.removeOrder(ctx, packName);
	}

	/** Update: re-sync source, atomically replace contents, rewrite meta (keep installedAt). */
	updatePack(args: { packName: string; scope: InstallScope; projectBase?: string; packOrderStore?: PackOrderStore }): InstalledPackWire {
		const { packName, scope } = args;
		if (!isValidPackName(packName)) throw new MarketplaceError("unsafe_name", `unsafe pack name: ${JSON.stringify(packName)}`);
		const ctx: ScopeContext = { scope, projectBase: args.projectBase, packOrderStore: args.packOrderStore };
		const marketRoot = this.marketPacksRoot(ctx);
		const dest = path.join(marketRoot, packName);
		if (!fs.existsSync(dest)) throw new MarketplaceError("not_installed", `not installed at ${scope}: ${packName}`);

		const oldMeta = readMeta(dest);
		if (!oldMeta) throw new MarketplaceError("invalid_pack", `installed pack is corrupt (missing .pack-meta.yaml): ${packName}`);

		// Resolve the originating source from the stored url.
		const source = this.opts.sourceStore.getByUrl(oldMeta.sourceUrl);
		if (!source) throw new MarketplaceError("unknown_source", `source no longer registered: ${oldMeta.sourceUrl}`);

		const { root, commit } = this.syncSource(source.id);
		// The installed dir name is `manifest.name`, which may differ from the
		// physical source subdir name (design §1.4). Locate the source pack by
		// matching `manifest.name`, falling back to a same-named dir.
		const found = findSourcePackByName(root, packName);
		if (!found) throw new MarketplaceError("unknown_pack", `no source pack with name ${packName} in ${source.url}`);
		const { manifest } = found;

		const now = new Date().toISOString();
		const meta: PackMeta = {
			sourceUrl: source.url,
			sourceRef: source.ref ?? oldMeta.sourceRef ?? "",
			commit,
			packName: manifest.name,
			version: manifest.version,
			installedAt: oldMeta.installedAt || now, // preserve original install date
			updatedAt: now,
			scope: scope as PackScope,
		};

		const staging = path.join(marketRoot, `.tmp-${packName}-${Math.random().toString(36).slice(2, 10)}`);
		const backup = path.join(marketRoot, `.tmp-old-${packName}-${Math.random().toString(36).slice(2, 10)}`);
		try {
			copyDirVerbatim(found.dir, staging);
			writeMeta(staging, meta);
			// Swap: move current aside, publish staging, drop the old.
			fs.renameSync(dest, backup);
			try {
				fs.renameSync(staging, dest);
			} catch (err) {
				// Roll back the swap so the original dest is never lost.
				fs.renameSync(backup, dest);
				throw err;
			}
			fs.rmSync(backup, { recursive: true, force: true });
		} catch (err) {
			fs.rmSync(staging, { recursive: true, force: true });
			fs.rmSync(backup, { recursive: true, force: true });
			throw err;
		}
		return { scope, packName, manifest, meta, status: "ok", ...this.computeSourceState(meta) };
	}

	// ── listing ──────────────────────────────────────────────────

	/**
	 * List installed packs across the given scope contexts. Corrupt dirs (valid
	 * `pack.yaml` but missing/invalid `.pack-meta.yaml`, or vice versa) are
	 * reported with `status: "corrupt"`. `.tmp-*` dirs are skipped.
	 *
	 * Rows within each scope are ordered to match resolver precedence (the same
	 * rule as `pack-list.ts::scanMarketPacks`): on-disk-but-unlisted packs first
	 * (install order ≈ readdir order), then `pack_order`-listed names in order
	 * (highest precedence last). This keeps the UI's displayed order — which it
	 * uses to build reorder payloads — consistent with actual precedence across
	 * reloads (finding #2). Omitting `packOrder` preserves raw readdir order.
	 */
	listInstalled(contexts: Array<{ scope: InstallScope; projectBase?: string; packOrder?: string[] }>): InstalledPackWire[] {
		const out: InstalledPackWire[] = [];
		// Dedup by resolved root: a self-managed project (rootPath == server cwd)
		// resolves multiple scopes to the same `market-packs` dir; attribute the
		// pack to the FIRST listed scope only so it isn't shown twice.
		const seenRoots = new Set<string>();
		for (const c of contexts) {
			const marketRoot = this.marketPacksRoot({ scope: c.scope, projectBase: c.projectBase });
			const rootKey = path.resolve(marketRoot);
			if (seenRoots.has(rootKey)) continue;
			seenRoots.add(rootKey);
			let dirents: fs.Dirent[];
			try {
				dirents = fs.readdirSync(marketRoot, { withFileTypes: true });
			} catch {
				continue;
			}
			const rows = new Map<string, InstalledPackWire>();
			for (const d of dirents) {
				if (!d.isDirectory() || d.name.startsWith(".tmp-") || d.name.startsWith(".")) continue;
				const dir = path.join(marketRoot, d.name);
				const manifest = readManifest(dir);
				const meta = readMeta(dir);
				if (manifest && meta) {
					rows.set(d.name, { scope: c.scope, packName: d.name, manifest, meta, status: "ok", ...this.computeSourceState(meta) });
				} else if (manifest || meta) {
					// Partial / corrupt install — surface so the UI can offer cleanup.
					// Corrupt rows never offer an update and report an unknown source.
					rows.set(d.name, {
						scope: c.scope,
						packName: d.name,
						manifest: manifest ?? synthManifest(d.name, meta),
						meta: meta ?? synthMeta(d.name, c.scope, manifest),
						status: "corrupt",
						updateAvailable: false,
						sourceStatus: "unknown",
					});
				}
			}
			// Order per pack_order: unlisted-on-disk first, then listed in order.
			const orderHint = c.packOrder ?? [];
			const listed = new Set(orderHint);
			const unlisted = [...rows.keys()].filter((n) => !listed.has(n));
			const ordered = [...unlisted, ...orderHint.filter((n) => rows.has(n))];
			for (const n of ordered) out.push(rows.get(n)!);
		}
		return out;
	}

	// ── pack_order mutation ──────────────────────────────────────

	private appendOrder(ctx: ScopeContext, packName: string): void {
		if (!ctx.packOrderStore) return;
		const order = ctx.packOrderStore.getPackOrder(ctx.scope).filter((n) => n !== packName);
		order.push(packName);
		ctx.packOrderStore.setPackOrder(ctx.scope, order);
	}

	private removeOrder(ctx: ScopeContext, packName: string): void {
		if (!ctx.packOrderStore) return;
		const order = ctx.packOrderStore.getPackOrder(ctx.scope).filter((n) => n !== packName);
		ctx.packOrderStore.setPackOrder(ctx.scope, order);
	}
}

function synthManifest(name: string, meta: PackMeta | null): PackManifest {
	return {
		name,
		description: "(corrupt install — missing pack.yaml)",
		version: meta?.version ?? "0.0.0",
		contents: { roles: [], tools: [], skills: [], entrypoints: [] },
	};
}

function synthMeta(name: string, scope: InstallScope, manifest: PackManifest | null): PackMeta {
	return {
		sourceUrl: "",
		sourceRef: "",
		commit: "",
		packName: name,
		version: manifest?.version ?? "0.0.0",
		installedAt: "",
		updatedAt: "",
		scope: scope as PackScope,
	};
}
