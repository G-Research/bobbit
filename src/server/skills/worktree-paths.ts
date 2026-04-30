/**
 * Pure path helpers for worktree layout.
 *
 * See docs/design/multi-repo-components.md §4.1.
 *
 * No I/O, no git. Just path arithmetic. Used by the worktree pool, goal
 * manager, session manager, sandbox, and the boot sweeper to compute
 * branch-container and per-repo worktree paths consistently.
 */
import path from "node:path";

export interface WorktreeProject {
	rootPath: string;
	worktreeRoot?: string;
}

export interface WorktreeComponent {
	name: string;
	repo: string;                  // "." for single-repo
	relativePath?: string;
}

/**
 * Convert a branch name to a slug suitable for use as a directory name.
 *
 * Slashes are flattened to dashes — this matches the existing convention
 * used throughout the worktree pool, goal manager, and session manager.
 * Idempotent: a slug already free of slashes round-trips unchanged.
 */
export function branchToSlug(branch: string): string {
	return branch.replace(/\//g, "-");
}

/**
 * The parent directory under which all worktrees for this project live.
 *
 * If `worktree_root` is set in `project.yaml`:
 *   - absolute path → used as-is
 *   - relative path → resolved against `rootPath`
 *
 * If unset, defaults to `<rootPath>-wt/` (sibling of the project root).
 */
export function worktreeRoot(project: WorktreeProject): string {
	if (!project.worktreeRoot) {
		return path.resolve(
			path.dirname(project.rootPath),
			path.basename(project.rootPath) + "-wt",
		);
	}
	return path.isAbsolute(project.worktreeRoot)
		? path.resolve(project.worktreeRoot)
		: path.resolve(project.rootPath, project.worktreeRoot);
}

/**
 * The per-branch container directory: `<worktreeRoot>/<branchSlug>/`.
 *
 * In single-repo mode this *is* the agent's cwd and the repo's worktree
 * directory (collapsed via `repoWorktreePath` below).
 *
 * In multi-repo mode this is a plain directory holding sibling repo
 * worktrees side-by-side, mirroring `rootPath`'s layout.
 */
export function branchContainer(project: WorktreeProject, branchSlug: string): string {
	return path.join(worktreeRoot(project), branchSlug);
}

/**
 * Where a specific repo's worktree lives for a given branch.
 *
 *   - single-repo (`repo === "."`): collapses to `branchContainer` itself.
 *   - multi-repo:                   `<branchContainer>/<repo>/`.
 *
 * The `components` argument is unused today but reserved so callers can
 * pass the resolved component list without a refactor when we add
 * cross-component validation.
 */
export function repoWorktreePath(
	project: WorktreeProject,
	_components: WorktreeComponent[],
	branchSlug: string,
	repo: string,
): string {
	const container = branchContainer(project, branchSlug);
	return repo === "." ? container : path.join(container, repo);
}

/**
 * The component's working directory — where its `commands[*]` and
 * `worktree_setup_command` execute.
 *
 *   componentRoot = branchContainer / (repo === "." ? "" : repo) / (relativePath ?? "")
 */
export function componentRoot(component: WorktreeComponent, branchContainerPath: string): string {
	const repoPart = component.repo === "." ? "" : component.repo;
	const relPart = component.relativePath ?? "";
	if (!repoPart && !relPart) return branchContainerPath;
	return path.join(branchContainerPath, repoPart, relPart);
}
