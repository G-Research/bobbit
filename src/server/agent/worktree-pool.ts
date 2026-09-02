/**
 * Pre-creates git worktrees so new sessions / goals can claim one instantly
 * instead of waiting 10-30s for `git worktree add` + setup.
 *
 * On startup, the pool revalidates its exact durable ownership records, adopts
 * complete matches, then fills the shortfall to `targetSize` in the background.
 * When a session or goal claims a worktree, the pool renames the branch,
 * moves the directory to its conventional path, and starts replenishing.
 *
 * If the pool is empty, callers fall back to the normal `createWorktree()` path.
 *
 * Branch naming:
 *   - Pool fill creates `pool/_pool-<id>` so session-manager's `session/*`
 *     orphan scans don't trip on in-flight pool entries.
 *   - `claim(targetBranch)` is the only claim entry point and renames the
 *     pool branch + directory to their final names synchronously before
 *     returning. On directory-rename failure the call returns null and
 *     the caller falls back to `createWorktree`. There is no persisted
 *     "degraded" state — see `docs/design/remove-session-worktree-rename.md`.
 *   - The fetch + reset that used to block claim now run in the
 *     background after returning the worktree to the caller.
 *   - `setComponents()` accepts the project's component list. When the
 *     components imply multi-repo, `_fill()` builds multi-repo pool sets
 *     via `createWorktreeSet` and `claim()` bounds rename + move work
 *     across repos.
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import nodeFs, { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createWorktree, cleanupWorktree, shouldSkipRemoteGitForTests, createWorktreeSet, resolveBaseRef, isUnresolvedHeadWorktreeError, isGitRepoRoot, hasResolvedHead, type WorktreeResult, type RemoteGitPolicy } from "../skills/git.js";
import { runComponentSetups, resolveSetupTimeoutMs } from "../skills/worktree-setup.js";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "./cpu-diagnostics.js";
import { execShellCommand } from "./shell-util.js";
import type { Component } from "./project-config-store.js";
import { branchToSlug, worktreeRoot as resolveWorktreeRoot } from "../skills/worktree-paths.js";
import {
	canonicalGitCommonDir,
	repositoryMutationCoordinator,
	type RepositoryMutationCoordinator,
} from "../skills/repository-mutation-coordinator.js";
import { isBobbitPoolBranch, parseGitWorktreeList, type WorktreePoolSnapshot } from "./worktree-inventory.js";
import type { PoolEntryRecord, PoolRecordSink } from "./worktree-pool-record.js";
import { realCommandRunner, type CommandRunner } from "../gateway-deps.js";
import { mapWithConcurrency, RECOVERY_IO_CONCURRENCY } from "./bounded-async-work.js";

function childErrorCode(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" || typeof code === "number" ? String(code) : "error";
}

function gitChildLabel(args: readonly string[]): string {
	const [cmd, sub] = args;
	if (cmd === "worktree" && sub) return `git worktree ${sub}`;
	if (cmd === "branch") return "git branch";
	if (cmd === "fetch") return "git fetch";
	if (cmd === "reset") return "git reset";
	if (cmd === "push") return "git push";
	if (cmd === "rev-parse") return "git rev-parse";
	return cmd ? `git ${cmd}` : "git";
}

async function execGit(args: readonly string[], options?: any, commandRunner: CommandRunner = realCommandRunner): Promise<{ stdout: string; stderr: string }> {
	if (!cpuDiagnosticsEnabled()) {
		return await commandRunner.execFile("git", args, options) as unknown as { stdout: string; stderr: string };
	}
	const start = performance.now();
	let success = 0;
	let errorCode = "none";
	try {
		const result = await commandRunner.execFile("git", args, options) as unknown as { stdout: string; stderr: string };
		success = 1;
		return result;
	} catch (err) {
		errorCode = childErrorCode(err);
		throw err;
	} finally {
		getCpuDiagnostics().recordChildProcess(gitChildLabel(args), performance.now() - start, {
			success,
			errorCode,
			timeoutMs: typeof options?.timeout === "number" ? options.timeout : 0,
		});
	}
}

interface PoolEntry {
	branchName: string;       // e.g. "pool/_pool-<8hex>" — git ref after fill
	/** Back-compat alias for `worktrees[0].worktreePath` in single-repo mode. */
	worktreePath: string;
	/** Multi-repo: per-repo worktree entries. Absent for single-repo. */
	worktrees?: Array<{ repo: string; repoPath: string; worktreePath: string }>;
	createdAt: number;
	/** Only fill-created or strictly re-adopted entries may become restart authority. */
	durable: boolean;
}

/** Result of a pool claim. */
export interface PoolClaimResult extends WorktreeResult {
	/**
	 * Transient claim-result signal: in multi-repo, a per-repo `git branch -m`
	 * failed even though the container rename succeeded. The worktree is
	 * usable; callers may surface a warning. Single-repo claims never set
	 * this — a directory-rename failure causes `claim()` to return null and
	 * the caller falls back to `createWorktree`. Not persisted to disk.
	 */
	degraded?: boolean;
	/** Multi-repo: per-repo worktree entries. Absent for single-repo entries. */
	worktrees?: Array<{ repo: string; worktreePath: string }>;
	/** Multi-repo: the per-branch container directory (`<wtRoot>/<branchSlug>`). */
	container?: string;
}

/** Component descriptor reserved for Phase 4 multi-repo pool sets. */
export interface PoolComponent {
	name: string;
	repo: string;
	relativePath?: string;
	worktreeSetupCommand?: string;
}

const POOL_BRANCH_PREFIX = "pool/_pool-";

/** Promise-only filesystem seam for pool lifecycle tests and gateway I/O. */
export interface WorktreePoolFs {
	rename(oldPath: string, newPath: string): Promise<void>;
}

const realWorktreePoolFs: WorktreePoolFs = {
	rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
};

const nativeRealpath = promisify(nodeFs.realpath.native) as (value: string) => Promise<string>;

/** Format a native-realpath result without discarding legal POSIX path bytes. */
function formatCanonicalHostPath(value: string): string | undefined {
	if (!value) return undefined;
	const resolved = path.normalize(value);
	if (process.platform !== "win32") return resolved;
	const rootLength = path.parse(resolved).root.length;
	let normalized = resolved.replace(/\\/g, "/");
	while (normalized.length > rootLength && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
	return normalized;
}

export interface WorktreePoolOptions {
	repoPath: string;
	targetSize?: number;
	componentsResolver?: () => Component[];
	baseRefResolver?: () => string | undefined;
	setupTimeoutResolver?: () => number | string | undefined;
	worktreeRoot?: string;
	projectRoot?: string;
	commandRunner?: CommandRunner;
	remotePolicy?: RemoteGitPolicy;
	worktreeSetupRuntime?: { skipNpmCi?: boolean; recordSetupPath?: string };
	fsImpl?: WorktreePoolFs;
	cleanupWorktreeImpl?: typeof cleanupWorktree;
	resolveRepoToplevelImpl?: (repoPath: string, commandRunner: CommandRunner) => Promise<string>;
	/** Narrow adoption seam; production uses native realpath and fails closed. */
	realpathNativeImpl?: (value: string) => Promise<string>;
	/** Test seam; production uses the process-wide canonical common-dir coordinator. */
	repositoryMutationCoordinator?: RepositoryMutationCoordinator;
	/** Exact durable ownership records used to reuse entries across restarts. */
	recordStore?: PoolRecordSink;
	/** Project key within `recordStore`; required when a record store is supplied. */
	projectId?: string;
}

/** Whether a branch name belongs to a pool entry (current or legacy form). */
export function isPoolBranch(branch: string): boolean {
	return isBobbitPoolBranch(branch);
}

/**
 * Move a worktree directory to a new path using `git worktree move`.
 *
 * `git worktree move` (added in git 2.17) atomically updates both the
 * worktree's `.git` pointer and the admin entry under `<repo>/.git/worktrees/`,
 * unlike a plain `mv` which leaves git tracking the old path.
 *
 * Inlined here from `skills/git.ts`: `pool.claim()` is now the sole caller
 * post-rename-removal, so this no longer needs to be a public skill export.
 */
/**
 * Resolve `p` to its enclosing git working-tree toplevel via
 * `git rev-parse --show-toplevel`. Falls back to the input on any error
 * (not a git repo, command failure, missing git binary). Logs a warn when
 * resolution changes the path so nested-rootPath misuse is visible.
 */
async function resolveRepoToplevel(p: string, commandRunner: CommandRunner = realCommandRunner): Promise<string> {
	try {
		const { stdout } = await execGit(["rev-parse", "--show-toplevel"], {
			cwd: p,
			timeout: 5_000,
			stdio: ["ignore", "pipe", "ignore"],
		}, commandRunner);
		const out = stdout.toString().trim();
		if (!out) return p;
		const resolved = path.resolve(out);
		const input = path.resolve(p);
		if (resolved !== input) {
			console.warn(`[worktree-pool] repoPath resolved from nested ${input} to git root ${resolved}`);
		}
		return resolved;
	} catch {
		return p;
	}
}

async function moveWorktree(repoPath: string, oldPath: string, newPath: string, commandRunner: CommandRunner = realCommandRunner): Promise<void> {
	if (oldPath === newPath) return;
	await execGit(["worktree", "move", oldPath, newPath], {
		cwd: repoPath,
		timeout: 30_000,
	}, commandRunner);
}

async function currentBranchUpstream(worktreePath: string, branch: string, commandRunner: CommandRunner = realCommandRunner): Promise<string | null> {
	try {
		const { stdout } = await execGit(["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`], {
			cwd: worktreePath,
			timeout: 5_000,
		}, commandRunner);
		const upstream = stdout.trim();
		return upstream || null;
	} catch {
		return null;
	}
}

async function clearBranchUpstream(worktreePath: string, branch: string, commandRunner: CommandRunner = realCommandRunner): Promise<void> {
	try {
		await execGit(["branch", "--unset-upstream", branch], {
			cwd: worktreePath,
			timeout: 5_000,
		}, commandRunner);
	} catch {
		// No upstream is already safe; continue with direct config cleanup as a belt-and-suspenders fallback.
	}
	for (const key of [`branch.${branch}.remote`, `branch.${branch}.merge`]) {
		try {
			await execGit(["config", "--unset-all", key], {
				cwd: worktreePath,
				timeout: 5_000,
			}, commandRunner);
		} catch {
			// Key absent or branch name requires Git's quoted subsection form; branch --unset-upstream handled normal cases.
		}
	}
}

async function ensureClaimedBranchSafeUpstream(worktreePath: string, branch: string, commandRunner: CommandRunner = realCommandRunner): Promise<void> {
	const inherited = await currentBranchUpstream(worktreePath, branch, commandRunner);
	if (!inherited) return;

	// Claim must never wait on the network or leave a claimed short-lived branch
	// tracking a remote branch by default. Drop inherited tracking immediately.
	await clearBranchUpstream(worktreePath, branch, commandRunner);
	const upstream = await currentBranchUpstream(worktreePath, branch, commandRunner);
	if (upstream) {
		throw new Error(`branch ${branch} still tracks ${upstream} after upstream safety cleanup`);
	}
}

export class WorktreePool {
	private pool: PoolEntry[] = [];
	private filling = false;
	/**
	 * Set by `stop()` / `drain()`. Once true no new background fill / freshen is
	 * scheduled — `replenish()`, `freshenInBackground()`, and
	 * `startFilling()` become no-ops. This closes a real teardown race: a
	 * `claim()` fires background `replenish()`/`freshenInBackground()` that used to
	 * be able to run AFTER `removeWorktreePool()`'s `drain()`, rebuilding worktrees
	 * for a project being deleted (and, in tests, racing repo cleanup).
	 */
	private stopped = false;
	/**
	 * Every in-flight pool operation that can mutate Git or the filesystem.
	 * Besides fill/freshen this includes foreground claims and the
	 * best-effort cleanup they schedule on failure. `stop()` loops over this set
	 * until it is empty, so a cleanup added late by an already-running claim is
	 * still part of the lifecycle barrier.
	 */
	private readonly inFlightOperations = new Set<Promise<unknown>>();
	private readonly inputRepoPath: string;
	private readonly projectRoot: string;
	private repoPath: string;
	private targetSize: number;
	private commandRunner: CommandRunner;
	private readonly fsImpl: WorktreePoolFs;
	private readonly cleanupWorktreeImpl: typeof cleanupWorktree;
	private readonly resolveRepoToplevelImpl: (repoPath: string, commandRunner: CommandRunner) => Promise<string>;
	private readonly realpathNativeImpl: (value: string) => Promise<string>;
	private readonly repositoryMutationCoordinator: RepositoryMutationCoordinator;
	private readonly recordStore?: PoolRecordSink;
	private readonly projectId?: string;
	private pathsResolved = false;
	private pathsResolution?: Promise<void>;
	private initializationStarted = false;
	private initialized = false;
	private initialization?: Promise<void>;

	/**
	 * Live resolver for the project's components[] — called fresh on every
	 * `_fill()` so config edits land on the next pool fill without restart.
	 * When unset (or empty), the pool falls back to legacy single-repo fill
	 * with no setup hook (no implicit project-yaml read — strictly opt-in).
	 */
	private componentsResolver?: () => Component[];

	/**
	 * Live resolver for the project's `base_ref` setting — called fresh on every
	 * `_fill()` and `freshenInBackground()` so pool entries auto-adopt the
	 * current configured integration target without a server restart. See
	 * `docs/design/base-ref.md` §7.
	 */
	private baseRefResolver?: () => string | undefined;

	/**
	 * Live resolver for the project's `worktree_setup_timeout_ms` setting — called
	 * fresh on every `_fill()` so the project default applies to per-component
	 * setup during pool prebuild too (matching the per-goal setup path). Returns
	 * a number, numeric string, or undefined; `resolveSetupTimeoutMs` validates
	 * and falls back to the 120s default when unset/invalid.
	 */
	private setupTimeoutResolver?: () => number | string | undefined;

	/** Project-level worktree_root input; a relative value is resolved exactly once. */
	private readonly configuredWorktreeRoot?: string;
	/** Resolved after async repo discovery; passed to every create helper. */
	private resolvedWorktreeRoot = "";
	private readonly remotePolicy: RemoteGitPolicy;
	private readonly worktreeSetupRuntime: { skipNpmCi?: boolean; recordSetupPath?: string };

	/**
	 * Construct a worktree pool without touching Git or the filesystem.
	 * `initialize()` asynchronously resolves nested repo paths before fill work
	 * is exposed to claims. `startFilling()` remains the compatible
	 * fire-and-forget entry point and delegates to that same initialization.
	 */
	constructor(opts: WorktreePoolOptions) {
		this.commandRunner = opts.commandRunner ?? realCommandRunner;
		this.inputRepoPath = opts.repoPath;
		this.projectRoot = opts.projectRoot ?? opts.repoPath;
		this.repoPath = opts.repoPath;
		this.targetSize = opts.targetSize ?? 2;
		this.componentsResolver = opts.componentsResolver;
		this.baseRefResolver = opts.baseRefResolver;
		this.setupTimeoutResolver = opts.setupTimeoutResolver;
		this.configuredWorktreeRoot = opts.worktreeRoot;
		this.remotePolicy = opts.remotePolicy ?? {};
		this.worktreeSetupRuntime = opts.worktreeSetupRuntime ?? {};
		this.fsImpl = opts.fsImpl ?? realWorktreePoolFs;
		this.cleanupWorktreeImpl = opts.cleanupWorktreeImpl ?? cleanupWorktree;
		this.resolveRepoToplevelImpl = opts.resolveRepoToplevelImpl ?? resolveRepoToplevel;
		this.realpathNativeImpl = opts.realpathNativeImpl ?? nativeRealpath;
		this.repositoryMutationCoordinator = opts.repositoryMutationCoordinator ?? repositoryMutationCoordinator;
		this.recordStore = opts.recordStore;
		this.projectId = opts.projectId;
	}

	private execGit(args: readonly string[], options?: any): Promise<{ stdout: string; stderr: string }> {
		return execGit(args, options, this.commandRunner);
	}

	/**
	 * Resolve the common Git directory shared by linked worktrees. Real Git
	 * failures intentionally fall through to the operation itself, which keeps
	 * the pool's existing cold-path fallback behaviour for malformed repos while
	 * still using the canonical common-dir key for every usable repository.
	 */
	private async resolveGitCommonDir(repoPath: string): Promise<string> {
		let commonDir = "";
		try {
			try {
				const result = await this.execGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
					cwd: repoPath,
					timeout: 5_000,
				});
				commonDir = result.stdout.toString().trim();
			} catch {
				const result = await this.execGit(["rev-parse", "--git-common-dir"], {
					cwd: repoPath,
					timeout: 5_000,
				});
				commonDir = result.stdout.toString().trim();
			}
		} catch {
			// The following mutating command provides the actionable Git error. This
			// fallback also keeps virtual command-runner tests from masquerading as
			// a real repository identity.
		}
		return canonicalGitCommonDir(commonDir
			? (path.isAbsolute(commonDir) ? commonDir : path.resolve(repoPath, commonDir))
			: repoPath);
	}

	private async withRepositoryMutation<T>(repoPath: string, operation: () => Promise<T>): Promise<T> {
		const commonDir = await this.resolveGitCommonDir(repoPath);
		return this.repositoryMutationCoordinator.run(commonDir, operation);
	}

	/** Acquire every repository lock in canonical order to prevent AB/BA deadlocks. */
	private async withRepositoryMutations<T>(repoPaths: readonly string[], operation: () => Promise<T>): Promise<T> {
		const keys = [...new Set(await Promise.all(repoPaths.map(repoPath => this.resolveGitCommonDir(repoPath))))].sort();
		const run = async (index: number): Promise<T> => index === keys.length
			? operation()
			: this.repositoryMutationCoordinator.run(keys[index]!, () => run(index + 1));
		return run(0);
	}

	/** Whether the given components list implies multi-repo fill. */
	private isMultiRepo(components: Component[] | undefined): boolean {
		return !!components && components.some(c => c.repo !== ".");
	}

	/** Number of ready worktrees available. */
	get size(): number { return this.pool.length; }

	/** Target pool size. */
	get target(): number { return this.targetSize; }

	/** Whether the pool is currently filling. */
	get isFilling(): boolean { return this.filling; }

	/** Status snapshot for the API. */
	getStatus(): { enabled: boolean; ready: number; target: number; filling: boolean } {
		return {
			enabled: this.targetSize > 0,
			ready: this.pool.length,
			target: this.targetSize,
			filling: this.filling,
		};
	}

	/** Read-only inventory snapshot for unified maintenance. */
	snapshotEntries(): WorktreePoolSnapshot {
		return {
			entries: this.pool.map(entry => ({
				branchName: entry.branchName,
				worktreePath: entry.worktreePath,
				worktrees: entry.worktrees?.map(w => ({ ...w })),
				createdAt: entry.createdAt,
			})),
			target: this.targetSize,
			filling: this.filling,
		};
	}

	private resolveRepositoryPaths(): Promise<void> {
		if (this.pathsResolved) return Promise.resolve();
		if (this.pathsResolution) return this.pathsResolution;

		const operation = (async () => {
			const resolvedRepoPath = await this.resolveRepoToplevelImpl(this.inputRepoPath, this.commandRunner);
			this.repoPath = resolvedRepoPath;
			// Resolve a relative override once against the registered project root,
			// never against the discovered/component repo path. Passing this absolute
			// value to createWorktree{,Set} keeps every fill on the same root.
			const worktreeRootBase = this.configuredWorktreeRoot ? this.projectRoot : resolvedRepoPath;
			this.resolvedWorktreeRoot = resolveWorktreeRoot({
				rootPath: worktreeRootBase,
				worktreeRoot: this.configuredWorktreeRoot,
			});
			this.pathsResolved = true;
		})();
		let resolution: Promise<void>;
		resolution = operation.catch((error) => {
			// A transient resolver failure must not poison every explicit initialize()
			// retry with the same cached rejection.
			if (!this.pathsResolved && this.pathsResolution === resolution) {
				this.pathsResolution = undefined;
			}
			throw error;
		});
		this.pathsResolution = resolution;
		return resolution;
	}

	/**
	 * Resolve repository paths, revalidate exact durable ownership records, then
	 * begin background fill. Branch/path shape alone is never adoption authority.
	 */
	initialize(activeWorktreePaths?: Set<string>): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.initialized) {
			this.replenish();
			return Promise.resolve();
		}
		if (this.initialization) return this.initialization;

		// Once boot initialization has ever begun, legacy registered entries stay
		// hidden through both the in-flight window and any failed-attempt gap. Only
		// a successful explicit retry may expose them again.
		this.initializationStarted = true;
		const operation = (async () => {
			await this.resolveRepositoryPaths();
			if (this.stopped) return;
			try {
				await this.adoptRecordedEntries(activeWorktreePaths);
			} catch (error) {
				console.warn("[worktree-pool] Adoption failed; continuing with a cold pool:", error);
			}
			if (this.stopped) return;
			this.initialized = true;
			this.replenish();
		})();
		const tracked = this.trackOperation(operation);
		this.initialization = tracked;
		void tracked.catch(() => {
			if (!this.initialized && !this.stopped && this.initialization === tracked) {
				this.initialization = undefined;
			}
		});
		return tracked;
	}

	/**
	 * Start filling the pool in the background. Call once after startup.
	 *
	 * @param activeWorktreePaths Exact live-session references that exclude an
	 *   otherwise valid durable record; never a source of adoption authority.
	 */
	startFilling(activeWorktreePaths?: Set<string>): void {
		if (this.stopped) return;
		if (cpuDiagnosticsEnabled()) {
			getCpuDiagnostics().recordTimer("worktree-pool:startFilling", 0, { calls: 1, activeWorktreePaths: activeWorktreePaths?.size ?? 0, ready: this.pool.length, target: this.targetSize });
		}
		void this.initialize(activeWorktreePaths).catch((err) => {
			console.warn("[worktree-pool] Initialization failed:", err);
		});
	}

	/** Track a mutation-capable operation until it settles. */
	private trackOperation<T>(op: Promise<T>): Promise<T> {
		const tracked = op.finally(() => { this.inFlightOperations.delete(tracked); });
		this.inFlightOperations.add(tracked);
		return tracked;
	}

	/**
	 * Claim failure still returns the cold-path fallback immediately, but its
	 * best-effort cleanup belongs to the pool lifecycle and must settle before
	 * `stop()`/`drain()` returns. Starting it from a resolved promise also turns a
	 * synchronously-throwing injected cleanup seam into a rejection we can own.
	 */
	private scheduleFailureCleanup(repoPath: string, worktreePath: string, branchName: string): void {
		const cleanup = Promise.resolve()
			.then(() => this.withRepositoryMutation(repoPath, async () => {
				await this.cleanupWorktreeImpl(repoPath, worktreePath, branchName, true, this.commandRunner, {
					...this.remotePolicy,
					skipRemotePush: true,
				});
			}))
			.catch(() => { /* best-effort; claim already logged the owning failure */ });
		this.trackOperation(cleanup);
	}

	private scheduleFailureCleanups(worktrees: readonly { repoPath: string; worktreePath: string }[], branchName: string): void {
		const cleanupPolicy: RemoteGitPolicy = { ...this.remotePolicy, skipRemotePush: true };
		const cleanup = this.withRepositoryMutations(worktrees.map(worktree => worktree.repoPath), async () => {
			await mapWithConcurrency(worktrees, RECOVERY_IO_CONCURRENCY, async (worktree) => {
				try {
					await this.cleanupWorktreeImpl(worktree.repoPath, worktree.worktreePath, branchName, true, this.commandRunner, cleanupPolicy);
				} catch {
					// Best-effort and isolated per repository; claim already logged the owning failure.
				}
			});
		}).catch(() => { /* best-effort; claim already logged the owning failure */ });
		this.trackOperation(cleanup);
	}

	/**
	 * Stop scheduling new work and await every in-flight mutation, including
	 * foreground claims and failure cleanups. Idempotent. The loop is required
	 * because an already-running claim can schedule cleanup while stop is waiting.
	 */
	async stop(): Promise<void> {
		this.stopped = true;
		while (this.inFlightOperations.size > 0) {
			await Promise.allSettled([...this.inFlightOperations]);
		}
	}

	/**
	 * Replace the components resolver used for future pool fills. Existing
	 * entries stay in the pool until claimed; the next `_fill()` calls the
	 * resolver to pick up the latest project config.
	 */
	setComponentsResolver(resolver: () => Component[]): void {
		this.componentsResolver = resolver;
	}

	/**
	 * Claim a pre-built worktree and rename it for a target branch.
	 *
	 * Steps performed synchronously (the caller awaits the rename):
	 *   1. `git branch -m pool/_pool-<id> <targetBranch>`
	 *   2. Clear any inherited upstream so the claimed branch stays local-only.
	 *   3. `git worktree move <oldPath> <newPath>` — on failure the call
	 *      returns null (caller falls back to `createWorktree`). No persistent
	 *      "degraded" state is emitted: post-refactor (see
	 *      `docs/design/remove-session-worktree-rename.md`) we never persist a
	 *      session whose dir name doesn't match its branch.
	 *
	 * Steps performed in the background (caller does NOT await):
	 *   4. `git fetch origin` + `git reset --hard <remote-primary>`.
	 *
	 * Returns null if the pool is empty, or if the directory rename fails
	 * (caller falls back to createWorktree).
	 */
	claim(targetBranch: string): Promise<PoolClaimResult | null> {
		return this.trackOperation(this.claimReadyEntry(targetBranch));
	}

	private async claimReadyEntry(targetBranch: string): Promise<PoolClaimResult | null> {
		// Initialization owns repo-root discovery. Do not let a concurrent request
		// observe entries before initialization settles; it takes the existing cold
		// createWorktree fallback instead. Explicit legacy entries remain claimable
		// only before the first initialization attempt begins.
		if (this.stopped || (this.initializationStarted && !this.initialized)) return null;

		const diagEnabled = cpuDiagnosticsEnabled();
		const diagStart = diagEnabled ? performance.now() : 0;
		const counters = diagEnabled ? {
			calls: 1,
			empty: 0,
			multiRepo: 0,
			readyAfterShift: 0,
			branchRenameErrors: 0,
			upstreamSafetyErrors: 0,
			moveErrors: 0,
			success: 0,
			degraded: 0,
		} : undefined;
		const recordClaimTimer = () => {
			if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-pool:claim", performance.now() - diagStart, counters);
		};
		const entry = this.pool.shift();
		// Once removed, ownership transfers to the session/goal lifecycle. Publish
		// before any Git mutation so a crash cannot leave stale pool authority.
		if (entry) this.recordEntries();
		if (!entry) {
			if (counters) counters.empty = 1;
			recordClaimTimer();
			return null;
		}
		if (counters) counters.readyAfterShift = this.pool.length;

		// Kick off background replenishment immediately
		this.replenish();

		// Multi-repo path: parallel per-repo branch rename + worktree move. The
		// container directory itself is renamed first because per-repo worktrees
		// live inside it; `git worktree move` then updates each repo's admin
		// pointer to the new container path.
		if (entry.worktrees && entry.worktrees.length > 0) {
			if (counters) counters.multiRepo = 1;
			try {
				const result = await this.withRepositoryMutations(
					entry.worktrees.map(worktree => worktree.repoPath),
					() => this._claimMultiRepo(entry, targetBranch),
				);
				if (counters) {
					counters.success = result ? 1 : 0;
					counters.degraded = result?.degraded ? 1 : 0;
				}
				recordClaimTimer();
				return result;
			} catch (err) {
				console.error(`[worktree-pool] Multi-repo claim coordination failed for ${targetBranch}:`, err);
				this.scheduleFailureCleanups(entry.worktrees, entry.branchName);
				recordClaimTimer();
				return null;
			}
		}

		// Branch rename, upstream cleanup, move, and rollback are one common-dir
		// transaction. A sibling setup cannot observe a partially claimed branch
		// or contend on the shared config file between those operations.
		try {
			return await this.withRepositoryMutation(this.repoPath, async () => {
		// 1. Rename branch (fast — local ref op).
		try {
			await this.execGit(["branch", "-m", entry.branchName, targetBranch], {
				cwd: entry.worktreePath,
				timeout: 10_000,
			});
		} catch (err) {
			if (counters) counters.branchRenameErrors = 1;
			console.error(`[worktree-pool] Branch rename failed (${entry.branchName} → ${targetBranch}):`, err);
			this.scheduleFailureCleanup(this.repoPath, entry.worktreePath, entry.branchName);
			recordClaimTimer();
			return null;
		}

		try {
			await ensureClaimedBranchSafeUpstream(entry.worktreePath, targetBranch, this.commandRunner);
		} catch (err) {
			if (counters) counters.upstreamSafetyErrors = 1;
			console.error(`[worktree-pool] Upstream safety cleanup failed for ${targetBranch}:`, err);
			try {
				await this.execGit(["branch", "-m", targetBranch, entry.branchName], {
					cwd: entry.worktreePath,
					timeout: 10_000,
				});
			} catch { /* best-effort */ }
			this.scheduleFailureCleanup(this.repoPath, entry.worktreePath, entry.branchName);
			recordClaimTimer();
			return null;
		}

		// 2. Move worktree directory to match the new branch slug. On failure we
		//    return null so the caller falls back to `createWorktree` — there is
		//    no persistent half-renamed state. (The branch rename in step 1 has
		//    already succeeded; we revert it here before bailing.)
		const targetSlug = branchToSlug(targetBranch);
		const wtRoot = path.dirname(entry.worktreePath);
		const newPath = path.join(wtRoot, targetSlug);
		let finalPath = entry.worktreePath;
		if (newPath !== entry.worktreePath) {
			try {
				await moveWorktree(this.repoPath, entry.worktreePath, newPath, this.commandRunner);
				finalPath = newPath;
			} catch (err) {
				if (counters) counters.moveErrors = 1;
				console.warn(`[worktree-pool] claim aborted: move ${entry.worktreePath} → ${newPath} failed: ${err instanceof Error ? err.message : err}`);
				// Revert the branch rename so the worktree's branch matches its dir again,
				// then clean up so the caller can fall back to createWorktree without
				// stepping on a half-renamed entry.
				try {
					await this.execGit(["branch", "-m", targetBranch, entry.branchName], {
						cwd: entry.worktreePath,
						timeout: 10_000,
					});
				} catch { /* best-effort */ }
				this.scheduleFailureCleanup(this.repoPath, entry.worktreePath, entry.branchName);
				recordClaimTimer();
				return null;
			}
		}

		// 3 + 4. Background freshen. Don't await — caller gets the worktree now.
		this.freshenInBackground(finalPath, targetBranch);

		console.log(`[worktree-pool] Claimed worktree: ${targetBranch} at ${finalPath} (pool: ${this.pool.length}/${this.targetSize})`);
		const result: PoolClaimResult = { worktreePath: finalPath, branchName: targetBranch, degraded: false };
		if (counters) counters.success = 1;
		recordClaimTimer();
		return result;
			});
		} catch (err) {
			console.error(`[worktree-pool] Claim coordination failed for ${targetBranch}:`, err);
			this.scheduleFailureCleanup(this.repoPath, entry.worktreePath, entry.branchName);
			recordClaimTimer();
			return null;
		}
	}

	/**
	 * Multi-repo claim: rename the container dir then run bounded per-repo
	 * `git branch -m` + `git worktree repair` so each repo's admin pointer
	 * tracks the new path. Results retain component order and failures remain
	 * independent — a repo where a mutation fails is degraded for that repo only.
	 */
	private async _claimMultiRepo(entry: PoolEntry, targetBranch: string): Promise<PoolClaimResult | null> {
		const targetSlug = branchToSlug(targetBranch);
		const wtRoot = path.dirname(entry.worktreePath);
		const newContainer = path.join(wtRoot, targetSlug);
		const worktrees = entry.worktrees!;

		// 1. Rename the container dir on the host (single fs.rename — fast and
		//    atomic on the same filesystem). Each repo's admin entry inside the
		//    parent repo's `.git/worktrees/<slug>/gitdir` still points at the old
		//    path; we fix that with `git worktree repair` after the move.
		//    On failure: clean up and return null so the caller falls back to
		//    createWorktreeSet — no half-state is persisted.
		let finalContainer = entry.worktreePath;
		if (newContainer !== entry.worktreePath) {
			try {
				await this.fsImpl.rename(entry.worktreePath, newContainer);
				finalContainer = newContainer;
			} catch (err) {
				console.warn(`[worktree-pool] multi-repo claim aborted: container rename ${entry.worktreePath} → ${newContainer} failed: ${err instanceof Error ? err.message : err}`);
				this.scheduleFailureCleanups(worktrees, entry.branchName);
				return null;
			}
		}

		// 2. Per-repo: rename the branch, clear any inherited upstream, and repair
		// worktree pointers under the shared background-I/O ceiling. No remote probes
		// run on the foreground claim path. mapWithConcurrency keeps result order.
		const perRepo = await mapWithConcurrency(worktrees, RECOVERY_IO_CONCURRENCY, async (w) => {
			const oldWtPath = w.worktreePath;
			const newWtPath = finalContainer === entry.worktreePath
				? oldWtPath
				: path.join(finalContainer, path.relative(entry.worktreePath, oldWtPath));
			let renamed = false;
			try {
				await this.execGit(["branch", "-m", entry.branchName, targetBranch], {
					cwd: newWtPath,
					timeout: 10_000,
				});
				renamed = true;
				try {
					await ensureClaimedBranchSafeUpstream(newWtPath, targetBranch, this.commandRunner);
				} catch (err) {
					console.warn(`[worktree-pool] multi-repo: upstream safety cleanup failed for ${w.repo}: ${err instanceof Error ? err.message : err}`);
					try {
						await this.execGit(["branch", "-m", targetBranch, entry.branchName], {
							cwd: newWtPath,
							timeout: 10_000,
						});
					} catch { /* best-effort */ }
					renamed = false;
				}
			} catch (err) {
				console.warn(`[worktree-pool] multi-repo: git branch -m failed for ${w.repo}: ${err instanceof Error ? err.message : err}`);
			}
			// Repair admin entry so `git worktree list` / future ops see the new path.
			if (finalContainer !== entry.worktreePath) {
				try {
					await this.execGit(["worktree", "repair", newWtPath], {
						cwd: w.repoPath,
						timeout: 15_000,
					});
				} catch (err) {
					console.warn(`[worktree-pool] multi-repo: git worktree repair failed for ${w.repo}: ${err instanceof Error ? err.message : err}`);
				}
			}
			return { repo: w.repo, worktreePath: newWtPath, renamed };
		});

		// Background freshen remains independent per successful repo, but scheduling
		// the batch as one tracked operation prevents a second unbounded Git burst.
		this.freshenManyInBackground(
			perRepo.filter(r => r.renamed).map(r => r.worktreePath),
			targetBranch,
		);

		const degraded = perRepo.some(r => !r.renamed);
		console.log(`[worktree-pool] Claimed multi-repo worktree set: ${targetBranch} at ${finalContainer}${degraded ? " (degraded)" : ""} (pool: ${this.pool.length}/${this.targetSize})`);
		return {
			worktreePath: finalContainer,
			branchName: targetBranch,
			degraded,
			worktrees: perRepo.map(r => ({ repo: r.repo, worktreePath: r.worktreePath })),
			container: finalContainer,
		};
	}

	/**
	 * Background freshen: fetch origin + reset --hard <base>.
	 * Resolves the base via `resolveBaseRef(repoPath, baseRefResolver())` so
	 * pool entries adopt the project's currently-configured `base_ref` at the
	 * moment they're freshened — no drain / no recorded-base needed. In offline
	 * test modes, skips non-local remote work while still allowing local bare origins.
	 * Errors are non-fatal and logged — the worktree is still usable.
	 */
	private freshenInBackground(worktreePath: string, branch: string): void {
		if (this.stopped) return;
		this.trackOperation(this.freshen(worktreePath, branch).catch(() => { /* swallow — already logged */ }));
	}

	private freshenManyInBackground(worktreePaths: readonly string[], branch: string): void {
		if (this.stopped || worktreePaths.length === 0) return;
		const operation = mapWithConcurrency(worktreePaths, RECOVERY_IO_CONCURRENCY, async (worktreePath) => {
			try {
				await this.freshen(worktreePath, branch);
			} catch {
				// Each freshen owns and logs its non-fatal failures.
			}
		});
		this.trackOperation(operation);
	}

	/**
	 * Internal async freshen. Exposed (package-private via `as any` access) for
	 * unit tests that need to await freshen completion before asserting HEAD.
	 * Not part of the public API.
	 */
	private async freshen(worktreePath: string, branch: string): Promise<void> {
		const diagEnabled = cpuDiagnosticsEnabled();
		const diagStart = diagEnabled ? performance.now() : 0;
		const counters = diagEnabled ? { calls: 1, fetchResetErrors: 0, success: 0 } : undefined;
		try {
			const skipRemoteGitForTests = await shouldSkipRemoteGitForTests(worktreePath, "origin", this.commandRunner, this.remotePolicy);
			if (!skipRemoteGitForTests) {
				try {
					await this.execGit(["fetch", "origin"], { cwd: worktreePath, timeout: 30_000 });
					const configured = this.baseRefResolver?.();
					const { ref: remotePrimary } = await resolveBaseRef(this.repoPath, configured, this.commandRunner);
					await this.execGit(["reset", "--hard", remotePrimary], { cwd: worktreePath, timeout: 10_000 });
				} catch (err) {
					if (counters) counters.fetchResetErrors = 1;
					console.warn(`[worktree-pool] Background reset failed for ${branch}:`, err instanceof Error ? err.message : err);
				}
			}
			if (counters) counters.success = counters.fetchResetErrors ? 0 : 1;
		} finally {
			if (diagEnabled) {
				getCpuDiagnostics().recordTimer("worktree-pool:freshen", performance.now() - diagStart, counters);
			}
		}
	}


	/** Fill pool up to targetSize in the background. */
	private replenish(): void {
		const diagEnabled = cpuDiagnosticsEnabled();
		if (this.stopped) return;
		if (this.filling) {
			if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-pool:replenish", 0, { calls: 1, skippedFilling: 1, ready: this.pool.length, target: this.targetSize });
			return;
		}
		if (this.pool.length >= this.targetSize) {
			if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-pool:replenish", 0, { calls: 1, skippedFull: 1, ready: this.pool.length, target: this.targetSize });
			return;
		}
		if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-pool:replenish", 0, { calls: 1, started: 1, ready: this.pool.length, target: this.targetSize });
		this.filling = true;
		this.trackOperation(this._fill().catch((err) => {
			console.error("[worktree-pool] Fill error:", err);
		}).finally(() => {
			this.filling = false;
		}));
	}

	private async _fill(): Promise<void> {
		const diagEnabled = cpuDiagnosticsEnabled();
		const diagStart = diagEnabled ? performance.now() : 0;
		const counters = diagEnabled ? {
			calls: 1,
			fillJobs: 0,
			entriesCreated: 0,
			failures: 0,
			singleRepoEntries: 0,
			multiRepoEntries: 0,
			setupComponents: 0,
			finalReady: 0,
			target: this.targetSize,
		} : undefined;
		try {
			// Normal initialization resolves this before replenish. Legacy externally
			// registered entries can be claimed before initialize(), though, so keep
			// their replacement fill on the same absolute root too.
			await this.resolveRepositoryPaths();
			while (!this.stopped && this.pool.length < this.targetSize) {
				if (counters) counters.fillJobs++;
				// Resolve components fresh on every fill so live project-config edits
				// (e.g. user toggles `worktreeSetupCommand` in Settings) take effect on
				// the very next pool entry without a server restart.
				const components = this.componentsResolver?.() ?? [];
				const multi = this.isMultiRepo(components);
				// Resolve base_ref fresh on every fill so config edits land on the next
				// pool entry without restart. Empty/undefined preserves today's
				// `resolveRemotePrimary` fallback (see `createWorktree`/`createWorktreeSet`).
				const configuredBaseRef = this.baseRefResolver?.();
				const uuid8 = randomUUID().slice(0, 8);
				const branchName = `${POOL_BRANCH_PREFIX}${uuid8}`;
				try {
					let container: string;
					let entry: PoolEntry;
					if (multi) {
						if (counters) counters.multiRepoEntries++;
						// Multi-repo prebuild via createWorktreeSet — entry carries per-repo paths.
						const set = await createWorktreeSet(this.repoPath, components, branchName, undefined, {
							worktreeRoot: this.resolvedWorktreeRoot,
							configuredBaseRef,
							commandRunner: this.commandRunner,
							remotePolicy: this.remotePolicy,
							repositoryMutationCoordinator: this.repositoryMutationCoordinator,
						});
						if (set.worktrees.length === 0) {
							console.warn(`[worktree-pool] Skipping pre-build ${branchName}: no worktree-able repo with a resolved HEAD`);
							break;
						}
						container = set.container;
						entry = {
							branchName,
							worktreePath: set.container,
							worktrees: set.worktrees,
							createdAt: Date.now(),
							durable: true,
						};
					} else {
						if (counters) counters.singleRepoEntries++;
						// Single-repo prebuild. NOTE: we no longer pass setupCommand to
						// createWorktree — the canonical path is runComponentSetups()
						// below so single-repo and multi-repo share one code path and
						// `components[*].worktreeSetupCommand` is the only source of truth.
						const result = await createWorktree(this.repoPath, branchName, {
							worktreeRoot: this.resolvedWorktreeRoot,
							configuredBaseRef,
							commandRunner: this.commandRunner,
							remotePolicy: this.remotePolicy,
							repositoryMutationCoordinator: this.repositoryMutationCoordinator,
						});
						container = result.worktreePath;
						entry = {
							branchName: result.branchName,
							worktreePath: result.worktreePath,
							createdAt: Date.now(),
							durable: true,
						};
					}

					// Per-component setup (npm ci, etc.) — runs BEFORE we expose the
					// entry in the pool so callers that claim immediately after fill
					// see node_modules/ already populated. Loud log so a future regression
					// of the source-of-truth migration cannot recur silently the way the
					// top-level `worktree_setup_command` read did.
					const setupNames = components.filter(c => c.worktreeSetupCommand).map(c => c.name);
					if (counters) counters.setupComponents += setupNames.length;
					if (setupNames.length > 0) {
						// Resolve the project default timeout fresh on every fill so a
						// `worktree_setup_timeout_ms` config edit applies to component setup
						// during pool prebuild too. No per-goal override exists at fill time
						// (the pool entry isn't yet claimed by a goal), so only the project
						// tier feeds the resolver here.
						const setupTimeoutMs = resolveSetupTimeoutMs({ projectTimeoutMs: this.setupTimeoutResolver?.() });
						console.log(`[worktree-pool] running setup for components: ${setupNames.join(", ")}`);
						try {
							await runComponentSetups({
								components,
								branchContainer: container,
								primaryWorktreeRoot: this.repoPath,
								timeoutMs: setupTimeoutMs,
								skipNpmCi: this.worktreeSetupRuntime.skipNpmCi,
								recordSetupPath: this.worktreeSetupRuntime.recordSetupPath,
								execHandlesTimeout: true,
								exec: async (cmd, cwd, env, timeoutMs) => {
									await execShellCommand(cmd, { cwd, env, timeout: timeoutMs });
								},
							});
						} catch (err) {
							console.warn(`[worktree-pool] runComponentSetups failed for ${branchName} (non-fatal):`, err);
						}
					}

					this.pool.push(entry);
					this.recordEntries();
					if (counters) counters.entriesCreated++;
					console.log(`[worktree-pool] Ready${multi ? " (multi-repo)" : ""}: ${branchName} (pool: ${this.pool.length}/${this.targetSize})`);
				} catch (err) {
					if (counters) counters.failures++;
					if (isUnresolvedHeadWorktreeError(err)) {
						console.warn(`[worktree-pool] Skipping pre-build ${branchName}: ${err.message}`);
					} else {
						console.error(`[worktree-pool] Failed to pre-build ${branchName}:`, err);
					}
					break;
				}
			}
		} finally {
			if (counters) counters.finalReady = this.pool.length;
			if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-pool:fill", performance.now() - diagStart, counters);
		}
	}

	private recordEntries(): void {
		if (!this.recordStore || !this.projectId) return;
		const entries: PoolEntryRecord[] = this.pool
			.filter(entry => entry.durable)
			.map(entry => ({
				branchName: entry.branchName,
				worktreePath: entry.worktreePath,
				...(entry.worktrees ? { worktrees: entry.worktrees.map(worktree => ({ ...worktree })) } : {}),
				createdAt: entry.createdAt,
			}));
		try {
			this.recordStore.replace(this.projectId, this.repoPath, entries);
		} catch (error) {
			console.warn("[worktree-pool] Failed to record pool entries:", error);
		}
	}

	/**
	 * Adopt only entries backed by this project's durable record and an exact,
	 * current Git path/branch match in every repository. Any live-session path
	 * overlap rejects the complete entry. Rejected paths are never mutated.
	 */
	private async adoptRecordedEntries(activeWorktreePaths?: Set<string>): Promise<void> {
		if (!this.recordStore || !this.projectId) return;
		const recorded = this.recordStore.read(this.projectId);
		if (recorded.entries.length === 0) return;

		const identityCache = new Map<string, Promise<string | undefined>>();
		const canonicalIdentity = (candidate: string): Promise<string | undefined> => {
			if (!candidate) return Promise.resolve(undefined);
			const resolved = path.resolve(candidate);
			let pending = identityCache.get(resolved);
			if (!pending) {
				pending = this.realpathNativeImpl(resolved)
					.then(formatCanonicalHostPath)
					.catch(() => undefined);
				identityCache.set(resolved, pending);
			}
			return pending;
		};
		const revokeRecords = (reason: string): void => {
			console.log(`[worktree-pool] Discarding ${recorded.entries.length} recorded entry(ies): ${reason}`);
			this.recordStore!.replace(this.projectId!, this.repoPath, []);
		};

		const [recordedRepoIdentity, currentRepoIdentity] = await Promise.all([
			recorded.repoPath ? canonicalIdentity(recorded.repoPath) : Promise.resolve(undefined),
			canonicalIdentity(this.repoPath),
		]);
		if (!recordedRepoIdentity || !currentRepoIdentity || recordedRepoIdentity !== currentRepoIdentity) {
			revokeRecords("repository path changed or could not be verified");
			return;
		}

		const active = await Promise.all([...(activeWorktreePaths ?? [])].map(canonicalIdentity));
		if (active.some(reference => !reference)) {
			revokeRecords("a live-session path could not be verified");
			return;
		}
		const activeIdentities = active as string[];
		const conflictsWithLiveSession = (candidate: string): boolean => activeIdentities.some(reference =>
			reference === candidate
				|| reference.startsWith(`${candidate}/`)
				|| candidate.startsWith(`${reference}/`),
		);

		const components = this.componentsResolver?.() ?? [];
		const configuredRepos = [...new Set(components.map(component => component.repo))];
		const expectsMultiRepo = configuredRepos.some(repo => repo !== ".");
		const expectedEligibleRepos: string[] = [];
		if (expectsMultiRepo) {
			const configuredBaseRef = (this.baseRefResolver?.() ?? "").trim();
			for (const repo of configuredRepos) {
				const repoPath = path.join(this.repoPath, repo === "." ? "" : repo);
				if (await isGitRepoRoot(repoPath, this.commandRunner)
					&& (configuredBaseRef || await hasResolvedHead(repoPath, this.commandRunner))) {
					expectedEligibleRepos.push(repo);
				}
			}
		}

		const gitLists = new Map<string, Promise<Map<string, string | undefined>>>();
		const listGitWorktrees = async (repoPath: string): Promise<Map<string, string | undefined>> => {
			const repoIdentity = await canonicalIdentity(repoPath);
			if (!repoIdentity) throw new Error("repository path could not be canonicalized");
			let pending = gitLists.get(repoIdentity);
			if (!pending) {
				pending = this.execGit(["worktree", "list", "--porcelain"], { cwd: repoPath, timeout: 10_000 })
					.then(async ({ stdout }) => {
						const worktrees = new Map<string, string | undefined>();
						for (const worktree of parseGitWorktreeList(stdout.toString())) {
							const identity = await canonicalIdentity(worktree.path);
							if (!identity) throw new Error(`Git-listed worktree path could not be canonicalized: ${worktree.path}`);
							if (worktrees.has(identity)) throw new Error(`Git listed ambiguous duplicate worktree identity: ${identity}`);
							worktrees.set(identity, worktree.branch);
						}
						return worktrees;
					});
				gitLists.set(repoIdentity, pending);
			}
			return pending;
		};
		const gitMatches = async (repoPath: string, worktreeIdentity: string, branchName: string): Promise<boolean> => {
			try {
				const worktrees = await listGitWorktrees(repoPath);
				return worktrees.has(worktreeIdentity) && worktrees.get(worktreeIdentity) === branchName;
			} catch (error) {
				console.warn(`[worktree-pool] Could not verify recorded worktree in ${repoPath}; leaving it untouched:`, error);
				return false;
			}
		};

		const adopted: PoolEntry[] = [];
		const adoptedPaths = new Set<string>();
		const adoptedBranches = new Set<string>();
		let rejected = 0;
		for (const entry of recorded.entries) {
			const entryIdentity = await canonicalIdentity(entry.worktreePath);
			let usable = isPoolBranch(entry.branchName)
				&& !!entryIdentity
				&& !conflictsWithLiveSession(entryIdentity);
			if (usable && entry.worktrees) {
				const repoNames = entry.worktrees.map(worktree => worktree.repo);
				usable = expectsMultiRepo
					&& repoNames.length === expectedEligibleRepos.length
					&& repoNames.every((repo, index) => repo === expectedEligibleRepos[index]);

				const repoIdentities = new Set<string>();
				const worktreeIdentities = new Set<string>();
				for (const worktree of entry.worktrees) {
					if (!usable) break;
					const expectedRepoPath = path.join(this.repoPath, worktree.repo === "." ? "" : worktree.repo);
					const expectedWorktreePath = path.join(entry.worktreePath, worktree.repo === "." ? "" : worktree.repo);
					const [repoIdentity, expectedRepoIdentity, worktreeIdentity, expectedWorktreeIdentity] = await Promise.all([
						canonicalIdentity(worktree.repoPath),
						canonicalIdentity(expectedRepoPath),
						canonicalIdentity(worktree.worktreePath),
						canonicalIdentity(expectedWorktreePath),
					]);
					const liesWithinContainer = !!entryIdentity && !!expectedWorktreeIdentity
						&& (worktree.repo === "."
							? expectedWorktreeIdentity === entryIdentity
							: expectedWorktreeIdentity.startsWith(`${entryIdentity}/`));
					usable = !!repoIdentity
						&& !!expectedRepoIdentity
						&& !!worktreeIdentity
						&& !!expectedWorktreeIdentity
						&& liesWithinContainer
						&& repoIdentity === expectedRepoIdentity
						&& worktreeIdentity === expectedWorktreeIdentity
						&& !repoIdentities.has(repoIdentity)
						&& !worktreeIdentities.has(worktreeIdentity)
						&& !conflictsWithLiveSession(worktreeIdentity)
						&& await gitMatches(worktree.repoPath, worktreeIdentity, entry.branchName);
					if (usable && repoIdentity && worktreeIdentity) {
						repoIdentities.add(repoIdentity);
						worktreeIdentities.add(worktreeIdentity);
					}
				}
			} else if (usable && entryIdentity) {
				usable = !expectsMultiRepo && await gitMatches(this.repoPath, entryIdentity, entry.branchName);
			}
			if (!usable || !entryIdentity || adoptedPaths.has(entryIdentity) || adoptedBranches.has(entry.branchName)) {
				rejected++;
				continue;
			}
			adoptedPaths.add(entryIdentity);
			adoptedBranches.add(entry.branchName);
			adopted.push({
				branchName: entry.branchName,
				worktreePath: entry.worktreePath,
				...(entry.worktrees ? { worktrees: entry.worktrees.map(worktree => ({ ...worktree })) } : {}),
				createdAt: entry.createdAt,
				durable: true,
			});
		}

		this.pool.push(...adopted);
		// Drop every stale/mismatched record. This only revokes adoption authority;
		// it never authorizes repair or deletion of the referenced directory.
		this.recordEntries();
		if (adopted.length > 0 || rejected > 0) {
			console.log(`[worktree-pool] Reused ${adopted.length} pre-built worktree(s) from the previous run`
				+ (rejected ? ` (${rejected} invalid record(s) left untouched)` : ""));
		}
	}

	/** Test seam for an explicitly supplied same-process entry; never persisted as restart authority. */
	registerExternalEntry(branchName: string, worktreePath: string): void {
		if (this.stopped || !isPoolBranch(branchName)) return;
		// Avoid duplicates
		if (this.pool.some(e => e.worktreePath === worktreePath)) return;
		this.pool.push({ branchName, worktreePath, createdAt: Date.now(), durable: false });
		if (cpuDiagnosticsEnabled()) {
			getCpuDiagnostics().recordTimer("worktree-pool:registerExternalEntry", 0, { registered: 1, ready: this.pool.length, target: this.targetSize });
		}
	}

	/**
	 * Clean up only the entries still held by this pool instance (worktree remove
	 * + local branch delete). Used for explicit project removal; graceful gateway
	 * shutdown stops and retains ready entries instead.
	 */
	async drain(): Promise<void> {
		const diagEnabled = cpuDiagnosticsEnabled();
		const diagStart = diagEnabled ? performance.now() : 0;
		// Stop scheduling and await in-flight background work FIRST so worktree
		// cleanup below never races a background fill/freshen `git` child (which,
		// once the repo is gone, fails with spawn ENOENT or a misreported
		// "base_ref no longer exists") and so a post-claim replenish cannot rebuild
		// entries for a pool being torn down.
		await this.stop();
		const entries = this.pool.splice(0);
		// Revoke restart adoption authority before destructive cleanup starts.
		this.recordEntries();
		if (entries.length === 0) {
			if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-pool:drain", performance.now() - diagStart, { entries: 0, skippedEmpty: 1 });
			return;
		}
		// Legacy externally-registered entries can be drained without a prior
		// initialize(). Resolve their repo root asynchronously before deletion.
		await this.resolveRepositoryPaths();
		const cleanupPolicy: RemoteGitPolicy = { ...this.remotePolicy, skipRemotePush: true };
		await mapWithConcurrency(entries, RECOVERY_IO_CONCURRENCY, async (entry) => {
			if (entry.worktrees && entry.worktrees.length > 0) {
				// Hold the complete set in canonical order. Cleanup remains sequential
				// within the set, so concurrent sets — not set size × sets — define the
				// global cleanup ceiling. A failure never prevents later repos in a set.
				try {
					await this.withRepositoryMutations(entry.worktrees.map(worktree => worktree.repoPath), async () => {
						for (const worktree of entry.worktrees!) {
							try {
								await this.cleanupWorktreeImpl(worktree.repoPath, worktree.worktreePath, entry.branchName, true, this.commandRunner, cleanupPolicy);
							} catch { /* all-settled per repository */ }
						}
					});
				} catch { /* all-settled per entry */ }
				return;
			}
			try {
				await this.withRepositoryMutation(this.repoPath, async () => {
					await this.cleanupWorktreeImpl(this.repoPath, entry.worktreePath, entry.branchName, true, this.commandRunner, cleanupPolicy);
				});
			} catch { /* all-settled per entry */ }
		});
		if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-pool:drain", performance.now() - diagStart, { entries: entries.length });
		console.log(`[worktree-pool] Drained ${entries.length} pre-built worktree(s)`);
	}
}
