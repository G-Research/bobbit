import fs from "node:fs";
import path from "node:path";

/**
 * Durable per-store deletion tombstones.
 *
 * ## Why this exists
 * The boot-time headquarters migration (`state-migration.ts`) re-materialises a
 * store record whenever it is present in a `.pre-headquarters-id-migration`
 * backup but absent from the live store (`routeLegacyProjectStoreFile`'s
 * backup-only recovery loop). That loop cannot distinguish a record that was
 * *legitimately dropped* (and needs recovery — "Finding C") from one that was
 * *intentionally deleted after the migration*. Without a tombstone, deleting a
 * staff agent / session / goal only sticks until the next server restart, when
 * the migration resurrects it (re-activating its triggers — a data-integrity +
 * safety bug).
 *
 * A tombstone is a durable record of "this key was hard-deleted on purpose".
 * The migration consults the tombstone set and refuses to recover a
 * backup-only key that is tombstoned, while still recovering un-tombstoned
 * backup-only keys (Finding C preserved).
 *
 * ## Storage
 * A single JSON file `<stateDir>/.deletion-tombstones.json` per state dir,
 * shape `{ "<fileName>": ["<key>", ...] }`. The file lives in the headquarters
 * state dir (durable across restarts, never a normal-project-reachable secret
 * path). Keys are the record id — i.e. the same key derivation as
 * `recordKeyForFile` for the array stores (`id` for staff/session/goal).
 *
 * ## Scope: which stores are tombstoned?
 * Only the array stores that are resurrected through the migration's
 * backup-only recovery path with an `id` key: **staff.json, sessions.json,
 * goals.json**. Their hard-delete `remove()` methods record a tombstone.
 *
 * Deliberately NOT tombstoned: team-state / gates / tasks and the object-shaped
 * stores (session-costs / session-colors / bg-processes). team-state and gates
 * are keyed by goalId / composite keys and are lifecycle-managed alongside the
 * goal they belong to (they are not user-facing hard-deletes that get
 * resurrected via this path); tasks are goal-scoped and cleared with the goal.
 * If a future array store gains a user-facing hard-delete AND routes through the
 * same backup-only recovery loop, it should tombstone on `remove()` too.
 *
 * ## Durability contract
 * All fs access is best-effort and wrapped in try/catch — a tombstone failure
 * must NEVER throw into a delete caller (deletion still succeeds; worst case the
 * record could theoretically resurrect, which the marker guard + backup
 * retirement in `state-migration.ts` also defend against). `record` is
 * idempotent (no duplicate keys) and creates the state dir if missing.
 */

const TOMBSTONE_FILE = ".deletion-tombstones.json";

export type DeletionTombstoneAsyncFs = Pick<
	typeof fs.promises,
	"mkdir" | "readFile" | "writeFile"
>;

type PendingTombstone = { fileName: string; key: string };
type TombstoneWriteState = {
	pending: PendingTombstone[];
	inFlight: Promise<void>;
};

/** One writer per durable tombstone file; synchronous callers fold into it. */
const asyncWriters = new Map<string, TombstoneWriteState>();

/** Absolute path to the tombstone file for a given state dir. */
export function deletionTombstoneFile(stateDir: string): string {
	return path.join(stateDir, TOMBSTONE_FILE);
}

/**
 * Read the full tombstone map for a state dir. Returns `{}` when the file is
 * missing, unreadable, or malformed (best-effort; never throws).
 */
export function readAllDeletionTombstones(stateDir: string): Record<string, string[]> {
	try {
		const file = deletionTombstoneFile(stateDir);
		if (!fs.existsSync(file)) return {};
		const data = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
		if (!data || typeof data !== "object" || Array.isArray(data)) return {};
		const out: Record<string, string[]> = {};
		for (const [fileName, keys] of Object.entries(data as Record<string, unknown>)) {
			if (Array.isArray(keys)) {
				out[fileName] = keys.filter((key): key is string => typeof key === "string");
			}
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Read the set of tombstoned keys for a specific store file. Returns an empty
 * set when none are recorded (best-effort; never throws).
 */
export function readDeletionTombstones(stateDir: string, fileName: string): Set<string> {
	const all = readAllDeletionTombstones(stateDir);
	return new Set(all[fileName] ?? []);
}

/**
 * Durably record that `key` was hard-deleted from `<stateDir>/<fileName>`.
 * Idempotent (no duplicate keys). Best-effort: never throws into the caller.
 */
export function recordDeletionTombstone(stateDir: string, fileName: string, key: string): void {
	if (!key) return;
	const writer = asyncWriters.get(path.resolve(deletionTombstoneFile(stateDir)));
	if (writer) {
		// A synchronous store mutation cannot await the active purge writer. Add
		// its intent to that writer so the older async snapshot cannot erase it.
		writer.pending.push({ fileName, key });
		return;
	}
	try {
		if (!fs.existsSync(stateDir)) {
			fs.mkdirSync(stateDir, { recursive: true });
		}
		const all = readAllDeletionTombstones(stateDir);
		const list = all[fileName] ?? [];
		if (list.includes(key)) return; // idempotent — already tombstoned
		list.push(key);
		all[fileName] = list;
		fs.writeFileSync(deletionTombstoneFile(stateDir), JSON.stringify(all, null, 2), "utf-8");
	} catch {
		/* best-effort — deletion must succeed even if the tombstone write fails */
	}
}

async function readAllDeletionTombstonesAsync(
	stateDir: string,
	fsImpl: DeletionTombstoneAsyncFs,
): Promise<Record<string, string[]>> {
	try {
		const data = JSON.parse(await fsImpl.readFile(deletionTombstoneFile(stateDir), "utf-8")) as unknown;
		if (!data || typeof data !== "object" || Array.isArray(data)) return {};
		const out: Record<string, string[]> = {};
		for (const [storedFileName, keys] of Object.entries(data as Record<string, unknown>)) {
			if (Array.isArray(keys)) {
				out[storedFileName] = keys.filter((storedKey): storedKey is string => typeof storedKey === "string");
			}
		}
		return out;
	} catch {
		return {};
	}
}

async function drainTombstones(
	stateDir: string,
	state: TombstoneWriteState,
	fsImpl: DeletionTombstoneAsyncFs,
): Promise<void> {
	while (state.pending.length > 0) {
		const batch = state.pending.splice(0);
		try {
			await fsImpl.mkdir(stateDir, { recursive: true });
			const all = await readAllDeletionTombstonesAsync(stateDir, fsImpl);
			let changed = false;
			for (const { fileName, key } of batch) {
				const list = all[fileName] ?? [];
				if (list.includes(key)) continue;
				list.push(key);
				all[fileName] = list;
				changed = true;
			}
			if (changed) {
				await fsImpl.writeFile(deletionTombstoneFile(stateDir), JSON.stringify(all, null, 2), "utf-8");
			}
		} catch {
			/* best-effort — deletion must succeed even if the tombstone write fails */
		}
	}
}

/**
 * Promise-based purge seam for a durable deletion tombstone. Calls targeting
 * the same state directory are serialized, remain idempotent, and fold any
 * synchronous tombstones recorded while an async write is pending.
 */
export function recordDeletionTombstoneAsync(
	stateDir: string,
	fileName: string,
	key: string,
	fsImpl: DeletionTombstoneAsyncFs = fs.promises,
): Promise<void> {
	if (!key) return Promise.resolve();
	const writerKey = path.resolve(deletionTombstoneFile(stateDir));
	const existing = asyncWriters.get(writerKey);
	if (existing) {
		existing.pending.push({ fileName, key });
		return existing.inFlight;
	}

	const state = { pending: [{ fileName, key }], inFlight: Promise.resolve() } as TombstoneWriteState;
	state.inFlight = drainTombstones(stateDir, state, fsImpl);
	asyncWriters.set(writerKey, state);
	void state.inFlight.then(() => {
		if (asyncWriters.get(writerKey) === state) asyncWriters.delete(writerKey);
	});
	return state.inFlight;
}
