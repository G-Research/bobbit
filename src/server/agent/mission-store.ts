import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "./workflow-store.js";
import type { GoalState } from "./goal-store.js";

export type MissionState =
	| "planning"
	| "in-progress"
	| "paused"
	| "complete"
	| "shelved"
	| "failed";

export type DivergencePolicy = "strict" | "balanced" | "autonomous";

export interface PlanEdge {
	/** Upstream planId. */
	from: string;
	/** Dependent planId. */
	to: string;
}

export interface PlannedGoal {
	/** ULID — stable across re-plans. */
	planId: string;
	title: string;
	spec: string;
	workflowId: string;
	suggestedRole?: string;
	enabledOptionalSteps?: string[];

	// Filled once the goal is spawned:
	goalId?: string;
	state?: GoalState;
	spawnedAt?: number;
	completedAt?: number;
	mergedAt?: number;
	failedAttempts?: number;
}

export interface MissionPlan {
	goals: PlannedGoal[];
	dependencies: PlanEdge[];
	rationale: string;
	estimatedConcurrency: number;
	version: number;
}

export interface PersistedMission {
	id: string;
	projectId: string;
	/** v1: [projectId]; reserved field for future cross-project missions. */
	projects: string[];
	title: string;
	spec: string;
	state: MissionState;
	createdAt: number;
	updatedAt: number;

	plan?: MissionPlan;
	planFrozenAt?: number;

	commanderSessionId?: string;

	workflowId: string;
	workflow?: Workflow;

	integrationBranch?: string;
	integrationWorktree?: string;
	baseRef?: string;
	prUrl?: string;

	divergencePolicy: DivergencePolicy;
	maxConcurrentGoals: number;
	sandboxed?: boolean;
	enabledOptionalSteps?: string[];

	archived?: boolean;
	archivedAt?: number;
	pausedAt?: number;
	pausedReason?: string;
	setupError?: string;
	/**
	 * Number of times this mission has been re-planned (proposePlan called
	 * after planFrozenAt was set). Capped — see `MAX_REPLANS` in
	 * mission-manager.ts. Beyond the cap, the mission is auto-paused and
	 * further replans are rejected.
	 */
	replanCount?: number;
}

/** Cap on consecutive re-plans before a mission auto-pauses for human review. */
export const MAX_REPLANS = 3;

/**
 * Generate a ULID-ish identifier (Crockford base-32, time-ordered).
 *
 * Lexicographically sortable so plan nodes render deterministically across
 * re-plans. Not a strict ULID (we don't need monotonicity guarantees within
 * the same millisecond for v1) — good enough for plan ids.
 */
export function ulid(now: number = Date.now()): string {
	const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base-32
	let timeStr = "";
	let t = now;
	for (let i = 9; i >= 0; i--) {
		timeStr = ENC[t % 32] + timeStr;
		t = Math.floor(t / 32);
	}
	let randStr = "";
	for (let i = 0; i < 16; i++) {
		randStr += ENC[Math.floor(Math.random() * 32)];
	}
	return timeStr + randStr;
}

/**
 * JSON file store for missions. Mirrors GoalStore's API shape.
 */
export class MissionStore {
	private readonly storeDir: string;
	private readonly storeFile: string;
	private missions: Map<string, PersistedMission> = new Map();
	private generation = 0;

	constructor(stateDir: string) {
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "missions.json");
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(this.storeFile)) {
				const data = JSON.parse(fs.readFileSync(this.storeFile, "utf-8"));
				if (Array.isArray(data)) {
					for (const m of data) {
						if (m && typeof m.id === "string") {
							this.missions.set(m.id, m as PersistedMission);
						}
					}
				}
			}
		} catch (err) {
			console.error("[mission-store] Failed to load persisted missions:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(this.storeDir)) {
				fs.mkdirSync(this.storeDir, { recursive: true });
			}
			const data = Array.from(this.missions.values());
			fs.writeFileSync(this.storeFile, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[mission-store] Failed to save missions:", err);
		}
	}

	/** Optional callback invoked after any mission mutation (put/update/archive). */
	onIndexUpdate?: (mission: PersistedMission) => void;

	getGeneration(): number {
		return this.generation;
	}

	bumpGeneration(): void {
		this.generation++;
	}

	put(m: PersistedMission): void {
		this.generation++;
		this.missions.set(m.id, m);
		this.save();
		this.onIndexUpdate?.(m);
	}

	get(id: string): PersistedMission | undefined {
		return this.missions.get(id);
	}

	remove(id: string): void {
		this.generation++;
		this.missions.delete(id);
		this.save();
	}

	getAll(): PersistedMission[] {
		return Array.from(this.missions.values());
	}

	getLive(): PersistedMission[] {
		return Array.from(this.missions.values()).filter(m => !m.archived);
	}

	getArchived(): PersistedMission[] {
		return Array.from(this.missions.values()).filter(m => m.archived === true);
	}

	getForProject(projectId: string): PersistedMission[] {
		return Array.from(this.missions.values()).filter(m => m.projectId === projectId);
	}

	archive(id: string): boolean {
		const m = this.missions.get(id);
		if (!m) return false;
		this.generation++;
		m.archived = true;
		m.archivedAt = Date.now();
		m.updatedAt = Date.now();
		this.save();
		this.onIndexUpdate?.(m);
		return true;
	}

	update(
		id: string,
		updates: { [K in keyof Omit<PersistedMission, "id" | "createdAt">]?: PersistedMission[K] | null },
	): boolean {
		const existing = this.missions.get(id) as Record<string, unknown> | undefined;
		if (!existing) return false;
		this.generation++;
		for (const [k, v] of Object.entries(updates)) {
			if (v === undefined) continue;
			if (v === null) {
				delete existing[k];
			} else {
				existing[k] = v;
			}
		}
		existing.updatedAt = Date.now();
		this.save();
		this.onIndexUpdate?.(existing as unknown as PersistedMission);
		return true;
	}

	// ── Plan-specific helpers (atomic) ────────────────────────────

	setPlan(id: string, plan: MissionPlan): boolean {
		const m = this.missions.get(id);
		if (!m) return false;
		this.generation++;
		m.plan = plan;
		m.updatedAt = Date.now();
		this.save();
		this.onIndexUpdate?.(m);
		return true;
	}

	freezePlan(id: string): boolean {
		const m = this.missions.get(id);
		if (!m) return false;
		this.generation++;
		m.planFrozenAt = Date.now();
		m.updatedAt = Date.now();
		this.save();
		this.onIndexUpdate?.(m);
		return true;
	}

	/** Atomically increment replanCount. Returns the new value, or 0 on miss. */
	incrementReplanCount(id: string): number {
		const m = this.missions.get(id);
		if (!m) return 0;
		this.generation++;
		m.replanCount = (m.replanCount ?? 0) + 1;
		m.updatedAt = Date.now();
		this.save();
		this.onIndexUpdate?.(m);
		return m.replanCount;
	}

	attachGoalToPlanNode(missionId: string, planId: string, goalId: string): boolean {
		const m = this.missions.get(missionId);
		if (!m || !m.plan) return false;
		const node = m.plan.goals.find(g => g.planId === planId);
		if (!node) return false;
		this.generation++;
		node.goalId = goalId;
		node.spawnedAt = node.spawnedAt ?? Date.now();
		m.updatedAt = Date.now();
		this.save();
		this.onIndexUpdate?.(m);
		return true;
	}

	updatePlanNodeState(
		missionId: string,
		planId: string,
		patch: { [K in keyof PlannedGoal]?: PlannedGoal[K] | null },
	): boolean {
		const m = this.missions.get(missionId);
		if (!m || !m.plan) return false;
		const node = m.plan.goals.find(g => g.planId === planId) as Record<string, unknown> | undefined;
		if (!node) return false;
		this.generation++;
		for (const [k, v] of Object.entries(patch)) {
			if (v === undefined) continue;
			if (v === null) {
				delete node[k];
			} else {
				node[k] = v;
			}
		}
		m.updatedAt = Date.now();
		this.save();
		this.onIndexUpdate?.(m);
		return true;
	}
}

/**
 * Validate a MissionPlan in isolation — DAG acyclic, deps reference real
 * planIds, no duplicate planIds. Returns { ok: true } or { ok: false, reason }.
 */
export function validatePlan(plan: MissionPlan): { ok: true } | { ok: false; reason: string } {
	if (!plan || !Array.isArray(plan.goals) || !Array.isArray(plan.dependencies)) {
		return { ok: false, reason: "Plan must have goals[] and dependencies[]" };
	}
	const ids = new Set<string>();
	for (const g of plan.goals) {
		if (!g.planId || typeof g.planId !== "string") return { ok: false, reason: "Plan node missing planId" };
		if (ids.has(g.planId)) return { ok: false, reason: `Duplicate planId: ${g.planId}` };
		ids.add(g.planId);
	}
	const adj = new Map<string, string[]>();
	for (const id of ids) adj.set(id, []);
	for (const e of plan.dependencies) {
		if (!ids.has(e.from)) return { ok: false, reason: `Edge references unknown planId: ${e.from}` };
		if (!ids.has(e.to)) return { ok: false, reason: `Edge references unknown planId: ${e.to}` };
		adj.get(e.from)!.push(e.to);
	}
	// Cycle detection — DFS with colour marking.
	const WHITE = 0, GREY = 1, BLACK = 2;
	const colour = new Map<string, number>();
	for (const id of ids) colour.set(id, WHITE);
	function dfs(node: string): string | null {
		colour.set(node, GREY);
		for (const next of adj.get(node) ?? []) {
			const c = colour.get(next);
			if (c === GREY) return next;
			if (c === WHITE) {
				const found = dfs(next);
				if (found) return found;
			}
		}
		colour.set(node, BLACK);
		return null;
	}
	for (const id of ids) {
		if (colour.get(id) === WHITE) {
			const cycle = dfs(id);
			if (cycle) return { ok: false, reason: `Cycle detected at node ${cycle}` };
		}
	}
	return { ok: true };
}
