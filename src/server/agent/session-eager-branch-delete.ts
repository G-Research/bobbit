/**
 * Eager remote-branch delete for archived sessions whose branch is fully
 * merged into `origin/<primary>`.
 *
 * Bug 2 in docs/design/orphan-remote-branch-cleanup.md: `terminateSession`
 * archives sessions but defers remote-branch cleanup to `purgeOneSession`,
 * which only runs after a 7-day archive window. Under typical session churn
 * this backlog never drains. This helper performs the eager delete inline
 * (fire-and-forget from `terminateSession`) when it is safe to do so.
 *
 * Extracted as a pure helper so it can be unit-tested without spinning up
 * a real git remote (the in-process E2E harness sets BOBBIT_TEST_NO_PUSH=1
 * globally, which would mask the assertion).
 */

export interface EagerDeleteOptions {
	branch?: string;
	repoPath?: string;
	delegateOf?: string;
	skipPush: boolean;
	detectPrimary: (cwd: string) => Promise<string>;
	/** Run a git invocation; throw on non-zero exit. Caller injects this. */
	runGit: (args: string[], cwd: string) => Promise<void>;
}

export interface EagerDeleteResult {
	deleted: boolean;
	reason?: string;
}

/**
 * Decide whether to push-delete the session's remote branch and, if so, do it.
 *
 * Guards (must ALL hold before any git work happens):
 *   - non-delegate session
 *   - branch + repoPath set
 *   - branch starts with `session/`
 *   - !skipPush (i.e. `BOBBIT_TEST_NO_PUSH` is not set)
 *   - `git merge-base --is-ancestor <branch> origin/<primary>` succeeds
 *
 * Errors from the final `git push` are reported via `reason` but never thrown
 * — caller is fire-and-forget.
 */
export async function eagerDeleteRemoteSessionBranch(
	opts: EagerDeleteOptions,
): Promise<EagerDeleteResult> {
	if (opts.delegateOf) return { deleted: false, reason: "delegate" };
	const branch = opts.branch;
	const repo = opts.repoPath;
	if (!branch || !repo) return { deleted: false, reason: "no-branch-or-repo" };
	if (!branch.startsWith("session/")) return { deleted: false, reason: "non-session-branch" };
	if (opts.skipPush) return { deleted: false, reason: "skip-push" };

	let primary = "master";
	try {
		primary = await opts.detectPrimary(repo);
	} catch {
		// detectPrimary failure → conservative fallback; ancestor check below
		// will simply fail and we'll skip the delete.
	}

	try {
		await opts.runGit(
			["merge-base", "--is-ancestor", branch, `origin/${primary}`],
			repo,
		);
	} catch {
		// Non-zero exit → not an ancestor (unmerged) or refs missing.
		return { deleted: false, reason: "unmerged-or-missing-ref" };
	}

	try {
		await opts.runGit(["push", "origin", "--delete", branch], repo);
		return { deleted: true };
	} catch (err) {
		return { deleted: false, reason: `push-failed: ${(err as Error).message}` };
	}
}
