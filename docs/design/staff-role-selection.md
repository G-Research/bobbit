# Staff Role Selection — Design

## Goal

Let users optionally choose a **role** when creating/editing a staff member. A selected role:
1. **Prepends the role's prompt context** to the staff agent's system prompt (role context first, then the staff's own `systemPrompt`, then pinned memory).
2. **Pre-fills the accessory** from the role's accessory (still user-overridable).

Role is fully optional — staff with no role behave exactly as today.

## Current state (verified)

- `PersistedStaff.roleId?: string` exists (`src/server/agent/staff-store.ts`). `StaffStore.update` treats `null` as "delete key" (clears the field) and strips `undefined`.
- `POST /api/staff` already passes `roleId: body.roleId` to `createStaff` (`server.ts` ~9818). `PUT /api/staff/:id` already passes `roleId: body.roleId` to `staffManager.updateStaff` (`server.ts` ~9929). **Neither validates that the role exists.**
- `createStaff` / `ensureSessionForStaff` pass `roleName: staff.roleId` to `createSession`, so role-keyed **model / thinking-level / tool-policy** overrides already apply via `session-setup.ts`. This must NOT change.

### The bug: staff misuse the prompt slots

Three staff sites assemble `fullPrompt = staff.systemPrompt (+ "\n\n---\n\n## Pinned Context\n\n" + staff.memory)` and pass it as `createSession({ rolePrompt: fullPrompt, roleName: staff.roleId })`. The role's actual `promptTemplate` is **never resolved or injected**. The three sites:
- `staff-manager.ts` → `createStaff` (~line 372)
- `staff-manager.ts` → `ensureSessionForStaff` legacy-migration branch (~line 640)
- `server.ts` → staff fork/restore path (~line 7294)

### Regular-session role-prompt resolution (the duplication to consolidate)

The "resolve role → `promptTemplate` with placeholder substitution" block is copy-pasted in two `session-manager.ts` sites and partially diverges in a third:
- `session-manager.ts` build-prompt-parts (~line 1682) — full substitution.
- `session-manager.ts` restore-on-restart (~line 3458) — full substitution.
- `session-manager.ts` `assignRole` (~line 4804) — passes `rolePrompt: role.promptTemplate` **raw, with no substitution** (latent inconsistency; the shared helper fixes it).

The substitution block (sites 1 & 2):
```ts
rolePrompt = role.promptTemplate;
if (goal?.branch) rolePrompt = rolePrompt.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch);
rolePrompt = rolePrompt.replace(/\{\{AGENT_ID\}\}/g, `${role}-${(goalId || id).slice(0, 8)}`);
rolePrompt = rolePrompt.replace(/\{\{AVAILABLE_ROLES\}\}/g, buildAvailableRolesList(this.roleManager));
```
Note: `{{GOAL_BRANCH}}` is replaced **only when `goal?.branch` is truthy** — otherwise the placeholder is left intact. The shared helper must preserve this exactly.

`buildAvailableRolesList` lives in `src/server/agent/team-manager.ts` and is already imported by `session-manager.ts`.

`RoleManager.getRole(name): Role | undefined` returns a role with `promptTemplate: string` and `accessory?: string`.

The final composition (role prompt + AGENTS.md + tool docs + goal + task + workflow) is owned by `assembleSystemPrompt` in `system-prompt.ts`, which merges `rolePrompt` into the goal section. Staff have no goal, so for staff the `rolePrompt` blob becomes the goal/role section. This structure is unchanged.

## Design

### New module: `src/server/agent/role-prompt.ts`

Single source of truth for role-prompt resolution and staff prompt assembly. New module (not session-manager.ts) to avoid an import cycle: `staff-manager.ts` and `server.ts` both need `buildStaffSystemPrompt`, and `staff-manager` must not import `session-manager`.

```ts
import { buildAvailableRolesList } from "./team-manager.js";
import type { RoleManager } from "./role-manager.js";
import type { PersistedStaff } from "./staff-store.js";

interface RoleLike { promptTemplate?: string }
interface RoleSource { getAll?: () => unknown[]; listRoles?: () => unknown[] }

/**
 * Resolve a role's promptTemplate with placeholder substitution.
 * Behaviour-preserving extraction of the regular-session block.
 * - {{GOAL_BRANCH}} replaced ONLY when `branch` is a non-empty string.
 * - {{AGENT_ID}} replaced with the caller-supplied agentId.
 * - {{AVAILABLE_ROLES}} replaced via buildAvailableRolesList(roleManager).
 * Returns undefined when role/promptTemplate is missing/empty.
 */
export function resolveRolePrompt(
  role: RoleLike | undefined,
  ctx: { branch?: string; agentId: string; roleManager?: RoleSource },
): string | undefined {
  if (!role?.promptTemplate) return undefined;
  let p = role.promptTemplate;
  if (ctx.branch) p = p.replace(/\{\{GOAL_BRANCH\}\}/g, ctx.branch);
  p = p.replace(/\{\{AGENT_ID\}\}/g, ctx.agentId);
  p = p.replace(/\{\{AVAILABLE_ROLES\}\}/g, buildAvailableRolesList(ctx.roleManager));
  return p;
}

/**
 * Assemble the full staff system-prompt blob passed as `rolePrompt` to
 * createSession. Order: [role context ---] systemPrompt [--- Pinned Context].
 * roleName is still passed separately by callers for model/thinking/tool-policy.
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
```

Notes:
- Unknown `roleId` (or `roleManager.getRole` returns undefined / empty template) → `resolveRolePrompt` returns undefined → graceful fallback to `systemPrompt (+ memory)` only. No throw.
- Memory ordering preserved exactly: `systemPrompt + "\n\n---\n\n## Pinned Context\n\n" + memory`.

### Refactor the three regular-session sites (behaviour-preserving)

Replace each inline block with:
```ts
const role = session.role && this.roleManager ? this.roleManager.getRole(session.role) : undefined;
const rolePrompt = resolveRolePrompt(role, {
  branch: goal?.branch,
  agentId: `${session.role}-${(session.goalId || session.id).slice(0, 8)}`,
  roleManager: this.roleManager,
});
const roleName = rolePrompt ? session.role : undefined;
```
- Site 1 (`~1682`) and site 2 (`~3458`, uses `ps.` instead of `session.`): exact behaviour match.
- Site 3 `assignRole` (`~4804`): currently passes `role.promptTemplate` raw. Switch to `resolveRolePrompt(this.roleManager?.getRole(role.name) ?? role, { branch: goal?.branch, agentId: `${role.name}-${(session.goalId || session.id).slice(0,8)}`, roleManager: this.roleManager })`. This newly applies substitution in `assignRole` — an intentional consistency fix; guard with a unit test.

Existing regular-session/role tests must still pass.

### Refactor the three staff sites

Replace the `fullPrompt = staff.systemPrompt (+ memory)` blocks with:
```ts
const fullPrompt = buildStaffSystemPrompt(staff, /* roleManager */);
```
passing the available `RoleManager` instance:
- `staff-manager.ts` `createStaff` (~372) and `ensureSessionForStaff` (~640): `StaffManager` must have access to a `RoleManager`. Check whether `StaffManager` already holds one; if not, thread it in (constructor injection or via `sessionManager.getRoleManager?.()`). Prefer reusing whatever the staff path can already reach. **Implementer: confirm the wiring and document it.**
- `server.ts` staff fork/restore (~7294): `roleManager` is already in scope (used in the sibling `else` branch). Use `buildStaffSystemPrompt(staff, roleManager)`.

`roleName = staff.roleId` is still passed to `createSession` at all three sites (unchanged) for model/thinking/tool-policy resolution.

### Server role validation (404)

Add role-existence validation to the staff routes so unknown roles are rejected:
- `POST /api/staff` (~9818): if `body.roleId` is a non-empty string and `roleManager.getRole(body.roleId)` is undefined → `json({ error: "Role not found" }, 404)`.
- `PUT /api/staff/:id` (~9929): same check when `body.roleId` is a non-empty string. `roleId: null` (clear) and omitted `roleId` are allowed.

### UI role picker (`src/app/staff-page.ts`)

- Add module state `editRoleId: string | null = null` and a roles list (fetch via existing `GET /api/roles`, same as `role-manager-page.ts`).
- Initialize from `agent.roleId` when opening edit; reset on open.
- Render a `<select>` with an explicit **"No role"** option (value `""` → maps to `null`) plus one option per role.
- On change: set `editRoleId`. If a role is selected, set `editAccessory = role.accessory || "none"` **only as a pre-fill default** — do NOT override if the user has already manually chosen an accessory this session. Track `accessoryUserTouched` so the accessory picker's `@click` sets it `true`, and the role `@change` only auto-fills the accessory when `accessoryUserTouched` is false.
- Save payload (`PUT /api/staff/:id`): include `roleId: editRoleId` (string or `null` to clear).
- `src/app/api.ts`: add `roleId?: string | null` to `CreateStaffAgentData` and to `StaffAgentUpdate` (`Pick` union). `updateStaffAgent` must JSON-serialize `roleId: null` (do not strip nulls) so the server clears the field.

### propose_staff tool + assistant + apply path

- `defaults/tools/proposals/extension.ts` (~167): add `role: Type.Optional(Type.String({ description: "Role name to attach (optional)." }))` to the `propose_staff` parameters.
- `defaults/tools/proposals/propose_staff.yaml`: document the new optional `role` field.
- `src/server/agent/staff-assistant.ts`: extend `STAFF_ASSISTANT_PROMPT` to describe the optional `role` parameter — what roles do (prepend role context + pre-fill accessory), that it's optional, and that the assistant should validate the role exists before proposing.
- Apply path: the staff proposal preview (`src/app/proposal-panels.ts` `handleCreateStaff`) must thread the proposal's `role` field into `createStaffAgent({ roleId: <role> })`. Find where staff proposal fields populate `state.staffPreview*` and add a `staffPreviewRole` (or read the proposal `role` field) → pass as `roleId`. Validation: server-side 404 (above) covers unknown roles; the assistant should also avoid proposing unknown roles.

## Data flow (create with role)

`UI/proposal → POST /api/staff { roleId } → validate role exists → createStaff({ roleId }) → buildStaffSystemPrompt(staff, roleManager) → createSession({ rolePrompt: <role ctx + systemPrompt + memory>, roleName: roleId, accessory }) → assembleSystemPrompt` emits role context as the leading goal/role section.

## Acceptance criteria (from goal)

- Create staff with a role → spawned session's system prompt begins with role context, then staff prompt; accessory defaults to role's accessory.
- Edit role (add/change/remove) updates `roleId`; next spawn reflects it. "None" clears `roleId` → fallback to staff prompt only.
- Role optional — no role behaves as today.
- Accessory pre-fill is a default only; manual choice preserved.
- `propose_staff` accepts optional role; accepted proposal creates staff with correct `roleId`.
- Unknown role → 404 on POST/PUT.

## Testing

**Unit** (`tests/role-prompt.spec.ts` or similar, file:// fixtures):
- `resolveRolePrompt`: `{{GOAL_BRANCH}}` replaced only when branch present (else left intact); `{{AGENT_ID}}` and `{{AVAILABLE_ROLES}}` substituted; missing/empty template → undefined.
- `buildStaffSystemPrompt`: role present (prepended, `---` separator); role absent (unchanged); role + memory ordering (`role --- systemPrompt --- Pinned Context`); unknown roleId → graceful fallback (systemPrompt only). 
- Confirm existing regular-session/role tests still pass after the refactor.

**API E2E** (`tests/e2e/`): `POST` and `PUT /api/staff` with `roleId` (persisted), and unknown-role → 404.

**Browser E2E** (`tests/e2e/ui/staff-role.spec.ts`, pattern: `staff-accessory.spec.ts`): create staff → pick role → accessory pre-fills from role → save → reload → role persists; edit to change role and to clear it ("No role"); verify accessory remains overridable after picking a role.

Run: `npm run check`, `npm run test:unit`, `npm run test:e2e`.

## Work partition (non-overlapping files)

- **Unit A — Server backend**: `role-prompt.ts` (new), `session-manager.ts` (3 sites), `staff-manager.ts` (2 sites + roleManager wiring), `server.ts` (fork-restore site + POST/PUT role 404 validation), unit tests for helpers, API E2E. Owns all `src/server/**` + `tests/*.spec.ts` + `tests/e2e/*.spec.ts`.
- **Unit B — Frontend**: `src/app/staff-page.ts`, `src/app/api.ts` (roleId in types), browser E2E `tests/e2e/ui/staff-role.spec.ts`. Owns `src/app/staff-page.ts`, `src/app/api.ts`, UI E2E.
- **Unit C — Proposal/tool** (after B for api.ts roleId): `defaults/tools/proposals/extension.ts`, `propose_staff.yaml`, `src/server/agent/staff-assistant.ts`, `src/app/proposal-panels.ts` (apply path role→roleId).

A and B run in parallel (no file overlap). C runs after B (depends on `api.ts` `roleId`; touches `staff-assistant.ts` which A leaves untouched).
