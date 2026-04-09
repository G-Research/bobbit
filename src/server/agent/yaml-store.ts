/**
 * Generic file-backed YAML store with builtin cascade support.
 *
 * Each item is a YAML file in a subdirectory (e.g. roles/<name>.yaml).
 * Builtins are held in-memory only and never persisted — they serve as
 * the lowest-priority layer in the config cascade.
 *
 * Resolution order: local (on-disk) overrides take priority over builtins.
 */
import fs from "node:fs";
import path from "node:path";
import { stringify, parse } from "yaml";

export interface YamlStoreOptions<T> {
	/** Subdirectory name under configDir (e.g. "roles", "personalities") */
	subdir: string;
	/** Extract the unique key from an item */
	keyFn: (item: T) => string;
	/** Parse raw YAML data into a typed item, or return null to skip */
	parseItem: (data: Record<string, unknown>) => T | null;
	/** Serialize a typed item to a plain object for YAML output */
	serializeItem: (item: T) => Record<string, unknown>;
	/** Log prefix for error messages (e.g. "[role-store]") */
	logPrefix: string;
	/** Optional filter applied to getAll/getAllLocal results */
	filter?: (item: T) => boolean;
}

export class YamlStore<T extends object> {
	private _local: Map<string, T> = new Map();
	private _builtins: Map<string, T> = new Map();
	protected readonly dir: string;
	private readonly opts: YamlStoreOptions<T>;

	constructor(configDir: string, opts: YamlStoreOptions<T>) {
		this.opts = opts;
		this.dir = path.join(configDir, opts.subdir);
		fs.mkdirSync(this.dir, { recursive: true });
		this.loadAll();
	}

	// ── Builtin cascade ──────────────────────────────────────────

	/** Set builtin items (in-memory only, never persisted to disk). */
	setBuiltins(items: T[]): void {
		this._builtins = new Map(items.map(i => [this.opts.keyFn(i), i]));
	}

	// ── Read operations ──────────────────────────────────────────

	/** Get an item by key. Local overrides take priority over builtins. */
	get(key: string): T | undefined {
		return this._local.get(key) ?? this._builtins.get(key);
	}

	/** Get an item only if it exists locally on disk (ignores builtins). */
	getLocal(key: string): T | undefined {
		return this._local.get(key);
	}

	/** Get all items — builtins merged with local overrides (local wins). */
	getAll(): T[] {
		this.reload();
		const merged = new Map(this._builtins);
		for (const [k, v] of this._local) merged.set(k, v);
		const items = [...merged.values()];
		return this.opts.filter ? items.filter(this.opts.filter) : items;
	}

	/** Get only locally overridden items (ignores builtins). */
	getAllLocal(): T[] {
		this.reload();
		const items = [...this._local.values()];
		return this.opts.filter ? items.filter(this.opts.filter) : items;
	}

	// ── Write operations ─────────────────────────────────────────

	/** Add or replace an item, persisting to disk. */
	put(item: T): void {
		const key = this.opts.keyFn(item);
		this._local.set(key, item);
		this.saveOne(item);
	}

	/** Remove a local override. Does not affect builtins. */
	remove(key: string): void {
		this._local.delete(key);
		try { fs.unlinkSync(this.itemPath(key)); } catch { /* ignore */ }
	}

	/**
	 * Partial update of an existing item. Copy-on-write: if the item only
	 * exists in builtins, it is cloned to the local layer before updating.
	 * Returns false if not found in either layer.
	 */
	update(key: string, updates: Record<string, unknown>): boolean {
		let existing = this._local.get(key);
		if (!existing) {
			// Copy-on-write from builtins
			const builtin = this._builtins.get(key);
			if (!builtin) return false;
			existing = { ...builtin };
			this._local.set(key, existing);
		}
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			if (v !== undefined) cleaned[k] = v;
		}
		Object.assign(existing, cleaned, { updatedAt: Date.now() });
		this.saveOne(existing);
		return true;
	}

	/** Re-read all YAML files from disk, picking up external changes. */
	reload(): void {
		this._local.clear();
		this.loadAll();
	}

	// ── Internal ─────────────────────────────────────────────────

	protected itemPath(key: string): string {
		const filePath = path.join(this.dir, `${key}.yaml`);
		const resolved = path.resolve(filePath);
		if (!resolved.startsWith(path.resolve(this.dir))) {
			throw new Error(`Invalid key: path traversal detected`);
		}
		return filePath;
	}

	private loadAll(): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(this.dir, { withFileTypes: true });
		} catch { return; }
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
			try {
				const raw = fs.readFileSync(path.join(this.dir, entry.name), "utf-8");
				const data = parse(raw);
				if (data && typeof data === "object") {
					const item = this.opts.parseItem(data as Record<string, unknown>);
					if (item) this._local.set(this.opts.keyFn(item), item);
				}
			} catch (err) {
				console.error(`${this.opts.logPrefix} Failed to load ${entry.name}:`, err);
			}
		}
	}

	private saveOne(item: T): void {
		const key = this.opts.keyFn(item);
		const filePath = this.itemPath(key);
		try {
			fs.writeFileSync(filePath, stringify(this.opts.serializeItem(item), { lineWidth: 0 }), "utf-8");
		} catch (err) {
			console.error(`${this.opts.logPrefix} Failed to save ${key}:`, err);
		}
	}
}
