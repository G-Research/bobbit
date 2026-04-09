# Roles — User Stories

## R-01: View roles list

**As a** user  
**I want to** navigate to `#/roles` and see all available roles  
**So that** I can understand what agent roles exist and where they come from

### Acceptance Criteria

- Navigating to `#/roles` displays all roles resolved through the config cascade (builtin + server + project layers).
- Each role entry shows its **name**, **label**, and **accessory icon** (if configured).
- Each role displays an **origin badge**: grey for builtin, blue for server, green for project.
- Inherited (non-overridden) roles render at **70% opacity**.
- When multiple projects are registered, a **project scope row** appears above the list allowing the user to filter by project context.

### Technical Notes

- Resolution uses `ConfigCascade.resolveRoles(projectId)` — merges builtin → server → project layers, tagging each with `origin` and optional `overrides`.
- REST: `GET /api/roles?projectId=<id>` returns the resolved list with origin metadata.
- Shared UI code in `config-scope.ts` and `config-scope.css` handles the scope row and badge rendering.

### Coverage

**Partial.** The list page renders and shows roles, but E2E tests do not fully validate origin badges, opacity, or multi-project scope row behavior.

---

## R-02: Create role

**As a** user  
**I want to** create a new custom role by filling out a form  
**So that** I can define specialized agent behaviors for my project

### Acceptance Criteria

- Clicking "New Role" opens a creation form.
- The **name** field accepts only lowercase alphanumeric characters and hyphens, and is **immutable** after creation.
- The user can fill in: **label**, **promptTemplate** (Markdown, supports `{{GOAL_BRANCH}}` and `{{AGENT_ID}}` template variables), optional **accessory**, optional **defaultPersonalities** list, and optional **toolPolicies** (per-tool: `allow` / `ask` / `never`).
- On save, the role appears in the list with a server or project origin badge.
- A YAML file is written to `config/roles/<name>.yaml`.
- The new role is immediately available in the session role picker.

### Technical Notes

- REST: `POST /api/roles` with JSON body. Accepts optional `projectId` for project-scoped creation.
- YAML is persisted to `<scope>/.bobbit/config/roles/<name>.yaml`.
- `toolPolicies` is a map of tool/group names to policy values (`allow`/`ask`/`never`).

### Coverage

**Partial (API only).** API CRUD tests exist but no browser E2E test validates the full form interaction.

---

## R-03: Edit role

**As a** user  
**I want to** edit an existing role's configuration  
**So that** I can refine agent behavior over time

### Acceptance Criteria

- Clicking a role in the list navigates to its edit page.
- All editable fields load with current values.
- On save, changes are persisted to the YAML file and `updatedAt` is updated.
- Existing sessions using this role are **not** affected; only new sessions pick up the changes.

### Technical Notes

- REST: `PUT /api/roles/:name` with JSON body.
- The edit page loads the resolved role from the cascade — if it's a builtin being viewed (not customized), the form is read-only until the user clicks "Customize".

### Coverage

**Partial (API only).** No browser E2E test for the edit page interaction.

---

## R-04: Delete role

**As a** user  
**I want to** delete a custom role I no longer need  
**So that** my role list stays clean and manageable

### Acceptance Criteria

- Clicking a role and then "Delete" shows a confirmation dialog.
- On confirm, the role is removed from the list and its YAML file is deleted.
- Only **custom roles** (server or project origin) can be deleted — builtin roles show no delete option.

### Technical Notes

- REST: `DELETE /api/roles/:name` with optional `?projectId=`.
- Server returns 403 or hides the action for builtin-origin roles.

### Coverage

**Partial (API only).** No browser E2E test for delete confirmation flow.

---

## R-05: Customize builtin role (project override)

**As a** user  
**I want to** create a project-level override of a builtin role  
**So that** I can tailor builtin behavior for a specific project without affecting other projects

### Acceptance Criteria

- With a project scope selected, clicking "Customize" on a builtin role copies the resolved role to the project's config directory.
- The role's origin badge changes from grey (builtin) to green (project).
- Project sessions use the override; other projects continue to see the builtin.
- The resolved item gains an `overrides` field indicating it shadows a lower-priority layer.

### Technical Notes

- REST: `POST /api/roles/:name/customize?scope=project&projectId=X` — copies the resolved item to the target scope for editing.
- The copy is a full snapshot of the resolved role — the user can then edit it independently.

### Coverage

**Partial.** API customization endpoint is tested but no browser E2E validates the Customize button flow, badge change, or multi-project isolation.

---

## R-06: Revert override

**As a** user  
**I want to** revert a project-level role override back to the inherited value  
**So that** I can undo customizations and fall back to the builtin or server-level definition

### Acceptance Criteria

- Clicking "Revert" on an overridden role removes the project-level override.
- The role's origin badge changes back (e.g., green → grey for a builtin revert).
- The role returns to 70% opacity if it's now inherited.
- The YAML file in the project config directory is deleted.

### Technical Notes

- REST: `DELETE /api/roles/:name/override?scope=project&projectId=X` — removes the override file, reverting to the inherited value.

### Coverage

**Partial (API only).** No browser E2E test for the Revert button interaction or visual state change.

---

## R-07: Role in session creation

**As a** user  
**I want to** select a role when creating a new session  
**So that** the agent operates with the correct prompt and tool policies for the task

### Acceptance Criteria

- The session creation flow includes a **role picker dropdown** listing all available roles (resolved through the cascade for the session's project).
- Selecting a role and creating the session results in the role's `promptTemplate` being used as the agent's system prompt.
- The role's `toolPolicies` are applied to the session with the following resolution order: role+tool → role+group → tool default → group default → `allow`.
- If the role defines `defaultPersonalities` and no explicit personalities are selected, those defaults are auto-applied.

### Technical Notes

- Session setup pipeline in `session-setup.ts` uses `ConfigCascade` for role resolution.
- `resolvePrompt` step interpolates template variables (`{{GOAL_BRANCH}}`, `{{AGENT_ID}}`).
- `resolveToolActivation` applies the policy resolution chain.

### Coverage

**None.** No E2E test validates the role picker dropdown, role selection, prompt application, or tool policy enforcement in a created session.

---

## R-08: Cascade affects goal team

**As a** team lead agent  
**I want** role resolution through the cascade when spawning team members  
**So that** project-level role customizations are applied to goal agents

### Acceptance Criteria

- When a team agent is spawned with a role (via `team_spawn`), the role resolves through the full cascade (builtin → server → project) for the goal's project.
- If a project-level override exists for the role, the spawned agent uses the overridden prompt and tool policies.
- The resolved prompt includes any project-specific customizations.

### Technical Notes

- This is the known bug path where cascade resolution broke goal creation — the session setup pipeline must use `ConfigCascade` (not direct store lookups) when resolving roles for team-spawned agents.
- `team-manager.ts` passes the goal's `projectId` through to the session setup pipeline.

### Coverage

**None.** No E2E test validates that team-spawned agents correctly receive cascade-resolved role overrides.
