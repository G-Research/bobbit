/**
 * Experiment-runner seam — the gateway closure behind `host.agents.spawnGoal`.
 *
 * This is the single core/host change the experiment-runner market pack needs
 * (see docs/design/experiment-runner-spawn-goal.md). It launches a CHILD GOAL
 * of the calling session's effective goal, carrying a distinct per-arm
 * treatment (`metadata` + `inlineRoles` + workflow), so an A/B variant or an
 * autoresearch candidate runs as its own goal whose effective metadata is the
 * experiment metadata deep-merged with the arm's metadata (#822's
 * `resolveGoalMetadata` + `goalProvisioned` propagate it uniformly across the
 * arm's whole sub-tree — the no-asymmetry guarantee).
 *
 * It factors out the non-transport nested-goal creation lifecycle that the REST
 * `POST /api/goals/:id/spawn-child` handler (`nested-goal-routes.ts`) drives, so
 * the host spawn path and the REST spawn path agree on cwd derivation, the
 * workflow cascade, the inlineRoles merge, nesting limits, idempotency, gate
 * initialization, and the per-root scheduled team start. The `server-host-api.ts`
 * host stays a thin shell: it imports ONLY the `SpawnChildGoalOpts` TYPE from
 * here (erased at runtime — no module cycle) and calls the injected closure.
 *
 * Parent derivation is authoritative server-side: the parent is always the
 * owner session's effective goal (`goalId ?? teamGoalId`). A caller-supplied
 * `parentGoalId` is an assertion only — a mismatch is rejected. There is NO
 * caller-supplied cwd / project / sandbox; all are inherited from the parent.
 */

import path from "node:path";

import type { PersistedGoal } from "./goal-store.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { SessionManager } from "./session-manager.js";
import type { VerificationHarness } from "./verification-harness.js";
import type { Role } from "./role-store.js";
import type { Workflow, WorkflowStore } from "./workflow-store.js";
import { stripSubgoalStepsForChildInheritance } from "./workflow-store.js";
import {
	checkCanSpawnChild,
	inheritedChildOverrides,
	type SubgoalNestingPrefs,
} from "./subgoal-nesting-limit.js";
import { resolveChildWorkflow } from "./spawn-child-workflow.js";

/**
 * The arm/candidate spawn request, normalised by the host shell before it
 * crosses into this closure. `spec`/`title`/`runKey` are required (validated by
 * the host); `parentGoalId` is an assertion only.
 */
export interface SpawnChildGoalOpts {
	spec: string;
	title: string;
	/** Idempotency key unique within the parent goal (mirrors spawn-child's
	 *  `planId` → `spawnedFromPlanId`). A re-call with the same key returns the
	 *  existing child id, never a second goal. */
	runKey: string;
	/** Optional caller assertion only; the server derives the real parent and
	 *  rejects a mismatch. Never authoritative. */
	parentGoalId?: string;
	/** Per-arm namespaced metadata (the treatment). Deep-merged over the
	 *  experiment goal's effective metadata by #822's resolver. */
	metadata?: Record<string, unknown>;
	/** Per-arm inline roles, merged with the parent's (arm wins per name). */
	inlineRoles?: Record<string, Role>;
	/** Workflow selection: `workflowId` (store lookup) or `workflow` (inline
	 *  snapshot, highest precedence). Absent ⇒ inherit the parent's workflow. */
	workflowId?: string;
	workflow?: Workflow;
}

/** A coded error so the pack can branch on `.code` (the host shell's
 *  recursion/backend guards throw plain `Error`s, matching the other `agents`
 *  verbs). */
export class SpawnGoalError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "SpawnGoalError";
		this.code = code;
	}
}

/** Dependencies injected by the gateway (server.ts). Structural Picks keep the
 *  surface small + testable while staying type-checked against the real
 *  managers. */
export interface SpawnExperimentChildGoalDeps {
	sessionManager: Pick<SessionManager, "getPersistedSession">;
	projectContextManager: Pick<ProjectContextManager, "getContextForGoal">;
	verificationHarness: Pick<VerificationHarness, "requestChildStart">;
	getSubgoalNestingPrefs(): SubgoalNestingPrefs;
	broadcastToAll(event: unknown): void;
}

/** Children inherit the ROOT REPO path (+ any monorepo offset), never the
 *  parent's worktree cwd — a parent-worktree cwd would nest child worktrees and
 *  collapse the branching topology. Identical to the spawn-child handler. */
function deriveChildRepoCwd(parent: PersistedGoal): string {
	let childCwd = parent.cwd;
	if (parent.repoPath) {
		const offset = parent.worktreePath ? path.relative(parent.worktreePath, parent.cwd) : "";
		childCwd = offset && offset !== "." && !offset.startsWith("..")
			? path.join(parent.repoPath, offset)
			: parent.repoPath;
	}
	return childCwd;
}

/** Merge parent inline roles with the arm's (arm wins per name). Returns
 *  undefined when neither side contributes a plain-object map. */
function mergeInlineRoles(
	parentRoles: Record<string, Role> | undefined,
	armRoles: Record<string, Role> | undefined,
): Record<string, Role> | undefined {
	const armValid = !!armRoles && typeof armRoles === "object" && !Array.isArray(armRoles);
	if (!parentRoles && !armValid) return undefined;
	return { ...(parentRoles ?? {}), ...(armValid ? armRoles : {}) };
}

/** Run the shared workflow cascade (body.workflow → body.workflowId →
 *  parent.workflow (stripped) → "feature" → first non-hidden). On total failure
 *  fall back to the parent snapshot (stripped) / the caller's id / "feature" and
 *  let createGoal throw loudly rather than create a gateless arm. */
function resolveChildWorkflowOrFallback(
	parent: PersistedGoal,
	opts: SpawnChildGoalOpts,
	workflowStore: WorkflowStore | undefined,
): { workflow?: Workflow; workflowId: string } {
	try {
		const res = resolveChildWorkflow(
			parent,
			undefined,
			{
				...(opts.workflow && typeof opts.workflow === "object" ? { workflow: opts.workflow } : {}),
				...(opts.workflowId !== undefined ? { workflowId: opts.workflowId } : {}),
			},
			workflowStore,
		);
		return { workflow: res.workflow, workflowId: res.workflowId };
	} catch {
		const fallback = parent.workflow
			? stripSubgoalStepsForChildInheritance(structuredClone(parent.workflow))
			: undefined;
		return { workflow: fallback, workflowId: fallback?.id ?? opts.workflowId ?? "feature" };
	}
}

function assertPlainObject(value: unknown, code: string, label: string): void {
	if (value === undefined) return;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SpawnGoalError(code, `${label} must be a plain object`);
	}
}

/**
 * Create a child goal of the owner session's effective goal carrying the arm's
 * treatment. Resolves owner → parent goal → project context, enforces the
 * parent assertion / pause / nesting-limit / idempotency guards, maps the arm
 * bundle onto `createGoal`, stamps the idempotency key, initializes gate state,
 * broadcasts, and requests a scheduled (cap-aware) team start.
 */
export async function spawnExperimentChildGoal(
	deps: SpawnExperimentChildGoalDeps,
	ownerSessionId: string,
	opts: SpawnChildGoalOpts,
): Promise<{ goalId: string }> {
	// 1. Resolve owner → effective goal (the experiment goal). Authoritative.
	const owner = deps.sessionManager.getPersistedSession(ownerSessionId);
	const parentGoalId = owner?.goalId ?? owner?.teamGoalId;
	if (!parentGoalId) {
		throw new SpawnGoalError("NO_EFFECTIVE_GOAL", "calling session has no goal to parent the run under");
	}
	// The caller's parentGoalId is an assertion only — reject a mismatch.
	if (opts.parentGoalId && opts.parentGoalId !== parentGoalId) {
		throw new SpawnGoalError(
			"PARENT_MISMATCH",
			`asserted parentGoalId ${opts.parentGoalId} does not match the derived parent ${parentGoalId}`,
		);
	}

	// Defensive shape guards (the host shell validated the strings already).
	assertPlainObject(opts.metadata, "INVALID_METADATA", "metadata");
	assertPlainObject(opts.inlineRoles, "INVALID_INLINE_ROLES", "inlineRoles");

	const ctx = deps.projectContextManager.getContextForGoal(parentGoalId);
	if (!ctx) {
		throw new SpawnGoalError("PARENT_GOAL_NOT_FOUND", `parent goal ${parentGoalId} project context not found`);
	}
	const parent = ctx.goalStore.get(parentGoalId);
	if (!parent) {
		throw new SpawnGoalError("PARENT_GOAL_NOT_FOUND", `parent goal ${parentGoalId} not found`);
	}
	if (parent.paused) {
		throw new SpawnGoalError("GOAL_PAUSED", `parent goal ${parentGoalId} is paused`);
	}

	// 2. Idempotency on runKey (mirrors spawn-child's planId).
	const siblings = ctx.goalStore.getAll().filter((g) => g.parentGoalId === parentGoalId);
	const existing = siblings.find((g) => g.spawnedFromPlanId === opts.runKey);
	if (existing) return { goalId: existing.id };

	// 3. Goal-level subgoal / nesting policy (single source of truth).
	const prefs = deps.getSubgoalNestingPrefs();
	const check = checkCanSpawnChild(parent, prefs, (gid) => ctx.goalStore.get(gid));
	if (!check.ok) {
		if (check.code === "SUBGOALS_DISABLED") {
			throw new SpawnGoalError("SUBGOALS_DISABLED", "subgoals are disabled for this goal tree");
		}
		throw new SpawnGoalError(
			"NESTING_DEPTH_EXCEEDED",
			`subgoal spawn blocked: nesting depth limit reached (${check.currentDepth}/${check.maxDepth})`,
		);
	}

	// 4-7. Derive inherited child config (cwd, workflow, roles, nesting ceilings).
	const childCwd = deriveChildRepoCwd(parent);
	const { workflow, workflowId } = resolveChildWorkflowOrFallback(parent, opts, ctx.workflowStore);
	const inlineRoles = mergeInlineRoles(parent.inlineRoles, opts.inlineRoles);
	const childOverrides = inheritedChildOverrides(parent, prefs);

	// 8. Create the child goal WITH the arm metadata (#822 persists it).
	const child = await ctx.goalManager.createGoal(opts.title, childCwd, {
		spec: opts.spec,
		workflowId,
		resolvedWorkflow: workflow,
		projectId: parent.projectId,
		sandboxed: parent.sandboxed,
		parentGoalId,
		metadata: opts.metadata,
		inlineRoles,
		subgoalsAllowed: childOverrides.subgoalsAllowed,
		maxNestingDepth: childOverrides.maxNestingDepth,
	});

	// 9. Stamp the idempotency key immediately (stamp-immediately invariant —
	//    no awaits between create and stamp other than this one persist).
	await ctx.goalManager.updateGoal(child.id, { spawnedFromPlanId: opts.runKey });

	// 10. Init gate states + broadcast + request scheduled (cap-aware) start.
	if (child.workflow) {
		ctx.gateStore.initGatesForGoal(child.id, child.workflow.gates.map((g) => g.id));
	}
	deps.broadcastToAll({ type: "goal_created", goalId: child.id, parentGoalId });
	// Request a scheduled (cap-aware) start. A capacity-blocked child is parked
	// `state='blocked'` and started later when a permit frees (mirrors the REST
	// spawn-child handler in nested-goal-routes.ts). Without this stamp the child
	// would sit in its default state while invisibly queued.
	const outcome = deps.verificationHarness.requestChildStart(child.id);
	if (outcome === "capacity-blocked") {
		try {
			await ctx.goalManager.updateGoal(child.id, { state: "blocked" });
			deps.broadcastToAll({ type: "goal_state_changed", goalId: child.id });
		} catch (err) {
			console.warn(`[experiment-spawn-goal] failed to stamp capacity-blocked state for ${child.id} (non-fatal):`, err);
		}
	}

	return { goalId: child.id };
}
