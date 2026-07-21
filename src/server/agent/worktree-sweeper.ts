/**
 * Boot-time worktree sweeper.
 *
 * Reconciles on-disk git worktrees against persisted goal/session/team/staff
 * records before the worktree pool fills. This catches:
 *
 *   - Pool worktrees that were left behind after a crash and aren't yet
 *     in the in-memory pool (logged for the pool to reclaim itself —
 *     `WorktreePool.reclaimOrphaned` already handles directory-based
 *     reclaim). The sweeper just counts these so they're visible in logs.
 *   - Active session/goal/team/staff branches with intact worktrees → keep.
 *   - Worktrees on a branch that no live record claims → cleanup.
 *   - A live record whose worktree path differs from git's tracking
 *     (rename-mid-shutdown) → repair via `git worktree repair`.
 *
 * The sweeper runs once after the listener starts and may overlap pool fill:
 * pool branches are counted but never mutated here, so the branch sets remain
 * disjoint. See docs/design/multi-repo-components.md §5.5 (historical) and
 * docs/design/remove-session-worktree-rename.md §13 (current post-upgrade
 * sweeper patterns: live `session-<id8>`, pool `pool-_pool-<id>`, legacy
 * `session-<slug>-<id8>` / `session-new-session-<id8>` orphan handling).
 */

import { performance } from "node:perf_hooks";
import path from "node:path";
import { cleanupWorktree, type RemoteGitPolicy } from "../skills/git.js";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "./cpu-diagnostics.js";
import { mapWithConcurrency, RECOVERY_IO_CONCURRENCY, realRecoveryFs, type RecoveryFs } from "./bounded-async-work.js";
import { isWorktreePathReferencedByLiveSession, normalizeWorktreeHostPath } from "./worktree-reference-guard.js";
import { classifyPoolReclaimCandidate, isBobbitPoolBranch, isContainerInternalWorktreePath, parseGitWorktreeList } from "./worktree-inventory.js";
import { worktreeRoot as resolveWorktreeRoot } from "../skills/worktree-paths.js";
import { realCommandRunner, type CommandRunner } from "../gateway-deps.js";

function childErrorCode(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" || typeof code === "number" ? String(code) : "error";
}

function gitChildLabel(args: readonly string[]): string {
	const [cmd, sub] = args;
	if (cmd === "worktree" && sub) return `git worktree ${sub}`;
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

export interface SweepProject {
	id: string;
	rootPath: string;
	/** Multi-repo: distinct repo subfolder names. Single-repo omits or supplies ["."]. */
	repos?: string[];
	/** Project-level worktree_root override, resolved with the shared helper. */
	worktreeRoot?: string;
}

export interface SweepRecord {
	id: string;
	branch?: string;
	worktreePath?: string;
	cwd?: string;
	archived?: boolean;
	/** Per-repo worktree paths (multi-repo). Each is treated as separately owned. */
	repoWorktrees?: Record<string, string>;
}

export interface SweepOwnership {
	goals: readonly SweepRecord[];
	sessions: readonly SweepRecord[];
	teams?: readonly SweepRecord[];
	staff: readonly SweepRecord[];
}

export interface SweepResult {
	reclaimed: number;
	cleaned: number;
	repaired: number;
}

type ParsedWorktree = ReturnType<typeof parseGitWorktreeList>[number];

const normalize = normalizeWorktreeHostPath;

type SweepFs = Pick<RecoveryFs, "access">;
type WorktreeCleanup = typeof cleanupWorktree;

interface SweepRepo {
	repoPath: string;
	resolvedWorktreeRoot: string;
}

interface SweptWorktree extends ParsedWorktree {
	repoPath: string;
	resolvedWorktreeRoot: string;
}

interface OwnershipGuards {
	ownedBranches: Set<string>;
	ownedPaths: Set<string>;
	archivedBranches: Set<string>;
	teamContainerPaths: Set<string>;
	branchToExpectedPath: Map<string, string>;
	allRecords: SweepRecord[];
}

function buildOwnershipGuards(ownership: SweepOwnership): OwnershipGuards {
	const ownedBranches = new Set<string>();
	const ownedPaths = new Set<string>();
	const archivedBranches = new Set<string>();
	const teamContainerPaths = new Set<string>();
	const branchToExpectedPath = new Map<string, string>();
	const teamRecords = (ownership.teams ?? []).map(rec => ({ ...rec, archived: false }));
	const teamIds = new Set(teamRecords.map(rec => rec.id));
	const allRecords = [...ownership.goals, ...ownership.sessions, ...teamRecords, ...ownership.staff];
	for (const rec of allRecords) {
		if (rec.archived) {
			if (rec.branch) archivedBranches.add(rec.branch);
			continue;
		}
		if (rec.branch) ownedBranches.add(rec.branch);
		const normalizedPath = normalize(rec.worktreePath);
		if (normalizedPath) ownedPaths.add(normalizedPath);
		const cwd = normalize(rec.cwd);
		if (cwd) ownedPaths.add(cwd);
		if (rec.branch && rec.worktreePath) branchToExpectedPath.set(rec.branch, rec.worktreePath);
		// Durable team-agent records store the branch container, not per-repo
		// worktrees. Protect component worktrees underneath that container.
		if (normalizedPath && !rec.repoWorktrees && teamIds.has(rec.id)) teamContainerPaths.add(normalizedPath);
		if (rec.repoWorktrees) {
			for (const worktreePath of Object.values(rec.repoWorktrees)) {
				const normalizedWorktreePath = normalize(worktreePath);
				if (normalizedWorktreePath) ownedPaths.add(normalizedWorktreePath);
			}
		}
	}
	return { ownedBranches, ownedPaths, archivedBranches, teamContainerPaths, branchToExpectedPath, allRecords };
}

function ownershipForWorktree(
	worktreePath: string,
	branch: string | undefined,
	guards: OwnershipGuards,
): { ownedByBranch: boolean; ownedByPath: boolean; expectedPath?: string } {
	const normalizedPath = normalize(worktreePath);
	const ownedByBranch = !!(branch && guards.ownedBranches.has(branch));
	let ownedByPath = !!normalizedPath && (
		guards.ownedPaths.has(normalizedPath)
		|| isWorktreePathReferencedByLiveSession(worktreePath, guards.allRecords)
	);
	if (!ownedByPath && normalizedPath) {
		for (const container of guards.teamContainerPaths) {
			if (normalizedPath.startsWith(`${container}/`)) {
				ownedByPath = true;
				break;
			}
		}
	}
	return {
		ownedByBranch,
		ownedByPath,
		expectedPath: branch ? guards.branchToExpectedPath.get(branch) : undefined,
	};
}

/**
 * Git normally searches parent directories when cwd has no `.git` marker. Keep
 * every sweeper command fenced to the configured repo even if the marker is
 * removed between the asynchronous policy check and process start.
 */
function gitOptions(repoPath: string, timeout: number): Record<string, unknown> {
	return {
		cwd: repoPath,
		timeout,
		env: {
			...process.env,
			GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(repoPath)),
		},
	};
}

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
	teams?: SweepRecord[];
	staff: SweepRecord[];
	commandRunner?: CommandRunner;
	remotePolicy?: RemoteGitPolicy;
	fs?: SweepFs;
	/** Focused test seam; production always uses the shared cleanup helper. */
	cleanupWorktreeImpl?: WorktreeCleanup;
	/**
	 * Return a fresh view of every durable owner. Called synchronously in the
	 * uninterrupted turn immediately before each repair or cleanup mutation.
	 */
	getCurrentOwnership?: () => SweepOwnership;
}): Promise<SweepResult> {
	const commandRunner = opts.commandRunner ?? realCommandRunner;
	const sweepFs = opts.fs ?? realRecoveryFs;
	const cleanup = opts.cleanupWorktreeImpl ?? cleanupWorktree;
	const diagEnabled = cpuDiagnosticsEnabled();
	const diagStart = diagEnabled ? performance.now() : 0;
	const diagCounters = diagEnabled ? {
		projects: opts.projects.length,
		reposScanned: 0,
		worktreesSeen: 0,
		reclaimed: 0,
		cleaned: 0,
		repaired: 0,
		errors: 0,
	} : undefined;

	try {
		// Keep the initial snapshot for deterministic candidate classification and
		// counts. Mutable ownership is rebuilt again at each mutation boundary.
		const initialOwnership: SweepOwnership = {
			goals: opts.goals,
			sessions: opts.sessions,
			teams: opts.teams,
			staff: opts.staff,
		};
		const initialGuards = buildOwnershipGuards(initialOwnership);
		const currentOwnershipGuards = (): OwnershipGuards => buildOwnershipGuards(
			opts.getCurrentOwnership ? opts.getCurrentOwnership() : initialOwnership,
		);

		// Resolve paths without walking upward. The caller supplies the actual Git
		// root for subdirectory projects; every configured repo must have its own
		// `.git` marker before Git is allowed to inspect it.
		const repos: SweepRepo[] = [];
		for (const project of opts.projects) {
			if (!project.rootPath) continue;
			const singleRepoRoot = path.resolve(project.rootPath);
			const isMultiRepo = !!project.repos?.some(repo => repo !== ".");
			const resolvedWorktreeRoot = resolveWorktreeRoot({
				rootPath: isMultiRepo ? project.rootPath : singleRepoRoot,
				worktreeRoot: project.worktreeRoot,
			});
			const repoPaths = project.repos?.length
				? project.repos.map(repo => repo === "." ? singleRepoRoot : path.join(project.rootPath, repo))
				: [singleRepoRoot];
			for (const repoPath of repoPaths) repos.push({ repoPath, resolvedWorktreeRoot });
		}

		// Scan repos concurrently under one shared ceiling. Result slots preserve
		// configured project/repo order even when the underlying I/O resolves out
		// of order. The Git ceiling also closes the `.git` check/start race.
		const scans = await mapWithConcurrency(repos, RECOVERY_IO_CONCURRENCY, async (repo): Promise<SweptWorktree[]> => {
			if (diagCounters) diagCounters.reposScanned++;
			try {
				await sweepFs.access(path.join(repo.repoPath, ".git"));
			} catch {
				return [];
			}
			try {
				const { stdout } = await execGit(
					["worktree", "list", "--porcelain"],
					gitOptions(repo.repoPath, 10_000),
					commandRunner,
				);
				const worktrees = parseGitWorktreeList(stdout).map(wt => ({ ...wt, ...repo }));
				if (diagCounters) diagCounters.worktreesSeen += worktrees.length;
				return worktrees;
			} catch {
				// Not a git repo, or git unavailable — skip this repo.
				return [];
			}
		});

		type SweepOutcome =
			| { kind: "none" }
			| { kind: "reclaimed" }
			| { kind: "repaired" }
			| { kind: "cleaned"; worktree: SweptWorktree; branch: string }
			| { kind: "cleanup-error"; worktree: SweptWorktree; error: unknown };

		// Reconcile different repos in parallel, but keep worktrees within one repo
		// sequential. This avoids concurrent Git metadata mutations in the same repo
		// and prevents nested concurrency multiplication.
		const outcomesByRepo = await mapWithConcurrency(scans, RECOVERY_IO_CONCURRENCY, async (worktrees): Promise<SweepOutcome[]> => {
			const outcomes: SweepOutcome[] = [];
			for (const wt of worktrees) {
				const wtPathNorm = normalize(wt.path);
				if (!wtPathNorm || wtPathNorm === normalize(wt.repoPath)) {
					outcomes.push({ kind: "none" });
					continue;
				}

				const branch = wt.branch;
				if (isContainerInternalWorktreePath(wt.path)) {
					outcomes.push({ kind: "none" });
					continue;
				}

				// Pool branches belong exclusively to WorktreePool.reclaimOrphaned.
				if (branch && isBobbitPoolBranch(branch)) {
					const verdict = classifyPoolReclaimCandidate({
						resolvedWorktreeRoot: wt.resolvedWorktreeRoot,
						candidatePath: wt.path,
						branch,
						gitMetadataExists: true,
					});
					outcomes.push(verdict.eligible || verdict.reason === "filesystem-only-needs-attention"
						? { kind: "reclaimed" }
						: { kind: "none" });
					continue;
				}

				const initialOwnershipState = ownershipForWorktree(wt.path, branch, initialGuards);
				if (initialOwnershipState.ownedByBranch || initialOwnershipState.ownedByPath) {
					// Explicit path ownership wins over flat-container drift detection for
					// multi-repo worktrees and shared/live-session references.
					if (initialOwnershipState.ownedByPath) {
						outcomes.push({ kind: "none" });
						continue;
					}
					if (initialOwnershipState.ownedByBranch && branch) {
						const expected = initialOwnershipState.expectedPath;
						if (expected && normalize(expected) !== wtPathNorm) {
							try {
								// A new path/repo/team owner, archive, or changed branch owner
								// can appear while the async repo scan is pending. Rebuild every
								// guard in the same turn that starts the repair mutation.
								const currentGuards = currentOwnershipGuards();
								const current = ownershipForWorktree(wt.path, branch, currentGuards);
								if (current.ownedByPath || !current.ownedByBranch || !current.expectedPath || normalize(current.expectedPath) === wtPathNorm) {
									outcomes.push({ kind: "none" });
									continue;
								}
								await execGit(
									["worktree", "repair", wt.path],
									gitOptions(wt.repoPath, 15_000),
									commandRunner,
								);
								outcomes.push({ kind: "repaired" });
							} catch {
								// A live owner keeps the worktree even when revalidation or repair fails.
								outcomes.push({ kind: "none" });
							}
							continue;
						}
					}
					outcomes.push({ kind: "none" });
					continue;
				}

				if (!branch) {
					outcomes.push({ kind: "none" });
					continue;
				}

				try {
					// The scan intentionally starts from a stable snapshot, but cleanup
					// authorization must be live: session creation remains available while
					// this post-listen sweep yields on filesystem and Git work.
					const currentGuards = currentOwnershipGuards();
					const current = ownershipForWorktree(wt.path, branch, currentGuards);
					if (current.ownedByBranch || current.ownedByPath) {
						outcomes.push({ kind: "none" });
						continue;
					}
					await cleanup(
						wt.repoPath,
						wt.path,
						branch,
						!initialGuards.archivedBranches.has(branch) && !currentGuards.archivedBranches.has(branch),
						commandRunner,
						opts.remotePolicy,
					);
					outcomes.push({ kind: "cleaned", worktree: wt, branch });
				} catch (error) {
					outcomes.push({ kind: "cleanup-error", worktree: wt, error });
				}
			}
			return outcomes;
		});

		let reclaimed = 0;
		let cleaned = 0;
		let repaired = 0;
		for (const outcomes of outcomesByRepo) {
			for (const outcome of outcomes) {
				switch (outcome.kind) {
					case "reclaimed":
						reclaimed++;
						if (diagCounters) diagCounters.reclaimed++;
						break;
					case "repaired":
						repaired++;
						if (diagCounters) diagCounters.repaired++;
						break;
					case "cleaned":
						cleaned++;
						if (diagCounters) diagCounters.cleaned++;
						console.log(`[sweeper] Cleaned orphan worktree: ${outcome.worktree.path} (branch: ${outcome.branch}, repo: ${outcome.worktree.repoPath})`);
						break;
					case "cleanup-error":
						if (diagCounters) diagCounters.errors++;
						console.warn(`[sweeper] Failed to clean orphan worktree ${outcome.worktree.path}:`, outcome.error);
						break;
					case "none":
						break;
				}
			}
		}
		return { reclaimed, cleaned, repaired };
	} finally {
		if (diagEnabled) getCpuDiagnostics().recordTimer("worktree-sweeper:sweep", performance.now() - diagStart, diagCounters);
	}
}

/** Helper for tests that want to run the sweeper against a single project's stdout. */
export function classifyWorktrees(opts: {
	porcelainStdout: string;
	repoPath: string;
	goals: SweepRecord[];
	sessions: SweepRecord[];
	teams?: SweepRecord[];
	staff: SweepRecord[];
}): {
	pool: ParsedWorktree[];
	active: ParsedWorktree[];
	orphan: ParsedWorktree[];
	repair: ParsedWorktree[];
} {
	const all = parseGitWorktreeList(opts.porcelainStdout);
	const guards = buildOwnershipGuards(opts);
	const pool: ParsedWorktree[] = [];
	const active: ParsedWorktree[] = [];
	const orphan: ParsedWorktree[] = [];
	const repair: ParsedWorktree[] = [];
	for (const wt of all) {
		const wtPathNorm = normalize(wt.path);
		if (wtPathNorm === normalize(opts.repoPath)) continue;
		if (isContainerInternalWorktreePath(wt.path)) continue;
		if (wt.branch && isBobbitPoolBranch(wt.branch)) {
			pool.push(wt);
			continue;
		}
		const ownership = ownershipForWorktree(wt.path, wt.branch, guards);
		if (ownership.ownedByBranch || ownership.ownedByPath) {
			// Multi-repo: a per-repo path explicitly listed in any record's
			// `repoWorktrees` map is active even if it differs from the record's
			// flat `worktreePath` (which holds the container in multi-repo mode).
			if (ownership.ownedByPath) {
				active.push(wt);
				continue;
			}
			if (ownership.ownedByBranch && wt.branch) {
				const expected = ownership.expectedPath;
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
