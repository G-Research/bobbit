import fs from "node:fs";
import path from "node:path";
import type { PersistedGoal } from "./goal-store.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { PersistedSession } from "./session-store.js";
import type { PersistedStaff } from "./staff-store.js";
import {
	HEADQUARTERS_PROJECT_ID,
	SYSTEM_PROJECT_ID,
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
	| { ok: true }
	| { ok: false; status: 422; code: "CWD_OUTSIDE_PROJECT"; error: string };

function realOrResolved(input: string): string {
	const resolved = path.resolve(input);
	try { return path.resolve(fs.realpathSync(resolved)); }
	catch { return resolved; }
}

function comparablePath(input: string): string {
	const normalized = realOrResolved(input).replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameOrDescendant(parent: string | undefined, candidate: string): boolean {
	if (!parent || !candidate) return false;
	const root = comparablePath(parent);
	const cwd = comparablePath(candidate);
	return cwd === root || cwd.startsWith(root + "/");
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

function projectOwnsSession(project: RegisteredProject, pcm: ProjectContextManager, sessionId: string): PersistedSession | undefined {
	const ctx = pcm.getOrCreate(project.id);
	const session = ctx?.sessionStore.get(sessionId);
	if (!session) return undefined;
	if (session.projectId && session.projectId !== project.id) return undefined;
	return session;
}

function projectOwnsStaff(project: RegisteredProject, pcm: ProjectContextManager, staffId: string): PersistedStaff | undefined {
	const ctx = pcm.getOrCreate(project.id);
	const staff = ctx?.staffStore.get(staffId);
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
	const project = registry.get(projectId);
	if (!project) {
		return { ok: false, status: 422, code: "CWD_OUTSIDE_PROJECT", error: `cwd cannot be validated for unknown project: ${projectId}` };
	}

	if (isHeadquartersProject(project)) {
		if (isSameOrDescendant(project.rootPath, cwd)) return { ok: true };
		return {
			ok: false,
			status: 422,
			code: "CWD_OUTSIDE_PROJECT",
			error: `cwd must be inside the Headquarters directory (${project.rootPath})`,
		};
	}

	if (project.id === HEADQUARTERS_PROJECT_ID || project.id === SYSTEM_PROJECT_ID) {
		if (isSameOrDescendant(project.rootPath, cwd)) return { ok: true };
		return {
			ok: false,
			status: 422,
			code: "CWD_OUTSIDE_PROJECT",
			error: "cwd must be inside the selected project",
		};
	}

	if (isSameOrDescendant(project.rootPath, cwd)) return { ok: true };
	if (sourceAllowsOwnedCwd(project, projectContextManager, cwd, source)) return { ok: true };

	return {
		ok: false,
		status: 422,
		code: "CWD_OUTSIDE_PROJECT",
		error: "cwd must be inside the selected project or an owned Bobbit worktree",
	};
}
