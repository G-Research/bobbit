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
import type { PackManifest, PackMeta, PackScope } from "./pack-types.js";
import { scopePaths } from "./pack-types.js";
import { isValidPackName, readManifest, readMeta, writeMeta } from "./pack-manifest.js";
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

/** Browse-payload pack shape (manifest + dirName + executable-code flag). */
export interface BrowsePack extends PackManifest {
	dirName: string;
	hasTools: boolean;
}

/** Installed-pack listing row for the REST layer. */
export interface InstalledPackWire {
	scope: InstallScope;
	packName: string;
	manifest: PackManifest;
	meta: PackMeta;
	status: "ok" | "corrupt";
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
		try {
			return path.resolve(new URL(u).pathname);
		} catch {
			return path.resolve(u.slice("file://".length));
		}
	}
	return path.resolve(u);
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
			packs.push({ ...manifest, dirName: d.name, hasTools: manifest.contents.tools.length > 0 });
		}
		return packs;
	}

	// ── install / uninstall / update ─────────────────────────────

	private marketPacksRoot(ctx: ScopeContext): string {
		const base = scopeBase(ctx.scope, this.opts);
		return scopePaths(ctx.scope as PackScope, base).marketPacksRoot;
	}

	/** Atomic install: stage → write meta → rename. Appends to pack_order. */
	installPack(args: {
		sourceId: string;
		packName: string;
		scope: InstallScope;
		projectBase?: string;
		packOrderStore?: PackOrderStore;
	}): InstalledPackWire {
		const { sourceId, packName, scope } = args;
		if (!isValidPackName(packName)) throw new MarketplaceError("unsafe_name", `unsafe pack name: ${JSON.stringify(packName)}`);
		const ctx: ScopeContext = { scope, projectBase: args.projectBase, packOrderStore: args.packOrderStore };

		const { root, commit, source } = this.syncSource(sourceId);
		const src = path.join(root, packName);
		const manifest = readManifest(src);
		if (!manifest) throw new MarketplaceError(fs.existsSync(src) ? "invalid_pack" : "unknown_pack", `no valid pack.yaml at ${packName}`);

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
		return { scope, packName, manifest, meta, status: "ok" };
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
		const src = path.join(root, packName);
		const manifest = readManifest(src);
		if (!manifest) throw new MarketplaceError(fs.existsSync(src) ? "invalid_pack" : "unknown_pack", `no valid pack.yaml at ${packName}`);

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
			copyDirVerbatim(src, staging);
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
		return { scope, packName, manifest, meta, status: "ok" };
	}

	// ── listing ──────────────────────────────────────────────────

	/**
	 * List installed packs across the given scope contexts. Corrupt dirs (valid
	 * `pack.yaml` but missing/invalid `.pack-meta.yaml`, or vice versa) are
	 * reported with `status: "corrupt"`. `.tmp-*` dirs are skipped.
	 */
	listInstalled(contexts: Array<{ scope: InstallScope; projectBase?: string }>): InstalledPackWire[] {
		const out: InstalledPackWire[] = [];
		for (const c of contexts) {
			const marketRoot = this.marketPacksRoot({ scope: c.scope, projectBase: c.projectBase });
			let dirents: fs.Dirent[];
			try {
				dirents = fs.readdirSync(marketRoot, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const d of dirents) {
				if (!d.isDirectory() || d.name.startsWith(".tmp-") || d.name.startsWith(".")) continue;
				const dir = path.join(marketRoot, d.name);
				const manifest = readManifest(dir);
				const meta = readMeta(dir);
				if (manifest && meta) {
					out.push({ scope: c.scope, packName: d.name, manifest, meta, status: "ok" });
				} else if (manifest || meta) {
					// Partial / corrupt install — surface so the UI can offer cleanup.
					out.push({
						scope: c.scope,
						packName: d.name,
						manifest: manifest ?? synthManifest(d.name, meta),
						meta: meta ?? synthMeta(d.name, c.scope, manifest),
						status: "corrupt",
					});
				}
			}
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
		contents: { roles: [], tools: [], skills: [] },
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
