# Roles — User Stories

## R-01: View roles list

**As a** user
**I want to** see all available roles on the Roles page
**So that** I can understand what agent roles exist and where they come from

### Acceptance Criteria

- The Roles page displays all roles, including built-in defaults and any user-created ones.
- Each role shows its **name**, **label**, and **icon** (if configured).
- Each role displays an **origin badge**: grey for builtin, blue for server-level, green for project-level.
- Inherited (non-overridden) roles appear **dimmed**.
- When multiple projects are registered, a **scope selector** appears allowing the user to switch project context.

### Coverage

**Partial.** The list page renders and shows roles, but E2E tests do not fully validate origin badges, dimming, or multi-project scope selector behavior.

---

## R-02: Create role

**As a** user
**I want to** create a new custom role
**So that** I can define specialized agent behaviors for my project

### Acceptance Criteria

- Clicking "New Role" opens a creation form.
- The user fills in: **name**, **label**, **prompt**, and optionally **tool policies** (per-tool: allow / ask / never).
- On save, the role appears in the list.
- The new role is immediately available when creating sessions.

### Coverage

**Partial (API only).** API tests exist but no browser E2E test validates the full form interaction.

---

## R-03: Edit role

**As a** user
**I want to** edit an existing role's configuration
**So that** I can refine agent behavior over time

### Acceptance Criteria

- Clicking a role opens its edit view with current values loaded.
- On save, changes are persisted.
- Existing sessions using this role are **not** affected; only new sessions pick up the changes.

### Coverage

**Partial (API only).** No browser E2E test for the edit interaction.

---

## R-04: Delete role

**As a** user
**I want to** delete a custom role I no longer need
**So that** my role list stays clean and manageable

### Acceptance Criteria

- Clicking "Delete" on a role shows a confirmation dialog.
- On confirm, the role is removed from the list.
- Only **custom roles** can be deleted — builtin roles show no delete option.

### Coverage

**Partial (API only).** No browser E2E test for the delete confirmation flow.

---

## R-05: Customize builtin role (project override)

**As a** user
**I want to** create a project-level override of a builtin role
**So that** I can tailor builtin behavior for a specific project without affecting other projects

### Acceptance Criteria

- With a project scope selected, clicking "Customize" on a builtin role creates an editable copy for that project.
- The role's origin badge changes from grey (builtin) to green (project).
- Sessions in that project use the override; other projects continue to see the original builtin.

### Coverage

**Partial.** API customization is tested but no browser E2E validates the Customize button flow, badge change, or multi-project isolation.

---

## R-06: Revert override

**As a** user
**I want to** revert a project-level role override back to the inherited value
**So that** I can undo customizations and fall back to the builtin definition

### Acceptance Criteria

- Clicking "Revert" on an overridden role removes the project-level override.
- The role's origin badge changes back (e.g., green → grey).
- The role returns to its dimmed inherited appearance.

### Coverage

**Partial (API only).** No browser E2E test for the Revert button interaction or visual state change.

---

## R-07: Use role in session creation

**As a** user
**I want to** select a role when creating a new session
**So that** the agent operates with the correct prompt and tool policies for the task

### Acceptance Criteria

- The session creation flow includes a **role picker** listing all available roles for the session's project.
- Selecting a role and creating the session results in the agent using that role's prompt and tool policies.

### Coverage

**None.** No E2E test validates the role picker, role selection, or that the chosen role takes effect in the created session.

---

## R-08: Role cascade affects goals

**As a** user
**I want** project-level role customizations to apply to team agents in goals
**So that** goal agents reflect project-specific role overrides

### Acceptance Criteria

- When a team agent is spawned for a goal, it uses the role as customized for that goal's project.
- If a project-level override exists, the spawned agent uses the overridden prompt and tool policies — not the builtin defaults.

### Coverage

**None.** No E2E test validates that team agents correctly receive project-level role overrides. This is a known bug path.
