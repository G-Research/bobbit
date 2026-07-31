import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

interface ProperLockfile {
	lock(
		path: string,
		options: {
			retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number; randomize: boolean };
			stale: number;
			onCompromised: (error: Error) => void;
		},
	): Promise<() => Promise<void>>;
}

// Share Pi's proper-lockfile namespace and retry contract. This is a direct
// dependency rather than an import of Pi's private auth-storage implementation,
// whose package export is intentionally not public.
const lockfile = createRequire(import.meta.url)("proper-lockfile") as ProperLockfile;

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const LOCK_STALE_MS = 30_000;
export const deleteCredential = Symbol("delete credential");

type RawAuthData = Record<string, unknown>;
export type CredentialMutation = Credential | typeof deleteCredential | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCredential(value: unknown): Credential | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type !== "oauth" && value.type !== "api_key") return undefined;
	return value as unknown as Credential;
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

/**
 * A fresh-reading, mutation-locked, atomic auth.json CredentialStore.
 *
 * Pi's built-in store and this adapter coordinate through proper-lockfile's
 * `<auth.json>.lock` directory. Pi currently writes its own file in place;
 * Bobbit cannot make an external Pi process atomic, but every Bobbit mutation
 * uses a same-directory temporary file, fsync, and atomic rename.
 */
export class AtomicCredentialStore implements CredentialStore {
	readonly authPath: string;
	private readonly onDidChange?: () => void;
	private fileQueue: Promise<void> = Promise.resolve();
	private readonly providerQueues = new Map<string, Promise<void>>();

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

	private readCurrent(): RawAuthData {
		return parseAuthData(readFileSync(this.authPath, "utf8"));
	}

	private atomicWrite(data: RawAuthData): void {
		const directory = dirname(this.authPath);
		const temporaryPath = join(
			directory,
			`.${basename(this.authPath)}.bobbit-${process.pid}-${randomUUID()}.tmp`,
		);
		let fd: number | undefined;
		try {
			fd = openSync(temporaryPath, "wx", FILE_MODE);
			writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8" });
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			bestEffortChmod(temporaryPath, FILE_MODE);
			renameSync(temporaryPath, this.authPath);
			bestEffortChmod(this.authPath, FILE_MODE);

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
		let compromised: Error | undefined;
		// Deliberately use proper-lockfile's default realpath:true, matching Pi's
		// async auth mutation path. This makes a symlinked/junction agent directory
		// coordinate on the same canonical <auth.json>.lock directory.
		const release = await lockfile.lock(this.authPath, {
			retries: {
				retries: 10,
				factor: 2,
				minTimeout: 100,
				maxTimeout: 10_000,
				randomize: true,
			},
			stale: LOCK_STALE_MS,
			onCompromised: (error) => {
				compromised = error;
			},
		});
		try {
			if (compromised) throw new Error("Credential store lock was compromised", { cause: compromised });
			const { result, next } = await fn(this.readCurrent());
			if (compromised) throw new Error("Credential store lock was compromised", { cause: compromised });
			if (next !== undefined) {
				this.atomicWrite(next);
				if (compromised) throw new Error("Credential store lock was compromised", { cause: compromised });
			}
			return result;
		} finally {
			try {
				await release();
			} catch {
				// A compromised lock is already reported above; unlock errors must
				// not replace the original storage result or exception.
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
			const result = await this.withLock(async (data) => {
				const current = asCredential(data[providerId]);
				const mutation = await fn(current);
				if (mutation === undefined) return { result: current };

				const next = { ...data };
				if (mutation === deleteCredential) {
					if (!(providerId in next)) return { result: undefined };
					delete next[providerId];
					changed = true;
					return { result: undefined, next };
				}
				next[providerId] = mutation;
				changed = true;
				return { result: mutation, next };
			});
			if (changed) this.didChange();
			return result;
		});
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.mutate(providerId, fn);
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
			if (changed) this.didChange();
		});
	}
}
