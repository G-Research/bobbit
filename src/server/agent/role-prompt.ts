import { buildAvailableRolesList } from "./team-manager.js";
import { applyPromptConditionals } from "./prompt-conditionals.js";
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
	ctx: { branch?: string; agentId: string; roleManager?: RoleSource; subGoalsEnabled?: boolean },
): string | undefined {
	if (!role?.promptTemplate) return undefined;
	let p = role.promptTemplate;
	if (ctx.branch) p = p.replace(/\{\{GOAL_BRANCH\}\}/g, ctx.branch);
	p = p.replace(/\{\{AGENT_ID\}\}/g, ctx.agentId);
	p = p.replace(/\{\{AVAILABLE_ROLES\}\}/g, buildAvailableRolesList(ctx.roleManager as any));
	// Conditional blocks ({if:subGoalsEnabled} … {endif:subGoalsEnabled}) are
	// resolved LAST so they can wrap any substituted content. No-op for
	// templates without conditional tags.
	p = applyPromptConditionals(p, { subGoalsEnabled: ctx.subGoalsEnabled ?? false });
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

/**
 * Rebuild the `{ rolePrompt, roleName }` pair for a session being restored on
 * gateway restart. `rolePrompt` isn't persisted, so it must be reconstructed.
 *
 * - **Staff sessions** (`ps.staffId` set + a `getStaff` lookup available):
 *   rebuild via `buildStaffSystemPrompt` so the restored prompt matches the
 *   create path's ordering — role context → staff `systemPrompt` → pinned
 *   memory — and `roleName` is the staff's `roleId` (for model / thinking /
 *   tool-policy resolution). This fixes restored staff sessions previously
 *   losing their `systemPrompt` + memory because the path keyed off `ps.role`.
 * - **Team-agent / role sessions** (`ps.role` set, no staff): resolve the
 *   role's `promptTemplate` via `resolveRolePrompt`, with `roleName` set only
 *   when a prompt was produced.
 * - **Plain sessions** (no role, no staff): both `undefined`.
 */
export function buildRestoreRolePrompt(
	ps: { staffId?: string; role?: string; goalId?: string; id: string; projectId?: string },
	ctx: {
		goalBranch?: string;
		roleManager?: RoleManager;
		getStaff?: (id: string) => PersistedStaff | undefined;
		/**
		 * Optional field-level template resolver (project→ancestor→server→builtin
		 * cascade). When supplied it takes precedence over the plain role-manager
		 * view so project-scoped `promptTemplate` overrides survive a restart.
		 */
		resolveTemplate?: (roleName: string, projectId?: string) => string | undefined;
		/** System-scope subgoals feature flag — gates `{if:subGoalsEnabled}` blocks. */
		subGoalsEnabled?: boolean;
	},
): { rolePrompt?: string; roleName?: string } {
	if (ps.staffId && ctx.getStaff) {
		const staff = ctx.getStaff(ps.staffId);
		if (staff) {
			return { rolePrompt: buildStaffSystemPrompt(staff, ctx.roleManager), roleName: staff.roleId };
		}
	}
	const template = ps.role
		? (ctx.resolveTemplate?.(ps.role, ps.projectId)
			?? (ctx.roleManager ? ctx.roleManager.getRole(ps.role)?.promptTemplate : undefined))
		: undefined;
	const rolePrompt = resolveRolePrompt(template ? { promptTemplate: template } : undefined, {
		branch: ctx.goalBranch,
		agentId: `${ps.role}-${(ps.goalId || ps.id).slice(0, 8)}`,
		roleManager: ctx.roleManager,
		subGoalsEnabled: ctx.subGoalsEnabled,
	});
	return { rolePrompt, roleName: rolePrompt ? ps.role : undefined };
}
