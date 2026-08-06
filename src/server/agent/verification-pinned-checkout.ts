import { constants, readFileSync, type Stats } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readlink,
	readdir,
	realpath,
	rename,
	stat,
	symlink,
	unlink,
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { realCommandRunner, type CommandRunner } from "../gateway-deps.js";
import type { GateSignal } from "./gate-store.js";
import { verificationCheckoutProjectDir, verificationCheckoutProjectScope } from "./verification-checkout-scope.js";
import {
	computeVerificationContentDigestFromInventory,
	readVerificationSourceInventory,
	type VerificationContentDigest,
	type VerificationSourceInventoryEntry,
} from "./verification-content-digest.js";

export type PinnedCheckoutState = "preparing" | "ready" | "releasing";
export type PinnedCheckoutErrorCode =
	| "PINNED_CHECKOUT_ACQUIRE_FAILED"
	| "PINNED_CHECKOUT_MUTATED"
	| "PINNED_CHECKOUT_UNREADABLE"
	| "PINNED_CHECKOUT_UNSUPPORTED_LAYOUT";

type CleanupErrorCode = "GIT_REMOVE_FAILED" | "PATH_BUSY";

export interface PinnedCheckout {
	id: string;
	/** Authoritative project owner; never derived from a goal or caller path. */
	projectId: string;
	sourceRoot: string;
	repoRoot: string;
	path: string;
	commitSha: string;
	contentDigest: VerificationContentDigest;
}

/**
 * Boundary consumed by verification execution. Production owns the real Git
 * implementation; test gateways may inject a lifecycle-faithful fake.
 */
export interface PinnedCheckoutManager {
	acquire(input: { signal: GateSignal; sourceRoot: string; projectId: string }): Promise<PinnedCheckout>;
	assertUnchanged(checkout: PinnedCheckout): Promise<void>;
	release(signalId: string, projectId: string): Promise<void>;
	/** Map signal IDs to their authoritative project owners during restart recovery. */
	recover(activeSignals: ReadonlyMap<string, string>): Promise<void>;
	resume(signalId: string, projectId: string): Promise<PinnedCheckout>;
}

/** Durable, server-owned operational state. Do not expose this through gate APIs. */
export interface PinnedCheckoutLease {
	signalId: string;
	/** Durable ownership boundary for the project-scoped checkout path. */
	projectId: string;
	goalId: string;
	gateId: string;
	state: PinnedCheckoutState;
	checkoutPath: string;
	sourceRoot: string;
	repoRoot: string;
	commitSha: string;
	createdAt: number;
	digest?: VerificationContentDigest;
	/**
	 * Exact inventory materialized into this lease. Persist it so restart
	 * verification never reinterprets an empty detached-worktree index.
	 */
	sourceInventory?: PersistedVerificationSourceInventoryEntry[];
	cleanupAttempts: number;
	lastCleanupErrorCode?: CleanupErrorCode;
}

export class PinnedCheckoutError extends Error {
	constructor(readonly code: PinnedCheckoutErrorCode, message: string) {
		super(message);
		this.name = "PinnedCheckoutError";
	}
}

export interface VerificationPinnedCheckoutManagerOptions {
	commandRunner?: CommandRunner;
	readInventory?: (root: string, runner: CommandRunner) => Promise<VerificationSourceInventoryEntry[]>;
	now?: () => number;
}

/** JSON-safe raw filename preservation for durable pinned-checkout leases. */
export interface PersistedVerificationSourceInventoryEntry {
	relativePath: string;
	rawPathBase64: string;
	membership: VerificationSourceInventoryEntry["membership"];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Verification executes npm/package-manager scripts from the frozen checkout.
 * Only this top-level dependency directory is deliberately shared from the
 * source worktree, and only when Git says it is ignored. Its bytes remain
 * outside the D-1/D-3 source digest by design.
 */
/** Narrow allowlist shared with sandbox remapping; never derive names from the source tree. */
export const EXPOSED_IGNORED_SETUP_DIRECTORIES = ["node_modules"] as const;

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameIdentity(left: Stats, right: Stats): boolean {
	return Number.isSafeInteger(left.dev) && Number.isSafeInteger(left.ino)
		&& Number.isSafeInteger(right.dev) && Number.isSafeInteger(right.ino)
		&& left.dev === right.dev && left.ino === right.ino;
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	return env;
}

function checkoutDigestIsValid(value: unknown): value is VerificationContentDigest {
	const digest = value as VerificationContentDigest | undefined;
	return digest?.algorithm === "sha256" && digest.version === 1
		&& typeof digest.digest === "string" && /^[0-9a-f]{64}$/i.test(digest.digest)
		&& Number.isSafeInteger(digest.fileCount) && digest.fileCount >= 0;
}

function persistInventory(entries: readonly VerificationSourceInventoryEntry[]): PersistedVerificationSourceInventoryEntry[] {
	return entries.map(entry => ({
		relativePath: entry.relativePath,
		rawPathBase64: entry.rawPath.toString("base64"),
		membership: entry.membership,
	}));
}

/** Reject malformed persisted leases before they can select a filesystem path. */
function restoreInventory(value: unknown): VerificationSourceInventoryEntry[] {
	if (!Array.isArray(value)) throw new Error("missing source inventory");
	const restored: VerificationSourceInventoryEntry[] = [];
	const paths = new Set<string>();
	for (const candidate of value) {
		if (!candidate || typeof candidate !== "object") throw new Error("invalid source inventory");
		const entry = candidate as PersistedVerificationSourceInventoryEntry;
		if (typeof entry.relativePath !== "string" || typeof entry.rawPathBase64 !== "string"
			|| (entry.membership !== "tracked" && entry.membership !== "untracked")) throw new Error("invalid source inventory");
		const rawPath = Buffer.from(entry.rawPathBase64, "base64");
		if (!rawPath.length || rawPath.toString("base64") !== entry.rawPathBase64) throw new Error("invalid source inventory");
		let decoded: string;
		try { decoded = utf8.decode(rawPath); } catch { throw new Error("invalid source inventory"); }
		if (decoded !== entry.relativePath || !entry.relativePath || entry.relativePath.includes("\0")
			|| (process.platform === "win32" && entry.relativePath.includes("\\"))
			|| path.posix.isAbsolute(entry.relativePath)) throw new Error("invalid source inventory");
		const normalized = path.posix.normalize(entry.relativePath);
		if (normalized !== entry.relativePath || normalized === "." || normalized === ".." || normalized.startsWith("../")
			|| paths.has(entry.relativePath)) throw new Error("invalid source inventory");
		paths.add(entry.relativePath);
		restored.push({ relativePath: entry.relativePath, rawPath, membership: entry.membership });
	}
	return restored;
}

/**
 * A signal-owned detached Git worktree whose materialized bytes are the D-1
 * source inventory, not a filter-transformed checkout. The manager is the only
 * owner of state paths and Git worktree lifecycle operations.
 */
export class VerificationPinnedCheckoutManager implements PinnedCheckoutManager {
	private readonly commandRunner: CommandRunner;
	private readonly inventory: (root: string, runner: CommandRunner) => Promise<VerificationSourceInventoryEntry[]>;
	private readonly now: () => number;
	private readonly leases = new Map<string, PinnedCheckoutLease>();
	private readonly stateDir: string;
	private readonly checkoutRoot: string;
	private readonly stateFile: string;
	private checkoutRootCanonical: string | undefined;
	private operations: Promise<void> = Promise.resolve();

	constructor(stateDir: string, options: VerificationPinnedCheckoutManagerOptions = {}) {
		this.stateDir = path.resolve(stateDir);
		this.checkoutRoot = path.join(this.stateDir, "verification-checkouts");
		this.stateFile = path.join(this.stateDir, "verification-checkouts.json");
		this.commandRunner = options.commandRunner ?? realCommandRunner;
		this.inventory = options.readInventory ?? readVerificationSourceInventory;
		this.now = options.now ?? Date.now;
		this.load();
	}

	/** A low-risk aggregate for maintenance diagnostics. */
	getDiagnostics(): { leaseCount: number; cleanupPending: number } {
		let cleanupPending = 0;
		for (const lease of this.leases.values()) if (lease.state === "releasing") cleanupPending++;
		return { leaseCount: this.leases.size, cleanupPending };
	}

	/** Snapshot copy prevents callers from mutating manager state. */
	getLease(signalId: string): PinnedCheckoutLease | undefined {
		const lease = this.leases.get(signalId);
		return lease ? {
			...lease,
			digest: lease.digest && { ...lease.digest },
			sourceInventory: lease.sourceInventory?.map(entry => ({ ...entry })),
		} : undefined;
	}

	async acquire(input: { signal: GateSignal; sourceRoot: string; projectId: string }): Promise<PinnedCheckout> {
		return this.serialized(async () => {
			const signal = input.signal;
			const projectScope = verificationCheckoutProjectScope(input.projectId);
			if (!projectScope || !UUID.test(signal.id) || !COMMIT_SHA.test(signal.commitSha) || signal.commitSha === "unknown") {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
			}
			const existing = this.leases.get(signal.id);
			if (existing && existing.projectId !== input.projectId) {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
			}
			if (existing?.state === "ready") {
				const checkout = await this.checkoutFromLease(existing);
				await this.assertUnchangedInternal(checkout);
				return checkout;
			}
			if (existing) await this.releaseInternal(existing);

			let sourceRoot: string;
			let repoRoot: string;
			try {
				sourceRoot = await realpath(input.sourceRoot);
				const sourceStats = await lstat(sourceRoot);
				if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) throw new Error("unsafe source root");
				repoRoot = await this.gitTopLevel(sourceRoot);
				if (sourceRoot !== repoRoot) throw new PinnedCheckoutError("PINNED_CHECKOUT_UNSUPPORTED_LAYOUT", "Pinned checkout requires a single repository root");
				await this.assertCommit(repoRoot, signal.commitSha);
				await this.ensureCheckoutRoot(sourceRoot);
			} catch (error) {
				if (error instanceof PinnedCheckoutError) throw error;
				throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
			}

			let target: string;
			try {
				target = await this.targetPath(input.projectId, signal.id);
			} catch {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
			}
			try {
				await lstat(target);
				throw new Error("target exists");
			} catch (error) {
				if (!isMissing(error)) {
					throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
				}
			}
			let sourceInventory: VerificationSourceInventoryEntry[];
			try {
				sourceInventory = await this.inventory(sourceRoot, this.secureRunner());
			} catch {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
			}
			const lease: PinnedCheckoutLease = {
				signalId: signal.id, projectId: input.projectId, goalId: signal.goalId, gateId: signal.gateId, state: "preparing",
				checkoutPath: target, sourceRoot, repoRoot, commitSha: signal.commitSha.toLowerCase(),
				createdAt: this.now(), sourceInventory: persistInventory(sourceInventory), cleanupAttempts: 0,
			};
			this.leases.set(lease.signalId, lease);
			try { await this.persist(); }
			catch {
				this.leases.delete(lease.signalId);
				throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
			}
			try {
				await this.execGit(["-c", "core.hooksPath=", "-C", repoRoot, "worktree", "add", "--detach", "--no-checkout", target, lease.commitSha]);
				await this.materialize(sourceRoot, target, sourceInventory);
				await this.exposeIgnoredSetupDirectories(sourceRoot, target);
				const contentDigest = await computeVerificationContentDigestFromInventory(target, sourceInventory);
				await this.makeReadOnly(target);
				lease.digest = contentDigest;
				lease.state = "ready";
				await this.persist();
				return { id: lease.signalId, projectId: lease.projectId, sourceRoot, repoRoot, path: target, commitSha: lease.commitSha, contentDigest };
			} catch (error) {
				await this.releaseInternal(lease);
				if (error instanceof PinnedCheckoutError) throw error;
				throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
			}
		});
	}

	async assertUnchanged(checkout: PinnedCheckout): Promise<void> {
		return this.serialized(() => this.assertUnchangedInternal(checkout));
	}

	/** Restore the durable ready checkout for restart recovery without consulting mutable source bytes. */
	async resume(signalId: string, projectId: string): Promise<PinnedCheckout> {
		return this.serialized(async () => {
			const lease = this.leases.get(signalId);
			if (!lease || lease.projectId !== projectId || lease.state !== "ready") {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout is unavailable");
			}
			const checkout = await this.checkoutFromLease(lease);
			await this.assertUnchangedInternal(checkout);
			return checkout;
		});
	}

	async release(signalId: string, projectId: string): Promise<void> {
		return this.serialized(async () => {
			const lease = this.leases.get(signalId);
			if (!lease) return;
			if (lease.projectId !== projectId) {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout is unavailable");
			}
			await this.releaseInternal(lease);
		});
	}

	/** Remove interrupted/orphaned state without ever sweeping unrelated worktrees. */
	async recover(activeSignals: ReadonlyMap<string, string>): Promise<void> {
		return this.serialized(async () => {
			for (const lease of [...this.leases.values()]) {
				if (lease.state === "ready" && activeSignals.get(lease.signalId) === lease.projectId) continue;
				await this.releaseInternal(lease);
			}
		});
	}

	private async assertUnchangedInternal(checkout: PinnedCheckout): Promise<void> {
		const lease = this.leases.get(checkout.id);
		if (!lease || lease.state !== "ready") throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout is unavailable");
		try {
			const restored = await this.checkoutFromLease(lease);
			if (restored.path !== checkout.path || restored.projectId !== checkout.projectId || restored.commitSha !== checkout.commitSha) throw new Error("mismatched checkout");
			const sourceInventory = restoreInventory(lease.sourceInventory);
			const actual = await computeVerificationContentDigestFromInventory(restored.path, sourceInventory);
			await this.assertNoSourceAdditions(restored.path, sourceInventory);
			if (!checkoutDigestIsValid(lease.digest) || checkout.contentDigest.digest !== lease.digest.digest
				|| actual.digest !== lease.digest.digest || actual.fileCount !== lease.digest.fileCount) {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_MUTATED", "Pinned checkout changed during verification");
			}
		} catch (error) {
			if (error instanceof PinnedCheckoutError) throw error;
			throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout could not be read");
		}
	}

	private async checkoutFromLease(lease: PinnedCheckoutLease): Promise<PinnedCheckout> {
		if (!checkoutDigestIsValid(lease.digest) || lease.state !== "ready") throw new Error("incomplete lease");
		restoreInventory(lease.sourceInventory);
		const target = await this.validateLease(lease);
		return {
			id: lease.signalId, projectId: lease.projectId, sourceRoot: lease.sourceRoot, repoRoot: lease.repoRoot, path: target,
			commitSha: lease.commitSha, contentDigest: { ...lease.digest },
		};
	}

	private async releaseInternal(lease: PinnedCheckoutLease): Promise<void> {
		lease.state = "releasing";
		await this.persist();
		try {
			const target = await this.validateLease(lease);
			await this.makeWritable(target);
			await this.execGit(["-c", "core.hooksPath=", "-C", lease.repoRoot, "worktree", "remove", "--force", target]);
			this.leases.delete(lease.signalId);
			await this.persist();
		} catch (error) {
			lease.cleanupAttempts++;
			lease.lastCleanupErrorCode = (error as NodeJS.ErrnoException | undefined)?.code === "EBUSY" ? "PATH_BUSY" : "GIT_REMOVE_FAILED";
			await this.persist();
		}
	}

	private async materialize(sourceRoot: string, targetRoot: string, inventory: readonly VerificationSourceInventoryEntry[]): Promise<void> {
		for (const entry of inventory) await this.copyEntry(sourceRoot, targetRoot, entry);
	}

	/**
	 * A --no-checkout worktree may have an empty per-worktree index. Read its
	 * current Git inventory only to discover non-ignored additions, then bind
	 * every known path to the durable inventory that was copied into the lease.
	 */
	private async assertNoSourceAdditions(targetRoot: string, sourceInventory: readonly VerificationSourceInventoryEntry[]): Promise<void> {
		const known = new Set(sourceInventory.map(entry => entry.relativePath));
		const observed = await this.inventory(targetRoot, this.secureRunner());
		for (const entry of observed) {
			if (!known.has(entry.relativePath)) {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_MUTATED", "Pinned checkout changed during verification");
			}
		}
	}

	/**
	 * Let host-side package scripts resolve their already-installed dependencies
	 * without copying mutable, ignored output into the frozen source snapshot.
	 * The source candidate must be an ignored, real top-level directory. A
	 * symlink, replacement race, or non-directory fails closed rather than
	 * creating a pinned checkout that points outside its source root.
	 */
	private async exposeIgnoredSetupDirectories(sourceRoot: string, targetRoot: string): Promise<void> {
		for (const name of EXPOSED_IGNORED_SETUP_DIRECTORIES) {
			if (!await this.isIgnoredTopLevelDirectory(sourceRoot, name)) continue;
			const source = path.join(sourceRoot, name);
			const target = path.join(targetRoot, name);
			let before: Stats;
			try {
				before = await lstat(source);
			} catch (error) {
				if (isMissing(error)) continue;
				throw error;
			}
			if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("unsafe ignored setup directory");
			const canonicalSource = await realpath(source);
			if (!isWithin(sourceRoot, canonicalSource)) throw new Error("ignored setup directory escape");
			try {
				await lstat(target);
				throw new Error("setup directory collides with materialized source");
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
			try {
				await symlink(canonicalSource, target, process.platform === "win32" ? "junction" : "dir");
				const [linkedTarget, after] = await Promise.all([realpath(target), lstat(source)]);
				if (linkedTarget !== canonicalSource || !after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)) {
					throw new Error("ignored setup directory changed during exposure");
				}
				// stat follows the just-created link and binds it to the directory checked above.
				if (!sameIdentity(before, await stat(target))) throw new Error("ignored setup directory changed during exposure");
			} catch (error) {
				try { await unlink(target); } catch (cleanupError) { if (!isMissing(cleanupError)) throw cleanupError; }
				throw error;
			}
		}
	}

	private async isIgnoredTopLevelDirectory(sourceRoot: string, name: string): Promise<boolean> {
		// `--` binds the constant directory name as a path, and omitting
		// `--no-index` ensures a tracked path cannot be treated as ignored.
		try {
			await this.execGit(["-C", sourceRoot, "check-ignore", "--quiet", "--", name]);
			return true;
		} catch (error) {
			const exitCode = (error as { code?: string | number } | undefined)?.code;
			if (exitCode === 1 || exitCode === "1") return false;
			throw error;
		}
	}

	private async copyEntry(sourceRoot: string, targetRoot: string, entry: VerificationSourceInventoryEntry): Promise<void> {
		const source = this.inventoryPath(sourceRoot, entry.relativePath);
		const target = this.inventoryPath(targetRoot, entry.relativePath);
		await this.assertDirectoryAncestors(sourceRoot, source);
		try {
			const info = await lstat(source);
			if (info.isFile()) return this.copyFile(sourceRoot, source, targetRoot, target);
			if (info.isSymbolicLink()) return this.copySymlink(sourceRoot, source, targetRoot, target);
			throw new Error("special source entry");
		} catch (error) {
			if (isMissing(error) && entry.membership === "tracked") {
				try { await unlink(target); } catch (unlinkError) { if (!isMissing(unlinkError)) throw unlinkError; }
				return;
			}
			throw error;
		}
	}

	private async copyFile(sourceRoot: string, source: string, targetRoot: string, target: string): Promise<void> {
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const sourceHandle = await open(source, constants.O_RDONLY | noFollow);
		try {
			const opened = await sourceHandle.stat();
			if (!opened.isFile() || opened.isSymbolicLink()) throw new Error("unsafe source file");
			await this.assertDirectoryAncestors(sourceRoot, source);
			const named = await lstat(source);
			if (!named.isFile() || named.isSymbolicLink() || !sameIdentity(opened, named)) throw new Error("source replacement");
			await this.ensureTargetParents(targetRoot, target);
			const targetHandle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
			try {
				const buffer = Buffer.allocUnsafe(64 * 1024);
				let position = 0;
				while (true) {
					const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
					if (bytesRead === 0) break;
					let written = 0;
					while (written < bytesRead) {
						const result = await targetHandle.write(buffer, written, bytesRead - written, position + written);
						if (result.bytesWritten <= 0) throw new Error("short target write");
						written += result.bytesWritten;
					}
					position += bytesRead;
				}
			} finally { await targetHandle.close(); }
			const after = await lstat(source);
			if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(opened, after)) throw new Error("source replacement");
			await chmod(target, (opened.mode & 0o111) ? 0o755 : 0o644);
		} finally { await sourceHandle.close(); }
	}

	private async copySymlink(sourceRoot: string, source: string, targetRoot: string, target: string): Promise<void> {
		const before = await lstat(source);
		if (!before.isSymbolicLink()) throw new Error("source replacement");
		const rawTarget = await readlink(source, { encoding: "buffer" }) as Buffer;
		let text: string;
		try { text = utf8.decode(rawTarget); } catch { throw new Error("invalid symlink target"); }
		const resolved = path.resolve(path.dirname(source), text);
		if (!isWithin(sourceRoot, resolved)) throw new Error("symlink escape");
		await this.assertDirectoryAncestors(sourceRoot, resolved);
		try { if ((await lstat(resolved)).isSymbolicLink()) throw new Error("symlink chain"); } catch (error) { if (!isMissing(error)) throw error; }
		await this.ensureTargetParents(targetRoot, target);
		await symlink(rawTarget, target);
		const after = await lstat(source);
		if (!after.isSymbolicLink() || !sameIdentity(before, after)) throw new Error("source replacement");
	}

	private inventoryPath(root: string, relative: string): string {
		const target = path.resolve(root, relative.split("/").join(path.sep));
		if (!isWithin(root, target)) throw new Error("inventory escape");
		return target;
	}

	private async assertDirectoryAncestors(root: string, leaf: string): Promise<void> {
		if (!isWithin(root, leaf)) throw new Error("path escape");
		const rootStats = await lstat(root);
		if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("unsafe root");
		let cursor = root;
		for (const segment of path.relative(root, leaf).split(path.sep).slice(0, -1)) {
			cursor = path.join(cursor, segment);
			const info = await lstat(cursor);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe ancestor");
		}
	}

	private async ensureTargetParents(root: string, leaf: string): Promise<void> {
		if (!isWithin(root, leaf)) throw new Error("target escape");
		let cursor = root;
		for (const segment of path.relative(root, leaf).split(path.sep).slice(0, -1)) {
			cursor = path.join(cursor, segment);
			await mkdir(cursor, { recursive: false }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
			const info = await lstat(cursor);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe target ancestor");
		}
	}

	private async makeReadOnly(root: string): Promise<void> {
		await this.walkSafe(root, async (entry, info) => {
			// Source files are a best-effort guardrail, while writable directories let
			// verification tools create ignored build output. The digest remains the
			// authoritative mutation boundary for every non-ignored source path.
			if (info.isDirectory()) await chmod(entry, 0o755);
			else if (info.isFile()) await chmod(entry, (info.mode & 0o111) ? 0o555 : 0o444);
		});
	}

	private async makeWritable(root: string): Promise<void> {
		await this.walkSafe(root, async (entry, info) => {
			if (info.isDirectory()) await chmod(entry, 0o700);
			else if (info.isFile()) await chmod(entry, 0o600);
		});
	}

	/** lstat-based traversal never follows a command-created symlink during cleanup. */
	private async walkSafe(root: string, visit: (entry: string, info: Stats) => Promise<void>): Promise<void> {
		const info = await lstat(root);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe checkout root");
		const descend = async (directory: string): Promise<void> => {
			for (const name of await readdir(directory)) {
				const entry = path.join(directory, name);
				if (!isWithin(root, entry)) throw new Error("checkout escape");
				const child = await lstat(entry);
				if (child.isDirectory() && !child.isSymbolicLink()) await descend(entry);
				await visit(entry, child);
			}
			await visit(directory, await lstat(directory));
		};
		await descend(root);
	}

	private async gitTopLevel(sourceRoot: string): Promise<string> {
		const result = await this.execGit(["-C", sourceRoot, "rev-parse", "--show-toplevel"]);
		const output = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
		return realpath(output.trim());
	}

	private async assertCommit(repoRoot: string, expected: string): Promise<void> {
		const result = await this.execGit(["-C", repoRoot, "rev-parse", "--verify", "HEAD^{commit}"]);
		const output = (Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout).trim().toLowerCase();
		if (!COMMIT_SHA.test(output) || output !== expected.toLowerCase()) throw new Error("commit mismatch");
	}

	private secureRunner(): CommandRunner {
		return { execFile: (file, args, options) => this.commandRunner.execFile(file, args, { ...options, env: sanitizedGitEnvironment() }) };
	}

	private execGit(args: string[]) {
		return this.commandRunner.execFile("git", args, { env: sanitizedGitEnvironment(), timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
	}

	private async targetPath(projectId: string, signalId: string): Promise<string> {
		if (!UUID.test(signalId)) throw new Error("unsafe signal id");
		const root = this.checkoutRootCanonical ?? this.checkoutRoot;
		const scoped = verificationCheckoutProjectDir(root, projectId);
		if (!scoped || !isWithin(root, scoped)) throw new Error("unsafe project scope");
		try {
			const info = await lstat(scoped);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe project scope");
		} catch (error) {
			if (!isMissing(error)) throw error;
			await mkdir(scoped);
		}
		const canonicalScoped = await realpath(scoped);
		const info = await lstat(canonicalScoped);
		if (!info.isDirectory() || info.isSymbolicLink() || !samePath(canonicalScoped, scoped) || !isWithin(root, canonicalScoped)) throw new Error("unsafe project scope");
		const target = path.resolve(canonicalScoped, signalId);
		if (!isWithin(canonicalScoped, target)) throw new Error("checkout escape");
		return target;
	}

	private async ensureCheckoutRoot(sourceRoot: string): Promise<void> {
		await mkdir(this.checkoutRoot, { recursive: true });
		const canonical = await realpath(this.checkoutRoot);
		const info = await lstat(canonical);
		if (!info.isDirectory() || info.isSymbolicLink() || isWithin(sourceRoot, canonical)) throw new Error("unsafe checkout root");
		this.checkoutRootCanonical = canonical;
	}

	private async validateLease(lease: PinnedCheckoutLease): Promise<string> {
		if (!verificationCheckoutProjectScope(lease.projectId) || !UUID.test(lease.signalId) || !COMMIT_SHA.test(lease.commitSha) || !checkoutDigestIsValid(lease.digest) && lease.state === "ready") throw new Error("invalid lease");
		await this.ensureCheckoutRoot(lease.sourceRoot);
		const source = await realpath(lease.sourceRoot);
		const repo = await realpath(lease.repoRoot);
		if (source !== lease.sourceRoot || repo !== lease.repoRoot || source !== repo) throw new Error("changed lease root");
		const target = await this.targetPath(lease.projectId, lease.signalId);
		if (target !== lease.checkoutPath) throw new Error("changed lease path");
		return target;
	}

	private load(): void {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.stateFile, "utf8"));
			if (!Array.isArray(parsed)) return;
			for (const candidate of parsed) {
				if (!candidate || typeof candidate !== "object") continue;
				const lease = candidate as PinnedCheckoutLease;
				if (typeof lease.signalId === "string" && typeof lease.projectId === "string" && typeof lease.checkoutPath === "string" && typeof lease.sourceRoot === "string" && typeof lease.repoRoot === "string") {
					this.leases.set(lease.signalId, lease);
				}
			}
		} catch { /* absent/corrupt state is recovered by future acquisition, never trusted for deletion */ }
	}

	private async persist(): Promise<void> {
		const payload = JSON.stringify([...this.leases.values()]);
		const temporary = `${this.stateFile}.tmp`;
		await mkdir(this.stateDir, { recursive: true });
		const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
		try {
			await file.writeFile(payload, "utf8");
			await file.sync();
		} finally { await file.close(); }
		await rename(temporary, this.stateFile);
		// Directory fsync is not available on all Windows filesystems. The rename
		// remains atomic there; Unix gets the stronger crash-publication barrier.
		try {
			const directory = await open(this.stateDir, constants.O_RDONLY);
			try { await directory.sync(); } finally { await directory.close(); }
		} catch { /* best effort where directory descriptors are unsupported */ }
	}

	private async serialized<T>(operation: () => Promise<T>): Promise<T> {
		let resolve!: () => void;
		const previous = this.operations;
		this.operations = new Promise<void>(next => { resolve = next; });
		await previous;
		try { return await operation(); }
		finally { resolve(); }
	}
}
