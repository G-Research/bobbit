import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";
import type { Workflow } from "./workflow-store.js";

export type GoalState = "todo" | "in-progress" | "complete" | "shelved";

export interface PersistedGoal {
	id: string;
	title: string;
	cwd: string;
	state: GoalState;
	/** Markdown spec content (inline) */
	spec: string;
	createdAt: number;
	updatedAt: number;
	/** Git worktree path (if goal has its own worktree) */
	worktreePath?: string;
	/** Git branch name for this goal's worktree */
	branch?: string;
	/** The original repo path (for worktree cleanup) */
	repoPath?: string;
	/** Whether this is a team goal with Team Lead orchestration */
	team?: boolean;
	/** Session ID of the Team Lead agent (for team goals) */
	teamLeadSessionId?: string;
	/** Gate types to skip requirement enforcement for */
	skipGateRequirements?: string[];
	/** ID of the workflow template this goal was created from */
	workflowId?: string;
	/** Frozen snapshot of the workflow at goal creation time */
	workflow?: Workflow;
	/** Worktree setup status: ready (done/not needed), preparing (in progress), error (failed) */
	setupStatus?: "ready" | "preparing" | "error";
	/** Error message when setupStatus === "error" */
	setupError?: string;
	/** GitHub PR URL (set by team lead after creating PR) */
	prUrl?: string;
}

const STORE_DIR = bobbitStateDir();
const STORE_FILE = path.join(STORE_DIR, "goals.json");

/**
 * Simple JSON file store for goals.
 * Goals persist across server restarts.
 */
export class GoalStore {
	private goals: Map<string, PersistedGoal> = new Map();

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(STORE_FILE)) {
				const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
				if (Array.isArray(data)) {
					for (const g of data) {
						if (g.id) {
							// Migrate legacy 'swarm' field to 'team'
							if (g.swarm !== undefined && g.team === undefined) {
								g.team = g.swarm;
								delete g.swarm;
							}
							// Migrate skipArtifactRequirements → skipGateRequirements
							if (g.skipArtifactRequirements && !g.skipGateRequirements) {
								g.skipGateRequirements = g.skipArtifactRequirements;
								delete g.skipArtifactRequirements;
							}
							// Default setupStatus for existing goals
							if (!g.setupStatus) {
								g.setupStatus = "ready";
							}
							this.goals.set(g.id, g);
						}
					}
				}
			}
		} catch (err) {
			console.error("[goal-store] Failed to load persisted goals:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(STORE_DIR)) {
				fs.mkdirSync(STORE_DIR, { recursive: true });
			}
			const data = Array.from(this.goals.values());
			fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[goal-store] Failed to save goals:", err);
		}
	}

	put(goal: PersistedGoal): void {
		this.goals.set(goal.id, goal);
		this.save();
	}

	get(id: string): PersistedGoal | undefined {
		return this.goals.get(id);
	}

	remove(id: string): void {
		this.goals.delete(id);
		this.save();
	}

	getAll(): PersistedGoal[] {
		return Array.from(this.goals.values());
	}

	update(id: string, updates: Partial<Omit<PersistedGoal, "id" | "createdAt">>): boolean {
		const existing = this.goals.get(id);
		if (!existing) return false;
		// Strip undefined values to avoid overwriting existing fields
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			if (v !== undefined) cleaned[k] = v;
		}
		Object.assign(existing, cleaned, { updatedAt: Date.now() });
		this.save();
		return true;
	}
}
