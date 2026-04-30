/**
 * Per-goal workflow resolver.
 *
 * Walks the inline-override chain (own goal → ancestors, closest-first)
 * before falling back to the project/server/builtin ConfigCascade.
 *
 * Pure: no module-level state, no I/O. All dependencies injected. Used at
 * goal-creation time and by call sites that need to materialise a custom
 * workflow definition for a child or descendant goal — *not* for replaying
 * a goal's own frozen `goal.workflow` snapshot, which remains the source
 * of truth for that goal's runtime verification.
 *
 * See `docs/design/nested-goals.md` §7.1.
 */

import type { Workflow } from "./workflow-store.js";
import type { GoalStore } from "./goal-store.js";
import type { ConfigCascade } from "./config-cascade.js";

/**
 * Resolve a Workflow definition for a goal.
 *
 * Resolution order:
 *   1. The goal's own `inlineWorkflow` snapshot.
 *   2. Closest-ancestor `inlineWorkflow` whose `id` matches `workflowId`.
 *      (When `workflowId` is omitted, ancestors are skipped — without a
 *      key there is nothing to match on.)
 *   3. `ConfigCascade.resolveWorkflows(projectId)` filtered by `workflowId`.
 *
 * Returns `undefined` when the goal does not exist, when no inline match
 * is found and no `workflowId` was given, or when the cascade has no
 * matching entry.
 *
 * NOTE: when the goal has an `inlineWorkflow` but the caller passes an
 * unrelated `workflowId`, the inline override is **not** returned. The
 * caller is asking for a specific workflow id; if the goal's own inline
 * workflow does not match it, we must look further.
 */
export function resolveWorkflowForGoal(
	goalStore: GoalStore,
	cascade: ConfigCascade,
	goalId: string,
	workflowId?: string,
): Workflow | undefined {
	const goal = goalStore.get(goalId);
	if (!goal) return undefined;

	// 1. Own inline override.
	if (goal.inlineWorkflow) {
		if (!workflowId || goal.inlineWorkflow.id === workflowId) {
			return goal.inlineWorkflow;
		}
	}

	// 2. Ancestor inline overrides — closest ancestor wins.
	//    `getAncestors` returns root-first; iterate in reverse so the
	//    immediate parent is checked first and shadows the root.
	if (workflowId) {
		const ancestors = goalStore.getAncestors(goalId);
		for (let i = ancestors.length - 1; i >= 0; i--) {
			const inline = ancestors[i].inlineWorkflow;
			if (inline && inline.id === workflowId) return inline;
		}
	}

	// 3. Project / server / builtin cascade.
	if (workflowId) {
		const resolved = cascade.resolveWorkflows(goal.projectId);
		const hit = resolved.find(r => r.item.id === workflowId);
		return hit?.item;
	}

	return undefined;
}
