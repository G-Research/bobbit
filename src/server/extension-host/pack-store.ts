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
export function createPackStore(opts?: { rootDir?: string }): PackStore {
	const baseDir = () => path.join(opts?.rootDir ?? bobbitStateDir(), "ext-store");

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
			await fs.promises.mkdir(dir, { recursive: true });
			const env: StoreEnvelope<T> = { v: 1, value };
			await fs.promises.writeFile(file, JSON.stringify(env), "utf8");
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
