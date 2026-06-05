/**
 * Role resolution for nested-goal contexts.
 *
 * A goal can carry `inlineRoles` — a snapshotted Record<name, Role> stamped
 * onto the goal at creation time (see PersistedGoal.inlineRoles in
 * goal-store.ts). These are ephemeral: they don't exist in the project's
 * role-store cascade, so they don't pollute the role library, and editing
 * the project's stored roles has no effect on a goal that has its own
 * inline definition for that name.
 *
 * Resolution order: inlineRoles first, project/server/builtin role-store
 * second. This matches the parallel `goal.workflow` snapshot pattern in
 * goal-manager.ts.
 *
 * Pure function — no I/O, no mutations. Unit-testable.
 */

import type { PersistedGoal } from "./goal-store.js";
import type { Role, RoleStore } from "./role-store.js";

/**
 * Resolve a role by name for a given goal. Returns the inline definition
 * if the goal has one for this name; otherwise falls back to the role
 * store. Returns `undefined` when neither has it (caller decides how to
 * handle — typically a fail-loud error message listing available roles).
 *
 * @param goal The goal context — may be undefined for callers that don't
 *   have a goal (e.g. assistant sessions); falls through to the store.
 * @param name The role name to resolve.
 * @param roleStore The project/server/builtin cascade.
 */
export function resolveRole(
	goal: PersistedGoal | undefined,
	name: string,
	roleStore: RoleStore | undefined,
): Role | undefined {
	const inline = goal?.inlineRoles?.[name];
	if (inline) return inline;
	return roleStore?.get(name);
}

/**
 * List the role names available to a goal — inline first, then store.
 * Used in error messages so a fail-loud "Role X not found" can list
 * everything the agent could have asked for, including ephemeral roles
 * that are NOT in the global role manager UI.
 */
export function listAvailableRoles(
	goal: PersistedGoal | undefined,
	roleStore: RoleStore | undefined,
): string[] {
	const inline = goal?.inlineRoles ? Object.keys(goal.inlineRoles) : [];
	const stored = roleStore?.getAll().map(r => r.name) ?? [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const n of [...inline, ...stored]) {
		if (!seen.has(n)) { seen.add(n); out.push(n); }
	}
	return out;
}
