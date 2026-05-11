import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

/**
 * Trust store for plugin loading.
 *
 * Loading plugin code is full code-exec — sandboxing via Node `vm` is theatre,
 * so we use explicit trust instead. Builtin plugins under `defaults/plugins/`
 * are auto-trusted (they ship with bobbit). Plugins from any other location
 * must be approved explicitly; the approval is keyed by `(absolute path,
 * sha256(plugin.yaml))` so renaming or mutating the manifest re-prompts.
 *
 * State lives at `~/.bobbit/trusted-plugins.json`. Per-machine, never
 * project-scoped — a malicious project must not be able to auto-trust itself
 * by committing a trust file to its repo.
 */

export interface TrustEntry {
	name: string;
	path: string;          // absolute, normalised
	manifestHash: string;  // sha256:<hex>
	trustedAt: number;     // epoch ms
}

interface TrustFile {
	version: 1;
	trusted: TrustEntry[];
}

function defaultStorePath(): string {
	return path.join(homedir(), ".bobbit", "trusted-plugins.json");
}

export function hashManifest(pluginRoot: string): string {
	const manifestPath = path.join(pluginRoot, "plugin.yaml");
	const buf = fs.readFileSync(manifestPath);
	const h = createHash("sha256").update(buf).digest("hex");
	return `sha256:${h}`;
}

export class PluginTrustStore {
	private readonly storePath: string;
	private cache: TrustFile | null = null;

	constructor(storePath?: string) {
		this.storePath = storePath ?? defaultStorePath();
	}

	private load(): TrustFile {
		if (this.cache) return this.cache;
		if (!fs.existsSync(this.storePath)) {
			this.cache = { version: 1, trusted: [] };
			return this.cache;
		}
		try {
			const raw = fs.readFileSync(this.storePath, "utf-8");
			const parsed = JSON.parse(raw) as Partial<TrustFile>;
			if (parsed.version !== 1 || !Array.isArray(parsed.trusted)) {
				this.cache = { version: 1, trusted: [] };
				return this.cache;
			}
			this.cache = {
				version: 1,
				trusted: parsed.trusted.filter(e =>
					e && typeof e === "object" &&
					typeof e.name === "string" &&
					typeof e.path === "string" &&
					typeof e.manifestHash === "string"
				) as TrustEntry[],
			};
			return this.cache;
		} catch {
			this.cache = { version: 1, trusted: [] };
			return this.cache;
		}
	}

	private persist(): void {
		if (!this.cache) return;
		fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
		fs.writeFileSync(this.storePath, JSON.stringify(this.cache, null, 2));
	}

	/** Is the plugin at `pluginPath` trusted, validated against the current manifest hash? */
	isTrusted(pluginPath: string): boolean {
		const abs = path.resolve(pluginPath);
		if (!fs.existsSync(path.join(abs, "plugin.yaml"))) return false;
		const hash = hashManifest(abs);
		const file = this.load();
		return file.trusted.some(e => e.path === abs && e.manifestHash === hash);
	}

	/** Get the trust entry for a path, if any (even if the hash has drifted). */
	getEntry(pluginPath: string): TrustEntry | undefined {
		const abs = path.resolve(pluginPath);
		const file = this.load();
		return file.trusted.find(e => e.path === abs);
	}

	/** Persist trust for `(pluginPath, current manifest hash)`. Overwrites any prior entry for that path. */
	trust(name: string, pluginPath: string): TrustEntry {
		const abs = path.resolve(pluginPath);
		const hash = hashManifest(abs);
		const entry: TrustEntry = { name, path: abs, manifestHash: hash, trustedAt: Date.now() };
		const file = this.load();
		file.trusted = file.trusted.filter(e => e.path !== abs);
		file.trusted.push(entry);
		this.persist();
		return entry;
	}

	/** Revoke trust for a plugin at the given path. Idempotent. */
	revoke(pluginPath: string): boolean {
		const abs = path.resolve(pluginPath);
		const file = this.load();
		const before = file.trusted.length;
		file.trusted = file.trusted.filter(e => e.path !== abs);
		if (file.trusted.length === before) return false;
		this.persist();
		return true;
	}

	listTrusted(): TrustEntry[] {
		return [...this.load().trusted];
	}
}
