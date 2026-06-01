/**
 * Single source of truth for "does this project support a git worktree, and
 * what is the container repoPath?".
 *
 * Shared by the session path (`server.ts` POST /api/sessions), the staff path
 * (`staff-manager.ts::projectSupportsWorktree`), and the goal path
 * (`goal-manager.ts::createGoal`). Before this helper existed, staff iterated
 * `repoNames()` and required EVERY repo — including a non-git `.` container in a
 * poly-repo — to pass `isGitRepo`, bailing to `supported:false` (or, worse,
 * running `git worktree add` against the non-git container root). Session and
 * goal used a different rule. This helper unifies them.
 *
 * Decision (identical for session, staff, and goal):
 *   1. Multi-repo (any component `repo !== "."`) AND a known project root ⇒
 *      `supported`, `repoPath = projectRoot`, `multiRepo:true`. The root need
 *      NOT itself be a git repo — per-repo worktrees land beneath it and
 *      `createWorktreeSet` skips any non-git `.` container entry.
 *   2. Else, if `cwd` is inside a git repo ⇒ `supported`, `repoPath =
 *      getRepoRoot(cwd)`, `multiRepo:false`.
 *   3. Else ⇒ not supported (caller proceeds with no worktree — never throws).
 *
 * See docs/design/multi-repo-components.md §4 + §5.
 */

import path from "node:path";
import type { Component } from "./project-config-store.js";
import {
	isGitRepo as defaultIsGitRepo,
	getRepoRoot as defaultGetRepoRoot,
	isGitRepoRoot as defaultIsGitRepoRoot,
} from "../skills/git.js";

export interface WorktreeSupport {
	supported: boolean;
	repoPath?: string;
	multiRepo: boolean;
}

export interface WorktreeSupportDeps {
	isGitRepo: (cwd: string) => Promise<boolean>;
	getRepoRoot: (cwd: string) => Promise<string>;
	isGitRepoRoot: (dir: string) => Promise<boolean>;
}

/**
 * Resolve worktree capability from `(components, projectRoot, cwd)`.
 *
 * @param components  The project's declared components (drives multi-repo detection).
 * @param projectRoot The project's root directory (poly-repo container).
 * @param cwd         The launch cwd (used for the single-repo `isGitRepo` probe).
 * @param deps        Injectable git probes (defaults to the real git helpers).
 */
export async function resolveWorktreeSupport(
	components: Component[],
	projectRoot: string | undefined,
	cwd: string,
	deps: WorktreeSupportDeps = {
		isGitRepo: defaultIsGitRepo,
		getRepoRoot: defaultGetRepoRoot,
		isGitRepoRoot: defaultIsGitRepoRoot,
	},
): Promise<WorktreeSupport> {
	const multiRepo = components.some(c => c.repo !== ".");

	if (multiRepo && projectRoot) {
		// Poly-repo: the container root IS the repoPath even when it isn't itself
		// a git repo. `createWorktreeSet` worktrees each git sub-repo and skips a
		// non-git `.` container entry. BUT only claim multi-repo support if at
		// least one distinct component repo actually resolves to a git repo ROOT
		// under projectRoot — otherwise there is nothing to worktree and claiming
		// support would make `createWorktreeSet` (and downstream callers) operate
		// on a non-existent container. Fall through to the single-repo probe.
		const distinct = new Set<string>();
		for (const c of components) {
			if (distinct.has(c.repo)) continue;
			distinct.add(c.repo);
			const repoSrc = path.join(projectRoot, c.repo === "." ? "" : c.repo);
			if (await deps.isGitRepoRoot(repoSrc)) {
				return { supported: true, repoPath: projectRoot, multiRepo: true };
			}
		}
		// No git repo root among the declared components — fall through.
	}

	try {
		if (!(await deps.isGitRepo(cwd))) return { supported: false, multiRepo };
		return { supported: true, repoPath: await deps.getRepoRoot(cwd), multiRepo };
	} catch {
		return { supported: false, multiRepo };
	}
}
