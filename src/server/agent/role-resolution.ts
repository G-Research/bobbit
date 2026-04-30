/**
 * Per-goal role resolver.
 *
 * Walks the inline-override chain (own goal → ancestors, closest-first)
 * before falling back to the project/server/builtin ConfigCascade.
 *
 * Pure: no module-level state, no I/O. All dependencies injected. Used by
 * call sites that previously looked up roles via `roleStore.get(name)` —
 * notably `team-manager.spawnAgent` and the verification harness — when
 * a goalId is in scope and per-goal-tree role overrides should apply.
 *
 * See `docs/design/nested-goals.md` §7.2.
 */

import type { Role } from "./role-store.js";
import type { GoalStore } from "./goal-store.js";
import type { ConfigCascade } from "./config-cascade.js";

/**
 * Resolve a Role definition for a goal by name.
 *
 * Resolution order:
 *   1. `goal.inlineRoles?.[roleName]`.
 *   2. Closest ancestor's `inlineRoles?.[roleName]`.
 *   3. `ConfigCascade.resolveRoles(projectId)` filtered by `name`.
 *
 * Returns `undefined` when the goal does not exist or no layer defines a
 * role with the requested name.
 */
export function resolveRoleForGoal(
	goalStore: GoalStore,
	cascade: ConfigCascade,
	goalId: string,
	roleName: string,
): Role | undefined {
	const goal = goalStore.get(goalId);
	if (!goal) return undefined;

	// 1. Own inline override.
	const ownInline = goal.inlineRoles?.[roleName];
	if (ownInline) return ownInline;

	// 2. Ancestor inline overrides — closest ancestor wins.
	//    `getAncestors` returns root-first; iterate in reverse so the
	//    immediate parent shadows the root.
	const ancestors = goalStore.getAncestors(goalId);
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const inline = ancestors[i].inlineRoles?.[roleName];
		if (inline) return inline;
	}

	// 3. Project / server / builtin cascade.
	const resolved = cascade.resolveRoles(goal.projectId);
	const hit = resolved.find(r => r.item.name === roleName);
	return hit?.item;
}
