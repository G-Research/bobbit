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
	rm,
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

/** Durable filesystem identity of the one root published for a lease. */
export interface PinnedCheckoutRootIdentity {
	dev: number;
	ino: number;
}

export interface PinnedCheckout {
	id: string;
	/** Authoritative project owner; never derived from a goal or caller path. */
	projectId: string;
	sourceRoot: string;
	repoRoot: string;
	path: string;
	/** Server-private Git worktree containing the immutable source overlay. Never expose this to reviewers or sandboxes. */
	trustedGitCwd?: string;
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
	/** Sandbox-visible, source-only tree. It never contains Git metadata. */
	checkoutPath: string;
	/** Server-private detached Git worktree; never bind-mounted into a sandbox. */
	worktreePath?: string;
	/** `public` is sandbox-visible; `quarantined` is private and safe to audit/remove. */
	publicationState?: "public" | "quarantined";
	/** The exact candidate directory that was atomically published for this signal. */
	publishedRootIdentity?: PinnedCheckoutRootIdentity;
	/** Optional private hard-link anchor for the public `.git` discovery barrier. */
	publicationAnchorPath?: string;
	publicationAnchorIdentity?: PinnedCheckoutRootIdentity;
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

function filesystemIdentity(info: Stats): PinnedCheckoutRootIdentity {
	if (info.isSymbolicLink() || !Number.isSafeInteger(info.dev) || !Number.isSafeInteger(info.ino)) {
		throw new Error("unsafe filesystem identity");
	}
	return { dev: info.dev, ino: info.ino };
}

function rootIdentity(info: Stats): PinnedCheckoutRootIdentity {
	if (!info.isDirectory()) throw new Error("unsafe published checkout root");
	return filesystemIdentity(info);
}

function hasRootIdentity(value: unknown): value is PinnedCheckoutRootIdentity {
	const identity = value as PinnedCheckoutRootIdentity | undefined;
	return Number.isSafeInteger(identity?.dev) && Number.isSafeInteger(identity?.ino);
}

function sameFilesystemIdentity(identity: PinnedCheckoutRootIdentity, info: Stats): boolean {
	return !info.isSymbolicLink() && identity.dev === info.dev && identity.ino === info.ino;
}

function sameRootIdentity(identity: PinnedCheckoutRootIdentity, info: Stats): boolean {
	return info.isDirectory() && sameFilesystemIdentity(identity, info);
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	delete env.GIT_CONFIG_GLOBAL;
	delete env.GIT_CONFIG_SYSTEM;
	return { ...env, GIT_CONFIG_NOSYSTEM: "1" };
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
	/** Public per-project roots are bind-mounted; host code only renames whole signal roots there. */
	private readonly checkoutRoot: string;
	/** All Git, copy, digest, and recursive cleanup work stays in this unmounted root. */
	private readonly privateRoot: string;
	private readonly stateFile: string;
	private checkoutRootCanonical: string | undefined;
	private privateRootCanonical: string | undefined;
	private operations: Promise<void> = Promise.resolve();

	constructor(stateDir: string, options: VerificationPinnedCheckoutManagerOptions = {}) {
		this.stateDir = path.resolve(stateDir);
		this.checkoutRoot = path.join(this.stateDir, "verification-checkouts");
		this.privateRoot = path.join(this.stateDir, "verification-checkouts-private");
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
			publishedRootIdentity: lease.publishedRootIdentity && { ...lease.publishedRootIdentity },
			publicationAnchorIdentity: lease.publicationAnchorIdentity && { ...lease.publicationAnchorIdentity },
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

			let target!: string;
			let worktree!: string;
			let candidate!: string;
			try {
				target = await this.targetPath(input.projectId, signal.id, true);
				worktree = await this.privatePath(input.projectId, signal.id, "worktree");
				candidate = await this.privatePath(input.projectId, signal.id, "candidate");
				for (const location of [target, worktree, candidate]) {
					try { await lstat(location); throw new Error("checkout path exists"); }
					catch (error) { if (!isMissing(error)) throw error; }
				}
			} catch {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
			}
			let sourceInventory: VerificationSourceInventoryEntry[];
			try {
				sourceInventory = await this.inventory(sourceRoot, this.secureRunner());
			} catch {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
			}
			const lease: PinnedCheckoutLease = {
				signalId: signal.id, projectId: input.projectId, goalId: signal.goalId, gateId: signal.gateId, state: "preparing",
				checkoutPath: target, worktreePath: worktree, publicationState: "quarantined", sourceRoot, repoRoot, commitSha: signal.commitSha.toLowerCase(),
				createdAt: this.now(), sourceInventory: persistInventory(sourceInventory), cleanupAttempts: 0,
			};
			this.leases.set(lease.signalId, lease);
			try { await this.persist(); }
			catch {
				this.leases.delete(lease.signalId);
				throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
			}
			try {
				// Git and raw-byte copying only ever touch the private worktree. The public
				// bind mount receives a finished source-only candidate by one rename.
				await this.execGit(["-c", "core.hooksPath=", "-C", repoRoot, "worktree", "add", "--detach", "--no-checkout", worktree, lease.commitSha]);
				await this.materialize(sourceRoot, worktree, sourceInventory);
				await this.materialize(worktree, candidate, sourceInventory);
				await this.exposeIgnoredSetupDirectories(sourceRoot, candidate);
				// An empty root `.git` file stops Git's upward repository discovery
				// in the sandbox-visible candidate. It contains no metadata and is checked
				// as part of every quarantine audit before the tree is republished.
				await this.installPublicGitBarrier(candidate);
				const contentDigest = await computeVerificationContentDigestFromInventory(candidate, sourceInventory);
				await this.makePublicExecutionTree(candidate);
				lease.digest = contentDigest;
				lease.publishedRootIdentity = rootIdentity(await lstat(candidate));
				// Persist identity before the candidate is renamed into the sandbox
				// namespace, so crash recovery never authorizes a replacement root.
				await this.persist();
				await this.publishCandidate(lease, candidate);
				lease.state = "ready";
				lease.publicationState = "public";
				await this.persist();
				return { id: lease.signalId, projectId: lease.projectId, sourceRoot, repoRoot, path: target, trustedGitCwd: worktree, commitSha: lease.commitSha, contentDigest };
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
			// The sandbox-visible tree is never traversed by privileged code. Detach it
			// first, audit the private quarantine, then atomically republish it.
			const audit = await this.quarantinePublic(lease);
			const actual = await computeVerificationContentDigestFromInventory(audit, sourceInventory);
			await this.assertNoSourceAdditions(audit, lease, sourceInventory);
			if (!checkoutDigestIsValid(lease.digest) || checkout.contentDigest.digest !== lease.digest.digest
				|| actual.digest !== lease.digest.digest || actual.fileCount !== lease.digest.fileCount) {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_MUTATED", "Pinned checkout changed during verification");
			}
			await this.republishQuarantine(lease, audit);
		} catch (error) {
			if (error instanceof PinnedCheckoutError) throw error;
			throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout could not be read");
		}
	}

	private async checkoutFromLease(lease: PinnedCheckoutLease): Promise<PinnedCheckout> {
		if (!checkoutDigestIsValid(lease.digest) || lease.state !== "ready") throw new Error("incomplete lease");
		restoreInventory(lease.sourceInventory);
		const target = await this.validateLease(lease);
		// A crash can persist between detach and republish. Restore only the exact
		// recorded private quarantine; resume immediately audits it before execution.
		if (lease.publicationState === "quarantined") await this.republishQuarantine(lease, await this.auditPath(lease.projectId, lease.signalId));
		if (!lease.worktreePath) throw new Error("missing private Git worktree");
		return {
			id: lease.signalId, projectId: lease.projectId, sourceRoot: lease.sourceRoot, repoRoot: lease.repoRoot, path: target,
			trustedGitCwd: lease.worktreePath, commitSha: lease.commitSha, contentDigest: { ...lease.digest },
		};
	}

	/**
	 * Cleanup validates only manager-owned paths. A completed or archived goal may
	 * have removed its repository before recovery runs; that must not strand its
	 * server-owned snapshot. Public roots keep their durable identity check before
	 * every privileged traversal or removal.
	 */
	private async releaseInternal(lease: PinnedCheckoutLease): Promise<void> {
		lease.state = "releasing";
		try {
			await this.persist();
			const paths = await this.cleanupPaths(lease);
			const audit = await this.quarantineForCleanup(lease, paths.target, paths.audit);
			if (audit) await this.removePublishedAudit(lease, audit);
			await this.removePrivateTree(paths.worktree, lease.repoRoot);
			await this.removePrivateTree(paths.candidate);
			this.leases.delete(lease.signalId);
			await this.persist();
		} catch (error) {
			lease.cleanupAttempts++;
			lease.lastCleanupErrorCode = (error as NodeJS.ErrnoException | undefined)?.code === "EBUSY" ? "PATH_BUSY" : "GIT_REMOVE_FAILED";
			try { await this.persist(); } catch { /* retain in-memory retry state */ }
		}
	}

	private async cleanupPaths(lease: PinnedCheckoutLease): Promise<{ target: string; audit: string; worktree: string; candidate: string }> {
		if (!verificationCheckoutProjectScope(lease.projectId) || !UUID.test(lease.signalId)) throw new Error("invalid cleanup lease");
		await this.ensureManagedRoots();
		const target = await this.targetPath(lease.projectId, lease.signalId, true);
		const audit = await this.auditPath(lease.projectId, lease.signalId);
		const candidate = await this.privatePath(lease.projectId, lease.signalId, "candidate");
		const worktree = lease.worktreePath ?? await this.privatePath(lease.projectId, lease.signalId, "worktree");
		const expectedWorktree = await this.privatePath(lease.projectId, lease.signalId, "worktree");
		if (worktree !== expectedWorktree) throw new Error("changed private worktree path");
		return { target, audit, worktree, candidate };
	}

	private async quarantineForCleanup(lease: PinnedCheckoutLease, target: string, audit: string): Promise<string | undefined> {
		const auditInfo = await this.lstatIfPresent(audit);
		const targetInfo = await this.lstatIfPresent(target);
		if (auditInfo) {
			this.assertPublishedRootIdentity(lease, audit, auditInfo);
			if (targetInfo) throw new Error("conflicting checkout roots");
			lease.publicationState = "quarantined";
			await this.persist();
			return audit;
		}
		if (!targetInfo) return undefined;
		await this.makePublishedRootWritable(lease, target, targetInfo);
		await rename(target, audit);
		this.assertPublishedRootIdentity(lease, audit, await lstat(audit));
		lease.publicationState = "quarantined";
		await this.persist();
		return audit;
	}

	/** Clear the public root attribute before moving it into private quarantine. */
	private async makePublishedRootWritable(lease: PinnedCheckoutLease, root: string, info?: Stats): Promise<void> {
		this.assertPublishedRootIdentity(lease, root, info ?? await lstat(root));
		await chmod(root, 0o700);
		this.assertPublishedRootIdentity(lease, root, await lstat(root));
	}

	private async removePublishedAudit(lease: PinnedCheckoutLease, audit: string): Promise<void> {
		this.assertPublishedRootIdentity(lease, audit, await lstat(audit));
		await this.makeWritable(audit);
		// Recheck after chmod: an untrusted replacement must never be traversed or
		// deleted just because it won a pathname race during cleanup.
		this.assertPublishedRootIdentity(lease, audit, await lstat(audit));
		await rm(audit, { recursive: true, force: true });
	}

	private async removePrivateTree(tree: string, repoRoot?: string): Promise<void> {
		const info = await this.lstatIfPresent(tree);
		if (!info) return;
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe private checkout root");
		await this.makeWritable(tree);
		if (repoRoot && await this.isDirectory(repoRoot)) {
			try {
				await this.execGit(["-c", "core.hooksPath=", "-C", repoRoot, "worktree", "remove", "--force", tree]);
			} catch {
				// A failed add or manually pruned registration is recoverable: direct
				// removal below owns the private directory and reclaims the bytes.
			}
		}
		await rm(tree, { recursive: true, force: true });
	}

	private async lstatIfPresent(location: string): Promise<Stats | undefined> {
		try { return await lstat(location); }
		catch (error) { if (isMissing(error)) return undefined; throw error; }
	}

	private async isDirectory(location: string): Promise<boolean> {
		try {
			const info = await lstat(location);
			return info.isDirectory() && !info.isSymbolicLink();
		} catch (error) {
			if (isMissing(error)) return false;
			throw error;
		}
	}

	private assertPublishedRootIdentity(lease: PinnedCheckoutLease, location: string, info: Stats): void {
		if (!hasRootIdentity(lease.publishedRootIdentity) || !sameRootIdentity(lease.publishedRootIdentity, info)) {
			throw new Error(`published checkout root identity changed: ${location}`);
		}
	}

	private async materialize(sourceRoot: string, targetRoot: string, inventory: readonly VerificationSourceInventoryEntry[]): Promise<void> {
		// `git worktree add` creates the private worktree root, but the plain
		// source-only candidate deliberately has no Git command creating it first.
		// Claim this unmounted root before copyEntry opens any child pathname.
		try {
			const info = await lstat(targetRoot);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe materialization root");
		} catch (error) {
			if (!isMissing(error)) throw error;
			await mkdir(targetRoot, { mode: 0o700 });
			const info = await lstat(targetRoot);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe materialization root");
		}
		for (const entry of inventory) await this.copyEntry(sourceRoot, targetRoot, entry);
	}

	/**
	 * The published tree is sandbox-writable. It has already been renamed into
	 * private quarantine when this runs, so neither this traversal nor Git sees a
	 * sandbox namespace. `--no-index` checks the private detached worktree's
	 * frozen ignore rules without consulting the quarantined tree as a Git cwd.
	 */
	private async assertNoSourceAdditions(targetRoot: string, lease: PinnedCheckoutLease, sourceInventory: readonly VerificationSourceInventoryEntry[]): Promise<void> {
		const known = new Set(sourceInventory.map(entry => entry.relativePath));
		const ancestors = new Set<string>();
		for (const entry of known) {
			let parent = path.posix.dirname(entry);
			while (parent !== ".") { ancestors.add(parent); parent = path.posix.dirname(parent); }
		}
		const inspect = async (directory: string, relative = ""): Promise<void> => {
			for (const name of await readdir(directory)) {
				const child = path.join(directory, name);
				const childRelative = relative ? `${relative}/${name}` : name;
				const info = await lstat(child);
				if (known.has(childRelative) || ancestors.has(childRelative)) {
					if (info.isDirectory() && !info.isSymbolicLink()) await inspect(child, childRelative);
					continue;
				}
				if (childRelative === ".git") {
					await this.assertPublicGitBarrier(targetRoot);
					continue;
				}
				if (EXPOSED_IGNORED_SETUP_DIRECTORIES.includes(childRelative as typeof EXPOSED_IGNORED_SETUP_DIRECTORIES[number])) continue;
				// Git's ignore engine distinguishes a directory path (`ignored/`) from
				// a plain name (`ignored`); preserve the quarantined entry's marker while
				// asking only the trusted private worktree for the frozen rule.
				if (!await this.isIgnoredPrivatePath(lease, childRelative, info.isDirectory() && !info.isSymbolicLink())) {
					throw new PinnedCheckoutError("PINNED_CHECKOUT_MUTATED", "Pinned checkout changed during verification");
				}
				// A matching ignored directory needs no source traversal below it.
			}
		};
		await inspect(targetRoot);
	}

	private async isIgnoredPrivatePath(lease: PinnedCheckoutLease, relativePath: string, directory: boolean): Promise<boolean> {
		const worktree = lease.worktreePath;
		if (!worktree) return false;
		const ignorePath = directory ? `${relativePath}/` : relativePath;
		try {
			await this.execGit(["-c", "core.hooksPath=", "-c", "core.fsmonitor=false", "-C", worktree, "check-ignore", "--quiet", "--no-index", "--", ignorePath]);
			return true;
		} catch (error) {
			const exitCode = (error as { code?: string | number } | undefined)?.code;
			if (exitCode === 1 || exitCode === "1") return false;
			throw error;
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

	/** Prepare a source-only candidate for a sandbox owned by another UID. */
	private async installPublicGitBarrier(root: string): Promise<void> {
		const barrier = path.join(root, ".git");
		try {
			const file = await open(barrier, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o444);
			await file.close();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		await chmod(root, 0o1777);
		await this.assertPublicGitBarrier(root);
	}

	/**
	 * A public checkout is often nested under the gateway repository. Git would
	 * otherwise walk upward from a source-only checkout and bind commands to that
	 * enclosing private repository. The exact empty root file is a Git discovery
	 * barrier (Git rejects an invalid gitfile before walking upward), not a Git
	 * repository and not source content.
	 */
	private async assertPublicGitBarrier(root: string): Promise<void> {
		const barrier = path.join(root, ".git");
		const [rootInfo, info] = await Promise.all([lstat(root), lstat(barrier)]);
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
			|| !info.isFile() || info.isSymbolicLink() || info.size !== 0
			|| (process.platform !== "win32" && ((info.mode & 0o222) !== 0 || (rootInfo.mode & 0o1000) === 0))) {
			throw new Error("unsafe public Git barrier");
		}
	}

	private async makePublicExecutionTree(root: string): Promise<void> {
		const barrier = path.join(root, ".git");
		await this.walkSafe(root, async (entry, info) => {
			// Directories deliberately remain writable for ignored build output; source
			// files remain immutable-by-permission and immutable-by-digest. The root
			// `.git` discovery barrier is the single exception.
			if (samePath(entry, barrier)) await chmod(entry, 0o444);
			// The sticky root lets commands create ignored top-level output but stops
			// the sandbox UID from unlinking or replacing the server-owned `.git`
			// discovery barrier through its writable parent.
			else if (samePath(entry, root)) await chmod(entry, 0o1777);
			else if (info.isDirectory()) await chmod(entry, 0o777);
			else if (info.isFile()) await chmod(entry, (info.mode & 0o111) ? 0o555 : 0o444);
		});
	}

	/**
	 * Clear read-only attributes before recursive deletion. Directories are made
	 * writable before opening them, which matters for Windows attributes and for
	 * POSIX trees containing a mode-000 generated directory. Never follow a
	 * symlink while doing so.
	 */
	private async makeWritable(root: string): Promise<void> {
		const visit = async (entry: string): Promise<void> => {
			const info = await lstat(entry);
			if (info.isSymbolicLink()) return;
			if (info.isFile()) {
				await chmod(entry, 0o600);
				return;
			}
			if (!info.isDirectory()) throw new Error("unsafe checkout entry");
			await chmod(entry, 0o700);
			for (const name of await readdir(entry)) {
				const child = path.join(entry, name);
				if (!isWithin(root, child)) throw new Error("checkout escape");
				await visit(child);
			}
		};
		const rootInfo = await lstat(root);
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("unsafe checkout root");
		await visit(root);
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

	private async targetPath(projectId: string, signalId: string, prepare = false): Promise<string> {
		if (!UUID.test(signalId)) throw new Error("unsafe signal id");
		const root = this.checkoutRootCanonical ?? this.checkoutRoot;
		const scoped = verificationCheckoutProjectDir(root, projectId);
		if (!scoped || !isWithin(root, scoped)) throw new Error("unsafe project scope");
		try {
			const info = await lstat(scoped);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe project scope");
		} catch (error) {
			if (!prepare || !isMissing(error)) throw error;
			await mkdir(scoped, { mode: 0o755 });
		}
		// The container gets this directory as its mount root. It must never be
		// writable by the sandbox; only its atomically-published signal children are.
		if (prepare) await chmod(scoped, 0o755);
		const canonicalScoped = await realpath(scoped);
		const info = await lstat(canonicalScoped);
		if (!info.isDirectory() || info.isSymbolicLink() || !samePath(canonicalScoped, scoped) || !isWithin(root, canonicalScoped)
			|| (process.platform !== "win32" && (info.mode & 0o022) !== 0)) throw new Error("unsafe project scope");
		const target = path.resolve(canonicalScoped, signalId);
		if (!isWithin(canonicalScoped, target)) throw new Error("checkout escape");
		return target;
	}

	private async privatePath(projectId: string, signalId: string, kind: "worktree" | "candidate" | "audit"): Promise<string> {
		if (!UUID.test(signalId)) throw new Error("unsafe signal id");
		const root = this.privateRootCanonical ?? this.privateRoot;
		const scoped = verificationCheckoutProjectDir(root, projectId);
		if (!scoped || !isWithin(root, scoped)) throw new Error("unsafe private scope");
		await mkdir(scoped, { recursive: true, mode: 0o700 });
		const canonical = await realpath(scoped);
		const info = await lstat(canonical);
		if (!info.isDirectory() || info.isSymbolicLink() || !samePath(canonical, scoped) || !isWithin(root, canonical)) throw new Error("unsafe private scope");
		const target = path.join(canonical, `${signalId}.${kind}`);
		if (!isWithin(canonical, target)) throw new Error("private checkout escape");
		return target;
	}

	private async auditPath(projectId: string, signalId: string): Promise<string> {
		return this.privatePath(projectId, signalId, "audit");
	}

	private async ensureCheckoutRoot(sourceRoot: string): Promise<void> {
		await this.ensureManagedRoots();
		const [canonical, privateCanonical] = [this.checkoutRootCanonical!, this.privateRootCanonical!];
		if (isWithin(sourceRoot, canonical) || isWithin(sourceRoot, privateCanonical)) throw new Error("unsafe checkout root");
	}

	/** Establish only server-owned roots; safe to use after the source repo is gone. */
	private async ensureManagedRoots(): Promise<void> {
		await mkdir(this.checkoutRoot, { recursive: true, mode: 0o755 });
		await mkdir(this.privateRoot, { recursive: true, mode: 0o700 });
		const [canonical, privateCanonical] = await Promise.all([realpath(this.checkoutRoot), realpath(this.privateRoot)]);
		const [info, privateInfo] = await Promise.all([lstat(canonical), lstat(privateCanonical)]);
		if (!info.isDirectory() || info.isSymbolicLink() || !privateInfo.isDirectory() || privateInfo.isSymbolicLink()) {
			throw new Error("unsafe checkout root");
		}
		this.checkoutRootCanonical = canonical;
		this.privateRootCanonical = privateCanonical;
	}

	private async publishCandidate(lease: PinnedCheckoutLease, candidate: string): Promise<void> {
		const target = await this.targetPath(lease.projectId, lease.signalId);
		this.assertPublishedRootIdentity(lease, candidate, await lstat(candidate));
		await rename(candidate, target);
		this.assertPublishedRootIdentity(lease, target, await lstat(target));
		lease.publicationState = "public";
		// A crash after rename must recover by quarantining this exact public root,
		// never by treating it as an unowned path.
		await this.persist();
	}

	private async quarantinePublic(lease: PinnedCheckoutLease): Promise<string> {
		const target = await this.targetPath(lease.projectId, lease.signalId);
		const audit = await this.auditPath(lease.projectId, lease.signalId);
		try {
			const auditInfo = await lstat(audit);
			this.assertPublishedRootIdentity(lease, audit, auditInfo);
			// Recover the crash window after rename and before durable state publication.
			try { await lstat(target); throw new Error("conflicting checkout roots"); }
			catch (error) {
				if (!isMissing(error)) throw error;
				lease.publicationState = "quarantined";
				await this.persist();
				return audit;
			}
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		await this.makePublishedRootWritable(lease, target);
		await rename(target, audit);
		this.assertPublishedRootIdentity(lease, audit, await lstat(audit));
		// The barrier audit also validates the public-root sticky bit. Restore it
		// after the cross-platform move precondition and before traversing bytes.
		await chmod(audit, 0o1777);
		this.assertPublishedRootIdentity(lease, audit, await lstat(audit));
		lease.publicationState = "quarantined";
		await this.persist();
		return audit;
	}

	private async republishQuarantine(lease: PinnedCheckoutLease, audit: string): Promise<void> {
		const target = await this.targetPath(lease.projectId, lease.signalId);
		try {
			this.assertPublishedRootIdentity(lease, audit, await lstat(audit));
		} catch (error) {
			if (!isMissing(error)) throw error;
			// Recover the inverse crash window: the public rename completed before
			// the lease state did. Do not accept an attacker-created replacement.
			this.assertPublishedRootIdentity(lease, target, await lstat(target));
			lease.publicationState = "public";
			await this.persist();
			return;
		}
		await rename(audit, target);
		this.assertPublishedRootIdentity(lease, target, await lstat(target));
		lease.publicationState = "public";
		await this.persist();
	}

	private async validateLease(lease: PinnedCheckoutLease): Promise<string> {
		if (!verificationCheckoutProjectScope(lease.projectId) || !UUID.test(lease.signalId) || !COMMIT_SHA.test(lease.commitSha)
			|| (!checkoutDigestIsValid(lease.digest) && lease.state === "ready")
			|| (!hasRootIdentity(lease.publishedRootIdentity) && lease.state === "ready")) throw new Error("invalid lease");
		await this.ensureCheckoutRoot(lease.sourceRoot);
		const source = await realpath(lease.sourceRoot);
		const repo = await realpath(lease.repoRoot);
		if (source !== lease.sourceRoot || repo !== lease.repoRoot || source !== repo) throw new Error("changed lease root");
		const target = await this.targetPath(lease.projectId, lease.signalId);
		if (target !== lease.checkoutPath) throw new Error("changed lease path");
		if (lease.worktreePath) {
			const expected = await this.privatePath(lease.projectId, lease.signalId, "worktree");
			if (expected !== lease.worktreePath) throw new Error("changed private worktree path");
		}
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
