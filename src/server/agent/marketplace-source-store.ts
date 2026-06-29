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

export type MarketplaceSourceType = "pack" | "mcp-gateway";
type StoredMarketplaceSourceType = MarketplaceSourceType | "mcp-registry";

export interface MarketplaceSource {
	/** Stable id ([a-z0-9-]+, unique). Also the cache subdir name. */
	id: string;
	/** Source kind. Absent means the legacy/default pack source type. */
	type?: StoredMarketplaceSourceType;
	/** Git remote URL OR absolute local directory path; MCP endpoint URL for MCP gateway sources. */
	url: string;
	/** Branch/tag. Optional for pack sources only (defaults to the remote HEAD on clone). */
	ref?: string;
	addedAt: string; // ISO-8601
	/** ISO timestamp recording source-level marketplace trust acceptance. */
	trustedAt?: string;
	lastSyncedAt?: string; // ISO-8601
	lastCommit?: string;
	/** Response-only migration note for tolerated legacy source rows. */
	unsupportedReason?: string;
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

export const LEGACY_MCP_REGISTRY_UNSUPPORTED_REASON = "mcp-registry sources are no longer supported; remove and re-add this source as an MCP Gateway source";

function normalizeStoredSourceType(v: unknown): StoredMarketplaceSourceType | null {
	if (v === undefined || v === "pack") return "pack";
	if (v === "mcp-gateway") return "mcp-gateway";
	if (v === "mcp-registry") return "mcp-registry";
	return null;
}

function normalizeNewSourceType(v: unknown): MarketplaceSourceType | null {
	if (v === undefined || v === "pack") return "pack";
	if (v === "mcp-gateway") return "mcp-gateway";
	return null;
}

function publicSource(s: MarketplaceSource): MarketplaceSource {
	const out = { ...s };
	if (out.type === "mcp-registry") out.unsupportedReason = LEGACY_MCP_REGISTRY_UNSUPPORTED_REASON;
	return out;
}

function parseSource(raw: unknown): MarketplaceSource | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (!isValidSourceId(r.id)) return null;
	if (!nonEmptyString(r.url)) return null;
	const type = normalizeStoredSourceType(r.type);
	if (!type) return null;
	// §4.1/§4.4 — the built-in source is synthetic and composed only at the API
	// layer. Reject any disk-authored row that would duplicate or shadow it so a
	// hand-edited/legacy `marketplace-sources.yaml` can never collide with it.
	if (r.id === BUILTIN_SOURCE_ID || (r.url as string).trim() === BUILTIN_SOURCE_URL) return null;
	const s: MarketplaceSource = {
		id: r.id,
		url: (r.url as string).trim(),
		addedAt: nonEmptyString(r.addedAt) ? (r.addedAt as string) : new Date().toISOString(),
	};
	if (type !== "pack") s.type = type;
	// Non-pack sources do not support refs. Ignore malformed on-disk refs rather
	// than preserving them across the next save.
	if (type === "pack" && nonEmptyString(r.ref)) s.ref = (r.ref as string).trim();
	if (nonEmptyString(r.trustedAt)) s.trustedAt = r.trustedAt as string;
	if (nonEmptyString(r.lastSyncedAt)) s.lastSyncedAt = r.lastSyncedAt as string;
	if (typeof r.lastCommit === "string") s.lastCommit = r.lastCommit;
	return s;
}

function serializeSource(s: MarketplaceSource): Record<string, unknown> {
	const out: Record<string, unknown> = { id: s.id, url: s.url };
	if (s.type && s.type !== "pack") out.type = s.type;
	if ((!s.type || s.type === "pack") && s.ref) out.ref = s.ref;
	out.addedAt = s.addedAt;
	if (s.trustedAt) out.trustedAt = s.trustedAt;
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
		return this.sources.map(publicSource);
	}

	get(id: string): MarketplaceSource | undefined {
		const s = this.sources.find((x) => x.id === id);
		return s ? publicSource(s) : undefined;
	}

	getByUrl(url: string): MarketplaceSource | undefined {
		const norm = url.trim();
		const s = this.sources.find((x) => x.url === norm);
		return s ? publicSource(s) : undefined;
	}

	/**
	 * Add a new source. Derives a unique id from the url. Throws on a duplicate
	 * url. Returns the created record (sync metadata is filled in later by the
	 * install engine after a successful git sync).
	 */
	add(input: { url: string; ref?: string; type?: MarketplaceSourceType | "mcp-registry" }): MarketplaceSource {
		const url = input.url.trim();
		if (!nonEmptyString(url)) throw new Error("source url is required");
		if (input.type === "mcp-registry") throw new Error("mcp-registry sources are no longer supported; use type mcp-gateway");
		const type = normalizeNewSourceType(input.type);
		if (!type) throw new Error(`invalid source type: ${String(input.type)}`);
		if (type === "mcp-gateway" && nonEmptyString(input.ref)) throw new Error("mcp-gateway sources do not support ref");
		// Reject the reserved built-in url scheme (§4.4): the built-in source is
		// synthetic and must never be user-registered/persisted.
		if (url === BUILTIN_SOURCE_URL || url.toLowerCase().startsWith("builtin:")) {
			throw new Error(`the built-in source cannot be added`);
		}
		if (this.getByUrl(url)) throw new Error(`source already registered: ${url}`);
		const id = deriveSourceId(url, new Set(this.sources.map((s) => s.id)));
		// Reject the reserved built-in id (§4.4) even if a url happens to slug to it.
		if (id === BUILTIN_SOURCE_ID) throw new Error(`the built-in source cannot be added`);
		const now = new Date().toISOString();
		const source: MarketplaceSource = {
			id,
			url,
			addedAt: now,
			trustedAt: now,
		};
		if (type !== "pack") source.type = type;
		if (type === "pack" && nonEmptyString(input.ref)) source.ref = input.ref!.trim();
		this.sources.push(source);
		this.save();
		return publicSource(source);
	}

	/** Patch sync metadata after a sync. No-op if id unknown. */
	update(id: string, patch: Partial<Pick<MarketplaceSource, "ref" | "trustedAt" | "lastSyncedAt" | "lastCommit">>): MarketplaceSource | undefined {
		const s = this.sources.find((x) => x.id === id);
		if (!s) return undefined;
		if (patch.ref !== undefined) {
			if (s.type && s.type !== "pack" && patch.ref) throw new Error(`${s.type} sources do not support ref`);
			s.ref = patch.ref || undefined;
		}
		if (patch.trustedAt !== undefined) s.trustedAt = patch.trustedAt || undefined;
		if (patch.lastSyncedAt !== undefined) s.lastSyncedAt = patch.lastSyncedAt;
		if (patch.lastCommit !== undefined) s.lastCommit = patch.lastCommit;
		this.save();
		return publicSource(s);
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
