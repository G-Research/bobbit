import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { readManifest, type PluginManifest, type ManifestValidationError } from "./plugin-manifest.js";
import { PluginTrustStore } from "./plugin-trust-store.js";
import { buildHostApi, type PluginActivateFn, type PluginActivation } from "./host-api.js";
import type { VerifyHandlerRegistry } from "../agent/verify-handlers/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type PluginSource = "builtin" | "server" | "user" | "project";

export interface DiscoveredPlugin {
	name: string;
	path: string;
	source: PluginSource;
	manifest: PluginManifest;
	manifestErrors: ManifestValidationError[];
}

export type LoadStatus =
	| { status: "loaded"; registeredTypes: string[] }
	| { status: "needs-approval" }
	| { status: "manifest-invalid"; errors: ManifestValidationError[] }
	| { status: "error"; error: string }
	| { status: "disabled" };

export interface LoadedPlugin extends DiscoveredPlugin {
	load: LoadStatus;
	activation?: PluginActivation;
}

/**
 * Cascade order — lowest precedence first. Later sources override earlier ones
 * if they declare the same `name`. Builtin plugins (`defaults/plugins/`) are
 * auto-trusted; every other source needs explicit approval via the trust
 * store before its gateway entry is imported.
 */
export interface DiscoveryPaths {
	builtin?: string;       // dist/server/defaults/plugins/
	serverCwd?: string;     // <server-cwd>/.bobbit/plugins/
	userHome?: string;      // ~/.bobbit/plugins/
	projectRoots?: string[]; // per-project <project-root>/.bobbit/plugins/
}

export function defaultDiscoveryPaths(): DiscoveryPaths {
	return {
		builtin: path.join(__dirname, "..", "defaults", "plugins"),
		serverCwd: path.join(process.cwd(), ".bobbit", "plugins"),
		userHome: path.join(homedir(), ".bobbit", "plugins"),
	};
}

/** Scan a single directory for plugin bundles (subdirs containing plugin.yaml). */
function scanDir(dir: string, source: PluginSource): DiscoveredPlugin[] {
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
	const out: DiscoveredPlugin[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const pluginRoot = path.join(dir, entry.name);
		if (!fs.existsSync(path.join(pluginRoot, "plugin.yaml"))) continue;
		try {
			const { manifest, errors } = readManifest(pluginRoot);
			out.push({
				name: manifest.name || entry.name,
				path: path.resolve(pluginRoot),
				source,
				manifest,
				manifestErrors: errors,
			});
		} catch (e) {
			out.push({
				name: entry.name,
				path: path.resolve(pluginRoot),
				source,
				manifest: { name: entry.name, version: "0.0.0" },
				manifestErrors: [{
					field: "(manifest)",
					message: e instanceof Error ? e.message : String(e),
				}],
			});
		}
	}
	return out;
}

/** Merge discovery results across all cascade levels; later sources win on name collision. */
export function discoverPlugins(paths: DiscoveryPaths = defaultDiscoveryPaths()): DiscoveredPlugin[] {
	const byName = new Map<string, DiscoveredPlugin>();
	if (paths.builtin) for (const p of scanDir(paths.builtin, "builtin")) byName.set(p.name, p);
	if (paths.serverCwd) for (const p of scanDir(paths.serverCwd, "server")) byName.set(p.name, p);
	if (paths.userHome) for (const p of scanDir(paths.userHome, "user")) byName.set(p.name, p);
	if (paths.projectRoots) {
		for (const root of paths.projectRoots) {
			const dir = path.join(root, ".bobbit", "plugins");
			for (const p of scanDir(dir, "project")) byName.set(p.name, p);
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export class PluginLoader {
	private trust: PluginTrustStore;
	private registry: VerifyHandlerRegistry;
	private loaded = new Map<string, LoadedPlugin>();
	private moduleCache = new Map<string, unknown>();

	constructor(args: { registry: VerifyHandlerRegistry; trustStore?: PluginTrustStore }) {
		this.registry = args.registry;
		this.trust = args.trustStore ?? new PluginTrustStore();
	}

	/** Builtin plugins ship in bobbit's binary — auto-trusted. Every other source needs explicit approval. */
	private isTrustedForLoading(p: DiscoveredPlugin): boolean {
		if (p.source === "builtin") return true;
		return this.trust.isTrusted(p.path);
	}

	listLoaded(): LoadedPlugin[] {
		return [...this.loaded.values()];
	}

	getLoaded(name: string): LoadedPlugin | undefined {
		return this.loaded.get(name);
	}

	/** Trust a plugin (records hash) so a subsequent loadOne() will run it. */
	trustPlugin(p: DiscoveredPlugin): void {
		this.trust.trust(p.name, p.path);
	}

	/** Revoke trust. If the plugin is currently loaded, deactivate it. */
	async revokeTrust(p: DiscoveredPlugin): Promise<void> {
		this.trust.revoke(p.path);
		await this.unload(p.name);
	}

	/**
	 * Load a single plugin: validate manifest, check trust, import the gateway
	 * entry, call its `activate(api)`. Idempotent — repeated calls with the
	 * same plugin return the prior load record without re-importing.
	 *
	 * Returns a `LoadedPlugin` carrying the final status. Errors never throw —
	 * caller inspects `result.load.status`.
	 */
	async loadOne(p: DiscoveredPlugin): Promise<LoadedPlugin> {
		const existing = this.loaded.get(p.name);
		if (existing && existing.load.status === "loaded") return existing;

		if (p.manifestErrors.length > 0) {
			const rec: LoadedPlugin = { ...p, load: { status: "manifest-invalid", errors: p.manifestErrors } };
			this.loaded.set(p.name, rec);
			return rec;
		}

		if (!this.isTrustedForLoading(p)) {
			const rec: LoadedPlugin = { ...p, load: { status: "needs-approval" } };
			this.loaded.set(p.name, rec);
			return rec;
		}

		const entry = p.manifest.entryPoints?.gateway;
		if (!entry) {
			// A data-only plugin (workflows/roles/skills) — nothing to import server-side.
			const rec: LoadedPlugin = { ...p, load: { status: "loaded", registeredTypes: [] } };
			this.loaded.set(p.name, rec);
			return rec;
		}

		const absEntry = path.resolve(p.path, entry);
		try {
			let mod = this.moduleCache.get(absEntry);
			if (!mod) {
				mod = await import(pathToFileURL(absEntry).href);
				this.moduleCache.set(absEntry, mod);
			}
			const activate = pickActivate(mod);
			if (!activate) {
				const rec: LoadedPlugin = {
					...p,
					load: { status: "error", error: `Gateway entry ${entry} has no default export or 'activate' function.` },
				};
				this.loaded.set(p.name, rec);
				return rec;
			}
			const { api, registeredTypes } = buildHostApi({
				pluginName: p.name,
				registry: this.registry,
				logger: (level, msg) => console[level === "info" ? "log" : level](`[plugin:${p.name}] ${msg}`),
			});
			const activationResult = await activate(api);
			const activation: PluginActivation | undefined = (activationResult && typeof activationResult === "object")
				? activationResult as PluginActivation
				: undefined;
			const rec: LoadedPlugin = {
				...p,
				load: { status: "loaded", registeredTypes: registeredTypes() },
				activation,
			};
			this.loaded.set(p.name, rec);
			return rec;
		} catch (e) {
			const rec: LoadedPlugin = {
				...p,
				load: { status: "error", error: e instanceof Error ? e.message : String(e) },
			};
			this.loaded.set(p.name, rec);
			return rec;
		}
	}

	async loadAll(plugins: DiscoveredPlugin[]): Promise<LoadedPlugin[]> {
		const out: LoadedPlugin[] = [];
		for (const p of plugins) out.push(await this.loadOne(p));
		return out;
	}

	/** Unload a plugin: call its deactivate (if any), unregister its types, clear caches. */
	async unload(name: string): Promise<void> {
		const rec = this.loaded.get(name);
		if (!rec) return;
		if (rec.activation?.deactivate) {
			try {
				await rec.activation.deactivate();
			} catch (e) {
				console.warn(`[plugin:${name}] deactivate threw:`, e);
			}
		}
		if (rec.load.status === "loaded") {
			for (const type of rec.load.registeredTypes) {
				this.registry.unregister(type);
			}
		}
		this.loaded.delete(name);
		const entry = rec.manifest.entryPoints?.gateway;
		if (entry) this.moduleCache.delete(path.resolve(rec.path, entry));
	}
}

function pickActivate(mod: unknown): PluginActivateFn | undefined {
	if (!mod || typeof mod !== "object") return undefined;
	const m = mod as Record<string, unknown>;
	if (typeof m.activate === "function") return m.activate as PluginActivateFn;
	if (typeof m.default === "function") return m.default as PluginActivateFn;
	return undefined;
}

/** Bootstrap-time accessor for the loader + last discovery list. The gateway
 *  calls `setGlobalPluginLoader` during start() so REST endpoints can reach
 *  the loader without threading it through every signature. */
let _globalLoader: PluginLoader | null = null;
let _globalDiscovered: DiscoveredPlugin[] = [];

export function setGlobalPluginLoader(loader: PluginLoader | null, discovered: DiscoveredPlugin[] = []): void {
	_globalLoader = loader;
	_globalDiscovered = discovered;
}

export function getGlobalPluginLoader(): { loader: PluginLoader; discovered: DiscoveredPlugin[] } | null {
	if (!_globalLoader) return null;
	return { loader: _globalLoader, discovered: _globalDiscovered };
}

/** Re-run discovery and reconcile the loader's state. Returns the new merged list. */
export async function refreshPlugins(paths: DiscoveryPaths = defaultDiscoveryPaths()): Promise<LoadedPlugin[]> {
	const loader = _globalLoader;
	if (!loader) throw new Error("Plugin loader not initialised");
	const discovered = discoverPlugins(paths);
	_globalDiscovered = discovered;
	return loader.loadAll(discovered);
}
