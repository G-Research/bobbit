import fs from "node:fs";
import path from "node:path";

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
}

/**
 * Simple JSON file store for tasks.
 * Tasks persist across server restarts.
 */
export class TaskStore {
	private readonly storeDir: string;
	private readonly storeFile: string;
	private tasks: Map<string, PersistedTask> = new Map();

	constructor(stateDir: string) {
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "tasks.json");
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(this.storeFile)) {
				const data = JSON.parse(fs.readFileSync(this.storeFile, "utf-8"));
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
		} catch (err) {
			console.error("[task-store] Failed to load persisted tasks:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(this.storeDir)) {
				fs.mkdirSync(this.storeDir, { recursive: true });
			}
			const data = Array.from(this.tasks.values());
			fs.writeFileSync(this.storeFile, JSON.stringify(data, null, 2), "utf-8");
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
