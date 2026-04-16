/**
 * Pure worktree decision logic for session creation.
 *
 * Extracted from server.ts POST /api/sessions handler so it can be
 * tested in isolation without the full server context.
 */

export interface WorktreeDecisionInput {
	/** Whether the caller explicitly requested (or declined) a worktree */
	worktree?: boolean;
	/** Assistant type — assistants never get worktrees */
	assistantType?: string;
	/** Goal ID — goal sessions have their own worktree flow */
	goalId?: string;
}

/**
 * Determine whether a new session should get a git worktree.
 *
 * Rules (from server.ts POST /api/sessions):
 *   1. Explicit `worktree` field overrides the default.
 *   2. Default: want worktree if NOT an assistant and NOT a goal session.
 *   3. Even with want=true, assistants are excluded (second guard).
 *   4. The cwd must be inside a git repo (caller checks this separately).
 *
 * @param input  Session creation parameters
 * @param isGitRepo  Whether the session cwd is inside a git repo
 * @returns true if the session should get a worktree
 */
export function shouldCreateWorktree(input: WorktreeDecisionInput, isGitRepo: boolean): boolean {
	const { assistantType, goalId } = input;

	const wantWorktree = input.worktree !== undefined
		? !!input.worktree
		: (!assistantType && !goalId);

	return wantWorktree && !assistantType && isGitRepo;
}
