/**
 * Module-level hook: cleanupWorktree (in skills/git.ts) calls
 * `runWorktreePreCleanupHooks(worktreePath)` before issuing
 * `git worktree remove`. The LSP supervisor registers a hook on
 * construction so its child processes release file descriptors first
 * (otherwise on Windows the rm -rf fails with EBUSY).
 */

type Hook = (worktreePath: string) => Promise<void>;

const hooks = new Set<Hook>();

export function registerWorktreePreCleanupHook(fn: Hook): () => void {
	hooks.add(fn);
	return () => hooks.delete(fn);
}

export async function runWorktreePreCleanupHooks(worktreePath: string): Promise<void> {
	if (hooks.size === 0) return;
	await Promise.allSettled([...hooks].map(h => h(worktreePath)));
}
