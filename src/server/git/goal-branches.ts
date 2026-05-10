/**
 * Delete remote branches associated with a goal.
 * Extracted from server.ts (commit: split server.ts).
 */
import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { shouldSkipRemotePush } from "../skills/git.js";
import type { PersistedGoal } from "../agent/goal-store.js";

const execFileAsync = promisify(execFileCb);

/**
 * Delete remote branches associated with a goal (integration + agent worktree branches).
 * Fire-and-forget — errors are logged but never block the archive flow.
 */
export async function deleteRemoteGoalBranches(
	goal: PersistedGoal,
	extraBranches: readonly string[],
	repoPath: string,
): Promise<void> {
	const branches = new Set<string>();
	if (goal.branch) branches.add(goal.branch);
	for (const b of extraBranches) {
		if (b) branches.add(b);
	}
	if (branches.size === 0) return;
	if (shouldSkipRemotePush()) return;

	// Multi-repo: iterate all configured repos and run `git push --delete` in
	// each one in parallel. Single-repo collapses to a single repoPath.
	const goalRepoWorktrees = (goal as { repoWorktrees?: Record<string, string> }).repoWorktrees;
	const repoPaths: string[] = goalRepoWorktrees && Object.keys(goalRepoWorktrees).length > 0
		? Object.keys(goalRepoWorktrees).map(repo => repo === "." ? repoPath : path.join(repoPath, repo))
		: [repoPath];

	await Promise.allSettled(repoPaths.flatMap(rp => Array.from(branches).map(async (branch) => {
		try {
			await execFileAsync("git", ["push", "origin", "--delete", branch], {
				cwd: rp,
				timeout: 15_000,
			});
			console.log(`[api] Deleted remote branch: ${branch} (repo: ${rp})`);
		} catch (err) {
			console.warn(`[api] Failed to delete remote branch ${branch} in ${rp}:`, err);
		}
	})));
}
