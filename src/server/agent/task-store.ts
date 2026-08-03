import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";
import path from "node:path";
import { CoalescedJsonWriter } from "./coalesced-json-writer.js";

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
	private readonly storeDir: string;
	private readonly storeFile: string;
	private readonly fs: FsLike;
	private readonly writer: CoalescedJsonWriter;
	private tasks: Map<string, PersistedTask> = new Map();
	/** Monotonic process-local counter, bumped once per mutation call. */
	private generation = 0;

	constructor(stateDir: string, fsImpl: FsLike = realFs) {
		this.fs = fsImpl;
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "tasks.json");
		this.writer = new CoalescedJsonWriter(
			this.fs,
			this.storeDir,
			this.storeFile,
			() => JSON.stringify(Array.from(this.tasks.values())),
			"task-store",
		);
		this.load();
	}

	private load(): void {
		try {
			if (this.fs.existsSync(this.storeFile)) {
				const data = JSON.parse(this.fs.readFileSync(this.storeFile, "utf-8"));
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
		this.writer.schedule();
	}

	/** Await all pending persistence, primarily for orderly shutdown/tests. */
	flush(): Promise<void> {
		return this.writer.flush();
	}

	/** Latest atomic persistence duration and serialized byte count. */
	getPersistenceMetrics() {
		return this.writer.getLastWriteMetrics();
	}

	/** Current generation counter. Loading persisted tasks does not increment it. */
	getGeneration(): number {
		return this.generation;
	}

	put(task: PersistedTask): void {
		this.tasks.set(task.id, task);
		this.save();
		this.generation++;
	}

	get(id: string): PersistedTask | undefined {
		return this.tasks.get(id);
	}

	remove(id: string): void {
		this.tasks.delete(id);
		this.save();
		this.generation++;
	}

	removeMany(ids: string[]): void {
		for (const id of ids) {
			this.tasks.delete(id);
		}
		if (ids.length > 0) {
			this.save();
			this.generation++;
		}
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
