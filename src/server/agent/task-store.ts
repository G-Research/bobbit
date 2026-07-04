import path from "node:path";
import { atomicWriteJsonSync, loadJsonWithBackupFallback } from "./atomic-json.js";

export type TaskState = "todo" | "in-progress" | "blocked" | "complete" | "skipped";

export interface PersistedTask {
	id: string;
	goalId: string;
	parentTaskId?: string;
	title: string;
	type: string;
	state: TaskState;
	assignedSessionId?: string;
	spec?: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	dependsOn?: string[];
	baseSha?: string;
	headSha?: string;
	branch?: string;
	resultSummary?: string;
	/** Workflow gate ID this task should produce (0 or 1). */
	workflowGateId?: string;
	/** Workflow gate IDs whose accepted content to inject when prompting the agent. */
	inputGateIds?: string[];
	/** Per-repo git handoff (multi-repo). Falls back to flat baseSha/headSha/branch for single-repo. */
	gitHandoff?: Record<string, { baseSha?: string; headSha?: string; branch?: string }>;
}

/**
 * Read a task's git handoff for a specific repo, falling back to legacy flat
 * fields for single-repo tasks. Returns an empty object when neither is set.
 *
 * Callers should always go through this helper rather than reading flat fields
 * directly so single- and multi-repo tasks behave uniformly.
 */
export function readHandoff(
	task: PersistedTask,
	repo: string,
): { baseSha?: string; headSha?: string; branch?: string } {
	if (task.gitHandoff && task.gitHandoff[repo]) return { ...task.gitHandoff[repo] };
	return { baseSha: task.baseSha, headSha: task.headSha, branch: task.branch };
}

/**
 * Simple JSON file store for tasks.
 * Tasks persist across server restarts.
 */
export class TaskStore {
	private readonly storeFile: string;
	private tasks: Map<string, PersistedTask> = new Map();
	/** Number of .bak generations to keep alongside tasks.json. */
	private static readonly BACKUP_COUNT = 3;

	constructor(stateDir: string) {
		this.storeFile = path.join(stateDir, "tasks.json");
		this.load();
	}

	private load(): void {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- legacy-field migration below needs loose typing, matching prior JSON.parse(...) behavior
		const data = loadJsonWithBackupFallback<any[]>(this.storeFile, {
			backups: TaskStore.BACKUP_COUNT,
			onBackupUsed: (usedFile) =>
				console.warn(`[task-store] Loaded from backup ${path.basename(usedFile)} — primary missing/corrupt`),
		});
		if (Array.isArray(data)) {
			for (const t of data) {
				if (t.id && t.goalId && t.title && t.type && t.state) {
					// Migrate old field names
					if (t.workflowArtifactId && !t.workflowGateId) {
						t.workflowGateId = t.workflowArtifactId;
						delete t.workflowArtifactId;
					}
					if (t.inputArtifactIds && !t.inputGateIds) {
						t.inputGateIds = t.inputArtifactIds;
						delete t.inputArtifactIds;
					}
					// Migrate commitSha -> headSha
					if (t.commitSha && !t.headSha) {
						t.headSha = t.commitSha;
					}
					delete t.commitSha;
					this.tasks.set(t.id, t);
				}
			}
		}
	}

	private save(): void {
		try {
			const data = Array.from(this.tasks.values());
			atomicWriteJsonSync(this.storeFile, data, { backups: TaskStore.BACKUP_COUNT });
		} catch (err) {
			console.error("[task-store] Failed to save tasks:", err);
		}
	}

	put(task: PersistedTask): void {
		this.tasks.set(task.id, task);
		this.save();
	}

	get(id: string): PersistedTask | undefined {
		return this.tasks.get(id);
	}

	remove(id: string): void {
		this.tasks.delete(id);
		this.save();
	}

	removeMany(ids: string[]): void {
		for (const id of ids) {
			this.tasks.delete(id);
		}
		if (ids.length > 0) this.save();
	}

	getAll(): PersistedTask[] {
		return Array.from(this.tasks.values());
	}

	getByGoalId(goalId: string): PersistedTask[] {
		return this.getAll().filter((t) => t.goalId === goalId);
	}

	getBySessionId(sessionId: string): PersistedTask[] {
		return this.getAll().filter((t) => t.assignedSessionId === sessionId);
	}

	getByParentTaskId(parentTaskId: string): PersistedTask[] {
		return this.getAll().filter((t) => t.parentTaskId === parentTaskId);
	}
}
