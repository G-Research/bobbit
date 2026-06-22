/**
 * TransientDraftStore — a small, synchronous, namespaced wrapper over the two
 * synchronous web-storage tiers (`sessionStorage` / `localStorage`) for *small,
 * client-local* in-progress drafts that today have no durable home and are lost
 * whenever the owning UI element is recreated (reload, LRU session-cache
 * eviction, reconnect-driven re-render, route change).
 *
 * It deliberately does NOT wrap IndexedDB or the server draft table — those
 * already have purpose-built, gen-guarded modules (`PromptDraftAttachmentsStore`,
 * `createDraftManager`, `proposal-helpers`). See
 * `docs/design/transient-draft-state.md` for the storage-tier selection rule
 * and the full rationale.
 *
 * Guarantees:
 *  - Synchronous `load`/`save`/`clear`/`forget`.
 *  - Opaque keys: `scopeKey` (e.g. `sessionId + "::" + toolUseId`) is never
 *    split, trimmed, or normalised — composite `call|fc` ids round-trip verbatim.
 *  - Last-write-wins via a per-key monotonic `gen`, so a stale async path can
 *    never clobber fresher input.
 *  - `clear()` writes a short-lived tombstone so a late `save()` scheduled before
 *    a submit cannot resurrect an already-committed draft; `forget()` hard-deletes
 *    including the tombstone.
 *  - Bounds: per-namespace LRU (`maxEntries`, by `updatedAt`) and a per-entry
 *    byte cap (`maxEntryBytes`, oversize writes dropped, never thrown).
 *  - Storage unavailable / disabled / quota errors degrade to a no-op and NEVER
 *    escape.
 */

export type DraftBackend = "session" | "local";

export interface TransientDraftStoreOptions {
	/** Stable namespace, e.g. "ask". Prefixes every storage key. */
	namespace: string;
	/** Web-storage tier. Default "session". */
	backend?: DraftBackend;
	/** Max live entries in this namespace (LRU by updatedAt). Default 50. */
	maxEntries?: number;
	/** Max serialized bytes per entry (writes above this are dropped). Default 32 KB. */
	maxEntryBytes?: number;
	/** Tombstone TTL in ms; cleared keys stay tombstoned this long. Default 5 min. */
	tombstoneTtlMs?: number;
}

export interface TransientDraftStore<T> {
	/** Synchronous read; null when absent, tombstoned, or unparseable. */
	load(key: string): T | null;
	/** Synchronous write; bumps gen + updatedAt, enforces bounds. No-op over maxEntryBytes or while tombstoned. */
	save(key: string, value: T): void;
	/** Delete the value + write a short-lived tombstone so a late save() can't resurrect. */
	clear(key: string): void;
	/** Drop a key entirely including any tombstone (hard delete). */
	forget(key: string): void;
}

const KEY_PREFIX = "bobbit_draft/";
const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_ENTRY_BYTES = 32 * 1024;
const DEFAULT_TOMBSTONE_TTL_MS = 5 * 60 * 1000;

/** Live value record. */
interface ValueRecord<T> {
	v: T;
	updatedAt: number;
	gen: number;
}

/** Tombstone record written by clear(). */
interface TombstoneRecord {
	tombstone: true;
	until: number;
	/** Last gen seen before clear, so resurrecting saves must strictly exceed it. */
	gen: number;
}

type StoredRecord<T> = ValueRecord<T> | TombstoneRecord;

function isTombstone(rec: StoredRecord<unknown> | null): rec is TombstoneRecord {
	return rec != null && (rec as TombstoneRecord).tombstone === true;
}

/**
 * Resolve a synchronous Storage object, or null if unavailable.
 * Touches the storage object behind a try/catch because access itself can throw
 * (e.g. Safari private mode, disabled cookies, sandboxed iframes).
 */
function resolveStorage(backend: DraftBackend): Storage | null {
	try {
		const g = globalThis as unknown as {
			sessionStorage?: Storage;
			localStorage?: Storage;
		};
		const s = backend === "local" ? g.localStorage : g.sessionStorage;
		// Probe: some environments expose the object but throw on use.
		if (!s) return null;
		return s;
	} catch {
		return null;
	}
}

export function createTransientDraftStore<T>(
	options: TransientDraftStoreOptions,
): TransientDraftStore<T> {
	const namespace = options.namespace;
	const backend: DraftBackend = options.backend ?? "session";
	const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
	const maxEntryBytes = Math.max(1, options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES);
	const tombstoneTtlMs = Math.max(0, options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS);
	const nsPrefix = KEY_PREFIX + namespace + "/";

	/**
	 * Per-key last-written gen, tracked in-memory so repeated synchronous saves
	 * within a session monotonically increase even if a read fails. Keyed by the
	 * full storage key.
	 */
	const lastGen = new Map<string, number>();

	function storageKeyFor(scopeKey: string): string {
		return nsPrefix + scopeKey;
	}

	function readRaw(storage: Storage, storageKey: string): StoredRecord<T> | null {
		let raw: string | null;
		try {
			raw = storage.getItem(storageKey);
		} catch {
			return null;
		}
		if (raw == null) return null;
		try {
			const parsed = JSON.parse(raw) as StoredRecord<T>;
			if (parsed && typeof parsed === "object") return parsed;
			return null;
		} catch {
			// Corrupt entry — drop it lazily so it stops wasting space.
			try {
				storage.removeItem(storageKey);
			} catch {
				/* ignore */
			}
			return null;
		}
	}

	function writeRaw(storage: Storage, storageKey: string, rec: StoredRecord<T>): boolean {
		try {
			storage.setItem(storageKey, JSON.stringify(rec));
			return true;
		} catch {
			// Quota / disabled — never throw.
			return false;
		}
	}

	/** Lazily resolve a live tombstone for a key, sweeping it if expired. */
	function liveTombstone(
		storage: Storage,
		storageKey: string,
		rec: StoredRecord<T> | null,
		now: number,
	): TombstoneRecord | null {
		if (!isTombstone(rec)) return null;
		if (rec.until > now) return rec;
		// Expired — sweep.
		try {
			storage.removeItem(storageKey);
		} catch {
			/* ignore */
		}
		return null;
	}

	/** Enforce per-namespace LRU, never evicting `keepKey`. */
	function enforceLru(storage: Storage, keepKey: string): void {
		let keys: string[];
		try {
			const len = storage.length;
			keys = [];
			for (let i = 0; i < len; i++) {
				const k = storage.key(i);
				if (k != null && k.startsWith(nsPrefix)) keys.push(k);
			}
		} catch {
			return;
		}
		if (keys.length <= maxEntries) return;

		// Build (key, updatedAt) for value records; tombstones sort oldest (evict first).
		const aged: Array<{ key: string; updatedAt: number }> = [];
		for (const k of keys) {
			if (k === keepKey) continue;
			const rec = readRaw(storage, k);
			let updatedAt = 0;
			if (rec && !isTombstone(rec)) updatedAt = rec.updatedAt;
			aged.push({ key: k, updatedAt });
		}
		// Oldest first.
		aged.sort((a, b) => a.updatedAt - b.updatedAt);
		// We must end with at most maxEntries total (including keepKey).
		let excess = keys.length - maxEntries;
		for (const entry of aged) {
			if (excess <= 0) break;
			try {
				storage.removeItem(entry.key);
				lastGen.delete(entry.key);
			} catch {
				/* ignore */
			}
			excess--;
		}
	}

	function load(scopeKey: string): T | null {
		const storage = resolveStorage(backend);
		if (!storage) return null;
		const storageKey = storageKeyFor(scopeKey);
		const now = Date.now();
		const rec = readRaw(storage, storageKey);
		if (liveTombstone(storage, storageKey, rec, now)) return null;
		if (rec == null || isTombstone(rec)) return null;
		// Track gen so subsequent saves remain monotonic.
		const prev = lastGen.get(storageKey) ?? 0;
		if (rec.gen > prev) lastGen.set(storageKey, rec.gen);
		return rec.v;
	}

	function save(scopeKey: string, value: T): void {
		const storage = resolveStorage(backend);
		if (!storage) return;
		const storageKey = storageKeyFor(scopeKey);
		const now = Date.now();

		const existing = readRaw(storage, storageKey);
		const tomb = liveTombstone(storage, storageKey, existing, now);
		if (tomb) {
			// A live tombstone blocks resurrection by stale/equal-gen saves.
			return;
		}

		// Last-write-wins: gen strictly greater than anything seen.
		let baseGen = lastGen.get(storageKey) ?? 0;
		if (existing && !isTombstone(existing) && existing.gen > baseGen) {
			baseGen = existing.gen;
		}
		const nextGen = baseGen + 1;

		const rec: ValueRecord<T> = { v: value, updatedAt: now, gen: nextGen };
		let serialized: string;
		try {
			serialized = JSON.stringify(rec);
		} catch {
			return;
		}
		// Per-entry byte cap — drop oversize writes rather than risk quota errors.
		// (UTF-16 length is a cheap upper-bound proxy for byte size.)
		const byteLen = utf8ByteLength(serialized);
		if (byteLen > maxEntryBytes) {
			warnOversizeOnce(namespace);
			return;
		}

		try {
			storage.setItem(storageKey, serialized);
		} catch {
			// Quota / disabled — never throw.
			return;
		}
		lastGen.set(storageKey, nextGen);
		enforceLru(storage, storageKey);
	}

	function clear(scopeKey: string): void {
		const storage = resolveStorage(backend);
		if (!storage) return;
		const storageKey = storageKeyFor(scopeKey);
		const now = Date.now();
		const existing = readRaw(storage, storageKey);
		let gen = lastGen.get(storageKey) ?? 0;
		if (existing && !isTombstone(existing) && existing.gen > gen) gen = existing.gen;
		if (isTombstone(existing) && existing.gen > gen) gen = existing.gen;

		if (tombstoneTtlMs <= 0) {
			// No tombstone requested — behave like forget.
			try {
				storage.removeItem(storageKey);
			} catch {
				/* ignore */
			}
			lastGen.delete(storageKey);
			return;
		}
		const tomb: TombstoneRecord = { tombstone: true, until: now + tombstoneTtlMs, gen };
		writeRaw(storage, storageKey, tomb);
		// Keep gen tracked so a resurrecting save would need to exceed it.
		lastGen.set(storageKey, gen);
	}

	function forget(scopeKey: string): void {
		const storage = resolveStorage(backend);
		if (!storage) return;
		const storageKey = storageKeyFor(scopeKey);
		try {
			storage.removeItem(storageKey);
		} catch {
			/* ignore */
		}
		lastGen.delete(storageKey);
	}

	return { load, save, clear, forget };
}

/** Compute UTF-8 byte length without allocating a TextEncoder per call where possible. */
const _sharedEncoder: TextEncoder | null = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
function utf8ByteLength(s: string): number {
	if (_sharedEncoder) return _sharedEncoder.encode(s).length;
	// Fallback: manual UTF-8 byte count.
	let bytes = 0;
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			// High surrogate — pair forms a 4-byte sequence.
			bytes += 4;
			i++; // skip the low surrogate
		} else bytes += 3;
	}
	return bytes;
}

const _warnedNamespaces = new Set<string>();
function warnOversizeOnce(namespace: string): void {
	if (_warnedNamespaces.has(namespace)) return;
	_warnedNamespaces.add(namespace);
	try {
		// eslint-disable-next-line no-console
		console.warn(
			`[transient-draft-store] dropped an oversize draft in namespace "${namespace}" (exceeds maxEntryBytes). ` +
				`This draft is too large for the synchronous draft tier — use IndexedDB or the server draft table instead.`,
		);
	} catch {
		/* ignore */
	}
}
