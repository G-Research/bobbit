import { randomUUID } from "node:crypto";
import {
	MissionStore,
	validatePlan,
	type DivergencePolicy,
	type MissionPlan,
	type PersistedMission,
} from "./mission-store.js";
import { GoalManager } from "./goal-manager.js";
import type { GoalStore, PersistedGoal } from "./goal-store.js";
import type { WorkflowStore, Workflow } from "./workflow-store.js";

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
		if (this.deps.createIntegrationBranch) {
			try {
				const updates = await this.deps.createIntegrationBranch(mission);
				if (updates.integrationBranch) mission.integrationBranch = updates.integrationBranch;
				if (updates.integrationWorktree) mission.integrationWorktree = updates.integrationWorktree;
				if (updates.baseRef) mission.baseRef = updates.baseRef;
			} catch (err) {
				console.error("[mission-manager] Integration branch setup failed:", err);
				mission.state = "failed";
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
			pausedAt: undefined,
			pausedReason: undefined,
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

		if (m.planFrozenAt && !opts?.force) {
			if (m.state !== "paused") {
				return { ok: false, status: 403, reason: "Plan is frozen — pause mission and provide replan_reason" };
			}
			if (!opts?.replanReason?.trim()) {
				return { ok: false, status: 403, reason: "replan_reason required when plan is frozen" };
			}
			// TODO(mission-gate-owner): cascade-reset `charter` and `plan-review` gates
			// for ownerKind="mission", ownerId=id once gateStore.cascadeReset accepts
			// (ownerKind, ownerId). Today gate-store is goal-only, so re-planning
			// after freeze leaves stale gate verdicts on disk until Coder B's branch
			// merges. Until then proposePlan only updates the plan record itself.
		}

		const previousVersion = m.plan?.version ?? 0;
		const next: MissionPlan = {
			...plan,
			version: Math.max(plan.version | 0, previousVersion + 1),
		};
		this.store.setPlan(id, next);
		// If we re-planned a frozen plan, clear the freeze marker — it must be
		// re-signalled through goal-plan. (Strict mode: state already paused.)
		if (m.planFrozenAt && opts?.replanReason) {
			this.store.update(id, { planFrozenAt: undefined });
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
		const goal = await this.deps.goalManager.createGoal(node.title, childCwd, {
			spec: node.spec,
			workflowId: childWorkflowId,
			workflowStore: this.deps.workflowStore,
			resolvedWorkflow,
			sandboxed: m.sandboxed,
			enabledOptionalSteps: node.enabledOptionalSteps,
			missionId: m.id,
			missionPlanId: node.planId,
			baseBranch: m.integrationBranch,
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
	 * Phase 1 stub for child-goal merge into integration branch. Returns
	 * not-implemented until Coder C's mission-git.ts lands.
	 */
	async integrateChild(_missionId: string, _planId: string): Promise<
		{ ok: false; status: number; reason: string }
	> {
		// TODO(mission-scheduler-owner): wire this to MissionGit.mergeChild
		// once mission-git.ts merges. For now the endpoint returns 501 so
		// callers fail fast and don't assume a merge happened.
		return { ok: false, status: 501, reason: "Child integration not yet wired (phase 4)" };
	}
}

function clampConcurrency(n: number): number {
	const v = Math.floor(Number(n));
	if (!Number.isFinite(v) || v < 1) return DEFAULT_MAX_CONCURRENT;
	return Math.min(v, MAX_CONCURRENT_HARD_LIMIT);
}
