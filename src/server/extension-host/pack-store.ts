// src/server/extension-host/pack-store.ts
//
// Slice B1 — file-backed, pack-namespaced KV persistence behind `host.store.*`
// (design docs/design/extension-host-phase2.md §3). One file per key under
// `<stateDir>/ext-store/<packId>/<encodeKey(key)>.json`.
//
// SECURITY MODEL (the cross-pack-read rejection, design §3 B1.1):
//   - The on-disk path is ALWAYS `join(root, "ext-store", packId, encodeKey(key))`.
//     `packId` comes from the SERVER-DERIVED pack identity (pack-identity.ts), never
//     from request input — so a pack physically cannot form a path outside its own
//     `packId` dir. A second pack reading the first pack's key is impossible because
//     it can only ever name its OWN packId.
//   - `encodeKey` percent-encodes EVERY non-alphanumeric byte, so an arbitrary key
//     string can never contain a path separator, `..`, or a filesystem-illegal char
//     — key traversal is structurally impossible. We additionally re-validate the
//     resolved absolute path stays within the `<packId>` dir (defense-in-depth,
//     mirroring action-dispatcher.ts:resolveModulePath / the renderer endpoint).
//   - Empty `packId` (a non-pack / builtin caller) is REJECTED: `store` is pack-only.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { bobbitStateDir } from "../bobbit-dir.js";
import type { StoreMutationDiagnostic, StoreMutationOptions, StoreMutationResult, StorePutOptions, StoreQuotaProfile, StoreReadDiagnostic, StoreReadResult, StoreStats } from "../../shared/extension-host/host-api.js";

export interface PackStore {
	/** Legacy, lossy read. Prefer `read` where an unreadable value must not be absent. */
	get<T = unknown>(packId: string, key: string): Promise<T | null>;
	/** Lossless durable read: only a proven ENOENT is absent. */
	read<T = unknown>(packId: string, key: string): Promise<StoreReadResult<T>>;
	put<T = unknown>(packId: string, key: string, value: T, opts?: StorePutOptions): Promise<void>;
	/** Fenced mutation with a durable version and optional immediate idempotency replay. */
	mutate<T = unknown>(packId: string, key: string, value: T, opts?: StoreMutationOptions): Promise<StoreMutationResult<T>>;
	list(packId: string, prefix?: string): Promise<string[]>;
	delete(packId: string, key: string): Promise<boolean>;
	deletePrefix(packId: string, prefix: string): Promise<number>;
	stats(packId: string, prefix?: string): Promise<StoreStats>;
	/** Legacy, lossy synchronous read. Prefer `readSync` for durable state. */
	getSync<T = unknown>(packId: string, key: string): T | null;
	/** Synchronous equivalent of `read`, used by synchronous activation paths. */
	readSync<T = unknown>(packId: string, key: string): StoreReadResult<T>;
}

/** Per-pack persistence quotas (Fix C). Enforced in `put` with a clear rejection
 *  BEFORE any write, so a pack cannot exhaust gateway disk. Defaults are generous
 *  for legitimate UI state but bound a runaway/malicious pack. */
export interface PackStoreQuotaProfile {
	/** Max cumulative bytes for keys under a caller-selected, server-owned scope prefix. */
	maxTotalBytes: number;
}

export interface PackStoreQuota {
	/** Max serialized bytes for a SINGLE value's on-disk envelope. */
	maxValueBytes: number;
	/** Max number of distinct keys a pack may hold. */
	maxKeys: number;
	/** Max cumulative on-disk bytes across ALL of a pack's keys for unscoped writes. */
	maxTotalBytes: number;
	/** Absolute per-pack on-disk ceiling that also applies to scoped writes. */
	maxTotalBytesEmergency: number;
	/** Server-owned scoped quota profiles. Callers select by name; they never set limits. */
	profiles: Record<StoreQuotaProfile, PackStoreQuotaProfile>;
}

export const DEFAULT_PACK_STORE_QUOTA: PackStoreQuota = {
	// First-party viewer state (for example synthesized PR walkthrough cards with
	// mapped diff context) can legitimately be multiple MiB. Keep per-pack total
	// bytes as the disk-exhaustion bound while allowing one large persisted view.
	maxValueBytes: 4 * 1024 * 1024, // 4 MiB per value
	maxKeys: 1000,
	maxTotalBytes: 5 * 1024 * 1024, // 5 MiB per pack for legacy/unscoped writes
	maxTotalBytesEmergency: 256 * 1024 * 1024, // absolute per-pack ceiling
	profiles: {
		default: { maxTotalBytes: 5 * 1024 * 1024 },
		"review-draft": { maxTotalBytes: 5 * 1024 * 1024 },
		"review-final": { maxTotalBytes: 5 * 1024 * 1024 },
	},
};

/** Thrown when a `put` would exceed a {@link PackStoreQuota}. The endpoint maps it
 *  to a 4xx with `.message` so the pack sees a clear reason. */
export class PackStoreQuotaError extends Error {
	readonly code: string;
	readonly details?: Record<string, unknown>;
	constructor(message: string, code = "STORE_QUOTA_EXCEEDED", details?: Record<string, unknown>) {
		super(message);
		this.name = "PackStoreQuotaError";
		this.code = code;
		this.details = details;
	}
}

/** Thrown when a store op exceeds its wall-time bound (design §3 B1.2 — bound the
 *  blast radius of a stuck/slow store backend so it cannot hold a request open
 *  indefinitely). The endpoint maps it to a 5xx. */
export class PackStoreTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PackStoreTimeoutError";
	}
}

/** Default per-op wall-time for `host.store.*` (design §3 B1.2). */
export const DEFAULT_STORE_OP_TIMEOUT_MS = 10_000;

/**
 * Race a store op against a wall-time bound, rejecting with {@link
 * PackStoreTimeoutError} on expiry (consistent with the dispatcher's
 * terminate-on-timeout pattern). A hung backend therefore cannot hold the
 * `/api/ext/store/:op` request open outside the blast-radius control the design
 * (B1.2) specifies. The timer is `unref`'d so it never keeps the process alive.
 */
export function withStoreTimeout<T>(op: Promise<T>, ms: number = DEFAULT_STORE_OP_TIMEOUT_MS, label = "store op"): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
			reject(new PackStoreTimeoutError(`${label} timed out after ${ms}ms`));
		}, ms);
		(timer as { unref?: () => void }).unref?.();
		op.then(
			(v) => { clearTimeout(timer); resolve(v); },
			(e) => { clearTimeout(timer); reject(e); },
		);
	});
}

/** Serialized on-disk envelope. `v` is a forward-compat version tag. */
interface StoreEnvelope<T = unknown> {
	v: 1;
	value: T;
	/** Optional so legacy `put` envelopes retain their exact on-disk compatibility. */
	revision?: number;
	/** Last fenced mutation marker. It makes a retry replay without a second commit. */
	mutation?: { idempotencyKey: string };
}

/**
 * Percent-encode EVERY byte that is not `[A-Za-z0-9]`, fully reversible and
 * filesystem-safe on every platform (no `/`, `\`, `..`, `*`, `:`, trailing dots).
 * The result is always a single path segment, so no key can ever traverse.
 */
function encodeKey(key: string): string {
	const bytes = Buffer.from(key, "utf8");
	let out = "";
	for (const b of bytes) {
		const isAlnum =
			(b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
		out += isAlnum ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/** Inverse of `encodeKey` — decode a stored filename (sans `.json`) back to a key. */
function decodeKey(name: string): string {
	const bytes: number[] = [];
	for (let i = 0; i < name.length; i++) {
		if (name[i] === "%") {
			const hex = name.slice(i + 1, i + 3);
			const code = Number.parseInt(hex, 16);
			if (Number.isNaN(code)) return name; // not our encoding — return verbatim
			bytes.push(code);
			i += 2;
		} else {
			bytes.push(name.charCodeAt(i));
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

/** Reject an empty / non-pack packId or one carrying path-structural characters. */
function assertPackId(packId: string): void {
	if (typeof packId !== "string" || packId.length === 0) {
		throw new Error("store requires a pack identity (non-pack caller rejected)");
	}
	if (packId.includes("/") || packId.includes("\\") || packId === "." || packId === "..") {
		throw new Error("invalid pack identity");
	}
}

function assertKey(key: string): void {
	if (typeof key !== "string" || key.length === 0) {
		throw new Error("store key must be a non-empty string");
	}
}

function assertPrefix(prefix: string): void {
	if (typeof prefix !== "string") {
		throw new Error("store prefix must be a string");
	}
}

export type PackStoreQuotaOptions = Partial<Omit<PackStoreQuota, "profiles">> & {
	profiles?: Partial<Record<StoreQuotaProfile, Partial<PackStoreQuotaProfile>>>;
};

const STORE_QUOTA_PROFILES = new Set<StoreQuotaProfile>(["default", "review-draft", "review-final"]);

function isStoreQuotaProfile(value: unknown): value is StoreQuotaProfile {
	return typeof value === "string" && STORE_QUOTA_PROFILES.has(value as StoreQuotaProfile);
}

function normalizeQuota(input?: PackStoreQuotaOptions): PackStoreQuota {
	return {
		...DEFAULT_PACK_STORE_QUOTA,
		...input,
		profiles: {
			default: { ...DEFAULT_PACK_STORE_QUOTA.profiles.default, ...input?.profiles?.default },
			"review-draft": { ...DEFAULT_PACK_STORE_QUOTA.profiles["review-draft"], ...input?.profiles?.["review-draft"] },
			"review-final": { ...DEFAULT_PACK_STORE_QUOTA.profiles["review-final"], ...input?.profiles?.["review-final"] },
		},
	};
}

function normalizeQuotaScope(key: string, opts?: StorePutOptions): { prefix: string; profile: StoreQuotaProfile } | undefined {
	const scope = opts?.quotaScope;
	if (scope === undefined) return undefined;
	if (!scope || typeof scope !== "object" || typeof scope.prefix !== "string" || scope.prefix.length === 0) {
		throw new PackStoreQuotaError("store quota scope prefix must be a non-empty string", "STORE_QUOTA_SCOPE_INVALID");
	}
	if (!key.startsWith(scope.prefix)) {
		throw new PackStoreQuotaError(
			`store quota scope prefix must match the written key: ${JSON.stringify(scope.prefix)} is not a prefix of ${JSON.stringify(key)}`,
			"STORE_QUOTA_SCOPE_INVALID",
			{ prefix: scope.prefix, key },
		);
	}
	const profile = scope.profile ?? "default";
	if (!isStoreQuotaProfile(profile)) {
		throw new PackStoreQuotaError(`unknown store quota profile: ${String(profile)}`, "STORE_QUOTA_PROFILE_INVALID", { profile });
	}
	return { prefix: scope.prefix, profile };
}

/**
 * Per-pack async mutex — serializes the read-tally-then-write critical section of
 * `put` so concurrent puts to the SAME pack cannot RACE the quota check (each
 * reads the pre-write key-count/byte-total, all pass, then all write → the pack
 * collectively blows past `maxKeys`/`maxTotalBytes`). Each new section chains
 * after the prior one settles (success OR failure); the map entry is dropped once
 * the chain drains so the table never grows unbounded.
 */
function makePackMutex() {
	const tails = new Map<string, Promise<unknown>>();
	return function withPackLock<T>(packId: string, fn: () => Promise<T>): Promise<T> {
		const prev = (tails.get(packId) ?? Promise.resolve()).then(
			() => {},
			() => {},
		);
		const run = prev.then(fn);
		const settled = run.then(
			() => {},
			() => {},
		);
		tails.set(packId, settled);
		void settled.then(() => {
			if (tails.get(packId) === settled) tails.delete(packId);
		});
		return run;
	};
}

function isTransientWindowsReplaceError(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

const replaceDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type CommitFence = () => StoreMutationDiagnostic | undefined;

/** A closed fence is control flow, not a write failure: callers report its stable diagnostic. */
class CommitFenceClosedError extends Error {
	constructor(readonly diagnostic: StoreMutationDiagnostic) {
		super(diagnostic.code);
	}
}

function checkCommitFence(fence?: CommitFence): void {
	const diagnostic = fence?.();
	if (diagnostic) throw new CommitFenceClosedError(diagnostic);
}

/**
 * Best-effort atomic replace with a Windows-safe fallback. POSIX `rename(tmp, file)`
 * atomically replaces an existing file; on Windows it can transiently fail with
 * EPERM/EACCES/EBUSY when the destination exists or a scanner briefly touches it.
 *
 * A fallback never deletes the old value. It moves it to a unique same-directory
 * backup, publishes the temp, then removes the backup. If publication or a commit
 * fence fails, the backup is restored. Fenced callers also re-check after every
 * retry delay and immediately before each destructive/publish operation.
 */
async function replaceFileWithTemp(tmpFile: string, file: string, fence?: CommitFence): Promise<void> {
	checkCommitFence(fence);
	try {
		await fs.promises.rename(tmpFile, file);
		return;
	} catch (err) {
		if (err instanceof CommitFenceClosedError || !isTransientWindowsReplaceError(err)) throw err;
	}

	let lastErr: unknown;
	for (let attempt = 0; attempt < 5; attempt++) {
		if (attempt > 0) {
			await replaceDelay(10 * attempt);
			checkCommitFence(fence);
		}
		const backup = `${file}.${process.pid}.${crypto.randomUUID()}.bak`;
		let movedOriginal = false;
		try {
			// Move, rather than remove, the prior value so a failed or aborted publish
			// can always restore it without exposing an empty key.
			checkCommitFence(fence);
			try {
				await fs.promises.rename(file, backup);
				movedOriginal = true;
			} catch (err) {
				if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw err;
			}
			checkCommitFence(fence);
			await fs.promises.rename(tmpFile, file);
			checkCommitFence(fence);
			if (movedOriginal) await fs.promises.rm(backup, { force: true });
			return;
		} catch (err) {
			// Restore before considering a retry or surfacing the fence. Recovery is
			// deliberately unfenced: preserving the old durable value wins once a
			// destructive move has started.
			if (movedOriginal) {
				await fs.promises.rm(file, { force: true }).catch(() => {});
				await fs.promises.rename(backup, file).catch(() => {});
			}
			if (err instanceof CommitFenceClosedError) throw err;
			lastErr = err;
			if (!isTransientWindowsReplaceError(err)) throw err;
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Create a file-backed pack store. `rootDir` defaults to `bobbitStateDir()`; all
 * keys for a pack live under `<rootDir>/ext-store/<packId>/`.
 */
export function createPackStore(opts?: { rootDir?: string; quota?: PackStoreQuotaOptions }): PackStore {
	const baseDir = () => path.join(opts?.rootDir ?? bobbitStateDir(), "ext-store");
	const quota: PackStoreQuota = normalizeQuota(opts?.quota);
	// One mutex per store instance — serializes each pack's `put` critical section.
	const withPackLock = makePackMutex();

	/** Resolve + re-validate the absolute file path for (packId, key). */
	const resolveFile = (packId: string, key: string): { dir: string; file: string } => {
		assertPackId(packId);
		assertKey(key);
		const dir = path.resolve(path.join(baseDir(), packId));
		const file = path.resolve(path.join(dir, `${encodeKey(key)}.json`));
		// Defense-in-depth: the resolved file MUST stay within the packId dir.
		if (file !== dir && !file.startsWith(dir + path.sep)) {
			throw new Error("resolved store path escapes the pack directory");
		}
		return { dir, file };
	};

	interface KeyFileStat { name: string; key: string; file: string; bytes: number }

	const readKeyFileStats = async (dir: string, prefix?: string): Promise<KeyFileStat[]> => {
		let names: string[];
		try {
			names = await fs.promises.readdir(dir);
		} catch {
			return [];
		}
		const out: KeyFileStat[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const key = decodeKey(name.slice(0, -".json".length));
			if (prefix !== undefined && !key.startsWith(prefix)) continue;
			const file = path.join(dir, name);
			let bytes = 0;
			try {
				bytes = (await fs.promises.stat(file)).size;
			} catch {
				bytes = 0;
			}
			out.push({ name, key, file, bytes });
		}
		return out;
	};

	const sumStats = (entries: KeyFileStat[]): StoreStats => ({
		keys: entries.length,
		bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
	});

	const isValidRevision = (revision: unknown): revision is number =>
		typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0;

	const mutationDiagnostic = (code: StoreMutationDiagnostic["code"], retryable: boolean): StoreMutationDiagnostic => ({ code, retryable });

	/** `mutate` checks the same host-owned budget before entering and immediately before rename. */
	const mutationBudgetDiagnostic = (opts: StoreMutationOptions): StoreMutationDiagnostic | undefined => {
		if (opts.signal?.aborted) return mutationDiagnostic("STORE_MUTATION_ABORTED", false);
		if (opts.deadlineEpochMs !== undefined && Date.now() >= opts.deadlineEpochMs) {
			return mutationDiagnostic("STORE_MUTATION_DEADLINE_EXCEEDED", true);
		}
		return undefined;
	};

	/**
	 * Each key has exactly one recovery slot. It intentionally lacks the `.json`
	 * suffix so lists and quota tallies ignore it. A stable name bounds recovery
	 * files and, unlike timestamp sidecars, refuses to overwrite earlier evidence.
	 */
	const quarantineFile = (file: string): string => `${file}.corrupt`;

	const corruptDiagnostic = (quarantined: boolean): StoreReadDiagnostic => ({
		code: "STORE_READ_CORRUPT",
		retryable: false,
		...(quarantined ? { quarantined: true } : {}),
	});

	const quarantineFullDiagnostic = (): StoreReadDiagnostic => ({
		code: "STORE_READ_CORRUPT_QUARANTINE_FULL",
		retryable: false,
	});

	/**
	 * Move corrupt data to the bounded recovery slot without replacing prior
	 * evidence. `link` creates the slot atomically and fails if it already exists;
	 * unlinking the primary afterwards may briefly leave two names for the same
	 * data, but can never destroy either one.
	 */
	const quarantineCorrupt = async (file: string, raw: string): Promise<StoreReadDiagnostic> => {
		const dest = quarantineFile(file);
		try {
			await fs.promises.link(file, dest);
		} catch (err) {
			if ((err as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") return corruptDiagnostic(false);

			// A prior synchronous read intentionally retains the primary to avoid an
			// unlink TOCTOU race, but it may already have captured these exact corrupt
			// bytes in the single recovery slot. Under the async pack lock, that
			// identical evidence makes removing the still-corrupt primary safe.
			let quarantinedRaw: string;
			try {
				quarantinedRaw = await fs.promises.readFile(dest, "utf8");
			} catch {
				return quarantineFullDiagnostic();
			}
			if (quarantinedRaw !== raw) return quarantineFullDiagnostic();
			try {
				await fs.promises.unlink(file);
				return corruptDiagnostic(true);
			} catch {
				return corruptDiagnostic(false);
			}
		}
		try {
			await fs.promises.unlink(file);
			return corruptDiagnostic(true);
		} catch {
			return corruptDiagnostic(false);
		}
	};

	const quarantineCorruptSync = (file: string, raw: string): StoreReadDiagnostic => {
		const dest = quarantineFile(file);
		try {
			fs.linkSync(file, dest);
		} catch (err) {
			if ((err as NodeJS.ErrnoException | undefined)?.code === "EEXIST") return quarantineFullDiagnostic();
			return corruptDiagnostic(false);
		}
		try {
			// `readSync` cannot take the async pack lock. A concurrent atomic put can
			// replace the pathname after we read corrupt bytes but before this link.
			// If the link captured that replacement, remove only the duplicate
			// recovery link. Crucially, sync recovery must never unlink the primary:
			// it could be replaced immediately after this comparison.
			if (fs.readFileSync(dest, "utf8") !== raw) {
				fs.unlinkSync(dest);
				return corruptDiagnostic(false);
			}
		} catch {
			return corruptDiagnostic(false);
		}
		// Unlike async recovery, retain the live pathname. There is no synchronous
		// lock shared with `put`, so path-unlinking it would have a TOCTOU window
		// that can delete a concurrent atomic replacement. The hardlink above is
		// bounded evidence; a subsequent put replaces the corrupt primary safely.
		return corruptDiagnostic(false);
	};

	return {
		async get<T = unknown>(packId: string, key: string): Promise<T | null> {
			const result = await this.read<T>(packId, key);
			return result.state === "present" ? result.value : null;
		},

		async read<T = unknown>(packId: string, key: string): Promise<StoreReadResult<T>> {
			const { file } = resolveFile(packId, key);
			// Recovery moves must not race a same-pack put or another recovery.
			return withPackLock(packId, async () => {
				let raw: string;
				try {
					raw = await fs.promises.readFile(file, "utf8");
				} catch (err) {
					if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { state: "absent" };
					return { state: "error", diagnostic: { code: "STORE_READ_IO", retryable: true } };
				}

				let env: StoreEnvelope<T>;
				try {
					env = JSON.parse(raw) as StoreEnvelope<T>;
				} catch {
					return { state: "error", diagnostic: await quarantineCorrupt(file, raw) };
				}
				if (!env || typeof env !== "object" || Array.isArray(env) || !("v" in env)) {
					return { state: "error", diagnostic: await quarantineCorrupt(file, raw) };
				}
				// Unknown versions are intentionally preserved for a newer host to read.
				if (env.v !== 1) {
					return { state: "error", diagnostic: { code: "STORE_READ_UNSUPPORTED_VERSION", retryable: false } };
				}
				if (!Object.prototype.hasOwnProperty.call(env, "value") || (env.revision !== undefined && !isValidRevision(env.revision))) {
					return { state: "error", diagnostic: await quarantineCorrupt(file, raw) };
				}
				return env.revision === undefined
					? { state: "present", value: env.value }
					: { state: "present", value: env.value, version: env.revision };
			});
		},

		async put<T = unknown>(packId: string, key: string, value: T, opts?: StorePutOptions): Promise<void> {
			const { dir, file } = resolveFile(packId, key);
			const scope = normalizeQuotaScope(key, opts);

			// SERIALIZE the tally→quota→write/delete critical section PER PACK: without it,
			// concurrent mutations can pass a stale quota check or race prefix cleanup.
			await withPackLock(packId, async () => {
				const entries = await readKeyFileStats(dir);
				const existingStats = sumStats(entries);
				const existing = entries.find((entry) => entry.file === file);
				const keyExists = existing !== undefined;
				const overwriteBytes = existing?.bytes ?? 0;

				// A legacy put remains unconditionally writable, but it cannot reset a
				// version established by mutate. This keeps mixed put/mutate callers
				// monotonic without changing unversioned on-disk envelopes.
				let priorRevision: number | undefined;
				if (keyExists) {
					try {
						const parsed = JSON.parse(await fs.promises.readFile(file, "utf8")) as StoreEnvelope<T>;
						if (isValidRevision(parsed?.revision)) priorRevision = parsed.revision;
					} catch { /* a legacy put may replace unreadable data */ }
				}
				const env: StoreEnvelope<T> = {
					v: 1,
					value,
					...(priorRevision === undefined ? {} : { revision: priorRevision + 1 }),
				};
				const serialized = JSON.stringify(env);
				const newBytes = Buffer.byteLength(serialized, "utf8");
				if (newBytes > quota.maxValueBytes) {
					throw new PackStoreQuotaError(
						`store value too large: ${newBytes} bytes exceeds the ${quota.maxValueBytes}-byte per-value limit`,
						"STORE_QUOTA_EXCEEDED",
						{ bytes: newBytes, limit: quota.maxValueBytes, dimension: "value" },
					);
				}

				if (!keyExists && existingStats.keys >= quota.maxKeys) {
					throw new PackStoreQuotaError(
						`store key limit reached: ${existingStats.keys} keys at the ${quota.maxKeys}-key per-pack limit`,
						"STORE_QUOTA_EXCEEDED",
						{ keys: existingStats.keys, limit: quota.maxKeys, dimension: "keys" },
					);
				}

				const projectedPackTotal = existingStats.bytes - overwriteBytes + newBytes;
				if (scope) {
					const profile = quota.profiles[scope.profile];
					const scopeStats = sumStats(entries.filter((entry) => entry.key.startsWith(scope.prefix)));
					const projectedScopeTotal = scopeStats.bytes - overwriteBytes + newBytes;
					if (projectedScopeTotal > profile.maxTotalBytes) {
						throw new PackStoreQuotaError(
							`store quota scope full: ${projectedScopeTotal} bytes would exceed the ${profile.maxTotalBytes}-byte ${scope.profile} limit for ${JSON.stringify(scope.prefix)}`,
							"STORE_QUOTA_EXCEEDED",
							{ bytes: projectedScopeTotal, limit: profile.maxTotalBytes, dimension: "scope", prefix: scope.prefix, profile: scope.profile },
						);
					}
					if (projectedPackTotal > quota.maxTotalBytesEmergency) {
						throw new PackStoreQuotaError(
							`store emergency limit reached: ${projectedPackTotal} bytes would exceed the ${quota.maxTotalBytesEmergency}-byte per-pack emergency limit`,
							"STORE_QUOTA_EXCEEDED",
							{ bytes: projectedPackTotal, limit: quota.maxTotalBytesEmergency, dimension: "emergency" },
						);
					}
				} else if (projectedPackTotal > quota.maxTotalBytes) {
					throw new PackStoreQuotaError(
						`store full: ${projectedPackTotal} bytes would exceed the ${quota.maxTotalBytes}-byte per-pack limit`,
						"STORE_QUOTA_EXCEEDED",
						{ bytes: projectedPackTotal, limit: quota.maxTotalBytes, dimension: "pack" },
					);
				}

				await fs.promises.mkdir(dir, { recursive: true });
				const tmpFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
				const handle = await fs.promises.open(tmpFile, "w");
				try {
					await handle.writeFile(serialized, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
				try {
					await replaceFileWithTemp(tmpFile, file);
				} catch (err) {
					await fs.promises.rm(tmpFile, { force: true }).catch(() => {});
					throw err;
				}
			});
		},

		async mutate<T = unknown>(packId: string, key: string, value: T, opts: StoreMutationOptions = {}): Promise<StoreMutationResult<T>> {
			let dir: string;
			let file: string;
			let scope: { prefix: string; profile: StoreQuotaProfile } | undefined;
			let valueSerialized: string;
			try {
				({ dir, file } = resolveFile(packId, key));
				scope = normalizeQuotaScope(key, opts);
				if (opts.expectedVersion !== undefined && opts.expectedVersion !== null
					&& (!Number.isSafeInteger(opts.expectedVersion) || opts.expectedVersion < 0)) {
					return { status: "rejected", committed: false, diagnostic: mutationDiagnostic("STORE_MUTATION_INVALID", false) };
				}
				if (opts.idempotencyKey !== undefined && (typeof opts.idempotencyKey !== "string" || opts.idempotencyKey.length === 0 || opts.idempotencyKey.length > 256)) {
					return { status: "rejected", committed: false, diagnostic: mutationDiagnostic("STORE_MUTATION_INVALID", false) };
				}
				if (opts.deadlineEpochMs !== undefined && !Number.isFinite(opts.deadlineEpochMs)) {
					return { status: "rejected", committed: false, diagnostic: mutationDiagnostic("STORE_MUTATION_INVALID", false) };
				}
				const encoded = JSON.stringify(value);
				if (encoded === undefined) return { status: "rejected", committed: false, diagnostic: mutationDiagnostic("STORE_MUTATION_INVALID", false) };
				valueSerialized = encoded;
			} catch (err) {
				return { status: "rejected", committed: false, diagnostic: mutationDiagnostic(err instanceof PackStoreQuotaError ? "STORE_MUTATION_QUOTA_EXCEEDED" : "STORE_MUTATION_INVALID", false) };
			}

			const beforeLock = mutationBudgetDiagnostic(opts);
			if (beforeLock) return { status: "aborted", committed: false, diagnostic: beforeLock };

			try {
				return await withPackLock(packId, async (): Promise<StoreMutationResult<T>> => {
					const beforePreflight = mutationBudgetDiagnostic(opts);
					if (beforePreflight) return { status: "aborted", committed: false, diagnostic: beforePreflight };

					let existing: StoreEnvelope<T> | undefined;
					try {
						const raw = await fs.promises.readFile(file, "utf8");
						const parsed = JSON.parse(raw) as StoreEnvelope<T>;
						if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.v !== 1
							|| !Object.prototype.hasOwnProperty.call(parsed, "value")
							|| (parsed.revision !== undefined && !isValidRevision(parsed.revision))) {
							return { status: "error", committed: false, diagnostic: mutationDiagnostic("STORE_MUTATION_READ_FAILED", false) };
						}
						existing = parsed;
					} catch (err) {
						if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
							return { status: "error", committed: false, diagnostic: mutationDiagnostic("STORE_MUTATION_READ_FAILED", true) };
						}
					}

					const currentVersion = existing?.revision ?? 0;
					if (opts.idempotencyKey !== undefined && existing?.mutation?.idempotencyKey === opts.idempotencyKey) {
						if (JSON.stringify(existing.value) !== valueSerialized) {
							return { status: "conflict", committed: false, diagnostic: mutationDiagnostic("STORE_MUTATION_IDEMPOTENCY_MISMATCH", false) };
						}
						return { status: "replayed", committed: false, value: existing.value, version: currentVersion };
					}
					if (opts.expectedVersion === null ? existing !== undefined : opts.expectedVersion !== undefined && opts.expectedVersion !== currentVersion) {
						// A create-if-absent conflict cannot become valid by retrying the
						// identical request; version contention may.
						return { status: "conflict", committed: false, diagnostic: mutationDiagnostic("STORE_MUTATION_EXPECTED_VERSION_CONFLICT", opts.expectedVersion !== null) };
					}

					const nextVersion = currentVersion + 1;
					const env: StoreEnvelope<T> = {
						v: 1,
						value,
						revision: nextVersion,
						...(opts.idempotencyKey === undefined ? {} : { mutation: { idempotencyKey: opts.idempotencyKey } }),
					};
					const serialized = JSON.stringify(env);
					const newBytes = Buffer.byteLength(serialized, "utf8");
					if (newBytes > quota.maxValueBytes) return { status: "rejected", committed: false, diagnostic: mutationDiagnostic("STORE_MUTATION_QUOTA_EXCEEDED", false) };

					const entries = await readKeyFileStats(dir);
					const existingStats = sumStats(entries);
					const existingEntry = entries.find((entry) => entry.file === file);
					const overwriteBytes = existingEntry?.bytes ?? 0;
					if (!existingEntry && existingStats.keys >= quota.maxKeys) return { status: "rejected", committed: false, diagnostic: mutationDiagnostic("STORE_MUTATION_QUOTA_EXCEEDED", false) };
					const projectedPackTotal = existingStats.bytes - overwriteBytes + newBytes;
					if (scope) {
						const projectedScopeTotal = sumStats(entries.filter((entry) => entry.key.startsWith(scope.prefix))).bytes - overwriteBytes + newBytes;
						if (projectedScopeTotal > quota.profiles[scope.profile].maxTotalBytes || projectedPackTotal > quota.maxTotalBytesEmergency) return { status: "rejected", committed: false, diagnostic: mutationDiagnostic("STORE_MUTATION_QUOTA_EXCEEDED", false) };
					} else if (projectedPackTotal > quota.maxTotalBytes) {
						return { status: "rejected", committed: false, diagnostic: mutationDiagnostic("STORE_MUTATION_QUOTA_EXCEEDED", false) };
					}

					const beforeWrite = mutationBudgetDiagnostic(opts);
					if (beforeWrite) return { status: "aborted", committed: false, diagnostic: beforeWrite };
					let tmpFile: string | undefined;
					try {
						await fs.promises.mkdir(dir, { recursive: true });
						tmpFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
						const handle = await fs.promises.open(tmpFile, "w");
						try {
							await handle.writeFile(serialized, "utf8");
							await handle.sync();
						} finally {
							await handle.close();
						}
						const beforeCommit = mutationBudgetDiagnostic(opts);
						if (beforeCommit) {
							await fs.promises.rm(tmpFile, { force: true }).catch(() => {});
							return { status: "aborted", committed: false, diagnostic: beforeCommit };
						}
						await replaceFileWithTemp(tmpFile, file, () => mutationBudgetDiagnostic(opts));
						return { status: "committed", committed: true, value, version: nextVersion };
					} catch (err) {
						if (tmpFile) await fs.promises.rm(tmpFile, { force: true }).catch(() => {});
						if (err instanceof CommitFenceClosedError) {
							return { status: "aborted", committed: false, diagnostic: err.diagnostic };
						}
						return { status: "error", committed: false, diagnostic: mutationDiagnostic("STORE_MUTATION_WRITE_FAILED", true) };
					}
				});
			} catch {
				return { status: "error", committed: false, diagnostic: mutationDiagnostic("STORE_MUTATION_WRITE_FAILED", true) };
			}
		},

		getSync<T = unknown>(packId: string, key: string): T | null {
			try {
				const result = this.readSync<T>(packId, key);
				return result.state === "present" ? result.value : null;
			} catch {
				// Preserve the legacy getSync contract for invalid pack/key inputs.
				return null;
			}
		},

		readSync<T = unknown>(packId: string, key: string): StoreReadResult<T> {
			const { file } = resolveFile(packId, key);
			let raw: string;
			try {
				raw = fs.readFileSync(file, "utf8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { state: "absent" };
				return { state: "error", diagnostic: { code: "STORE_READ_IO", retryable: true } };
			}

			let env: StoreEnvelope<T>;
			try {
				env = JSON.parse(raw) as StoreEnvelope<T>;
			} catch {
				return { state: "error", diagnostic: quarantineCorruptSync(file, raw) };
			}
			if (!env || typeof env !== "object" || Array.isArray(env) || !("v" in env)) {
				return { state: "error", diagnostic: quarantineCorruptSync(file, raw) };
			}
			if (env.v !== 1) {
				return { state: "error", diagnostic: { code: "STORE_READ_UNSUPPORTED_VERSION", retryable: false } };
			}
			if (!Object.prototype.hasOwnProperty.call(env, "value") || (env.revision !== undefined && !isValidRevision(env.revision))) {
				return { state: "error", diagnostic: quarantineCorruptSync(file, raw) };
			}
			return env.revision === undefined
				? { state: "present", value: env.value }
				: { state: "present", value: env.value, version: env.revision };
		},

		async list(packId: string, prefix?: string): Promise<string[]> {
			assertPackId(packId);
			if (prefix !== undefined) assertPrefix(prefix);
			const dir = path.resolve(path.join(baseDir(), packId));
			const out = (await readKeyFileStats(dir, prefix)).map((entry) => entry.key);
			out.sort();
			return out;
		},

		async delete(packId: string, key: string): Promise<boolean> {
			const { file } = resolveFile(packId, key);
			return withPackLock(packId, async () => {
				try {
					await fs.promises.unlink(file);
					return true;
				} catch (err) {
					if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return false;
					throw err;
				}
			});
		},

		async deletePrefix(packId: string, prefix: string): Promise<number> {
			assertPackId(packId);
			assertPrefix(prefix);
			const dir = path.resolve(path.join(baseDir(), packId));
			return withPackLock(packId, async () => {
				const entries = await readKeyFileStats(dir, prefix);
				let deleted = 0;
				for (const entry of entries) {
					try {
						await fs.promises.unlink(entry.file);
						deleted++;
					} catch (err) {
						if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw err;
					}
				}
				return deleted;
			});
		},

		async stats(packId: string, prefix?: string): Promise<StoreStats> {
			assertPackId(packId);
			if (prefix !== undefined) assertPrefix(prefix);
			const dir = path.resolve(path.join(baseDir(), packId));
			return withPackLock(packId, async () => sumStats(await readKeyFileStats(dir, prefix)));
		},
	};
}

// Process-singleton — ONE PackStore for the gateway lifetime (design §3 B1.3).
// Warmed near `actionDispatcher` in server.ts and reused by both the
// `/api/ext/store/:op` endpoint and `ctx.host.store`.
let _singleton: PackStore | undefined;
export function getPackStore(): PackStore {
	if (!_singleton) _singleton = createPackStore();
	return _singleton;
}
