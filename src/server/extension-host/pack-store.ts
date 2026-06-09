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
import { bobbitStateDir } from "../bobbit-dir.js";

export interface PackStore {
	get<T = unknown>(packId: string, key: string): Promise<T | null>;
	put<T = unknown>(packId: string, key: string, value: T): Promise<void>;
	list(packId: string, prefix?: string): Promise<string[]>;
}

/** Per-pack persistence quotas (Fix C). Enforced in `put` with a clear rejection
 *  BEFORE any write, so a pack cannot exhaust gateway disk. Defaults are generous
 *  for legitimate UI state but bound a runaway/malicious pack. */
export interface PackStoreQuota {
	/** Max serialized bytes for a SINGLE value's on-disk envelope. */
	maxValueBytes: number;
	/** Max number of distinct keys a pack may hold. */
	maxKeys: number;
	/** Max cumulative on-disk bytes across ALL of a pack's keys. */
	maxTotalBytes: number;
}

export const DEFAULT_PACK_STORE_QUOTA: PackStoreQuota = {
	maxValueBytes: 256 * 1024, // 256 KiB per value
	maxKeys: 1000,
	maxTotalBytes: 5 * 1024 * 1024, // 5 MiB per pack
};

/** Thrown when a `put` would exceed a {@link PackStoreQuota}. The endpoint maps it
 *  to a 4xx with `.message` so the pack sees a clear reason. */
export class PackStoreQuotaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PackStoreQuotaError";
	}
}

/** Serialized on-disk envelope. `v` is a forward-compat version tag. */
interface StoreEnvelope<T = unknown> {
	v: 1;
	value: T;
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

/**
 * Create a file-backed pack store. `rootDir` defaults to `bobbitStateDir()`; all
 * keys for a pack live under `<rootDir>/ext-store/<packId>/`.
 */
export function createPackStore(opts?: { rootDir?: string; quota?: Partial<PackStoreQuota> }): PackStore {
	const baseDir = () => path.join(opts?.rootDir ?? bobbitStateDir(), "ext-store");
	const quota: PackStoreQuota = { ...DEFAULT_PACK_STORE_QUOTA, ...opts?.quota };

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

	return {
		async get<T = unknown>(packId: string, key: string): Promise<T | null> {
			const { file } = resolveFile(packId, key);
			let raw: string;
			try {
				raw = await fs.promises.readFile(file, "utf8");
			} catch {
				return null; // missing file
			}
			try {
				const env = JSON.parse(raw) as StoreEnvelope<T>;
				if (!env || typeof env !== "object" || !("value" in env)) return null;
				return env.value;
			} catch {
				return null; // corrupt/parse failure
			}
		},

		async put<T = unknown>(packId: string, key: string, value: T): Promise<void> {
			const { dir, file } = resolveFile(packId, key);
			const env: StoreEnvelope<T> = { v: 1, value };
			const serialized = JSON.stringify(env);
			const newBytes = Buffer.byteLength(serialized, "utf8");

			// QUOTA 1 — reject an oversized single value BEFORE writing anything.
			if (newBytes > quota.maxValueBytes) {
				throw new PackStoreQuotaError(
					`store value too large: ${newBytes} bytes exceeds the ${quota.maxValueBytes}-byte per-value limit`,
				);
			}

			// Tally the pack's current keys + cumulative bytes (the file being
			// overwritten is excluded from both the key count and the byte total).
			let existingKeyCount = 0;
			let existingTotalBytes = 0;
			let overwriteBytes = 0;
			let keyExists = false;
			let names: string[] = [];
			try {
				names = await fs.promises.readdir(dir);
			} catch {
				names = []; // no dir yet
			}
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				existingKeyCount++;
				let size = 0;
				try {
					size = (await fs.promises.stat(path.join(dir, name))).size;
				} catch {
					size = 0;
				}
				existingTotalBytes += size;
				if (path.join(dir, name) === file) {
					keyExists = true;
					overwriteBytes = size;
				}
			}

			// QUOTA 2 — reject a NEW key that would exceed the per-pack key count.
			if (!keyExists && existingKeyCount >= quota.maxKeys) {
				throw new PackStoreQuotaError(
					`store key limit reached: ${existingKeyCount} keys at the ${quota.maxKeys}-key per-pack limit`,
				);
			}

			// QUOTA 3 — reject a write that would exceed the per-pack cumulative bytes
			// (subtract the overwritten key's old size; add the new value's size).
			const projectedTotal = existingTotalBytes - overwriteBytes + newBytes;
			if (projectedTotal > quota.maxTotalBytes) {
				throw new PackStoreQuotaError(
					`store full: ${projectedTotal} bytes would exceed the ${quota.maxTotalBytes}-byte per-pack limit`,
				);
			}

			await fs.promises.mkdir(dir, { recursive: true });
			await fs.promises.writeFile(file, serialized, "utf8");
		},

		async list(packId: string, prefix?: string): Promise<string[]> {
			assertPackId(packId);
			const dir = path.resolve(path.join(baseDir(), packId));
			let names: string[];
			try {
				names = await fs.promises.readdir(dir);
			} catch {
				return []; // no dir yet → no keys
			}
			const out: string[] = [];
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				const key = decodeKey(name.slice(0, -".json".length));
				if (prefix && !key.startsWith(prefix)) continue;
				out.push(key);
			}
			out.sort();
			return out;
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
