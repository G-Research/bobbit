import { constants, readFileSync, type Stats } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
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
import { verificationCheckoutProjectDir, verificationCheckoutProjectScope, verificationCheckoutRepositoryScope, verificationRepositoryKey } from "./verification-checkout-scope.js";
import {
	computeVerificationContentDigestFromInventory,
	prefixVerificationSourceInventory,
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

/** Durable no-follow identity for a multi-layout container directory. */
export interface PinnedCheckoutDirectoryIdentity {
	relativePath: string;
	identity: PinnedCheckoutRootIdentity;
}

export interface PinnedRepositorySource {
	repoKey: string;
	sourceRoot: string;
	commitSha: string;
}

export type PinnedSourceLayout =
	| { version: 1; kind: "single"; containerRoot: string; repositories: readonly [PinnedRepositorySource] }
	| { version: 2; kind: "multi"; containerRoot: string; repositories: readonly PinnedRepositorySource[] };

export interface PinnedCheckoutRepository {
	repoKey: string;
	commitSha: string;
	contentDigest: VerificationContentDigest;
	publicRelativePath: string;
	trustedGitWorktreePath?: string;
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
	/** Frozen, literal ignored output directories authorized for a separate writable execution view. */
	writableIgnoredDirectories: readonly string[];
	/** Persisted source-layout manifest; v1 contains the sole root entry. */
	repositories?: readonly PinnedCheckoutRepository[];
	layout?: "single" | "multi";
}

/**
 * Boundary consumed by verification execution. Production owns the real Git
 * implementation; test gateways may inject a lifecycle-faithful fake.
 */
export interface PinnedCheckoutManager {
	acquire(input: { signal: GateSignal; sourceRoot: string; projectId: string; layout?: PinnedSourceLayout }): Promise<PinnedCheckout>;
	assertUnchanged(checkout: PinnedCheckout): Promise<void>;
	/** Resolves only after cleanup converges; pending cleanup rejects with a sanitized PinnedCheckoutError. */
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
	/**
	 * Frozen literal paths derived from the source inventory's `.gitignore`
	 * files and confirmed by the private detached worktree. They never grant
	 * write access to the published source tree.
	 */
	writableIgnoredDirectories?: string[];
	/** v2 stores independent private worktrees/inventories beneath one public layout. */
	layout?: "single" | "multi";
	repositories?: PersistedPinnedCheckoutRepository[];
	/** Every repository root and its non-root container ancestors, bound before audit traversal. */
	publicDirectoryIdentities?: PinnedCheckoutDirectoryIdentity[];
	cleanupAttempts: number;
	lastCleanupErrorCode?: CleanupErrorCode;
}

export class PinnedCheckoutError extends Error {
	constructor(readonly code: PinnedCheckoutErrorCode, message: string) {
		super(message);
		this.name = "PinnedCheckoutError";
	}
}

type CleanupRetryTimer = ReturnType<typeof setTimeout>;
type RepositoryPathOps = {
	lstat(path: string): Promise<Stats>;
	realpath(path: string): Promise<string>;
};

export interface VerificationPinnedCheckoutManagerOptions {
	commandRunner?: CommandRunner;
	/** Test seam for deterministic directory-swap checks; production uses Node's filesystem. */
	pathOps?: RepositoryPathOps;
	readInventory?: (root: string, runner: CommandRunner) => Promise<VerificationSourceInventoryEntry[]>;
	now?: () => number;
	/** Injectable only for deterministic retry-clock tests. The callback resolves when its serialized retry settles. */
	setTimeout?: (callback: () => void | Promise<void>, delayMs: number) => CleanupRetryTimer;
	clearTimeout?: (timer: CleanupRetryTimer) => void;
}

/** JSON-safe raw filename preservation for durable pinned-checkout leases. */
export interface PersistedPinnedCheckoutRepository {
	repoKey: string;
	sourceRoot: string;
	repoRoot: string;
	commitSha: string;
	publicRelativePath: string;
	worktreePath: string;
	digest: VerificationContentDigest;
	sourceInventory: PersistedVerificationSourceInventoryEntry[];
	writableIgnoredDirectories: string[];
}

export interface PersistedVerificationSourceInventoryEntry {
	relativePath: string;
	rawPathBase64: string;
	membership: VerificationSourceInventoryEntry["membership"];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const MAX_IGNOREFILE_BYTES = 64 * 1024;
const MAX_IGNOREFILE_LINE_BYTES = 4 * 1024;

/**
 * Verification executes npm/package-manager scripts from the frozen checkout.
 * Only this top-level dependency directory is deliberately shared from the
 * source worktree, and only when Git says it is ignored. Its bytes remain
 * outside the D-1/D-3 source digest by design.
 */
/** Narrow allowlist shared with sandbox remapping; never derive names from the source tree. */
export const EXPOSED_IGNORED_SETUP_DIRECTORIES = ["node_modules"] as const;

/** Setup links own their whole subtree; writable output mounts may not overlap it. */
function isExposedIgnoredSetupPath(value: string): boolean {
	return EXPOSED_IGNORED_SETUP_DIRECTORIES.some(directory => value === directory || value.startsWith(`${directory}/`));
}

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

/** A conservative literal directory path accepted from a frozen `.gitignore`. */
function isSafeWritableIgnoredDirectory(value: unknown, sourceInventory: readonly VerificationSourceInventoryEntry[]): value is string {
	if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > MAX_IGNOREFILE_LINE_BYTES
		|| value.includes("\\") || value.includes(":") || /[\0-\x1f\x7f*?\[\]]/.test(value)
		|| path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
	const normalized = path.posix.normalize(value);
	if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) return false;
	const segments = value.split("/");
	if (segments.some(segment => !segment || segment === "." || segment === ".." || segment === ".git")) return false;
	// These names are manager-owned symlinks into setup dependencies, never
	// writable-output overlays. Reject persisted values too, so a tampered lease
	// cannot make sidecar mount ownership collide with dependency exposure.
	if (isExposedIgnoredSetupPath(value)) return false;
	return !sourceInventory.some(entry => entry.relativePath === value
		|| entry.relativePath.startsWith(`${value}/`) || value.startsWith(`${entry.relativePath}/`));
}

/** Reject tampered or legacy ready leases before their paths can be used. */
function restoreWritableIgnoredDirectories(value: unknown, sourceInventory: readonly VerificationSourceInventoryEntry[]): string[] {
	if (!Array.isArray(value)) throw new Error("missing writable ignored directories");
	const restored: string[] = [];
	for (const candidate of value) {
		if (!isSafeWritableIgnoredDirectory(candidate, sourceInventory)
			|| restored.some(existing => samePath(existing, candidate))) throw new Error("invalid writable ignored directory");
		if (restored.length && restored[restored.length - 1]! >= candidate) throw new Error("unsorted writable ignored directories");
		restored.push(candidate);
	}
	return restored;
}

function sameWritableIgnoredDirectories(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * A signal-owned detached Git worktree whose materialized bytes are the D-1
 * source inventory, not a filter-transformed checkout. The manager is the only
 * owner of state paths and Git worktree lifecycle operations.
 */
export class VerificationPinnedCheckoutManager implements PinnedCheckoutManager {
	private readonly commandRunner: CommandRunner;
	private readonly pathOps: RepositoryPathOps;
	private readonly inventory: (root: string, runner: CommandRunner) => Promise<VerificationSourceInventoryEntry[]>;
	private readonly now: () => number;
	private readonly scheduleTimeout: (callback: () => void | Promise<void>, delayMs: number) => CleanupRetryTimer;
	private readonly cancelTimeout: (timer: CleanupRetryTimer) => void;
	private readonly cleanupRetryTimers = new Map<string, CleanupRetryTimer>();
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
		this.pathOps = options.pathOps ?? { lstat, realpath };
		this.inventory = options.readInventory ?? readVerificationSourceInventory;
		this.now = options.now ?? Date.now;
		this.scheduleTimeout = options.setTimeout ?? setTimeout;
		this.cancelTimeout = options.clearTimeout ?? clearTimeout;
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
			writableIgnoredDirectories: lease.writableIgnoredDirectories && [...lease.writableIgnoredDirectories],
			repositories: lease.repositories?.map(repository => ({ ...repository, digest: { ...repository.digest }, sourceInventory: repository.sourceInventory.map(entry => ({ ...entry })), writableIgnoredDirectories: [...repository.writableIgnoredDirectories] })),
			publicDirectoryIdentities: lease.publicDirectoryIdentities?.map(entry => ({ relativePath: entry.relativePath, identity: { ...entry.identity } })),
		} : undefined;
	}

	async acquire(input: { signal: GateSignal; sourceRoot: string; projectId: string; layout?: PinnedSourceLayout }): Promise<PinnedCheckout> {
		return this.serialized(async () => {
			const layout = input.layout;
			if (layout?.version === 2 && layout.kind === "multi") return this.acquireMulti({ ...input, layout });
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
			// An interrupted preparation may be retried only after its exact
			// server-owned lease has converged. Never overwrite a releasing lease:
			// it is the sole durable authority for later recovery.
			if (existing && !await this.releaseInternal(existing)) {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
			}

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
				// Derive once from raw-byte materialized ignore files, then let only
				// the detached private worktree's Git engine confirm each candidate.
				const writableIgnoredDirectories = await this.deriveWritableIgnoredDirectories(lease, sourceInventory);
				lease.writableIgnoredDirectories = writableIgnoredDirectories;
				await this.persist();
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
				return {
					id: lease.signalId, projectId: lease.projectId, sourceRoot, repoRoot, path: target, trustedGitCwd: worktree,
					commitSha: lease.commitSha, contentDigest, writableIgnoredDirectories: Object.freeze([...writableIgnoredDirectories]),
				};
			} catch (error) {
				await this.releaseInternal(lease);
				if (error instanceof PinnedCheckoutError) throw error;
				throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
			}
		});
	}

	/** Materialize a complete branch-container layout. Kept separate so v1 retains its exact lease format and path lifecycle. */
	private async acquireMulti(input: { signal: GateSignal; sourceRoot: string; projectId: string; layout: PinnedSourceLayout }): Promise<PinnedCheckout> {
		const { signal, layout } = input;
		if (!UUID.test(signal.id) || !verificationCheckoutProjectScope(input.projectId) || !Array.isArray(layout.repositories) || layout.repositories.length === 0) throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
		const existing = this.leases.get(signal.id);
		if (existing && existing.projectId !== input.projectId) throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
		if (existing?.state === "ready") {
			if (existing.layout !== "multi" || !this.matchesPersistedMultiLayout(existing, layout)) {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
			}
			try {
				const checkout = await this.checkoutFromLease(existing);
				await this.assertUnchangedInternal(checkout);
				return checkout;
			} catch (error) {
				if (error instanceof PinnedCheckoutError) throw error;
				throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
			}
		}
		if (existing && !await this.releaseInternal(existing)) throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
		let containerRoot: string;
		let target: string;
		let candidate: string;
		try {
			const rawContainerInfo = await lstat(layout.containerRoot);
			if (!rawContainerInfo.isDirectory() || rawContainerInfo.isSymbolicLink()) throw new Error("unsafe container");
			containerRoot = await realpath(layout.containerRoot);
			const info = await lstat(containerRoot);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe container");
			await this.ensureCheckoutRoot(containerRoot);
			target = await this.targetPath(input.projectId, signal.id, true);
			candidate = await this.privatePath(input.projectId, signal.id, "candidate");
			for (const location of [target, candidate]) { try { await lstat(location); throw new Error("exists"); } catch (error) { if (!isMissing(error)) throw error; } }
		} catch { throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared"); }
		const repositories: PersistedPinnedCheckoutRepository[] = [];
		const seenKeys = new Set<string>(); const seenRoots: Array<{ repoKey: string; sourceRoot: string }> = [];
		try {
			for (const source of layout.repositories) {
				const repoKey = verificationRepositoryKey(source.repoKey);
				// The container-root repository is a legitimate multi-layout member.
				// It may enclose named component repositories; named roots themselves
				// must remain disjoint so no component can shadow another.
				if (!repoKey || seenKeys.has(repoKey) || !COMMIT_SHA.test(source.commitSha)) throw new Error("invalid repository");
				seenKeys.add(repoKey);
				const sourceRoot = await this.resolveStableContainedRepositoryRoot(containerRoot, repoKey, source.sourceRoot);
				if (seenRoots.some(root => root.repoKey !== "." && repoKey !== "." && (isWithin(root.sourceRoot, sourceRoot) || isWithin(sourceRoot, root.sourceRoot)))) throw new Error("unsafe repository");
				const repoRoot = await this.gitTopLevel(sourceRoot);
				if (repoRoot !== sourceRoot) throw new Error("not repository root");
				await this.assertCommit(repoRoot, source.commitSha);
				const scope = verificationCheckoutRepositoryScope(repoKey);
				if (!scope) throw new Error("invalid repository");
				const worktree = await this.privatePath(input.projectId, signal.id, `worktree-${scope}` as "worktree");
				seenRoots.push({ repoKey, sourceRoot });
				repositories.push({ repoKey, sourceRoot, repoRoot, commitSha: source.commitSha.toLowerCase(), publicRelativePath: repoKey, worktreePath: worktree, digest: undefined as unknown as VerificationContentDigest, sourceInventory: [], writableIgnoredDirectories: [] });
			}
		} catch { throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared"); }
		const lease: PinnedCheckoutLease = { signalId: signal.id, projectId: input.projectId, goalId: signal.goalId, gateId: signal.gateId, state: "preparing", checkoutPath: target!, sourceRoot: containerRoot!, repoRoot: containerRoot!, commitSha: signal.commitSha.toLowerCase(), createdAt: this.now(), publicationState: "quarantined", layout: "multi", repositories, cleanupAttempts: 0 };
		this.leases.set(signal.id, lease);
		try {
			await this.persist();
			for (const repository of repositories) {
				const inventory = await this.inventory(repository.sourceRoot, this.secureRunner());
				// A root repository must never claim a file or symlink at, above, or
				// below a separately pinned nested repository. Git normally omits a
				// nested repository, but make that boundary explicit before the two
				// inventories are materialized into one public layout.
				if (repository.repoKey === "." && repositories.some(nested => nested.repoKey !== "." && inventory.some(entry =>
					entry.relativePath === nested.repoKey
					|| entry.relativePath.startsWith(`${nested.repoKey}/`)
					|| nested.repoKey.startsWith(`${entry.relativePath}/`)))) throw new Error("overlapping root inventory");
				repository.sourceInventory = persistInventory(inventory);
				await this.execGit(["-c", "core.hooksPath=", "-C", repository.repoRoot, "worktree", "add", "--detach", "--no-checkout", repository.worktreePath, repository.commitSha]);
				await this.materialize(repository.sourceRoot, repository.worktreePath, inventory);
				repository.writableIgnoredDirectories = await this.deriveWritableIgnoredDirectories({ ...lease, worktreePath: repository.worktreePath }, inventory);
				const publicRoot = path.join(candidate!, repository.publicRelativePath);
				await mkdir(path.dirname(publicRoot), { recursive: true, mode: 0o700 });
				await this.materialize(repository.worktreePath, publicRoot, inventory);
				await this.exposeIgnoredSetupDirectories(repository.sourceRoot, publicRoot);
				repository.digest = await computeVerificationContentDigestFromInventory(publicRoot, inventory);
			}
			await this.installPublicGitBarrier(candidate!);
			const aggregateInventory = prefixVerificationSourceInventory(repositories.map(repository => ({ repoKey: repository.repoKey, inventory: restoreInventory(repository.sourceInventory) })));
			lease.digest = await computeVerificationContentDigestFromInventory(candidate!, aggregateInventory);
			lease.publishedRootIdentity = rootIdentity(await lstat(candidate!));
			lease.publicDirectoryIdentities = await this.captureMultiDirectoryIdentities(candidate!, repositories);
			await this.persist(); await this.makePublicExecutionTree(candidate!, this.multiContainerAncestorPaths(repositories)); await this.publishCandidate(lease, candidate!);
			lease.state = "ready"; lease.publicationState = "public"; await this.persist();
			return this.checkoutMultiFromLease(lease);
		} catch (error) {
			await this.releaseInternal(lease);
			if (error instanceof PinnedCheckoutError) throw error;
			throw new PinnedCheckoutError("PINNED_CHECKOUT_ACQUIRE_FAILED", "Pinned checkout could not be prepared");
		}
	}

	/** Existing signal reuse must not switch repositories under an already-pinned lease. */
	private matchesPersistedMultiLayout(lease: PinnedCheckoutLease, layout: PinnedSourceLayout): boolean {
		if (lease.layout !== "multi" || !Array.isArray(lease.repositories) || lease.repositories.length !== layout.repositories.length) return false;
		return lease.repositories.every((repository, index) => {
			const source = layout.repositories[index];
			return source !== undefined
				&& verificationRepositoryKey(source.repoKey) === repository.repoKey
				&& source.sourceRoot === repository.sourceRoot
				&& source.commitSha.toLowerCase() === repository.commitSha;
		});
	}

	/**
	 * Bind raw and expected spellings to one directory identity before Git sees
	 * either. A post-realpath canonical containment check and identity recheck
	 * reject a directory→junction swap instead of accepting its outside target.
	 */
	private async resolveStableContainedRepositoryRoot(containerRoot: string, repoKey: string, sourceRoot: string): Promise<string> {
		const expected = path.resolve(containerRoot, repoKey);
		const expectedIdentities = await this.containedDirectoryIdentities(containerRoot, expected);
		const expectedIdentity = expectedIdentities[expectedIdentities.length - 1]!;
		const sourceIdentity = rootIdentity(await this.pathOps.lstat(sourceRoot));
		const same = (left: PinnedCheckoutRootIdentity, right: PinnedCheckoutRootIdentity): boolean => left.dev === right.dev && left.ino === right.ino;
		if (!same(expectedIdentity, sourceIdentity)) throw new Error("repository identity mismatch");
		const expectedRoot = await this.pathOps.realpath(expected);
		if (!isWithin(containerRoot, expectedRoot)) throw new Error("repository canonical path escapes container");
		const [currentExpectedIdentities, currentSource, canonicalIdentity] = await Promise.all([
			this.containedDirectoryIdentities(containerRoot, expected),
			this.pathOps.lstat(sourceRoot).then(rootIdentity),
			this.pathOps.lstat(expectedRoot).then(rootIdentity),
		]);
		if (expectedIdentities.length !== currentExpectedIdentities.length
			|| expectedIdentities.some((identity, index) => !same(identity, currentExpectedIdentities[index]!))
			|| !same(sourceIdentity, currentSource) || !same(expectedIdentity, canonicalIdentity)) throw new Error("repository path changed");
		return expectedRoot;
	}

	/** Capture every lexical component so an in-container link is never accepted. */
	private async containedDirectoryIdentities(root: string, leaf: string): Promise<PinnedCheckoutRootIdentity[]> {
		if (!isWithin(root, leaf)) throw new Error("repository escapes container");
		const identities: PinnedCheckoutRootIdentity[] = [];
		let cursor = root;
		identities.push(rootIdentity(await this.pathOps.lstat(cursor)));
		for (const segment of path.relative(root, leaf).split(path.sep).filter(Boolean)) {
			cursor = path.join(cursor, segment);
			identities.push(rootIdentity(await this.pathOps.lstat(cursor)));
		}
		return identities;
	}

	/** The non-repository path components are immutable container structure. */
	private multiContainerAncestorPaths(repositories: readonly PersistedPinnedCheckoutRepository[]): string[] {
		const repositoryRoots = new Set(repositories.map(repository => repository.publicRelativePath));
		const ancestors = new Set<string>();
		for (const repository of repositories) {
			let current = "";
			for (const segment of repository.publicRelativePath.split("/")) {
				current = current ? `${current}/${segment}` : segment;
				if (!repositoryRoots.has(current)) ancestors.add(current);
			}
		}
		return [...ancestors].sort();
	}

	/** Bind every repo root and its path ancestors before the candidate becomes public. */
	private async captureMultiDirectoryIdentities(root: string, repositories: readonly PersistedPinnedCheckoutRepository[]): Promise<PinnedCheckoutDirectoryIdentity[]> {
		const paths = new Set<string>();
		for (const repository of repositories) {
			let current = "";
			for (const segment of repository.publicRelativePath.split("/")) {
				current = current ? `${current}/${segment}` : segment;
				paths.add(current);
			}
		}
		const identities: PinnedCheckoutDirectoryIdentity[] = [];
		for (const relativePath of [...paths].sort()) {
			const location = this.inventoryPath(root, relativePath);
			const info = await lstat(location);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe multi checkout directory");
			identities.push({ relativePath, identity: rootIdentity(info) });
		}
		return identities;
	}

	/** Validate the durable path identities before readdir/digest can traverse them. */
	private async assertMultiDirectoryIdentities(lease: PinnedCheckoutLease, root: string): Promise<void> {
		if (!Array.isArray(lease.repositories) || !Array.isArray(lease.publicDirectoryIdentities)) throw new Error("missing multi checkout identities");
		const expectedPaths = new Set<string>();
		for (const repository of lease.repositories) {
			let current = "";
			for (const segment of repository.publicRelativePath.split("/")) {
				current = current ? `${current}/${segment}` : segment;
				expectedPaths.add(current);
			}
		}
		const identities = lease.publicDirectoryIdentities;
		if (!identities || identities.length !== expectedPaths.size || identities.some((entry, index) => !expectedPaths.has(entry.relativePath)
			|| !hasRootIdentity(entry.identity) || (index > 0 && identities[index - 1]!.relativePath >= entry.relativePath))) throw new Error("invalid multi checkout identities");
		this.assertPublishedRootIdentity(lease, root, await lstat(root));
		for (const entry of identities) {
			const info = await lstat(this.inventoryPath(root, entry.relativePath));
			if (!sameRootIdentity(entry.identity, info)) {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_MUTATED", "Pinned checkout changed during verification");
			}
		}
	}

	/** Reject additions in the container and intermediate path nodes outside repository roots. */
	private async assertMultiContainerStructure(lease: PinnedCheckoutLease, root: string): Promise<void> {
		// The root repository's own inventory audit admits its source entries and
		// explicitly delegates each nested repository to its independent audit.
		if (lease.repositories?.some(repository => repository.publicRelativePath === ".")) return;
		type Node = { children: Map<string, Node>; repository: boolean };
		const createNode = (): Node => ({ children: new Map(), repository: false });
		const tree = createNode();
		for (const repository of lease.repositories ?? []) {
			let node = tree;
			for (const segment of repository.publicRelativePath.split("/")) {
				let child = node.children.get(segment);
				if (!child) { child = createNode(); node.children.set(segment, child); }
				node = child;
			}
			if (node.repository || node.children.size > 0) throw new Error("invalid multi repository structure");
			node.repository = true;
		}
		const inspect = async (directory: string, node: Node, relativePath: string): Promise<void> => {
			for (const name of await readdir(directory)) {
				if (!relativePath && name === ".git") {
					await this.assertPublicGitBarrier(root);
					continue;
				}
				const childNode = node.children.get(name);
				if (!childNode) throw new PinnedCheckoutError("PINNED_CHECKOUT_MUTATED", "Pinned checkout changed during verification");
				const childPath = path.join(directory, name);
				const info = await lstat(childPath);
				if (!info.isDirectory() || info.isSymbolicLink()) throw new PinnedCheckoutError("PINNED_CHECKOUT_MUTATED", "Pinned checkout changed during verification");
				if (!childNode.repository) await inspect(childPath, childNode, relativePath ? `${relativePath}/${name}` : name);
			}
		};
		await inspect(root, tree, "");
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
			if (!await this.releaseInternal(lease)) {
				// Do not expose filesystem paths, Git output, or OS error details to
				// the harness. The retained releasing lease is the durable retry owner.
				throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout cleanup is pending");
			}
		});
	}

	/** Remove interrupted/orphaned state without ever sweeping unrelated worktrees. */
	async recover(activeSignals: ReadonlyMap<string, string>): Promise<void> {
		return this.serialized(async () => {
			for (const lease of [...this.leases.values()]) {
				// The active-verification store is authoritative during restart. It may
				// preserve a ready lease for resume, or a releasing lease whose terminal
				// owner has not finished recording its outcome. In either case, do not let
				// a stale manager retry reclaim bytes that active recovery still owns.
				if (activeSignals.get(lease.signalId) === lease.projectId) {
					this.cancelCleanupRetry(lease.signalId);
					continue;
				}
				// Cleanup is deliberately lease-independent: a locked/replaced root
				// must not strand unrelated orphan snapshots. Failures are durable and
				// observable through getDiagnostics()/getLease(), then retried live.
				await this.releaseInternal(lease);
			}
		});
	}

	private async assertUnchangedInternal(checkout: PinnedCheckout): Promise<void> {
		const lease = this.leases.get(checkout.id);
		if (lease?.layout === "multi") return this.assertMultiUnchanged(lease, checkout);
		if (!lease || lease.state !== "ready") throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout is unavailable");
		try {
			const restored = await this.checkoutFromLease(lease);
			if (restored.path !== checkout.path || restored.projectId !== checkout.projectId || restored.commitSha !== checkout.commitSha
				|| !sameWritableIgnoredDirectories(restored.writableIgnoredDirectories, checkout.writableIgnoredDirectories)) throw new Error("mismatched checkout");
			const sourceInventory = restoreInventory(lease.sourceInventory);
			restoreWritableIgnoredDirectories(lease.writableIgnoredDirectories, sourceInventory);
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
		if (lease.layout === "multi") return this.checkoutMultiFromLease(lease);
		if (!checkoutDigestIsValid(lease.digest) || lease.state !== "ready") throw new Error("incomplete lease");
		const sourceInventory = restoreInventory(lease.sourceInventory);
		const writableIgnoredDirectories = restoreWritableIgnoredDirectories(lease.writableIgnoredDirectories, sourceInventory);
		const target = await this.validateLease(lease);
		// A crash can persist between detach and republish. Restore only the exact
		// recorded private quarantine; resume immediately audits it before execution.
		if (lease.publicationState === "quarantined") await this.republishQuarantine(lease, await this.auditPath(lease.projectId, lease.signalId));
		if (!lease.worktreePath) throw new Error("missing private Git worktree");
		return {
			id: lease.signalId, projectId: lease.projectId, sourceRoot: lease.sourceRoot, repoRoot: lease.repoRoot, path: target,
			trustedGitCwd: lease.worktreePath, commitSha: lease.commitSha, contentDigest: { ...lease.digest },
			writableIgnoredDirectories: Object.freeze([...writableIgnoredDirectories]),
		};
	}

	private async checkoutMultiFromLease(lease: PinnedCheckoutLease): Promise<PinnedCheckout> {
		if (lease.state !== "ready" || !checkoutDigestIsValid(lease.digest) || !Array.isArray(lease.repositories) || lease.repositories.length === 0
			|| !Array.isArray(lease.publicDirectoryIdentities)) throw new Error("incomplete multi lease");
		const target = await this.validateLease(lease);
		const repositories: PinnedCheckoutRepository[] = lease.repositories.map(repository => {
			if (!verificationRepositoryKey(repository.repoKey) || repository.publicRelativePath !== repository.repoKey || !COMMIT_SHA.test(repository.commitSha)
				|| !checkoutDigestIsValid(repository.digest)) throw new Error("invalid multi manifest");
			restoreInventory(repository.sourceInventory); restoreWritableIgnoredDirectories(repository.writableIgnoredDirectories, restoreInventory(repository.sourceInventory));
			return { repoKey: repository.repoKey, commitSha: repository.commitSha, contentDigest: { ...repository.digest }, publicRelativePath: repository.publicRelativePath, trustedGitWorktreePath: repository.worktreePath };
		});
		if (lease.publicationState === "quarantined") await this.republishQuarantine(lease, await this.auditPath(lease.projectId, lease.signalId));
		const writableIgnoredDirectories = lease.repositories
			.flatMap(repository => repository.writableIgnoredDirectories.map(dir => path.posix.join(repository.repoKey, dir)))
			.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
		return { id: lease.signalId, projectId: lease.projectId, sourceRoot: lease.sourceRoot, repoRoot: lease.repoRoot, path: target,
			trustedGitCwd: repositories[0]?.trustedGitWorktreePath, commitSha: lease.commitSha, contentDigest: { ...lease.digest },
			writableIgnoredDirectories: Object.freeze(writableIgnoredDirectories),
			repositories: Object.freeze(repositories), layout: "multi" };
	}

	private async assertMultiUnchanged(lease: PinnedCheckoutLease, checkout: PinnedCheckout): Promise<void> {
		try {
			const restored = await this.checkoutMultiFromLease(lease);
			if (restored.path !== checkout.path || restored.projectId !== checkout.projectId || restored.commitSha !== checkout.commitSha
				|| restored.contentDigest.digest !== checkout.contentDigest.digest || restored.contentDigest.fileCount !== checkout.contentDigest.fileCount
				|| !sameWritableIgnoredDirectories(restored.writableIgnoredDirectories, checkout.writableIgnoredDirectories)) throw new Error("mismatched checkout");
			const audit = await this.quarantinePublic(lease);
			// Bind every path component before any readdir/realpath-based digest traversal.
			await this.assertMultiDirectoryIdentities(lease, audit);
			await this.assertMultiContainerStructure(lease, audit);
			for (const repository of lease.repositories ?? []) {
				const inventory = restoreInventory(repository.sourceInventory);
				const root = this.inventoryPath(audit, repository.publicRelativePath);
				const digest = await computeVerificationContentDigestFromInventory(root, inventory);
				if (digest.digest !== repository.digest.digest || digest.fileCount !== repository.digest.fileCount) throw new PinnedCheckoutError("PINNED_CHECKOUT_MUTATED", "Pinned checkout changed during verification");
				await this.assertNoSourceAdditions(
					root,
					{ ...lease, worktreePath: repository.worktreePath },
					inventory,
					repository.repoKey === "."
						? (lease.repositories ?? []).filter(nested => nested.repoKey !== ".").map(nested => nested.publicRelativePath)
						: [],
				);
			}
			// The aggregate performs a second traversal through every repository path.
			// Rebind the persisted directories again immediately before it.
			await this.assertMultiDirectoryIdentities(lease, audit);
			const aggregate = await computeVerificationContentDigestFromInventory(audit, prefixVerificationSourceInventory((lease.repositories ?? []).map(repository => ({ repoKey: repository.repoKey, inventory: restoreInventory(repository.sourceInventory) }))));
			if (aggregate.digest !== lease.digest!.digest || aggregate.fileCount !== lease.digest!.fileCount) throw new PinnedCheckoutError("PINNED_CHECKOUT_MUTATED", "Pinned checkout changed during verification");
			await this.republishQuarantine(lease, audit);
		} catch (error) {
			if (error instanceof PinnedCheckoutError) throw error;
			throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout could not be read");
		}
	}

	/**
	 * Cleanup validates only manager-owned paths. A completed or archived goal may
	 * have removed its repository before recovery runs; that must not strand its
	 * server-owned snapshot. Public roots keep their durable identity check before
	 * every privileged traversal or removal.
	 */
	/**
	 * Attempt one exact lease cleanup. False means the lease was retained in the
	 * durable releasing state; callers must not mistake it for a completed release.
	 */
	private async releaseInternal(lease: PinnedCheckoutLease): Promise<boolean> {
		lease.state = "releasing";
		try {
			await this.persist();
			const paths = await this.cleanupPaths(lease);
			const audit = await this.quarantineForCleanup(lease, paths.target, paths.audit);
			if (audit) await this.removePublishedAudit(lease, audit);
			if (lease.layout === "multi") {
				for (const repository of lease.repositories ?? []) await this.removePrivateTree(repository.worktreePath, repository.repoRoot);
			} else await this.removePrivateTree(paths.worktree, lease.repoRoot);
			await this.removePrivateTree(paths.candidate);
			this.leases.delete(lease.signalId);
			await this.persist();
			this.cancelCleanupRetry(lease.signalId);
			return true;
		} catch (error) {
			// Keep counting every attempt for durable operator diagnostics. The retry
			// interval caps; the retry lifecycle intentionally does not.
			lease.cleanupAttempts = Math.min(Number.MAX_SAFE_INTEGER, lease.cleanupAttempts + 1);
			lease.lastCleanupErrorCode = (error as NodeJS.ErrnoException | undefined)?.code === "EBUSY" ? "PATH_BUSY" : "GIT_REMOVE_FAILED";
			try { await this.persist(); } catch { /* retain the prior durable releasing lease */ }
			// A returned checkout/harness row is not the retry authority. Every failed
			// cleanup path (including failed acquisition) installs this manager-owned,
			// unref'd retry only after its releasing state has been persisted.
			this.scheduleCleanupRetry(lease);
			return false;
		}
	}

	/** 1s exponential backoff, capped at 30s while cleanup remains durable. */
	private cleanupRetryDelay(cleanupAttempts: number): number {
		const exponent = Math.max(cleanupAttempts - 1, 0);
		return Math.min(1_000 * (2 ** Math.min(exponent, 52)), 30_000);
	}

	/** Exactly one queued retry per signal; all deletion stays behind `serialized`. */
	private scheduleCleanupRetry(lease: PinnedCheckoutLease): void {
		if (this.cleanupRetryTimers.has(lease.signalId) || this.leases.get(lease.signalId) !== lease || lease.state !== "releasing") return;
		const timer = this.scheduleTimeout(() => {
			this.cleanupRetryTimers.delete(lease.signalId);
			const retry = this.serialized(async () => {
				const current = this.leases.get(lease.signalId);
				if (!current || current !== lease || current.state !== "releasing") return;
				await this.releaseInternal(current);
			});
			// Production timers discard returned promises, but the injected clock must
			// await the exact serialized retry rather than guess at event-loop turns.
			void retry.catch(() => undefined);
			return retry;
		}, this.cleanupRetryDelay(lease.cleanupAttempts));
		this.cleanupRetryTimers.set(lease.signalId, timer);
		// Background cleanup must not keep a production gateway process alive.
		(timer as NodeJS.Timeout).unref?.();
	}

	private cancelCleanupRetry(signalId: string): void {
		const timer = this.cleanupRetryTimers.get(signalId);
		if (!timer) return;
		this.cleanupRetryTimers.delete(signalId);
		this.cancelTimeout(timer);
	}

	private async cleanupPaths(lease: PinnedCheckoutLease): Promise<{ target: string; audit: string; worktree: string; candidate: string }> {
		if (!verificationCheckoutProjectScope(lease.projectId) || !UUID.test(lease.signalId)) throw new Error("invalid cleanup lease");
		await this.ensureManagedRoots();
		const target = await this.targetPath(lease.projectId, lease.signalId, true);
		const audit = await this.auditPath(lease.projectId, lease.signalId);
		const candidate = await this.privatePath(lease.projectId, lease.signalId, "candidate");
		const worktree = lease.worktreePath ?? await this.privatePath(lease.projectId, lease.signalId, "worktree");
		if (lease.layout === "multi") {
			if (!Array.isArray(lease.repositories) || lease.repositories.length === 0) throw new Error("invalid multi cleanup lease");
			for (const repository of lease.repositories) {
				const scope = verificationCheckoutRepositoryScope(repository.repoKey);
				const expectedWorktree = scope && await this.privatePath(lease.projectId, lease.signalId, `worktree-${scope}` as "worktree");
				if (!scope || repository.worktreePath !== expectedWorktree) throw new Error("changed private multi worktree path");
			}
		} else {
			const expectedWorktree = await this.privatePath(lease.projectId, lease.signalId, "worktree");
			if (worktree !== expectedWorktree) throw new Error("changed private worktree path");
		}
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
			} catch (error) {
				// Lock/access failures mean the private worktree may still be in use.
				// Retain its lease rather than treating a direct recursive removal as
				// proof of cleanup. Other Git failures (failed add/pruned registration)
				// still use the manager-owned direct removal fallback.
				const code = (error as NodeJS.ErrnoException | undefined)?.code;
				if (code === "EBUSY" || code === "EACCES" || code === "EPERM") throw error;
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
	 * Produces the sole writable-output authority for this lease. Candidate rules
	 * come from inventory-backed raw `.gitignore` files in the private overlay;
	 * neither acquisition nor resume reads the mutable source root after this.
	 */
	private async deriveWritableIgnoredDirectories(lease: PinnedCheckoutLease, sourceInventory: readonly VerificationSourceInventoryEntry[]): Promise<string[]> {
		if (!lease.worktreePath) throw new Error("missing private Git worktree");
		const candidates: string[] = [];
		for (const entry of sourceInventory) {
			if (path.posix.basename(entry.relativePath) !== ".gitignore") continue;
			const contents = await this.readBoundedIgnoreFile(this.inventoryPath(lease.worktreePath, entry.relativePath));
			if (contents === undefined) continue;
			const base = path.posix.dirname(entry.relativePath);
			for (const rawLine of contents.split("\n")) {
				const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
				const candidate = this.literalIgnoredDirectoryCandidate(line, base, sourceInventory);
				// Setup dependency roots are manager-owned links, not output mounts.
				// Keep the explicit guard here as the derivation boundary in addition
				// to rejecting them in persisted-lease validation.
				if (!candidate || isExposedIgnoredSetupPath(candidate)
					|| candidates.some(existing => samePath(existing, candidate))) continue;
				// Defend this boundary even though literal parsing already rejects
				// traversal: the resolved path must remain inside the private tree.
				this.inventoryPath(lease.worktreePath, candidate);
				// `--no-index` below makes this an ignore-rule check rather than a
				// tracked-file query. The directory marker preserves Git semantics.
				if (await this.isIgnoredPrivatePath(lease, candidate, true)) candidates.push(candidate);
			}
		}
		return candidates.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
	}

	private async readBoundedIgnoreFile(location: string): Promise<string | undefined> {
		let info: Stats;
		try { info = await lstat(location); }
		catch (error) { if (isMissing(error)) return undefined; throw error; }
		if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_IGNOREFILE_BYTES) return undefined;
		const bytes = await readFile(location);
		if (bytes.length > MAX_IGNOREFILE_BYTES) return undefined;
		try { return utf8.decode(bytes); }
		catch { return undefined; }
	}

	private literalIgnoredDirectoryCandidate(line: string, base: string, sourceInventory: readonly VerificationSourceInventoryEntry[]): string | undefined {
		if (!line || Buffer.byteLength(line, "utf8") > MAX_IGNOREFILE_LINE_BYTES || line !== line.trim()
			|| line.startsWith("#") || line.startsWith("!") || line.includes("\\") || !line.endsWith("/")) return undefined;
		const pattern = line.slice(0, -1);
		if (!pattern || pattern.startsWith("/") || pattern.includes("//")) return undefined;
		const candidate = base === "." ? pattern : `${base}/${pattern}`;
		return isSafeWritableIgnoredDirectory(candidate, sourceInventory) ? candidate : undefined;
	}

	/**
	 * The published tree is sandbox-writable. It has already been renamed into
	 * private quarantine when this runs, so neither this traversal nor Git sees a
	 * sandbox namespace. `--no-index` checks the private detached worktree's
	 * frozen ignore rules without consulting the quarantined tree as a Git cwd.
	 */
	private async assertNoSourceAdditions(
		targetRoot: string,
		lease: PinnedCheckoutLease,
		sourceInventory: readonly VerificationSourceInventoryEntry[],
		delegatedDirectories: readonly string[] = [],
	): Promise<void> {
		const known = new Set(sourceInventory.map(entry => entry.relativePath));
		const delegated = new Set(delegatedDirectories);
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
				if (delegated.has(childRelative)) {
					if (!info.isDirectory() || info.isSymbolicLink()) throw new PinnedCheckoutError("PINNED_CHECKOUT_MUTATED", "Pinned checkout changed during verification");
					continue;
				}
				if (known.has(childRelative) || ancestors.has(childRelative)) {
					if (info.isDirectory() && !info.isSymbolicLink()) await inspect(child, childRelative);
					continue;
				}
				if (childRelative === ".git") {
					await this.assertPublicGitBarrier(targetRoot);
					continue;
				}
				if (EXPOSED_IGNORED_SETUP_DIRECTORIES.includes(childRelative as typeof EXPOSED_IGNORED_SETUP_DIRECTORIES[number])) continue;
				const isDirectory = info.isDirectory() && !info.isSymbolicLink();
				// Git does not classify non-ignored parents of a nested ignored
				// directory (and does not track empty directories). Inspect those
				// parents recursively, so `tests/results/tier-2-5/` is usable without
				// admitting a non-ignored file, symlink, or special-file sibling.
				if (isDirectory && !await this.isIgnoredPrivatePath(lease, childRelative, true)) {
					await inspect(child, childRelative);
					continue;
				}
				// Git's ignore engine distinguishes a directory path (`ignored/`) from
				// a plain name (`ignored`); preserve the quarantined entry's marker while
				// asking only the trusted private worktree for the frozen rule.
				if (!await this.isIgnoredPrivatePath(lease, childRelative, isDirectory)) {
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

	private async makePublicExecutionTree(root: string, readOnlyDirectories: readonly string[] = []): Promise<void> {
		const barrier = path.join(root, ".git");
		const protectedDirectories = new Set(readOnlyDirectories.map(relativePath => this.inventoryPath(root, relativePath)));
		await this.walkSafe(root, async (entry, info) => {
			// Directories deliberately remain writable for ignored build output; source
			// files remain immutable-by-permission and immutable-by-digest. The root
			// `.git` discovery barrier is the single exception. Multi-layout container
			// ancestors contain no source/output and remain read-only.
			if (samePath(entry, barrier)) await chmod(entry, 0o444);
			// The sticky root lets commands create ignored top-level output but stops
			// the sandbox UID from unlinking or replacing the server-owned `.git`
			// discovery barrier through its writable parent.
			else if (samePath(entry, root)) await chmod(entry, 0o1777);
			else if (info.isDirectory() && protectedDirectories.has(entry)) await chmod(entry, 0o555);
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
		if (lease.layout === "multi") {
			if (!verificationCheckoutProjectScope(lease.projectId) || !UUID.test(lease.signalId) || !checkoutDigestIsValid(lease.digest)
				|| !hasRootIdentity(lease.publishedRootIdentity) || !Array.isArray(lease.repositories) || lease.repositories.length === 0
				|| !Array.isArray(lease.publicDirectoryIdentities)) throw new Error("invalid multi lease");
			const target = await this.targetPath(lease.projectId, lease.signalId);
			if (target !== lease.checkoutPath) throw new Error("changed lease path");
			const seenRepositories = new Set<string>();
			const expectedDirectories = new Set<string>();
			for (const repository of lease.repositories) {
				const repoKey = verificationRepositoryKey(repository.repoKey);
				const scope = repoKey && verificationCheckoutRepositoryScope(repoKey);
				const expected = scope && await this.privatePath(lease.projectId, lease.signalId, `worktree-${scope}` as "worktree");
				if (!repoKey || repository.publicRelativePath !== repoKey || seenRepositories.has(repoKey) || !scope || expected !== repository.worktreePath || !checkoutDigestIsValid(repository.digest)) throw new Error("invalid multi worktree");
				seenRepositories.add(repoKey);
				for (const other of seenRepositories) {
					if (other !== repoKey && other !== "." && repoKey !== "." && (repoKey.startsWith(`${other}/`) || other.startsWith(`${repoKey}/`))) throw new Error("overlapping multi repositories");
				}
				let current = "";
				for (const segment of repoKey.split("/")) {
					current = current ? `${current}/${segment}` : segment;
					expectedDirectories.add(current);
				}
			}
			const identities = lease.publicDirectoryIdentities;
			if (!identities || identities.length !== expectedDirectories.size || identities.some((entry, index) => !expectedDirectories.has(entry.relativePath)
				|| !hasRootIdentity(entry.identity) || (index > 0 && identities[index - 1]!.relativePath >= entry.relativePath))) throw new Error("invalid multi directory identities");
			return target;
		}
		if (!verificationCheckoutProjectScope(lease.projectId) || !UUID.test(lease.signalId) || !COMMIT_SHA.test(lease.commitSha)
			|| (!checkoutDigestIsValid(lease.digest) && lease.state === "ready")
			|| (!hasRootIdentity(lease.publishedRootIdentity) && lease.state === "ready")) throw new Error("invalid lease");
		if (lease.state === "ready") restoreWritableIgnoredDirectories(lease.writableIgnoredDirectories, restoreInventory(lease.sourceInventory));
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
