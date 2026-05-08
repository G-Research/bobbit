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
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { createWorktree, cleanupWorktree, shouldSkipRemotePush, createWorktreeSet, type WorktreeResult } from "../skills/git.js";
import { runComponentSetups } from "../skills/worktree-setup.js";
import { execShellCommand } from "./shell-util.js";
import type { Component } from "./project-config-store.js";

const execFile = promisify(execFileCb);

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
		const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
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
	await execFile("git", ["worktree", "move", oldPath, newPath], {
		cwd: repoPath,
		timeout: 30_000,
	});
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
	constructor(opts: { repoPath: string; targetSize?: number; componentsResolver?: () => Component[]; worktreeRoot?: string }) {
		this.repoPath = resolveRepoToplevel(opts.repoPath);
		this.targetSize = opts.targetSize ?? 2;
		this.componentsResolver = opts.componentsResolver;
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
	 *   2. `git worktree move <oldPath> <newPath>` — on failure the call
	 *      returns null (caller falls back to `createWorktree`). No persistent
	 *      "degraded" state is emitted: post-refactor (see
	 *      `docs/design/remove-session-worktree-rename.md`) we never persist a
	 *      session whose dir name doesn't match its branch.
	 *
	 * Steps performed in the background (caller does NOT await):
	 *   3. `git fetch origin` + `git reset --hard <remote-primary>`
	 *   4. `git push -u origin <targetBranch>` (skipped under BOBBIT_TEST_NO_PUSH=1)
	 *
	 * Returns null if the pool is empty, or if the directory rename fails
	 * (caller falls back to createWorktree).
	 */
	async claim(targetBranch: string): Promise<PoolClaimResult | null> {
		const entry = this.pool.shift();
		if (!entry) return null;

		// Kick off background replenishment immediately
		this.replenish();

		// Multi-repo path: parallel per-repo branch rename + worktree move. The
		// container directory itself is renamed first because per-repo worktrees
		// live inside it; `git worktree move` then updates each repo's admin
		// pointer to the new container path.
		if (entry.worktrees && entry.worktrees.length > 0) {
			return this._claimMultiRepo(entry, targetBranch);
		}

		// 1. Rename branch (fast — local ref op).
		try {
			await execFile("git", ["branch", "-m", entry.branchName, targetBranch], {
				cwd: entry.worktreePath,
				timeout: 10_000,
			});
		} catch (err) {
			console.error(`[worktree-pool] Branch rename failed (${entry.branchName} → ${targetBranch}):`, err);
			cleanupWorktree(this.repoPath, entry.worktreePath, entry.branchName, true).catch(() => {});
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
				console.warn(`[worktree-pool] claim aborted: move ${entry.worktreePath} → ${newPath} failed: ${err instanceof Error ? err.message : err}`);
				// Revert the branch rename so the worktree's branch matches its dir again,
				// then clean up so the caller can fall back to createWorktree without
				// stepping on a half-renamed entry.
				try {
					await execFile("git", ["branch", "-m", targetBranch, entry.branchName], {
						cwd: entry.worktreePath,
						timeout: 10_000,
					});
				} catch { /* best-effort */ }
				cleanupWorktree(this.repoPath, entry.worktreePath, entry.branchName, true).catch(() => {});
				return null;
			}
		}

		// 3 + 4. Background freshen + push. Don't await — caller gets the worktree now.
		this.freshenInBackground(finalPath, targetBranch);

		console.log(`[worktree-pool] Claimed worktree: ${targetBranch} at ${finalPath} (pool: ${this.pool.length}/${this.targetSize})`);
		const result: PoolClaimResult = { worktreePath: finalPath, branchName: targetBranch, degraded: false };
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

		// 2. Per-repo: rename the branch and repair worktree pointers in parallel.
		const perRepo = await Promise.all(worktrees.map(async (w) => {
			const oldWtPath = w.worktreePath;
			const newWtPath = finalContainer === entry.worktreePath
				? oldWtPath
				: path.join(finalContainer, path.relative(entry.worktreePath, oldWtPath));
			let renamed = false;
			try {
				await execFile("git", ["branch", "-m", entry.branchName, targetBranch], {
					cwd: newWtPath,
					timeout: 10_000,
				});
				renamed = true;
			} catch (err) {
				console.warn(`[worktree-pool] multi-repo: git branch -m failed for ${w.repo}: ${err instanceof Error ? err.message : err}`);
			}
			// Repair admin entry so `git worktree list` / future ops see the new path.
			if (finalContainer !== entry.worktreePath) {
				try {
					await execFile("git", ["worktree", "repair", newWtPath], {
						cwd: w.repoPath,
						timeout: 15_000,
					});
				} catch (err) {
					console.warn(`[worktree-pool] multi-repo: git worktree repair failed for ${w.repo}: ${err instanceof Error ? err.message : err}`);
				}
			}
			return { repo: w.repo, worktreePath: newWtPath, renamed };
		}));

		// Background freshen for each repo (independent).
		for (const r of perRepo) {
			this.freshenInBackground(r.worktreePath, targetBranch);
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

	/** Resolve the remote primary branch (e.g. origin/master). */
	private async resolveRemotePrimary(): Promise<string> {
		try {
			const { stdout } = await execFile("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
				cwd: this.repoPath,
				timeout: 5_000,
			});
			const ref = stdout.trim().replace("refs/remotes/", "");
			if (ref) return ref;
		} catch {
			// Fall back if origin/HEAD is not set
		}
		return "origin/master";
	}

	/**
	 * Background freshen: fetch origin + reset --hard <primary> + push -u.
	 * Errors are non-fatal and logged — the worktree is still usable.
	 */
	private freshenInBackground(worktreePath: string, branch: string): void {
		(async () => {
			try {
				await execFile("git", ["fetch", "origin"], { cwd: worktreePath, timeout: 30_000 });
				const remotePrimary = await this.resolveRemotePrimary();
				await execFile("git", ["reset", "--hard", remotePrimary], { cwd: worktreePath, timeout: 10_000 });
			} catch (err) {
				console.warn(`[worktree-pool] Background reset failed for ${branch}:`, err instanceof Error ? err.message : err);
			}
			if (!shouldSkipRemotePush()) {
				try {
					await execFile("git", ["push", "-u", "origin", branch], { cwd: worktreePath, timeout: 30_000 });
				} catch {
					// Push failure is non-fatal (offline, auth issues, etc.)
				}
			}
		})().catch(() => { /* swallow — already logged */ });
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
		try {
			const wtRoot = path.resolve(this.repoPath, "..", `${path.basename(this.repoPath)}-wt`);
			if (!fs.existsSync(wtRoot)) return;

			const entries = fs.readdirSync(wtRoot, { withFileTypes: true });
			for (const entry of entries) {
				if (this.pool.length >= this.targetSize) break;
				if (!entry.isDirectory()) continue;
				// Match new (`pool-_pool-*`) and legacy (`session-_pool-*`) flattened slugs.
				if (!entry.name.startsWith("pool-_pool-") && !entry.name.startsWith("session-_pool-")) continue;

				const wtPath = path.join(wtRoot, entry.name);
				if (activeWorktreePaths?.has(wtPath)) continue;

				const gitFile = path.join(wtPath, ".git");
				if (!fs.existsSync(gitFile)) continue;

				try {
					const { stdout } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
						cwd: wtPath,
						timeout: 5_000,
					});
					const branch = stdout.trim();
					if (!isPoolBranch(branch)) continue;

					this.pool.push({ branchName: branch, worktreePath: wtPath, createdAt: Date.now() });
					console.log(`[worktree-pool] Reclaimed orphaned: ${branch} at ${wtPath} (pool: ${this.pool.length}/${this.targetSize})`);
				} catch {
					continue;
				}
			}
		} catch (err) {
			console.warn("[worktree-pool] Orphan reclaim scan failed:", err);
		}
	}

	/** Fill pool up to targetSize in the background. */
	private replenish(): void {
		if (this.filling || this.pool.length >= this.targetSize) return;
		this.filling = true;
		this._fill().catch((err) => {
			console.error("[worktree-pool] Fill error:", err);
		}).finally(() => {
			this.filling = false;
		});
	}

	private async _fill(): Promise<void> {
		while (this.pool.length < this.targetSize) {
			// Resolve components fresh on every fill so live project-config edits
			// (e.g. user toggles `worktreeSetupCommand` in Settings) take effect on
			// the very next pool entry without a server restart.
			const components = this.componentsResolver?.() ?? [];
			const multi = this.isMultiRepo(components);
			const uuid8 = randomUUID().slice(0, 8);
			const branchName = `${POOL_BRANCH_PREFIX}${uuid8}`;
			try {
				let container: string;
				let entry: PoolEntry;
				if (multi) {
					// Multi-repo prebuild via createWorktreeSet — entry carries per-repo paths.
					const set = await createWorktreeSet(this.repoPath, components, branchName, undefined, { worktreeRoot: this.worktreeRoot });
					container = set.container;
					entry = {
						branchName,
						worktreePath: set.container,
						worktrees: set.worktrees,
						createdAt: Date.now(),
					};
				} else {
					// Single-repo prebuild. NOTE: we no longer pass setupCommand to
					// createWorktree — the canonical path is runComponentSetups()
					// below so single-repo and multi-repo share one code path and
					// `components[*].worktreeSetupCommand` is the only source of truth.
					const result = await createWorktree(this.repoPath, branchName, {
						skipPush: true,
						worktreeRoot: this.worktreeRoot,
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
				console.log(`[worktree-pool] Ready${multi ? " (multi-repo)" : ""}: ${branchName} (pool: ${this.pool.length}/${this.targetSize})`);
			} catch (err) {
				console.error(`[worktree-pool] Failed to pre-build ${branchName}:`, err);
				break;
			}
		}
	}

	/** Push a pre-existing pool entry into the in-memory pool. Used by the boot sweeper. */
	registerExternalEntry(branchName: string, worktreePath: string): void {
		if (!isPoolBranch(branchName)) return;
		// Avoid duplicates
		if (this.pool.some(e => e.worktreePath === worktreePath)) return;
		this.pool.push({ branchName, worktreePath, createdAt: Date.now() });
	}

	/** Clean up all pool entries. Call on shutdown. */
	async drain(): Promise<void> {
		const entries = this.pool.splice(0);
		if (entries.length === 0) return;
		await Promise.allSettled(
			entries.map(e => cleanupWorktree(this.repoPath, e.worktreePath, e.branchName, true)),
		);
		console.log(`[worktree-pool] Drained ${entries.length} pre-built worktree(s)`);
	}
}
