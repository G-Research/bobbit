/**
 * Boot-time worktree sweeper.
 *
 * Reconciles on-disk Git worktrees against persisted goal/session/team/staff
 * records before the worktree pool fills. Discovery is diagnostic only:
 *
 *   - Pool-shaped worktrees are counted so they remain visible in boot logs.
 *   - Active session/goal/team/staff worktrees retain their existing guards.
 *   - Discovered worktrees without an exact durable identity are reported and
 *     preserved; branch or path shape never authorizes repair or cleanup.
 *
 * The sweeper runs once after the listener starts, before pool initialization.
 * It never mutates discovered Git worktrees or branches.
 */

import { performance } from "node:perf_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { cleanupWorktree, RemoteGitPolicy } from "../skills/git.js";
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
	repoPath?: string;
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

// Keep downstream comparisons purely lexical. The async sweep gathers canonical
// aliases once before classifying candidates; classifyWorktrees intentionally
// remains synchronous and side-effect free for its canned-output callers.
function normalize(value?: string): string | undefined {
	return value ? normalizeWorktreeHostPath(path.resolve(value)) : undefined;
}

type CanonicalPaths = ReadonlyMap<string, string>;

function canonicalPath(value: string | undefined, aliases: CanonicalPaths): string | undefined {
	const normalized = normalize(value);
	return normalized ? aliases.get(normalized) ?? normalized : undefined;
}

async function canonicalizePaths(
	values: Iterable<string | undefined>,
	realpath?: (value: string) => Promise<string>,
	aliases = new Map<string, string>(),
): Promise<Map<string, string>> {
	const normalizedPaths = [...new Set([...values].flatMap(value => {
		const normalized = normalize(value);
		return normalized && !aliases.has(normalized) ? [normalized] : [];
	}))];
	for (const value of normalizedPaths) aliases.set(value, value);
	// Test seams that model only the async access probe have no filesystem
	// identity to resolve. Their paths are intentionally compared lexically.
	if (!realpath) return aliases;
	await mapWithConcurrency(normalizedPaths, RECOVERY_IO_CONCURRENCY, async normalized => {
		try {
			aliases.set(normalized, normalizeWorktreeHostPath(await realpath(normalized)) ?? normalized);
		} catch { /* a removed/nonexistent record retains its lexical spelling */ }
	});
	return aliases;
}

function ownershipPaths(ownership: SweepOwnership): Array<string | undefined> {
	return [
		...ownership.goals,
		...ownership.sessions,
		...(ownership.teams ?? []),
		...ownership.staff,
	].flatMap(record => [record.repoPath, record.worktreePath, record.cwd, ...Object.values(record.repoWorktrees ?? {})]);
}

type SweepFs = Pick<RecoveryFs, "access"> & { realpath?: (value: string) => Promise<string> };
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
	archivedIdentities: Set<string>;
	teamContainerPaths: Set<string>;
	branchToExpectedPath: Map<string, string>;
	allRecords: SweepRecord[];
}

function worktreeIdentityKey(repoPath: string | undefined, worktreePath: string | undefined, branch: string | undefined, aliases: CanonicalPaths): string | undefined {
	const repo = canonicalPath(repoPath, aliases);
	const worktree = canonicalPath(worktreePath, aliases);
	return repo && worktree && branch ? `${repo}\0${worktree}\0${branch}` : undefined;
}

function buildOwnershipGuards(ownership: SweepOwnership, aliases: CanonicalPaths = new Map()): OwnershipGuards {
	const ownedBranches = new Set<string>();
	const ownedPaths = new Set<string>();
	const archivedIdentities = new Set<string>();
	const teamContainerPaths = new Set<string>();
	const branchToExpectedPath = new Map<string, string>();
	const teamRecords = (ownership.teams ?? []).map(rec => ({ ...rec, archived: false }));
	const teamIds = new Set(teamRecords.map(rec => rec.id));
	const archivedSessionRecords = new Set(ownership.sessions.filter(rec => rec.archived));
	const allRecords = [...ownership.goals, ...ownership.sessions, ...teamRecords, ...ownership.staff];
	const addPathAliases = (paths: Set<string>, value: string | undefined): string | undefined => {
		const lexical = normalize(value);
		if (lexical) paths.add(lexical);
		const canonical = canonicalPath(value, aliases);
		if (canonical) paths.add(canonical);
		return canonical ?? lexical;
	};
	for (const rec of allRecords) {
		if (rec.archived) {
			// Only archived sessions are retained for review. Archived goals and
			// other record types do not prove that a leftover is expected here.
			if (!archivedSessionRecords.has(rec)) continue;
			const repoWorktrees = Object.entries(rec.repoWorktrees ?? {});
			if (repoWorktrees.length > 0) {
				for (const [repo, worktreePath] of repoWorktrees) {
					const key = worktreeIdentityKey(
						rec.repoPath ? (repo === "." ? rec.repoPath : path.join(rec.repoPath, repo)) : undefined,
						worktreePath,
						rec.branch,
						aliases,
					);
					if (key) archivedIdentities.add(key);
				}
			} else {
				const key = worktreeIdentityKey(rec.repoPath, rec.worktreePath, rec.branch, aliases);
				if (key) archivedIdentities.add(key);
			}
			continue;
		}
		if (rec.branch) ownedBranches.add(rec.branch);
		const normalizedPath = addPathAliases(ownedPaths, rec.worktreePath);
		addPathAliases(ownedPaths, rec.cwd);
		if (rec.branch && rec.worktreePath) branchToExpectedPath.set(rec.branch, canonicalPath(rec.worktreePath, aliases) ?? rec.worktreePath);
		// Durable team-agent records store the branch container, not per-repo
		// worktrees. Protect component worktrees underneath that container.
		if (normalizedPath && !rec.repoWorktrees && teamIds.has(rec.id)) teamContainerPaths.add(normalizedPath);
		if (rec.repoWorktrees) {
			for (const worktreePath of Object.values(rec.repoWorktrees)) addPathAliases(ownedPaths, worktreePath);
		}
	}
	// The reference guard also protects children of a record's cwd. Include a
	// canonical spelling of every record so that containment survives /var ↔
	// /private/var aliases without adding I/O to its hot comparison path.
	const canonicalRecords = allRecords.map(record => ({
		...record,
		worktreePath: canonicalPath(record.worktreePath, aliases) ?? record.worktreePath,
		cwd: canonicalPath(record.cwd, aliases) ?? record.cwd,
		repoWorktrees: record.repoWorktrees && Object.fromEntries(
			Object.entries(record.repoWorktrees).map(([repo, worktreePath]) => [repo, canonicalPath(worktreePath, aliases) ?? worktreePath]),
		),
	}));
	return { ownedBranches, ownedPaths, archivedIdentities, teamContainerPaths, branchToExpectedPath, allRecords: [...allRecords, ...canonicalRecords] };
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
	/** Retained compatibility seam; boot discovery never invokes cleanup. */
	cleanupWorktreeImpl?: WorktreeCleanup;
	/** Retained compatibility seam; boot discovery never authorizes a mutation. */
	getCurrentOwnership?: () => SweepOwnership;
}): Promise<SweepResult> {
	const commandRunner = opts.commandRunner ?? realCommandRunner;
	const sweepFs: SweepFs = opts.fs ?? { ...realRecoveryFs, realpath: value => fs.realpath(value) };
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
		// Keep the initial snapshot for deterministic diagnostic classification.
		const initialOwnership: SweepOwnership = {
			goals: opts.goals,
			sessions: opts.sessions,
			teams: opts.teams,
			staff: opts.staff,
		};
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

		// Git reports canonical paths while durable records can retain lexical
		// TMPDIR spellings. Canonicalize every distinct path asynchronously once,
		// then retain both spellings in ownership guards for synchronous hot-path
		// comparisons below.
		const aliases = await canonicalizePaths([
			...ownershipPaths(initialOwnership),
			...repos.flatMap(repo => [repo.repoPath, repo.resolvedWorktreeRoot]),
			...scans.flatMap(worktrees => worktrees.flatMap(worktree => [worktree.path, worktree.repoPath, worktree.resolvedWorktreeRoot])),
		], sweepFs.realpath);
		const initialGuards = buildOwnershipGuards(initialOwnership, aliases);

		type SweepOutcome =
			| { kind: "none" }
			| { kind: "reclaimed" }
			| { kind: "needs-attention"; worktree: SweptWorktree; branch: string };

		// Classify different repos in parallel, but keep worktrees within one repo
		// sequential so diagnostic ordering stays deterministic and nested
		// concurrency does not multiply.
		const outcomesByRepo = await mapWithConcurrency(scans, RECOVERY_IO_CONCURRENCY, async (worktrees): Promise<SweepOutcome[]> => {
			const outcomes: SweepOutcome[] = [];
			for (const wt of worktrees) {
				const wtPathNorm = canonicalPath(wt.path, aliases);
				if (!wtPathNorm || wtPathNorm === canonicalPath(wt.repoPath, aliases)) {
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

				const ownership = ownershipForWorktree(wt.path, branch, initialGuards);
				// Exact path ownership (including shared cwd, delegate, team-container,
				// and multi-repo component guards) remains an ordinary protected row.
				if (ownership.ownedByPath) {
					outcomes.push({ kind: "none" });
					continue;
				}

				// Archived-session retention is expected, not an ownership warning. An
				// exact durable repo/path/branch triple proves where the worktree came
				// from without granting this diagnostic-only sweeper mutation authority.
				const archivedIdentity = worktreeIdentityKey(wt.repoPath, wt.path, branch, aliases);
				if (archivedIdentity && initialGuards.archivedIdentities.has(archivedIdentity)) {
					outcomes.push({ kind: "none" });
					continue;
				}

				if (!branch) {
					outcomes.push({ kind: "none" });
					continue;
				}

				// A branch-only durable match and an entirely unreferenced Git worktree
				// are both unverified discoveries. Preserve and report them; neither
				// branch naming nor worktree-root placement proves Bobbit ownership.
				outcomes.push({ kind: "needs-attention", worktree: wt, branch });
			}
			return outcomes;
		});

		let reclaimed = 0;
		for (const outcomes of outcomesByRepo) {
			for (const outcome of outcomes) {
				switch (outcome.kind) {
					case "reclaimed":
						reclaimed++;
						if (diagCounters) diagCounters.reclaimed++;
						break;
					case "needs-attention":
						console.log(`[sweeper] Preserved unverified worktree: ${outcome.worktree.path} (branch: ${outcome.branch}, repo: ${outcome.worktree.repoPath})`);
						break;
					case "none":
						break;
				}
			}
		}
		return { reclaimed, cleaned: 0, repaired: 0 };
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
