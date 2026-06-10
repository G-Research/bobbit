/**
 * Marketplace source registry.
 *
 * A *source* is a git remote (URL) or an absolute local directory whose top
 * level is a collection of pack directories. Sources are **global to the
 * server** (not per-project): a registered source can be browsed and installed
 * into any scope.
 *
 * Persisted to `<server-cwd>/.bobbit/config/marketplace-sources.yaml`. Mirrors
 * the `RoleStore` patterns (file-backed, auto-saves on mutate, graceful on a
 * missing file). See `docs/design/pack-based-marketplace.md` §7.1.
 */

import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";

/** Source id guard — also used as the cache subdir name; reject traversal. */
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSourceId(id: unknown): id is string {
	return (
		typeof id === "string" &&
		SOURCE_ID_RE.test(id) &&
		!id.includes("..") &&
		!id.includes("/") &&
		!id.includes("\\")
	);
}

export interface MarketplaceSource {
	/** Stable id ([a-z0-9-]+, unique). Also the cache subdir name. */
	id: string;
	/** Git remote URL OR absolute local directory path. */
	url: string;
	/** Branch/tag. Optional (defaults to the remote HEAD on clone). */
	ref?: string;
	addedAt: string; // ISO-8601
	lastSyncedAt?: string; // ISO-8601
	lastCommit?: string;
	/**
	 * Response-only flag marking the synthetic, non-persisted built-in source
	 * (built-in-first-party-packs §4.4). NEVER written to disk by
	 * {@link serializeSource} and NEVER read from disk by {@link parseSource}; it
	 * is composed only at the API layer. A disk-authored `builtin` is stripped.
	 */
	builtin?: boolean;
}

/** Reserved identifiers for the synthetic built-in source (§4.4). */
export const BUILTIN_SOURCE_ID = "builtin";
export const BUILTIN_SOURCE_URL = "builtin:";

function nonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function parseSource(raw: unknown): MarketplaceSource | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (!isValidSourceId(r.id)) return null;
	if (!nonEmptyString(r.url)) return null;
	const s: MarketplaceSource = {
		id: r.id,
		url: (r.url as string).trim(),
		addedAt: nonEmptyString(r.addedAt) ? (r.addedAt as string) : new Date().toISOString(),
	};
	if (nonEmptyString(r.ref)) s.ref = (r.ref as string).trim();
	if (nonEmptyString(r.lastSyncedAt)) s.lastSyncedAt = r.lastSyncedAt as string;
	if (typeof r.lastCommit === "string") s.lastCommit = r.lastCommit;
	return s;
}

function serializeSource(s: MarketplaceSource): Record<string, unknown> {
	const out: Record<string, unknown> = { id: s.id, url: s.url };
	if (s.ref) out.ref = s.ref;
	out.addedAt = s.addedAt;
	if (s.lastSyncedAt) out.lastSyncedAt = s.lastSyncedAt;
	if (s.lastCommit) out.lastCommit = s.lastCommit;
	return out;
}

/** Derive a stable, unique source id from a url (slug + numeric suffix). */
export function deriveSourceId(url: string, taken: ReadonlySet<string>): string {
	const base = url
		.trim()
		.replace(/\.git$/i, "")
		.replace(/[\\/]+$/, "")
		.split(/[\\/]/)
		.pop() || "source";
	let slug = base
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	if (!slug || !/^[a-z0-9]/.test(slug)) slug = `source${slug ? `-${slug}` : ""}`;
	slug = slug.replace(/^[^a-z0-9]+/, "") || "source";
	if (!taken.has(slug)) return slug;
	let n = 2;
	while (taken.has(`${slug}-${n}`)) n++;
	return `${slug}-${n}`;
}

/**
 * File-backed marketplace source registry. CRUD + YAML persistence.
 * `configDir` is the server scope config dir (`<server-cwd>/.bobbit/config`).
 */
export class MarketplaceSourceStore {
	private sources: MarketplaceSource[] = [];
	private readonly file: string;

	constructor(configDir: string) {
		this.file = path.join(configDir, "marketplace-sources.yaml");
		this.load();
	}

	private load(): void {
		this.sources = [];
		try {
			if (!fs.existsSync(this.file)) return;
			const raw = parse(fs.readFileSync(this.file, "utf-8"));
			if (!raw || typeof raw !== "object") return;
			const list = (raw as Record<string, unknown>).sources;
			if (!Array.isArray(list)) return;
			const seen = new Set<string>();
			for (const item of list) {
				const s = parseSource(item);
				if (!s || seen.has(s.id)) continue;
				seen.add(s.id);
				this.sources.push(s);
			}
		} catch (err) {
			console.error("[marketplace-source-store] Failed to load sources:", err);
		}
	}

	private save(): void {
		try {
			const dir = path.dirname(this.file);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			const out = { sources: this.sources.map(serializeSource) };
			fs.writeFileSync(this.file, stringify(out), "utf-8");
		} catch (err) {
			console.error("[marketplace-source-store] Failed to save sources:", err);
		}
	}

	/** Reload from disk (pick up out-of-band edits). */
	reload(): void {
		this.load();
	}

	/** All registered sources (defensive copies), in registration order. */
	list(): MarketplaceSource[] {
		return this.sources.map((s) => ({ ...s }));
	}

	get(id: string): MarketplaceSource | undefined {
		const s = this.sources.find((x) => x.id === id);
		return s ? { ...s } : undefined;
	}

	getByUrl(url: string): MarketplaceSource | undefined {
		const norm = url.trim();
		const s = this.sources.find((x) => x.url === norm);
		return s ? { ...s } : undefined;
	}

	/**
	 * Add a new source. Derives a unique id from the url. Throws on a duplicate
	 * url. Returns the created record (sync metadata is filled in later by the
	 * install engine after a successful git sync).
	 */
	add(input: { url: string; ref?: string }): MarketplaceSource {
		const url = input.url.trim();
		if (!nonEmptyString(url)) throw new Error("source url is required");
		// Reject the reserved built-in url scheme (§4.4): the built-in source is
		// synthetic and must never be user-registered/persisted.
		if (url === BUILTIN_SOURCE_URL || url.toLowerCase().startsWith("builtin:")) {
			throw new Error(`the built-in source cannot be added`);
		}
		if (this.getByUrl(url)) throw new Error(`source already registered: ${url}`);
		const id = deriveSourceId(url, new Set(this.sources.map((s) => s.id)));
		// Reject the reserved built-in id (§4.4) even if a url happens to slug to it.
		if (id === BUILTIN_SOURCE_ID) throw new Error(`the built-in source cannot be added`);
		const source: MarketplaceSource = {
			id,
			url,
			addedAt: new Date().toISOString(),
		};
		if (nonEmptyString(input.ref)) source.ref = input.ref!.trim();
		this.sources.push(source);
		this.save();
		return { ...source };
	}

	/** Patch sync metadata after a git sync. No-op if id unknown. */
	update(id: string, patch: Partial<Pick<MarketplaceSource, "ref" | "lastSyncedAt" | "lastCommit">>): MarketplaceSource | undefined {
		const s = this.sources.find((x) => x.id === id);
		if (!s) return undefined;
		if (patch.ref !== undefined) s.ref = patch.ref || undefined;
		if (patch.lastSyncedAt !== undefined) s.lastSyncedAt = patch.lastSyncedAt;
		if (patch.lastCommit !== undefined) s.lastCommit = patch.lastCommit;
		this.save();
		return { ...s };
	}

	/** Remove a source. Returns true if it existed. */
	remove(id: string): boolean {
		const before = this.sources.length;
		this.sources = this.sources.filter((s) => s.id !== id);
		const changed = this.sources.length !== before;
		if (changed) this.save();
		return changed;
	}
}
