/**
 * Pre-creates git worktrees so new sessions / goals can claim one instantly
 * instead of waiting 10-30s for `git worktree add` + setup.
 *
 * On startup, the pool fills to `targetSize` (default 2) in the background.
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
 *     via `createWorktreeSet` and `claim()` parallelises rename + move
 *     across repos.
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { constants as fsConstants, promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { createWorktree, cleanupWorktree, shouldSkipRemoteGitForTests, createWorktreeSet, resolveBaseRef, isUnresolvedHeadWorktreeError, type WorktreeResult, type RemoteGitPolicy } from "../skills/git.js";
import { runComponentSetups, resolveSetupTimeoutMs } from "../skills/worktree-setup.js";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "./cpu-diagnostics.js";
import { execShellCommand } from "./shell-util.js";
import type { Component } from "./project-config-store.js";
import { branchToSlug, worktreeRoot as resolveWorktreeRoot } from "../skills/worktree-paths.js";
import { classifyPoolReclaimCandidate, isBobbitPoolBranch, isContainerInternalWorktreePath, type WorktreePoolSnapshot } from "./worktree-inventory.js";
import { normalizeWorktreeHostPath } from "./worktree-reference-guard.js";
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
	access(filePath: string, mode?: number): Promise<void>;
	readdir(dirPath: string): Promise<Dirent[]>;
	rename(oldPath: string, newPath: string): Promise<void>;
}

const realWorktreePoolFs: WorktreePoolFs = {
	access: (filePath, mode) => fs.access(filePath, mode),
	readdir: async (dirPath) => await fs.readdir(dirPath, { withFileTypes: true }),
	rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
};

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
	 * Set by `stop()` / `drain()`. Once true no new background fill / freshen /
	 * startup reclaim is scheduled — `replenish()`, `freshenInBackground()`, and
	 * `startFilling()` become no-ops. This closes a real teardown race: a
	 * `claim()` fires background `replenish()`/`freshenInBackground()` that used to
	 * be able to run AFTER `removeWorktreePool()`'s `drain()`, rebuilding worktrees
	 * for a project being deleted (and, in tests, racing repo cleanup).
	 */
	private stopped = false;
	/**
	 * In-flight background operations (fill, freshen, startup reclaim). Tracked so
	 * `stop()`/`drain()` can await them and callers never race a live background
	 * `git` child against a repo/worktree-root that is about to be removed (which
	 * otherwise surfaces as `spawn git ENOENT` or a misreported
	 * `base_ref '<ref>' no longer exists` from `git worktree add`).
	 */
	private readonly backgroundOps = new Set<Promise<unknown>>();
	private readonly inputRepoPath: string;
	private readonly projectRoot: string;
	private repoPath: string;
	private targetSize: number;
	private commandRunner: CommandRunner;
	private readonly fsImpl: WorktreePoolFs;
	private readonly cleanupWorktreeImpl: typeof cleanupWorktree;
	private pathsResolved = false;
	private pathsResolution?: Promise<void>;
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

	/** Project-level worktree_root override (sibling of <rootPath>-wt by default). */
	private worktreeRoot?: string;
	/** Resolved after async repo discovery; never re-resolved against component repo paths. */
	private resolvedWorktreeRoot = "";
	private readonly remotePolicy: RemoteGitPolicy;
	private readonly worktreeSetupRuntime: { skipNpmCi?: boolean; recordSetupPath?: string };

	/**
	 * Construct a worktree pool without touching Git or the filesystem.
	 * `initialize()` asynchronously resolves nested repo paths before reclaim or
	 * fill work is exposed to claims. `startFilling()` remains the compatible
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
		this.worktreeRoot = opts.worktreeRoot;
		this.remotePolicy = opts.remotePolicy ?? {};
		this.worktreeSetupRuntime = opts.worktreeSetupRuntime ?? {};
		this.fsImpl = opts.fsImpl ?? realWorktreePoolFs;
		this.cleanupWorktreeImpl = opts.cleanupWorktreeImpl ?? cleanupWorktree;
	}

	private execGit(args: readonly string[], options?: any): Promise<{ stdout: string; stderr: string }> {
		return execGit(args, options, this.commandRunner);
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

		this.pathsResolution = (async () => {
			const resolvedRepoPath = await resolveRepoToplevel(this.inputRepoPath, this.commandRunner);
			this.repoPath = resolvedRepoPath;
			// A configured relative worktree_root remains relative to the registered
			// project root. Without an override, nested single-repo projects must use
			// the discovered Git root so reclaim and fill inspect the same directory.
			const worktreeRootBase = this.worktreeRoot ? this.projectRoot : resolvedRepoPath;
			this.resolvedWorktreeRoot = resolveWorktreeRoot({
				rootPath: worktreeRootBase,
				worktreeRoot: this.worktreeRoot,
			});
			this.pathsResolved = true;
		})();
		return this.pathsResolution;
	}

	/**
	 * Resolve repository paths, reclaim startup orphans, then begin background
	 * fill. Concurrent callers share one operation. Until it settles, `claim()`
	 * returns the normal cold-path fallback (`null`).
	 */
	initialize(activeWorktreePaths?: Set<string>): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.initialized) {
			this.replenish();
			return Promise.resolve();
		}
		if (this.initialization) return this.initialization;

		const operation = (async () => {
			await this.resolveRepositoryPaths();
			await this.reclaimOrphaned(activeWorktreePaths);
			if (this.stopped) return;
			this.initialized = true;
			this.replenish();
		})();
		const tracked = this.trackBackground(operation);
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
	 * @param activeWorktreePaths — Worktree paths currently owned by live sessions.
	 *   These are excluded from orphan reclamation to prevent the pool from stealing
	 *   a session's working directory on restart.
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

	/**
	 * Register a fire-and-forget background op so `stop()`/`drain()` can await it.
	 * The tracked promise is already rejection-safe (callers pass caught chains);
	 * it auto-removes itself from the set on settle.
	 */
	private trackBackground<T>(op: Promise<T>): Promise<T> {
		const tracked = op.finally(() => { this.backgroundOps.delete(tracked); });
		this.backgroundOps.add(tracked);
		return tracked;
	}

	/**
	 * Stop scheduling new background work and await all in-flight background
	 * operations. Idempotent. After this resolves nothing is filling or freshening
	 * and nothing is pending, so callers can safely remove the repo / worktree
	 * root without racing a background `git` child. Loops until the set converges
	 * to empty: the `stopped` guard makes any op that settles a no-op re-scheduler,
	 * so newly-tracked work cannot appear.
	 */
	async stop(): Promise<void> {
		this.stopped = true;
		while (this.backgroundOps.size > 0) {
			await Promise.allSettled([...this.backgroundOps]);
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
	async claim(targetBranch: string): Promise<PoolClaimResult | null> {
		// Initialization owns repo-root discovery and orphan selection. Do not let
		// a concurrent request observe a partially reclaimed pool; it takes the
		// existing cold createWorktree fallback instead. Explicit legacy entries
		// registered before initialization remain claimable for compatibility.
		if (this.stopped || (!this.initialized && this.initialization)) return null;

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
			const result = await this._claimMultiRepo(entry, targetBranch);
			if (counters) {
				counters.success = result ? 1 : 0;
				counters.degraded = result?.degraded ? 1 : 0;
			}
			recordClaimTimer();
			return result;
		}

		// 1. Rename branch (fast — local ref op).
		try {
			await this.execGit(["branch", "-m", entry.branchName, targetBranch], {
				cwd: entry.worktreePath,
				timeout: 10_000,
			});
		} catch (err) {
			if (counters) counters.branchRenameErrors = 1;
			console.error(`[worktree-pool] Branch rename failed (${entry.branchName} → ${targetBranch}):`, err);
			cleanupWorktree(this.repoPath, entry.worktreePath, entry.branchName, true, this.commandRunner, this.remotePolicy).catch(() => {});
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
			cleanupWorktree(this.repoPath, entry.worktreePath, entry.branchName, true, this.commandRunner, this.remotePolicy).catch(() => {});
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
				cleanupWorktree(this.repoPath, entry.worktreePath, entry.branchName, true, this.commandRunner, this.remotePolicy).catch(() => {});
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
	}

	/**
	 * Multi-repo claim: rename the container dir then `Promise.all` per-repo
	 * `git branch -m` + `git worktree move` so each repo's admin pointer
	 * tracks the new path. Per-repo failures are independent — a repo where
	 * the move fails ends up degraded for that repo only.
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
				for (const w of worktrees) {
					cleanupWorktree(w.repoPath, w.worktreePath, entry.branchName, true, this.commandRunner, this.remotePolicy).catch(() => {});
				}
				return null;
			}
		}

		// 2. Per-repo: rename the branch, clear any inherited upstream, and repair
		// worktree pointers in parallel. No remote probes run on the claim path.
		const perRepo = await Promise.all(worktrees.map(async (w) => {
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
		}));

		// Background freshen for each successfully renamed repo (independent).
		for (const r of perRepo) {
			if (r.renamed) this.freshenInBackground(r.worktreePath, targetBranch);
		}

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
		this.trackBackground(this.freshen(worktreePath, branch).catch(() => { /* swallow — already logged */ }));
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

	private hasPoolEntry(branchName: string | undefined, worktreePath: string, worktrees?: Array<{ repo: string; repoPath: string; worktreePath: string }>): boolean {
		const candidatePath = normalizeWorktreeHostPath(worktreePath);
		const candidateWorktreePaths = new Set((worktrees ?? []).map(w => normalizeWorktreeHostPath(w.worktreePath)).filter(Boolean) as string[]);
		return this.pool.some(entry => {
			if (branchName && entry.branchName === branchName) return true;
			const entryPath = normalizeWorktreeHostPath(entry.worktreePath);
			if (entryPath && candidatePath && entryPath === candidatePath) return true;
			for (const wt of entry.worktrees ?? []) {
				const wtPath = normalizeWorktreeHostPath(wt.worktreePath);
				if (wtPath && candidatePath && wtPath === candidatePath) return true;
				if (wtPath && candidateWorktreePaths.has(wtPath)) return true;
			}
			return false;
		});
	}

	private async inspectMultiRepoPoolCandidate(container: string, components: Component[]): Promise<{ branch: string; worktrees: Array<{ repo: string; repoPath: string; worktreePath: string }> } | null> {
		const worktrees: Array<{ repo: string; repoPath: string; worktreePath: string }> = [];
		const seenRepos = new Set<string>();
		let expectedBranch: string | undefined;

		// Keep declared-repo order and validate every distinct repo. Candidate-level
		// concurrency is applied by reclaimOrphaned(), so this loop stays sequential
		// and cannot multiply the shared ceiling for large multi-repo projects.
		for (const component of components) {
			const repo = component.repo;
			if (seenRepos.has(repo)) continue;
			seenRepos.add(repo);

			const repoPath = path.join(this.repoPath, repo === "." ? "" : repo);
			try {
				await this.fsImpl.access(repoPath, fsConstants.R_OK);
				await this.fsImpl.access(path.join(repoPath, ".git"), fsConstants.R_OK);
			} catch {
				return null;
			}

			const wtPath = repo === "." ? container : path.join(container, repo);
			try {
				await this.fsImpl.access(wtPath, fsConstants.R_OK);
				await this.fsImpl.access(path.join(wtPath, ".git"), fsConstants.R_OK);
			} catch {
				return null;
			}

			let branch: string;
			try {
				const { stdout } = await this.execGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wtPath, timeout: 5_000 });
				branch = stdout.trim();
			} catch {
				return null;
			}

			if (!expectedBranch) expectedBranch = branch;
			if (branch !== expectedBranch) return null;
			worktrees.push({ repo, repoPath, worktreePath: wtPath });
		}

		if (!expectedBranch || worktrees.length === 0) return null;
		return { branch: expectedBranch, worktrees };
	}

	private async inspectReclaimCandidate(
		entry: Dirent,
		wtRoot: string,
		components: Component[],
		multi: boolean,
		activeWorktreePaths?: Set<string>,
	): Promise<{
		candidate?: { branch: string; container: string; worktrees?: Array<{ repo: string; repoPath: string; worktreePath: string }> };
		activeSkipped?: boolean;
		gitMissing?: boolean;
	}> {
		if (!entry.isDirectory()) return {};
		const container = path.join(wtRoot, entry.name);
		if (isContainerInternalWorktreePath(container)) return { activeSkipped: true };

		if (multi) {
			const candidate = await this.inspectMultiRepoPoolCandidate(container, components);
			const verdict = classifyPoolReclaimCandidate({
				resolvedWorktreeRoot: wtRoot,
				candidatePath: container,
				branch: candidate?.branch,
				activeWorktreePaths,
				gitMetadataExists: !!candidate,
			});
			if (!verdict.eligible || !candidate) {
				return {
					activeSkipped: verdict.reason === "referenced-by-live-session",
					gitMissing: !candidate,
				};
			}
			return { candidate: { branch: candidate.branch, container, worktrees: candidate.worktrees } };
		}

		try {
			await this.fsImpl.access(path.join(container, ".git"), fsConstants.R_OK);
		} catch {
			return { gitMissing: true };
		}
		const { stdout } = await this.execGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: container, timeout: 5_000 });
		const branch = stdout.trim();
		const verdict = classifyPoolReclaimCandidate({
			resolvedWorktreeRoot: wtRoot,
			candidatePath: container,
			branch,
			activeWorktreePaths,
			gitMetadataExists: true,
		});
		if (!verdict.eligible) {
			return { activeSkipped: verdict.reason === "referenced-by-live-session" };
		}
		return { candidate: { branch, container } };
	}

	/**
	 * Scan for orphaned pool worktrees from a previous server instance and reclaim them.
	 * An orphaned pool worktree is a directory under `<repo>-wt/` whose branch is still
	 * a pool branch (i.e. it was never claimed by a session/goal).
	 *
	 * Accepts both the new `pool/_pool-*` and legacy `session/_pool-*` prefixes.
	 * Candidate inspection is bounded, while candidates are committed to the pool
	 * strictly in directory-enumeration order. Batches never exceed the remaining
	 * target capacity, so reclaim stops without selecting extra later candidates.
	 *
	 * @param activeWorktreePaths — Paths owned by live sessions; skip these even if
	 *   the branch name looks like a pool branch (the session may not have renamed it
	 *   yet, or recovery may have restored the original pool branch name).
	 */
	private async reclaimOrphaned(activeWorktreePaths?: Set<string>): Promise<void> {
		const diagEnabled = cpuDiagnosticsEnabled();
		const diagStart = diagEnabled ? performance.now() : 0;
		const counters = diagEnabled ? { scans: 1, rootMissing: 0, entriesScanned: 0, activeSkipped: 0, gitMissing: 0, reclaimed: 0, errors: 0 } : undefined;
		try {
			await this.resolveRepositoryPaths();
			if (this.pool.length >= this.targetSize) return;
			const wtRoot = this.resolvedWorktreeRoot;
			let entries: Dirent[];
			try {
				entries = await this.fsImpl.readdir(wtRoot);
			} catch (err) {
				if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
					if (counters) counters.rootMissing = 1;
					return;
				}
				throw err;
			}

			const components = this.componentsResolver?.() ?? [];
			const multi = this.isMultiRepo(components);
			let cursor = 0;
			while (cursor < entries.length && this.pool.length < this.targetSize) {
				const remainingCapacity = this.targetSize - this.pool.length;
				const batchSize = Math.min(RECOVERY_IO_CONCURRENCY, remainingCapacity, entries.length - cursor);
				const batch = entries.slice(cursor, cursor + batchSize);
				cursor += batch.length;
				if (counters) counters.entriesScanned += batch.length;

				const inspected = await mapWithConcurrency(batch, RECOVERY_IO_CONCURRENCY, async (entry) => {
					try {
						return await this.inspectReclaimCandidate(entry, wtRoot, components, multi, activeWorktreePaths);
					} catch {
						// Per-candidate Git/filesystem failures never abort later candidates.
						return {};
					}
				});

				for (const result of inspected) {
					if (result.activeSkipped && counters) counters.activeSkipped++;
					if (result.gitMissing && counters) counters.gitMissing++;
					const candidate = result.candidate;
					if (!candidate || this.pool.length >= this.targetSize) continue;
					if (this.hasPoolEntry(candidate.branch, candidate.container, candidate.worktrees)) continue;
					this.pool.push({
						branchName: candidate.branch,
						worktreePath: candidate.container,
						worktrees: candidate.worktrees,
						createdAt: Date.now(),
					});
					if (counters) counters.reclaimed++;
					const multiLabel = candidate.worktrees ? " multi-repo" : "";
					console.log(`[worktree-pool] Reclaimed orphaned${multiLabel}: ${candidate.branch} at ${candidate.container} (pool: ${this.pool.length}/${this.targetSize})`);
				}
			}
		} catch (err) {
			if (counters) counters.errors = 1;
			console.warn("[worktree-pool] Orphan reclaim scan failed:", err);
		} finally {
			if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-pool:reclaimOrphaned", performance.now() - diagStart, counters);
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
		this.trackBackground(this._fill().catch((err) => {
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
							worktreeRoot: this.worktreeRoot,
							configuredBaseRef,
							commandRunner: this.commandRunner,
							remotePolicy: this.remotePolicy,
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
						};
					} else {
						if (counters) counters.singleRepoEntries++;
						// Single-repo prebuild. NOTE: we no longer pass setupCommand to
						// createWorktree — the canonical path is runComponentSetups()
						// below so single-repo and multi-repo share one code path and
						// `components[*].worktreeSetupCommand` is the only source of truth.
						const result = await createWorktree(this.repoPath, branchName, {
							worktreeRoot: this.worktreeRoot,
							configuredBaseRef,
							commandRunner: this.commandRunner,
							remotePolicy: this.remotePolicy,
						});
						container = result.worktreePath;
						entry = {
							branchName: result.branchName,
							worktreePath: result.worktreePath,
							createdAt: Date.now(),
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

	/** Push a pre-existing pool entry into the in-memory pool. Used by the boot sweeper. */
	registerExternalEntry(branchName: string, worktreePath: string): void {
		if (this.stopped || !isPoolBranch(branchName)) return;
		// Avoid duplicates
		if (this.pool.some(e => e.worktreePath === worktreePath)) return;
		this.pool.push({ branchName, worktreePath, createdAt: Date.now() });
		if (cpuDiagnosticsEnabled()) {
			getCpuDiagnostics().recordTimer("worktree-pool:registerExternalEntry", 0, { registered: 1, ready: this.pool.length, target: this.targetSize });
		}
	}

	/**
	 * Clean up all pool entries (worktree remove + branch delete). NOT called on
	 * gateway shutdown anymore — shutdown intentionally leaves pool worktrees on
	 * disk for `reclaimOrphaned` to re-adopt on the next boot. Only explicit
	 * teardown drains: project removal (`removeWorktreePool`) and Settings →
	 * Maintenance cleanup.
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
		if (entries.length === 0) {
			if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-pool:drain", performance.now() - diagStart, { entries: 0, skippedEmpty: 1 });
			return;
		}
		// Legacy externally-registered entries can be drained without a prior
		// initialize(). Resolve their repo root asynchronously before deletion.
		await this.resolveRepositoryPaths();
		await mapWithConcurrency(entries, RECOVERY_IO_CONCURRENCY, async (entry) => {
			if (entry.worktrees && entry.worktrees.length > 0) {
				// Keep each set sequential so concurrent sets — not set size × sets —
				// define the global cleanup ceiling. Failure in one repo never prevents
				// cleanup of the remaining repos in the same pool set.
				for (const worktree of entry.worktrees) {
					try {
						await this.cleanupWorktreeImpl(worktree.repoPath, worktree.worktreePath, entry.branchName, true, this.commandRunner, this.remotePolicy);
					} catch { /* all-settled per repository */ }
				}
				return;
			}
			try {
				await this.cleanupWorktreeImpl(this.repoPath, entry.worktreePath, entry.branchName, true, this.commandRunner, this.remotePolicy);
			} catch { /* all-settled per entry */ }
		});
		if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-pool:drain", performance.now() - diagStart, { entries: entries.length });
		console.log(`[worktree-pool] Drained ${entries.length} pre-built worktree(s)`);
	}
}
