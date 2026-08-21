import fs from "node:fs";
import path from "node:path";
import { bobbitDir } from "../bobbit-dir.js";
import type { PersistedGoal } from "./goal-store.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { PersistedSession } from "./session-store.js";
import type { PersistedStaff } from "./staff-store.js";
import {
	HEADQUARTERS_PROJECT_ID,
	SYSTEM_PROJECT_ID,
	createProjectPathIdentity,
	isHeadquartersProject,
	isSystemProject,
	type ProjectRegistry,
	type RegisteredProject,
} from "./project-registry.js";

export type ProjectResolutionErrorCode =
	| "PROJECT_ID_REQUIRED"
	| "PROJECT_NOT_FOUND"
	| "PROJECT_NOT_VISIBLE";

export type ResolvedProject =
	| { ok: true; projectId: string; project: RegisteredProject }
	| { ok: false; status: 400 | 404; error: string; code: ProjectResolutionErrorCode };

export interface ResolveProjectOptions {
	/** Allow hidden/internal projects such as the synthetic system project. */
	allowHidden?: boolean;
	/** Allow the synthetic system project id even though it is hidden. */
	allowSystem?: boolean;
}

/**
 * Resolve a project-scoped API request from an explicit `projectId` only.
 *
 * `cwd` is deliberately ignored here. It is an execution directory and must
 * be validated after project selection with `validateExecutionCwd()`; it must
 * never select the project scope for user/work actions.
 */
export function resolveProjectForRequest(
	registry: ProjectRegistry,
	body: { projectId?: unknown },
	options: ResolveProjectOptions = {},
): ResolvedProject {
	const raw = body.projectId;
	const projectId = typeof raw === "string" ? raw.trim() : "";
	if (!projectId) {
		return {
			ok: false,
			status: 400,
			code: "PROJECT_ID_REQUIRED",
			error: "projectId required",
		};
	}

	const project = registry.get(projectId);
	if (!project) {
		return {
			ok: false,
			status: 404,
			code: "PROJECT_NOT_FOUND",
			error: `Project not found: ${projectId}`,
		};
	}

	const allowHidden = options.allowHidden === true || (options.allowSystem === true && isSystemProject(project));
	if (!allowHidden && (project.hidden || isSystemProject(project))) {
		return {
			ok: false,
			status: 400,
			code: "PROJECT_NOT_VISIBLE",
			error: "projectId must reference a visible project",
		};
	}

	return { ok: true, projectId: project.id, project };
}

export type CwdOwnershipSource =
	| { kind: "user-input" }
	| { kind: "goal"; goalId: string }
	| { kind: "session"; sessionId: string }
	| { kind: "staff"; staffId: string }
	| { kind: "team"; goalId: string }
	| { kind: "verification"; goalId: string };

export type CwdValidationResult =
	| { ok: true; cwd?: string }
	| { ok: false; status: 422; code: "CWD_OUTSIDE_PROJECT"; error: string };

// Execution-cwd validation and goal-creation preflight must bind the same
// host path identity. Disable ProjectRegistry's owned case probe here: request
// validation/preflight is strictly read-only, so inconclusive filesystems keep
// their case-preserving spelling rather than creating a temporary directory.
const executionPathIdentityOwner = createProjectPathIdentity({
	createCaseProbe: () => { throw new Error("read-only execution path identity"); },
});

/**
 * Realpath-aware, separator-normalized identity for execution coordinates.
 * Resolves the longest existing prefix and preserves case unless the host
 * filesystem supplies bounded read-only evidence that aliases are equivalent.
 */
export function executionPathIdentity(input: string): string {
	return executionPathIdentityOwner(input);
}

/** Preserve the established canonical cwd spelling while resolving aliases. */
export function canonicalExecutionCwd(input: string): string {
	const resolved = path.resolve(input);
	let existing = resolved;
	const suffix: string[] = [];
	while (true) {
		try {
			const canonical = path.resolve(fs.realpathSync(existing));
			return path.join(canonical, ...suffix.reverse());
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) return resolved;
			suffix.push(path.basename(existing));
			existing = parent;
		}
	}
}

function isSameOrDescendant(parent: string | undefined, candidate: string): boolean {
	if (!parent || !candidate) return false;
	const canonicalParent = executionPathIdentity(parent);
	const canonicalCandidate = executionPathIdentity(candidate);
	if (canonicalParent === canonicalCandidate) return true;
	const prefix = canonicalParent.endsWith("/") ? canonicalParent : `${canonicalParent}/`;
	return canonicalCandidate.startsWith(prefix);
}

function repoWorktreeRoots(repoWorktrees: Record<string, string> | undefined): string[] {
	return repoWorktrees ? Object.values(repoWorktrees).filter((value): value is string => typeof value === "string" && value.length > 0) : [];
}

function projectOwnsGoal(project: RegisteredProject, pcm: ProjectContextManager, goalId: string): PersistedGoal | undefined {
	const ctx = pcm.getContextForGoal(goalId);
	if (!ctx || ctx.project.id !== project.id) return undefined;
	const goal = ctx.goalStore.get(goalId);
	if (!goal) return undefined;
	if (goal.projectId && goal.projectId !== project.id) return undefined;
	return goal;
}

function existingProjectContext(project: RegisteredProject, pcm: ProjectContextManager) {
	for (const ctx of pcm.all()) {
		if (ctx.project.id === project.id) return ctx;
	}
	return undefined;
}

function projectOwnsSession(project: RegisteredProject, pcm: ProjectContextManager, sessionId: string): PersistedSession | undefined {
	// Ownership validation is read-only: a lookup must never lazily provision a
	// project context or open its stores.
	const session = existingProjectContext(project, pcm)?.sessionStore.get(sessionId);
	if (!session) return undefined;
	if (session.projectId && session.projectId !== project.id) return undefined;
	return session;
}

function projectOwnsStaff(project: RegisteredProject, pcm: ProjectContextManager, staffId: string): PersistedStaff | undefined {
	const staff = existingProjectContext(project, pcm)?.staffStore.get(staffId);
	if (!staff) return undefined;
	if (staff.projectId && staff.projectId !== project.id) return undefined;
	return staff;
}

function cwdOwnedByGoalWorktree(project: RegisteredProject, pcm: ProjectContextManager, goalId: string, cwd: string): boolean {
	const goal = projectOwnsGoal(project, pcm, goalId);
	if (!goal) return false;
	const roots = [goal.worktreePath, ...repoWorktreeRoots(goal.repoWorktrees)];
	return roots.some(root => isSameOrDescendant(root, cwd));
}

function cwdOwnedBySession(project: RegisteredProject, pcm: ProjectContextManager, sessionId: string, cwd: string): boolean {
	const session = projectOwnsSession(project, pcm, sessionId);
	if (!session) return false;
	const roots = [session.worktreePath, session.cwd, ...repoWorktreeRoots(session.repoWorktrees)];
	return roots.some(root => isSameOrDescendant(root, cwd));
}

function cwdOwnedByStaff(project: RegisteredProject, pcm: ProjectContextManager, staffId: string, cwd: string): boolean {
	const staff = projectOwnsStaff(project, pcm, staffId);
	if (!staff) return false;
	const roots = [staff.worktreePath, staff.cwd, ...repoWorktreeRoots(staff.repoWorktrees)];
	return roots.some(root => isSameOrDescendant(root, cwd));
}

function sourceAllowsOwnedCwd(project: RegisteredProject, pcm: ProjectContextManager, cwd: string, source: CwdOwnershipSource): boolean {
	switch (source.kind) {
		case "goal":
		case "team":
		case "verification":
			return cwdOwnedByGoalWorktree(project, pcm, source.goalId, cwd);
		case "session":
			return cwdOwnedBySession(project, pcm, source.sessionId, cwd);
		case "staff":
			return cwdOwnedByStaff(project, pcm, source.staffId, cwd);
		case "user-input":
			return false;
	}
}

export function validateExecutionCwd(
	registry: ProjectRegistry,
	projectContextManager: ProjectContextManager,
	projectId: string,
	cwd: string | undefined,
	source: CwdOwnershipSource,
): CwdValidationResult {
	if (!cwd) return { ok: true };
	const canonicalCwd = canonicalExecutionCwd(cwd);
	const project = registry.get(projectId);
	if (!project) {
		return { ok: false, status: 422, code: "CWD_OUTSIDE_PROJECT", error: `cwd cannot be validated for unknown project: ${projectId}` };
	}

	if (isHeadquartersProject(project)) {
		if (isSameOrDescendant(project.rootPath, canonicalCwd)) return { ok: true, cwd: canonicalCwd };
		return {
			ok: false,
			status: 422,
			code: "CWD_OUTSIDE_PROJECT",
			error: `cwd must be inside the Headquarters directory (${project.rootPath})`,
		};
	}

	if (project.id === SYSTEM_PROJECT_ID) {
		if (isSameOrDescendant(bobbitDir(), canonicalCwd) || isSameOrDescendant(project.rootPath, canonicalCwd)) return { ok: true, cwd: canonicalCwd };
		return {
			ok: false,
			status: 422,
			code: "CWD_OUTSIDE_PROJECT",
			error: "cwd must be inside the Headquarters directory for system-scope sessions",
		};
	}

	if (project.id === HEADQUARTERS_PROJECT_ID) {
		if (isSameOrDescendant(project.rootPath, canonicalCwd)) return { ok: true, cwd: canonicalCwd };
		return {
			ok: false,
			status: 422,
			code: "CWD_OUTSIDE_PROJECT",
			error: "cwd must be inside the selected project",
		};
	}

	if (isSameOrDescendant(project.rootPath, canonicalCwd)) return { ok: true, cwd: canonicalCwd };
	// Ownership roots and the requested coordinate live in the same server-owned
	// realm. Keep their original path dialect for containment: on a Windows host,
	// sandbox POSIX paths such as /workspace-wt/... must not be rewritten into a
	// host drive path before comparing them. Native paths remain realpath-aware
	// through isSameOrDescendant(), and user input never reaches this allowance.
	if (sourceAllowsOwnedCwd(project, projectContextManager, cwd, source)) return { ok: true, cwd: canonicalCwd };

	return {
		ok: false,
		status: 422,
		code: "CWD_OUTSIDE_PROJECT",
		error: source.kind === "user-input"
			? "cwd must be inside the selected project"
			: "cwd must be inside the selected project or the server-owned Bobbit worktree",
	};
}
