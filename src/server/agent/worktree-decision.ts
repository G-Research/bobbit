/**
 * Pure worktree decision logic for project-scoped agent/session creation.
 *
 * Extracted from server.ts POST /api/sessions handler so it can be tested in
 * isolation and reused by other long-running project-scoped runtimes (staff).
 */

export interface WorktreeDecisionInput {
	/** Whether the caller explicitly requested (or declined) a worktree. */
	worktree?: boolean;
	/** Assistant type — assistants never get session worktrees. */
	assistantType?: string;
	/** Goal ID — goal sessions have their own worktree flow. */
	goalId?: string;
}

/**
 * Determine whether a project-scoped runtime should get a git worktree.
 *
 * Rules:
 *   1. Explicit `worktree` field overrides the default.
 *   2. Default: want worktree if NOT an assistant and NOT a goal session.
 *      Staff callers pass neither, so they default to auto-worktree.
 *   3. Assistants are excluded even if worktree=true.
 *   4. The project must support worktrees (single git repo or multi-repo set);
 *      callers compute that capability separately.
 *
 * @param input  Creation parameters.
 * @param isWorktreeSupported  Whether a worktree can be provisioned.
 * @returns true if the runtime should get a worktree.
 */
export function shouldCreateWorktree(input: WorktreeDecisionInput, isWorktreeSupported: boolean): boolean {
	const { assistantType, goalId } = input;

	const wantWorktree = input.worktree !== undefined
		? !!input.worktree
		: (!assistantType && !goalId);

	return wantWorktree && !assistantType && isWorktreeSupported;
}
