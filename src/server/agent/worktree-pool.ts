/**
 * Pre-creates git worktrees so new sessions / goals can claim one instantly
 * instead of waiting 10-30s for `git worktree add` + setup + `git push`.
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
 *   - The fetch + reset + push that used to block claim now run in the
 *     background after returning the worktree to the caller.
 *   - `setComponents()` accepts the project's component list. When the
 *     components imply multi-repo, `_fill()` builds multi-repo pool sets
 *     via `createWorktreeSet` and `claim()` parallelises rename + move
 *     across repos.
 */

import { randomUUID } from "node:crypto";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { createWorktree, cleanupWorktree, shouldSkipRemotePush, createWorktreeSet, resolveBaseRef, type WorktreeResult } from "../skills/git.js";
import { runComponentSetups } from "../skills/worktree-setup.js";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "./cpu-diagnostics.js";
import { execShellCommand } from "./shell-util.js";
import type { Component } from "./project-config-store.js";

const execFile = promisify(execFileCb);

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

async function execGit(args: readonly string[], options?: any): Promise<{ stdout: string; stderr: string }> {
	if (!cpuDiagnosticsEnabled()) {
		return await execFile("git", args, options) as unknown as { stdout: string; stderr: string };
	}
	const start = performance.now();
	let success = 0;
	let errorCode = "none";
	try {
		const result = await execFile("git", args, options) as unknown as { stdout: string; stderr: string };
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

function execGitSync(args: readonly string[], options?: any): Buffer | string {
	if (!cpuDiagnosticsEnabled()) {
		return execFileSync("git", args, options);
	}
	const start = performance.now();
	let success = 0;
	let errorCode = "none";
	try {
		const result = execFileSync("git", args, options);
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
const LEGACY_POOL_BRANCH_PREFIX = "session/_pool-";

/** Whether a branch name belongs to a pool entry (current or legacy form). */
export function isPoolBranch(branch: string): boolean {
	return branch.startsWith(POOL_BRANCH_PREFIX) || branch.startsWith(LEGACY_POOL_BRANCH_PREFIX);
}

/** Flatten a branch name into a directory-safe slug (matches createWorktree's convention). */
function branchToSlug(branch: string): string {
	return branch.replace(/\//g, "-");
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
function resolveRepoToplevel(p: string): string {
	try {
		const out = execGitSync(["rev-parse", "--show-toplevel"], {
			cwd: p,
			timeout: 5_000,
			stdio: ["ignore", "pipe", "ignore"],
		}).toString().trim();
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

async function moveWorktree(repoPath: string, oldPath: string, newPath: string): Promise<void> {
	if (oldPath === newPath) return;
	await execGit(["worktree", "move", oldPath, newPath], {
		cwd: repoPath,
		timeout: 30_000,
	});
}

async function fetchRemoteTrackingBranch(worktreePath: string, branch: string): Promise<void> {
	await execGit(["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`], {
		cwd: worktreePath,
		timeout: 15_000,
	});
}

async function hasOriginRemote(worktreePath: string): Promise<boolean> {
	try {
		const { stdout } = await execGit(["config", "--get", "remote.origin.url"], {
			cwd: worktreePath,
			timeout: 5_000,
		});
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}

async function localRemoteTrackingBranchExists(worktreePath: string, branch: string): Promise<boolean> {
	try {
		await execGit(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
			cwd: worktreePath,
			timeout: 5_000,
		});
		return true;
	} catch {
		return false;
	}
}

async function remoteBranchExists(worktreePath: string, branch: string): Promise<boolean> {
	if (await localRemoteTrackingBranchExists(worktreePath, branch)) return true;

	if (!(await hasOriginRemote(worktreePath))) return false;

	try {
		await execGit(["ls-remote", "--exit-code", "--heads", "origin", branch], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		try {
			await fetchRemoteTrackingBranch(worktreePath, branch);
		} catch {
			// Best-effort: --set-upstream-to below will fall back to clearing if the
			// local tracking ref could not be materialized.
		}
		return true;
	} catch {
		return false;
	}
}

async function currentBranchUpstream(worktreePath: string, branch: string): Promise<string | null> {
	try {
		const { stdout } = await execGit(["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`], {
			cwd: worktreePath,
			timeout: 5_000,
		});
		const upstream = stdout.trim();
		return upstream || null;
	} catch {
		return null;
	}
}

async function clearBranchUpstream(worktreePath: string, branch: string): Promise<void> {
	try {
		await execGit(["branch", "--unset-upstream", branch], {
			cwd: worktreePath,
			timeout: 5_000,
		});
	} catch {
		// No upstream is already safe; continue with direct config cleanup as a belt-and-suspenders fallback.
	}
	for (const key of [`branch.${branch}.remote`, `branch.${branch}.merge`]) {
		try {
			await execGit(["config", "--unset-all", key], {
				cwd: worktreePath,
				timeout: 5_000,
			});
		} catch {
			// Key absent or branch name requires Git's quoted subsection form; branch --unset-upstream handled normal cases.
		}
	}
}

async function setBranchUpstreamToOrigin(worktreePath: string, branch: string): Promise<void> {
	await execGit(["branch", `--set-upstream-to=origin/${branch}`, branch], {
		cwd: worktreePath,
		timeout: 10_000,
	});
}

async function ensureClaimedBranchSafeUpstream(worktreePath: string, branch: string): Promise<void> {
	const desired = `origin/${branch}`;
	const inherited = await currentBranchUpstream(worktreePath, branch);
	if (inherited === desired) return;

	if (!inherited) {
		// Fast path for normal pool entries with no upstream: avoid a synchronous
		// remote probe unless we already know about origin/<branch> locally.
		if (await localRemoteTrackingBranchExists(worktreePath, branch)) {
			await setBranchUpstreamToOrigin(worktreePath, branch);
		}
		return;
	}

	if (await remoteBranchExists(worktreePath, branch)) {
		try {
			await setBranchUpstreamToOrigin(worktreePath, branch);
			return;
		} catch (err) {
			console.warn(`[worktree-pool] Failed to set upstream for ${branch} to ${desired}; clearing inherited upstream: ${err instanceof Error ? err.message : err}`);
		}
	}

	await clearBranchUpstream(worktreePath, branch);
	const upstream = await currentBranchUpstream(worktreePath, branch);
	if (upstream && upstream !== desired) {
		throw new Error(`branch ${branch} still tracks ${upstream} after upstream safety cleanup`);
	}
}

export class WorktreePool {
	private pool: PoolEntry[] = [];
	private filling = false;
	private repoPath: string;
	private targetSize: number;

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

	/** Project-level worktree_root override (sibling of <rootPath>-wt by default). */
	private worktreeRoot?: string;

	/**
	 * Construct a worktree pool.
	 *
	 * `opts.repoPath` SHOULD be a git toplevel. If a nested path inside a git
	 * working tree is supplied (e.g. a project with `rootPath` pointing at a
	 * subdirectory inside a larger repo), the constructor self-heals by
	 * resolving to the toplevel via `git rev-parse --show-toplevel`. After
	 * construction, `this.repoPath` is always the git root (or, when the
	 * supplied path isn't a git working tree at all, the original input).
	 */
	constructor(opts: { repoPath: string; targetSize?: number; componentsResolver?: () => Component[]; baseRefResolver?: () => string | undefined; worktreeRoot?: string }) {
		this.repoPath = resolveRepoToplevel(opts.repoPath);
		this.targetSize = opts.targetSize ?? 2;
		this.componentsResolver = opts.componentsResolver;
		this.baseRefResolver = opts.baseRefResolver;
		this.worktreeRoot = opts.worktreeRoot;
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

	/**
	 * Start filling the pool in the background. Call once after startup.
	 *
	 * @param activeWorktreePaths — Worktree paths currently owned by live sessions.
	 *   These are excluded from orphan reclamation to prevent the pool from stealing
	 *   a session's working directory on restart.
	 */
	startFilling(activeWorktreePaths?: Set<string>): void {
		if (cpuDiagnosticsEnabled()) {
			getCpuDiagnostics().recordTimer("worktree-pool:startFilling", 0, { calls: 1, activeWorktreePaths: activeWorktreePaths?.size ?? 0, ready: this.pool.length, target: this.targetSize });
		}
		this.reclaimOrphaned(activeWorktreePaths).then(() => this.replenish()).catch(() => this.replenish());
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
	 *   2. Clear any inherited upstream, or point it at `origin/<targetBranch>`
	 *      when that remote branch already exists.
	 *   3. `git worktree move <oldPath> <newPath>` — on failure the call
	 *      returns null (caller falls back to `createWorktree`). No persistent
	 *      "degraded" state is emitted: post-refactor (see
	 *      `docs/design/remove-session-worktree-rename.md`) we never persist a
	 *      session whose dir name doesn't match its branch.
	 *
	 * Steps performed in the background (caller does NOT await):
	 *   4. `git fetch origin` + `git reset --hard <remote-primary>`
	 *   5. Explicitly push `<targetBranch>:refs/heads/<targetBranch>` and set
	 *      upstream to `origin/<targetBranch>` (skipped under BOBBIT_TEST_NO_PUSH=1).
	 *
	 * Returns null if the pool is empty, or if the directory rename fails
	 * (caller falls back to createWorktree).
	 */
	async claim(targetBranch: string): Promise<PoolClaimResult | null> {
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
			await execGit(["branch", "-m", entry.branchName, targetBranch], {
				cwd: entry.worktreePath,
				timeout: 10_000,
			});
		} catch (err) {
			if (counters) counters.branchRenameErrors = 1;
			console.error(`[worktree-pool] Branch rename failed (${entry.branchName} → ${targetBranch}):`, err);
			cleanupWorktree(this.repoPath, entry.worktreePath, entry.branchName, true).catch(() => {});
			recordClaimTimer();
			return null;
		}

		try {
			await ensureClaimedBranchSafeUpstream(entry.worktreePath, targetBranch);
		} catch (err) {
			if (counters) counters.upstreamSafetyErrors = 1;
			console.error(`[worktree-pool] Upstream safety cleanup failed for ${targetBranch}:`, err);
			try {
				await execGit(["branch", "-m", targetBranch, entry.branchName], {
					cwd: entry.worktreePath,
					timeout: 10_000,
				});
			} catch { /* best-effort */ }
			cleanupWorktree(this.repoPath, entry.worktreePath, entry.branchName, true).catch(() => {});
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
				await moveWorktree(this.repoPath, entry.worktreePath, newPath);
				finalPath = newPath;
			} catch (err) {
				if (counters) counters.moveErrors = 1;
				console.warn(`[worktree-pool] claim aborted: move ${entry.worktreePath} → ${newPath} failed: ${err instanceof Error ? err.message : err}`);
				// Revert the branch rename so the worktree's branch matches its dir again,
				// then clean up so the caller can fall back to createWorktree without
				// stepping on a half-renamed entry.
				try {
					await execGit(["branch", "-m", targetBranch, entry.branchName], {
						cwd: entry.worktreePath,
						timeout: 10_000,
					});
				} catch { /* best-effort */ }
				cleanupWorktree(this.repoPath, entry.worktreePath, entry.branchName, true).catch(() => {});
				recordClaimTimer();
				return null;
			}
		}

		// 3 + 4. Background freshen + push. Don't await — caller gets the worktree now.
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
				fs.renameSync(entry.worktreePath, newContainer);
				finalContainer = newContainer;
			} catch (err) {
				console.warn(`[worktree-pool] multi-repo claim aborted: container rename ${entry.worktreePath} → ${newContainer} failed: ${err instanceof Error ? err.message : err}`);
				for (const w of worktrees) {
					cleanupWorktree(w.repoPath, w.worktreePath, entry.branchName, true).catch(() => {});
				}
				return null;
			}
		}

		// 2. Per-repo: rename the branch, clear any inherited upstream, and repair
		// worktree pointers in parallel.
		const perRepo = await Promise.all(worktrees.map(async (w) => {
			const oldWtPath = w.worktreePath;
			const newWtPath = finalContainer === entry.worktreePath
				? oldWtPath
				: path.join(finalContainer, path.relative(entry.worktreePath, oldWtPath));
			let renamed = false;
			try {
				await execGit(["branch", "-m", entry.branchName, targetBranch], {
					cwd: newWtPath,
					timeout: 10_000,
				});
				renamed = true;
				try {
					await ensureClaimedBranchSafeUpstream(newWtPath, targetBranch);
				} catch (err) {
					console.warn(`[worktree-pool] multi-repo: upstream safety cleanup failed for ${w.repo}: ${err instanceof Error ? err.message : err}`);
					try {
						await execGit(["branch", "-m", targetBranch, entry.branchName], {
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
					await execGit(["worktree", "repair", newWtPath], {
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
	 * Background freshen: fetch origin + reset --hard <base> + explicit branch push.
	 * Resolves the base via `resolveBaseRef(repoPath, baseRefResolver())` so
	 * pool entries adopt the project's currently-configured `base_ref` at the
	 * moment they're freshened — no drain / no recorded-base needed.
	 * Errors are non-fatal and logged — the worktree is still usable.
	 */
	private freshenInBackground(worktreePath: string, branch: string): void {
		this.freshen(worktreePath, branch).catch(() => { /* swallow — already logged */ });
	}

	/**
	 * Internal async freshen. Exposed (package-private via `as any` access) for
	 * unit tests that need to await freshen completion before asserting HEAD.
	 * Not part of the public API.
	 */
	private async freshen(worktreePath: string, branch: string): Promise<void> {
		const diagEnabled = cpuDiagnosticsEnabled();
		const diagStart = diagEnabled ? performance.now() : 0;
		const counters = diagEnabled ? { calls: 1, fetchResetErrors: 0, pushSkipped: 0, pushErrors: 0, success: 0 } : undefined;
		try {
			try {
				await execGit(["fetch", "origin"], { cwd: worktreePath, timeout: 30_000 });
				const configured = this.baseRefResolver?.();
				const { ref: remotePrimary } = await resolveBaseRef(this.repoPath, configured);
				await execGit(["reset", "--hard", remotePrimary], { cwd: worktreePath, timeout: 10_000 });
			} catch (err) {
				if (counters) counters.fetchResetErrors = 1;
				console.warn(`[worktree-pool] Background reset failed for ${branch}:`, err instanceof Error ? err.message : err);
			}
			if (!shouldSkipRemotePush()) {
				try {
					await execGit(["push", "origin", `${branch}:refs/heads/${branch}`], { cwd: worktreePath, timeout: 30_000 });
					try {
						await fetchRemoteTrackingBranch(worktreePath, branch);
						await setBranchUpstreamToOrigin(worktreePath, branch);
					} catch (err) {
						console.warn(`[worktree-pool] Failed to set upstream for published ${branch}:`, err instanceof Error ? err.message : err);
					}
				} catch {
					if (counters) counters.pushErrors = 1;
					// Push failure is non-fatal (offline, auth issues, etc.)
				}
			} else if (counters) {
				counters.pushSkipped = 1;
			}
			if (counters) counters.success = counters.fetchResetErrors || counters.pushErrors ? 0 : 1;
		} finally {
			if (diagEnabled) {
				getCpuDiagnostics().recordTimer("worktree-pool:freshen", performance.now() - diagStart, counters);
			}
		}
	}

	/**
	 * Scan for orphaned pool worktrees from a previous server instance and reclaim them.
	 * An orphaned pool worktree is a directory under `<repo>-wt/` whose branch is still
	 * a pool branch (i.e. it was never claimed by a session/goal).
	 *
	 * Accepts both the new `pool/_pool-*` and legacy `session/_pool-*` prefixes.
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
			const wtRoot = path.resolve(this.repoPath, "..", `${path.basename(this.repoPath)}-wt`);
			if (!fs.existsSync(wtRoot)) { if (counters) counters.rootMissing = 1; return; }

			const entries = fs.readdirSync(wtRoot, { withFileTypes: true });
			for (const entry of entries) {
				if (counters) counters.entriesScanned++;
				if (this.pool.length >= this.targetSize) break;
				if (!entry.isDirectory()) continue;
				// Match new (`pool-_pool-*`) and legacy (`session-_pool-*`) flattened slugs.
				if (!entry.name.startsWith("pool-_pool-") && !entry.name.startsWith("session-_pool-")) continue;

				const wtPath = path.join(wtRoot, entry.name);
				if (activeWorktreePaths?.has(wtPath)) { if (counters) counters.activeSkipped++; continue; }

				const gitFile = path.join(wtPath, ".git");
				if (!fs.existsSync(gitFile)) { if (counters) counters.gitMissing++; continue; }

				try {
					const { stdout } = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], {
						cwd: wtPath,
						timeout: 5_000,
					});
					const branch = stdout.trim();
					if (!isPoolBranch(branch)) continue;

					this.pool.push({ branchName: branch, worktreePath: wtPath, createdAt: Date.now() });
					if (counters) counters.reclaimed++;
					console.log(`[worktree-pool] Reclaimed orphaned: ${branch} at ${wtPath} (pool: ${this.pool.length}/${this.targetSize})`);
				} catch {
					continue;
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
		this._fill().catch((err) => {
			console.error("[worktree-pool] Fill error:", err);
		}).finally(() => {
			this.filling = false;
		});
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
			while (this.pool.length < this.targetSize) {
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
						});
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
							skipPush: true,
							worktreeRoot: this.worktreeRoot,
							configuredBaseRef,
						});
						container = result.worktreePath;
						entry = {
							branchName: result.branchName,
							worktreePath: result.worktreePath,
							createdAt: Date.now(),
						};
					}

					// Per-component setup (npm ci, etc.) — runs BEFORE we publish the
					// entry into the pool so callers that claim immediately after fill
					// see node_modules/ already populated. Loud log so a future regression
					// of the source-of-truth migration cannot recur silently the way the
					// top-level `worktree_setup_command` read did.
					const setupNames = components.filter(c => c.worktreeSetupCommand).map(c => c.name);
					if (counters) counters.setupComponents += setupNames.length;
					if (setupNames.length > 0) {
						console.log(`[worktree-pool] running setup for components: ${setupNames.join(", ")}`);
						try {
							await runComponentSetups({
								components,
								branchContainer: container,
								primaryWorktreeRoot: this.repoPath,
								exec: async (cmd, cwd, env) => {
									await execShellCommand(cmd, { cwd, env, timeout: 120_000 });
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
					console.error(`[worktree-pool] Failed to pre-build ${branchName}:`, err);
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
		if (!isPoolBranch(branchName)) return;
		// Avoid duplicates
		if (this.pool.some(e => e.worktreePath === worktreePath)) return;
		this.pool.push({ branchName, worktreePath, createdAt: Date.now() });
		if (cpuDiagnosticsEnabled()) {
			getCpuDiagnostics().recordTimer("worktree-pool:registerExternalEntry", 0, { registered: 1, ready: this.pool.length, target: this.targetSize });
		}
	}

	/** Clean up all pool entries. Call on shutdown. */
	async drain(): Promise<void> {
		const diagEnabled = cpuDiagnosticsEnabled();
		const diagStart = diagEnabled ? performance.now() : 0;
		const entries = this.pool.splice(0);
		if (entries.length === 0) {
			if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-pool:drain", performance.now() - diagStart, { entries: 0, skippedEmpty: 1 });
			return;
		}
		await Promise.allSettled(
			entries.map(e => cleanupWorktree(this.repoPath, e.worktreePath, e.branchName, true)),
		);
		if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-pool:drain", performance.now() - diagStart, { entries: entries.length });
		console.log(`[worktree-pool] Drained ${entries.length} pre-built worktree(s)`);
	}
}
