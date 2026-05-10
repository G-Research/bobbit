/**
 * Cross-project resolver helpers used by route handlers.
 * Extracted from inner closures inside handleApiRoute() in server.ts.
 *
 * These were originally captured by closure in handleApiRoute(); now they
 * are free functions taking a `RouteDeps` (or specific deps) so per-domain
 * route modules can use them without a god-object closure.
 */
import type { ProjectContextManager } from "../agent/project-context-manager.js";
import type { ProjectConfigStore } from "../agent/project-config-store.js";
import type { GoalManager } from "../agent/goal-manager.js";
import type { TaskManager } from "../agent/task-manager.js";
import { TaskManager as TaskManagerCtor } from "../agent/task-manager.js";
import type { PersistedGoal } from "../agent/goal-store.js";
import type { RouteDeps } from "./route-deps.js";

/** Retrieve a goal from any project context. */
export function getGoalAcrossProjects(deps: RouteDeps, goalId: string): PersistedGoal | undefined {
	const ctx = deps.projectContextManager.getContextForGoal(goalId);
	return ctx?.goalStore.get(goalId);
}

/** List live goals across all projects, optionally filtered by projectId. */
export function listGoalsAcrossProjects(deps: RouteDeps, opts?: { projectId?: string }): PersistedGoal[] {
	if (opts?.projectId) {
		const ctx = deps.projectContextManager.getOrCreate(opts.projectId);
		return ctx ? ctx.goalStore.getLive() : [];
	}
	return deps.projectContextManager.getAllLiveGoals();
}

/** Resolve per-project config store, falling back to the default. */
export function resolveProjectConfigStore(deps: RouteDeps, pid: string | null): ProjectConfigStore {
	if (pid && deps.projectContextManager) {
		const ctx = deps.projectContextManager.getOrCreate(pid);
		if (ctx) return ctx.projectConfigStore;
	}
	return deps.projectConfigStore;
}

/**
 * Resolve the host-side cwd for slash-skill discovery.
 * For sandboxed sessions the cwd is a container-internal path (e.g. /workspace-wt/...)
 * which doesn't exist on the host. Use the project's rootPath instead so skill
 * files (.claude/skills/, .bobbit/skills/) are found on the host filesystem.
 */
export function resolveSkillDiscoveryCwd(
	deps: RouteDeps,
	cwd: string,
	projectId: string | null | undefined,
): string {
	if (projectId && deps.projectContextManager) {
		const ctx = deps.projectContextManager.getOrCreate(projectId);
		if (ctx) return ctx.project.rootPath;
	}
	return cwd;
}

/** Get a GoalManager for the project that owns the given goal. Throws if not found. */
export function getGoalManagerForGoal(deps: RouteDeps, goalId: string): GoalManager {
	const ctx = deps.projectContextManager.getContextForGoal(goalId);
	if (!ctx) throw new Error(`Goal "${goalId}" not found in any project`);
	return ctx.goalManager;
}

// Per-process TaskManager cache (keyed by projectId).
const taskManagerCache = new WeakMap<ProjectContextManager, Map<string, TaskManager>>();

function getProjectTmCache(pcm: ProjectContextManager): Map<string, TaskManager> {
	let m = taskManagerCache.get(pcm);
	if (!m) { m = new Map(); taskManagerCache.set(pcm, m); }
	return m;
}

/** Get a TaskManager for the project that owns the given goal. Throws if not found. */
export function getTaskManagerForGoal(deps: RouteDeps, goalId: string): TaskManager {
	const ctx = deps.projectContextManager.getContextForGoal(goalId);
	if (!ctx) throw new Error(`Goal "${goalId}" not found in any project`);
	const cache = getProjectTmCache(deps.projectContextManager);
	const projectId = ctx.project.id;
	let tm = cache.get(projectId);
	if (!tm) {
		tm = new TaskManagerCtor(ctx.taskStore);
		cache.set(projectId, tm);
	}
	return tm;
}

/** Get a TaskManager for a task by looking up which goal it belongs to. Throws if not found. */
export function getTaskManagerForTask(deps: RouteDeps, taskId: string): TaskManager {
	for (const ctx of deps.projectContextManager.all()) {
		const task = ctx.taskStore.get(taskId);
		if (task) return getTaskManagerForGoal(deps, task.goalId);
	}
	throw new Error(`Task "${taskId}" not found in any project`);
}
