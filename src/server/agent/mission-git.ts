/**
 * Mission-specific git operations.
 *
 * Owned by Coder C (Mission orchestration — Workflow + Scheduler + Git).
 * See `docs/design/mission-orchestration.md` §3.4, §12.
 *
 * - createIntegrationBranch: branch `mission/<slug>-<id8>` off
 *   `origin/<master>` and add a managed Bobbit worktree under `<repo>-wt/`.
 *   Reuses `createWorktree` from skills/git.ts so the worktree inherits
 *   `worktree_setup_command` and the standard 7-day purge path.
 *
 * - childStartPoint: returns the integration branch HEAD SHA at the moment
 *   the caller wants to spawn a child. Pinning to a SHA (not the branch
 *   name) prevents a race when two parallel children spawn off the
 *   integration branch and the branch advances between them.
 *
 * - mergeChild: in the integration worktree, fetches the child's branch
 *   from origin and runs `git merge --no-ff`. Detects already-merged via
 *   `git merge-base --is-ancestor`. On conflict, collects the conflicting
 *   files and aborts the merge so the worktree stays clean.
 *
 * - forwardMergeMaster: pulls origin/<master> into the integration branch.
 *   Conflict path returns a status, never throws.
 *
 * - pushIntegration: gated by `shouldSkipRemotePush()` for test mode.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
	createWorktree,
	shouldSkipRemotePush,
	type WorktreeResult,
} from "../skills/git.js";

const execFile = promisify(execFileCb);

/** Run a git command. Resolves with stdout (trimmed) on exit 0, rejects with the Error. */
type RunGit = (
	args: string[],
	cwd: string,
	opts?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

const defaultRunGit: RunGit = async (args, cwd, opts) => {
	try {
		const { stdout, stderr } = await execFile("git", args, {
			cwd,
			timeout: opts?.timeout ?? 30_000,
		});
		return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
	} catch (err) {
		const e = err as NodeJS.ErrnoException & { code?: number; stdout?: Buffer | string; stderr?: Buffer | string };
		return {
			stdout: e.stdout ? e.stdout.toString() : "",
			stderr: e.stderr ? e.stderr.toString() : (e.message ?? ""),
			code: typeof e.code === "number" ? e.code : 1,
		};
	}
};

export interface MissionGitDeps {
	repoPath: string;
	/** Optional override — used in tests. Defaults to a wrapper around execFile. */
	runGit?: RunGit;
	/**
	 * Optional override for `createWorktree` — used in tests so we don't shell
	 * out to a real `git worktree add` against a temp repo without a remote.
	 */
	createWorktreeFn?: (
		repoPath: string,
		branch: string,
		opts?: { startPoint?: string; setupCommand?: string; skipPush?: boolean },
	) => Promise<WorktreeResult>;
}

export interface IntegrationBranchInfo {
	branch: string;
	worktreePath: string;
	baseSha: string;
}

export type MergeResult =
	| { status: "merged"; mergeSha: string }
	| { status: "conflict"; conflictFiles: string[] }
	| { status: "already-merged" };

export type ForwardMergeResult =
	| { status: "merged"; mergeSha: string }
	| { status: "conflict"; conflictFiles: string[] }
	| { status: "up-to-date" };

/** Slugify a mission title for use in a branch / worktree directory name. */
export function slugifyTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 30);
	return slug || "mission";
}

/** Build the canonical mission integration branch name. */
export function missionBranchName(missionId: string, title: string): string {
	const slug = slugifyTitle(title);
	const idSuffix = missionId.replace(/-/g, "").slice(0, 8);
	return `mission/${slug}-${idSuffix}`;
}

export class MissionGit {
	private readonly repoPath: string;
	private readonly runGit: RunGit;
	private readonly createWorktreeFn: NonNullable<MissionGitDeps["createWorktreeFn"]>;

	constructor(deps: MissionGitDeps) {
		this.repoPath = deps.repoPath;
		this.runGit = deps.runGit ?? defaultRunGit;
		this.createWorktreeFn =
			deps.createWorktreeFn ??
			((rp, branch, opts) => createWorktree(rp, branch, opts));
	}

	/**
	 * Create the integration branch + managed worktree, branched off
	 * `origin/<master>`. The branch is NOT pushed — pushing is deferred until
	 * the mission-pr gate to keep planning private.
	 */
	async createIntegrationBranch(
		missionId: string,
		missionTitle: string,
		masterRef = "origin/master",
	): Promise<IntegrationBranchInfo> {
		const branch = missionBranchName(missionId, missionTitle);

		// createWorktree handles the `git fetch origin <ref>` + `git worktree add -b`.
		const result = await this.createWorktreeFn(this.repoPath, branch, {
			startPoint: masterRef,
			skipPush: true, // mission integration stays local until mission-pr gate
		});

		const head = await this.runGit(["rev-parse", "HEAD"], result.worktreePath);
		if (head.code !== 0) {
			throw new Error(`Failed to resolve HEAD of integration worktree: ${head.stderr.trim()}`);
		}

		return {
			branch: result.branchName,
			worktreePath: result.worktreePath,
			baseSha: head.stdout.trim(),
		};
	}

	/**
	 * Resolve the start-point SHA for a child goal — HEAD of the integration
	 * branch right now. Children pin to this SHA (not the branch name) so two
	 * parallel siblings observe the same parent commit even if a third child
	 * lands a merge between them.
	 */
	async childStartPoint(integrationWorktree: string): Promise<string> {
		const r = await this.runGit(["rev-parse", "HEAD"], integrationWorktree);
		if (r.code !== 0) {
			throw new Error(
				`childStartPoint: rev-parse HEAD failed in ${integrationWorktree}: ${r.stderr.trim()}`,
			);
		}
		return r.stdout.trim();
	}

	/**
	 * Merge a child goal's branch into the integration branch (in the
	 * integration worktree). Non-fast-forward so each goal lands as a discrete
	 * merge commit.
	 *
	 * Returns:
	 *   - `already-merged` if the child branch is already an ancestor.
	 *   - `merged` with the new merge commit SHA on success.
	 *   - `conflict` with the list of unmerged files; the merge is aborted
	 *     so the worktree returns to a clean state.
	 *
	 * @param integrationWorktree absolute path to the integration worktree.
	 * @param childRef            the child branch ref to merge — typically
	 *                            `origin/<childBranch>` after a fetch, or a
	 *                            local branch name.
	 */
	async mergeChild(
		integrationWorktree: string,
		childBranch: string,
		missionTitle: string,
		planTitle: string,
	): Promise<MergeResult> {
		// Refresh remote tracking so we have the child's latest commits.
		// Non-fatal if it fails (e.g. no remote in tests).
		await this.runGit(["fetch", "origin", childBranch], integrationWorktree, { timeout: 60_000 });

		// Prefer origin/<branch> if it resolves; fall back to local <branch>.
		const remoteRef = `origin/${childBranch}`;
		let mergeRef = remoteRef;
		const remoteOk = await this.runGit(["rev-parse", "--verify", remoteRef], integrationWorktree);
		if (remoteOk.code !== 0) {
			const localOk = await this.runGit(["rev-parse", "--verify", childBranch], integrationWorktree);
			if (localOk.code !== 0) {
				throw new Error(`mergeChild: child branch not found locally or on origin: ${childBranch}`);
			}
			mergeRef = childBranch;
		}

		// Already merged?
		const ancestor = await this.runGit(
			["merge-base", "--is-ancestor", mergeRef, "HEAD"],
			integrationWorktree,
		);
		if (ancestor.code === 0) {
			return { status: "already-merged" };
		}

		const message = `Mission: ${missionTitle} — merge goal: ${planTitle}`;
		const merge = await this.runGit(
			["merge", "--no-ff", "-m", message, mergeRef],
			integrationWorktree,
			{ timeout: 120_000 },
		);

		if (merge.code === 0) {
			const head = await this.runGit(["rev-parse", "HEAD"], integrationWorktree);
			return { status: "merged", mergeSha: head.stdout.trim() };
		}

		// Non-zero exit → likely conflict. Collect conflicting files then abort.
		const unmerged = await this.runGit(
			["diff", "--name-only", "--diff-filter=U"],
			integrationWorktree,
		);
		const conflictFiles = unmerged.stdout
			.split("\n")
			.map(s => s.trim())
			.filter(Boolean);

		await this.abortMerge(integrationWorktree);

		if (conflictFiles.length === 0) {
			// Non-zero exit but no unmerged paths — propagate as a hard error.
			throw new Error(
				`mergeChild: git merge failed with no conflict files. stderr: ${merge.stderr.trim()}`,
			);
		}

		return { status: "conflict", conflictFiles };
	}

	/** Abort an in-progress merge in the given worktree. Best-effort. */
	async abortMerge(integrationWorktree: string): Promise<void> {
		await this.runGit(["merge", "--abort"], integrationWorktree);
	}

	/**
	 * Forward-merge `origin/<master>` into the integration branch. Used to
	 * keep the mission integration branch up to date with master, and as a
	 * precondition for the `mission-pr` gate.
	 */
	async forwardMergeMaster(
		integrationWorktree: string,
		masterBranch: string,
	): Promise<ForwardMergeResult> {
		await this.runGit(["fetch", "origin", masterBranch], integrationWorktree, { timeout: 60_000 });

		const remoteRef = `origin/${masterBranch}`;
		const ancestor = await this.runGit(
			["merge-base", "--is-ancestor", remoteRef, "HEAD"],
			integrationWorktree,
		);
		if (ancestor.code === 0) {
			return { status: "up-to-date" };
		}

		const merge = await this.runGit(
			["merge", "--no-ff", "-m", `Mission: forward-merge ${masterBranch}`, remoteRef],
			integrationWorktree,
			{ timeout: 120_000 },
		);

		if (merge.code === 0) {
			const head = await this.runGit(["rev-parse", "HEAD"], integrationWorktree);
			return { status: "merged", mergeSha: head.stdout.trim() };
		}

		const unmerged = await this.runGit(
			["diff", "--name-only", "--diff-filter=U"],
			integrationWorktree,
		);
		const conflictFiles = unmerged.stdout
			.split("\n")
			.map(s => s.trim())
			.filter(Boolean);
		await this.abortMerge(integrationWorktree);
		return { status: "conflict", conflictFiles };
	}

	/**
	 * Push the integration branch to origin. Gated by `shouldSkipRemotePush()`
	 * so test mode (`BOBBIT_TEST_NO_PUSH=1`) never touches the remote.
	 */
	async pushIntegration(integrationWorktree: string, integrationBranch: string): Promise<void> {
		if (shouldSkipRemotePush()) return;
		const r = await this.runGit(
			["push", "-u", "origin", integrationBranch],
			integrationWorktree,
			{ timeout: 60_000 },
		);
		if (r.code !== 0) {
			throw new Error(`pushIntegration failed: ${r.stderr.trim()}`);
		}
	}

	/** Default integration-worktree path for a given repo + branch. */
	defaultWorktreePath(branch: string): string {
		const wtRoot = path.resolve(this.repoPath, "..", `${path.basename(this.repoPath)}-wt`);
		return path.join(wtRoot, branch.replace(/\//g, "-"));
	}
}
