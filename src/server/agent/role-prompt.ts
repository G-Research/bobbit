import { buildAvailableRolesList } from "./team-manager.js";
import type { RoleManager } from "./role-manager.js";
import type { PersistedStaff } from "./staff-store.js";

interface RoleLike {
	promptTemplate?: string;
}

interface RoleSource {
	getAll?: () => unknown[];
	listRoles?: () => unknown[];
}

/**
 * Resolve a role's `promptTemplate` with placeholder substitution.
 *
 * Behaviour-preserving extraction of the regular-session block that was
 * copy-pasted across `session-manager.ts`. Single source of truth so the
 * regular-session and staff paths can't drift.
 *
 * - `{{GOAL_BRANCH}}` replaced ONLY when `ctx.branch` is a non-empty string
 *   (otherwise the placeholder is left intact, exactly as before).
 * - `{{AGENT_ID}}` replaced with the caller-supplied `ctx.agentId`.
 * - `{{AVAILABLE_ROLES}}` replaced via `buildAvailableRolesList(ctx.roleManager)`.
 *
 * Returns `undefined` when the role or its `promptTemplate` is missing/empty —
 * callers then fall back gracefully (no throw).
 */
export function resolveRolePrompt(
	role: RoleLike | undefined,
	ctx: { branch?: string; agentId: string; roleManager?: RoleSource },
): string | undefined {
	if (!role?.promptTemplate) return undefined;
	let p = role.promptTemplate;
	if (ctx.branch) p = p.replace(/\{\{GOAL_BRANCH\}\}/g, ctx.branch);
	p = p.replace(/\{\{AGENT_ID\}\}/g, ctx.agentId);
	p = p.replace(/\{\{AVAILABLE_ROLES\}\}/g, buildAvailableRolesList(ctx.roleManager as any));
	return p;
}

/**
 * Assemble the full staff system-prompt blob passed as `rolePrompt` to
 * `createSession`. Order: `[role context ---] systemPrompt [--- Pinned Context]`.
 *
 * When `staff.roleId` resolves to a role with a non-empty `promptTemplate`, the
 * resolved role context is prepended (separated by a `---` rule). Unknown
 * `roleId` / empty template → graceful fallback to `systemPrompt (+ memory)`.
 *
 * `roleName` is still passed separately by callers to `createSession` for
 * model / thinking-level / tool-policy resolution — this only adds the role
 * *prompt text* on top.
 */
export function buildStaffSystemPrompt(
	staff: PersistedStaff,
	roleManager?: RoleManager,
): string {
	let prompt = "";
	if (staff.roleId && roleManager) {
		const role = roleManager.getRole(staff.roleId);
		const rolePrompt = resolveRolePrompt(role, {
			branch: staff.branch,
			agentId: `staff-${staff.id.slice(0, 8)}`,
			roleManager,
		});
		if (rolePrompt) prompt += rolePrompt.trim() + "\n\n---\n\n";
	}
	prompt += staff.systemPrompt;
	if (staff.memory) prompt += "\n\n---\n\n## Pinned Context\n\n" + staff.memory;
	return prompt;
}
