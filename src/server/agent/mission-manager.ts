import { randomUUID } from "node:crypto";
import {
	MAX_REPLANS,
	MissionStore,
	validatePlan,
	type DivergencePolicy,
	type MissionPlan,
	type PersistedMission,
} from "./mission-store.js";
import { GoalManager } from "./goal-manager.js";
import type { GoalStore, PersistedGoal } from "./goal-store.js";
import type { WorkflowStore, Workflow } from "./workflow-store.js";
import type { GateStore } from "./gate-store.js";
import type { MissionGit, MergeResult } from "./mission-git.js";

export interface CreateMissionInput {
	title: string;
	projectId: string;
	spec: string;
	divergencePolicy?: DivergencePolicy;
	maxConcurrentGoals?: number;
	sandboxed?: boolean;
	enabledOptionalSteps?: string[];
}

export interface MissionManagerDeps {
	goalManager: GoalManager;
	goalStore: GoalStore;
	workflowStore?: WorkflowStore;
	resolvedMissionWorkflow?: Workflow;
	projectId: string;
	/**
	 * Resolve a workflow id through the config cascade (builtin → server → project).
	 * The mission manager calls this when spawning child goals so children pick up
	 * the same builtin workflows as a normal `POST /api/goals` call. Falls back to
	 * `workflowStore.get` when not provided (which only sees project-level workflows).
	 */
	resolveWorkflow?: (workflowId: string) => Workflow | undefined;
	/**
	 * Optional hook used by phase 4+ to provision the integration branch + worktree.
	 * When provided, called once during createMission. Returns updates to merge
	 * into the new mission record.
	 */
	createIntegrationBranch?: (mission: PersistedMission) => Promise<{
		integrationBranch?: string;
		integrationWorktree?: string;
		baseRef?: string;
	}>;
	/** Optional gate store for cascade-reset on replan. */
	gateStore?: GateStore;
	/** Optional MissionGit for child integration. */
	missionGit?: MissionGit;
}

const DEFAULT_MAX_CONCURRENT = 3;
const MAX_CONCURRENT_HARD_LIMIT = 8;

/**
 * Mission lifecycle manager — analogous to GoalManager.
 *
 * Phase 1 scope: CRUD, plan validation, freeze, spawn-child (delegates into
 * GoalManager.createGoal with mission-aware options). The scheduler
 * (mission-scheduler.ts) and integration-branch git plumbing (mission-git.ts)
 * are owned by Coder C and wired in via the createIntegrationBranch hook.
 */
export class MissionManager {
	private store: MissionStore;
	private deps: MissionManagerDeps;

	constructor(store: MissionStore, deps: MissionManagerDeps) {
		this.store = store;
		this.deps = deps;
	}

	getStore(): MissionStore {
		return this.store;
	}

	/** Wire/replace the cascade-aware workflow resolver post-construction. */
	setResolveWorkflow(fn: (workflowId: string) => Workflow | undefined): void {
		this.deps.resolveWorkflow = fn;
	}

	/** Wire/replace the resolved mission workflow snapshot post-construction. */
	setResolvedMissionWorkflow(wf: Workflow | undefined): void {
		this.deps.resolvedMissionWorkflow = wf;
	}

	getMission(id: string): PersistedMission | undefined {
		return this.store.get(id);
	}

	listMissions(projectId?: string): PersistedMission[] {
		if (projectId) return this.store.getForProject(projectId).filter(m => !m.archived);
		return this.store.getLive();
	}

	/** Locate the mission that owns a given goal, if any. */
	getMissionForGoal(goalId: string): PersistedMission | undefined {
		for (const m of this.store.getAll()) {
			if (m.plan?.goals.some(g => g.goalId === goalId)) return m;
		}
		return undefined;
	}

	async createMission(input: CreateMissionInput): Promise<PersistedMission> {
		if (!input.title?.trim()) throw new Error("Missing title");
		if (!input.projectId) throw new Error("Missing projectId");
		const max = clampConcurrency(input.maxConcurrentGoals ?? DEFAULT_MAX_CONCURRENT);
		const now = Date.now();
		const id = randomUUID();
		const workflowId = "mission";
		let workflow: Workflow | undefined = this.deps.resolvedMissionWorkflow;
		if (!workflow && this.deps.workflowStore) {
			workflow = this.deps.workflowStore.get(workflowId);
		}
		const mission: PersistedMission = {
			id,
			projectId: input.projectId,
			projects: [input.projectId],
			title: input.title.trim(),
			spec: input.spec ?? "",
			state: "planning",
			createdAt: now,
			updatedAt: now,
			workflowId,
			workflow: workflow ? (JSON.parse(JSON.stringify(workflow)) as Workflow) : undefined,
			divergencePolicy: input.divergencePolicy ?? "strict",
			maxConcurrentGoals: max,
			sandboxed: input.sandboxed === true ? true : undefined,
			enabledOptionalSteps: input.enabledOptionalSteps?.length ? input.enabledOptionalSteps : undefined,
		};

		// Phase-4 hook — provision integration branch + worktree if available.
		// Failures here are non-fatal: the mission stays in `planning`, callers can
		// retry integration setup later. Setting state="failed" here would lock
		// out CRUD/plan flows that don't need a real git worktree (e.g. tests, or
		// purely-planning missions before any execution).
		if (this.deps.createIntegrationBranch) {
			try {
				const updates = await this.deps.createIntegrationBranch(mission);
				if (updates.integrationBranch) mission.integrationBranch = updates.integrationBranch;
				if (updates.integrationWorktree) mission.integrationWorktree = updates.integrationWorktree;
				if (updates.baseRef) mission.baseRef = updates.baseRef;
			} catch (err) {
				console.warn("[mission-manager] Integration branch setup failed (non-fatal):", err);
				mission.setupError = (err as Error).message ?? String(err);
			}
		}

		this.store.put(mission);
		return mission;
	}

	async archiveMission(id: string): Promise<boolean> {
		return this.store.archive(id);
	}

	async pauseMission(id: string, reason: string): Promise<boolean> {
		const m = this.store.get(id);
		if (!m) return false;
		if (m.state === "complete" || m.state === "failed") return false;
		return this.store.update(id, {
			state: "paused",
			pausedAt: Date.now(),
			pausedReason: reason || undefined,
		});
	}

	async resumeMission(id: string): Promise<boolean> {
		const m = this.store.get(id);
		if (!m) return false;
		if (m.state !== "paused") return false;
		return this.store.update(id, {
			state: m.planFrozenAt ? "in-progress" : "planning",
			pausedAt: null,
			pausedReason: null,
		});
	}

	/**
	 * Replace the mission's plan. Bumps `version`. Server enforces:
	 *  - DAG acyclic, deps reference real planIds.
	 *  - If `planFrozenAt` is set: requires mission paused AND replanReason
	 *    non-empty (cascades reset of upstream `charter` / `plan-review`
	 *    gates is left to the gate-store integration — see TODO).
	 */
	async proposePlan(
		id: string,
		plan: MissionPlan,
		opts?: { replanReason?: string; force?: boolean },
	): Promise<{ ok: true; version: number } | { ok: false; status: number; reason: string }> {
		const m = this.store.get(id);
		if (!m) return { ok: false, status: 404, reason: "Mission not found" };

		const validation = validatePlan(plan);
		if (!validation.ok) return { ok: false, status: 400, reason: validation.reason };

		const isReplan = !!m.planFrozenAt && !opts?.force;

		if (isReplan) {
			if (m.state !== "paused") {
				return { ok: false, status: 403, reason: "Plan is frozen — pause mission and provide replan_reason" };
			}
			if (!opts?.replanReason?.trim()) {
				return { ok: false, status: 403, reason: "replan_reason required when plan is frozen" };
			}
			// Cap repeated re-plans — if we've already replanned MAX_REPLANS times,
			// force a human review by rejecting further attempts.
			const already = m.replanCount ?? 0;
			if (already >= MAX_REPLANS) {
				// Ensure the mission is paused with a clear reason for the human.
				this.store.update(id, {
					state: "paused",
					pausedAt: m.pausedAt ?? Date.now(),
					pausedReason: `Replan loop detected (>${MAX_REPLANS} iterations); awaiting human review`,
				});
				return { ok: false, status: 429, reason: `Too many replans (cap=${MAX_REPLANS})` };
			}
			// Cascade-reset upstream content gates so the user must re-signal them
			// after a structural replan.
			if (this.deps.gateStore) {
				for (const gateId of ["charter", "plan-review", "goal-plan"]) {
					const gs = this.deps.gateStore.getGateFor("mission", id, gateId);
					if (gs && gs.status !== "pending") {
						this.deps.gateStore.updateGateStatusFor("mission", id, gateId, "pending");
					}
				}
			}
		}

		const previousVersion = m.plan?.version ?? 0;
		const next: MissionPlan = {
			...plan,
			version: Math.max(plan.version | 0, previousVersion + 1),
		};
		this.store.setPlan(id, next);
		// If we re-planned a frozen plan, clear the freeze marker — it must be
		// re-signalled through goal-plan. (Strict mode: state already paused.)
		if (isReplan && opts?.replanReason) {
			this.store.update(id, { planFrozenAt: null });
			this.store.incrementReplanCount(id);
		}
		return { ok: true, version: next.version };
	}

	freezePlan(id: string): boolean {
		const m = this.store.get(id);
		if (!m || !m.plan) return false;
		this.store.freezePlan(id);
		// Drive the mission state forward once the plan is approved.
		if (m.state === "planning") {
			this.store.update(id, { state: "in-progress" });
		}
		return true;
	}

	/**
	 * Spawn a child goal for a plan node. Idempotent on (missionId, planId).
	 *
	 * Phase 1 stub: validates preconditions and creates a real goal via
	 * GoalManager.createGoal with the mission's integration branch (if any)
	 * passed as baseBranch. The full scheduler-driven flow with concurrency
	 * caps and dependency mirroring lives in mission-scheduler.ts (Coder C).
	 */
	async spawnChild(missionId: string, planId: string): Promise<
		| { ok: true; goal: PersistedGoal; alreadySpawned: boolean }
		| { ok: false; status: number; reason: string }
	> {
		const m = this.store.get(missionId);
		if (!m) return { ok: false, status: 404, reason: "Mission not found" };
		if (m.archived) return { ok: false, status: 409, reason: "Mission is archived" };
		if (!m.plan) return { ok: false, status: 409, reason: "Mission has no plan" };
		if (!m.planFrozenAt) return { ok: false, status: 409, reason: "Plan not approved (goal-plan gate not passed)" };
		const node = m.plan.goals.find(g => g.planId === planId);
		if (!node) return { ok: false, status: 404, reason: `Plan node not found: ${planId}` };

		// Idempotency: if a goal is already attached, return it.
		if (node.goalId) {
			const existing = this.deps.goalStore.get(node.goalId);
			if (existing) {
				return { ok: true, goal: existing, alreadySpawned: true };
			}
			// Stale goalId pointing at a deleted record — fall through and respawn.
		}

		// Dependency check: every upstream node must be merged.
		const deps = m.plan.dependencies.filter(e => e.to === planId).map(e => e.from);
		for (const depId of deps) {
			const dep = m.plan.goals.find(g => g.planId === depId);
			if (!dep || !dep.mergedAt) {
				return { ok: false, status: 409, reason: `Dependency not complete: ${depId}` };
			}
		}

		const childWorkflowId = node.workflowId || "feature";
		const resolvedWorkflow = this.deps.resolveWorkflow?.(childWorkflowId)
			?? this.deps.workflowStore?.get(childWorkflowId);
		// createGoal needs the worktree's parent dir for git-repo detection. For
		// phase 1 we don't have an integration worktree, so fall back to an empty
		// cwd which makes createGoal skip worktree provisioning (consistent with
		// non-team standalone-goal flows in tests).
		const childCwd = m.integrationWorktree ?? "";

		// Pin the child branch to the integration branch HEAD SHA at this exact
		// moment — prevents two parallel siblings observing different parents if
		// a third child lands a merge between their spawn calls. Falls back to
		// the integration branch name on lookup failure (best-effort).
		let baseBranch = m.integrationBranch;
		if (this.deps.missionGit && m.integrationWorktree) {
			try {
				baseBranch = await this.deps.missionGit.childStartPoint(m.integrationWorktree);
			} catch (err) {
				console.warn("[mission-manager] childStartPoint failed; falling back to integration branch name:", err);
			}
		}

		const goal = await this.deps.goalManager.createGoal(node.title, childCwd, {
			spec: node.spec,
			workflowId: childWorkflowId,
			workflowStore: this.deps.workflowStore,
			resolvedWorkflow,
			sandboxed: m.sandboxed,
			enabledOptionalSteps: node.enabledOptionalSteps,
			missionId: m.id,
			missionPlanId: node.planId,
			baseBranch,
		});

		// Tag the goal with the project + mission linkage.
		await this.deps.goalManager.updateGoal(goal.id, {
			projectId: m.projectId,
		});

		this.store.attachGoalToPlanNode(m.id, planId, goal.id);
		this.store.updatePlanNodeState(m.id, planId, {
			state: goal.state,
			spawnedAt: Date.now(),
		});

		return { ok: true, goal, alreadySpawned: false };
	}

	/**
	 * Merge a child goal's branch into the integration branch.
	 * REST-shaped result (ok/status/reason). Scheduler uses
	 * `integrateChildForScheduler` for the MergeResult shape.
	 */
	async integrateChild(missionId: string, planId: string): Promise<
		| { ok: true; status: "merged" | "already-merged"; mergeSha?: string; planId: string }
		| { ok: false; status: number; reason: string; conflictFiles?: string[] }
	> {
		const m = this.store.get(missionId);
		if (!m) return { ok: false, status: 404, reason: "Mission not found" };
		if (!m.plan) return { ok: false, status: 409, reason: "Mission has no plan" };
		const node = m.plan.goals.find(g => g.planId === planId);
		if (!node) return { ok: false, status: 404, reason: `Plan node not found: ${planId}` };
		if (!node.goalId) return { ok: false, status: 409, reason: "Child not yet spawned" };
		if (!m.integrationBranch || !m.integrationWorktree) {
			return { ok: false, status: 409, reason: "Mission has no integration branch/worktree" };
		}
		if (!this.deps.missionGit) return { ok: false, status: 501, reason: "MissionGit not configured" };

		const goal = this.deps.goalStore.get(node.goalId);
		if (!goal || !goal.branch) return { ok: false, status: 404, reason: "Child goal or branch missing" };

		if (node.mergedAt) return { ok: true, status: "already-merged", planId };

		let result;
		try {
			result = await this.deps.missionGit.mergeChild(
				m.integrationWorktree,
				goal.branch,
				m.title,
				node.title,
			);
		} catch (err) {
			return { ok: false, status: 500, reason: (err as Error).message ?? String(err) };
		}

		if (result.status === "conflict") {
			return {
				ok: false,
				status: 409,
				reason: "Merge conflict — strict policy escalates to user",
				conflictFiles: result.conflictFiles,
			};
		}
		if (result.status === "already-merged") {
			this.store.updatePlanNodeState(missionId, planId, { mergedAt: Date.now() });
			return { ok: true, status: "already-merged", planId };
		}
		// merged
		this.store.updatePlanNodeState(missionId, planId, { mergedAt: Date.now() });
		return { ok: true, status: "merged", mergeSha: result.mergeSha, planId };
	}

	/**
	 * Forward-merge `origin/<master>` into the mission integration branch.
	 * Soft-fails on missing config / conflicts — returns a status so the
	 * scheduler can log and continue.
	 */
	async forwardMergeMaster(missionId: string, masterBranch = "master"): Promise<
		{ status: "merged" | "up-to-date" | "conflict" | "skipped" }
	> {
		const m = this.store.get(missionId);
		if (!m || m.archived) return { status: "skipped" };
		if (!m.integrationWorktree || !this.deps.missionGit) return { status: "skipped" };
		const r = await this.deps.missionGit.forwardMergeMaster(m.integrationWorktree, masterBranch);
		return { status: r.status };
	}

	/**
	 * Scheduler-facing variant returning MergeResult directly. Throws on error
	 * shapes so the scheduler logs a warning and continues with other children.
	 */
	async integrateChildForScheduler(missionId: string, planId: string): Promise<MergeResult> {
		const r = await this.integrateChild(missionId, planId);
		if (!r.ok) {
			if (r.conflictFiles) return { status: "conflict", conflictFiles: r.conflictFiles };
			throw new Error(r.reason);
		}
		if (r.status === "merged") return { status: "merged", mergeSha: r.mergeSha! };
		return { status: "already-merged" };
	}
}

function clampConcurrency(n: number): number {
	const v = Math.floor(Number(n));
	if (!Number.isFinite(v) || v < 1) return DEFAULT_MAX_CONCURRENT;
	return Math.min(v, MAX_CONCURRENT_HARD_LIMIT);
}
