import { randomUUID } from "node:crypto";
import { TaskStore, type TaskCommittedFact, type TaskState, type PersistedTask } from "./task-store.js";
import type { HostNotificationPayload } from "../../shared/extension-host/host-hooks.js";

/** Valid state transitions. Terminal states (complete, skipped) have no outgoing transitions. */
const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
	todo: ["in-progress", "skipped"],
	"in-progress": ["complete", "blocked", "todo"],
	blocked: ["in-progress", "skipped"],
	complete: [],
	skipped: [],
};

const TASK_UPDATED_FIELDS = [
	"title", "spec", "assignedSessionId", "dependsOn", "workflowGateId", "inputGateIds",
	"headSha", "baseSha", "branch", "resultSummary",
] as const;

type TaskUpdatedField = (typeof TASK_UPDATED_FIELDS)[number];
type CatalogueTaskUpdatedPublicField = HostNotificationPayload<"taskUpdated">["changedFields"][number];

/** Internal checkout coordinates are persisted on the task but are not public
 * notification metadata. Every exposed identifier comes from the catalogue. */
const TASK_UPDATED_PUBLIC_FIELD_MAP = {
	title: "title",
	spec: "spec",
	assignedSessionId: "assignedSessionId",
	dependsOn: "dependsOn",
	workflowGateId: "workflowGateId",
	inputGateIds: "inputGateIds",
	headSha: "headSha",
	resultSummary: "resultSummary",
} as const satisfies Partial<Record<TaskUpdatedField, CatalogueTaskUpdatedPublicField>>;

type TaskUpdatedPublicField = (typeof TASK_UPDATED_PUBLIC_FIELD_MAP)[keyof typeof TASK_UPDATED_PUBLIC_FIELD_MAP];

function isTaskUpdatedPublicField(field: TaskUpdatedField): field is keyof typeof TASK_UPDATED_PUBLIC_FIELD_MAP {
	return Object.prototype.hasOwnProperty.call(TASK_UPDATED_PUBLIC_FIELD_MAP, field);
}

function projectTaskUpdatedFields(changedFields: readonly TaskUpdatedField[]): TaskUpdatedPublicField[] {
	const projected = changedFields.flatMap((field): TaskUpdatedPublicField[] => {
		return isTaskUpdatedPublicField(field) ? [TASK_UPDATED_PUBLIC_FIELD_MAP[field]] : [];
	});
	return [...new Set(projected)].sort();
}

function valuesEqual(left: unknown, right: unknown): boolean {
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((value, index) => value === right[index]);
	}
	return left === right;
}

function monotonicNow(previous: number): number {
	return Math.max(Date.now(), previous + 1);
}

export class TaskManager {
	private store: TaskStore;

	constructor(taskStore: TaskStore) {
		this.store = taskStore;
	}

	/**
	 * Create a new task under a goal.
	 * Validates sub-task depth (max 1 level: sub-tasks cannot have sub-tasks).
	 */
	createTask(
		goalId: string,
		title: string,
		type: string,
		opts?: { parentTaskId?: string; spec?: string; dependsOn?: string[]; workflowGateId?: string; inputGateIds?: string[] },
	): PersistedTask {
		const { parentTaskId, spec } = opts ?? {};
		// Deduplicate dependsOn
		let dependsOn = opts?.dependsOn ? [...new Set(opts.dependsOn)] : undefined;

		// Validate sub-task depth: if parentTaskId is set, the parent must not itself be a sub-task
		if (parentTaskId) {
			const parent = this.store.get(parentTaskId);
			if (!parent) {
				throw new Error(`Parent task ${parentTaskId} not found`);
			}
			if (parent.parentTaskId) {
				throw new Error("Sub-tasks cannot have sub-tasks (max one level of nesting)");
			}
			if (parent.goalId !== goalId) {
				throw new Error("Sub-task must belong to the same goal as its parent");
			}
		}

		// Validate dependsOn references exist
		if (dependsOn?.length) {
			for (const depId of dependsOn) {
				if (!this.store.get(depId)) {
					throw new Error(`Dependency task ${depId} not found`);
				}
			}
		}

		const now = Date.now();
		const task: PersistedTask = {
			id: randomUUID(),
			goalId,
			parentTaskId,
			title,
			type,
			state: "todo",
			spec,
			createdAt: now,
			updatedAt: now,
			dependsOn: dependsOn?.length ? dependsOn : undefined,
			workflowGateId: opts?.workflowGateId,
			inputGateIds: opts?.inputGateIds?.length ? opts.inputGateIds : undefined,
		};

		this.commitTask(task, [{
			kind: "taskCreated",
			taskId: task.id,
			goalId: task.goalId,
			type: task.type,
			state: task.state,
			parentTaskId: task.parentTaskId,
			revision: task.updatedAt,
		}]);
		return task;
	}

	getTask(id: string): PersistedTask | undefined {
		return this.store.get(id);
	}

	/** Get all tasks (including sub-tasks) for a goal. */
	getTasksForGoal(goalId: string): PersistedTask[] {
		return this.store.getByGoalId(goalId);
	}

	/** Get all tasks assigned to a session. */
	getTasksForSession(sessionId: string): PersistedTask[] {
		return this.store.getBySessionId(sessionId);
	}

	/**
	 * Update a task's mutable fields.
	 * Validates state transitions and prevents circular dependencies.
	 */
	updateTask(
		id: string,
		updates: {
			title?: string;
			spec?: string;
			state?: TaskState;
			assignedSessionId?: string;
			dependsOn?: string[];
			workflowGateId?: string;
			inputGateIds?: string[];
			headSha?: string;
			baseSha?: string;
			branch?: string;
			resultSummary?: string;
		},
	): boolean {
		const task = this.store.get(id);
		if (!task) return false;

		// Validate state transition if state is being changed
		if (updates.state !== undefined && updates.state !== task.state) {
			if (!this.isValidTransition(task.state, updates.state)) {
				throw new Error(`Invalid state transition: ${task.state} → ${updates.state}`);
			}

			// For completion, validate all sub-tasks are complete or skipped
			if (updates.state === "complete") {
				const subTasks = this.store.getByParentTaskId(id);
				const incomplete = subTasks.filter(st => st.state !== "complete" && st.state !== "skipped");
				if (incomplete.length > 0) {
					throw new Error(`Cannot complete task: ${incomplete.length} sub-task(s) still incomplete`);
				}
			}
		}

		// Validate dependsOn: deduplicate, remove self-references, check existence and cycles
		if (updates.dependsOn !== undefined) {
			updates.dependsOn = [...new Set(updates.dependsOn)].filter((depId) => depId !== id);
			for (const depId of updates.dependsOn) {
				if (!this.store.get(depId)) {
					throw new Error(`Dependency task ${depId} not found`);
				}
			}
			this.detectCycle(id, updates.dependsOn);
		}

		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			if (v !== undefined) cleaned[k] = v;
		}
		const changedFields = TASK_UPDATED_FIELDS.filter(field =>
			Object.prototype.hasOwnProperty.call(cleaned, field)
			&& !valuesEqual(task[field], cleaned[field]),
		);
		const previousState = task.state;
		const stateChanged = updates.state !== undefined && updates.state !== previousState;
		if (!stateChanged && changedFields.length === 0) return true;

		const publicChangedFields = projectTaskUpdatedFields(changedFields);
		const now = monotonicNow(task.updatedAt);
		// Handle completedAt for terminal states
		if (stateChanged && (updates.state === "complete" || updates.state === "skipped")) {
			cleaned.completedAt = now;
		}

		Object.assign(task, cleaned, { updatedAt: now });
		const facts: TaskCommittedFact[] = [];
		if (changedFields.length > 0) {
			facts.push({
				kind: "taskUpdated",
				taskId: task.id,
				goalId: task.goalId,
				state: task.state,
				changedFields: publicChangedFields,
				revision: task.updatedAt,
			});
		}
		if (stateChanged) {
			facts.push({
				kind: "taskStateChanged",
				taskId: task.id,
				goalId: task.goalId,
				previousState,
				state: task.state,
				revision: task.updatedAt,
			});
		}
		this.commitTask(task, facts);
		return true;
	}

	/**
	 * Delete a task. Cascades to delete sub-tasks if the task is a parent.
	 */
	deleteTask(id: string): boolean {
		const task = this.store.get(id);
		if (!task) return false;

		// Cascade delete sub-tasks + the task itself in a single write
		const subTasks = this.store.getByParentTaskId(id);
		const idsToRemove = subTasks.map((s) => s.id);
		idsToRemove.push(id);
		this.store.removeMany(idsToRemove);
		return true;
	}

	/**
	 * Assign a task to a session. Auto-transitions to in-progress.
	 * If the task is a sub-task, also auto-transitions the parent to in-progress.
	 */
	assignTask(taskId: string, sessionId: string): boolean {
		const task = this.store.get(taskId);
		if (!task) return false;

		const assignmentChanged = task.assignedSessionId !== sessionId;
		const previousState = task.state;
		const stateChanged = previousState === "todo";
		if (assignmentChanged || stateChanged) {
			task.assignedSessionId = sessionId;
			task.updatedAt = monotonicNow(task.updatedAt);
			if (stateChanged) task.state = "in-progress";
			const facts: TaskCommittedFact[] = [];
			if (assignmentChanged) {
				facts.push({
					kind: "taskUpdated", taskId: task.id, goalId: task.goalId,
					state: task.state, changedFields: ["assignedSessionId"], revision: task.updatedAt,
				});
			}
			if (stateChanged) {
				facts.push({
					kind: "taskStateChanged", taskId: task.id, goalId: task.goalId,
					previousState, state: task.state, revision: task.updatedAt,
				});
			}
			this.commitTask(task, facts);
		}

		// Auto-transition parent to in-progress if a sub-task starts
		if (task.parentTaskId) {
			const parent = this.store.get(task.parentTaskId);
			if (parent && parent.state === "todo") {
				const parentPreviousState = parent.state;
				parent.state = "in-progress";
				parent.updatedAt = monotonicNow(parent.updatedAt);
				this.commitTask(parent, [{
					kind: "taskStateChanged", taskId: parent.id, goalId: parent.goalId,
					previousState: parentPreviousState, state: parent.state, revision: parent.updatedAt,
				}]);
			}
		}

		return true;
	}

	/**
	 * Complete a task. Validates all sub-tasks are complete or skipped first.
	 */
	completeTask(taskId: string): boolean {
		const task = this.store.get(taskId);
		if (!task) return false;

		if (!this.isValidTransition(task.state, "complete")) {
			throw new Error(`Invalid state transition: ${task.state} → complete`);
		}

		// If this task has sub-tasks, all must be complete or skipped
		const subTasks = this.store.getByParentTaskId(taskId);
		if (subTasks.length > 0) {
			const incomplete = subTasks.filter((s) => s.state !== "complete" && s.state !== "skipped");
			if (incomplete.length > 0) {
				throw new Error(
					`Cannot complete task: ${incomplete.length} sub-task(s) are not complete or skipped`,
				);
			}
		}

		const previousState = task.state;
		const now = monotonicNow(task.updatedAt);
		task.state = "complete";
		task.completedAt = now;
		task.updatedAt = now;
		this.commitTask(task, [{
			kind: "taskStateChanged", taskId: task.id, goalId: task.goalId,
			previousState, state: task.state, revision: task.updatedAt,
		}]);
		return true;
	}

	/**
	 * Transition a task to a new state with validation. No-op (success) if the
	 * task is already in the target state — agents commonly re-issue the
	 * current state when stitching together `task_update` calls, and rejecting
	 * those as 400s wedges team-lead loops.
	 */
	transitionTask(taskId: string, newState: TaskState): boolean {
		const task = this.store.get(taskId);
		if (!task) return false;

		if (task.state === newState) return true;

		if (!this.isValidTransition(task.state, newState)) {
			throw new Error(`Invalid state transition: ${task.state} → ${newState}`);
		}

		// For completion, delegate to completeTask for sub-task validation
		if (newState === "complete") {
			return this.completeTask(taskId);
		}

		const previousState = task.state;
		const now = monotonicNow(task.updatedAt);
		task.state = newState;
		task.updatedAt = now;

		if (newState === "skipped") {
			task.completedAt = now;
		}

		this.commitTask(task, [{
			kind: "taskStateChanged", taskId: task.id, goalId: task.goalId,
			previousState, state: task.state, revision: task.updatedAt,
		}]);
		return true;
	}

	/** Delete all tasks for a goal (for cascade from goal deletion). */
	deleteTasksForGoal(goalId: string): void {
		const tasks = this.store.getByGoalId(goalId);
		this.store.removeMany(tasks.map((t) => t.id));
	}

	// --- Private helpers ---

	private commitTask(task: PersistedTask, facts: readonly TaskCommittedFact[]): void {
		void this.store.putCommitted(task, facts).catch(error => {
			// Existing TaskManager methods are synchronous. The strict store barrier
			// remains observable through TaskStore.flush/close while avoiding an
			// unhandled rejection on legacy callers.
			console.error(`[task-manager] Failed to publish task ${task.id}:`, error);
		});
	}

	private isValidTransition(from: TaskState, to: TaskState): boolean {
		return VALID_TRANSITIONS[from].includes(to);
	}

	/**
	 * Detect circular dependencies by walking the dependency graph.
	 * Throws if adding `newDeps` to `taskId` would create a cycle.
	 */
	private detectCycle(taskId: string, newDeps: string[]): void {
		const visited = new Set<string>();

		const walk = (id: string): void => {
			if (id === taskId) {
				throw new Error("Circular dependency detected");
			}
			if (visited.has(id)) return;
			visited.add(id);

			const dep = this.store.get(id);
			if (dep?.dependsOn) {
				for (const next of dep.dependsOn) {
					walk(next);
				}
			}
		};

		for (const depId of newDeps) {
			walk(depId);
		}
	}
}

/**
 * Mark test/review tasks as stale when a new commit lands on the goal branch.
 * Tasks completed at a different headSha than the current HEAD are stale.
 */
export function markStaleTasks(store: TaskStore, goalId: string, currentHeadSha: string): PersistedTask[] {
	const tasks = store.getByGoalId(goalId);
	const staleMarked: PersistedTask[] = [];
	for (const task of tasks) {
		if (
			task.state === "complete" &&
			(task.type === "testing" || task.type === "tdd-tests" || task.type === "code-review" || task.type === "security-review" || task.type === "design-review") &&
			task.headSha &&
			task.headSha !== currentHeadSha
		) {
			// Don't change state to avoid breaking master's state machine,
			// but the dashboard can compare task.headSha vs branch HEAD to show stale badges
			staleMarked.push(task);
		}
	}
	return staleMarked;
}

/**
 * Get the current HEAD commit SHA for a goal's branch.
 */
export function getGoalBranchHead(cwd: string): string | null {
	try {
		const { execFileSync } = require("node:child_process");
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" }).trim();
	} catch {
		return null;
	}
}
