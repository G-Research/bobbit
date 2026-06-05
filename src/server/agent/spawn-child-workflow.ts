/**
 * Pure helper that resolves the workflow a child goal should adopt when
 * spawned from a parent — used by the harness's `runSubgoalStep` and
 * (eventually) by `POST /api/goals/:id/spawn-child`.
 *
 * Cascade tiers (highest precedence first):
 *
 *   1. `body.workflow`            — full inline workflow object explicitly
 *                                    supplied by the caller (the spawn-child
 *                                    REST surface allows this; subgoal
 *                                    verify-steps do not currently expose it
 *                                    but the helper accepts it for parity).
 *   2. `body.workflowId` / `sg.workflowId`
 *                                  — registered workflow looked up in the
 *                                    project's `workflowStore`.
 *   3. `parent.workflow`          — inherit the parent's snapshotted
 *                                    workflow, deep-cloned via
 *                                    `structuredClone` and stripped of any
 *                                    parent-specific subgoal verify-steps via
 *                                    `stripSubgoalStepsForChildInheritance`
 *                                    so the child does NOT re-execute the
 *                                    parent's plan.
 *   4. `"feature"` from the workflow store.
 *   5. First non-hidden workflow in the workflow store.
 *
 * This matches the cascade enforced (in spirit) by the REST spawn-child
 * handler in `server.ts`. Callers MUST pass through {workflow, workflowId}
 * to `goalManager.createGoal`'s `resolvedWorkflow` / `workflowId` opts.
 *
 * TODO: `POST /api/goals/:id/spawn-child` in `src/server/server.ts` still
 * inlines its own workflow-resolution logic (see the comment block around
 * `inlineWorkflowBody` near line 3506). Switch that handler to call this
 * helper so both spawn paths stay in lockstep — out of scope for the
 * harness-area remediation goal that introduced this file.
 */

import type { PersistedGoal } from "./goal-store.js";
import type { VerifyStepSubgoal, Workflow, WorkflowStore } from "./workflow-store.js";
import { stripSubgoalStepsForChildInheritance } from "./workflow-store.js";

export interface SpawnChildWorkflowBody {
	workflow?: Workflow;
	workflowId?: string;
}

export interface ResolveChildWorkflowResult {
	/**
	 * Resolved workflow object when the cascade landed on a snapshot (tiers
	 * 1 and 3). Undefined when the cascade landed on a store id only (tiers
	 * 2, 4, 5) — the caller should pass `workflowId` to
	 * `goalManager.createGoal` and let it materialise via the store.
	 */
	workflow?: Workflow;
	/**
	 * The workflow id to record on the child goal. Always set when at least
	 * one tier resolves.
	 */
	workflowId: string;
}

/**
 * Resolve the workflow a freshly-spawned child should adopt. Pure: no side
 * effects, no IO. Returns `{ workflow, workflowId }` where `workflow` is set
 * for snapshot-bearing tiers (1 + 3) and unset for id-only tiers (2/4/5).
 *
 * Throws when the workflow store is unavailable AND no inline / inherited
 * snapshot exists — the harness has no fallback in that case.
 */
export function resolveChildWorkflow(
	parent: PersistedGoal,
	sg: VerifyStepSubgoal | undefined,
	body: SpawnChildWorkflowBody | undefined,
	workflowStore: WorkflowStore | undefined,
): ResolveChildWorkflowResult {
	// Tier 1 — explicit inline workflow on the body wins outright.
	if (body?.workflow && typeof body.workflow === "object" && body.workflow.id) {
		const cloned = structuredClone(body.workflow);
		return { workflow: cloned, workflowId: cloned.id };
	}

	// Tier 2 — explicit workflowId on body or the subgoal step descriptor,
	// looked up in the workflow store.
	const idCandidate = body?.workflowId ?? sg?.workflowId;
	if (idCandidate && workflowStore) {
		const found = workflowStore.get(idCandidate);
		if (found) {
			return { workflowId: found.id };
		}
	}

	// Tier 3 — inherit the parent's snapshotted workflow. Deep-clone via
	// structuredClone (R-032/R-033) and strip parent-specific subgoal
	// verify-steps so the child doesn't re-execute the parent's plan. For
	// non-meta workflows this is effectively a pure deep-clone.
	if (parent.workflow) {
		const cloned = structuredClone(parent.workflow);
		const stripped = stripSubgoalStepsForChildInheritance(cloned);
		return { workflow: stripped, workflowId: stripped.id };
	}

	// Tier 4 — fall back to the project's "feature" workflow.
	if (workflowStore) {
		const feature = workflowStore.get("feature");
		if (feature) {
			return { workflowId: feature.id };
		}

		// Tier 5 — first non-hidden workflow in the store.
		const firstAvailable = workflowStore.getAll().find(w => !w.hidden);
		if (firstAvailable) {
			return { workflowId: firstAvailable.id };
		}
	}

	throw new Error(
		"resolveChildWorkflow: no workflow available — body.workflow / body.workflowId / " +
		"parent.workflow / 'feature' / first-non-hidden all empty",
	);
}
