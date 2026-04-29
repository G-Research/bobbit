/**
 * Boot-time worktree sweeper.
 *
 * Reconciles on-disk git worktrees against persisted goal/session/staff
 * records before the worktree pool fills. This catches:
 *
 *   - Pool worktrees that were left behind after a crash and aren't yet
 *     in the in-memory pool (logged for the pool to reclaim itself —
 *     `WorktreePool.reclaimOrphaned` already handles directory-based
 *     reclaim). The sweeper just counts these so they're visible in logs.
 *   - Active session/goal/staff branches with intact worktrees → keep.
 *   - Worktrees on a branch that no live record claims → cleanup.
 *   - A live record whose worktree path differs from git's tracking
 *     (rename-mid-shutdown) → repair via `git worktree repair`.
 *
 * The sweeper runs once at startup, before pool fill, so renamed-but-
 * orphaned worktrees from a crashed prior instance are reclaimed
 * cleanly. See docs/design/multi-repo-components.md §5.5.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { isPoolBranch } from "./worktree-pool.js";
import { cleanupWorktree } from "../skills/git.js";

const execFile = promisify(execFileCb);

export interface SweepProject {
	id: string;
	rootPath: string;
	/** Multi-repo: distinct repo subfolder names. Single-repo omits or supplies ["."]. */
	repos?: string[];
}

export interface SweepRecord {
	id: string;
	branch?: string;
	worktreePath?: string;
	archived?: boolean;
	/** Per-repo worktree paths (multi-repo). Each is treated as separately owned. */
	repoWorktrees?: Record<string, string>;
}

export interface SweepResult {
	reclaimed: number;
	cleaned: number;
	repaired: number;
}

interface ParsedWorktree {
	path: string;
	branch?: string;
}

/** Parse `git worktree list --porcelain` output. */
function parseWorktreeList(stdout: string): ParsedWorktree[] {
	const blocks = stdout.split(/\r?\n\r?\n/);
	const out: ParsedWorktree[] = [];
	for (const block of blocks) {
		if (!block.trim()) continue;
		const pathMatch = block.match(/^worktree (.+)$/m);
		if (!pathMatch) continue;
		const branchMatch = block.match(/^branch refs\/heads\/(.+)$/m);
		out.push({
			path: pathMatch[1].trim(),
			branch: branchMatch ? branchMatch[1].trim() : undefined,
		});
	}
	return out;
}

const normalize = (p: string | undefined): string | undefined =>
	p ? p.replace(/\\/g, "/").toLowerCase() : undefined;

/**
 * Sweep orphaned worktrees across all projects.
 *
 * Idempotent and safe to run on every boot. Returns counts for logging;
 * never throws.
 */
export async function sweepOrphanedWorktrees(opts: {
	projects: SweepProject[];
	goals: SweepRecord[];
	sessions: SweepRecord[];
	staff: SweepRecord[];
}): Promise<SweepResult> {
	let reclaimed = 0;
	let cleaned = 0;
	let repaired = 0;

	// Build the set of branches/paths owned by live (non-archived) records.
	const ownedBranches = new Set<string>();
	const ownedPaths = new Set<string>();
	const branchToExpectedPath = new Map<string, string>();
	for (const rec of [...opts.goals, ...opts.sessions, ...opts.staff]) {
		if (rec.archived) continue;
		if (rec.branch) ownedBranches.add(rec.branch);
		const np = normalize(rec.worktreePath);
		if (np) ownedPaths.add(np);
		if (rec.branch && rec.worktreePath) branchToExpectedPath.set(rec.branch, rec.worktreePath);
		// Multi-repo: each per-repo worktree is separately owned. The branch is
		// shared across repos so we only add to ownedPaths.
		if (rec.repoWorktrees) {
			for (const wp of Object.values(rec.repoWorktrees)) {
				const n = normalize(wp);
				if (n) ownedPaths.add(n);
			}
		}
	}

	for (const project of opts.projects) {
		if (!project.rootPath || !fs.existsSync(project.rootPath)) continue;

		// Multi-repo: enumerate per-repo worktrees so each repo's git metadata
		// is reconciled against the goal/session/staff record map. Single-repo
		// projects have one entry with `repoPath === project.rootPath`.
		const repoList = (project.repos && project.repos.length > 0)
			? project.repos.map(r => r === "." ? project.rootPath : path.join(project.rootPath, r))
			: [project.rootPath];

		const worktrees: Array<ParsedWorktree & { repoPath: string }> = [];
		for (const repoPath of repoList) {
			if (!fs.existsSync(repoPath)) continue;
			// Only sweep if THIS directory is itself a git repo (has its own .git).
			// Without this check, `git worktree list` walks upward to find a parent
			// repo and returns the parent's worktrees — which the sweeper would
			// then try to clean. Catastrophic if rootPath is, say, a test fixture
			// nested inside a real bobbit checkout.
			if (!fs.existsSync(path.join(repoPath, ".git"))) continue;
			try {
				const { stdout } = await execFile("git", ["worktree", "list", "--porcelain"], {
					cwd: repoPath,
					timeout: 10_000,
				});
				for (const wt of parseWorktreeList(stdout)) {
					worktrees.push({ ...wt, repoPath });
				}
			} catch {
				// Not a git repo, or git unavailable — skip this repo.
			}
		}

		for (const wt of worktrees) {
			const wtPathNorm = normalize(wt.path);
			if (!wtPathNorm) continue;

			// Skip the primary worktree(s) of any configured repo.
			if (wtPathNorm === normalize(wt.repoPath)) continue;

			const branch = wt.branch;

			// Pool branch — leave for `WorktreePool.reclaimOrphaned` to absorb.
			// We just count it as "reclaimed" so logs reflect what's happening.
			if (branch && isPoolBranch(branch)) {
				reclaimed++;
				continue;
			}

			// Active record owns this worktree (by branch or path).
			const ownedByBranch = !!(branch && ownedBranches.has(branch));
			const ownedByPath = ownedPaths.has(wtPathNorm);

			if (ownedByBranch || ownedByPath) {
				// Multi-repo: a per-repo path explicitly listed in any record's
				// `repoWorktrees` is active in this repo — do NOT treat path drift
				// against the record's flat container path as a repair signal.
				if (ownedByPath) {
					continue;
				}
				// Path drift — record says worktree is at X, git says it's at Y.
				// Try `git worktree repair` to bring them back into sync.
				if (ownedByBranch && branch) {
					const expected = branchToExpectedPath.get(branch);
					if (expected && normalize(expected) !== wtPathNorm) {
						try {
							await execFile("git", ["worktree", "repair", wt.path], {
								cwd: wt.repoPath,
								timeout: 15_000,
							});
							repaired++;
						} catch {
							// Repair failed — leave as-is; the running session will
							// surface its own error if it tries to use a stale path.
						}
					}
				}
				continue;
			}

			// No owner — branch is from a pre-rename crash or stale pool entry.
			// Skip session/goal/* prefixed branches whose owner record may have
			// been deleted; cleanup is harmless because the branch is unowned.
			if (!branch) continue; // detached worktree; leave alone.

			try {
				await cleanupWorktree(wt.repoPath, wt.path, branch, true);
				cleaned++;
				console.log(`[sweeper] Cleaned orphan worktree: ${wt.path} (branch: ${branch}, repo: ${wt.repoPath})`);
			} catch (err) {
				console.warn(`[sweeper] Failed to clean orphan worktree ${wt.path}:`, err);
			}
		}
	}

	return { reclaimed, cleaned, repaired };
}

/** Helper for tests that want to run the sweeper against a single project's stdout. */
export function classifyWorktrees(opts: {
	porcelainStdout: string;
	repoPath: string;
	goals: SweepRecord[];
	sessions: SweepRecord[];
	staff: SweepRecord[];
}): {
	pool: ParsedWorktree[];
	active: ParsedWorktree[];
	orphan: ParsedWorktree[];
	repair: ParsedWorktree[];
} {
	const all = parseWorktreeList(opts.porcelainStdout);
	const ownedBranches = new Set<string>();
	const ownedPaths = new Set<string>();
	const branchToExpectedPath = new Map<string, string>();
	for (const rec of [...opts.goals, ...opts.sessions, ...opts.staff]) {
		if (rec.archived) continue;
		if (rec.branch) ownedBranches.add(rec.branch);
		const np = normalize(rec.worktreePath);
		if (np) ownedPaths.add(np);
		if (rec.branch && rec.worktreePath) branchToExpectedPath.set(rec.branch, rec.worktreePath);
		if (rec.repoWorktrees) {
			for (const wp of Object.values(rec.repoWorktrees)) {
				const n = normalize(wp);
				if (n) ownedPaths.add(n);
			}
		}
	}
	const pool: ParsedWorktree[] = [];
	const active: ParsedWorktree[] = [];
	const orphan: ParsedWorktree[] = [];
	const repair: ParsedWorktree[] = [];
	for (const wt of all) {
		const wtPathNorm = normalize(wt.path);
		if (wtPathNorm === normalize(opts.repoPath)) continue;
		if (wt.branch && isPoolBranch(wt.branch)) {
			pool.push(wt);
			continue;
		}
		const ownedByBranch = !!(wt.branch && ownedBranches.has(wt.branch));
		const ownedByPath = !!wtPathNorm && ownedPaths.has(wtPathNorm);
		if (ownedByBranch || ownedByPath) {
			// Multi-repo: a per-repo path explicitly listed in any record's
			// `repoWorktrees` map is active even if it differs from the record's
			// flat `worktreePath` (which holds the container in multi-repo mode).
			if (ownedByPath) {
				active.push(wt);
				continue;
			}
			if (ownedByBranch && wt.branch) {
				const expected = branchToExpectedPath.get(wt.branch);
				if (expected && normalize(expected) !== wtPathNorm) {
					repair.push(wt);
					continue;
				}
			}
			active.push(wt);
			continue;
		}
		if (wt.branch) orphan.push(wt);
	}
	// path is unused here but we keep the helper synchronous and side-effect free.
	void path;
	return { pool, active, orphan, repair };
}
