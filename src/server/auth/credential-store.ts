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
import { createHash, randomUUID } from "node:crypto";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
// Pi's FileAuthStorageBackend calls proper-lockfile with `stale: 30_000` and
// a 15-second heartbeat. This shared lock namespace must match that lease so
// Bobbit never reclaims a healthy Pi lock before its next heartbeat.
const PI_LOCK_STALE_MS = 30_000;
const LOCK_STALE_MS = PI_LOCK_STALE_MS;
const LOCK_HEARTBEAT_MS = 15_000;
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

const REJECTED_OAUTH_LEDGER_VERSION = 1;
// Pi's file-backed auth store treats an unknown stored credential type as owned
// but unresolvable: it neither derives OAuth auth nor falls back to ambient API
// keys. Keep this non-secret raw entry when an OAuth credential is terminally
// rejected, so a separately constructed Pi runtime cannot refresh a raw row
// that Bobbit's sidecar fence has hidden from this adapter.
const REJECTED_OAUTH_TOMBSTONE_TYPE = "oauth_rejected";
// A rejected OAuth access value must be denied immediately even if persisting
// its sidecar fence fails. The durable fence remains the restart boundary; this
// narrow in-process record closes the write-failure window without retaining a
// bearer value. Keep every exact in-flight decision: a stale rejection must
// never replace the current rejection's fail-closed protection.
const rejectedOAuthInProcess = new Map<string, Set<string>>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStoredCredential(value: unknown): StoredCredential | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type !== "oauth" && value.type !== "api_key" && value.type !== "api-key") return undefined;
	return value as StoredCredential;
}

/** Pi's renewable Anthropic OAuth contract, shared by every gateway consumer. */
export function isCompleteAnthropicOAuthCredential(value: unknown): value is Credential & { type: "oauth"; access: string; refresh: string; expires: number } {
	if (!isRecord(value)) return false;
	return value.type === "oauth"
		&& typeof value.access === "string" && value.access.length > 0
		&& typeof value.refresh === "string" && value.refresh.length > 0
		&& typeof value.expires === "number" && Number.isFinite(value.expires);
}

/** Anthropic API keys remain a separate, non-OAuth authentication path. */
export function isAnthropicApiKeyCredential(value: unknown): value is Credential & { key: string } {
	return isRecord(value)
		&& (value.type === "api-key" || value.type === "api_key")
		&& typeof value.key === "string" && value.key.trim().length > 0;
}

function rejectedLedgerPath(authPath: string, providerId: string): string {
	// Each provider owns its own fence. A corrupt Anthropic sidecar must not
	// hide a valid Codex/Google account row (or vice versa).
	return `${authPath}.bobbit-rejected-oauth.${encodeURIComponent(providerId)}.json`;
}

function oauthAccessFingerprint(access: string): string {
	// Persist only a one-way compare value: this ledger must never become another
	// bearer-token store or reveal renewable credentials in diagnostics.
	return createHash("sha256").update(access).digest("hex");
}

function rejectedOAuthTombstone(access: string): RawAuthData[string] {
	return {
		type: REJECTED_OAUTH_TOMBSTONE_TYPE,
		rejected: oauthAccessFingerprint(access),
		version: REJECTED_OAUTH_LEDGER_VERSION,
	};
}

function isRejectedOAuthTombstone(value: unknown, access?: string): boolean {
	if (!isRecord(value)
		|| value.type !== REJECTED_OAUTH_TOMBSTONE_TYPE
		|| value.version !== REJECTED_OAUTH_LEDGER_VERSION
		|| typeof value.rejected !== "string"
		|| !/^[a-f0-9]{64}$/i.test(value.rejected)) return false;
	return access === undefined || value.rejected === oauthAccessFingerprint(access);
}

function rejectionKey(authPath: string, providerId: string): string {
	try {
		return `${realpathSync(authPath)}\u0000${providerId}`;
	} catch {
		return `${authPath}\u0000${providerId}`;
	}
}

function rememberRejectedOAuthFingerprint(authPath: string, providerId: string, fingerprint: string): void {
	const key = rejectionKey(authPath, providerId);
	const fingerprints = rejectedOAuthInProcess.get(key) ?? new Set<string>();
	fingerprints.add(fingerprint);
	rejectedOAuthInProcess.set(key, fingerprints);
}

function rejectedOAuthFingerprint(authPath: string, providerId: string): string | null | undefined {
	let canonicalPath: string;
	try {
		// The mutation lock follows Pi's realpath contract, so status/direct/sandbox
		// readers must resolve the same sidecar when an agent directory is a link.
		canonicalPath = realpathSync(authPath);
	} catch {
		return null;
	}
	// A durable decision always wins over the in-process safety fallback. A
	// stale invalidation can arrive after a newer rejection committed; it must
	// never shadow that current fence merely because its caller is still live.
	const ledgerPath = rejectedLedgerPath(canonicalPath, providerId);
	if (existsSync(ledgerPath)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(ledgerPath, "utf8"));
			if (!isRecord(parsed) || parsed.version !== REJECTED_OAUTH_LEDGER_VERSION) return null;
			const fingerprint = parsed.rejected;
			return typeof fingerprint === "string" && /^[a-f0-9]{64}$/i.test(fingerprint) ? fingerprint : null;
		} catch {
			// A corrupt fence fails closed for *its provider only*.
			return null;
		}
	}
	// Read the prior shared format only when it contains a valid entry for this
	// provider. A corrupt legacy document cannot be assigned safely, so it must
	// not hide unrelated provider rows during migration to scoped sidecars.
	const legacyPath = `${canonicalPath}.bobbit-rejected-oauth.json`;
	if (existsSync(legacyPath)) {
		try {
			const legacy: unknown = JSON.parse(readFileSync(legacyPath, "utf8"));
			if (isRecord(legacy) && legacy.version === REJECTED_OAUTH_LEDGER_VERSION && isRecord(legacy.rejected)) {
				const fingerprint = legacy.rejected[providerId];
				if (typeof fingerprint === "string" && /^[a-f0-9]{64}$/i.test(fingerprint)) return fingerprint;
			}
		} catch {
			// A malformed legacy entry does not override a provider-scoped fallback.
		}
	}
	return undefined;
}

/** True only for the exact persisted OAuth access value that was definitively rejected. */
export function isStoredOAuthCredentialRejected(authPath: string, providerId: string, value: unknown): boolean {
	if (!isRecord(value) || value.type !== "oauth" || typeof value.access !== "string" || !value.access) return false;
	const fingerprint = oauthAccessFingerprint(value.access);
	const durableFingerprint = rejectedOAuthFingerprint(authPath, providerId);
	if (durableFingerprint === null || durableFingerprint === fingerprint) return true;
	return rejectedOAuthInProcess.get(rejectionKey(authPath, providerId))?.has(fingerprint) ?? false;
}

/** The single Anthropic OAuth validity predicate for status, catalog, direct, and sandbox paths. */
export function isUsableAnthropicOAuthCredential(authPath: string, value: unknown): value is Credential & { type: "oauth"; access: string; refresh: string; expires: number } {
	return isCompleteAnthropicOAuthCredential(value) && !isStoredOAuthCredentialRejected(authPath, "anthropic", value);
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

/** An observed stale lock remains reclaimable only while its identity and lease are unchanged. */
function isSameStaleLock(expected: LockIdentity, lockPath: string): boolean {
	try {
		const stats = statSync(lockPath);
		return stats.dev === expected.dev
			&& stats.ino === expected.ino
			&& Date.now() - stats.mtimeMs > LOCK_STALE_MS;
	} catch {
		return false;
	}
}

let beforeStaleLockClaimForTests: ((lockPath: string) => void) | undefined;

/** @internal Deterministically interleave an owner action before the final stale-lock claim. */
export function __setBeforeStaleLockClaimForTests(hook: ((lockPath: string) => void) | undefined): void {
	beforeStaleLockClaimForTests = hook;
}

/**
 * Reclaim an unchanged stale lock only. A stale observation alone is not
 * ownership: another process can release the stale directory and acquire a
 * fresh lock at the same pathname before we remove it. Rename the visible
 * directory to a private claim before deleting it, then validate the claimed
 * directory's identity and lease. This makes the destructive rmdir target
 * immutable: a replacement at lockPath can never be removed by this recovery
 * attempt, while a renewed original lease is restored rather than reclaimed.
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

	// A healthy owner can heartbeat the same directory inode after our first
	// stale observation. Re-check the lease immediately before the atomic claim.
	if (!isSameStaleLock(observed, lockPath)) return false;
	beforeStaleLockClaimForTests?.(lockPath);

	const claimPath = `${lockPath}.reclaim-${process.pid}-${randomUUID()}`;
	try {
		// rename is atomic within this directory. Once it succeeds, no subsequent
		// replacement at lockPath can become the directory we remove below.
		renameSync(lockPath, claimPath);
	} catch {
		return false;
	}

	// A heartbeat may have raced the final pre-claim check. Verify the claimed
	// lease again before deleting, then restore a renewed original owner.
	if (!isSameStaleLock(observed, claimPath)) {
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

/**
 * Remove only the exact lock directory this owner created. Re-checking before
 * `rmdir` alone has a TOCTOU gap: a stalled owner can observe its inode, then
 * delete a replacement lease at the same pathname. Claim the observed inode
 * first, validate it at the private path, and only then remove that claim.
 */
function releaseAuthFileLock(lockPath: string, identity: LockIdentity): void {
	if (!isSameLockIdentity(identity, lockPath)) {
		throw new Error("Credential store lock was compromised");
	}
	const claimPath = `${lockPath}.release-${process.pid}-${randomUUID()}`;
	try {
		renameSync(lockPath, claimPath);
	} catch {
		throw new Error("Credential store lock was compromised");
	}
	if (!isSameLockIdentity(identity, claimPath)) {
		// We claimed a replacement after the pre-claim check. Restore it only if
		// another owner has not acquired the public pathname; never delete it.
		try {
			if (!existsSync(lockPath)) renameSync(claimPath, lockPath);
		} catch {
			// A later owner won the pathname. Failing closed is safer than removal.
		}
		throw new Error("Credential store lock was compromised");
	}
	try {
		rmdirSync(claimPath);
	} catch (error) {
		// The claimed directory is private, so a failure cannot be interpreted as
		// a successful release by a replacement owner.
		throw error;
	}
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
					releaseAuthFileLock(lockPath, identity);
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
		fn: (data: RawAuthData, authPath: string, assertLock: () => void) =>
			| { result: T; next?: RawAuthData }
			| Promise<{ result: T; next?: RawAuthData }>,
	): Promise<T> {
		const operation = this.fileQueue.then(() => this.withFileLock(fn));
		this.fileQueue = operation.then(() => undefined, () => undefined);
		return operation;
	}

	private async withFileLock<T>(
		fn: (data: RawAuthData, authPath: string, assertLock: () => void) =>
			| { result: T; next?: RawAuthData }
			| Promise<{ result: T; next?: RawAuthData }>,
	): Promise<T> {
		this.ensureStorage();
		// Pi's auth storage uses proper-lockfile's default realpath:true. Resolve
		// before acquiring the shared lock so a symlinked/junction agent directory
		// coordinates on the canonical `<auth.json>.lock` directory as well.
		const authPath = this.canonicalAuthPath();
		const fileLock = await acquireAuthFileLock(authPath);
		let result: T | undefined;
		let failure: unknown;
		try {
			fileLock.assertIntact();
			const outcome = await fn(this.readCurrent(authPath), authPath, fileLock.assertIntact);
			fileLock.assertIntact();
			if (outcome.next !== undefined) {
				this.atomicWrite(outcome.next, authPath);
				fileLock.assertIntact();
			}
			result = outcome.result;
		} catch (error) {
			failure = error;
		}
		try {
			fileLock.release();
		} catch (releaseError) {
			// Losing lock ownership means the caller cannot safely treat the
			// operation as committed. Never swallow this security boundary.
			throw releaseError;
		}
		if (failure !== undefined) throw failure;
		return result as T;
	}

	private persistRejectedOAuthCredential(authPath: string, providerId: string, access: string): void {
		const fingerprint = oauthAccessFingerprint(access);
		// Set before the durable write. If a full disk or permissions error prevents
		// the sidecar commit, the running gateway still refuses this exact credential.
		rememberRejectedOAuthFingerprint(authPath, providerId, fingerprint);
		this.atomicWrite({ version: REJECTED_OAUTH_LEDGER_VERSION, rejected: fingerprint }, rejectedLedgerPath(authPath, providerId));
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
			const credential = asCredential(this.readCurrent()[providerId]);
			return credential && !isStoredOAuthCredentialRejected(this.authPath, providerId, credential)
				? credential
				: undefined;
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
		const credential = asCredential((await this.readFresh())[providerId]);
		return credential && !isStoredOAuthCredentialRejected(this.authPath, providerId, credential)
			? credential
			: undefined;
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(await this.readFresh()).flatMap(([providerId, value]) => {
			const credential = asCredential(value);
			return credential && !isStoredOAuthCredentialRejected(this.authPath, providerId, credential)
				? [{ providerId, type: credential.type }]
				: [];
		});
	}

	async mutate(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<CredentialMutation>,
	): Promise<Credential | undefined> {
		return this.enqueueProvider(providerId, async () => {
			let changed = false;
			let committed: { before?: StoredCredential; after?: StoredCredential } | undefined;
			const result = await this.withLock(async (data, authPath) => {
				const rawCurrent = asStoredCredential(data[providerId]);
				const rawCredential = asCredential(rawCurrent);
				const current = rawCredential && !isStoredOAuthCredentialRejected(authPath, providerId, rawCredential)
					? rawCredential
					: undefined;
				const mutation = await fn(current);
				if (mutation === undefined) return { result: current };
				if (providerId === "anthropic" && mutation !== deleteCredential && mutation.type === "oauth" && !isCompleteAnthropicOAuthCredential(mutation)) {
					throw new Error("Anthropic OAuth credential is incomplete");
				}

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
		shouldRestore: (candidate: StoredCredential | undefined) => boolean,
	): Promise<void> {
		await this.enqueueProvider(providerId, async () => {
			let changed = false;
			await this.withLock((data) => {
				const rawCurrent = data[providerId];
				const current = asStoredCredential(rawCurrent);
				// Fencing replaces the raw OAuth row with a non-secret, Pi-unresolvable
				// tombstone before rollback. Accept only the tombstone for this exact
				// issued access, never a new flow's fence or credential.
				if (!sameStoredCredential(current, expected as StoredCredential)
					&& !isRejectedOAuthTombstone(rawCurrent, expected.type === "oauth" ? expected.access : undefined)) {
					return { result: undefined };
				}
				const remembered = this.rollbackHistory.get(providerId);
				const candidate = remembered && sameStoredCredential(remembered.after, expected as StoredCredential)
					? remembered.before
					: fallback;
				const restore = shouldRestore(candidate) ? candidate : undefined;
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

	/**
	 * Durably deny an exact OAuth row before cancellation rollback.
	 *
	 * The raw tombstone is intentional: Pi hosts that read auth.json directly do
	 * not know Bobbit's sidecar fence, and must not refresh the rejected bearer.
	 */
	async fenceOAuthCredential(providerId: string, access: string, refresh?: string): Promise<boolean> {
		if (!access) return false;
		// Deny the exact attempted bearer before acquiring the lock. The set keeps
		// a stale caller from replacing a newer in-process rejection decision.
		rememberRejectedOAuthFingerprint(this.authPath, providerId, oauthAccessFingerprint(access));
		const fenced = await this.enqueueProvider(providerId, async () => this.withLock((data, authPath, assertLock) => {
			const current = asCredential(asStoredCredential(data[providerId]));
			if (!current || current.type !== "oauth" || current.access !== access || (refresh !== undefined && current.refresh !== refresh)) return { result: false };
			this.persistRejectedOAuthCredential(authPath, providerId, access);
			assertLock();
			return { result: true, next: { ...data, [providerId]: rejectedOAuthTombstone(access) } };
		}));
		if (fenced) this.didChange();
		return fenced;
	}

	async invalidateRejectedOAuthCredential(providerId: string, access: string, refresh?: string): Promise<boolean> {
		if (!access) return false;
		// Keep lock-acquisition/write failures fail-closed for this exact bearer
		// without letting a stale rejection erase another rejected value.
		rememberRejectedOAuthFingerprint(this.authPath, providerId, oauthAccessFingerprint(access));
		const invalidated = await this.enqueueProvider(providerId, async () => this.withLock((data, authPath, assertLock) => {
			const current = asCredential(asStoredCredential(data[providerId]));
			if (!current || current.type !== "oauth" || current.access !== access || (refresh !== undefined && current.refresh !== refresh)) return { result: false };
			this.persistRejectedOAuthCredential(authPath, providerId, access);
			assertLock();
			// Do not delete this row. A separate Pi host reads raw auth.json and
			// cannot observe Bobbit's sidecar fence; the tombstone owns this provider
			// while carrying neither an access nor a renewable refresh credential.
			return { result: true, next: { ...data, [providerId]: rejectedOAuthTombstone(access) } };
		}));
		if (invalidated) {
			this.rollbackHistory.delete(providerId);
			this.didChange();
		}
		return invalidated;
	}

	/**
	 * Delete only a rejected OAuth row or its non-secret tombstone.
	 *
	 * Saving an explicit API key must recover from a rejected OAuth login without
	 * deleting a healthy account credential for the same provider.
	 */
	async deleteRejectedOAuthCredential(providerId: string): Promise<boolean> {
		const deleted = await this.enqueueProvider(providerId, async () => this.withLock((data, authPath) => {
			const rawCurrent = data[providerId];
			const current = asCredential(asStoredCredential(rawCurrent));
			if (!isRejectedOAuthTombstone(rawCurrent)
				&& !(current && isStoredOAuthCredentialRejected(authPath, providerId, current))) {
				return { result: false };
			}
			const next = { ...data };
			delete next[providerId];
			return { result: true, next };
		}));
		if (deleted) {
			this.rollbackHistory.delete(providerId);
			this.didChange();
		}
		return deleted;
	}

	/** True when the raw provider slot is a removable, non-secret OAuth tombstone. */
	hasRejectedOAuthTombstoneSync(providerId: string): boolean {
		try {
			return existsSync(this.authPath) && isRejectedOAuthTombstone(this.readCurrent()[providerId]);
		} catch {
			return false;
		}
	}

	/** Delete a raw OAuth row or non-secret rejection tombstone for this provider. */
	async deleteOAuthCredential(providerId: string): Promise<boolean> {
		const deleted = await this.enqueueProvider(providerId, async () => this.withLock((data) => {
			const current = asStoredCredential(data[providerId]);
			if (current?.type !== "oauth" && !isRejectedOAuthTombstone(data[providerId])) return { result: false };
			const next = { ...data };
			delete next[providerId];
			return { result: true, next };
		}));
		if (deleted) {
			this.rollbackHistory.delete(providerId);
			this.didChange();
		}
		return deleted;
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
