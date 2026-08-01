import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
// Pi's FileAuthStorage calls proper-lockfile with `stale: 10_000`. This shared
// lock namespace must refresh before the shortest consumer's stale deadline,
// or Pi can reclaim a Bobbit lock during a healthy token refresh.
const PI_LOCK_STALE_MS = 10_000;
const LOCK_STALE_MS = PI_LOCK_STALE_MS;
const LOCK_HEARTBEAT_MS = Math.max(1_000, Math.floor(PI_LOCK_STALE_MS / 2));
const LOCK_RETRIES = 10;
const LOCK_MIN_RETRY_MS = 100;
const LOCK_MAX_RETRY_MS = 10_000;
export const deleteCredential = Symbol("delete credential");

type RawAuthData = Record<string, unknown>;

/** Historical Pi files used `api-key`; keep those rows intact on unrelated OAuth rollback. */
export interface LegacyApiKeyCredential {
	type: "api-key";
	key: string;
	[key: string]: unknown;
}

export type StoredCredential = Credential | LegacyApiKeyCredential;
export type CredentialMutation = Credential | typeof deleteCredential | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStoredCredential(value: unknown): StoredCredential | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type !== "oauth" && value.type !== "api_key" && value.type !== "api-key") return undefined;
	return value as StoredCredential;
}

/** Pi consumes the canonical spelling, while storage retains the legacy spelling. */
function asCredential(value: unknown): Credential | undefined {
	const stored = asStoredCredential(value);
	if (!stored) return undefined;
	if (stored.type === "api-key") return { ...stored, type: "api_key" } as Credential;
	return stored as Credential;
}

function cloneStoredCredential(credential: StoredCredential | undefined): StoredCredential | undefined {
	return credential ? { ...credential } as StoredCredential : undefined;
}

function sameStoredCredential(left: StoredCredential | undefined, right: StoredCredential | undefined): boolean {
	if (!left || !right || left.type !== right.type) return left === right;
	const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
	const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
	return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function parseAuthData(content: string): RawAuthData {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error("Credential store contains invalid JSON");
	}
	if (!isRecord(parsed)) throw new Error("Credential store must contain a JSON object");
	return parsed;
}

function bestEffortChmod(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Windows and some network filesystems do not implement POSIX modes.
	}
}

function sleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isFileExistsError(error: unknown): boolean {
	return isRecord(error) && error.code === "EEXIST";
}

interface LockIdentity {
	dev: number;
	ino: number;
}

function lockIdentity(lockPath: string): LockIdentity {
	const { dev, ino } = statSync(lockPath);
	return { dev, ino };
}

function isSameLockIdentity(expected: LockIdentity, lockPath: string): boolean {
	try {
		const actual = lockIdentity(lockPath);
		return actual.dev === expected.dev && actual.ino === expected.ino;
	} catch {
		return false;
	}
}

let beforeStaleLockClaimForTests: ((lockPath: string) => void) | undefined;

/** @internal Deterministically interleave a replacement owner after identity verification. */
export function __setBeforeStaleLockClaimForTests(hook: ((lockPath: string) => void) | undefined): void {
	beforeStaleLockClaimForTests = hook;
}

/**
 * Reclaim an unchanged stale lock only. A stale observation alone is not
 * ownership: another process can release the stale directory and acquire a
 * fresh lock at the same pathname before we remove it. Rename the visible
 * directory to a private claim before deleting it, then validate the claimed
 * directory's identity. This makes the destructive rmdir target immutable:
 * a replacement at lockPath can never be removed by this recovery attempt.
 */
function reclaimStaleAuthFileLock(lockPath: string): boolean {
	let observed: LockIdentity;
	try {
		const stats = statSync(lockPath);
		if (Date.now() - stats.mtimeMs <= LOCK_STALE_MS) return false;
		observed = { dev: stats.dev, ino: stats.ino };
	} catch {
		return false;
	}

	if (!isSameLockIdentity(observed, lockPath)) return false;
	beforeStaleLockClaimForTests?.(lockPath);

	const claimPath = `${lockPath}.reclaim-${process.pid}-${randomUUID()}`;
	try {
		// rename is atomic within this directory. Once it succeeds, no subsequent
		// replacement at lockPath can become the directory we remove below.
		renameSync(lockPath, claimPath);
	} catch {
		return false;
	}

	if (!isSameLockIdentity(observed, claimPath)) {
		try {
			// Restore an intervening replacement only while no later owner has
			// acquired the public pathname. If it has, leave both directories
			// untouched rather than clobbering that owner.
			if (!existsSync(lockPath)) renameSync(claimPath, lockPath);
		} catch {
			// The claim was no longer exclusively recoverable. Never delete it.
		}
		return false;
	}

	try {
		rmdirSync(claimPath);
		return true;
	} catch {
		// A concurrent releaser/reclaimer is harmless; retry normally.
		return false;
	}
}

/**
 * Acquire the same `<auth.json>.lock` directory namespace used by Pi's
 * proper-lockfile dependency without importing that private implementation.
 * mkdir is atomic across processes; touching the directory while the callback
 * is running prevents a healthy, slow token refresh from being reclaimed as
 * stale. The lock directory deliberately remains empty so Pi can reclaim a
 * lock left behind by a crashed Bobbit process, and vice versa.
 */
interface AuthFileLock {
	assertIntact(): void;
	release(): void;
}

async function acquireAuthFileLock(authPath: string): Promise<AuthFileLock> {
	const lockPath = `${authPath}.lock`;
	for (let attempt = 0; ; attempt += 1) {
		try {
			mkdirSync(lockPath, { mode: DIRECTORY_MODE });
			bestEffortChmod(lockPath, DIRECTORY_MODE);
			const identity = lockIdentity(lockPath);
			let compromised = false;
			const assertOwnership = () => {
				if (compromised || !isSameLockIdentity(identity, lockPath)) {
					compromised = true;
					throw new Error("Credential store lock was compromised");
				}
			};
			const heartbeat = setInterval(() => {
				try {
					// A stale owner must never refresh the lease of a directory that a
					// reclaimer has removed and recreated at the same pathname.
					assertOwnership();
					utimesSync(lockPath, new Date(), new Date());
					assertOwnership();
				} catch {
					compromised = true;
				}
			}, LOCK_HEARTBEAT_MS);
			heartbeat.unref();
			return {
				assertIntact: assertOwnership,
				release: () => {
					clearInterval(heartbeat);
					// Do not remove a lock directory that was reclaimed by another
					// process while this owner was stalled.
					assertOwnership();
					rmdirSync(lockPath);
				},
			};
		} catch (error) {
			if (!isFileExistsError(error)) throw error;

			// Match proper-lockfile's stale-directory recovery protocol so a
			// gateway crash cannot permanently block future credential refreshes.
			// Revalidate the observed directory identity before reclaiming: a
			// replacement lock at the same pathname belongs to another owner.
			if (reclaimStaleAuthFileLock(lockPath)) continue;

			if (attempt >= LOCK_RETRIES) throw new Error("Credential store lock timed out");
			const baseDelay = Math.min(LOCK_MAX_RETRY_MS, LOCK_MIN_RETRY_MS * 2 ** attempt);
			await sleep(baseDelay * (1 + Math.random()));
		}
	}
}

/**
 * A fresh-reading, mutation-locked, atomic auth.json CredentialStore.
 *
 * Pi's built-in store and this adapter coordinate through the shared
 * `<auth.json>.lock` directory. Pi currently writes its own file in place;
 * Bobbit cannot make an external Pi process atomic, but every Bobbit mutation
 * uses a same-directory temporary file, fsync, and atomic rename.
 */
export class AtomicCredentialStore implements CredentialStore {
	readonly authPath: string;
	private readonly onDidChange?: () => void;
	private fileQueue: Promise<void> = Promise.resolve();
	private readonly providerQueues = new Map<string, Promise<void>>();
	/** Last committed value per provider, used to undo only a cancelled flow's write. */
	private readonly rollbackHistory = new Map<string, { before?: StoredCredential; after: StoredCredential }>();

	constructor(authPath: string, onDidChange?: () => void) {
		this.authPath = authPath;
		this.onDidChange = onDidChange;
	}

	private ensureStorage(): void {
		const directory = dirname(this.authPath);
		mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
		if (!existsSync(this.authPath)) {
			let fd: number | undefined;
			try {
				fd = openSync(this.authPath, "wx", FILE_MODE);
				writeFileSync(fd, "{}\n", { encoding: "utf8" });
				fsyncSync(fd);
			} catch (error) {
				const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
				if (code !== "EEXIST") throw error;
			} finally {
				if (fd !== undefined) closeSync(fd);
			}
		}
		bestEffortChmod(this.authPath, FILE_MODE);
	}

	private canonicalAuthPath(): string {
		return realpathSync(this.authPath);
	}

	private readCurrent(authPath = this.authPath): RawAuthData {
		return parseAuthData(readFileSync(authPath, "utf8"));
	}

	private atomicWrite(data: RawAuthData, authPath = this.authPath): void {
		const directory = dirname(authPath);
		const temporaryPath = join(
			directory,
			`.${basename(authPath)}.bobbit-${process.pid}-${randomUUID()}.tmp`,
		);
		let fd: number | undefined;
		try {
			fd = openSync(temporaryPath, "wx", FILE_MODE);
			writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8" });
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			bestEffortChmod(temporaryPath, FILE_MODE);
			renameSync(temporaryPath, authPath);
			bestEffortChmod(authPath, FILE_MODE);

			// Persist the directory entry where supported. Opening/fsyncing a
			// directory is unavailable on Windows and some filesystems.
			let directoryFd: number | undefined;
			try {
				directoryFd = openSync(directory, "r");
				fsyncSync(directoryFd);
			} catch {
				// Best-effort durability beyond the already-fsynced file.
			} finally {
				if (directoryFd !== undefined) closeSync(directoryFd);
			}
		} finally {
			if (fd !== undefined) closeSync(fd);
			try {
				if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
			} catch {
				// Best-effort cleanup after a failed write/rename.
			}
		}
	}

	/**
	 * Pi's CredentialStore.modify contract holds the canonical auth.json lock
	 * across the provider callback. This is required for rotating refresh tokens:
	 * the second process must re-read the winner before it can contact upstream.
	 * Provider HTTP calls made from these callbacks must therefore be bounded.
	 */
	private withLock<T>(
		fn: (data: RawAuthData) =>
			| { result: T; next?: RawAuthData }
			| Promise<{ result: T; next?: RawAuthData }>,
	): Promise<T> {
		const operation = this.fileQueue.then(() => this.withFileLock(fn));
		this.fileQueue = operation.then(() => undefined, () => undefined);
		return operation;
	}

	private async withFileLock<T>(
		fn: (data: RawAuthData) =>
			| { result: T; next?: RawAuthData }
			| Promise<{ result: T; next?: RawAuthData }>,
	): Promise<T> {
		this.ensureStorage();
		// Pi's auth storage uses proper-lockfile's default realpath:true. Resolve
		// before acquiring the shared lock so a symlinked/junction agent directory
		// coordinates on the canonical `<auth.json>.lock` directory as well.
		const authPath = this.canonicalAuthPath();
		const fileLock = await acquireAuthFileLock(authPath);
		try {
			fileLock.assertIntact();
			const { result, next } = await fn(this.readCurrent(authPath));
			fileLock.assertIntact();
			if (next !== undefined) {
				this.atomicWrite(next, authPath);
				fileLock.assertIntact();
			}
			return result;
		} finally {
			try {
				fileLock.release();
			} catch {
				// A competing stale-lock recovery can remove the directory first. Do
				// not replace a completed credential result with cleanup failure.
			}
		}
	}

	private async readFresh(): Promise<RawAuthData> {
		this.ensureStorage();
		return parseAuthData(await readFile(this.authPath, "utf8"));
	}

	private enqueueProvider<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.providerQueues.get(providerId) ?? Promise.resolve();
		const operation = previous.then(fn);
		const tail = operation.then(() => undefined, () => undefined);
		this.providerQueues.set(providerId, tail);
		void tail.then(() => {
			if (this.providerQueues.get(providerId) === tail) this.providerQueues.delete(providerId);
		});
		return operation;
	}

	private didChange(): void {
		try {
			this.onDidChange?.();
		} catch {
			// Cache invalidation must not turn a durable credential write into a failure.
		}
	}

	/**
	 * Synchronous, read-only status lookup for the existing REST facade. Writers
	 * replace auth.json atomically, so this observes either the complete old or
	 * complete new file without participating in a mutation lock.
	 */
	readStoredCredentialSync(providerId: string): Credential | undefined {
		try {
			if (!existsSync(this.authPath)) return undefined;
			return asCredential(this.readCurrent()[providerId]);
		} catch {
			return undefined;
		}
	}

	/**
	 * Read the persisted row without normalizing legacy `api-key` spelling.
	 * OAuth cancellation needs this exact snapshot so it cannot erase an older
	 * API-key credential while unwinding a late OAuth result.
	 */
	readStoredCredentialSnapshotSync(providerId: string): StoredCredential | undefined {
		try {
			if (!existsSync(this.authPath)) return undefined;
			return cloneStoredCredential(asStoredCredential(this.readCurrent()[providerId]));
		} catch {
			return undefined;
		}
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return asCredential((await this.readFresh())[providerId]);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(await this.readFresh()).flatMap(([providerId, value]) => {
			const credential = asCredential(value);
			return credential ? [{ providerId, type: credential.type }] : [];
		});
	}

	async mutate(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<CredentialMutation>,
	): Promise<Credential | undefined> {
		return this.enqueueProvider(providerId, async () => {
			let changed = false;
			let committed: { before?: StoredCredential; after?: StoredCredential } | undefined;
			const result = await this.withLock(async (data) => {
				const rawCurrent = asStoredCredential(data[providerId]);
				const current = asCredential(rawCurrent);
				const mutation = await fn(current);
				if (mutation === undefined) return { result: current };

				const next = { ...data };
				if (mutation === deleteCredential) {
					if (!(providerId in next)) return { result: undefined };
					delete next[providerId];
					committed = { before: cloneStoredCredential(rawCurrent) };
					changed = true;
					return { result: undefined, next };
				}
				next[providerId] = mutation;
				committed = {
					before: cloneStoredCredential(rawCurrent),
					after: cloneStoredCredential(mutation)!,
				};
				changed = true;
				return { result: mutation, next };
			});
			if (changed) {
				if (committed?.after) this.rollbackHistory.set(providerId, committed as { before?: StoredCredential; after: StoredCredential });
				else this.rollbackHistory.delete(providerId);
				this.didChange();
			}
			return result;
		});
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.mutate(providerId, fn);
	}

	/**
	 * Replace an exact cancelled-flow result with the value immediately before
	 * that write. A refresh that occurred after login started is therefore kept,
	 * instead of rolling all the way back to the flow-start snapshot.
	 */
	async rollbackCredentialIfCurrent(
		providerId: string,
		expected: Credential,
		fallback: StoredCredential | undefined,
		shouldRestore: () => boolean,
	): Promise<void> {
		await this.enqueueProvider(providerId, async () => {
			let changed = false;
			await this.withLock((data) => {
				const current = asStoredCredential(data[providerId]);
				if (!sameStoredCredential(current, expected as StoredCredential)) return { result: undefined };
				const remembered = this.rollbackHistory.get(providerId);
				const restore = shouldRestore()
					? (remembered && sameStoredCredential(remembered.after, current) ? remembered.before : fallback)
					: undefined;
				const next = { ...data };
				if (restore) next[providerId] = restore;
				else delete next[providerId];
				changed = true;
				return { result: undefined, next };
			});
			if (changed) {
				this.rollbackHistory.delete(providerId);
				this.didChange();
			}
		});
	}

	async delete(providerId: string): Promise<void> {
		await this.enqueueProvider(providerId, async () => {
			let changed = false;
			await this.withLock((data) => {
				if (!(providerId in data)) return { result: undefined };
				const next = { ...data };
				delete next[providerId];
				changed = true;
				return { result: undefined, next };
			});
			if (changed) {
				this.rollbackHistory.delete(providerId);
				this.didChange();
			}
		});
	}
}
